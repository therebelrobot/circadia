// Threshold tuning (Phase 7, Step 9). REPORT ONLY.
//
// Grid-searches the auto-escalation and scoring knobs on the `dev` split and
// returns a suggested config. It NEVER writes DEFAULT_CONFIG and never edits
// src/config.ts (ADR-0010): a human reads the suggestion and applies it by hand.
//
// The search is coordinate-wise over the grid (one parameter at a time, holding
// the rest at the current best) rather than the full cartesian product, so the
// number of eval runs is the sum of the grid sizes, not their product. None of
// the tuned parameters affect extraction, so one index build is reused for every
// candidate.
//
// The objective is the macro-average of per-kind mean recall@5 over the unscoped
// recall kinds. `*-scoped` kinds are excluded: a scope shrinks the retrieval
// problem, so a scoped pass is not evidence the unscoped query works. A candidate
// may not increase the trust, absent, order, or missing-id counts over the
// baseline candidate. After the best candidate is frozen, the tuner reads the
// holdout exactly once to confirm the pick.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { deepMerge, loadConfig, validateConfig } from '../config.ts';
import { runEval } from './run.ts';
import type { EvalKind, EvalQuery } from './types.ts';

/** The values tried for each knob. Small by default so a tune run stays quick. */
export interface TuneGrid {
  minTopMargin: number[];
  minSeeds: number[];
  weights: { graph: number; activation: number; importance: number }[];
  actrThresholdDays: number[];
  damping: number[];
  originWeightsFact: number[];
}

export const DEFAULT_TUNE_GRID: TuneGrid = {
  minTopMargin: [0, 0.05, 0.2],
  minSeeds: [1, 2],
  weights: [
    { graph: 1, activation: 0.3, importance: 0.2 },
    { graph: 1, activation: 0, importance: 0 },
  ],
  actrThresholdDays: [7, 30],
  damping: [0.3, 0.5],
  originWeightsFact: [1.5, 1.0, 2.0],
};

/** The unscoped recall kinds the objective averages over, macro per kind. */
export const OBJECTIVE_KINDS: readonly EvalKind[] = [
  'single-hop',
  'multi-hop',
  'temporal',
  'preference',
  'remote-association-2hop',
  'remote-association-3hop',
];

export interface TuneViolations {
  trust: number;
  absent: number;
  order: number;
  missing: number;
}

/** One evaluated config. `score` is recall@5 with MRR as a tiny tie-break. */
export interface TuneCandidate {
  config: Config;
  /** macro-average of per-kind mean recall@5 over OBJECTIVE_KINDS. */
  recallAt5: number;
  mrr: number;
  score: number;
  violations: TuneViolations;
  /** mean recall@5 per kind, every non-trust kind (scoped included). */
  perKind: Record<string, number>;
}

export interface TuneHoldout {
  baseline: { recallAt5: number; mrr: number };
  best: { recallAt5: number; mrr: number };
}

