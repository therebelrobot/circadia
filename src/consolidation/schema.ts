// Schema-fit gate: decide whether to promote, queue, supersede, or ignore a candidate.
//
// The gate is a PURE function: it takes the candidate, the resolved entity refs, and the
// subject note's current facts, and returns a decision. All I/O (reading the subject
// note, writing facts, calling supersede) happens in consolidate.ts. This keeps the
// memory-poisoning defense (ARCHITECTURE §3) testable in isolation.

import type { Config } from '../config.ts';
import type { Fact } from '../types.ts';
import type { Candidate } from './candidate.ts';
import type { NoteRef } from './entity.ts';

export type GateAction = 'promote' | 'queue' | 'supersede' | 'noop';

export interface GateDecision {
  action: GateAction;
  reason: string;
  candidate: Candidate;
  subjectRef: NoteRef | null;
  objectRef: NoteRef | null;
  /** the current fact this candidate contradicts, when action is 'supersede' or 'queue' */
  conflict?: Fact;
}

/** Canonical object key for comparing a fact's object with a candidate's. */
export function factObjectKey(f: Fact): string {
  return f.object.kind === 'link' ? `[[${f.object.link.target}]]` : f.object.value;
}

/**
 * A predicate is single-valued only when its def explicitly says `cardinality: "single"`.
 * The default is `many`: a new object is added rather than treated as a contradiction, so
 * an unconfigured predicate can never silently strike out a correct current fact.
 */
export function isSingleValued(cfg: Config, predicate: string): boolean {
  return cfg.predicates.defs[predicate]?.cardinality === 'single';
}

/**
 * Evaluate a candidate against the schema-fit gate.
 *
 * Order matters:
 *  1. C4 — untrusted sources (`by: web|tool` or `trust: low`) always queue, before any
 *     promotion check. This is the memory-poisoning defense.
 *  2. C13 — triple-cache candidates always queue (ADR-0006): their provenance is a
 *     passage, not an episode, so they cannot carry a valid `src::`.
 *  3. Known subject + known predicate:
 *     - a different object on a single-valued predicate is a contradiction → queue, or
 *       supersede when a `by: user` episode states it explicitly;
 *     - the same object is corroboration → no-op.
 *  4. Otherwise promote (known subject + known predicate, no conflict) or queue.
 */
export function evaluateGate(
  candidate: Candidate,
  cfg: Config,
  subjectRef: NoteRef | null,
  objectRef: NoteRef | null,
  currentFacts: Fact[] = [],
): GateDecision {
  // C4: untrusted sources never auto-promote. Checked first.
  if (candidate.by === 'web' || candidate.by === 'tool' || candidate.trust === 'low') {
    return { action: 'queue', reason: 'untrusted source', candidate, subjectRef, objectRef };
  }

  // C13: triple-cache candidates always queue (ADR-0006).
  if (candidate.origin === 'triple') {
    return { action: 'queue', reason: 'derived from triple cache', candidate, subjectRef, objectRef };
  }

  const knownPredicate = Object.keys(cfg.predicates.defs).includes(candidate.predicate);
  const knownSubject = subjectRef !== null;

  if (knownSubject && knownPredicate) {
    const samePredicate = currentFacts.filter((f) => f.predicate === candidate.predicate);
    const newObjectKey = objectRef ? `[[${objectRef.id}]]` : candidate.object;

    // The same object is corroboration, never a second fact.
    if (samePredicate.some((f) => factObjectKey(f) === newObjectKey)) {
      return { action: 'noop', reason: 'corroborates a current fact', candidate, subjectRef, objectRef };
    }

    // A different object is only a contradiction for a single-valued predicate. For a
    // `many` predicate (the default) it is simply a new fact to accumulate.
    if (isSingleValued(cfg, candidate.predicate)) {
      const conflict = samePredicate[0];
      if (conflict) {
        if (candidate.by === 'user' && candidate.explicit) {
          return {
            action: 'supersede',
            reason: 'contradicts a current fact (user-confirmed)',
            candidate,
            subjectRef,
            objectRef,
            conflict,
          };
        }
        return { action: 'queue', reason: 'contradicts a current fact', candidate, subjectRef, objectRef, conflict };
      }
    }

    return {
      action: 'promote',
      reason: 'known entity + known predicate + no conflict',
      candidate,
      subjectRef,
      objectRef,
    };
  }

  const reasons: string[] = [];
  if (!knownSubject) reasons.push('new entity');
  if (!knownPredicate) reasons.push('unknown predicate');

  return {
    action: 'queue',
    reason: reasons.join(', '),
    candidate,
    subjectRef,
    objectRef,
  };
}
