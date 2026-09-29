// Triple-to-candidate promotion path (Phase 5: HippoRAG).
// High-confidence triples from the triple cache are proposed to consolidation
// as candidate facts. They still go through the consolidation gate.

import type { Config } from '../config.ts';
import { loadTriples } from '../extract/triples.ts';
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
  _cfg: Config,
  minConfidence: number = DEFAULT_PROMOTION_CONFIDENCE_THRESHOLD,
): Candidate[] {
  const { triples } = loadTriples(vaultRoot);

  const highConfidenceTriples = triples.filter((t) => {
    // Filter by confidence threshold
    const conf = t.conf ?? 0.5;
    return conf >= minConfidence;
  });

  // Convert to Candidate format
  return highConfidenceTriples.map((t) => {
    // Use passageId as the "episodeId" equivalent for provenance tracking
    // This allows consolidation to reference the source note
    const sourceNoteId = t.passageId.split('#')[0];

    return {
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      valid: true, // High-confidence triples from HippoRAG are assumed valid
      episodeId: sourceNoteId,
      confidence: t.conf ?? 0.5,
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
