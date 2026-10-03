// RFC-0004 Stage 8: the workspace eval runner.
//
// Runs the workspace fixture's cases through federated recall and scores layer
// resolution. Each case names the vault and layer that holds its answer, and the
// passage ids that must NOT be recalled (sibling content, or content a layer's
// trust floor blocks). A single sibling hit fails the case, like a trust violation
// (RFC-0004 test plan item 13).
//
// Strictly read-only against the fixture's notes: it builds each vault's derived
// index in place (the fixture is a temp directory), never the tracked vault, and
// never writes the registry or a baseline. The `layerWeights` sweep is report-only,
// mirroring `eval --tune` (RFC-0004 Stage 8).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { buildIndex } from '../index/indexer.ts';
import {
  DEFAULT_LAYER_WEIGHTS,
  loadWorkspace,
  resolveBinding,
  resolveLineage,
  type Layer,
  type WorkspaceRegistry,
} from '../workspace/registry.ts';
import { workspaceRecall } from '../workspace/recall.ts';
import { FIXED_NOW } from './run.ts';

/** One line of `eval/workspace.queries.jsonl`. */
export interface WorkspaceEvalCase {
  id: string;
  query: string;
  /** the binding whose lineage the query resolves against */
  binding: { project: string | null; agent: string | null };
  /** narrow the lineage to these layers (optional; it can only narrow) */
  layers?: Layer[];
  /** the vault and layer each expected passage must come from */
  expected: { passage: string; vault: string; layer: Layer }[];
  /** passage ids that must NOT be recalled (sibling content, blocked content) */
  expect_absent?: string[];
  split: 'dev' | 'holdout';
}

/** A returned hit, labeled with the vault and layer it came from. */
export interface WorkspaceEvalHit {
  passageId: string;
  vault: string;
  layer: Layer;
  rank: number;
}

/** One case's outcome. Every list is empty on a pass. */
export interface WorkspaceEvalResult {
  id: string;
  hits: WorkspaceEvalHit[];
  /** expected hits that were not returned at all */
  missing: { passage: string; vault: string; layer: Layer }[];
  /** expected hits returned from the wrong vault or layer */
  mislabeled: { passage: string; expectedVault: string; gotVault: string; expectedLayer: Layer; gotLayer: Layer }[];
  /** `expect_absent` passage ids that were returned */
  absentViolations: string[];
  /** per-vault recall errors (a degraded layer) */
  errors: Record<string, string>;
}

/** Read `eval/workspace.queries.jsonl`. */
export function readWorkspaceQueries(path: string): WorkspaceEvalCase[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as WorkspaceEvalCase);
}

/**
 * Build every registered vault's derived index in place. The workspace fixture is a
 * temp directory, so writing each vault's `.circadia/index.sqlite` is safe; the
 * tracked vault is never touched.
 */
export function buildWorkspaceIndexes(workspaceDir: string): void {
  const { registry } = loadWorkspace(workspaceDir);
  for (const id of Object.keys(registry.vaults)) {
    const vaultPath = join(workspaceDir, id);
    const cfg = loadConfig(vaultPath, registry.defaults);
    buildIndex(vaultPath, cfg);
  }
}

async function runCases(
  registry: WorkspaceRegistry,
  workspaceDir: string,
  cases: readonly WorkspaceEvalCase[],
): Promise<WorkspaceEvalResult[]> {
  const out: WorkspaceEvalResult[] = [];
  for (const c of cases) {
    const { binding, problems } = resolveBinding(registry, c.binding.project, c.binding.agent);
    if (problems.length > 0) throw new Error(`case ${c.id}: ${problems.map((p) => p.message).join('; ')}`);
    const lineage = resolveLineage(registry, workspaceDir, binding);
    const r = await workspaceRecall(registry, lineage, c.query, {
      layers: c.layers,
      logAccess: false,
      now: FIXED_NOW,
    });
    const hits: WorkspaceEvalHit[] = r.hits.map((h, i) => ({
      passageId: h.passageId,
      vault: h.vault ?? '',
      layer: (h.layer ?? 'global') as Layer,
      rank: i + 1,
    }));
    const byPassage = new Map(hits.map((h) => [h.passageId, h]));
    const missing: WorkspaceEvalResult['missing'] = [];
    const mislabeled: WorkspaceEvalResult['mislabeled'] = [];
    for (const e of c.expected) {
      const got = byPassage.get(e.passage);
      if (!got) {
        missing.push(e);
      } else if (got.vault !== e.vault || got.layer !== e.layer) {
        mislabeled.push({
          passage: e.passage,
          expectedVault: e.vault,
          gotVault: got.vault,
          expectedLayer: e.layer,
          gotLayer: got.layer,
        });
      }
    }
    const absent = new Set(c.expect_absent ?? []);
    const errors: Record<string, string> = {};
    for (const [id, info] of Object.entries(r.byVault)) if (info.error) errors[id] = info.error;
    out.push({
      id: c.id,
      hits,
      missing,
      mislabeled,
      absentViolations: hits.filter((h) => absent.has(h.passageId)).map((h) => h.passageId),
      errors,
    });
  }
  return out;
}

/** Run the workspace eval cases against a generated workspace fixture. */
export async function runWorkspaceEval(
  workspaceDir: string,
  cases: readonly WorkspaceEvalCase[],
): Promise<WorkspaceEvalResult[]> {
  const { registry } = loadWorkspace(workspaceDir);
  return runCases(registry, workspaceDir, cases);
}

/** One row of the report-only `layerWeights` sweep. */
export interface LayerWeightSweepRow {
  weights: Record<Layer, number>;
  passed: number;
  total: number;
  /** ids of cases that did not resolve cleanly under these weights */
  failures: string[];
}

/**
 * Report-only sweep over `recall.layerWeights` (RFC-0004 Stage 8). It re-runs the
 * cases with each weight set and reports how many still resolve. It never writes the
 * registry or a baseline; turning a weight into a default is a human decision, as
 * `eval --tune` is today.
 */
export async function sweepLayerWeights(
  workspaceDir: string,
  cases: readonly WorkspaceEvalCase[],
  weightSets: readonly Partial<Record<Layer, number>>[],
): Promise<LayerWeightSweepRow[]> {
  const { registry } = loadWorkspace(workspaceDir);
  const rows: LayerWeightSweepRow[] = [];
  for (const weights of weightSets) {
    const reg: WorkspaceRegistry = {
      ...registry,
      recall: { ...(registry.recall ?? {}), layerWeights: weights },
    };
    const results = await runCases(reg, workspaceDir, cases);
    const failures = results
      .filter(
        (r) =>
          r.missing.length > 0 ||
          r.mislabeled.length > 0 ||
          r.absentViolations.length > 0 ||
          Object.keys(r.errors).length > 0,
      )
      .map((r) => r.id);
    rows.push({
      weights: { ...DEFAULT_LAYER_WEIGHTS, ...weights },
      passed: results.length - failures.length,
      total: results.length,
      failures,
    });
  }
  return rows;
}
