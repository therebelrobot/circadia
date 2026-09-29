// Schema-fit gate: decide whether to promote or queue consolidation candidates.

import type { Config } from '../config.ts';
import type { Candidate } from './candidate.ts';
import type { NoteRef } from './entity.ts';

export type GateAction = 'promote' | 'queue';

export interface GateDecision {
  action: GateAction;
  reason: string;
  candidate: Candidate;
  subjectRef: NoteRef | null;
  objectRef: NoteRef | null;
}

/**
 * Evaluate a candidate against the schema-fit gate.
 * Returns 'promote' for known entity + known predicate + no conflict,
 * 'queue' for new entity, unknown predicate, or contradictions.
 */
export function evaluateGate(candidate: Candidate, cfg: Config, subjectRef: NoteRef | null, objectRef: NoteRef | null): GateDecision {
  // Check source kind constraint: web/tool episodes never auto-promote
  // (This assumes we have access to episode by/source somewhere; for now pass through)

  const { predicate } = candidate;

  // Check if predicate is known
  const knownPredicates = Object.keys(cfg.predicates.defs);
  const knownPredicate = knownPredicates.includes(predicate);

  // Check if both entities are known
  const knownSubject = subjectRef !== null;
  const knownObject = objectRef !== null;

  // Gate rules:
  // - Promote: known entity, known predicate, no conflict
  // - Queue: new entity, unknown predicate, or contradiction
  if (knownSubject && knownObject && knownPredicate) {
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
  if (!knownObject) reasons.push('new object entity');
  if (!knownPredicate) reasons.push('unknown predicate');

  return {
    action: 'queue',
    reason: reasons.join(', '),
    candidate,
    subjectRef,
    objectRef,
  };
}
