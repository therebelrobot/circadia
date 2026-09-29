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
