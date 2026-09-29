// `circadia watch`: watch the vault and reindex incrementally on change.
// Uses fs.watch (recursive) with a debounce; falls back to polling when recursive
// watch is unavailable or --poll is passed. Zero dependencies.

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { walkVault } from '../vault/walk.ts';
import { embedPassages, incrementalIndex, type IndexResult } from '../index/indexer.ts';

/** Debounce: wait this long after the last change event before reindexing. */
const DEBOUNCE_MS = 500;
/** Poll interval for the --poll fallback. */
const POLL_INTERVAL_MS = 2000;

export interface WatchOptions {
  dbPath?: string;
  /** use stat-polling instead of fs.watch */
  poll?: boolean;
  /** called after each successful reindex */
  onIndex?: (r: IndexResult) => void;
  /** overrides for tests */
  debounceMs?: number;
  pollIntervalMs?: number;
}

export interface WatchHandle {
  /** stop watching and release the fs watcher / poll timer */
  abort(): void;
}

export function watchVault(vaultRoot: string, config: Config, opts: WatchOptions = {}): WatchHandle {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  let stopped = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let prevSnapshot: Map<string, number> | null = null;

  /** Returns true when the reindex succeeded (poll mode uses this to decide
   * whether the change snapshot may advance). */
  const doIndex = (): boolean => {
    if (stopped) return false;
    const t0 = performance.now();
    try {
      const r = incrementalIndex(vaultRoot, config, { dbPath: opts.dbPath });
      const ms = Math.round(performance.now() - t0);
      console.log(`watch: reindexed ${r.stats.changed ?? 0} changed, ${r.stats.removed ?? 0} removed in ${ms} ms`);
      opts.onIndex?.(r);
      // best-effort embeddings: a down server must not block the text-only
      // index; the embedding is retried on the next change or via `index`
      if (config.embeddings.provider === 'http') {
        embedPassages(opts.dbPath ?? join(vaultRoot, config.index.path), config)
          .then((res) => {
            if (res.embedded > 0) console.log(`watch: embedded ${res.embedded} passage(s)`);
          })
          .catch((e) => console.error(`watch: embedding failed, continuing text-only: ${(e as Error).message}`));
      }
      return true;
    } catch (e) {
      console.error(`watch: reindex failed: ${(e as Error).message}`);
      return false;
    }
  };

  const schedule = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      doIndex();
    }, debounceMs);
  };

  const snapshot = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (const f of walkVault(vaultRoot, config.vault.ignore)) m.set(f.path, f.mtime);
    return m;
  };

  const startPoll = (): void => {
    prevSnapshot = snapshot();
    pollTimer = setInterval(() => {
      if (stopped) return;
      const cur = snapshot();
      let changed = false;
      for (const [p, mt] of cur) if (prevSnapshot!.get(p) !== mt) { changed = true; break; }
      if (!changed) for (const p of prevSnapshot!.keys()) if (!cur.has(p)) { changed = true; break; }
      if (!changed) return;
      // advance the snapshot only after a successful reindex: if doIndex fails,
      // the change must still be detected (and retried) on the next poll
      if (doIndex()) prevSnapshot = cur;
    }, pollIntervalMs);
  };

  if (opts.poll) {
    startPoll();
  } else {
    try {
      watcher = fsWatch(vaultRoot, { recursive: true }, (_event, filename) => {
        if (stopped) return;
        // ignore the derived index / access log / triple cache: reindexing writes
        // to them, and we must not let that trigger another reindex (infinite loop)
        if (filename && (filename.startsWith('.circadia') || filename.includes('.circadia'))) return;
        schedule();
      });
    } catch (e) {
      console.error(`watch: fs.watch recursive unavailable (${(e as Error).message}); falling back to polling`);
      startPoll();
    }
  }

  const abort = (): void => {
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (watcher) { watcher.close(); watcher = null; }
  };

  return { abort };
}
