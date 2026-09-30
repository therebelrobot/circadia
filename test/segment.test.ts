// C26: direct tests for src/episodes/segment.ts (event segmentation).
//
// The module splits a transcript at topic shifts. It has three structural fallbacks:
// markdown headings, speaker turns, and a single "none" segment. These tests pin each
// branch and the propagation of `by`/`source` onto every segment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentText } from '../src/episodes/segment.ts';

test('segment: splits at markdown headings and records each heading as the title', () => {
  const text = '# Alpha\nfirst body\n## Beta\nsecond body\n';
  const segs = segmentText(text, { by: 'user', source: 'tool' });

  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => s.boundary), ['heading', 'heading']);
  assert.equal(segs[0].title, 'Alpha');
  assert.equal(segs[1].title, 'Beta');
  assert.ok(segs[0].text.includes('first body'));
  assert.ok(segs[1].text.includes('second body'));
  // `by`/`source` are copied onto every segment so the episode writer can stamp them.
  assert.equal(segs[0].by, 'user');
  assert.equal(segs[0].source, 'tool');
  assert.equal(segs[1].by, 'user');
});

test('segment: falls back to turn boundaries when there are many speaker turns', () => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) lines.push(`Speaker${i}: line ${i}`);
  const segs = segmentText(lines.join('\n'));

  assert.ok(segs.length > 1, 'a 12-turn transcript must split into more than one block');
  assert.ok(segs.every((s) => s.boundary === 'turn'), 'every block is a turn boundary');
  // Every line is preserved across the blocks (no text is dropped).
  const joined = segs.map((s) => s.text).join('\n');
  for (let i = 0; i < 12; i++) assert.ok(joined.includes(`line ${i}`));
});

test('segment: a plain paragraph is a single segment with boundary "none"', () => {
  const segs = segmentText('just a paragraph with no structure');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].boundary, 'none');
  assert.equal(segs[0].text, 'just a paragraph with no structure');
  assert.equal(segs[0].by, undefined);
  assert.equal(segs[0].source, undefined);
});
