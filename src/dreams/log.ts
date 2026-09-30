// The night's sleep report and fragments: `.circadia/dreams/log/<night>.json`
// (RFC-0001 "Wake recall").
//
// The log is non-derivable but DISPOSABLE (ADR-0011) and never committed to git. Reading
// it once and forgetting it is Stage 3 (`wake`); this module owns the shape, the write, the
// read, and TTL deletion of unread logs.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dreamsDir } from './candidates.ts';

/** Consolidation half of the sleep report. */
export interface ConsolidationReport {
  ran: boolean;
  episodes: number;
  promoted: number;
  queued: number;
}

/** REM half of the sleep report. */
export interface RemReport {
  ran: boolean;
  samples: number;
  kept: number;
  pruned: number;
  /** error class -> count (e.g. `llm.timeout`, `malformed`) */
  errors: Record<string, number>;
  /** set when the pass was skipped, e.g. `extraction.provider is none` */
  skipped?: string;
}

export interface SleepReport {
  consolidation: ConsolidationReport;
  rem: RemReport;
}

/** One sample's outcome. Pruned fragments are kept in the log (D7: pruning is logged). */
export interface DreamFragment {
  a: string;
  b: string;
  gist: string | null;
  status: 'kept' | 'pruned';
  salience: number;
}

export interface DreamLog {
  night: string;
  /** the seeded LCG seed, derived from the night's local date only */
  seed: number;
  /**
   * Epoch ms the pass first ran for this night. A re-run reuses it for the recent-side
   * scoring window, so the same pairs are sampled even hours later (RFC-0001
   * "Determinism and idempotence").
   */
  ranAt: number;
  model: string;
  report: SleepReport;
  fragments: DreamFragment[];
}

export function logDir(vaultRoot: string): string {
  return join(dreamsDir(vaultRoot), 'log');
}

export function logPath(vaultRoot: string, night: string): string {
  return join(logDir(vaultRoot), `${night}.json`);
}

/** Write (overwrite) the night's log. */
export function writeLog(vaultRoot: string, log: DreamLog): void {
  const path = logPath(vaultRoot, log.night);
  mkdirSync(logDir(vaultRoot), { recursive: true });
  writeFileSync(path, JSON.stringify(log, null, 2) + '\n');
}

/** Read the night's log, or null when it is absent or malformed. */
export function readLog(vaultRoot: string, night: string): DreamLog | null {
  const path = logPath(vaultRoot, night);
  if (!existsSync(path)) return null;
  try {
    const log = JSON.parse(readFileSync(path, 'utf8')) as DreamLog;
    return log && typeof log.night === 'string' ? log : null;
  } catch {
    return null;
  }
}

/**
 * Delete unread logs older than `ttlHours` (by file mtime). `ttlHours: 0` turns the TTL
 * off: the log is then deleted only by reading it (Stage 3 `wake`). Returns the nights
 * deleted.
 */
export function deleteExpiredLogs(vaultRoot: string, ttlHours: number, now: number): string[] {
  if (ttlHours <= 0) return [];
  const dir = logDir(vaultRoot);
  if (!existsSync(dir)) return [];
  const cutoff = now - ttlHours * 3_600_000;
  const deleted: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const abs = join(dir, name);
    try {
      if (statSync(abs).mtimeMs < cutoff) {
        rmSync(abs, { force: true });
        deleted.push(name.slice(0, -'.json'.length));
      }
    } catch {
      // a file that vanished between readdir and stat is already gone
    }
  }
  return deleted;
}
