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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { deepMerge, loadConfig, validateConfig } from '../config.ts';
import { runEval } from './run.ts';
import type { EvalQuery } from './types.ts';

/** The values tried for each knob. Small by default so a tune run stays quick. */
export interface TuneGrid {
  minTopMargin: number[];
  minSeeds: number[];
  weights: { graph: number; activation: number; importance: number }[];
  actrThresholdDays: number[];
  damping: number[];
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
};

/** One evaluated config. `score` is recall@5 with MRR as a tiny tie-break. */
export interface TuneCandidate {
  config: Config;
  recallAt5: number;
  mrr: number;
  score: number;
}

export interface TuneReport {
  /** number of `dev` queries scored; holdout queries are never read. */
  devCount: number;
  grid: TuneGrid;
  baseline: TuneCandidate;
  best: TuneCandidate;
  candidates: TuneCandidate[];
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * Score a config on the dev split. Trust queries are excluded: trust is a hard
 * gate (a violation count), not a recall average (see metrics.ts).
 */
async function scoreConfig(
  fixtureDir: string,
  queries: readonly EvalQuery[],
  cfg: Config,
  dbPath: string,
): Promise<{ recallAt5: number; mrr: number }> {
  const results = await runEval(fixtureDir, queries, { config: cfg, split: 'dev', dbPath, reuseIndex: true });
  const scored = results.filter((r) => r.kind !== 'trust');
  return {
    recallAt5: mean(scored.map((r) => r.metrics.recallAtK['5'] ?? 0)),
    mrr: mean(scored.map((r) => r.metrics.mrr)),
  };
}

/**
 * Grid-search thresholds on the `dev` split. `queries` may contain holdout
 * entries (they are needed to resolve `paired_with` partners), but only `dev`
 * results are scored — a holdout query is never read into the score.
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
      const { recallAt5, mrr } = await scoreConfig(fixtureDir, queries, cfg, dbPath);
      const c: TuneCandidate = { config: cfg, recallAt5, mrr, score: recallAt5 + mrr * 1e-6 };
      candidates.push(c);
      return c;
    };

    let best = await evaluate(base);
    const steps: { apply: (cfg: Config, v: unknown) => Config; values: unknown[] }[] = [
      { apply: (c, v) => deepMerge(c, { graph: { query: { auto: { minTopMargin: v } } } }), values: grid.minTopMargin },
      { apply: (c, v) => deepMerge(c, { graph: { query: { auto: { minSeeds: v } } } }), values: grid.minSeeds },
      { apply: (c, v) => deepMerge(c, { retrieval: { weights: v } }), values: grid.weights },
      { apply: (c, v) => deepMerge(c, { retrieval: { actrThresholdDays: v } }), values: grid.actrThresholdDays },
      { apply: (c, v) => deepMerge(c, { graph: { damping: v } }), values: grid.damping },
    ];
    for (const step of steps) {
      for (const value of step.values) {
        const cand = await evaluate(step.apply(best.config, value));
        if (cand.score > best.score) best = cand;
      }
    }

    const errs = validateConfig(best.config);
    if (errs.length) throw new Error(`tuning produced an invalid config: ${errs.join('; ')}`);
    return { devCount, grid, baseline: candidates[0], best, candidates };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
