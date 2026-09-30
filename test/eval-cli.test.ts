// `circadia eval` CLI (Phase 7, Step 8). Generates a fixture into a temp dir and
// drives `main()` directly; never touches examples/vault/ or the committed
// baseline (the baseline path is redirected to a temp file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { main } from '../src/cli/main.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-cli-'));

/** Capture console.log while running `fn`, so the JSON output can be parsed. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => {
    lines.push(a.map((x) => String(x)).join(' '));
  };
  try {
    return { code: await fn(), out: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

test('eval --json returns 0 and valid JSON', async () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const { code, out } = await capture(() => main(['eval', '--vault', dir, '--json']));
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as { report: { results: unknown[]; trustViolations: number; failed: boolean } };
  assert.ok(Array.isArray(parsed.report.results), 'report.results is an array');
  assert.ok(parsed.report.results.length > 0, 'queries ran');
  assert.equal(parsed.report.trustViolations, 0);
  assert.equal(parsed.report.failed, false);
});

test('--update-baseline writes the baseline path', async () => {
  const dir = join(tmp, 'vault2');
  generateFixture(dir);
  const baselinePath = join(tmp, 'baseline.json');
  const { code } = await capture(() =>
    main(['eval', '--vault', dir, '--baseline', baselinePath, '--update-baseline', '--json']),
  );
  assert.equal(code, 0);
  assert.ok(existsSync(baselinePath), 'baseline written');
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
    queries: unknown[];
    failed: boolean;
    modes: Record<string, unknown>;
  };
  assert.ok(Array.isArray(parsed.queries));
  assert.equal(parsed.failed, false);
  assert.ok(parsed.modes.wikilink && parsed.modes.typed && parsed.modes.hipporag, 'forced-mode aggregates recorded');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
