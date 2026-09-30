// Ablations by edge origin (Phase 7, Step 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAblations } from '../src/eval/ablate.ts';
import { MODE_ORIGINS } from '../src/retrieval/modes.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

test('typed ablations include contains/link/fact/provenance zeroed variants', () => {
  const names = buildAblations().map((a) => a.name);
  for (const origin of ['contains', 'link', 'fact', 'provenance']) {
    assert.ok(names.includes(`origin:typed:${origin}=0`), `missing origin:typed:${origin}=0`);
  }
});

test('each mode alone, and the two weight ablations, are present', () => {
  const names = buildAblations().map((a) => a.name);
  for (const mode of ['wikilink', 'typed', 'hipporag']) {
    assert.ok(names.includes(`mode:${mode}`), `missing mode:${mode}`);
  }
  assert.ok(names.includes('weights:activation=0'));
  assert.ok(names.includes('weights:importance=0'));
});

test('an origin variant actually zeroes the weight and fixes the mode', () => {
  const v = buildAblations().find((a) => a.name === 'origin:typed:fact=0');
  assert.ok(v, 'variant exists');
  assert.equal(v.config.graph.originWeights.fact, 0);
  assert.equal(v.config.graph.query.mode, 'typed');
  // the base config is untouched (variants are copies)
  assert.equal(DEFAULT_CONFIG.graph.originWeights.fact, 1.5);
});

test('a synthetic origin produces a new variant (no rework)', () => {
  const origins = { ...MODE_ORIGINS, typed: [...MODE_ORIGINS.typed, 'dream'] };
  const names = buildAblations(DEFAULT_CONFIG, origins).map((a) => a.name);
  assert.ok(names.includes('origin:typed:dream=0'), 'a new origin is picked up automatically');
});
