// Regression: a single-hit result must not receive top confidence (Phase 7,
// Step 12). Before the fix, `runRung` gave a one-hit result margin 1, so `auto`
// treated it as certain and never escalated — a scoped deep query returned only
// its starting note. This test fails before the fix and passes after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { runEval } from '../src/eval/run.ts';
import type { EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-recall-escalation-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

test('a single-hit result does not get top confidence, so auto escalates', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const q = readQueries().find((x) => x.id === 'q-mhs-deep-1');
  assert.ok(q, 'q-mhs-deep-1 exists');
  const [r] = await runEval(dir, [q]);
  assert.ok(r.escalations.length > 0, 'auto escalated past the single-hit rung');
  assert.equal(r.modeUsed, 'hipporag', 'the ladder reached the triple rung');
  assert.ok(
    r.hits.some((h) => h.passageId === 'probe-aging#0'),
    'the triple-only path to the target was found',
  );
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
