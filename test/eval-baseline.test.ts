// Baseline capture and diffing (Phase 7, Step 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { deepMerge, loadConfig } from '../src/config.ts';
import { buildReport, runEval } from '../src/eval/run.ts';
import { aggregate } from '../src/eval/metrics.ts';
import { diffBaseline, readBaseline, toBaseline, type Baseline } from '../src/eval/baseline.ts';
import type { EvalAggregate, EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const BASELINE_PATH = join(EVAL_DIR, 'baseline.json');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-baseline-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

/** Run auto + each forced mode against one index build, and project to a baseline. */
async function freshBaseline(dir: string): Promise<Baseline> {
  const cfg = loadConfig(dir);
  const queries = readQueries();
  const dbPath = join(tmp, 'baseline.sqlite');
  const auto = await runEval(dir, queries, { config: cfg, dbPath });
  const report = buildReport(dir, cfg, auto);
  const modes: Record<string, EvalAggregate[]> = {};
  for (const mode of ['wikilink', 'typed', 'hipporag'] as const) {
    const modeCfg = deepMerge(cfg, { graph: { query: { mode } } });
    const results = await runEval(dir, queries, { config: modeCfg, dbPath, reuseIndex: true });
    modes[mode] = [...aggregate(results, 'kind'), ...aggregate(results, 'kind-split')];
  }
  return toBaseline(report, modes);
}

test('the committed baseline matches a fresh run (zero deltas)', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const fresh = await freshBaseline(dir);
  const committed = readBaseline(BASELINE_PATH);
  assert.deepEqual(diffBaseline(committed, fresh), [], 'committed baseline is stale');
  assert.deepEqual(diffBaseline(fresh, fresh), [], 'identical reports have zero deltas');
});

test('changed hits produce a non-zero delta', () => {
  const base = readBaseline(BASELINE_PATH);
  const changed: Baseline = JSON.parse(JSON.stringify(base)) as Baseline;
  const q = changed.queries.find((x) => x.id === 'q-sh-pi-cluster');
  assert.ok(q && q.hits.length > 0, 'query has hits');
  q.hits[0] = 'something-else#0';
  const deltas = diffBaseline(base, changed);
  assert.ok(deltas.length > 0, 'a changed hit is a delta');
  assert.ok(deltas.some((d) => d.queryId === 'q-sh-pi-cluster' && d.field === 'hits'));
});

test('the baseline records no ordering violations', () => {
  const base = readBaseline(BASELINE_PATH);
  // Measuring the dense seed path changed q-pref-sam's ranking, so the
  // coffee/tea ordering constraint now holds (it was 1 before query embeddings
  // were measured). Ordering is still not a hard gate.
  assert.equal(base.orderViolations, 0, 'q-pref-sam: the ordering constraint now holds');
  assert.equal(base.trustViolations, 0);
  assert.equal(base.failed, false, 'ordering is not a hard gate');
});

test('the baseline contains no absolute paths or timestamps', () => {
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const volatile = /^(built_at|builtAt|timestamp|generatedAt|now|mtime|createdAt|updatedAt)$/;
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        assert.ok(!volatile.test(k), `volatile key ${k} at ${path}`);
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string') assert.ok(!v.startsWith('/'), `absolute path "${v}" at ${path}`);
  };
  walk(parsed, '$');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
