// Pure retrieval metrics (Phase 7). No I/O, no config, no clock — so the
// expected values in tests come from the metric definitions, not from the code.
//
// Gold is a list of GROUPS. A group is a passage id, or an array of ids meaning
// "any of these counts". A group counts once, at the rank of its first member.
// This is what lets a multi-hop query accept either the answer-bearing `#facts`
// passage or the target entity's `#0` passage without double-counting.
//
// Trust is deliberately NOT a metric here: a trust failure is a hard gate
// (a violation count), never averaged into recall. See run.ts.

import type { EvalAggregate, EvalQueryResult, ExpectedGroup } from './types.ts';

/** k values reported by default. */
export const DEFAULT_KS: readonly number[] = [1, 3, 5, 10];

/** Minimal shape a hit needs to be scored. */
export interface ScorableHit {
  passageId: string;
}

/** Normalize gold into groups of ids. A plain string is a single-member group. */
export function normalizeExpected(expected: readonly ExpectedGroup[]): string[][] {
  return expected.map((e) => (typeof e === 'string' ? [e] : [...e]));
}

/**
 * The 1-based rank of each group's first member in `hits`, or Infinity when the
 * group is not retrieved. A group with no members is Infinity.
 */
export function groupRanks(hits: readonly ScorableHit[], expected: readonly ExpectedGroup[]): number[] {
  const groups = normalizeExpected(expected);
  return groups.map((g) => {
    if (g.length === 0) return Infinity;
    const set = new Set(g);
    for (let i = 0; i < hits.length; i++) if (set.has(hits[i].passageId)) return i + 1;
    return Infinity;
  });
}

/**
 * Recall@k = (# groups whose first member is in the top-k) / (# groups).
 * An empty gold set scores 0 (there is nothing to recall).
 */
export function recallAtK(hits: readonly ScorableHit[], expected: readonly ExpectedGroup[], k: number): number {
  const ranks = groupRanks(hits, expected);
  if (ranks.length === 0) return 0;
  return ranks.filter((r) => r <= k).length / ranks.length;
}

/**
 * Precision@k = (# groups whose first member is in the top-k) / k.
 * k <= 0 scores 0.
 */
export function precisionAtK(hits: readonly ScorableHit[], expected: readonly ExpectedGroup[], k: number): number {
  if (k <= 0) return 0;
  const ranks = groupRanks(hits, expected);
  return ranks.filter((r) => r <= k).length / k;
}

/**
 * Mean reciprocal rank = 1 / rank of the first relevant group, else 0.
 * Rank is 1-based.
 */
export function mrr(hits: readonly ScorableHit[], expected: readonly ExpectedGroup[]): number {
  const ranks = groupRanks(hits, expected);
  const best = Math.min(...ranks);
  return Number.isFinite(best) ? 1 / best : 0;
}

/** Compute the full metric block for one query's hits. */
export function metricsFor(
  hits: readonly ScorableHit[],
  expected: readonly ExpectedGroup[],
  ks: readonly number[] = DEFAULT_KS,
): { recallAtK: Record<string, number>; precisionAtK: Record<string, number>; mrr: number } {
  const recall: Record<string, number> = {};
  const precision: Record<string, number> = {};
  for (const k of ks) {
    recall[String(k)] = recallAtK(hits, expected, k);
    precision[String(k)] = precisionAtK(hits, expected, k);
  }
  return { recallAtK: recall, precisionAtK: precision, mrr: mrr(hits, expected) };
}

export type EvalGroupBy = 'mode' | 'kind' | 'escalation' | 'split' | 'kind-split';

/** The grouping key for a result under a given `groupBy`. */
export function groupKey(r: EvalQueryResult, groupBy: EvalGroupBy): string {
  switch (groupBy) {
    case 'mode':
      return r.modeUsed;
    case 'kind':
      return r.kind;
    case 'split':
      return r.split;
    case 'kind-split':
      return `${r.kind}:${r.split}`;
    case 'escalation':
      return r.escalations.length > 0 ? r.escalations.map((e) => `${e.from}->${e.to}`).join(',') : 'none';
  }
}

/**
 * Average the per-query metrics within each group. Trust queries are excluded:
 * they are a violation count, not a recall average (the plan's hard-gate rule).
 */
export function aggregate(
  results: readonly EvalQueryResult[],
  groupBy: EvalGroupBy,
  ks: readonly number[] = DEFAULT_KS,
): EvalAggregate[] {
  const groups = new Map<string, EvalQueryResult[]>();
  for (const r of results) {
    if (r.kind === 'trust') continue;
    const key = groupKey(r, groupBy);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: EvalAggregate[] = [];
  for (const [group, list] of groups) {
    const recall: Record<string, number> = {};
    const precision: Record<string, number> = {};
    for (const k of ks) {
      recall[String(k)] = mean(list.map((r) => r.metrics.recallAtK[String(k)] ?? 0));
      precision[String(k)] = mean(list.map((r) => r.metrics.precisionAtK[String(k)] ?? 0));
    }
    const agg: EvalAggregate = {
      group,
      count: list.length,
      recallAtK: recall,
      precisionAtK: precision,
      mrr: mean(list.map((r) => r.metrics.mrr)),
    };
    // RFC-0002: report the share of queries with at least one fact-expansion
    // insertion, but only when expansion ran. `expanded` is present on every
    // result of a flag-on run and absent on every result of a flag-off run, so
    // the field is omitted entirely when off and the committed baseline is
    // unchanged. The denominator is the queries that carry the signal.
    const withExpansion = list.filter((r) => r.expanded !== undefined);
    if (withExpansion.length > 0) {
      agg.expansionShare = withExpansion.filter((r) => (r.expanded ?? 0) > 0).length / withExpansion.length;
    }
    out.push(agg);
  }
  // stable order so reports are byte-identical across runs
  out.sort((a, b) => a.group.localeCompare(b.group));
  return out;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
