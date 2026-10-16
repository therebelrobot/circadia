// RFC-0003 §4: the advisory vault write lock.
//
// These tests never touch examples/vault/ or any tracked file; every vault is a mktemp
// directory. The unit tests inject hostname/pid-liveness so "a live holder" and "a stale
// holder" are deterministic; the CLI test uses the real hostname and the test process's own
// (live) pid to prove a real command exits nonzero while the lock is held.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { hostname as osHostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, DEFAULT_CONFIG } from '../src/config.ts';
import {
  LockHeldError,
  acquireLock,
  isStale,
  lockFilePath,
  pidAlive,
  readLock,
  releaseLock,
  withWriteLock,
} from '../src/util/lockfile.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');

const dirs: string[] = [];

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-lock-'));
  dirs.push(v);
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify({ graph: { defaultExtraction: DEFAULT_CONFIG.graph.defaultExtraction }, predicates: { defs: {} } }, null, 2) + '\n',
  );
  mkdirSync(join(v, 'entities'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  return v;
}

/** A pid that is definitely gone: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.ok(r.pid && r.pid > 0, 'spawnSync must report a pid');
  return r.pid;
}

afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

test('lock: acquire writes pid/hostname/command and release removes it', () => {
  const v = makeVault();
  const file = lockFilePath(v);
  const h = acquireLock(v, 'index');
  assert.equal(h.path, file);
  const info = readLock(file);
  assert.ok(info);
  assert.equal(info.pid, process.pid);
  assert.equal(info.hostname, osHostname());
  assert.equal(info.command, 'index');
  assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
  h.release();
  assert.equal(existsSync(file), false, 'release removes the lock');
});

test('lock: a live holder on this host makes a second acquire throw', () => {
  const v = makeVault();
  const host = 'test-host';
  const first = acquireLock(v, 'serve', { hostname: host, isAlive: () => true });
  try {
    assert.throws(
      () => acquireLock(v, 'consolidate', { hostname: host, isAlive: () => true }),
      (e: unknown) => e instanceof LockHeldError && (e as LockHeldError).info.command === 'serve',
    );
  } finally {
    first.release();
  }
});

test('lock: a dead pid on this host is stale and is replaced', () => {
  const v = makeVault();
  const host = 'test-host';
  const first = acquireLock(v, 'consolidate', { hostname: host, isAlive: () => true });
  // Simulate the holder having died: the pid in the file is no longer alive.
  try {
    const second = acquireLock(v, 'index', { hostname: host, isAlive: () => false });
    assert.equal(readLock(lockFilePath(v))?.command, 'index', 'the stale lock is replaced');
    second.release();
  } finally {
    first.release();
  }
});

test('lock: a lock owned by another host is treated as held, not stale', () => {
  const v = makeVault();
  acquireLock(v, 'serve', { hostname: 'other-host' });
  assert.equal(isStale(readLock(lockFilePath(v)), 'this-host'), false);
  assert.throws(() => acquireLock(v, 'index', { hostname: 'this-host' }), LockHeldError);
});

test('lock: an unparseable lock file is treated as stale and replaced', () => {
  const v = makeVault();
  const file = lockFilePath(v);
  writeFileSync(file, 'not json\n');
  const h = acquireLock(v, 'index', { hostname: 'test-host' });
  assert.equal(readLock(file)?.command, 'index');
  h.release();
});

test('lock: release never deletes a lock that replaced ours', () => {
  const v = makeVault();
  const file = lockFilePath(v);
  const first = acquireLock(v, 'index', { hostname: 'h', isAlive: () => true });
  // Another process replaces the lock (e.g. ours was stale from its view).
  writeFileSync(file, JSON.stringify({ pid: 4242, hostname: 'h', command: 'serve', startedAt: new Date().toISOString() }) + '\n');
  first.release();
  assert.ok(existsSync(file), "release must not remove another holder's lock");
  assert.equal(readLock(file)?.command, 'serve');
});

test('withWriteLock releases even when fn throws', async () => {
  const v = makeVault();
  await assert.rejects(
    withWriteLock(v, 'index', () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(existsSync(lockFilePath(v)), false, 'lock is released after a throw');
});

test('pidAlive: the current pid is alive; a dead child pid is not', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(deadPid()), false);
});

test('CLI: a mutating command exits nonzero while a live lock is held', () => {
  const v = makeVault();
  writeFileSync(
    lockFilePath(v),
    JSON.stringify({ pid: process.pid, hostname: osHostname(), command: 'serve', startedAt: new Date().toISOString() }) + '\n',
  );
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [BIN, 'index', '--vault', v], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    status = err.status ?? -1;
    stderr = err.stderr ?? '';
  }
  assert.notEqual(status, 0, 'index must fail while the lock is held');
  assert.match(stderr, /locked by "serve"/);
  // The lock is still there (the CLI did not take or remove it).
  assert.ok(existsSync(lockFilePath(v)));
});

test('CLI: a mutating command replaces a stale lock and succeeds', () => {
  const v = makeVault();
  writeFileSync(
    lockFilePath(v),
    JSON.stringify({ pid: deadPid(), hostname: osHostname(), command: 'serve', startedAt: new Date().toISOString() }) + '\n',
  );
  execFileSync(process.execPath, [BIN, 'index', '--vault', v], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(existsSync(lockFilePath(v)), false, 'the CLI releases its lock when done');
  assert.ok(statSync(join(v, '.circadia', 'index.sqlite')).isFile(), 'index ran');
  // Sanity: the file is a real lock file again only transiently; final read is gone.
  assert.equal(readLock(lockFilePath(v)), null);
});
