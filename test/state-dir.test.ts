// Regression tests for C24: the state directory must come from STATE_DIR, never a
// hardcoded '.circadia' path literal. See src/config.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // Scan src/ recursively rather than a hardcoded list, so a new module cannot slip
  // past the guard. `src/config.ts` is the one place the literal is defined.
  const allowed = new Set(['src/config.ts']);
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const offenders: string[] = [];
  for (const rel of readdirSync(srcDir, { recursive: true }) as string[]) {
    if (!rel.endsWith('.ts')) continue;
    const relPosix = `src/${rel.split(sep).join('/')}`;
    if (allowed.has(relPosix)) continue;
    if (readFileSync(join(srcDir, rel), 'utf8').includes("'.circadia'")) offenders.push(relPosix);
  }
  assert.deepEqual(offenders, [], `these files must use STATE_DIR, not a literal '.circadia': ${offenders.join(', ')}`);
});
