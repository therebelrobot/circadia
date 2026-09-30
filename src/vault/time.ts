// Time parsing for SCHEMA.md §4.3: YYYY | YYYY-MM | YYYY-MM-DD | ISO datetime.
// Dates without a time are interpreted in UTC so indexes are machine-independent.

import type { Interval } from '../types.ts';

/** Returns [startMs, endMsExclusive] of the period a value names, or null if unparseable. */
export function parsePeriod(raw: string): [number, number] | null {
  const s = raw.trim();
  let m = /^(\d{4})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    return [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)];
  }
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    if (mo < 0 || mo > 11) return null;
    return [Date.UTC(y, mo, 1), Date.UTC(y, mo + 1, 1)];
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(t)) return null;
    return [t, t + 86_400_000];
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    return [t, t + 1];
  }
  return null;
}

/** Point-in-time value (start of the named period). */
export function parseInstant(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  const p = parsePeriod(raw);
  return p ? p[0] : null;
}

/**
 * Parse `from..to` (half-open; either side may be empty). A bare value means `value..`.
 * Returns null on a malformed interval.
 */
export function parseInterval(raw: string): Interval | null {
  const s = raw.trim();
  if (s === '' || s === '..') return { from: null, to: null };
  const idx = s.indexOf('..');
  if (idx === -1) {
    const p = parsePeriod(s);
    return p ? { from: p[0], to: null } : null;
  }
  const a = s.slice(0, idx).trim();
  const b = s.slice(idx + 2).trim();
  const from = a ? parsePeriod(a) : null;
  const to = b ? parsePeriod(b) : null;
  if ((a && !from) || (b && !to)) return null;
  const iv: Interval = { from: from ? from[0] : null, to: to ? to[0] : null };
  if (iv.from !== null && iv.to !== null && iv.to <= iv.from) return null;
  return iv;
}

export function intervalContains(iv: Interval, t: number): boolean {
  return (iv.from === null || iv.from <= t) && (iv.to === null || t < iv.to);
}

/**
 * Format a Date as the LOCAL calendar date `YYYY-MM-DD`.
 *
 * Why not `toISOString().slice(0, 10)`: that returns the UTC date, so an evening run in
 * a negative-offset timezone (e.g. America/New_York) would stamp tomorrow's date on the
 * `consolidated:` field. This reads the local Y/M/D components directly, so the stamp
 * matches the operator's wall clock. Pure: no I/O, no timezone lookup beyond the Date's
 * own local getters.
 */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * System time for a fact's `at::` / `superseded::` field: the epoch ms of the LOCAL
 * calendar date, so `formatFact` (which renders UTC) stamps the operator's date rather
 * than tomorrow's. Use this instead of `Date.now()` anywhere a date is written to a note.
 *
 * `formatFact` renders `new Date(ms).toISOString().slice(0, 10)`, so the value must be
 * the UTC midnight of the local date — which is exactly what `parseInstant(localDateString)`
 * produces. Passing a raw `Date.now()` would render the UTC date and shift an evening run
 * in a negative-offset timezone onto the next day.
 */
export function systemDateNow(now: number = Date.now()): number {
  return parseInstant(localDateString(new Date(now))) ?? now;
}
