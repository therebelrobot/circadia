// Tests for the C5 (shell injection), C15 (wrong git-ref timestamp), and C27
// (interpolated execSync) fixes, plus the local-date `consolidated:` stamp.
//
// Every git call in src/ must use execFileSync with an argument array, so refs and
// paths are never interpreted by a shell. These tests prove that with a real payload
// and a source-level guard that fails if `execSync(` is ever reintroduced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCommit, readFileAtCommit, getNoteCommitAtTime } from '../src/vault/git.ts';
import { localDateString } from '../src/vault/time.ts';

/** Run git with an argument array (no shell) and return stdout. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Create a temp git repo with a deterministic identity. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-git-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  return dir;
}

/** Commit all changes with a fixed author/committer date. */
function commitAll(repo: string, message: string, isoDate: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', message], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  });
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

test('C5: shell-injection payload in a ref is inert and creates no file', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'x\n');
  commitAll(repo, 'init', '2020-01-01T00:00:00Z');

  const pwned = join(repo, 'pwned');
  // The exact payload from the C5 repro: `HEAD;touch${IFS}<path>;#`
  const payload = 'HEAD;touch${IFS}' + pwned + ';#';

  const result = resolveCommit(repo, payload);

  assert.equal(result, null, 'injection payload must not resolve to a commit');
  assert.equal(existsSync(pwned), false, 'injection payload must not create a file');
});

test('guard: no file under src/ contains execSync(', () => {
  const srcDir = resolve(import.meta.dirname, '..', 'src');
  const entries = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }) as string[];
  const offenders: string[] = [];
  for (const rel of entries) {
    const abs = join(srcDir, rel);
    if (!statSync(abs).isFile()) continue;
    if (readFileSync(abs, 'utf8').includes('execSync(')) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `execSync( reintroduced in: ${offenders.join(', ')}`);
});

test('C15: resolveCommit returns the ref commit timestamp, not HEAD', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'first\n');
  const firstHash = commitAll(repo, 'first', '2020-01-01T00:00:00Z');
  writeFileSync(join(repo, 'b.md'), 'second\n');
  const headHash = commitAll(repo, 'second', '2021-06-15T00:00:00Z');

  const first = resolveCommit(repo, firstHash);
  assert.ok(first, 'first commit must resolve');
  assert.equal(first.hash, firstHash);
  assert.equal(first.timestamp, Date.parse('2020-01-01T00:00:00Z'));
  assert.notEqual(first.timestamp, Date.parse('2021-06-15T00:00:00Z'));
  assert.notEqual(first.hash, headHash);
});

test('valid ref: resolveCommit("HEAD") returns the HEAD hash and timestamp', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'first\n');
  commitAll(repo, 'first', '2020-01-01T00:00:00Z');
  writeFileSync(join(repo, 'b.md'), 'second\n');
  const headHash = commitAll(repo, 'second', '2021-06-15T00:00:00Z');

  const head = resolveCommit(repo, 'HEAD');
  assert.ok(head, 'HEAD must resolve');
  assert.equal(head.hash, headHash);
  assert.equal(head.timestamp, Date.parse('2021-06-15T00:00:00Z'));
});

test('C27: a note path containing a space is read without shell splitting', () => {
  const repo = initRepo();
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes', 'my note.md'), 'spaced content\n');
  const hash = commitAll(repo, 'spaced', '2020-01-01T00:00:00Z');

  assert.equal(readFileAtCommit(repo, 'notes/my note.md', hash), 'spaced content\n');
  assert.equal(getNoteCommitAtTime(repo, 'notes/my note.md', Date.now()), hash);
});

test('localDateString: formats the local calendar date, not the UTC date', () => {
  // Constructed from local components, so the assertion is timezone-independent.
  assert.equal(localDateString(new Date(2026, 8, 30, 23, 30, 0)), '2026-09-30');
  assert.equal(localDateString(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01');
  assert.equal(localDateString(new Date(2026, 11, 31, 12, 0, 0)), '2026-12-31');
});
