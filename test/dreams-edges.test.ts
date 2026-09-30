// RFC-0001 Stage 4: dream edges at weight 0.
//
// The indexer builds `dream` edges from `.circadia/dreams/candidates.jsonl`, rebuilt from
// scratch on every index. At the default `graph.originWeights.dream: 0`, `addEdge` drops
// them from every PageRank graph, and `relate` excludes them always. These tests assert
// effects on disk (the edges table) and on the graph/relate outputs, not counts alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex, incrementalIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { loadGraph } from '../src/retrieval/graph-cache.ts';
import { relate, type RelateResult } from '../src/retrieval/relate.ts';
import { recall } from '../src/retrieval/recall.ts';
import { parseInstant } from '../src/vault/time.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-dreams-edges-'));

/** A minimal vault: alpha/beta unconnected, gamma -> delta by wikilink. */
function makeVault(name: string): string {
  const v = join(tmp, name);
  mkdirSync(join(v, 'entities', 'concepts'), { recursive: true });
  mkdirSync(join(v, '.circadia', 'dreams'), { recursive: true });
  // `created` is pinned before the dream night so an as-of query can see the notes while
  // the dream edge (recorded_at = the night) is still invisible.
  const note = (id: string, body: string): void =>
    writeFileSync(
      join(v, 'entities', 'concepts', `${id}.md`),
      `---\ntype: entity\nkind: concept\ncreated: 2026-09-01\n---\n# ${id}\n\n${body}\n`,
    );
  note('alpha', 'Alpha is a concept.');
  note('beta', 'Beta is a concept.');
  note('gamma', 'Gamma is a concept. See [[delta]].');
  note('delta', 'Delta is a concept.');
  return v;
}

function candidate(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: 'd-2026-09-29-abc',
    a: 'alpha',
    b: 'beta',
    gist: 'both are concepts',
    quotes: { a: 'alpha#0', b: 'beta#0' },
    hops: 2,
    salience: 0.5,
    model: 'fixture',
    night: '2026-09-29',
    expires: '2099-12-31',
    state: 'open',
    ...over,
  });
}

function writeCandidates(v: string, lines: string[]): void {
  writeFileSync(join(v, '.circadia', 'dreams', 'candidates.jsonl'), lines.join('\n') + '\n');
}

interface DreamEdgeRow {
  src: string;
  dst: string;
  type: string;
  weight: number;
  trust: string | null;
  recorded_at: number | null;
  declared_in: string | null;
}

function dreamEdges(dbPath: string): DreamEdgeRow[] {
  const { db } = openIndex(dbPath);
  try {
    return db
      .prepare(
        `SELECT src, dst, type, weight, trust, recorded_at, declared_in
         FROM edges WHERE origin = 'dream' ORDER BY src, dst`,
      )
      .all() as unknown as DreamEdgeRow[];
  } finally {
    db.close();
  }
}

/** The meaningful part of a relate result: whether a path was found and its node chains. */
function relateShape(r: RelateResult): { found: boolean; paths: string[][] } {
  return { found: r.found, paths: r.paths.map((p) => p.nodes) };
}

test('index rebuilds identical dream edges from the candidate file', () => {
  const v = makeVault('rebuild');
  writeCandidates(v, [candidate()]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'rebuild.sqlite');

  buildIndex(v, cfg, { dbPath });
  const first = dreamEdges(dbPath);
  buildIndex(v, cfg, { dbPath });
  const second = dreamEdges(dbPath);

  assert.deepEqual(second, first, 'a rebuild reproduces the same dream edges');
  assert.equal(first.length, 1);
  assert.equal(first[0].src, 'alpha');
  assert.equal(first[0].dst, 'beta');
  assert.equal(first[0].type, 'association');
  assert.equal(first[0].weight, 0.5, 'weight = salience');
  assert.equal(first[0].trust, 'low');
  assert.equal(first[0].declared_in, null);
  assert.equal(first[0].recorded_at, parseInstant('2026-09-29'), 'recorded_at = the night');
});

