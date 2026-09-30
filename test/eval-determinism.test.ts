// Eval runner determinism (Phase 7, Step 4). Two runs must be byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { runEval } from '../src/eval/run.ts';
import type { EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-determinism-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

test('two eval runs produce byte-identical output', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const queries = readQueries();
  const a = await runEval(dir, queries);
  const b = await runEval(dir, queries);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(a.length > 0, 'queries ran');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
