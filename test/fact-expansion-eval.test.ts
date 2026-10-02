// RFC-0002 criterion 8: with `factExpansion.enabled: true`, the eval reproduces the
// RFC's numbers exactly. The eval is deterministic (ADR-0010), so "within noise"
// means identical. The fixture is generated into a temp dir; the committed baseline
// and examples/vault are never touched.
//
// The RFC's table row "current scoring + entity-anchored expansion" is:
//   macro recall@5 over the six unscoped kinds:
//     auto 0.556 / 0.500, typed 0.583 / 0.500, hipporag 0.583 / 0.500  (dev / holdout)
//   all-kinds overall MRR (the bracketed value; the `split` aggregate):
//     auto 0.368 / 0.465, typed 0.352 / 0.453, hipporag 0.381 / 0.482  (dev / holdout)
// The MRR label was corrected in 4f1d35e: the bracketed values are the all-kinds
// overall MRR (matching eval/baseline.json's `dev`/`holdout` groups), not the
// six-unscoped-kind macro MRR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { deepMerge, loadConfig } from '../src/config.ts';
import { runEval } from '../src/eval/run.ts';
import { aggregate } from '../src/eval/metrics.ts';
import type { EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-fe-eval-'));

const UNSCOPED = new Set([
  'single-hop',
  'multi-hop',
  'temporal',
  'preference',
  'remote-association-2hop',
  'remote-association-3hop',
]);

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

/** Macro recall@5 over the six unscoped kinds, per split. */
function macroRecall5(results: Awaited<ReturnType<typeof runEval>>): Record<string, number> {
  const bySplit: Record<string, { sum: number; n: number }> = {};
  for (const a of aggregate(results, 'kind-split')) {
    const [kind, split] = a.group.split(':');
    if (!UNSCOPED.has(kind)) continue;
    const e = (bySplit[split] ??= { sum: 0, n: 0 });
    e.sum += a.recallAtK['5'] ?? 0;
    e.n += 1;
  }
  return Object.fromEntries(Object.entries(bySplit).map(([s, e]) => [s, e.sum / e.n]));
}

/**
 * All-kinds overall MRR per split — the RFC's bracketed MRR. This is the `split`
 * aggregate (mean MRR over every non-trust query in the split), the same value
 * eval/baseline.json records under its `dev`/`holdout` groups.
 */
function overallMrr(results: Awaited<ReturnType<typeof runEval>>): Record<string, number> {
  return Object.fromEntries(aggregate(results, 'split').map((a) => [a.group, a.mrr]));
}

test('criterion 8: flag-on eval reproduces the RFC recall@5 and overall MRR numbers exactly', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const base = loadConfig(dir);
  const queries = readQueries();
  const dbPath = join(tmp, 'index.sqlite');

  const expected: Record<string, { dev: number; holdout: number }> = {
    auto: { dev: 0.556, holdout: 0.5 },
    typed: { dev: 0.583, holdout: 0.5 },
    hipporag: { dev: 0.583, holdout: 0.5 },
  };
  // The RFC's bracketed all-kinds overall MRR (dev / holdout).
  const expectedMrr: Record<string, { dev: number; holdout: number }> = {
    auto: { dev: 0.368, holdout: 0.465 },
    typed: { dev: 0.352, holdout: 0.453 },
    hipporag: { dev: 0.381, holdout: 0.482 },
  };

  for (const mode of ['auto', 'typed', 'hipporag'] as const) {
    const cfg = deepMerge(base, {
      graph: { query: { mode } },
      retrieval: { factExpansion: { enabled: true } },
    });
    const results = await runEval(dir, queries, { config: cfg, dbPath, reuseIndex: mode !== 'auto' });
    const macro = macroRecall5(results);
    assert.equal(Number(macro.dev.toFixed(3)), expected[mode].dev, `${mode} dev recall@5`);
    assert.equal(Number(macro.holdout.toFixed(3)), expected[mode].holdout, `${mode} holdout recall@5`);
    const mrr = overallMrr(results);
    assert.equal(Number(mrr.dev.toFixed(3)), expectedMrr[mode].dev, `${mode} dev overall MRR`);
    assert.equal(Number(mrr.holdout.toFixed(3)), expectedMrr[mode].holdout, `${mode} holdout overall MRR`);
  }
});

// W1: the eval reports the per-kind fact-expansion share so RFC-0002 rollout
// step 3 can be evaluated. The signal must be present when the flag is on and
// absent (not merely zero) when it is off, so the committed baseline is
// unchanged.
test('W1: per-kind expansion share is reported when the flag is on and absent when off', async () => {
  const dir = join(tmp, 'vault-share');
  generateFixture(dir);
  const base = loadConfig(dir);
  const queries = readQueries();
  const dbPath = join(tmp, 'index-share.sqlite');

  // Flag off: no expansion fields anywhere, so the committed baseline is unchanged.
  const off = await runEval(dir, queries, { config: base, dbPath });
  for (const r of off) assert.equal('expanded' in r, false, `${r.id} has no expanded when off`);
  for (const a of aggregate(off, 'kind')) {
    assert.equal('expansionShare' in a, false, `${a.group} has no expansionShare when off`);
  }

  // Flag on, forced typed so fact edges are traversed: every result carries
  // `expanded`, and each kind aggregate reports the share of queries with
  // expanded > 0.
  const cfg = deepMerge(base, {
    graph: { query: { mode: 'typed' } },
    retrieval: { factExpansion: { enabled: true } },
  });
  const on = await runEval(dir, queries, { config: cfg, dbPath, reuseIndex: true });
  for (const r of on) assert.equal(typeof r.expanded, 'number', `${r.id} carries expanded when on`);

  const byKind = new Map<string, typeof on>();
  for (const r of on) {
    if (r.kind === 'trust') continue; // aggregate() excludes trust queries
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  let sawExpansion = false;
  for (const a of aggregate(on, 'kind')) {
    const list = byKind.get(a.group) as typeof on;
    const expected = list.filter((r) => (r.expanded ?? 0) > 0).length / list.length;
    assert.equal(a.expansionShare, expected, `${a.group} expansion share`);
    if (expected > 0) sawExpansion = true;
  }
  assert.ok(sawExpansion, 'at least one kind has a non-zero expansion share');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
