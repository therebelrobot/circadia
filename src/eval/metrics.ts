// Pure retrieval metrics (Phase 7). No I/O, no config, no clock — so the
// expected values in tests come from the metric definitions, not from the code.
//
// Trust is deliberately NOT a metric here: a trust failure is a hard gate
// (a violation count), never averaged into recall. See run.ts.

import type { EvalAggregate, EvalQueryResult } from './types.ts';

/** k values reported by default. */
export const DEFAULT_KS: readonly number[] = [1, 3, 5, 10];

/** Minimal shape a hit needs to be scored. */
export interface ScorableHit {
  passageId: string;
}

/**
 * Recall@k = |expected ∩ top-k| / |expected|.
 * An empty expected set scores 0 (there is nothing to recall).
 */
export function recallAtK(hits: readonly ScorableHit[], expected: readonly string[], k: number): number {
  if (expected.length === 0) return 0;
  const top = new Set(hits.slice(0, Math.max(0, k)).map((h) => h.passageId));
  let found = 0;
  for (const e of expected) if (top.has(e)) found++;
  return found / expected.length;
}

/**
 * Precision@k = |expected ∩ top-k| / k.
 * k <= 0 scores 0.
 */
export function precisionAtK(hits: readonly ScorableHit[], expected: readonly string[], k: number): number {
  if (k <= 0) return 0;
  const exp = new Set(expected);
  let found = 0;
  for (const h of hits.slice(0, k)) if (exp.has(h.passageId)) found++;
  return found / k;
}

/**
 * Mean reciprocal rank = 1 / rank of the first relevant hit, else 0.
 * Rank is 1-based.
 */
export function mrr(hits: readonly ScorableHit[], expected: readonly string[]): number {
  const exp = new Set(expected);
  for (let i = 0; i < hits.length; i++) {
    if (exp.has(hits[i].passageId)) return 1 / (i + 1);
  }
  return 0;
}

/** Compute the full metric block for one query's hits. */
export function metricsFor(
  hits: readonly ScorableHit[],
  expected: readonly string[],
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

export type EvalGroupBy = 'mode' | 'kind' | 'escalation' | 'split';

/** The grouping key for a result under a given `groupBy`. */
export function groupKey(r: EvalQueryResult, groupBy: EvalGroupBy): string {
  switch (groupBy) {
    case 'mode':
      return r.modeUsed;
    case 'kind':
      return r.kind;
    case 'split':
      return r.split;
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
    out.push({
      group,
      count: list.length,
      recallAtK: recall,
      precisionAtK: precision,
      mrr: mean(list.map((r) => r.metrics.mrr)),
    });
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
