// RFC-0001 Stage 5: the dream-edge weight sweep. REPORT ONLY.
//
// For `originWeights.dream` in {0, 0.25, 0.5, 1}, in two configurations
// (true+decoys, decoys-only) and per forced mode (auto, wikilink, typed,
// hipporag), report remote-association recall@5 (dev and holdout), every kind's
// recall@5, and the trust/absent/order/vacuous/missing counts.
//
// Strictly read-only and deterministic (ADR-0010): the eval runner uses a fixed
// clock, no logging, no network, and builds its index in a temp dir. The
// decoys-only configuration is prepared in a temp copy of the fixture, so the
// committed fixture and baseline are never written. The default
// `graph.originWeights.dream` is never changed; turning dreams on is a human
// decision (RFC-0001 "Rollout → Stage 5").
//
// The true/decoy split comes from the generator's knowledge as encoded in the
// query set (each remote-association query names its `seed` and its gold
// target), never from a candidate field. Part 0 removed the salience confound
// so the sweep measures the mechanism, not "the heavier link wins".

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { STATE_DIR, deepMerge, loadConfig } from '../config.ts';
import type { GraphMode } from '../types.ts';
import { runEval } from './run.ts';
import type { EvalQuery, EvalQueryResult } from './types.ts';

/** The weights the sweep reports. 0 is the shipped default. */
export const DREAM_WEIGHTS: readonly number[] = [0, 0.25, 0.5, 1];

/** `auto` plus every forced mode. `wikilink` never traverses dream edges. */
export type DreamMode = 'auto' | GraphMode;
export const DREAM_MODES: readonly DreamMode[] = ['auto', 'wikilink', 'typed', 'hipporag'];

export type DreamConfigName = 'true+decoys' | 'decoys-only';

const REMOTE_KINDS: readonly string[] = ['remote-association-2hop', 'remote-association-3hop'];

export interface DreamSweepCounts {
  trust: number;
  absent: number;
  order: number;
  vacuous: number;
  missing: number;
}

export interface DreamSweepCell {
  config: DreamConfigName;
  mode: DreamMode;
  weight: number;
  /** mean recall@5 over the two remote-association kinds, per split. */
  remoteRecall5: { dev: number; holdout: number };
  /** per-kind mean recall@5, per split; null when the split has no such query. */
  perKind: Record<string, { dev: number | null; holdout: number | null }>;
  counts: DreamSweepCounts;
  /** the tuner's `noKindRegression` rule vs weight 0 for the same config+mode. */
  noKindRegression: { dev: boolean; holdout: boolean };
}

export interface DreamSweepGate {
  mode: DreamMode;
  weight: number;
  /** remote-association recall@5 rose on both dev and holdout vs weight 0. */
  remoteRises: boolean;
  /** no kind regressed on either split in the decoys-only run. */
  noKindRegression: boolean;
  /** trust stayed at 0 in both configurations. */
  trustZero: boolean;
  pass: boolean;
}

export interface DreamSweepReport {
  weights: number[];
  modes: DreamMode[];
  cells: DreamSweepCell[];
  gate: DreamSweepGate[];
  /** report-only; the turn-on decision is the owner's (RFC-0001 Stage 5). */
  recommendation: { turnOn: boolean; reason: string };
}

