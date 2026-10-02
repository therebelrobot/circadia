// RFC-0002 criterion 8: with `factExpansion.enabled: true`, the eval reproduces the
// RFC's macro recall@5 numbers exactly. The eval is deterministic (ADR-0010), so
// "within noise" means identical. The fixture is generated into a temp dir; the
// committed baseline and examples/vault are never touched.
//
// The RFC's table row "current scoring + entity-anchored expansion" is:
//   auto 0.556 / 0.500, typed 0.583 / 0.500, hipporag 0.583 / 0.500  (dev / holdout)
// over the six unscoped kinds. The RFC's bracketed MRR does not match the committed
// baseline even for the flag-off "current" row, so only recall@5 is asserted here.

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

test('criterion 8: flag-on eval reproduces the RFC recall@5 numbers exactly', async () => {
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

  for (const mode of ['auto', 'typed', 'hipporag'] as const) {
    const cfg = deepMerge(base, {
      graph: { query: { mode } },
      retrieval: { factExpansion: { enabled: true } },
    });
    const results = await runEval(dir, queries, { config: cfg, dbPath, reuseIndex: mode !== 'auto' });
    const macro = macroRecall5(results);
    assert.equal(Number(macro.dev.toFixed(3)), expected[mode].dev, `${mode} dev recall@5`);
    assert.equal(Number(macro.holdout.toFixed(3)), expected[mode].holdout, `${mode} holdout recall@5`);
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
