// Query embedding for recall's vector-seed path (bug fix).
//
// Before the fix, only the CLI embedded the query. The MCP handler (the path
// agents actually use) and the eval runner did not, so with an embeddings
// provider configured, agents got keyword + entity seeds only and the eval never
// measured the dense seed path. These tests fail before the fix and pass after.
//
// They never touch examples/vault/: the MCP vault is a temp dir and the eval
// fixture is generated into a temp dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { buildIndex, embedPassages } from '../src/index/indexer.ts';
import { handleToolsCall } from '../src/mcp/server.ts';
import { HttpEmbeddingsClient } from '../src/retrieval/embeddings.ts';
import { generateFixture } from '../eval/generate-fixture.ts';
import { runEval } from '../src/eval/run.ts';
import type { EvalQuery } from '../src/eval/types.ts';
import { startMockEmbeddings } from './helpers/mock-embeddings.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-query-embedding-'));
const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const REPO = resolve(import.meta.dirname, '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

/** A one-note vault whose config points embeddings at `endpoint`. */
function makeVault(endpoint: string): string {
  const vault = join(tmp, 'vault-' + Math.random().toString(36).slice(2));
  mkdirSync(join(vault, 'entities', 'tools'), { recursive: true });
  mkdirSync(join(vault, '.circadia'), { recursive: true });
  writeFileSync(
    join(vault, CONFIG_FILENAME),
    JSON.stringify(
      {
        graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'wikilink' } },
        predicates: { strict: false, defs: {} },
        embeddings: { provider: 'http', endpoint, model: 'test-model', apiKeyEnv: null, batchSize: 8 },
        index: { path: '.circadia/index.sqlite' },
        retrieval: { ...DEFAULT_CONFIG.retrieval, logAccess: false },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(vault, 'entities', 'tools', 'widget.md'),
    '---\ntype: entity\nkind: tool\n---\n# Widget\n\nThe widget calibration procedure aligns the sensor array.\n',
  );
  return vault;
}

function hasVectorSeed(seeds: { via: string[] }[] | undefined): boolean {
  return (seeds ?? []).some((s) => s.via.includes('vector'));
}

test('MCP recall embeds the query and produces a vector seed', async () => {
  const mock = await startMockEmbeddings(() => [1, 0, 0, 0]);
  try {
    const vault = makeVault(mock.url);
    const cfg = loadConfig(vault);
    buildIndex(vault, cfg);
    await embedPassages(join(vault, cfg.index.path), cfg, new HttpEmbeddingsClient(cfg.embeddings));

    const res = await handleToolsCall(vault, cfg, 'recall', { query: 'widget calibration' }, 1);
    assert.ok(res.result, 'recall must succeed');
    const seeds = (res.result as { seeds?: { via: string[] }[] }).seeds;
    assert.ok(hasVectorSeed(seeds), 'the MCP recall result must carry a via:vector seed');
  } finally {
    await mock.close();
  }
});

test('MCP server writes only the JSON-RPC response to stdout when embeddings are down', async () => {
  // Port 1 is reserved and refuses connections, so the client fails after one retry.
  const vault = makeVault('http://127.0.0.1:1/v1/embeddings');
  const cfg = loadConfig(vault);
  buildIndex(vault, cfg);

  // Spawn the real server: the stdout guarantee is a transport property, and the
  // test runner writes to stdout too, so an in-process capture would be polluted.
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN, 'mcp', '--vault', vault], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: 'widget calibration' } } }) + '\n',
    );
    const deadline = Date.now() + 15000;
    while (lines.length < 2) {
      if (Date.now() > deadline) throw new Error(`timed out; stdout=${JSON.stringify(lines)} stderr=${stderrBuf}`);
      await delay(20);
    }
    // Every stdout line must be a JSON-RPC message; the warning must not be here.
    for (const l of lines) {
      const m = JSON.parse(l) as { jsonrpc: string };
      assert.equal(m.jsonrpc, '2.0', `stdout line is not JSON-RPC: ${l}`);
    }
    const recallRes = JSON.parse(lines[1]) as {
      result?: { content: { text: string }[] };
      error?: unknown;
    };
    assert.ok(recallRes.result, 'recall must still succeed');
    assert.ok(!recallRes.error, 'a down endpoint must not be a protocol error');
    assert.ok(recallRes.result.content[0].text.includes('widget calibration procedure'), 'keyword hits still return');
    assert.match(stderrBuf, /query embedding failed/, 'the warning goes to stderr');
  } finally {
    child.kill('SIGKILL');
  }
});

test('runEval with trigram embeddings produces vector seeds, deterministically', async () => {
  const dir = join(tmp, 'eval-vault');
  generateFixture(dir);
  const queries = readQueries();
  const a = await runEval(dir, queries);
  const b = await runEval(dir, queries);
  assert.ok(a.length > 0, 'queries ran');
  assert.ok(a.some((r) => hasVectorSeed(r.seeds)), 'at least one query must carry a vector seed');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'two runs must be byte-identical (ADR-0010)');
});

test('runEval with embeddings:none makes no query embedding', async () => {
  const dir = join(tmp, 'eval-vault-none');
  generateFixture(dir);
  const results = await runEval(dir, readQueries(), { embeddings: 'none' });
  assert.ok(results.length > 0, 'queries ran');
  assert.ok(results.every((r) => !hasVectorSeed(r.seeds)), 'no query may carry a vector seed');
});

after(() => rmSync(tmp, { recursive: true, force: true }));
