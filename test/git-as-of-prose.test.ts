// C17: git-backed as-of for prose. At as-of time T, recall renders a note's passages from
// the note at the last commit <= T, not the current working-tree text. When the vault is not
// a git repo (or the note has no commit <= T), it falls back to the current text and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { recall } from '../src/retrieval/recall.ts';

/** Run git with an argument array (no shell) and return stdout. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

const V1 = '---\ntype: entity\nkind: project\ncreated: 2026-01-01\n---\n# Orchard\n\nThe orchard collector runs on the old laptop.\n';
const V2 = '---\ntype: entity\nkind: project\ncreated: 2026-01-01\n---\n# Orchard\n\nThe orchard collector runs on the pi cluster.\n';

test('C17: as-of recall returns the note prose at the last commit <= T, not the current text', async () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-c17-'));
  git(v, ['init', '-q']);
  git(v, ['config', 'user.email', 't@example.com']);
  git(v, ['config', 'user.name', 't']);
  mkdirSync(join(v, 'entities', 'projects'), { recursive: true });

  const notePath = join(v, 'entities', 'projects', 'orchard.md');
  writeFileSync(notePath, V1);
  git(v, ['add', '-A']);
  git(v, ['commit', '-qm', 'v1'], { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });

  writeFileSync(notePath, V2);
  git(v, ['add', '-A']);
  git(v, ['commit', '-qm', 'v2'], { GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z' });

  const cfg = loadConfig(v);
  const dbPath = join(v, '.circadia', 'index.sqlite');
  buildIndex(v, cfg, { dbPath });

  // as-of just after the first commit: the first version's prose must come back.
  const asOf = Date.parse('2026-01-01T00:01:00Z');
  const r = await recall(v, cfg, 'orchard collector', { dbPath, logAccess: false, mode: 'typed', asOf, topK: 5 });

  const hit = r.hits.find((h) => h.noteId === 'orchard');
  assert.ok(hit, 'the orchard note is recalled');
  assert.ok(r.asOfProse?.fromGit, `prose should come from git (${r.asOfProse?.reason})`);
  assert.ok(hit.text.includes('old laptop'), `expected v1 prose, got: ${hit.text}`);
  assert.ok(!hit.text.includes('pi cluster'), 'current prose must not leak into an as-of result');
  // the returned text is the passage as it existed on disk at that commit
  assert.ok(V1.includes(hit.text), 'hit text is a passage of the committed v1 file');
});

test('C17: a non-git vault falls back to current prose and says so', async () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-c17-nogit-'));
  mkdirSync(join(v, 'entities', 'projects'), { recursive: true });
  writeFileSync(join(v, 'entities', 'projects', 'orchard.md'), V1);

  const cfg = loadConfig(v);
  const dbPath = join(v, '.circadia', 'index.sqlite');
  buildIndex(v, cfg, { dbPath });

  const r = await recall(v, cfg, 'orchard collector', {
    dbPath,
    logAccess: false,
    mode: 'typed',
    asOf: Date.parse('2026-06-01T00:00:00Z'),
    topK: 5,
  });

  const hit = r.hits.find((h) => h.noteId === 'orchard');
  assert.ok(hit, 'the orchard note is recalled');
  assert.equal(r.asOfProse?.fromGit, false);
  assert.ok(r.asOfProse?.reason.includes('not a git repository'), `reason: ${r.asOfProse?.reason}`);
  assert.ok(hit.text.includes('old laptop'), 'current prose is returned');
});
