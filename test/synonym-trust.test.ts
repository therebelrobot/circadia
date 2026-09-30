// C12 regression: synonym edges must not launder trust.
//
// A phrase's trust is the minimum trust of the passages it came from; a synonym
// edge takes the minimum trust of its two endpoint phrases. Before the fix the
// edge was hardcoded 'medium', so a low-trust phrase could bridge a query to
// content it should not reach at retrieval.trustFloor = 'medium'.
//
// The fixtures drive the real pipeline: embedPassages embeds the phrase nodes,
// and emitSynonymEdges builds the edges from those embeddings. No embeddings are
// inserted by hand.
//
// Temp vaults and temp index paths only; examples/vault/ is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { buildIndex, embedPassages } from '../src/index/indexer.ts';
import { recall } from '../src/retrieval/recall.ts';
import { openIndex } from '../src/index/db.ts';
import { parseNote } from '../src/vault/parse.ts';
import { passageHash, writeTriples } from '../src/extract/triples.ts';
import { HttpEmbeddingsClient, type EmbeddingsClient } from '../src/retrieval/embeddings.ts';
import { main } from '../src/cli/main.ts';
import { startMockEmbeddings } from './helpers/mock-embeddings.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-synonym-trust-'));

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// A 32-dim space: the first slots carry the vectors we care about, and every
// other text gets a unique one-hot in the tail, so unrelated phrases are
// orthogonal and cannot form accidental synonym edges.
const DIM = 32;
function vec(...head: number[]): number[] {
  const v = new Array<number>(DIM).fill(0);
  head.forEach((x, i) => (v[i] = x));
  return v;
}

/** Deterministic embeddings client: `vectors` by exact text, unique one-hots otherwise. */
function vectorClient(vectors: Record<string, number[]>): EmbeddingsClient {
  const assigned = new Map<string, number[]>();
  let next = 8;
  return {
    model: 'test-model',
    dimensions: DIM,
    embed: async (texts) =>
      texts.map((t) => {
        let v: number[] | undefined = vectors[t.text];
        if (!v) {
          v = assigned.get(t.text);
          if (!v) {
            v = new Array<number>(DIM).fill(0);
            v[next++] = 1;
            assigned.set(t.text, v);
          }
        }
        return { id: t.id, embedding: Float32Array.from(v) };
      }),
  };
}

/** Write a one-triple cache entry for a note's first passage, hash-matched to the parser. */
function cacheTriple(vault: string, rel: string, subject: string, predicate: string, object: string): void {
  const cfg = loadConfig(vault);
  const note = parseNote(rel, readFileSync(join(vault, rel), 'utf8'), 0, cfg);
  const p = note.passages[0];
  writeTriples(vault, note.id, [
    { passageId: p.id, contentHash: passageHash(p.text), subject, predicate, object, conf: 0.9 },
  ]);
}

function synonymEdges(dbPath: string): { src: string; dst: string; trust: string | null }[] {
  const { db } = openIndex(dbPath);
  try {
    return db
      .prepare(`SELECT src, dst, trust FROM edges WHERE origin = 'synonym' AND type = 'similar' ORDER BY src, dst`)
      .all() as { src: string; dst: string; trust: string | null }[];
  } finally {
    db.close();
  }
}

function edgeTrust(edges: { src: string; dst: string; trust: string | null }[], a: string, b: string): string | null {
  const e = edges.find((x) => (x.src === a && x.dst === b) || (x.src === b && x.dst === a));
  return e ? e.trust : null;
}

/**
 * Trusted note (phrase "soil sensor") + low-trust web episode (phrase "moisture
 * probe") + a trusted note (phrase "forum scrapes") reachable ONLY through the
 * low-trust phrase. Vectors: soil-sensor ~ moisture-probe ~ forum-scrapes, but
 * soil-sensor !~ forum-scrapes, so the only path to forum#0 crosses the low phrase.
 */
