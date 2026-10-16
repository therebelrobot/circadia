// RFC-0003 §5: scheduler time math and the disposable state file.
// Pure functions plus a temp dir for the state file; never touches examples/vault/.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDue,
  localSlotInstant,
  nextSlotAfter,
  parseHhMm,
  readServeState,
  serveStatePath,
  writeServeState,
} from '../src/serve/scheduler.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const dirs: string[] = [];
function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'circadia-sched-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

test('parseHhMm: valid times parse; invalid ones throw', () => {
  assert.deepEqual(parseHhMm('03:30'), { hh: 3, mm: 30 });
  assert.deepEqual(parseHhMm('00:00'), { hh: 0, mm: 0 });
  assert.deepEqual(parseHhMm('23:59'), { hh: 23, mm: 59 });
  assert.throws(() => parseHhMm('24:00'), /invalid schedule/);
  assert.throws(() => parseHhMm('3:30'), /invalid schedule/);
  assert.throws(() => parseHhMm('03:60'), /invalid schedule/);
});

test('localSlotInstant: a normal local time maps to the right UTC instant', () => {
  // 03:00 America/New_York on 2026-10-16 is EDT (UTC-4) → 07:00 UTC.
  assert.equal(new Date(localSlotInstant(2026, 10, 16, 3, 0, 'America/New_York')).toISOString(), '2026-10-16T07:00:00.000Z');
  // UTC+14 (Kiritimati) is on the other side of the date line.
  assert.equal(new Date(localSlotInstant(2026, 10, 16, 3, 0, 'Pacific/Kiritimati')).toISOString(), '2026-10-15T13:00:00.000Z');
});

test('localSlotInstant: DST spring-forward runs at the first valid instant after the gap', () => {
  // 2026-03-08: 02:00→03:00 in America/New_York, so 02:30 does not exist. Run at 03:00 EDT.
  assert.equal(new Date(localSlotInstant(2026, 3, 8, 2, 30, 'America/New_York')).toISOString(), '2026-03-08T07:00:00.000Z');
});

test('localSlotInstant: DST fall-back picks the earlier of the repeated times', () => {
  // 2026-11-01: 01:30 happens twice (05:30 UTC EDT, then 06:30 UTC EST). Earlier wins.
  const slot = localSlotInstant(2026, 11, 1, 1, 30, 'America/New_York');
  assert.equal(new Date(slot).toISOString(), '2026-11-01T05:30:00.000Z');
  // The repeat does not fire a second time: a run at either occurrence is at/after the slot.
  const first = Date.parse('2026-11-01T05:30:00Z');
  const second = Date.parse('2026-11-01T06:30:00Z');
  assert.equal(isDue(second, '01:30', 'America/New_York', first), false, 'a run after the first occurrence is not due again');
});

test('isDue: before the slot is false, at/after the first time is true, then once', () => {
  const tz = 'America/New_York';
  const before = Date.parse('2026-10-16T06:00:00Z'); // 02:00 local, before 03:00 slot
  const at = Date.parse('2026-10-16T07:00:00Z'); // 03:00 local, the slot
  assert.equal(isDue(before, '03:00', tz, null), false);
  assert.equal(isDue(at, '03:00', tz, null), true);
  // After a run at the slot, it is not due again that day.
  assert.equal(isDue(Date.parse('2026-10-16T09:00:00Z'), '03:00', tz, at), false);
  // Next day's slot: due again.
  assert.equal(isDue(Date.parse('2026-10-17T07:00:00Z'), '03:00', tz, at), true);
});

test('isDue: at most one catch-up after any downtime', () => {
  const tz = 'America/New_York';
  const lastRun = Date.parse('2026-10-10T07:00:00Z'); // five days ago
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(isDue(now, '03:00', tz, lastRun), true, 'a missed slot catches up once');
  // Once the catch-up is recorded, no further catch-up until tomorrow.
  assert.equal(isDue(Date.parse('2026-10-16T13:00:00Z'), '03:00', tz, now), false);
});

test('nextSlotAfter returns the first slot strictly after now', () => {
  const tz = 'America/New_York';
  assert.equal(
    new Date(nextSlotAfter(Date.parse('2026-10-16T06:00:00Z'), '03:00', tz)).toISOString(),
    '2026-10-16T07:00:00.000Z',
  );
  assert.equal(
    new Date(nextSlotAfter(Date.parse('2026-10-16T08:00:00Z'), '03:00', tz)).toISOString(),
    '2026-10-17T07:00:00.000Z',
  );
});

test('serve state: absent, written, and re-read; unreadable is treated as absent', async () => {
  const v = tmpVault();
  assert.deepEqual(readServeState(v), { lastRun: null });
  writeServeState(v, {
    lastRun: { startedAt: '2026-10-16T07:00:00Z', endedAt: '2026-10-16T07:05:00Z', outcome: 'ok', counts: { promoted: 1, queued: 2, superseded: 0 } },
  });
  assert.equal(readServeState(v).lastRun?.counts.promoted, 1);
  assert.ok(existsSync(serveStatePath(v)));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(serveStatePath(v), 'not json');
  assert.deepEqual(readServeState(v), { lastRun: null }, 'disposable state: unreadable is absent');
});

test('resolveTimezone falls back to TZ, then UTC', async () => {
  const { resolveTimezone } = await import('../src/serve/scheduler.ts');
  const cfg = { ...DEFAULT_CONFIG, serve: { ...DEFAULT_CONFIG.serve, schedule: { consolidate: '03:00', timezone: 'America/Chicago' } } };
  assert.equal(resolveTimezone(cfg, {}), 'America/Chicago');
  const cfgNoTz = { ...DEFAULT_CONFIG, serve: { ...DEFAULT_CONFIG.serve, schedule: { consolidate: '03:00', timezone: null } } };
  assert.equal(resolveTimezone(cfgNoTz, { TZ: 'Europe/Paris' }), 'Europe/Paris');
  assert.equal(resolveTimezone(cfgNoTz, {}), 'UTC');
});
