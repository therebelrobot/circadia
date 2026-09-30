// Threshold tuning is report-only and dev-only (Phase 7, Step 9).
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
};

test('tuning never reads a holdout query', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const dev = devSubset();
  const a = await tuneThresholds(dir, dev, SMALL_GRID);
  // A sentinel holdout query that would change the score if it were read.
  const sentinel: EvalQuery = {
    id: 'sentinel-holdout',
    query: 'zzz sentinel that matches nothing',
    kind: 'single-hop',
    expected_passages: ['pi-cluster#0'],
    split: 'holdout',
  };
  const b = await tuneThresholds(dir, [...dev, sentinel], SMALL_GRID);
  assert.equal(a.best.recallAt5, b.best.recallAt5, 'holdout sentinel changed the dev score');
  assert.equal(a.best.mrr, b.best.mrr);
  assert.equal(a.devCount, b.devCount);
});

test('the suggestion is a valid Config and DEFAULT_CONFIG is unchanged', async () => {
  const dir = join(tmp, 'vault2');
  generateFixture(dir);
  const before = JSON.stringify(DEFAULT_CONFIG);
  const report = await tuneThresholds(dir, devSubset(), SMALL_GRID);
  assert.deepEqual(validateConfig(report.best.config), [], 'suggested config is valid');
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before, 'DEFAULT_CONFIG was mutated');
  assert.ok(report.candidates.length > 1, 'the grid was searched');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
