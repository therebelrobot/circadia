// Baseline capture and diffing (Phase 7, Step 7).
//
// A baseline records the fixture hash, the config, and per-query hits + metrics
// plus aggregates. Absolute paths and wall-clock timestamps are stripped so a
// baseline is portable and diffable across machines.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvalAggregate, EvalMetrics, EvalReport } from './types.ts';

export interface BaselineHit {
  passageId: string;
  rank: number;
  score: number;
  trust: string;
}

export interface BaselineQuery {
  id: string;
  kind: string;
  split: string;
  modeUsed: string;
  hits: BaselineHit[];
  metrics: EvalMetrics;
}

export interface Baseline {
  fixtureHash: string;
  config: unknown;
  queries: BaselineQuery[];
  aggregates: EvalAggregate[];
  trustViolations: number;
  absentViolations: number;
  failed: boolean;
}

export interface BaselineDelta {
  queryId: string;
  field: string;
  from: unknown;
  to: unknown;
}

const VOLATILE_KEYS = /^(built_at|builtAt|timestamp|generatedAt|now|mtime|createdAt|updatedAt)$/;

/** Recursively drop volatile keys and replace absolute paths with a placeholder. */
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.test(k)) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  if (typeof value === 'string' && value.startsWith('/')) return '<absolute-path>';
  return value;
}

/** Project a report onto the portable baseline shape. */
export function toBaseline(report: EvalReport): Baseline {
  return {
    fixtureHash: report.fixtureHash,
    config: sanitize(report.config),
    queries: report.results.map((r) => ({
      id: r.id,
      kind: r.kind,
      split: r.split,
      modeUsed: r.modeUsed,
      hits: r.hits.map((h) => ({ passageId: h.passageId, rank: h.rank, score: h.score, trust: h.trust })),
      metrics: r.metrics,
    })),
    aggregates: report.aggregates,
    trustViolations: report.trustViolations,
    absentViolations: report.absentViolations,
    failed: report.failed,
  };
}

export function writeBaseline(path: string, report: EvalReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(toBaseline(report), null, 2) + '\n');
}

export function readBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

/** Compare two baselines; an empty array means no change. */
export function diffBaseline(a: Baseline, b: Baseline): BaselineDelta[] {
  const deltas: BaselineDelta[] = [];
  if (a.fixtureHash !== b.fixtureHash) {
    deltas.push({ queryId: '*', field: 'fixtureHash', from: a.fixtureHash, to: b.fixtureHash });
  }
  const bById = new Map(b.queries.map((q) => [q.id, q]));
  for (const qa of a.queries) {
    const qb = bById.get(qa.id);
    if (!qb) {
      deltas.push({ queryId: qa.id, field: 'presence', from: 'present', to: 'absent' });
      continue;
    }
    if (qa.modeUsed !== qb.modeUsed) deltas.push({ queryId: qa.id, field: 'modeUsed', from: qa.modeUsed, to: qb.modeUsed });
    const ha = qa.hits.map((h) => h.passageId).join(',');
    const hb = qb.hits.map((h) => h.passageId).join(',');
    if (ha !== hb) deltas.push({ queryId: qa.id, field: 'hits', from: ha, to: hb });
    if (JSON.stringify(qa.metrics) !== JSON.stringify(qb.metrics)) {
      deltas.push({ queryId: qa.id, field: 'metrics', from: qa.metrics, to: qb.metrics });
    }
  }
  for (const qb of b.queries) {
    if (!a.queries.some((q) => q.id === qb.id)) {
      deltas.push({ queryId: qb.id, field: 'presence', from: 'absent', to: 'present' });
    }
  }
  return deltas;
}
