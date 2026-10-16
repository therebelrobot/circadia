// Advisory write lock for a vault (RFC-0003 §4).
//
// SQLite is in WAL mode without a `busy_timeout` in older builds, and nothing coordinated
// writers across processes before this. A long-running `circadia serve` and a cron-launched
// `circadia consolidate` can both write the vault and index; this file makes the second
// writer stop with a clear message instead of corrupting a fact or racing a commit.
//
// The lock is *advisory*: it is a file, not a kernel lock, so a process that ignores it can
// still write. Its job is to coordinate the programs that do honor it (every mutating CLI
// command, and the `serve` mutex holder). It names the vault, never the network: see
// docs/SECURITY.md T2/T4.
//
// The file lives under `.circadia/`, which is not derivable state. It is created with
// `flag: 'wx'`, so creation is atomic: exactly one process wins. A lock whose owning pid is
// gone *on this host* is stale and is replaced; a lock owned by another host cannot be
// probed, so it is treated as held.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_DIR } from '../config.ts';

export interface LockInfo {
  /** process id that took the lock */
  pid: number;
  /** host the process runs on; a pid is only meaningful on its own host */
  hostname: string;
  /** the command that holds it, e.g. `consolidate` or `serve` */
  command: string;
  /** ISO timestamp the lock was taken */
  startedAt: string;
}

export interface LockHandle {
  info: LockInfo;
  path: string;
  release(): void;
}

/** The advisory lock file for a vault. */
export function lockFilePath(vault: string): string {
  return join(vault, STATE_DIR, 'write.lock');
}

/**
 * Is a pid alive? Signal 0 performs the permission/existence check without sending a
 * signal. `ESRCH` means the process is gone; `EPERM` means it exists but is owned by
 * another user — alive for our purposes.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isLockInfo(v: unknown): v is LockInfo {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.pid === 'number' && typeof o.hostname === 'string' && typeof o.command === 'string' && typeof o.startedAt === 'string';
}

/** Read and validate the lock file. Returns null when it is absent or unparseable. */
export function readLock(file: string): LockInfo | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isLockInfo(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * A lock is stale when we can prove its holder is gone. We can only prove that for a pid
 * on *this* host. An unreadable lock file proves nothing about a live holder, so it is
 * also treated as stale (replaced); a lock from another host is treated as held.
 */
export function isStale(info: LockInfo | null, host: string, isAlive: (pid: number) => boolean = pidAlive): boolean {
  if (info === null) return true;
  if (info.hostname !== host) return false;
  return !isAlive(info.pid);
}

export interface LockHeldErrorInfo {
  path: string;
  info: LockInfo;
}

export class LockHeldError extends Error {
  readonly path: string;
  readonly info: LockInfo;
  constructor(path: string, info: LockInfo) {
    super(`${path} is locked by "${info.command}" (pid ${info.pid} on ${info.hostname}, since ${info.startedAt})`);
    this.name = 'LockHeldError';
    this.path = path;
    this.info = info;
  }
}

export interface AcquireOptions {
  /** override the clock (tests) */
  now?: () => Date;
  /** override the hostname (tests) */
  hostname?: string;
  /** override pid liveness (tests) */
  isAlive?: (pid: number) => boolean;
}

/**
 * Take the vault's advisory write lock, or throw `LockHeldError` when a live holder owns it.
 * The caller must call `release()`; `withWriteLock` does that in a `finally`.
 */
export function acquireLock(vault: string, command: string, opts: AcquireOptions = {}): LockHandle {
  const file = lockFilePath(vault);
  mkdirSync(dirname(file), { recursive: true });
  const host = opts.hostname ?? osHostname();
  const alive = opts.isAlive ?? pidAlive;
  const info: LockInfo = {
    pid: process.pid,
    hostname: host,
    command,
    startedAt: (opts.now?.() ?? new Date()).toISOString(),
  };

  // At most two passes: the second handles "the file was stale, we removed it, but another
  // process created a fresh one in between".
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(info) + '\n', { flag: 'wx' });
      return { info, path: file, release: () => releaseLock(file, info) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const existing = readLock(file);
    if (existing !== null && !isStale(existing, host, alive)) throw new LockHeldError(file, existing);
    // Stale or unreadable: replace it and retry.
    try {
      unlinkSync(file);
    } catch {
      // Another process may have removed it first; the retry will handle that.
    }
  }
  throw new Error(`could not acquire write lock at ${file}`);
}

/** Release a lock, but only if it is still ours (never delete a replacement's lock). */
export function releaseLock(file: string, info: LockInfo): void {
  if (!existsSync(file)) return;
  const cur = readLock(file);
  if (cur === null || (cur.pid === info.pid && cur.hostname === info.hostname)) {
    try {
      unlinkSync(file);
    } catch {
      // best effort; a stale file is replaced by the next acquirer
    }
  }
}

/**
 * Run `fn` while holding the vault's advisory write lock. The lock is released even when
 * `fn` throws. A live holder makes this throw `LockHeldError` before `fn` runs.
 */
export async function withWriteLock<T>(vault: string, command: string, fn: () => Promise<T> | T, opts: AcquireOptions = {}): Promise<T> {
  const handle = acquireLock(vault, command, opts);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
