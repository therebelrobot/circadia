// Threshold tuning is report-only and dev-only for selection (Phase 7, Step 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.ts';
import { tuneThresholds, type TuneGrid } from '../src/eval/tune.ts';
import type { EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-tune-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

/** A small dev subset with no `paired_with`, so a tune run stays quick. */
function devSubset(): EvalQuery[] {
  const ids = new Set(['q-sh-pi-cluster', 'q-sh-greenhouse-controller', 'q-mh-pref', 'q-pref-sam', 'q-r2-0', 'q-mh-deep-1']);
  return readQueries().filter((q) => ids.has(q.id));
}

/** A tiny grid so the test exercises the search without a long run. */
const SMALL_GRID: TuneGrid = {
  minTopMargin: [0, 0.05],
  minSeeds: [2],
  weights: [{ graph: 1, activation: 0.3, importance: 0.2 }],
  actrThresholdDays: [30],
  damping: [0.5],
  originWeightsFact: [1.5],
};

test('selection never reads a holdout query', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const dev = devSubset();
  const a = await tuneThresholds(dir, dev, SMALL_GRID);
  // A sentinel holdout query that would change the selection if it were read.
  const sentinel: EvalQuery = {
    id: 'sentinel-holdout',
    query: 'zzz sentinel that matches nothing',
    kind: 'single-hop',
    expected_passages: ['pi-cluster#0'],
    split: 'holdout',
  };
  const b = await tuneThresholds(dir, [...dev, sentinel], SMALL_GRID);
  assert.equal(
    JSON.stringify(a.best.config),
    JSON.stringify(b.best.config),
    'holdout sentinel changed the selection',
  );
  assert.equal(a.devCount, b.devCount);
});

test('a candidate that lowers any kind (scoped included) is rejected', async () => {
  const dir = join(tmp, 'vault3');
  generateFixture(dir);
  // minTopMargin 0 stops auto escalation and drops the scoped deep query to 0;
  // it must not be selected even if it helps the unscoped objective.
  const grid: TuneGrid = { ...SMALL_GRID, minTopMargin: [0, 0.05], damping: [0.3, 0.5] };
  const report = await tuneThresholds(dir, devSubset(), grid);
  for (const [kind, v] of Object.entries(report.baseline.perKind)) {
    assert.ok(
      (report.best.perKind[kind] ?? 0) >= v - 1e-9,
      `best lowered ${kind}: ${report.best.perKind[kind]} < ${v}`,
    );
  }
});

test('the suggestion is a valid Config and DEFAULT_CONFIG is unchanged', async () => {
  const dir = join(tmp, 'vault2');
  generateFixture(dir);
  const before = JSON.stringify(DEFAULT_CONFIG);
  const report = await tuneThresholds(dir, devSubset(), SMALL_GRID);
  assert.deepEqual(validateConfig(report.best.config), [], 'suggested config is valid');
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before, 'DEFAULT_CONFIG was mutated');
  assert.ok(report.candidates.length > 1, 'the grid was searched');
  assert.ok(report.holdout.baseline && report.holdout.best, 'the holdout confirmation is reported');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
