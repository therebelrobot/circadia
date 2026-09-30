// C26: direct tests for the git.ts paths not covered by git-safety.test.ts.
//
// git-safety.test.ts covers `resolveCommit`, `readFileAtCommit`, and `getNoteCommitAtTime`
// (the C5/C15/C27 security fixes). This file covers the commit-per-run path (C8) and the
// history readers used by `circadia history`:
//   - isGitRepo
//   - getDirtyPaths (refuse to commit a path a human was already editing)
//   - createConsolidationCommit (stage only the run's paths, summarize counts)
//   - getCommits / getNoteCommits
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isGitRepo,
  getDirtyPaths,
  createConsolidationCommit,
  getCommits,
  getNoteCommits,
} from '../src/vault/git.ts';

/** Run git with an argument array (no shell) and return stdout. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

/** Create a temp git repo with a deterministic identity. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-git-commit-'));
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

test('git: isGitRepo is true in a repo and false in a plain directory', () => {
  const repo = initRepo();
  assert.equal(isGitRepo(repo), true);

  const plain = mkdtempSync(join(tmpdir(), 'circadia-nogit-'));
  assert.equal(isGitRepo(plain), false);
});

test('git: getDirtyPaths reports only the given paths with uncommitted changes', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'a\n');
  writeFileSync(join(repo, 'b.md'), 'b\n');
  commitAll(repo, 'init', '2020-01-01T00:00:00Z');

  writeFileSync(join(repo, 'a.md'), 'a changed\n');

  assert.deepEqual(getDirtyPaths(repo, ['a.md', 'b.md']), ['a.md']);
  assert.deepEqual(getDirtyPaths(repo, ['b.md']), []);
  assert.deepEqual(getDirtyPaths(repo, []), [], 'no paths means nothing to check');
});

test('git: createConsolidationCommit stages only the run paths and summarizes counts', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'a\n');
  writeFileSync(join(repo, 'unrelated.md'), 'u\n');
  commitAll(repo, 'init', '2020-01-01T00:00:00Z');

  // Both files change; only `a.md` is a run path.
  writeFileSync(join(repo, 'a.md'), 'a changed\n');
  writeFileSync(join(repo, 'unrelated.md'), 'u changed\n');

  const result = createConsolidationCommit(repo, ['a.md'], { promoted: 1, queued: 2, superseded: 3 });
  assert.ok(result, 'a commit must be created');
  assert.match(result.hash, /^[0-9a-f]{40}$/, 'the returned hash is a full commit hash');

  const committed = git(repo, ['show', '--name-only', '--format=', 'HEAD']);
  assert.ok(committed.includes('a.md'), 'the run path is committed');
  assert.ok(!committed.includes('unrelated.md'), 'an unrelated edit must not be swept in');

  const subject = git(repo, ['log', '-1', '--format=%s']);
  assert.ok(subject.includes('promoted 1 candidate(s)'), `message must summarize promotions: ${subject}`);
  assert.ok(subject.includes('queued 2 candidate(s)'), `message must summarize queued: ${subject}`);
  assert.ok(subject.includes('superseded 3 fact(s)'), `message must summarize supersessions: ${subject}`);

  // The unrelated edit is still uncommitted.
  assert.ok(git(repo, ['status', '--porcelain']).includes('unrelated.md'));
});

test('git: createConsolidationCommit returns null when there is nothing to commit', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'a\n');
  commitAll(repo, 'init', '2020-01-01T00:00:00Z');

  assert.equal(createConsolidationCommit(repo, ['a.md'], { promoted: 0, queued: 0, superseded: 0 }), null);
  assert.equal(createConsolidationCommit(repo, [], { promoted: 1, queued: 0, superseded: 0 }), null);
});

test('git: createConsolidationCommit returns null outside a git repo', () => {
  const plain = mkdtempSync(join(tmpdir(), 'circadia-nogit-commit-'));
  writeFileSync(join(plain, 'a.md'), 'a\n');
  assert.equal(createConsolidationCommit(plain, ['a.md'], { promoted: 1, queued: 0, superseded: 0 }), null);
});

test('git: getCommits lists commits oldest-first with their messages', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'a\n');
  commitAll(repo, 'first', '2020-01-01T00:00:00Z');
  writeFileSync(join(repo, 'b.md'), 'b\n');
  commitAll(repo, 'second', '2021-01-01T00:00:00Z');

  const commits = getCommits(repo);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].message, 'first');
  assert.equal(commits[1].message, 'second');
  assert.ok(commits[0].timestamp < commits[1].timestamp, 'oldest first');
});

test('git: getNoteCommits returns only the commits that touched the note', () => {
  const repo = initRepo();
  writeFileSync(join(repo, 'a.md'), 'a\n');
  commitAll(repo, 'first', '2020-01-01T00:00:00Z');
  writeFileSync(join(repo, 'b.md'), 'b\n');
  commitAll(repo, 'second', '2021-01-01T00:00:00Z');

  const commits = getNoteCommits(repo, 'a.md');
  assert.equal(commits.length, 1, 'only the commit that changed a.md');
  assert.equal(commits[0].message, 'first');
});
