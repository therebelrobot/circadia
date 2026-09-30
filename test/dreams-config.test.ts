// Dreaming config (RFC-0001 "Config"): the nine dreaming.* keys, their defaults, and
// validation. The two floors are distinct: dreaming.trustFloor is the SAMPLING floor,
// retrieval.trustFloor is the TRAVERSAL floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, deepMerge, validateConfig } from '../src/config.ts';

test('dreaming defaults: a user who sets nothing gets no dreaming', () => {
  assert.deepEqual(DEFAULT_CONFIG.dreaming, {
    enabled: false,
    samplesPerNight: 20,
    minHops: 2,
    recentDays: 7,
    noiseShare: 0.25,
    trustFloor: 'medium',
    recallFragments: 3,
    logTtlHours: 12,
    candidateTtlNights: 14,
  });
});

test('dreaming.trustFloor is the sampling floor, distinct from retrieval.trustFloor', () => {
  assert.equal(DEFAULT_CONFIG.dreaming.trustFloor, 'medium');
  assert.equal(DEFAULT_CONFIG.retrieval.trustFloor, 'low');
});

test('validateConfig accepts the defaults', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
});

test('validateConfig rejects bad dreaming values', () => {
  const cases: [string, unknown][] = [
    ['dreaming.samplesPerNight', -1],
    ['dreaming.samplesPerNight', 1.5],
    ['dreaming.minHops', 0],
    ['dreaming.minHops', 1.5],
    ['dreaming.recentDays', -1],
    ['dreaming.noiseShare', 1.5],
    ['dreaming.noiseShare', -0.1],
    ['dreaming.trustFloor', 'nope'],
    ['dreaming.recallFragments', -1],
    ['dreaming.logTtlHours', -1],
    ['dreaming.candidateTtlNights', -1],
  ];
  for (const [key, value] of cases) {
    const sub = key.split('.')[1];
    const cfg = deepMerge(DEFAULT_CONFIG, { dreaming: { [sub]: value } });
    const errs = validateConfig(cfg);
    assert.ok(
      errs.some((e) => e.startsWith(key)),
      `${key}=${String(value)} must be rejected; got ${errs.join('; ') || '(none)'}`,
    );
  }
});

test('validateConfig accepts the boundary values', () => {
  assert.deepEqual(validateConfig(deepMerge(DEFAULT_CONFIG, { dreaming: { logTtlHours: 0 } })), []);
  assert.deepEqual(validateConfig(deepMerge(DEFAULT_CONFIG, { dreaming: { noiseShare: 0 } })), []);
  assert.deepEqual(validateConfig(deepMerge(DEFAULT_CONFIG, { dreaming: { noiseShare: 1 } })), []);
  assert.deepEqual(validateConfig(deepMerge(DEFAULT_CONFIG, { dreaming: { samplesPerNight: 0 } })), []);
  assert.deepEqual(validateConfig(deepMerge(DEFAULT_CONFIG, { dreaming: { minHops: 1 } })), []);
});
