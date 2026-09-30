// C26: direct tests for src/retrieval/recognition-memory.ts (HippoRAG 2 seed filter).
//
// The handoff noted this module was only exercised through the no-op verifier. These
// tests cover the real paths: embedding-based triple matching, LLM verification with a
// rejecting verifier, seed extraction, and the HTTP verifier's parse + fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { openIndex } from '../src/index/db.ts';
import { writeTriples, type CachedTriple } from '../src/extract/triples.ts';
import {
  findCandidateTriples,
  filterTriplesWithLLM,
  extractSeeds,
  NoopVerifier,
  HttpTripleVerifier,
  type TripleMatch,
  type TripleVerifier,
} from '../src/retrieval/recognition-memory.ts';

function triple(over: Partial<CachedTriple> = {}): CachedTriple {
  return { passageId: 'p#0', contentHash: 'h', subject: 'a', predicate: 'runs_on', object: 'b', conf: 0.9, ...over };
}

function match(over: Partial<TripleMatch> = {}): TripleMatch {
  return { triple: triple(), passageId: 'p#0', confidence: 1.0, ...over };
}

test('recognition-memory: findCandidateTriples matches triples to the nearest passages', async () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-rm-'));
  const cfg = loadConfig(v);
  const { db } = openIndex(join(v, cfg.index.path));
  try {
    // A passage node with a stored embedding, and a triple cache keyed to it.
    const emb = new Float32Array([1, 0, 0]);
    db.prepare(`INSERT INTO nodes (id, kind, embedding) VALUES (?, 'passage', ?)`).run(
      'p#0',
      new Uint8Array(emb.buffer),
    );
    writeTriples(v, 'p', [triple()]);

    const matches = await findCandidateTriples(v, db, new Float32Array([1, 0, 0]), cfg);
    assert.equal(matches.length, 1, 'the triple whose passage is nearest is returned');
    assert.equal(matches[0].passageId, 'p#0');
    assert.equal(matches[0].triple.subject, 'a');
  } finally {
    db.close();
  }
});

test('recognition-memory: findCandidateTriples returns nothing without triples or embeddings', async () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-rm-empty-'));
  const cfg = loadConfig(v);
  const { db } = openIndex(join(v, cfg.index.path));
  try {
    // No triples cached and no passage embeddings.
    assert.deepEqual(await findCandidateTriples(v, db, new Float32Array([1, 0, 0]), cfg), []);
  } finally {
    db.close();
  }
});

test('recognition-memory: filterTriplesWithLLM keeps high-confidence and drops low-confidence', async () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'circadia-rm-filter-')));
  const candidates = [match()];

  // NoopVerifier returns 1.0; combined (1 + 1) / 2 = 1 >= minConfidence (0.7).
  const kept = await filterTriplesWithLLM(candidates, 'q', new NoopVerifier(), cfg);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].confidence, 1);

  // A rejecting verifier returns 0; combined (1 + 0) / 2 = 0.5 < 0.7.
  const reject: TripleVerifier = { verify: async () => 0 };
  const dropped = await filterTriplesWithLLM(candidates, 'q', reject, cfg);
  assert.equal(dropped.length, 0, 'a low-confidence triple is filtered out');
});

test('recognition-memory: extractSeeds collects passage ids and phrase variants', () => {
  const seeds = extractSeeds([match()]);
  assert.deepEqual(seeds.passageIds, ['p#0']);
  assert.ok(seeds.phrases.includes('a'), 'subject phrase');
  assert.ok(seeds.phrases.includes('b'), 'object phrase');
  assert.ok(seeds.phrases.includes('a runs_on'), 'subject+predicate phrase');
  assert.ok(seeds.phrases.includes('runs_on b'), 'predicate+object phrase');
});

test('recognition-memory: HttpTripleVerifier parses confidence and falls back to 0.5', async () => {
  const responses: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages?: unknown };
      if (!Array.isArray(body.messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'messages required' }));
        return;
      }
      const content = responses.shift() ?? '{}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;

  try {
    const verifier = new HttpTripleVerifier(endpoint, 'mock', null);

    responses.push(JSON.stringify({ confidence: 0.9 }));
    assert.equal(await verifier.verify('q', triple()), 0.9);

    // A response with no numeric confidence falls back to the neutral 0.5.
    responses.push(JSON.stringify({}));
    assert.equal(await verifier.verify('q', triple()), 0.5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
