// Vector seeds (Phase 2, item 5) — the roadmap's key acceptance criterion:
// with embeddings enabled, a paraphrased query with NO keyword overlap still
// retrieves the right passage. Plus CLI smoke tests for relate/timeline.
// Temp vaults and temp index paths only; examples/vault/ is never modified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex, embedPassages } from '../src/index/indexer.ts';
import { recall } from '../src/retrieval/recall.ts';
import { HttpEmbeddingsClient } from '../src/retrieval/embeddings.ts';
import { main } from '../src/cli/main.ts';
import { startMockEmbeddings } from './helpers/mock-embeddings.ts';

const VAULT = resolve(import.meta.dirname, '..', 'examples', 'vault');
const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-vector-'));

test('vector seeds: a paraphrased query with no keyword overlap retrieves the right passage', async () => {
  const v = join(tmp, 'vec');
  mkdirSync(join(v, 'entities', 'projects'), { recursive: true });
  writeFileSync(
    join(v, 'palimpsest.config.json'),
    JSON.stringify({
      graph: { defaultExtraction: 'typed' },
      embeddings: { provider: 'http', model: 'test-model', batchSize: 8 },
    }),
  );
  writeFileSync(join(v, 'entities', 'projects', 'alpha.md'), '---\ntype: entity\nkind: project\n---\n# Alpha\n\nThe collector aggregates soil readings.\n');
  writeFileSync(join(v, 'entities', 'projects', 'beta.md'), '---\ntype: entity\nkind: project\n---\n# Beta\n\nBeta is about something else entirely.\n');
  const cfg = loadConfig(v);
  const dbPath = join(v, '.palimpsest', 'index.sqlite');
  buildIndex(v, cfg, { dbPath });

  // deterministic vectors: the target passage's text gets [1,0,0,0], everything
  // else gets [0,0,0,1] (orthogonal, i.e. maximally far)
  const mock = await startMockEmbeddings((t) => (t.includes('aggregates soil readings') ? [1, 0, 0, 0] : [0, 0, 0, 1]));
  try {
    const client = new HttpEmbeddingsClient({ ...cfg.embeddings, endpoint: mock.url });
    await embedPassages(dbPath, cfg, client);

    // no keyword overlap with any passage: "collector/aggregates/soil/readings"
    // vs "machine/combine/moisture/data"
    const query = 'how does the machine combine moisture data';
    const r = recall(v, cfg, query, {
      dbPath,
      logAccess: false,
      mode: 'wikilink',
      queryEmbedding: Float32Array.from([1, 0, 0, 0]),
    });
    assert.equal(r.hits.length > 0, true, 'vector seeds produce hits where keywords found none');
    assert.equal(r.hits[0].passageId, 'alpha#0', 'the vector-close passage is the top hit');
    const seed = r.seeds.find((s) => s.nodeId === 'alpha#0');
    assert.ok(seed, 'alpha#0 appears in the seed list');
    assert.ok(seed!.via.includes('vector'), 'alpha#0 was seeded via vector');
    // components stay explainable: no new component was added
    assert.deepEqual(Object.keys(r.hits[0].components).sort(), ['activation', 'graph', 'importance', 'seed']);
  } finally {
    await mock.close();
  }
});

test('vector seeds: without a queryEmbedding the same query finds nothing', () => {
  const v = join(tmp, 'vec');
  const cfg = loadConfig(v);
  const dbPath = join(v, '.palimpsest', 'index.sqlite');
  const r = recall(v, cfg, 'how does the machine combine moisture data', {
    dbPath,
    logAccess: false,
    mode: 'wikilink',
  });
  assert.equal(r.hits.length, 0, 'no keyword or entity overlap -> no hits');
});

test('cli: relate and timeline smoke over a copy of the example vault', async () => {
  const v = join(tmp, 'vault-copy');
  cpSync(VAULT, v, { recursive: true });
  rmSync(join(v, '.palimpsest', 'index.sqlite'), { force: true });
  rmSync(join(v, '.palimpsest', 'index.sqlite-wal'), { force: true });
  rmSync(join(v, '.palimpsest', 'index.sqlite-shm'), { force: true });

  const log = console.log;
  const out: string[] = [];
  console.log = (s?: unknown) => { out.push(String(s)); };
  const run = async (argv: string[]): Promise<{ code: number; text: string }> => {
    out.length = 0;
    const code = await main(argv);
    return { code, text: out.join('\n') };
  };
  try {
    assert.equal((await run(['index', '--vault', v])).code, 0);
    const relateRes = await run(['relate', 'orchard-sensors', 'pi-cluster', '--vault', v, '--json']);
    assert.equal(relateRes.code, 0);
    const relateOut = JSON.parse(relateRes.text) as { found: boolean; paths: { nodes: string[] }[] };
    assert.equal(relateOut.found, true, 'relate --json reports a path');
    assert.ok(relateOut.paths.some((p) => p.nodes[0] === 'orchard-sensors' && p.nodes[p.nodes.length - 1] === 'pi-cluster'));

    const timelineRes = await run(['timeline', 'orchard-sensors', '--vault', v, '--json']);
    assert.equal(timelineRes.code, 0);
    const timelineOut = JSON.parse(timelineRes.text) as { predicate: string }[];
    assert.ok(timelineOut.length >= 8, 'timeline --json reports the facts');
    assert.ok(timelineOut.some((t) => t.predicate === 'runs_on'));
  } finally {
    console.log = log;
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
