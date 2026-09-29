// Embeddings client + vector storage (Phase 2, items 3–4).
// Uses a local node:http mock server and temp vaults; never touches examples/vault/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex, incrementalIndex, embedPassages } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import {
  cosineSimilarity,
  topKByCosine,
  HttpEmbeddingsClient,
  NullEmbeddingsClient,
  createEmbeddingsClient,
} from '../src/retrieval/embeddings.ts';
import { startMockEmbeddings } from './helpers/mock-embeddings.ts';

const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-embeddings-'));

test('cosineSimilarity: orthogonal = 0, identical = 1, opposite = -1', () => {
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([0, 1, 0]);
  const c = Float32Array.from([2, 0, 0]);
  const d = Float32Array.from([-1, 0, 0]);
  assert.equal(cosineSimilarity(a, b), 0);
  assert.ok(Math.abs(cosineSimilarity(a, c) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(a, d) + 1) < 1e-6);
});

test('topKByCosine returns the correct top-K', () => {
  const q = Float32Array.from([1, 0]);
  const cands = [
    { id: 'a', embedding: Float32Array.from([1, 0]) }, // 1
    { id: 'b', embedding: Float32Array.from([0, 1]) }, // 0
    { id: 'c', embedding: Float32Array.from([0.7, 0.7]) }, // ~0.707
    { id: 'd', embedding: Float32Array.from([-1, 0]) }, // -1
  ];
  const top = topKByCosine(q, cands, 2);
  assert.deepEqual(top.map((t) => t.id), ['a', 'c']);
  assert.ok(top[0].score > top[1].score);
});

test('HttpEmbeddingsClient: batching, bearer header, parsing, dimensions', async () => {
  const mock = await startMockEmbeddings(() => [0, 0, 0, 0]);
  process.env.EMBED_TEST_KEY = 'sekret';
  try {
    const client = new HttpEmbeddingsClient({
      provider: 'http',
      endpoint: mock.url,
      model: 'test-model',
      apiKeyEnv: 'EMBED_TEST_KEY',
      batchSize: 2,
    });
    assert.equal(client.dimensions, null, 'dimensions unknown before first response');
    const out = await client.embed([
      { id: 'a', text: 'one' },
      { id: 'b', text: 'two' },
      { id: 'c', text: 'three' },
      { id: 'd', text: 'four' },
    ]);
    assert.equal(mock.requests.length, 2, '4 inputs at batchSize 2 -> 2 requests');
    assert.equal(mock.requests[0].input.length, 2);
    assert.equal(mock.requests[1].input.length, 2);
    assert.equal(mock.requests[0].auth, 'Bearer sekret');
    assert.deepEqual(out.map((o) => o.id), ['a', 'b', 'c', 'd']);
    assert.equal(out[0].embedding.length, 4);
    assert.equal(client.dimensions, 4, 'dimensions recorded from first response');
  } finally {
    delete process.env.EMBED_TEST_KEY;
    await mock.close();
  }
});

test('HttpEmbeddingsClient: retries once on 5xx, throws on persistent failure', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      if (calls === 1) {
        res.statusCode = 500;
        res.end('boom');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const cfg = { provider: 'http' as const, endpoint: `http://127.0.0.1:${port}/v1/embeddings`, model: 'm', apiKeyEnv: null, batchSize: 8 };
    const ok = new HttpEmbeddingsClient(cfg);
    const out = await ok.embed([{ id: 'a', text: 'x' }]);
    assert.equal(calls, 2, 'one retry after the 500');
    assert.deepEqual([...out[0].embedding], [1, 0]);

    // persistent failure: always 500 -> throws after the retry
    let calls2 = 0;
    const server2 = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls2++;
        res.statusCode = 503;
        res.end('down');
      });
    });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const port2 = (server2.address() as { port: number }).port;
    const bad = new HttpEmbeddingsClient({ ...cfg, endpoint: `http://127.0.0.1:${port2}/v1/embeddings` });
    await assert.rejects(() => bad.embed([{ id: 'a', text: 'x' }]));
    assert.equal(calls2, 2, 'gave up after one retry');
    await new Promise<void>((r) => server2.close(() => r()));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('NullEmbeddingsClient throws on embed()', async () => {
  const client = new NullEmbeddingsClient();
  await assert.rejects(() => client.embed([{ id: 'a', text: 'x' }]));
  assert.equal(createEmbeddingsClient({ provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 }) instanceof NullEmbeddingsClient, true);
});

test('embedPassages: embeds, records model, re-embeds only changed passages', async () => {
  const v = join(tmp, 'vault');
  mkdirSync(join(v, 'entities', 'projects'), { recursive: true });
  writeFileSync(
    join(v, 'palimpsest.config.json'),
    JSON.stringify({
      graph: { defaultExtraction: 'typed' },
      embeddings: { provider: 'http', model: 'test-model', batchSize: 2 },
      predicates: { strict: false, defs: {} },
    }),
  );
  writeFileSync(join(v, 'entities', 'projects', 'alpha.md'), '---\ntype: entity\nkind: project\n---\n# Alpha\n\nThe collector aggregates soil readings.\n');
  writeFileSync(join(v, 'entities', 'projects', 'beta.md'), '---\ntype: entity\nkind: project\n---\n# Beta\n\nBeta is about something else entirely.\n');
  const cfg = loadConfig(v);
  const dbPath = join(v, '.palimpsest', 'index.sqlite');
  buildIndex(v, cfg, { dbPath });

  const mock = await startMockEmbeddings((t) => (t.includes('aggregates soil readings') ? [1, 0, 0, 0] : [0, 0, 0, 1]));
  try {
    const client = new HttpEmbeddingsClient({ ...cfg.embeddings, endpoint: mock.url });
    const r1 = await embedPassages(dbPath, cfg, client);
    assert.equal(r1.embedded, 2, 'both passages embedded on first run');
    assert.equal(r1.total, 2);

    const { db } = openIndex(dbPath);
    const rows = db.prepare(`SELECT id, embedding, embedding_model FROM nodes WHERE kind = 'passage' ORDER BY id`).all() as { id: string; embedding: Uint8Array; embedding_model: string }[];
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.embedding, `${r.id} has an embedding blob`);
      assert.equal(r.embedding_model, 'test-model');
    }
    const alphaVec = new Float32Array(new Uint8Array(rows.find((r) => r.id === 'alpha#0')!.embedding).buffer);
    assert.deepEqual([...alphaVec], [1, 0, 0, 0], 'target passage got the near vector');
    db.close();

    // second run: nothing changed -> no new requests
    const r2 = await embedPassages(dbPath, cfg, client);
    assert.equal(r2.embedded, 0, 'no re-embedding when nothing changed');
    assert.equal(mock.requests.length, 1);

    // modify one passage: incremental index gives it a fresh row with NULL embedding
    writeFileSync(join(v, 'entities', 'projects', 'alpha.md'), '---\ntype: entity\nkind: project\n---\n# Alpha\n\nThe collector now aggregates soil readings nightly.\n');
    incrementalIndex(v, cfg, { dbPath });
    const r3 = await embedPassages(dbPath, cfg, client);
    assert.equal(r3.embedded, 1, 'only the changed passage re-embedded');
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1].input.length, 1, 'the second request carried only the changed text');
    assert.ok(mock.requests[1].input[0].includes('nightly'));
  } finally {
    await mock.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
