// RFC-0001 Stage 5: the dream-edge weight sweep (report only).
//
// The sweep runs `originWeights.dream` in {0, 0.25, 0.5, 1} in two
// configurations (true+decoys, decoys-only) and per forced mode (auto,
// wikilink, typed, hipporag). These tests prove the shape, determinism and
// read-only guarantees. They use a small query subset so the suite stays fast;
// the CLI runs the full set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { DEFAULT_CONFIG, deepMerge, loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { loadGraph } from '../src/retrieval/graph-cache.ts';
import { fixtureHash } from '../src/eval/run.ts';
import { runDreamSweep } from '../src/eval/dreams.ts';
import type { EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const BASELINE_PATH = join(EVAL_DIR, 'baseline.json');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-dream-sweep-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

/** A small, representative subset: one remote pair per split, plus a hop and a trust query. */
function subset(queries: readonly EvalQuery[]): EvalQuery[] {
  const want = new Set(['q-r2-0', 'q-r3-2', 'q-sh-pi-cluster', 'q-trust-medium']);
  return queries.filter((q) => want.has(q.id));
}

test('the dream sweep reports all weights, modes and both configurations', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const report = await runDreamSweep(dir, subset(readQueries()));

  assert.deepEqual(report.weights, [0, 0.25, 0.5, 1], 'all four weights');
  assert.deepEqual(report.modes, ['auto', 'wikilink', 'typed', 'hipporag'], 'auto plus every forced mode');
  assert.equal(report.cells.length, 2 * 4 * 4, 'every (config, mode, weight) combination');
  assert.deepEqual(
    [...new Set(report.cells.map((c) => c.config))].sort(),
    ['decoys-only', 'true+decoys'],
    'both configurations',
  );
  // forced typed and hipporag are reported, not just auto
  for (const mode of ['auto', 'wikilink', 'typed', 'hipporag'] as const) {
    assert.ok(report.cells.some((c) => c.mode === mode), `${mode} is reported`);
  }
  for (const c of report.cells) {
    assert.ok(report.weights.includes(c.weight), 'weight is one of the sweep weights');
    assert.ok(c.remoteRecall5.dev >= 0 && c.remoteRecall5.holdout >= 0, 'remote recall is a number');
    assert.ok(c.counts.trust >= 0 && c.counts.absent >= 0 && c.counts.order >= 0, 'counts are numbers');
    assert.equal(typeof c.noKindRegression.dev, 'boolean');
    assert.equal(typeof c.noKindRegression.holdout, 'boolean');
  }
  // the gate is evaluated per mode and weight, and the recommendation is report-only
  assert.equal(report.gate.length, 4 * 3, 'gate per mode and non-zero weight');
  assert.equal(typeof report.recommendation.turnOn, 'boolean');
  assert.ok(report.recommendation.reason.length > 0);
});

test('the dream sweep is deterministic', async () => {
  const dir = join(tmp, 'vault-det');
  generateFixture(dir);
  const queries = subset(readQueries());
  const a = await runDreamSweep(dir, queries);
  const b = await runDreamSweep(dir, queries);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'two runs are byte-identical');
});

test('the dream sweep is read-only and never mutates defaults or the baseline', async () => {
  const dir = join(tmp, 'vault-ro');
  generateFixture(dir);
  const before = fixtureHash(dir);
  const baselineBefore = readFileSync(BASELINE_PATH, 'utf8');
  const defaultBefore = DEFAULT_CONFIG.graph.originWeights.dream;

  await runDreamSweep(dir, subset(readQueries()));

  assert.equal(fixtureHash(dir), before, 'the fixture tree is unchanged');
  assert.equal(readFileSync(BASELINE_PATH, 'utf8'), baselineBefore, 'the committed baseline is unchanged');
  assert.equal(DEFAULT_CONFIG.graph.originWeights.dream, defaultBefore, 'the default weight is unchanged');
  assert.equal(DEFAULT_CONFIG.graph.originWeights.dream, 0, 'dreams stay at weight 0');
});

test('the sweep weight reaches the graph: a dream edge is present at weight 1 and absent at weight 0', () => {
  const dir = join(tmp, 'vault-graph');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'graph.sqlite');
  buildIndex(dir, cfg, { dbPath });

  const { db } = openIndex(dbPath);
  try {
    const adjacent = (weight: number): boolean => {
      const c = deepMerge(cfg, { graph: { originWeights: { dream: weight } } });
      const g = loadGraph(db, 'typed', null, c);
      const i = g.index.get('electrode-drift');
      const j = g.index.get('aquifer-salinity');
      if (i === undefined || j === undefined) return false;
      return g.nbr[i].includes(j);
    };
    // electrode-drift and aquifer-salinity are a planted true pair, 2 hops apart
    // over wikilinks. The dream edge is the only direct link between them.
    assert.equal(adjacent(0), false, 'weight 0 drops the dream edge');
    assert.equal(adjacent(1), true, 'weight 1 keeps the dream edge');
  } finally {
    db.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
