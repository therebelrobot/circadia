// C19: recall `scope` (SECURITY T4) — a seed and traversal filter by path prefix or tag.
//
// Expected values come from docs/SECURITY.md T4 ("restricts seeds and traversal to a path
// prefix or tag") and docs/RETRIEVAL.md §11, not from current output. The vault is built in
// a temp dir; examples/vault is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { recall } from '../src/retrieval/recall.ts';

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-scope-'));
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify(
      {
        graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'wikilink' } },
        predicates: { strict: false, defs: {} },
        embeddings: { provider: 'none' },
        index: { path: '.circadia/index.sqlite' },
        retrieval: { ...DEFAULT_CONFIG.retrieval, logAccess: false },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(v, 'projects', 'alpha'), { recursive: true });
  mkdirSync(join(v, 'projects', 'beta'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  writeFileSync(
    join(v, 'projects', 'alpha', 'alpha-note.md'),
    '---\ntype: entity\nkind: project\ntags: [alpha]\n---\n# Alpha\n\nThe alpha widget calibration procedure.\n',
  );
  writeFileSync(
    join(v, 'projects', 'beta', 'beta-note.md'),
    '---\ntype: entity\nkind: project\ntags: [beta]\n---\n# Beta\n\nThe beta widget calibration procedure.\n',
  );
  return v;
}

test('C19: an unscoped recall returns hits from every project', async () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await recall(v, cfg, 'widget calibration', { logAccess: false });
    const paths = r.hits.map((h) => h.path).sort();
    assert.deepEqual(
      paths,
      ['projects/alpha/alpha-note.md', 'projects/beta/beta-note.md'],
      'unscoped recall must see both projects',
    );
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('C19: a path-prefix scope returns only hits under the prefix', async () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await recall(v, cfg, 'widget calibration', { logAccess: false, scope: 'projects/alpha' });
    assert.deepEqual(
      r.hits.map((h) => h.path),
      ['projects/alpha/alpha-note.md'],
      'a scoped recall must not return the other project',
    );
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('C19: a tag scope returns only notes carrying the tag', async () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await recall(v, cfg, 'widget calibration', { logAccess: false, scope: 'tag:beta' });
    assert.deepEqual(
      r.hits.map((h) => h.path),
      ['projects/beta/beta-note.md'],
      'a tag scope must not return the untagged project',
    );
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('C19: a path prefix does not match a sibling with the same string prefix', async () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    // "projects/alph" is a string prefix of "projects/alpha/..." but not a path-segment
    // prefix, so it must match nothing.
    const r = await recall(v, cfg, 'widget calibration', { logAccess: false, scope: 'projects/alph' });
    assert.deepEqual(r.hits, [], 'a partial path segment must not match');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});