test('incremental index rebuilds the same dream edges', () => {
  const v = makeVault('incremental');
  writeCandidates(v, [candidate()]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'incremental.sqlite');

  buildIndex(v, cfg, { dbPath });
  const first = dreamEdges(dbPath);
  incrementalIndex(v, cfg, { dbPath });
  const second = dreamEdges(dbPath);

  assert.deepEqual(second, first);
  assert.equal(second.length, 1);
});

test('expiry removes the edge', () => {
  const v = makeVault('expired');
  // An open candidate whose `expires` date has passed is expired on read.
  writeCandidates(v, [candidate({ expires: '2000-01-01' })]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'expired.sqlite');
  buildIndex(v, cfg, { dbPath });
  assert.deepEqual(dreamEdges(dbPath), []);
});

test('rejected, dismissed, accepted and expired candidates produce no edge', () => {
  const v = makeVault('states');
  writeCandidates(v, [
    candidate({ id: 'd-1', state: 'rejected' }),
    candidate({ id: 'd-2', state: 'dismissed' }),
    candidate({ id: 'd-3', state: 'accepted' }),
    candidate({ id: 'd-4', state: 'expired' }),
  ]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'states.sqlite');
  buildIndex(v, cfg, { dbPath });
  assert.deepEqual(dreamEdges(dbPath), []);
});

test('endorsed candidates produce an edge', () => {
  const v = makeVault('endorsed');
  writeCandidates(v, [candidate({ state: 'endorsed' })]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'endorsed.sqlite');
  buildIndex(v, cfg, { dbPath });
  assert.equal(dreamEdges(dbPath).length, 1);
});

test('at weight 0 a dream edge is in the index but in no PageRank graph', () => {
  const v = makeVault('weight0');
  writeCandidates(v, [candidate()]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'weight0.sqlite');
  buildIndex(v, cfg, { dbPath });

  assert.equal(dreamEdges(dbPath).length, 1, 'the edge is in the index');
  const { db } = openIndex(dbPath);
  try {
    const g = loadGraph(db, 'typed', null, cfg);
    // Both notes are in the graph via their `contains` edges, but weight 0 means the
    // dream edge adds no alpha-beta adjacency.
    const ai = g.index.get('alpha');
    const bi = g.index.get('beta');
    assert.ok(ai !== undefined && bi !== undefined, 'both notes are in the graph via contains edges');
    const alphaNbrs = (g.nbr[ai] ?? []).map((j) => g.ids[j]);
    assert.ok(!alphaNbrs.includes('beta'), 'weight 0 drops the dream edge from the graph');
  } finally {
    db.close();
  }
});

test('relate never returns a path through a dream edge', () => {
  const v = makeVault('relate');
  writeCandidates(v, [candidate()]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'relate.sqlite');
  buildIndex(v, cfg, { dbPath });

  const { db } = openIndex(dbPath);
  try {
    assert.equal(relate(db, 'alpha', 'beta', cfg).found, false, 'a dream-only pair is not connected');
    assert.equal(relate(db, 'gamma', 'delta', cfg).found, true, 'a wikilink pair is still connected');
  } finally {
    db.close();
  }
});

test('relate output is unchanged by the candidate file', () => {
  const withC = makeVault('relate-with');
  writeCandidates(withC, [candidate()]);
  const withoutC = makeVault('relate-without');
  const cfgW = loadConfig(withC);
  const cfgWo = loadConfig(withoutC);
  const dbW = join(tmp, 'relate-with.sqlite');
  const dbWo = join(tmp, 'relate-without.sqlite');
  buildIndex(withC, cfgW, { dbPath: dbW });
  buildIndex(withoutC, cfgWo, { dbPath: dbWo });

  const { db: a } = openIndex(dbW);
  const { db: b } = openIndex(dbWo);
  try {
    for (const [x, y] of [
      ['alpha', 'beta'],
      ['gamma', 'delta'],
      ['alpha', 'gamma'],
    ]) {
      assert.deepEqual(relateShape(relate(a, x, y, cfgW)), relateShape(relate(b, x, y, cfgWo)), `relate ${x} ${y}`);
    }
  } finally {
    a.close();
    b.close();
  }
});

