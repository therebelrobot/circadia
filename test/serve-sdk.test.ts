// RFC-0003 test 2: connect to the real `serve` HTTP transport with the OFFICIAL MCP
// TypeScript SDK. The hand-written HTTP tests assert on raw bytes; the SDK validates the
// Streamable-HTTP handshake and result shapes the way a real client does.
//
// @modelcontextprotocol/sdk is a dev dependency only; the runtime stays zero-dependency.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { incrementalIndex } from '../src/index/indexer.ts';
import { startServe, type ServeHandle } from '../src/serve/run.ts';

const W = 'w'.repeat(40);
const handles: ServeHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-serve-sdk-'));
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

async function serve(v: string): Promise<string> {
  const cfg = loadConfig(v);
  incrementalIndex(v, cfg);
  const handle = await startServe({ target: { kind: 'vault', vault: v, cfg }, tokens: { write: W, read: null }, bind: '127.0.0.1', port: 0, log: () => {}, heartbeatFile: join(v, 'hb.json') });
  handles.push(handle);
  return `http://127.0.0.1:${handle.port}/mcp`;
}

test('official MCP SDK over Streamable HTTP connects, lists tools, calls one, and runs two matched-id calls concurrently', async () => {
  const v = makeVault();
  const url = await serve(v);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${W}` } },
  });
  const client = new Client({ name: 'circadia-serve-sdk-test', version: '0.0.0' });
  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ['dismiss_dream', 'endorse_dream', 'get_note', 'recall', 'relate', 'remember', 'timeline', 'wake'],
    );

    const res = await client.callTool({ name: 'remember', arguments: { text: 'The orchard sensors report soil moisture.' } });
    assert.ok(!res.isError, 'remember should succeed over HTTP');
    assert.equal(episodeFiles(v).length, 1, 'remember must write one episode');

    // Two concurrent calls with matched ids: the server answers each with its request id.
    const [a, b] = await Promise.all([
      client.callTool({ name: 'recall', arguments: { query: 'orchard sensors' } }),
      client.callTool({ name: 'recall', arguments: { query: 'soil moisture' } }),
    ]);
    assert.ok(Array.isArray(a.content) && Array.isArray(b.content), 'both concurrent calls returned results');
  } finally {
    await client.close();
  }
});
