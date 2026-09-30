// Deterministic, strictly read-only eval runner (Phase 7, Step 4).
//
// Builds the index in a temp directory and calls recall() with a fixed clock and
// logAccess: false. Nothing is ever written under the vault — not even
// `.circadia/`. The fixture is the source of truth; the index is derived.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';
import { deepMerge, loadConfig } from '../config.ts';
import { buildIndex } from '../index/indexer.ts';
import { recall } from '../retrieval/recall.ts';
import { TRUST_RANK } from '../retrieval/graph-cache.ts';
import { parseInstant } from '../vault/time.ts';
import type { Trust } from '../types.ts';
import { DEFAULT_KS, aggregate, metricsFor } from './metrics.ts';
import type { EvalHit, EvalQuery, EvalQueryResult, EvalReport } from './types.ts';

/** The clock every eval run uses, so results are reproducible. */
export const FIXED_NOW = Date.UTC(2026, 8, 30, 12, 0, 0); // 2026-09-30T12:00:00Z

/**
 * The only config keys a query may override. `retrieval.trustFloor` is the trust
 * gate; `scope` restricts seeds and traversal. Anything else is rejected so a
 * query cannot silently change extraction or scoring.
 */
export const ALLOWED_OVERRIDE_KEYS: readonly string[] = ['retrieval.trustFloor', 'scope'];

export interface RunEvalOptions {
  /** config to run with; defaults to `loadConfig(fixtureDir)`. */
  config?: Config;
  /** k values for the metric block. */
  ks?: readonly number[];
  /** run only this split (tuning reads `dev`; the holdout is never read by tuning). */
  split?: 'dev' | 'holdout';
  /** reuse an existing index instead of building one in a temp dir. */
  dbPath?: string;
}

/** Expand dotted override keys (`retrieval.trustFloor`) into nested objects. */
function expandOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const parts = key.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  }
  return out;
}

/** Hits whose trust is below the floor. A trust failure is a hard gate, not a metric. */
export function countTrustViolations(hits: readonly { trust: Trust }[], floor: Trust): number {
  let n = 0;
  for (const h of hits) if (TRUST_RANK[h.trust] < TRUST_RANK[floor]) n++;
  return n;
}

/** SHA-256 over every file's relative path + content, so a fixture change is visible. */
export function fixtureHash(root: string): string {
  const h = createHash('sha256');
  const visit = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) visit(abs);
      else if (ent.isFile()) {
        h.update(abs.slice(root.length + 1));
        h.update('\0');
        h.update(readFileSync(abs));
        h.update('\0');
      }
    }
  };
  visit(root);
  return h.digest('hex');
}

async function runQuery(
  fixtureDir: string,
  baseCfg: Config,
  q: EvalQuery,
  dbPath: string,
  ks: readonly number[],
): Promise<EvalQueryResult> {
  const overrides = q.config_overrides ?? {};
  for (const key of Object.keys(overrides)) {
    if (!ALLOWED_OVERRIDE_KEYS.includes(key)) {
      throw new Error(`query ${q.id}: config override "${key}" is not allowlisted`);
    }
  }
  const scope = typeof overrides.scope === 'string' ? overrides.scope : undefined;
  const configOverrides = { ...overrides };
  delete configOverrides.scope;
  const cfg = Object.keys(configOverrides).length > 0 ? deepMerge(baseCfg, expandOverrides(configOverrides)) : baseCfg;

  const asOf = q.as_of ? parseInstant(q.as_of) : null;
  const r = await recall(fixtureDir, cfg, q.query, {
    dbPath,
    logAccess: false,
    now: FIXED_NOW,
    asOf,
    scope,
    topK: cfg.retrieval.topK,
    tokenBudget: cfg.retrieval.tokenBudget,
  });

  const hits: EvalHit[] = r.hits.map((h, i) => ({
    passageId: h.passageId,
    noteId: h.noteId,
    score: h.score,
    rank: i + 1,
    trust: h.trust,
  }));
  const absent = new Set(q.expect_absent ?? []);
  return {
    id: q.id,
    query: q.query,
    kind: q.kind,
    split: q.split,
    modeUsed: r.modeUsed,
    escalations: r.escalations,
    hits,
    metrics: metricsFor(hits, q.expected_passages, ks),
    absentViolations: hits.filter((h) => absent.has(h.passageId)).length,
    trustViolations: countTrustViolations(hits, cfg.retrieval.trustFloor),
  };
}

/**
 * Run the eval set against a fixture. Builds the index in a temp dir (or reuses
 * `opts.dbPath`) and never writes under the vault.
 */
export async function runEval(
  fixtureDir: string,
  queries: readonly EvalQuery[],
  opts: RunEvalOptions = {},
): Promise<EvalQueryResult[]> {
  const baseCfg = opts.config ?? loadConfig(fixtureDir);
  const ks = opts.ks ?? DEFAULT_KS;
  const selected = opts.split ? queries.filter((q) => q.split === opts.split) : queries;

  const tmpDir = opts.dbPath ? null : mkdtempSync(join(tmpdir(), 'circadia-eval-'));
  const dbPath = opts.dbPath ?? join(tmpDir as string, 'index.sqlite');
  try {
    buildIndex(fixtureDir, baseCfg, { dbPath });
    const results: EvalQueryResult[] = [];
    for (const q of selected) results.push(await runQuery(fixtureDir, baseCfg, q, dbPath, ks));
    return results;
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Assemble a report from results: aggregates plus the hard-gate totals. */
export function buildReport(fixtureDir: string, config: Config, results: readonly EvalQueryResult[]): EvalReport {
  const trustViolations = results.reduce((n, r) => n + r.trustViolations, 0);
  const absentViolations = results.reduce((n, r) => n + r.absentViolations, 0);
  return {
    fixtureHash: fixtureHash(fixtureDir),
    config,
    results: [...results],
    aggregates: [
      ...aggregate(results, 'mode'),
      ...aggregate(results, 'kind'),
      ...aggregate(results, 'escalation'),
      ...aggregate(results, 'split'),
    ],
    trustViolations,
    absentViolations,
    failed: trustViolations > 0 || absentViolations > 0,
  };
}
