// Config tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-test-'));

test('loadConfig: finds circadia.config.json', () => {
  const v = join(tmp, 'circadia-vault');
  mkdirSync(v);
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify({ graph: { defaultExtraction: 'wikilink' } }));
  const cfg = loadConfig(v);
  assert.equal(cfg.graph.defaultExtraction, 'wikilink');
  rmSync(v, { recursive: true, force: true });
});

test('loadConfig: dreaming.* keys deep-merge over the defaults', () => {
  const v = join(tmp, 'circadia-dreaming');
  mkdirSync(v);
  writeFileSync(
    join(v, 'circadia.config.json'),
    JSON.stringify({ dreaming: { enabled: true, samplesPerNight: 5, trustFloor: 'high' } }),
  );
  const cfg = loadConfig(v);
  assert.equal(cfg.dreaming.enabled, true);
  assert.equal(cfg.dreaming.samplesPerNight, 5);
  assert.equal(cfg.dreaming.trustFloor, 'high');
  // untouched keys keep their defaults
  assert.equal(cfg.dreaming.minHops, 2);
  assert.equal(cfg.dreaming.noiseShare, 0.25);
  rmSync(v, { recursive: true, force: true });
});

test('loadConfig: an invalid dreaming value fails loudly', () => {
  const v = join(tmp, 'circadia-dreaming-bad');
  mkdirSync(v);
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify({ dreaming: { noiseShare: 2 } }));
  assert.throws(() => loadConfig(v), /dreaming\.noiseShare must be in \[0, 1\]/);
  rmSync(v, { recursive: true, force: true });
});
