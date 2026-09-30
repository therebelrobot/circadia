// Eval runner is strictly read-only (Phase 7, Step 4). The vault tree must be
// byte-identical before and after a run — including `.circadia/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { fixtureHash, runEval } from '../src/eval/run.ts';
import type { EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-readonly-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

test('an eval run does not change the vault tree', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const before = fixtureHash(dir);
  await runEval(dir, readQueries());
  const after = fixtureHash(dir);
  assert.equal(after, before, 'vault tree changed during an eval run');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
