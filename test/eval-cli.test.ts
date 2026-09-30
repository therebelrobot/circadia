// `circadia eval` CLI (Phase 7, Step 8 + cleanup). Generates a fixture into a
// temp dir and drives `main()` directly; never touches examples/vault/ or the
// committed baseline (the baseline path is redirected to a temp file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { main } from '../src/cli/main.ts';

const REPO = resolve(import.meta.dirname, '..');
const TRACKED_BASELINE = join(REPO, 'eval', 'baseline.json');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-cli-'));

/** Capture console.log and console.error while running `fn`. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => {
    out.push(a.map((x) => String(x)).join(' '));
  };
  console.error = (...a: unknown[]) => {
    err.push(a.map((x) => String(x)).join(' '));
  };
  try {
    return { code: await fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = origLog;
    console.error = origErr;
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

test('a non-fixture target cannot write the tracked baseline', async () => {
  const dir = join(tmp, 'personal');
  generateFixture(dir); // a temp copy, not the canonical fixture
  const before = readFileSync(TRACKED_BASELINE, 'utf8');
  const { code, err } = await capture(() => main(['eval', '--vault', dir, '--update-baseline', '--json']));
  assert.notEqual(code, 0, 'exits non-zero');
  assert.match(err, /--update-baseline needs an explicit --baseline/);
  assert.equal(readFileSync(TRACKED_BASELINE, 'utf8'), before, 'tracked baseline unchanged');
});

test('a symlinked baseline path into the repo is refused', async () => {
  const dir = join(tmp, 'personal-symlink');
  generateFixture(dir);
  const link = join(tmp, 'link-to-repo-eval');
  symlinkSync(join(REPO, 'eval'), link, 'dir');
  const before = readFileSync(TRACKED_BASELINE, 'utf8');
  const { code, err } = await capture(() =>
    main(['eval', '--vault', dir, '--baseline', join(link, 'baseline.json'), '--update-baseline', '--json']),
  );
  assert.notEqual(code, 0, 'a symlinked path into the repo is refused');
  assert.match(err, /outside the repo/);
  assert.equal(readFileSync(TRACKED_BASELINE, 'utf8'), before, 'tracked baseline unchanged');
});

test('a query naming a nonexistent id exits non-zero', async () => {
  const dir = join(tmp, 'missing');
  generateFixture(dir);
  const qPath = join(tmp, 'missing.jsonl');
  writeFileSync(
    qPath,
    JSON.stringify({ id: 'bad', query: 'pi cluster', kind: 'single-hop', expected_passages: ['does-not-exist#0'], split: 'dev' }) + '\n',
  );
  const { code, out } = await capture(() => main(['eval', '--vault', dir, '--queries', qPath, '--json']));
  assert.notEqual(code, 0, 'a missing gold id fails the run');
  const parsed = JSON.parse(out) as { missingIds: string[] };
  assert.deepEqual(parsed.missingIds, ['does-not-exist#0']);

  const { code: allowed } = await capture(() =>
    main(['eval', '--vault', dir, '--queries', qPath, '--allow-missing', '--json']),
  );
  assert.equal(allowed, 0, '--allow-missing lets it pass');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
