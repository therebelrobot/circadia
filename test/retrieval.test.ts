import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, addEdge, personalizedPageRank } from '../src/retrieval/ppr.ts';
import { baseLevel, retrievalProbability } from '../src/retrieval/activation.ts';
import { Bm25Index, tokenize } from '../src/retrieval/keyword.ts';
import { deepMerge, DEFAULT_CONFIG, validateConfig } from '../src/config.ts';
import { extractionModeFor } from '../src/extract/scope.ts';
import { parseNote } from '../src/vault/parse.ts';

const opts = { damping: 0.5, maxIterations: 200, tolerance: 1e-12 };

test('PPR: mass concentrates at the seed and decays with distance', () => {
  const g = makeGraph();
  addEdge(g, 'a', 'b', 1);
  addEdge(g, 'b', 'c', 1);
  addEdge(g, 'c', 'd', 1);
  const p = personalizedPageRank(g, new Map([['a', 1]]), opts);
  const total = [...p.values()].reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `mass conserved (${total})`);
  assert.ok(p.get('a')! > p.get('b')! && p.get('b')! > p.get('c')! && p.get('c')! > p.get('d')!);
});

test('PPR: two seeds make their shared neighbour the hub (multi-hop association)', () => {
  const g = makeGraph();
  addEdge(g, 's1', 'hub', 1);
  addEdge(g, 's2', 'hub', 1);
  addEdge(g, 's1', 'x', 1);
  addEdge(g, 's2', 'y', 1);
  const p = personalizedPageRank(g, new Map([['s1', 1], ['s2', 1]]), opts);
  assert.ok(p.get('hub')! > p.get('x')!);
});

test('PPR: unknown seeds yield nothing, not a crash', () => {
  assert.equal(personalizedPageRank(makeGraph(), new Map([['nope', 1]]), opts).size, 0);
});

test('ACT-R: recency and frequency both raise base-level activation', () => {
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  const old = baseLevel([now - 30 * day], now, 0.5);
  const recent = baseLevel([now - day], now, 0.5);
  const frequent = baseLevel([now - 30 * day, now - 20 * day, now - 10 * day], now, 0.5);
  assert.ok(recent > old);
  assert.ok(frequent > old);
  assert.equal(baseLevel([], now, 0.5), -Infinity);
});

test('ACT-R: retrieval probability is 0.5 at the threshold age', () => {
  const now = 1_000_000_000_000;
  const B = baseLevel([now - 30 * 86_400_000], now, 0.5);
  assert.ok(Math.abs(retrievalProbability(B, 0.5, 30, 1) - 0.5) < 1e-9);
  assert.equal(retrievalProbability(-Infinity, 0.5, 30, 1), 0);
});

test('BM25 fallback ranks the matching passage first', () => {
  const idx = new Bm25Index();
  idx.add('a', 'capacitive probes resist corrosion');
  idx.add('b', 'drip irrigation at dawn');
  idx.add('c', 'probes probes probes corrosion corrosion');
  const r = idx.search('probe corrosion', 3);
  assert.equal(r[0].passageId, 'c');
  assert.ok(!r.some((h) => h.passageId === 'b'));
  assert.deepEqual(tokenize('The Orchard, is it?'), ['orchard']);
});

test('config: deep merge replaces arrays, merges objects; validation catches bad modes', () => {
  const c = deepMerge(DEFAULT_CONFIG, { graph: { query: { mode: 'typed' } }, vault: { ignore: ['x/**'] } });
  assert.equal(c.graph.query.mode, 'typed');
  assert.equal(c.graph.damping, DEFAULT_CONFIG.graph.damping);
  assert.deepEqual(c.vault.ignore, ['x/**']);
  const bad = deepMerge(DEFAULT_CONFIG, { graph: { defaultExtraction: 'magic', scopes: [{ match: {}, extract: 'typed' }] } });
  const errs = validateConfig(bad);
  assert.ok(errs.some((e) => e.includes('defaultExtraction')));
  assert.ok(errs.some((e) => e.includes('scopes[0].match')));
});

test('scope precedence: frontmatter > first matching rule > default', () => {
  const cfg = deepMerge(DEFAULT_CONFIG, {
    graph: {
      defaultExtraction: 'wikilink',
      scopes: [
        { match: { tags: ['deep'] }, extract: 'hipporag' },
        { match: { paths: ['entities/**'] }, extract: 'typed' },
      ],
    },
  });
  const note = (fm: string, path = 'entities/a/n.md') => parseNote(path, `---\ntype: entity\nkind: x\n${fm}\n---\n# n`, 0, cfg);
  assert.equal(extractionModeFor(note('tags: [deep]'), cfg).mode, 'hipporag');
  assert.equal(extractionModeFor(note('tags: [other]'), cfg).mode, 'typed');
  assert.equal(extractionModeFor(note('tags: [deep]\ngraph: wikilink'), cfg).mode, 'wikilink');
  assert.equal(extractionModeFor(note('', 'procedures/p.md'), cfg).mode, 'wikilink');
});
