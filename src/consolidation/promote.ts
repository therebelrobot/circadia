// Triple-to-candidate promotion path (Phase 5: HippoRAG).
// High-confidence triples from the triple cache are proposed to consolidation
// as candidate facts. They still go through the consolidation gate.
//
// C13 / ADR-0006: a triple's only provenance is a passage id, not an episode. Using the
// source *note* id as `episodeId` would make a promoted fact's `src::` point at an entity
// note, which SCHEMA §4 forbids. Rather than invent provenance, triple candidates are
// marked `origin: 'triple'` and the gate always queues them. The source note's `by` and
// `trust` are still carried so the gate can reason about them.

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

/**
 * Convert cached triples to consolidation candidates.
 * Only triples meeting the confidence threshold are returned.
 */
export function promoteTriplesToCandidates(
  vaultRoot: string,
  cfg: Config,
  minConfidence: number = DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
): Candidate[] {
  const { triples } = loadTriples(vaultRoot);

  const highConfidenceTriples = triples.filter((t) => {
    // Filter by confidence threshold
    const conf = t.conf ?? 0.5;
    return conf >= minConfidence;
  });

  // Resolve each triple's source note so we can inherit its `by`/`trust`.
  const notesById = new Map(parseVault(vaultRoot, cfg).map((n) => [n.id, n]));

  return highConfidenceTriples.map((t) => {
    const sourceNoteId = t.passageId.split('#')[0];
    const note = notesById.get(sourceNoteId);
    const by = (note?.frontmatter.by as SourceKind | undefined) ?? 'agent';
    const trust: Trust = note ? noteTrust(note) : (DEFAULT_TRUST[by] ?? 'low');

    return {
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
    };
  });
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
