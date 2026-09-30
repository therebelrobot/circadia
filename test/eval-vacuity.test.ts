// Split-safe vacuity (Phase 7, subtask 1c, fix 4). A paired query outside the
// selected split is still run, so a dev-only run sees a cross-split absence check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { runEval } from '../src/eval/run.ts';
import type { EvalQuery } from '../src/eval/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-vacuity-'));
const CLIP = '2026-09-10-web-clipping#0';

test('a cross-split pair is run for vacuity even when the partner is outside the split', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const queries: EvalQuery[] = [
    { id: 'q-a', query: 'pi cluster', kind: 'temporal', expected_passages: [], expect_absent: [CLIP], paired_with: 'q-b', split: 'dev' },
    { id: 'q-b', query: 'pi cluster', kind: 'temporal', expected_passages: [], split: 'holdout' },
    { id: 'q-c', query: 'pi cluster', kind: 'temporal', expected_passages: [], expect_absent: [CLIP], paired_with: 'q-d', split: 'dev' },
    { id: 'q-d', query: 'drip irrigation timing', kind: 'temporal', expected_passages: [CLIP], split: 'holdout' },
  ];
  const results = await runEval(dir, queries, { split: 'dev' });
  assert.deepEqual(results.map((r) => r.id), ['q-a', 'q-c'], 'only dev queries are returned');
  const a = results.find((r) => r.id === 'q-a');
  const c = results.find((r) => r.id === 'q-c');
  assert.ok(a && c);
  assert.equal(a.vacuousAbsences, 1, 'partner q-b does not retrieve the passage -> vacuous');
  assert.equal(c.vacuousAbsences, 0, 'partner q-d retrieves the passage -> non-vacuous');
});

test('a paired_with id that is not in the query set is an error', async () => {
  const dir = join(tmp, 'vault2');
  generateFixture(dir);
  const queries: EvalQuery[] = [
    { id: 'q-x', query: 'pi cluster', kind: 'temporal', expected_passages: [], expect_absent: [CLIP], paired_with: 'nope', split: 'dev' },
  ];
  await assert.rejects(() => runEval(dir, queries, { split: 'dev' }), /paired_with "nope" is not in the query set/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
