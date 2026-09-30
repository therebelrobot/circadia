// Deterministic lexical embeddings (Phase 7, Step 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex, embedPassages } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { cosineSimilarity } from '../src/retrieval/embeddings.ts';
import { TrigramEmbeddingsClient, trigramVector, TRIGRAM_DIMENSIONS } from '../src/eval/trigram-embeddings.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-trigram-'));

test('same text produces an identical vector', () => {
  const a = trigramVector('the quick brown fox');
  const b = trigramVector('the quick brown fox');
  assert.deepEqual([...a], [...b]);
  assert.equal(a.length, TRIGRAM_DIMENSIONS);
});

test('near-identical wording is closer than unrelated text', () => {
  const base = trigramVector('the quick brown fox jumps over the lazy dog');
  const near = trigramVector('the quick brown fox jumps over the lazy cat');
  const far = trigramVector('quantum chromodynamics lattice gauge theory');
  const nearSim = cosineSimilarity(base, near);
  const farSim = cosineSimilarity(base, far);
  assert.ok(nearSim > farSim, `near ${nearSim} should exceed far ${farSim}`);
  assert.ok(nearSim > 0.5, 'near-identical wording should be strongly similar');
});

test('embedPassages populates nodes.embedding deterministically', async () => {
  const vault = join(tmp, 'vault');
  mkdirSync(join(vault, 'entities', 'concepts'), { recursive: true });
  writeFileSync(join(vault, 'circadia.config.json'), JSON.stringify({ graph: { defaultExtraction: 'typed' } }));
  writeFileSync(
    join(vault, 'entities', 'concepts', 'alpha.md'),
    '---\ntype: entity\nkind: concept\n---\n# Alpha\n\nAlpha tracks soil moisture across the orchard.\n',
  );
  const cfg = loadConfig(vault);
  const dbPath = join(tmp, 'index.sqlite');
  buildIndex(vault, cfg, { dbPath });

  const client = new TrigramEmbeddingsClient();
  const first = await embedPassages(dbPath, cfg, client);
  assert.ok(first.embedded > 0, 'at least one passage embedded');

  const { db } = openIndex(dbPath);
  try {
    const row = db.prepare(`SELECT text, embedding, embedding_model FROM nodes WHERE id = 'alpha#0'`).get() as
      | { text: string; embedding: Uint8Array | null; embedding_model: string | null }
      | undefined;
    assert.ok(row, 'alpha#0 exists');
    assert.ok(row.embedding, 'embedding stored');
    assert.equal(row.embedding_model, 'trigram-hash-v1');
    const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
    const expected = trigramVector(row.text);
    assert.deepEqual([...stored], [...expected], 'stored vector matches the deterministic function');
  } finally {
    db.close();
  }

  // a second run is a no-op (same model -> nothing to re-embed)
  const second = await embedPassages(dbPath, cfg, client);
  assert.equal(second.embedded, 0, 'idempotent: nothing re-embedded');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