test('a dream edge is traversed at trustFloor low and dropped at medium', () => {
  const v = makeVault('trust');
  writeCandidates(v, [candidate()]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'trust.sqlite');
  buildIndex(v, cfg, { dbPath });

  const { db } = openIndex(dbPath);
  try {
    // Turn the weight on so the edge is in the graph; the trust floor is what is under test.
    const withFloor = (floor: 'low' | 'medium') => ({
      ...cfg,
      graph: { ...cfg.graph, originWeights: { ...cfg.graph.originWeights, dream: 1 } },
      retrieval: { ...cfg.retrieval, trustFloor: floor },
    });
    const adjacent = (floor: 'low' | 'medium'): boolean => {
      const g = loadGraph(db, 'typed', null, withFloor(floor));
      const ai = g.index.get('alpha');
      const bi = g.index.get('beta');
      assert.ok(ai !== undefined && bi !== undefined, 'both notes are in the graph');
      return (g.nbr[ai] ?? []).map((j) => g.ids[j]).includes('beta');
    };
    assert.equal(adjacent('low'), true, 'a low-trust dream edge is traversed at the low floor');
    assert.equal(adjacent('medium'), false, 'the same edge is dropped at the medium floor');
  } finally {
    db.close();
  }
});

test('scope drops a dream edge whose endpoint is outside the scope', async () => {
  const v = makeVault('scope');
  writeCandidates(v, [candidate()]);
  const cfg = loadConfig(v);
  const withDream = {
    ...cfg,
    graph: { ...cfg.graph, originWeights: { ...cfg.graph.originWeights, dream: 1 } },
  };
  const dbPath = join(tmp, 'scope.sqlite');
  buildIndex(v, withDream, { dbPath });

  const unscoped = await recall(v, withDream, 'Alpha', { dbPath, logAccess: false, mode: 'typed', topK: 10 });
  assert.ok(unscoped.hits.some((h) => h.noteId === 'beta'), 'the dream edge reaches beta unscoped');

  const scoped = await recall(v, withDream, 'Alpha', {
    dbPath,
    logAccess: false,
    mode: 'typed',
    topK: 10,
    scope: 'entities/concepts/alpha.md',
  });
  assert.ok(!scoped.hits.some((h) => h.noteId === 'beta'), 'the out-of-scope endpoint is dropped');
});

test('as-of sees a dream edge only after its night', () => {
  const v = makeVault('asof');
  writeCandidates(v, [candidate()]);
  const cfg = loadConfig(v);
  const dbPath = join(tmp, 'asof.sqlite');
  buildIndex(v, cfg, { dbPath });

  const { db } = openIndex(dbPath);
  try {
    const withDream = {
      ...cfg,
      graph: { ...cfg.graph, originWeights: { ...cfg.graph.originWeights, dream: 1 } },
    };
    const adjacent = (asOf: number | null): boolean => {
      const g = loadGraph(db, 'typed', asOf, withDream);
      const ai = g.index.get('alpha');
      const bi = g.index.get('beta');
      assert.ok(ai !== undefined && bi !== undefined, 'both notes are in the graph');
      return (g.nbr[ai] ?? []).map((j) => g.ids[j]).includes('beta');
    };
    const night = parseInstant('2026-09-29');
    assert.ok(night !== null, 'the night parses');
    assert.equal(adjacent(night - 1), false, 'before the night the dream edge is invisible');
    assert.equal(adjacent(night), true, 'at the night it becomes visible');
  } finally {
    db.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