export interface TuneReport {
  /** number of `dev` queries scored; holdout is read only for the confirmation. */
  devCount: number;
  grid: TuneGrid;
  baseline: TuneCandidate;
  best: TuneCandidate;
  candidates: TuneCandidate[];
  /** the holdout, read exactly once after selection. */
  holdout: TuneHoldout;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function sum(xs: readonly number[]): number {
  let n = 0;
  for (const x of xs) n += x;
  return n;
}

/** A candidate may not increase any violation count over the baseline. */
function noWorse(a: TuneViolations, b: TuneViolations): boolean {
  return a.trust <= b.trust && a.absent <= b.absent && a.order <= b.order && a.missing <= b.missing;
}

/**
 * A candidate may not lower recall@5 for ANY kind, scoped kinds included. The
 * objective excludes scoped kinds (a scope shrinks the problem), but a knob that
 * helps the headline by breaking a scoped path — e.g. `minTopMargin: 0` stopping
 * auto escalation — must be rejected, not suggested.
 */
function noKindRegression(cand: Record<string, number>, base: Record<string, number>): boolean {
  for (const [kind, v] of Object.entries(base)) {
    if ((cand[kind] ?? 0) < v - 1e-9) return false;
  }
  return true;
}

interface Scored {
  recallAt5: number;
  mrr: number;
  violations: TuneViolations;
  perKind: Record<string, number>;
}

/**
 * Score a config on one split. Trust queries are excluded from the objective:
 * trust is a hard gate (a violation count), not a recall average (metrics.ts).
 */
async function scoreConfig(
  fixtureDir: string,
  queries: readonly EvalQuery[],
  cfg: Config,
  dbPath: string,
  split: 'dev' | 'holdout',
): Promise<Scored> {
  const results = await runEval(fixtureDir, queries, { config: cfg, split, dbPath, reuseIndex: true });
  const byKind = new Map<string, number[]>();
  const objective = results.filter((r) => OBJECTIVE_KINDS.includes(r.kind));
  for (const r of objective) {
    const list = byKind.get(r.kind) ?? byKind.set(r.kind, []).get(r.kind)!;
    list.push(r.metrics.recallAtK['5'] ?? 0);
  }
  // every non-trust kind, scoped included, for the no-regression check
  const byKindAll = new Map<string, number[]>();
  for (const r of results) {
    if (r.kind === 'trust') continue;
    const list = byKindAll.get(r.kind) ?? byKindAll.set(r.kind, []).get(r.kind)!;
    list.push(r.metrics.recallAtK['5'] ?? 0);
  }
  const perKind: Record<string, number> = {};
  for (const [kind, xs] of byKindAll) perKind[kind] = mean(xs);
  return {
    recallAt5: mean([...byKind.values()].map(mean)),
    mrr: mean(objective.map((r) => r.metrics.mrr)),
    violations: {
      trust: sum(results.map((r) => r.trustViolations)),
      absent: sum(results.map((r) => r.absentViolations)),
      order: sum(results.map((r) => r.orderViolations)),
      missing: sum(results.map((r) => r.missingIds.length)),
    },
    perKind,
  };
}

/**
 * Grid-search thresholds on the `dev` split. `queries` may contain holdout
 * entries (they are needed to resolve `paired_with` partners), but selection
 * scores `dev` only — the holdout is read once, after the best candidate is
 * frozen, to confirm it.
 */
export async function tuneThresholds(
  fixtureDir: string,
  queries: readonly EvalQuery[],
  grid: TuneGrid = DEFAULT_TUNE_GRID,
): Promise<TuneReport> {
  const base = loadConfig(fixtureDir);
  const devCount = queries.filter((q) => q.split === 'dev').length;
  const tmpDir = mkdtempSync(join(tmpdir(), 'circadia-eval-tune-'));
  const dbPath = join(tmpDir, 'index.sqlite');
  try {
    // Build the index once with the base config; every candidate reuses it.
    await runEval(fixtureDir, queries, { config: base, split: 'dev', dbPath });

    const candidates: TuneCandidate[] = [];
    const evaluate = async (cfg: Config): Promise<TuneCandidate> => {
      const s = await scoreConfig(fixtureDir, queries, cfg, dbPath, 'dev');
      const c: TuneCandidate = {
        config: cfg,
        recallAt5: s.recallAt5,
        mrr: s.mrr,
        score: s.recallAt5 + s.mrr * 1e-6,
        violations: s.violations,
        perKind: s.perKind,
      };
      candidates.push(c);
      return c;
    };

    const baseline = await evaluate(base);
    let best = baseline;
    const steps: { apply: (cfg: Config, v: unknown) => Config; values: unknown[]; current: (cfg: Config) => unknown }[] = [
      {
        apply: (c, v) => deepMerge(c, { graph: { query: { auto: { minTopMargin: v } } } }),
        values: grid.minTopMargin,
        current: (c) => c.graph.query.auto.minTopMargin,
      },
      {
        apply: (c, v) => deepMerge(c, { graph: { query: { auto: { minSeeds: v } } } }),
        values: grid.minSeeds,
        current: (c) => c.graph.query.auto.minSeeds,
      },
      { apply: (c, v) => deepMerge(c, { retrieval: { weights: v } }), values: grid.weights, current: (c) => c.retrieval.weights },
      {
        apply: (c, v) => deepMerge(c, { retrieval: { actrThresholdDays: v } }),
        values: grid.actrThresholdDays,
        current: (c) => c.retrieval.actrThresholdDays,
      },
      { apply: (c, v) => deepMerge(c, { graph: { damping: v } }), values: grid.damping, current: (c) => c.graph.damping },
      {
        apply: (c, v) => deepMerge(c, { graph: { originWeights: { fact: v } } }),
        values: grid.originWeightsFact,
        current: (c) => c.graph.originWeights.fact,
      },
    ];
    for (const step of steps) {
      for (const value of step.values) {
        // don't re-evaluate the value already in place
        if (JSON.stringify(step.current(best.config)) === JSON.stringify(value)) continue;
        const cand = await evaluate(step.apply(best.config, value));
        if (
          cand.score > best.score &&
          noWorse(cand.violations, baseline.violations) &&
          noKindRegression(cand.perKind, baseline.perKind)
        ) {
          best = cand;
        }
      }
    }

    const errs = validateConfig(best.config);
    if (errs.length) throw new Error(`tuning produced an invalid config: ${errs.join('; ')}`);

    // The holdout is read exactly once, after selection, to confirm the pick.
    const holdoutBaseline = await scoreConfig(fixtureDir, queries, baseline.config, dbPath, 'holdout');
    const holdoutBest = await scoreConfig(fixtureDir, queries, best.config, dbPath, 'holdout');
    return {
      devCount,
      grid,
      baseline,
      best,
      candidates,
      holdout: {
        baseline: { recallAt5: holdoutBaseline.recallAt5, mrr: holdoutBaseline.mrr },
        best: { recallAt5: holdoutBest.recallAt5, mrr: holdoutBest.mrr },
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
