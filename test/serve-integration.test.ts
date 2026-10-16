// RFC-0003 §2–§5, §9: `circadia serve` end to end over HTTP against a real temp vault.
// Temp vaults only; never touches examples/vault/.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { incrementalIndex } from '../src/index/indexer.ts';
import { acquireLock } from '../src/util/lockfile.ts';
import { startServe, checkServe, type ServeHandle } from '../src/serve/run.ts';
import { serveStatePath, readServeState } from '../src/serve/scheduler.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');
const W = 'w'.repeat(40);
const R = 'r'.repeat(40);
const TOKENS = { write: W, read: R };

const handles: ServeHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function makeVault(serveExtra: Record<string, unknown> = {}): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-serve-int-'));
  dirs.push(v);
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify(
      {
        graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'auto' } },
        predicates: { strict: false, defs: {} },
        embeddings: { provider: 'none' },
        extraction: { provider: 'none' },
        retrieval: DEFAULT_CONFIG.retrieval,
        serve: serveExtra,
      },
      null,
      2,
    ) + '\n',
  );
  mkdirSync(join(v, 'entities'), { recursive: true });
  mkdirSync(join(v, 'episodes'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  return v;
}

function episodeFiles(v: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(join(v, 'episodes'));
  return out;
}

async function start(v: string, over: Partial<Parameters<typeof startServe>[0]> = {}): Promise<{ url: string; handle: ServeHandle }> {
  const cfg = loadConfig(v);
  incrementalIndex(v, cfg);
  const hb = join(v, 'heartbeat.json');
  const handle = await startServe({
    target: { kind: 'vault', vault: v, cfg },
    tokens: TOKENS,
    bind: '127.0.0.1',
    port: 0,
    log: () => {},
    heartbeatFile: hb,
    ...over,
  });
  handles.push(handle);
  return { url: `http://127.0.0.1:${handle.port}/mcp`, handle };
}

const call = (url: string, token: string, id: number, method: string, params?: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });

const toolCall = (url: string, token: string, id: number, name: string, args: Record<string, unknown>): Promise<Response> =>
  call(url, token, id, 'tools/call', { name, arguments: args });

test('serve: initialize and tools/list expose the full tool set', async () => {
  const v = makeVault();
  const { url } = await start(v);
  const init = await call(url, W, 1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.status, 200);
  const list = (await (await call(url, W, 2, 'tools/list')).json()) as { result: { tools: { name: string }[] } };
  assert.equal(list.result.tools.length, 8);
});

test('serve: remember over HTTP writes one episode', async () => {
  const v = makeVault();
  const { url } = await start(v);
  const res = await toolCall(url, W, 1, 'remember', { text: 'The orchard sensors report soil moisture.' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  assert.match(body.result.content[0].text, /Wrote 1 episode/);
  assert.equal(episodeFiles(v).length, 1);
});

test('serve: recall works with a read token; remember with a read token is refused and writes nothing', async () => {
  const v = makeVault();
  const { url } = await start(v);
  // Seed one episode with the write token, then reindex so recall sees it.
  await toolCall(url, W, 1, 'remember', { text: 'The orchard sensors report soil moisture.' });
  const recall = await toolCall(url, R, 2, 'recall', { query: 'orchard soil moisture' });
  assert.equal(recall.status, 200);
  const rBody = (await recall.json()) as { result?: unknown; error?: unknown };
  assert.ok(rBody.result, 'recall with a read token must succeed');

  const before = episodeFiles(v).length;
  const refused = await toolCall(url, R, 3, 'remember', { text: 'A write with the wrong token.' });
  const refusedBody = (await refused.json()) as { error?: { message: string; data?: { scope?: string } } };
  assert.match(refusedBody.error?.message ?? '', /requires a write token/);
  assert.equal(refusedBody.error?.data?.scope, 'read');
  assert.equal(episodeFiles(v).length, before, 'a refused remember writes nothing');
});

test('serve: a mutating call during a held lock returns a retryable error naming the job', async () => {
  const v = makeVault({ lockWaitMs: 200 });
  const { url } = await start(v);
  const lock = acquireLock(v, 'consolidate');
  try {
    const res = await toolCall(url, W, 1, 'remember', { text: 'blocked' });
    const body = (await res.json()) as { error?: { code: number; data?: { retryable?: boolean; job?: string } } };
    assert.equal(body.error?.data?.retryable, true);
    assert.equal(body.error?.data?.job, 'consolidate');
    assert.equal(episodeFiles(v).length, 0, 'the tool did not run');
  } finally {
    lock.release();
  }
});

test('serve: a scheduled tick runs once and records disposable state', async () => {
  const v = makeVault({ schedule: { consolidate: '03:00', timezone: 'UTC' } });
  const before = Date.parse('2026-10-16T02:00:00Z');
  const after = Date.parse('2026-10-16T04:00:00Z');
  const { handle } = await start(v, { now: () => before, schedulerIntervalMs: 3_600_000 });
  // The startup catch-up tick is a no-op before the slot; state has no run yet.
  assert.equal(readServeState(v).lastRun, null);
  await handle.tick(after);
  const first = readServeState(v).lastRun;
  assert.ok(first, 'the slot fires once');
  // A second tick shortly after must not run again: the recorded run is at/after the slot.
  const stamp = first.startedAt;
  await handle.tick(after + 60_000);
  assert.equal(readServeState(v).lastRun?.startedAt, stamp, 'a run is not retried before the next slot');
  assert.ok(existsSync(serveStatePath(v)));
});

test('serve: heartbeat makes --check healthy; a stale heartbeat is unhealthy', async () => {
  const v = makeVault();
  const cfg = loadConfig(v);
  incrementalIndex(v, cfg);
  const hb = join(v, 'heartbeat.json');
  const handle = await startServe({ target: { kind: 'vault', vault: v, cfg }, tokens: TOKENS, bind: '127.0.0.1', port: 0, log: () => {}, heartbeatFile: hb });
  handles.push(handle);
  const now = Date.parse('2026-10-16T12:00:00Z');
  // Fresh heartbeat: healthy.
  assert.equal(checkServe({ heartbeatFile: hb, now: () => Date.now() }).healthy, true);
  // A far-future clock makes it stale (the heartbeat is written with the real clock).
  assert.equal(checkServe({ heartbeatFile: hb, now: () => now + 10 * 365 * 24 * 60 * 60_000 }).healthy, false);
  assert.equal(checkServe({ heartbeatFile: join(v, 'missing.json') }).healthy, false);
});

test('CLI: serve refuses to start without a write token or with a short one', () => {
  const v = makeVault();
  const run = (env: NodeJS.ProcessEnv): { status: number; stderr: string } => {
    try {
      execFileSync(process.execPath, [BIN, 'serve', '--vault', v], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
      return { status: 0, stderr: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? -1, stderr: err.stderr ?? '' };
    }
  };
  // Clear any inherited token so "no token" is deterministic.
  const noToken = run({ CIRCADIA_WRITE_TOKEN: '', CIRCADIA_WRITE_TOKEN_FILE: '', CIRCADIA_READ_TOKEN: '', CIRCADIA_READ_TOKEN_FILE: '' });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /without a write token/);
  const short = run({ CIRCADIA_WRITE_TOKEN: 'tooshort' });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /at least 32 bytes/);
});