async function buildLowTrustFixture(dir: string): Promise<{ cfg: Config; dbPath: string }> {
  write(dir, 'circadia.config.json', JSON.stringify({
    graph: { defaultExtraction: 'hipporag', hipporag: { synonymThreshold: 0.7, maxSynonymEdges: 20 } },
    retrieval: { trustFloor: 'medium' },
  }));
  write(dir, 'entities/projects/soil.md', '---\ntype: entity\nkind: project\n---\n# Soil Project\n\nThe soil sensor array logs moisture.\n');
  write(dir, 'episodes/2026/09/2026-09-20-web.md', '---\ntype: episode\nstarted: 2026-09-20\nsource: https://example.com/forum\nby: web\n---\n# Web clip\n\nThe moisture probe readings were scraped from a forum.\n');
  write(dir, 'entities/projects/forum.md', '---\ntype: entity\nkind: project\n---\n# Forum Project\n\nForum scrapes are archived nightly.\n');
  cacheTriple(dir, 'entities/projects/soil.md', 'soil sensor', 'logs', 'moisture');
  cacheTriple(dir, 'episodes/2026/09/2026-09-20-web.md', 'moisture probe', 'reads', 'readings');
  cacheTriple(dir, 'entities/projects/forum.md', 'forum scrapes', 'archived', 'nightly');

  const cfg = loadConfig(dir);
  const dbPath = join(dir, '.circadia', 'index.sqlite');
  buildIndex(dir, cfg, { dbPath });

  await embedPassages(dbPath, cfg, vectorClient({
    'soil sensor': vec(1),
    'moisture probe': vec(0.8, 0.6),
    'forum scrapes': vec(0.6, 0.8),
  }));
  return { cfg, dbPath };
}

test('C12: a low-trust phrase does not bridge a query past trustFloor=medium', async () => {
  const dir = join(tmp, 'low');
  const { cfg, dbPath } = await buildLowTrustFixture(dir);

  const r = await recall(dir, cfg, 'soil sensor', {
    dbPath,
    logAccess: false,
    mode: 'hipporag',
    topK: 20,
    tokenBudget: 100_000,
  });

  // The low-trust phrase's own passage must never surface.
  assert.ok(!r.hits.some((h) => h.passageId === '2026-09-20-web#0'), 'low-trust passage is not returned');
  // The trusted passage reachable ONLY through the low-trust phrase must not
  // surface either: both synonym edges are low, so they are filtered.
  assert.ok(!r.hits.some((h) => h.passageId === 'forum#0'), 'content behind the low-trust phrase is not reachable');
});

test('C12: a synonym edge between two trusted phrases survives trustFloor=medium', async () => {
  const dir = join(tmp, 'trusted');
  write(dir, 'circadia.config.json', JSON.stringify({
    graph: { defaultExtraction: 'hipporag', hipporag: { synonymThreshold: 0.7, maxSynonymEdges: 20 } },
    retrieval: { trustFloor: 'medium' },
  }));
  write(dir, 'entities/projects/alpha.md', '---\ntype: entity\nkind: project\n---\n# Alpha Project\n\nThe alpha sensor reports temperature.\n');
  write(dir, 'entities/projects/beta.md', '---\ntype: entity\nkind: project\n---\n# Beta Project\n\nThe beta probe reports humidity.\n');
  cacheTriple(dir, 'entities/projects/alpha.md', 'alpha sensor', 'reports', 'temperature');
  cacheTriple(dir, 'entities/projects/beta.md', 'beta probe', 'reports', 'humidity');

  const cfg = loadConfig(dir);
  const dbPath = join(dir, '.circadia', 'index.sqlite');
  buildIndex(dir, cfg, { dbPath });
  await embedPassages(dbPath, cfg, vectorClient({
    'alpha sensor': vec(1),
    'beta probe': vec(0.8, 0.6),
  }));

  const edges = synonymEdges(dbPath);
  assert.equal(edgeTrust(edges, 'p:alpha-sensor', 'p:beta-probe'), 'high', 'trusted endpoints -> high edge');

  const r = await recall(dir, cfg, 'alpha sensor', {
    dbPath,
    logAccess: false,
    mode: 'hipporag',
    topK: 20,
    tokenBudget: 100_000,
  });
  assert.ok(r.hits.some((h) => h.passageId === 'beta#0'), 'the trusted synonym edge survives the floor');
});

test('C12: a stored synonym edge trust equals the min of its endpoint phrases', async () => {
  const dir = join(tmp, 'edge-value');
  const { dbPath } = await buildLowTrustFixture(dir);
  const edges = synonymEdges(dbPath);

  // soil-sensor (high) <-> moisture-probe (low) => low
  assert.equal(edgeTrust(edges, 'p:soil-sensor', 'p:moisture-probe'), 'low');
  // moisture-probe (low) <-> forum-scrapes (high) => low
  assert.equal(edgeTrust(edges, 'p:moisture-probe', 'p:forum-scrapes'), 'low');
  // no direct edge between the two trusted phrases (their cosine is below threshold)
  assert.equal(edgeTrust(edges, 'p:soil-sensor', 'p:forum-scrapes'), null);
});

