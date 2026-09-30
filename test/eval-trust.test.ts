// Trust is a hard gate, not a recall average (Phase 7, Step 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { loadConfig } from '../src/config.ts';
import { buildReport, countTrustViolations, runEval } from '../src/eval/run.ts';
import type { EvalQuery, EvalQueryResult } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-trust-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

const CLIP = '2026-09-10-web-clipping#0';

test('a low-trust passage is absent at trustFloor: medium', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const q = readQueries().find((x) => x.id === 'q-trust-medium');
  assert.ok(q, 'q-trust-medium exists');
  const [result] = await runEval(dir, [q]);
  assert.ok(!result.hits.some((h) => h.passageId === CLIP), 'low-trust passage must not be returned');
  assert.equal(result.trustViolations, 0);
});

test('a deliberately planted violation makes the run fail', () => {
  assert.equal(countTrustViolations([{ trust: 'low' }], 'medium'), 1);
  assert.equal(countTrustViolations([{ trust: 'medium' }], 'medium'), 0);
  assert.equal(countTrustViolations([{ trust: 'high' }], 'medium'), 0);

  const planted: EvalQueryResult = {
    id: 'planted',
    query: 'planted',
    kind: 'trust',
    split: 'dev',
    modeUsed: 'typed',
    escalations: [],
    hits: [{ passageId: CLIP, noteId: '2026-09-10-web-clipping', score: 1, rank: 1, trust: 'low' }],
    metrics: { recallAtK: {}, precisionAtK: {}, mrr: 0 },
    absentViolations: 0,
    trustViolations: countTrustViolations([{ trust: 'low' }], 'medium'),
  };
  const report = buildReport(tmp, loadConfig(join(tmp, 'vault')), [planted]);
  assert.equal(report.trustViolations, 1);
  assert.equal(report.failed, true, 'a single trust violation fails the run');
});

test('a non-allowlisted override key is rejected', async () => {
  const dir = join(tmp, 'vault2');
  generateFixture(dir);
  const bad: EvalQuery = {
    id: 'bad-override',
    query: 'pi cluster',
    kind: 'single-hop',
    expected_passages: ['pi-cluster#0'],
    split: 'dev',
    config_overrides: { 'retrieval.topK': 5 },
  };
  await assert.rejects(() => runEval(dir, [bad]), /not allowlisted/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
