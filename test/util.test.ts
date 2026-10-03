// B4: slugify() must cap its length so a long entity/concept name cannot produce an
// ENAMETOOLONG filename, while leaving short inputs byte-identical to before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, SLUG_MAX_LENGTH } from '../src/vault/util.ts';

test('slugify: short inputs are unchanged', () => {
  assert.equal(slugify('Pi Cluster'), 'pi-cluster');
  assert.equal(slugify('  Orchard Sensors!  '), 'orchard-sensors');
  assert.equal(slugify('Café'), 'cafe');
  assert.equal(slugify(''), '');
});

test('slugify: a long input is capped and fills the cap exactly', () => {
  const s = slugify('a'.repeat(500));
  assert.ok(s.length <= SLUG_MAX_LENGTH, `slug length ${s.length} must be <= ${SLUG_MAX_LENGTH}`);
  assert.equal(s.length, SLUG_MAX_LENGTH, 'a truncated slug fills the cap exactly');
});

test('slugify: two long inputs sharing a prefix produce different slugs', () => {
  const prefix = 'the-billing-api-payment-retry-policy-and-the-idempotency-key-handling-'.repeat(4);
  const a = slugify(prefix + 'alpha');
  const b = slugify(prefix + 'beta');
  assert.notEqual(a, b, 'distinct long inputs must not collide');
  assert.ok(a.length <= SLUG_MAX_LENGTH && b.length <= SLUG_MAX_LENGTH, 'both stay within the cap');
});

test('slugify: truncation is deterministic', () => {
  const long = 'x'.repeat(300);
  assert.equal(slugify(long), slugify(long));
});
