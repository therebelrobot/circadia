// Phase 6.5: MCP stdio transport conformance.
//
// These tests spawn the REAL server over stdio and assert on the bytes that cross the
// wire, not on handler return values. Expected values come from the JSON-RPC 2.0 spec:
//   - every response echoes the request's `id` (never `null`);
//   - a message without an `id` is a notification and gets no response;
//   - messages are newline-delimited and may be batched into one chunk or split across
//     chunks; `\r\n` and a final line without a trailing newline are both valid;
//   - stdout is the protocol channel and carries only JSON-RPC; logs go to stderr.
//
// TZ is pinned so the episode-filename test is deterministic: 2026-09-30T01:30:00Z is
// 2026-09-29 21:30 in America/New_York, so the local calendar date differs from the UTC
// date. Node re-reads process.env.TZ for subsequent Date operations.
process.env.TZ = 'America/New_York';

import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { writeEpisodes } from '../src/episodes/episode.ts';
import type { Segment } from '../src/episodes/segment.ts';
import { buildIndex } from '../src/index/indexer.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');

const children: ChildProcessWithoutNullStreams[] = [];
const vaults: string[] = [];

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-mcp-stdio-'));
  vaults.push(v);
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify(
      {
        $schemaVersion: 1,
        graph: {
          defaultExtraction: DEFAULT_CONFIG.graph.defaultExtraction,
          scopes: [],
          query: { mode: 'auto' },
        },
        predicates: { strict: false, defs: {} },
        embeddings: { provider: 'none' },
        index: { path: '.circadia/index.sqlite' },
        retrieval: DEFAULT_CONFIG.retrieval,
      },
      null,
      2,
    ),
  );
  mkdirSync(join(v, 'episodes'), { recursive: true });
  mkdirSync(join(v, 'entities'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  return v;
}

interface Harness {
  child: ChildProcessWithoutNullStreams;
  /** Every raw stdout line, including any non-JSON noise (used by the banner test). */
  lines: string[];
  /** Only the stdout lines that parse as JSON (the protocol responses). */
  jsonLines: () => string[];
  stderr: () => string;
  write: (s: string) => void;
  end: () => void;
  waitForJsonLines: (n: number, timeoutMs?: number) => Promise<string[]>;
  waitForStderr: (substr: string, timeoutMs?: number) => Promise<void>;
  settle: (ms: number) => Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function spawnServer(vault: string): Harness {
  const child = spawn(process.execPath, [BIN, 'mcp', '--vault', vault], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const lines: string[] = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (d: Buffer) => {
    stdoutBuf += d.toString('utf8');
    let i: number;
    while ((i = stdoutBuf.indexOf('\n')) !== -1) {
      lines.push(stdoutBuf.slice(0, i));
      stdoutBuf = stdoutBuf.slice(i + 1);
    }
  });
  child.stderr.on('data', (d: Buffer) => {
    stderrBuf += d.toString('utf8');
  });

  const jsonLines = (): string[] =>
    lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });

  return {
    child,
    lines,
    jsonLines,
    stderr: () => stderrBuf,
    write: (s) => {
      child.stdin.write(s);
    },
    end: () => {
      child.stdin.end();
    },
    waitForJsonLines: async (n, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (jsonLines().length < n) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${n} JSON stdout line(s); got ${jsonLines().length}: ${JSON.stringify(lines)}; stderr: ${stderrBuf}`,
          );
        }
        await delay(10);
      }
      return jsonLines().slice(0, n);
    },
    waitForStderr: async (substr, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (!stderrBuf.includes(substr)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for stderr to contain ${JSON.stringify(substr)}; got: ${stderrBuf}`);
        }
        await delay(10);
      }
    },
    settle: (ms) => delay(ms),
  };
}

afterEach(async () => {
  for (const c of children.splice(0)) {
    try {
      c.stdin.end();
    } catch {
      // already closed
    }
    c.kill('SIGKILL');
  }
  await delay(50);
  for (const v of vaults.splice(0)) {
    if (existsSync(v)) rmSync(v, { recursive: true, force: true });
  }
});

test('batches two messages in one write and echoes both ids', async () => {
  const h = spawnServer(makeVault());
  const a = { jsonrpc: '2.0', id: 100, method: 'initialize', params: {} };
  const b = { jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} };
  // Two complete messages in a single write: the server must split on `\n`, not treat
  // the chunk as one blob.
  h.write(JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n');
  const raw = await h.waitForJsonLines(2);
  const res = raw.map((l) => JSON.parse(l));
  assert.deepEqual(res.map((r) => r.id), [100, 101], 'each response must echo its request id');
  assert.equal(res[0].jsonrpc, '2.0');
  assert.ok(res[0].result.serverInfo, 'initialize must return serverInfo');
  assert.equal(typeof res[0].result.protocolVersion, 'string', 'initialize must return protocolVersion');
  assert.ok(Array.isArray(res[1].result.tools), 'tools/list must return tools');
});

test('never replies to a notification (message without an id)', async () => {
  const h = spawnServer(makeVault());
  const init = { jsonrpc: '2.0', id: 100, method: 'initialize', params: {} };
  const note = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const list = { jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} };
  h.write(JSON.stringify(init) + '\n' + JSON.stringify(note) + '\n' + JSON.stringify(list) + '\n');
  const raw = await h.waitForJsonLines(2);
  const res = raw.map((l) => JSON.parse(l));
  assert.deepEqual(res.map((r) => r.id), [100, 101], 'only the two requests get responses');
  // Give the server time to (incorrectly) emit a third response, then assert it did not.
  await h.settle(300);
  assert.equal(h.jsonLines().length, 2, 'the notification must not get a reply');
});

