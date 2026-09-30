// The dream pass refuses to run when `.circadia/dreams/` is not git-ignored, or when
// anything under it is tracked (ADR-0011). Exit codes: 0 = ignored (run), 1 = not ignored
// (refuse with a one-line fix), 128/other = refuse and say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDreamsIgnored } from '../src/dreams/gitignore.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-dreams-git-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  return dir;
}

test('not a git repo: the pass may run (nothing to leak into git)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-dreams-nogit-'));
  try {
    assert.deepEqual(checkDreamsIgnored(dir), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit 0: .circadia/dreams/ is git-ignored, so the pass runs', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, '.gitignore'), '.circadia/dreams/\n');
    assert.deepEqual(checkDreamsIgnored(repo), { ok: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('exit 1: not ignored, so the pass refuses with a one-line fix', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, '.gitignore'), '.circadia/index.sqlite*\n');
    const r = checkDreamsIgnored(repo);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /not git-ignored/);
    assert.match(r.reason ?? '', /\.circadia\/dreams\//);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('exit 128: a bare repo has no work tree, so the pass refuses and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-dreams-bare-'));
  try {
    git(dir, ['init', '-q', '--bare']);
    const r = checkDreamsIgnored(dir);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /check-ignore failed \(exit 128\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tracked file under .circadia/dreams/ is refused even when the candidate path is ignored', () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, '.gitignore'), '.circadia/dreams/\n');
    mkdirSync(join(repo, '.circadia', 'dreams', 'log'), { recursive: true });
    // Track a *different* file under the directory: `check-ignore` on the candidate path
    // still exits 0 (it is ignored and untracked), so only `ls-files` catches the leak.
    writeFileSync(join(repo, '.circadia', 'dreams', 'log', 'old.json'), '{}\n');
    git(repo, ['add', '-f', '.circadia/dreams/log/old.json']);
    git(repo, ['commit', '-qm', 'track a dream file']);
    const r = checkDreamsIgnored(repo);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /tracked files/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
