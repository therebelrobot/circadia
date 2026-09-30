// Regression tests for C24: the state directory must come from STATE_DIR, never a
// hardcoded '.circadia' path literal. See src/config.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR, CONFIG_FILENAME, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';

test('STATE_DIR is the single source of truth for the state directory', () => {
  assert.equal(STATE_DIR, '.circadia');
});

test('consolidate writes its pending file under STATE_DIR', async () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-state-dir-'));
  mkdirSync(join(v, 'episodes'), { recursive: true });
  writeFileSync(join(v, CONFIG_FILENAME), JSON.stringify({}));
  const cfg = loadConfig(v);
  const result = await consolidate(v, cfg, { dryRun: true });
  assert.equal(result.pendingPath, join(v, STATE_DIR, 'pending.jsonl'));
});

test('no source file constructs a literal .circadia path', () => {
  const files = [
    'src/consolidation/consolidate.ts',
    'src/cli/review.ts',
    'src/extract/triples.ts',
    'src/cli/watch.ts',
    'src/cli/main.ts',
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!src.includes("'.circadia'"), `${f} must use STATE_DIR, not a literal '.circadia'`);
  }
});