test('parses a message split across two writes', async () => {
  const h = spawnServer(makeVault());
  const msg = JSON.stringify({ jsonrpc: '2.0', id: 200, method: 'initialize', params: {} });
  const half = Math.floor(msg.length / 2);
  h.write(msg.slice(0, half));
  await h.settle(50);
  h.write(msg.slice(half) + '\n');
  const raw = await h.waitForJsonLines(1);
  const res = JSON.parse(raw[0]);
  assert.equal(res.id, 200, 'a message split across chunks must still parse');
  assert.equal(res.jsonrpc, '2.0');
  assert.ok(res.result.serverInfo);
  assert.equal(typeof res.result.protocolVersion, 'string');
});

test('handles CRLF terminators and a final line without a trailing newline', async () => {
  const h = spawnServer(makeVault());
  h.write(JSON.stringify({ jsonrpc: '2.0', id: 300, method: 'initialize', params: {} }) + '\r\n');
  const first = JSON.parse((await h.waitForJsonLines(1))[0]);
  assert.equal(first.id, 300, 'CRLF-terminated message must parse');

  // No trailing newline: the line is only complete at EOF.
  h.write(JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'tools/list', params: {} }));
  h.end();
  const raw = await h.waitForJsonLines(2);
  const second = JSON.parse(raw[1]);
  assert.equal(second.id, 301, 'a final line without a newline must still parse');
  assert.ok(Array.isArray(second.result.tools));
});

test('writes only JSON-RPC to stdout and the banner to stderr', async () => {
  const h = spawnServer(makeVault());
  await h.waitForStderr('starting MCP server');
  h.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  await h.waitForJsonLines(1);
  // Every raw stdout line must be a valid JSON-RPC message; the banner must not be here.
  for (const line of h.lines) {
    assert.ok(!line.includes('starting MCP server'), `banner leaked to stdout: ${line}`);
    const m = JSON.parse(line);
    assert.equal(m.jsonrpc, '2.0', `stdout line is not JSON-RPC: ${line}`);
  }
  assert.ok(h.stderr().includes('starting MCP server'), 'the banner must appear on stderr');
});

test('a remembered episode lands in the local-date folder, not the UTC-date folder', async () => {
  const vault = makeVault();
  const cfg = loadConfig(vault);
  // 2026-09-30T01:30:00Z is 2026-09-29 21:30 in America/New_York.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-30T01:30:00Z') });
  try {
    const seg: Segment = { text: 'Evening note.', boundary: 'none', title: 'Evening note' };
    const result = await writeEpisodes(vault, cfg, [seg], { by: 'agent' });
    assert.equal(result.episodes.length, 1);
    const p = result.episodes[0].path;
    assert.match(p, /^episodes\/2026\/09\/2026-09-29-/, `expected the local-date path, got ${p}`);
    assert.ok(existsSync(join(vault, p)), 'the episode file must exist at the local-date path');
  } finally {
    mock.timers.reset();
  }
});

// Phase 2 adjacency cache: a long-running server must pick up an external reindex. The
// cache is keyed on the index's `built_at`, so a rebuild invalidates it without a restart.
// The new note is reachable ONLY through the graph (its text does not contain the query
// token), so a stale cache would miss it.
test('a running server picks up an external reindex (graph cache invalidation)', async () => {
  const vault = makeVault();
  const cfg = loadConfig(vault);
  // alpha links to gamma; gamma does not exist yet, so the link is a placeholder.
  writeFileSync(
    join(vault, 'entities', 'alpha.md'),
    '---\ntype: entity\nkind: tool\n---\n# Alpha\n\nThe alpha widget. See [[gamma]].\n',
  );
  writeFileSync(join(vault, 'entities', 'beta.md'), '---\ntype: entity\nkind: tool\n---\n# Beta\n\nThe beta widget.\n');
  buildIndex(vault, cfg);

  const h = spawnServer(vault);
  h.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  await h.waitForJsonLines(1);

  const recall = async (harness: Harness, id: number): Promise<string> => {
    harness.write(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'recall', arguments: { query: 'alpha' } } }) + '\n',
    );
    const lines = await harness.waitForJsonLines(id);
    const res = JSON.parse(lines[id - 1]);
    return (res.result as { content: { text: string }[] }).content[0].text;
  };

  const first = await recall(h, 2);
  assert.ok(first.includes('alpha widget'), 'the seed note is returned');
  assert.ok(!first.includes('gamma widget'), 'gamma is not in the vault yet');

  // Externally add gamma and reindex. The delay guarantees a new `built_at`.
  await delay(5);
  writeFileSync(join(vault, 'entities', 'gamma.md'), '---\ntype: entity\nkind: tool\n---\n# Gamma\n\nThe gamma widget.\n');
  buildIndex(vault, cfg);

  const second = await recall(h, 3);
  assert.ok(second.includes('gamma widget'), 'the running server must see the reindexed graph');

  // A fresh server on the same vault returns the same thing.
  const fresh = spawnServer(vault);
  fresh.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  await fresh.waitForJsonLines(1);
  const freshText = await recall(fresh, 2);
  assert.ok(freshText.includes('gamma widget'), 'a fresh server sees gamma too');
});
