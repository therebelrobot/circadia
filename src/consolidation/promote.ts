// Triple-to-candidate promotion path (Phase 5: HippoRAG).
// High-confidence triples from the triple cache are proposed to consolidation
// as candidate facts. They still go through the consolidation gate.
//
// C13 / ADR-0006: a triple's only provenance is a passage id, not an episode. Using the
// source *note* id as `episodeId` would make a promoted fact's `src::` point at an entity
// note, which SCHEMA §4 forbids. Rather than invent provenance, triple candidates are
// marked `origin: 'triple'` and the gate always queues them. The source note's `by` and
// `trust` are still carried so the gate can reason about them.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config.ts';
import type { SourceKind, Trust } from '../types.ts';
import { loadTriples } from '../extract/triples.ts';
import { parseVault, noteTrust } from '../index/indexer.ts';
import { DEFAULT_TRUST } from '../vault/facts.ts';
import type { Candidate } from './candidate.ts';

/**
 * Default confidence threshold for promoting triples to candidates.
 * Triples with conf >= this value are proposed for consolidation.
 */
export const DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD = 0.8;

export interface TriplePromotionResult {
  /** candidates to hand to the gate this run */
  candidates: Candidate[];
  /**
   * passageId -> contentHash for every triple seen this run. Persist this and pass it
   * back next run so an unchanged passage is not re-proposed (C6).
   */
  seen: Map<string, string>;
}

/**
 * Convert cached triples to consolidation candidates.
 *
 * Only triples meeting the confidence threshold are returned, and only when the
 * passage's `contentHash` differs from the last run's (`seen`). A triple whose passage
 * text has not changed is not re-proposed, which is half of the idempotency guarantee;
 * the pending/rejected key check in `consolidate` is the other half.
 */
export function promoteTriplesToCandidates(
  vaultRoot: string,
  cfg: Config,
  minConfidence: number = DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
  seen: Map<string, string> = new Map(),
): TriplePromotionResult {
  const { triples } = loadTriples(vaultRoot);

  // Resolve each triple's source note so we can inherit its `by`/`trust`.
  const notesById = new Map(parseVault(vaultRoot, cfg).map((n) => [n.id, n]));

  const candidates: Candidate[] = [];
  const nextSeen = new Map(seen);

  for (const t of triples) {
    // Record every triple's hash, even low-confidence ones, so a later run does not
    // re-propose them either.
    nextSeen.set(t.passageId, t.contentHash);

    const conf = t.conf ?? 0.5;
    if (conf < minConfidence) continue;
    // C6: unchanged passage content since the last run -> do not re-propose.
    if (seen.get(t.passageId) === t.contentHash) continue;

    const sourceNoteId = t.passageId.split('#')[0];
    const note = notesById.get(sourceNoteId);
    const by = (note?.frontmatter.by as SourceKind | undefined) ?? 'agent';
    const trust: Trust = note ? noteTrust(note) : (DEFAULT_TRUST[by] ?? 'low');

    candidates.push({
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      valid: true, // High-confidence triples from HippoRAG are assumed valid
      explicit: false, // a triple is derived, never a direct user assertion
      origin: 'triple' as const,
      episodeId: sourceNoteId,
      confidence: t.conf ?? 0.5,
      by,
      trust,
    });
  }

  return { candidates, seen: nextSeen };
}

/** Read the persisted passageId -> contentHash map. Missing/corrupt -> empty. */
export function readSeenHashes(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

/** Serialize the passageId -> contentHash map, sorted for byte-stable output. */
export function serializeSeenHashes(seen: Map<string, string>): string {
  const sorted = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(sorted), null, 2) + '\n';
}

/** Persist the passageId -> contentHash map. */
export function writeSeenHashes(path: string, seen: Map<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeSeenHashes(seen));
}

/**
 * Get statistics about triples available for promotion.
 */
export function getTriplePromotionStats(vaultRoot: string, minConfidence: number = DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD): {
  totalTriples: number;
  eligibleTriples: number;
  byPredicate: Map<string, number>;
} {
  const { triples } = loadTriples(vaultRoot);

  const eligibleTriples = triples.filter((t) => {
    const conf = t.conf ?? 0.5;
    return conf >= minConfidence;
  });

  const byPredicate = new Map<string, number>();
  for (const t of eligibleTriples) {
    const count = byPredicate.get(t.predicate) ?? 0;
    byPredicate.set(t.predicate, count + 1);
  }

  return {
    totalTriples: triples.length,
    eligibleTriples: eligibleTriples.length,
    byPredicate,
  };
}
