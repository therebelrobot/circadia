// Phase 6.5 follow-up: connect to the real server with the OFFICIAL MCP TypeScript SDK.
//
// The hand-written stdio tests in mcp-stdio.test.ts assert on raw bytes, but they do not
// validate the handshake the way a real client does. The SDK does: it rejects an
// `initialize` result that is missing `protocolVersion` before anything else runs. This
// test is the one that would have caught that gap, and it will catch the next spec gap.
//
// @modelcontextprotocol/sdk is a dev dependency only; the runtime stays zero-dependency.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONFIG_FILENAME, DEFAULT_CONFIG } from '../src/config.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');

const vaults: string[] = [];

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-mcp-sdk-'));
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

function episodeFiles(v: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(join(v, 'episodes'));
  return out;
}

afterEach(() => {
  for (const v of vaults.splice(0)) {
    if (existsSync(v)) rmSync(v, { recursive: true, force: true });
  }
});

test('official MCP SDK connects, lists tools, and calls one', async () => {
  const vault = makeVault();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp', '--vault', vault],
  });
  const client = new Client({ name: 'circadia-sdk-test', version: '0.0.0' });
  try {
    // connect() performs the initialize handshake and validates the result. A missing
    // protocolVersion throws here, before any tool call.
    await client.connect(transport);

    const tools = await client.listTools();
    assert.equal(tools.tools.length, 5, 'the server must advertise 5 tools');
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ['get_note', 'recall', 'relate', 'remember', 'timeline'],
    );

    const res = await client.callTool({
      name: 'remember',
      arguments: { text: 'The orchard sensors report soil moisture.' },
    });
    assert.ok(!res.isError, 'remember should succeed');
    const content = res.content as Array<{ type: string; text: string }>;
    assert.ok(content[0].text.includes('Wrote'), `unexpected content: ${content[0].text}`);
    assert.equal(episodeFiles(vault).length, 1, 'remember must write one episode');

    // A business-logic refusal comes back as a tool result with isError: true, which the
    // client can show to the model without treating it as a transport failure.
    const refused = await client.callTool({ name: 'remember', arguments: { text: 'x', by: 'user' } });
    assert.equal(refused.isError, true, 'the by:user refusal must be a tool-level error');
    const refusedContent = refused.content as Array<{ type: string; text: string }>;
    assert.match(refusedContent[0].text, /not allowed over MCP/);
  } finally {
    await client.close();
  }
});