test('Phase 5: embedPassages embeds phrases, so synonym edges form end to end', async () => {
  const dir = join(tmp, 'e2e');
  write(dir, 'circadia.config.json', JSON.stringify({
    graph: { defaultExtraction: 'hipporag', hipporag: { synonymThreshold: 0.7, maxSynonymEdges: 20 } },
    embeddings: { provider: 'http', model: 'test-model', batchSize: 32 },
  }));
  write(dir, 'entities/projects/alpha.md', '---\ntype: entity\nkind: project\n---\n# Alpha Project\n\nThe alpha sensor reports temperature.\n');
  write(dir, 'entities/projects/beta.md', '---\ntype: entity\nkind: project\n---\n# Beta Project\n\nThe beta probe reports humidity.\n');
  cacheTriple(dir, 'entities/projects/alpha.md', 'alpha sensor', 'reports', 'temperature');
  cacheTriple(dir, 'entities/projects/beta.md', 'beta probe', 'reports', 'humidity');

  const cfg = loadConfig(dir);
  const dbPath = join(dir, '.circadia', 'index.sqlite');
  buildIndex(dir, cfg, { dbPath });

  // No manual embedding insertion: the pipeline itself must embed the phrase
  // nodes, or synonym edges never form in a real vault.
  const assigned = new Map<string, number[]>();
  let next = 8;
  const mock = await startMockEmbeddings((t) => {
    if (t === 'alpha sensor') return vec(1);
    if (t === 'beta probe') return vec(0.8, 0.6);
    let v = assigned.get(t);
    if (!v) {
      v = new Array<number>(DIM).fill(0);
      v[next++] = 1;
      assigned.set(t, v);
    }
    return v;
  });
  try {
    const client = new HttpEmbeddingsClient({ ...cfg.embeddings, endpoint: mock.url });
    await embedPassages(dbPath, cfg, client);

    const { db } = openIndex(dbPath);
    const phraseRows = db
      .prepare(`SELECT id, embedding IS NOT NULL AS has_emb FROM nodes WHERE kind = 'phrase' ORDER BY id`)
      .all() as { id: string; has_emb: number }[];
    db.close();
    assert.ok(phraseRows.length >= 2, 'phrase nodes exist');
    assert.ok(phraseRows.every((r) => r.has_emb === 1), 'every phrase node got an embedding from the pipeline');

    const edges = synonymEdges(dbPath);
    assert.equal(edgeTrust(edges, 'p:alpha-sensor', 'p:beta-probe'), 'high', 'synonym edge formed without manual embedding');
  } finally {
    await mock.close();
  }
});

test('cli: index summary reflects synonym edges written by the embedding step', async () => {
  const dir = join(tmp, 'cli');
  const assigned = new Map<string, number[]>();
  let next = 8;
  const mock = await startMockEmbeddings((t) => {
    if (t === 'alpha sensor') return vec(1);
    if (t === 'beta probe') return vec(0.8, 0.6);
    let v = assigned.get(t);
    if (!v) {
      v = new Array<number>(DIM).fill(0);
      v[next++] = 1;
      assigned.set(t, v);
    }
    return v;
  });
  try {
    write(dir, 'circadia.config.json', JSON.stringify({
      graph: { defaultExtraction: 'hipporag', hipporag: { synonymThreshold: 0.7, maxSynonymEdges: 20 } },
      embeddings: { provider: 'http', model: 'test-model', batchSize: 32, endpoint: mock.url },
    }));
    write(dir, 'entities/projects/alpha.md', '---\ntype: entity\nkind: project\n---\n# Alpha Project\n\nThe alpha sensor reports temperature.\n');
    write(dir, 'entities/projects/beta.md', '---\ntype: entity\nkind: project\n---\n# Beta Project\n\nThe beta probe reports humidity.\n');
    cacheTriple(dir, 'entities/projects/alpha.md', 'alpha sensor', 'reports', 'temperature');
    cacheTriple(dir, 'entities/projects/beta.md', 'beta probe', 'reports', 'humidity');

    const log = console.log;
    const out: string[] = [];
    console.log = (s?: unknown) => { out.push(String(s)); };
    try {
      assert.equal(await main(['index', '--vault', dir]), 0);
    } finally {
      console.log = log;
    }
    // The summary is printed after embeddings, so it counts the synonym edge
    // that emitSynonymEdges just wrote (it was 0 before the fix).
    assert.match(out.join('\n'), /synonym=1/, 'the summary counts the synonym edge written during embedding');
  } finally {
    await mock.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
