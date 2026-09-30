// Pure metric definitions (Phase 7, Step 1). Expected values are hand-computed
// from the metric definitions, not read from the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recallAtK, precisionAtK, mrr, metricsFor, aggregate, groupKey } from '../src/eval/metrics.ts';
import type { EvalQueryResult } from '../src/eval/types.ts';

const hits = ['a', 'b', 'c', 'd', 'e'].map((passageId) => ({ passageId }));
const expected = ['b', 'd'];

test('recallAtK: |expected ∩ top-k| / |expected|', () => {
  assert.equal(recallAtK(hits, expected, 1), 0); // {a} ∩ {b,d} = 0
  assert.equal(recallAtK(hits, expected, 2), 0.5); // {a,b} -> 1/2
  assert.equal(recallAtK(hits, expected, 3), 0.5); // {a,b,c} -> 1/2
  assert.equal(recallAtK(hits, expected, 5), 1); // all -> 2/2
  assert.equal(recallAtK(hits, expected, 10), 1); // k beyond list length
});

test('precisionAtK: |expected ∩ top-k| / k', () => {
  assert.equal(precisionAtK(hits, expected, 1), 0);
  assert.equal(precisionAtK(hits, expected, 2), 0.5);
  assert.equal(precisionAtK(hits, expected, 3), 1 / 3);
  assert.equal(precisionAtK(hits, expected, 5), 0.4);
  assert.equal(precisionAtK(hits, expected, 0), 0);
});

test('mrr: 1 / rank of the first relevant hit', () => {
  assert.equal(mrr(hits, expected), 0.5); // b is at rank 2
  assert.equal(mrr(hits, ['a']), 1); // a is at rank 1
  assert.equal(mrr(hits, ['z']), 0); // no relevant hit
  assert.equal(mrr([], expected), 0);
});

test('empty expected set scores 0 (nothing to recall)', () => {
  assert.equal(recallAtK(hits, [], 5), 0);
  assert.equal(precisionAtK(hits, [], 5), 0);
  assert.equal(mrr(hits, []), 0);
});

test('metricsFor produces the full k-keyed block', () => {
  const m = metricsFor(hits, expected, [1, 2, 5]);
  assert.deepEqual(m.recallAtK, { '1': 0, '2': 0.5, '5': 1 });
  assert.deepEqual(m.precisionAtK, { '1': 0, '2': 0.5, '5': 0.4 });
  assert.equal(m.mrr, 0.5);
});

function result(over: Partial<EvalQueryResult>): EvalQueryResult {
  return {
    id: 'q',
    query: 'q',
    kind: 'single-hop',
    split: 'dev',
    modeUsed: 'typed',
    escalations: [],
    hits: [],
    metrics: { recallAtK: { '5': 0 }, precisionAtK: { '5': 0 }, mrr: 0 },
    absentViolations: 0,
    trustViolations: 0,
    ...over,
  };
}

test('groupKey: mode, kind, split, escalation', () => {
  const r = result({ modeUsed: 'hipporag', kind: 'multi-hop', split: 'holdout' });
  assert.equal(groupKey(r, 'mode'), 'hipporag');
  assert.equal(groupKey(r, 'kind'), 'multi-hop');
  assert.equal(groupKey(r, 'split'), 'holdout');
  assert.equal(groupKey(r, 'escalation'), 'none');
  const esc = result({ escalations: [{ from: 'wikilink', to: 'typed', reason: 'x' }] });
  assert.equal(groupKey(esc, 'escalation'), 'wikilink->typed');
});

test('aggregate averages within groups and excludes trust queries', () => {
  const a = result({ id: 'a', kind: 'single-hop', metrics: { recallAtK: { '5': 1 }, precisionAtK: { '5': 0.2 }, mrr: 1 } });
  const b = result({ id: 'b', kind: 'single-hop', metrics: { recallAtK: { '5': 0 }, precisionAtK: { '5': 0 }, mrr: 0 } });
  const t = result({ id: 't', kind: 'trust', metrics: { recallAtK: { '5': 1 }, precisionAtK: { '5': 1 }, mrr: 1 } });
  const agg = aggregate([a, b, t], 'kind', [5]);
  assert.equal(agg.length, 1, 'trust query is not a recall group');
  assert.equal(agg[0].group, 'single-hop');
  assert.equal(agg[0].count, 2);
  assert.equal(agg[0].recallAtK['5'], 0.5);
  assert.equal(agg[0].precisionAtK['5'], 0.1);
  assert.equal(agg[0].mrr, 0.5);
});
