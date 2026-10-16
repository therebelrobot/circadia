// Write coordination for `circadia serve` (RFC-0003 §4).
//
// Mutating operations (`remember`, `wake`, `endorse_dream`, `dismiss_dream`, a reindex, and
// the scheduled `consolidate`/`dream`) run under one in-process async mutex. Reads
// (`recall`, `timeline`, `relate`, `get_note`) never take it. Because a CLI command can run
// in another process (e.g. `docker exec … circadia review`), the mutex holder also takes the
// vault's advisory lockfile (src/util/lockfile.ts).
//
// Consolidation takes minutes. Holding the gate the whole time would block `remember` for
// the whole run, so a mutating tool call waits at most `serve.lockWaitMs` and then fails
// with a retryable error that names the running job. A scheduled job waits without a limit.

import { LockHeldError, acquireLock, type LockHandle } from '../util/lockfile.ts';

/** A retryable "the vault is busy" failure (RFC-0003 §4). */
export class LockWaitError extends Error {
  readonly job: string;
  readonly retryable = true;
  constructor(job: string, waitMs: number) {
    super(
      waitMs === Number.POSITIVE_INFINITY
        ? `vault is busy with "${job}"`
        : `write lock not acquired within ${waitMs} ms; "${job}" is running`,
    );
    this.name = 'LockWaitError';
    this.job = job;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never keep the process (or a test) alive just for a poll timer.
    if (typeof t.unref === 'function') t.unref();
  });
}

export class WriteGate {
  private tail: Promise<void> = Promise.resolve();
  private holder: string | null = null;

  /** The command currently holding the gate, or null. Named in a `LockWaitError`. */
  get currentJob(): string | null {
    return this.holder;
  }

  /**
   * Run `fn` while holding the gate and the advisory lockfile. Waits up to `waitMs` for both
   * (`Infinity` for a scheduled job). Throws `LockWaitError` on an in-process timeout and
   * `LockHeldError` when another process owns the lockfile past the deadline.
   */
  async run<T>(vault: string, command: string, waitMs: number, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });

    const gotTurn =
      waitMs === Number.POSITIVE_INFINITY
        ? (await prev, true)
        : await Promise.race([prev.then(() => true), sleep(waitMs).then(() => false)]);
    if (!gotTurn) {
      release();
      throw new LockWaitError(this.holder ?? 'another job', waitMs);
    }

    this.holder = command;
    const started = Date.now();
    try {
      const remaining = waitMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.max(0, waitMs - (Date.now() - started));
      const lock = await this.acquireWithWait(vault, command, remaining);
      try {
        return await fn();
      } finally {
        lock.release();
      }
    } finally {
      this.holder = null;
      release();
    }
  }

  private async acquireWithWait(vault: string, command: string, waitMs: number): Promise<LockHandle> {
    const deadline = waitMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + waitMs;
    for (;;) {
      try {
        return acquireLock(vault, command);
      } catch (e) {
        if (!(e instanceof LockHeldError)) throw e;
        if (Date.now() >= deadline) throw e;
        await sleep(50);
      }
    }
  }
}
