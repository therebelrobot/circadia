// C26: direct tests for src/vault/walk.ts (file discovery).
//
// The walker defines what the indexer sees: markdown only, no dot-folders, no `_meta/`,
// no `node_modules/`, and no `vault.ignore` globs. A regression here silently changes
// what is indexed, so each exclusion is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkVault } from '../src/vault/walk.ts';

test('walk: finds markdown, skips dot-folders, _meta, node_modules, non-md, and ignore globs', () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-walk-'));
  for (const d of ['entities', '_meta', '.hidden', 'node_modules', 'drafts']) {
    mkdirSync(join(v, d), { recursive: true });
  }
  writeFileSync(join(v, 'entities', 'a.md'), '# a\n');
  writeFileSync(join(v, '_meta', 'README.md'), '# meta\n');
  writeFileSync(join(v, '.hidden', 'b.md'), '# b\n');
  writeFileSync(join(v, 'node_modules', 'c.md'), '# c\n');
  writeFileSync(join(v, 'drafts', 'd.md'), '# d\n');
  writeFileSync(join(v, 'notes.txt'), 'not markdown\n');

  const files = walkVault(v, ['drafts/**']);

  assert.deepEqual(files.map((f) => f.path), ['entities/a.md']);
  assert.ok(files[0].abs.endsWith(join('entities', 'a.md')), 'abs is the on-disk path');
  assert.ok(files[0].mtime > 0, 'mtime is recorded for incremental indexing');
});

test('walk: results are sorted by vault-relative path', () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-walk-sort-'));
  mkdirSync(join(v, 'b'), { recursive: true });
  mkdirSync(join(v, 'a'), { recursive: true });
  writeFileSync(join(v, 'b', 'z.md'), '# z\n');
  writeFileSync(join(v, 'a', 'y.md'), '# y\n');

  const files = walkVault(v);
  assert.deepEqual(files.map((f) => f.path), ['a/y.md', 'b/z.md']);
});
