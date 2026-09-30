// Optional LongMemEval / LoCoMo adapters (Phase 7, Step 10). Inline fixtures only;
// no download, no dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLongMemEvalText } from '../src/eval/adapters/longmemeval.ts';
import { parseLoCoMoText } from '../src/eval/adapters/locomo.ts';

test('a LongMemEval JSONL fixture maps to EvalQuery[]', () => {
  const text = [
    JSON.stringify({
      question_id: 'q1',
      question: 'Where is the key?',
      question_type: 'single-session-user',
      answer_session_ids: ['s1'],
    }),
    JSON.stringify({ question_id: 'q2', question: 'What changed?', question_type: 'knowledge-update' }),
  ].join('\n');
  const { queries: qs, skippedAbs } = parseLongMemEvalText(text);
  assert.equal(qs.length, 2);
  assert.equal(skippedAbs, 0);
  assert.equal(qs[0].id, 'q1');
  assert.equal(qs[0].kind, 'single-hop');
  assert.deepEqual(qs[0].expected_passages, ['s1#0']);
  assert.equal(qs[0].split, 'holdout', 'external sets are never dev');
  assert.equal(qs[1].kind, 'temporal');
});

test('a malformed line is skipped, not thrown', () => {
  const text = [
    JSON.stringify({ question_id: 'q1', question: 'ok', question_type: 'multi-session' }),
    '{ this is not json',
    JSON.stringify({ question_id: 'q2', question: 'also ok' }),
  ].join('\n');
  const { queries: qs } = parseLongMemEvalText(text);
  assert.equal(qs.length, 2);
  assert.deepEqual(
    qs.map((q) => q.id),
    ['q1', 'q2'],
  );
});

test('an abstention (_abs) record is skipped and counted', () => {
  const text = [
    JSON.stringify({ question_id: 'q1', question: 'ok', question_type: 'single-session-user' }),
    JSON.stringify({ question_id: 'q2_abs', question: 'no answer exists', question_type: 'single-session-user' }),
  ].join('\n');
  const { queries: qs, skippedAbs } = parseLongMemEvalText(text);
  assert.equal(skippedAbs, 1, 'the _abs record is counted');
  assert.deepEqual(
    qs.map((q) => q.id),
    ['q1'],
  );
});

test('a LoCoMo conversation maps each QA item to an EvalQuery', () => {
  const text = JSON.stringify([
    {
      sample_id: 'c1',
      qa: [
        { question: 'Who?', answer: 'x', evidence: ['d1', 'd2'], category: 1 },
        { question: 'When?', answer: 'y', evidence: ['d3'], category: 2 },
      ],
    },
  ]);
  const qs = parseLoCoMoText(text);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].id, 'c1-q0');
  assert.equal(qs[0].kind, 'multi-hop');
  assert.deepEqual(qs[0].expected_passages, ['d1#0', 'd2#0']);
  assert.equal(qs[1].kind, 'temporal');
  assert.equal(qs[0].split, 'holdout');
});
