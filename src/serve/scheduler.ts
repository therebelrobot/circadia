// Nightly consolidate scheduler for `circadia serve` (RFC-0003 §5).
//
// Built in, not cron. `serve.schedule.consolidate` is a local time `"HH:MM"`, or null to
// disable it (the default: a user who never sets it gets no model calls). Daily is the only
// frequency. The last *successful* run is recorded in `.circadia/serve-state.json`, which is
// non-derivable but disposable, like `.circadia/dreams/` (losing it costs at most one extra
// catch-up run).
//
// Time zones are handled with `Intl` (a Node built-in), including DST: a slot in a
// spring-forward gap runs at the first valid instant after the gap; a fall-back slot that
// repeats runs once (the earlier occurrence).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR, type Config } from '../config.ts';

export interface ServeRunCounts {
  promoted: number;
  queued: number;
  superseded: number;
}

export interface ServeLastRun {
  startedAt: string;
  endedAt: string;
  outcome: 'ok' | 'failed' | 'skipped';
  counts: ServeRunCounts;
  error?: string;
}

export interface ServeRunState {
  lastRun: ServeLastRun | null;
}

export function serveStatePath(vault: string): string {
  return join(vault, STATE_DIR, 'serve-state.json');
}

export function readServeState(vault: string): ServeRunState {
  const file = serveStatePath(vault);
  if (!existsSync(file)) return { lastRun: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ServeRunState;
    return { lastRun: raw.lastRun ?? null };
  } catch {
    // Disposable state: an unreadable file is treated as absent.
    return { lastRun: null };
  }
}

export function writeServeState(vault: string, state: ServeRunState): void {
  const file = serveStatePath(vault);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** `serve.schedule.timezone`, else `TZ`, else UTC. */
export function resolveTimezone(cfg: Config, env: NodeJS.ProcessEnv = process.env): string {
  return cfg.serve.schedule.timezone ?? env.TZ ?? 'UTC';
}

interface WallClock {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock time in `tz` at instant `t`. */
export function wallClock(tz: string, t: number): WallClock {
  const parts = formatter(tz).formatToParts(new Date(t));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute'), ss: get('second') };
}

function wallMillis(tz: string, t: number): number {
  const w = wallClock(tz, t);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
}

/**
 * The UTC instant for local wall time `y-m-d hh:mm` in `tz`. Scans ±15 h around the naive
 * instant (zones range from UTC-12 to UTC+14) and returns the earliest exact match. A
 * spring-forward gap has no exact match, so the first instant after the gap is returned; a
 * fall-back repeat returns its earlier occurrence.
 */
export function localSlotInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const target = Date.UTC(y, m - 1, d, hh, mm, 0);
  let firstAfter: number | null = null;
  for (let delta = -15 * 60; delta <= 15 * 60; delta++) {
    const t = target + delta * 60_000;
    const w = wallMillis(tz, t);
    if (w === target) return t;
    if (w > target && (firstAfter === null || t < firstAfter)) firstAfter = t;
  }
  return firstAfter ?? target;
}

/** The local calendar date in `tz` at instant `now`. */
export function localDate(now: number, tz: string): { y: number; m: number; d: number } {
  const w = wallClock(tz, now);
  return { y: w.y, m: w.m, d: w.d };
}

function addLocalDay(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

export function parseHhMm(schedule: string): { hh: number; mm: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule);
  if (!m) throw new Error(`invalid schedule "${schedule}" (expected "HH:MM")`);
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

/** The next slot strictly after `now`. */
export function nextSlotAfter(now: number, schedule: string, tz: string): number {
  const { hh, mm } = parseHhMm(schedule);
  let { y, m, d } = localDate(now, tz);
  for (let i = 0; i < 8; i++) {
    const slot = localSlotInstant(y, m, d, hh, mm, tz);
    if (slot > now) return slot;
    ({ y, m, d } = addLocalDay(y, m, d));
  }
  return now + 24 * 60 * 60 * 1000;
}

/**
 * Is the scheduled run due at `now`?
 *
 * Due when today's slot has passed and either no successful run is recorded or the last one
 * predates today's slot. That fires each slot once, and fires at most one catch-up after any
 * amount of downtime: once a run is recorded at or after the slot, it is not due again until
 * tomorrow's slot.
 */
export function isDue(now: number, schedule: string, tz: string, lastRunAt: number | null): boolean {
  const { hh, mm } = parseHhMm(schedule);
  const { y, m, d } = localDate(now, tz);
  const slot = localSlotInstant(y, m, d, hh, mm, tz);
  return now >= slot && (lastRunAt === null || lastRunAt < slot);
}