export interface DreamSweepOptions {
  /** k values for the metric block; defaults to the runner's DEFAULT_KS. */
  k?: readonly number[];
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** A normalized, order-independent pair key. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

/**
 * The planted true pairs, from the generator's knowledge as encoded in the query
 * set: each remote-association query names its `seed` and its gold target. This
 * is deliberately NOT read from any candidate field.
 */
export function truePairKeys(queries: readonly EvalQuery[]): Set<string> {
  const keys = new Set<string>();
  for (const q of queries) {
    if (!q.seed || !REMOTE_KINDS.includes(q.kind)) continue;
    const g = q.expected_passages[0];
    const target = typeof g === 'string' ? g : g?.[0];
    if (!target) continue;
    keys.add(pairKey(q.seed, target.replace(/#.*$/, '')));
  }
  return keys;
}

interface CandidateLine {
  a: string;
  b: string;
}

function readCandidateLines(path: string): CandidateLine[] {
  const out: CandidateLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as CandidateLine;
      if (c && typeof c.a === 'string' && typeof c.b === 'string') out.push(c);
    } catch {
      // a malformed line is not one of our records; skip it
    }
  }
  return out;
}

function perKindRecall(results: readonly EvalQueryResult[]): Record<string, number> {
  const byKind = new Map<string, number[]>();
  for (const r of results) {
    if (r.kind === 'trust') continue;
    const list = byKind.get(r.kind) ?? byKind.set(r.kind, []).get(r.kind)!;
    list.push(r.metrics.recallAtK['5'] ?? 0);
  }
  const out: Record<string, number> = {};
  for (const [kind, xs] of byKind) out[kind] = mean(xs);
  return out;
}

function remoteRecall(results: readonly EvalQueryResult[]): number {
  return mean(results.filter((r) => REMOTE_KINDS.includes(r.kind)).map((r) => r.metrics.recallAtK['5'] ?? 0));
}

function counts(results: readonly EvalQueryResult[]): DreamSweepCounts {
  return {
    trust: results.reduce((n, r) => n + r.trustViolations, 0),
    absent: results.reduce((n, r) => n + r.absentViolations, 0),
    order: results.reduce((n, r) => n + r.orderViolations, 0),
    vacuous: results.reduce((n, r) => n + r.vacuousAbsences, 0),
    missing: results.reduce((n, r) => n + r.missingIds.length, 0),
  };
}

/** The tuner's rule, as written: a candidate may not lower recall@5 for any kind. */
function noKindRegression(
  cand: Record<string, { dev: number | null; holdout: number | null }>,
  base: Record<string, { dev: number | null; holdout: number | null }>,
  split: 'dev' | 'holdout',
): boolean {
  for (const [kind, v] of Object.entries(base)) {
    const b = v[split];
    if (b === null) continue;
    const c = cand[kind]?.[split];
    if (c === null || c === undefined) return false;
    if (c < b - 1e-9) return false;
  }
  return true;
}

function mergePerKind(
  dev: Record<string, number>,
  holdout: Record<string, number>,
): Record<string, { dev: number | null; holdout: number | null }> {
  const out: Record<string, { dev: number | null; holdout: number | null }> = {};
  for (const kind of new Set([...Object.keys(dev), ...Object.keys(holdout)])) {
    out[kind] = { dev: dev[kind] ?? null, holdout: holdout[kind] ?? null };
  }
  return out;
}

/**
 * Run the weight sweep. Builds one index per configuration in a temp dir and
 * reuses it for every weight (the weight is applied at query time). Writes only
 * under a temp directory; the fixture and the committed baseline are untouched.
 */
export async function runDreamSweep(
  fixtureDir: string,
  queries: readonly EvalQuery[],
  opts: DreamSweepOptions = {},
): Promise<DreamSweepReport> {
  const baseCfg = loadConfig(fixtureDir);
  const trueKeys = truePairKeys(queries);
  const candidatesPath = join(fixtureDir, STATE_DIR, 'dreams', 'candidates.jsonl');
  const decoyCandidates = readCandidateLines(candidatesPath).filter((c) => !trueKeys.has(pairKey(c.a, c.b)));

  const tmp = mkdtempSync(join(tmpdir(), 'circadia-dream-sweep-'));
  const decoyDir = join(tmp, 'decoys-only');
  try {
    cpSync(fixtureDir, decoyDir, { recursive: true });
    writeFileSync(
      join(decoyDir, STATE_DIR, 'dreams', 'candidates.jsonl'),
      decoyCandidates.map((c) => JSON.stringify(c)).join('\n') + (decoyCandidates.length > 0 ? '\n' : ''),
    );

    const configs: { name: DreamConfigName; dir: string }[] = [
      { name: 'true+decoys', dir: fixtureDir },
      { name: 'decoys-only', dir: decoyDir },
    ];

    const cells: DreamSweepCell[] = [];
    for (const cfg of configs) {
      const dbPath = join(tmp, `${cfg.name.replace(/[^a-z0-9]+/gi, '-')}.sqlite`);
      // Build the index once per configuration. `addEdge` drops weight <= 0, so
      // the dream weight is applied at query time and one build serves every weight.
      await runEval(cfg.dir, queries, { config: baseCfg, dbPath, k: opts.k });
      for (const mode of DREAM_MODES) {
        let baseline: Record<string, { dev: number | null; holdout: number | null }> | null = null;
        for (const weight of DREAM_WEIGHTS) {
          const modeCfg: Config = deepMerge(baseCfg, {
            graph: { query: { mode }, originWeights: { dream: weight } },
          });
          const results = await runEval(cfg.dir, queries, { config: modeCfg, dbPath, reuseIndex: true, k: opts.k });
          const dev = results.filter((r) => r.split === 'dev');
          const holdout = results.filter((r) => r.split === 'holdout');
          const perKind = mergePerKind(perKindRecall(dev), perKindRecall(holdout));
          if (weight === 0) baseline = perKind;
          cells.push({
            config: cfg.name,
            mode,
            weight,
            remoteRecall5: { dev: remoteRecall(dev), holdout: remoteRecall(holdout) },
            perKind,
            counts: counts(results),
            noKindRegression: {
              dev: baseline ? noKindRegression(perKind, baseline, 'dev') : true,
              holdout: baseline ? noKindRegression(perKind, baseline, 'holdout') : true,
            },
          });
        }
      }
    }

    const gate = evaluateGate(cells);
    const passing = gate.filter((g) => g.pass);
    const turnOn = passing.length > 0;
    const reason = turnOn
      ? `at least one weight passes the Stage 5 gate: ${passing.map((g) => `${g.mode}@${g.weight}`).join(', ')}`
      : 'no weight raises remote-association recall@5 on both dev and holdout without a kind regression; dreams stay at weight 0';
    return { weights: [...DREAM_WEIGHTS], modes: [...DREAM_MODES], cells, gate, recommendation: { turnOn, reason } };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The RFC's Stage 5 gate, evaluated per mode and weight. Report-only: the
 * recommendation is advisory and the turn-on decision is the owner's.
 */
function evaluateGate(cells: readonly DreamSweepCell[]): DreamSweepGate[] {
  const gate: DreamSweepGate[] = [];
  for (const mode of DREAM_MODES) {
    const trueCells = cells.filter((c) => c.config === 'true+decoys' && c.mode === mode);
    const decoyCells = cells.filter((c) => c.config === 'decoys-only' && c.mode === mode);
    const base = trueCells.find((c) => c.weight === 0);
    for (const cell of trueCells) {
      if (cell.weight === 0) continue;
      const decoy = decoyCells.find((c) => c.weight === cell.weight);
      const remoteRises =
        cell.remoteRecall5.dev > (base?.remoteRecall5.dev ?? 0) + 1e-9 &&
        cell.remoteRecall5.holdout > (base?.remoteRecall5.holdout ?? 0) + 1e-9;
      const noReg = decoy ? decoy.noKindRegression.dev && decoy.noKindRegression.holdout : false;
      const trustZero = cell.counts.trust === 0 && (decoy?.counts.trust ?? 0) === 0;
      gate.push({
        mode,
        weight: cell.weight,
        remoteRises,
        noKindRegression: noReg,
        trustZero,
        pass: remoteRises && noReg && trustZero,
      });
    }
  }
  return gate;
}
