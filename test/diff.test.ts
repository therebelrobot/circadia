// C26: direct tests for src/vault/diff.ts (the in-process unified diff used by
// `consolidate --dry-run`, C7). The diff must be side-effect-free and render a standard
// unified format so a reviewer can read what a run would change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../src/vault/diff.ts';

test('diff: identical content yields an empty string', () => {
  assert.equal(unifiedDiff('a.md', 'x\n', 'x\n'), '');
  assert.equal(unifiedDiff('a.md', '', ''), '');
});

test('diff: a changed line renders a hunk with the path and +/- markers', () => {
  const d = unifiedDiff('notes/a.md', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.ok(d.startsWith('--- a/notes/a.md\n+++ b/notes/a.md\n'), `unexpected header:\n${d}`);
  assert.ok(d.includes('-two'), 'the removed line is marked');
  assert.ok(d.includes('+TWO'), 'the added line is marked');
  assert.ok(d.includes(' one'), 'unchanged context is kept');
  assert.ok(d.includes(' three'), 'unchanged context is kept');
  assert.match(d, /@@ -\d+,\d+ \+\d+,\d+ @@/, 'a hunk header is present');
});

test('diff: an appended line is a pure addition with no deletions', () => {
  const d = unifiedDiff('a.md', 'one\n', 'one\ntwo\n');
  assert.ok(d.includes('+two'));
  assert.ok(!d.includes('-one'), 'an unchanged line must not be shown as removed');
});
