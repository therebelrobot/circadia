// C26: direct tests for src/retrieval/graph-cache.ts.
//
// The module owns edge filtering (`edgeAllowed`), graph loading (`loadGraph`), and the
// per-(mode, asOf) cache used by long-running processes (MCP). A regression in the
// filter changes what recall can traverse, so each time/trust rule is pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { edgeAllowed, loadGraph, createGraphCache, type EdgeRow } from '../src/retrieval/graph-cache.ts';

/** A synthetic edge row with every time/trust field null unless overridden. */
function row(over: Partial<EdgeRow> = {}): EdgeRow {
  return {
    src: 'a',
    dst: 'b',
    origin: 'link',
    weight: 1,
    valid_from: null,
    valid_to: null,
    recorded_at: null,
    expired_at: null,
    trust: null,
    declared_created: null,
    ...over,
  };
}

/** A temp vault with two linked entity notes, indexed. Returns the vault and its config. */
function linkedVault(): { vault: string; cfg: ReturnType<typeof loadConfig> } {
  const vault = mkdtempSync(join(tmpdir(), 'circadia-gc-vault-'));
  mkdirSync(join(vault, 'entities'), { recursive: true });
  writeFileSync(join(vault, 'entities', 'alpha.md'), '---\ntype: entity\nkind: tool\n---\n# Alpha\n\nSee [[beta]].\n');
  writeFileSync(join(vault, 'entities', 'beta.md'), '---\ntype: entity\nkind: tool\n---\n# Beta\n');
  const cfg = loadConfig(vault);
  buildIndex(vault, cfg);
  return { vault, cfg };
}

test('graph-cache: edgeAllowed drops edges below the trust floor', () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'circadia-gc-')));
  const strict = { ...cfg, retrieval: { ...cfg.retrieval, trustFloor: 'high' as const } };

  assert.equal(edgeAllowed(row({ trust: 'low' }), null, strict), false);
  assert.equal(edgeAllowed(row({ trust: 'medium' }), null, strict), false);
  assert.equal(edgeAllowed(row({ trust: 'high' }), null, strict), true);
  assert.equal(edgeAllowed(row({ trust: null }), null, strict), true, 'an unlabeled edge is not filtered');
});

test('graph-cache: edgeAllowed at "now" drops superseded edges unless includeSuperseded', () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'circadia-gc-')));
  assert.equal(edgeAllowed(row({ expired_at: 1000 }), null, cfg), false);
  assert.equal(edgeAllowed(row({ expired_at: null }), null, cfg), true);

  const incl = { ...cfg, retrieval: { ...cfg.retrieval, includeSuperseded: true } };
  assert.equal(edgeAllowed(row({ expired_at: 1000 }), null, incl), true);
});

test('graph-cache: edgeAllowed at an as-of time applies system and world time', () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'circadia-gc-')));
  const T = 10_000;

  assert.equal(edgeAllowed(row({ declared_created: T + 1 }), T, cfg), false, 'note did not exist yet');
  assert.equal(edgeAllowed(row({ recorded_at: T + 1 }), T, cfg), false, 'recorded after as-of');
  assert.equal(edgeAllowed(row({ expired_at: T }), T, cfg), false, 'superseded at as-of');
  assert.equal(edgeAllowed(row({ valid_from: T + 1 }), T, cfg), false, 'not yet true');
  assert.equal(edgeAllowed(row({ valid_to: T }), T, cfg), false, 'no longer true');
  assert.equal(edgeAllowed(row({ valid_from: T - 1, valid_to: T + 1 }), T, cfg), true, 'true at as-of');
});

test('graph-cache: loadGraph builds an undirected graph for a mode', () => {
  const { vault, cfg } = linkedVault();
  const { db } = openIndex(join(vault, cfg.index.path));
  try {
    const g = loadGraph(db, 'wikilink', null, cfg);
    assert.ok(g.index.has('alpha'), 'alpha is a node');
    assert.ok(g.index.has('beta'), 'beta is a node');
    // A body wikilink is declared by the passage, so the edge is alpha#0 -> beta.
    const pi = g.index.get('alpha#0')!;
    const bi = g.index.get('beta')!;
    assert.ok(g.nbr[pi].includes(bi), 'the link is stored alpha#0 -> beta');
    assert.ok(g.nbr[bi].includes(pi), 'the graph is undirected');
  } finally {
    db.close();
  }
});

test('graph-cache: createGraphCache reuses a graph until invalidated', () => {
  const { vault, cfg } = linkedVault();
  const { db } = openIndex(join(vault, cfg.index.path));
  try {
    const cache = createGraphCache(db);
    const first = cache.getGraph('wikilink', null, cfg);
    const second = cache.getGraph('wikilink', null, cfg);
    assert.equal(first, second, 'a cached graph is reused for the same (mode, asOf)');

    cache.invalidate();
    const third = cache.getGraph('wikilink', null, cfg);
    assert.notEqual(first, third, 'invalidate forces a rebuild');
  } finally {
    db.close();
  }
});
