// Eval fixture generator (Phase 7, Step 2). Generates into temp dirs only;
// never touches examples/vault/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generateFixture, DEEP_TRIPLES } from '../eval/generate-fixture.ts';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import type { EvalQuery, ExpectedGroup } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-fixture-'));

/** Recursively hash every file's relative path + content. */
function treeHash(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) visit(abs);
      else if (ent.isFile()) {
        const rel = abs.slice(root.length + 1);
        out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
      }
    }
  };
  visit(root);
  return out;
}

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

function flatExpected(groups: ExpectedGroup[]): string[] {
  return groups.flatMap((g) => (typeof g === 'string' ? [g] : g));
}

test('fixture generation is byte-identical across two runs', () => {
  const a = join(tmp, 'a');
  const b = join(tmp, 'b');
  generateFixture(a);
  generateFixture(b);
  const ha = treeHash(a);
  const hb = treeHash(b);
  assert.deepEqual([...ha.keys()].sort(), [...hb.keys()].sort(), 'same file set');
  for (const [rel, hash] of ha) assert.equal(hb.get(rel), hash, `content differs: ${rel}`);
  assert.equal(ha.size, 299 + 1 + 1 + 8, '299 notes + config + access log + 8 triple files');
});

test('fixture contains at least one note of each required shape', () => {
  const dir = join(tmp, 'shapes');
  generateFixture(dir);
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8');

  // four scoped projects
  for (const p of ['alpha', 'beta', 'gamma', 'delta']) {
    assert.ok(statSync(join(dir, 'projects', p)).isDirectory(), `project ${p} exists`);
  }
  // backdated + late-recorded facts: world time and system time diverge
  const alpha = read('projects/alpha/alpha-overview.md');
  assert.match(alpha, /valid:: 2026-01\.\.2026-06/);
  assert.match(alpha, /valid:: 2026-06\.\./);
  const beta = read('projects/beta/beta-overview.md');
  assert.match(beta, /valid:: 2026-02\.\./);
  assert.match(beta, /at:: 2026-09-01/, 'late-recorded fact');
  // web clipping episode, by: web -> trust low
  const clip = read('episodes/2026/09/2026-09-10-web-clipping.md');
  assert.match(clip, /type: episode/);
  assert.match(clip, /by: web/);
  // remote-association 2-hop: two notes share a neighbour, no direct edge
  assert.match(read('entities/concepts/electrode-drift.md'), /\[\[loam-porosity\]\]/);
  assert.match(read('entities/concepts/aquifer-salinity.md'), /\[\[loam-porosity\]\]/);
  // remote-association 3-hop chain
  assert.match(read('entities/concepts/weathervane-anemometer.md'), /\[\[sprocket-ratchet\]\]/);
  assert.match(read('entities/concepts/sprocket-ratchet.md'), /\[\[windlass-anchor\]\]/);
  assert.match(read('entities/concepts/windlass-anchor.md'), /\[\[lighthouse-foghorn\]\]/);
  // prefers:: facts with by:: user, including one superseded
  const sam = read('entities/people/sam.md');
  assert.match(sam, /\[prefers:: \[\[tea\]\]\] \[by:: user\]/);
  assert.match(sam, /~~\[prefers:: \[\[coffee\]\]\]~~ \[superseded:: 2026-05-01\] \[by:: user\]/);
  // 8 deep notes, each with a committed triple cache
  assert.equal(Object.keys(DEEP_TRIPLES).length, 8);
  for (const id of Object.keys(DEEP_TRIPLES)) {
    assert.match(read(`entities/concepts/${id}.md`), /tags: \[deep\]/);
    assert.ok(statSync(join(dir, '.circadia', 'triples', `${id}.jsonl`)).isFile(), `${id} triple cache`);
  }
});

test('every expected_passages id exists in the built index', () => {
  const dir = join(tmp, 'index');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'index.sqlite');
  buildIndex(dir, cfg, { dbPath });
  const { db } = openIndex(dbPath);
  try {
    const ids = new Set(
      (db.prepare(`SELECT id FROM nodes WHERE kind = 'passage'`).all() as { id: string }[]).map((r) => r.id),
    );
    for (const q of readQueries()) {
      for (const p of flatExpected(q.expected_passages)) {
        assert.ok(ids.has(p), `query ${q.id}: expected passage ${p} is not in the index`);
      }
      for (const p of q.expect_absent ?? []) {
        assert.ok(ids.has(p), `query ${q.id}: expect_absent passage ${p} is not in the index`);
      }
    }
  } finally {
    db.close();
  }
});

test('remote-association queries share no content token with their target', () => {
  const dir = join(tmp, 'tokens');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'tokens.sqlite');
  buildIndex(dir, cfg, { dbPath });
  const { db } = openIndex(dbPath);
  try {
    const text = new Map(
      (db.prepare(`SELECT id, text FROM nodes WHERE kind = 'passage'`).all() as { id: string; text: string }[]).map(
        (r) => [r.id, r.text],
      ),
    );
    const stop = new Set([
      'what', 'does', 'the', 'and', 'for', 'with', 'from', 'into', 'over', 'this', 'that',
      'these', 'those', 'here', 'noted', 'concept', 'tracked', 'field', 'log', 'recorded',
    ]);
    const tokens = (s: string): Set<string> =>
      new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !stop.has(w)));
    for (const q of readQueries()) {
      if (!q.kind.startsWith('remote-association')) continue;
      const target = flatExpected(q.expected_passages)[0];
      const targetText = text.get(target);
      assert.ok(targetText, `query ${q.id}: target ${target} has text`);
      const shared = [...tokens(q.query)].filter((t) => tokens(targetText).has(t));
      assert.deepEqual(shared, [], `query ${q.id}: query and target share tokens ${shared.join(', ')}`);
    }
  } finally {
    db.close();
  }
});

test('deep multi-hop pairs are connected only through triple/synonym edges', () => {
  const dir = join(tmp, 'deep');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'deep.sqlite');
  buildIndex(dir, cfg, { dbPath });
  const { db } = openIndex(dbPath);
  try {
    const nodeToNote = new Map<string, string>();
    for (const r of db.prepare(`SELECT id, kind, note_id FROM nodes`).all() as { id: string; kind: string; note_id: string | null }[]) {
      nodeToNote.set(r.id, r.kind === 'passage' && r.note_id ? r.note_id : r.id);
    }
    const buildAdj = (excludeOrigins: string[]): Map<string, Set<string>> => {
      const adj = new Map<string, Set<string>>();
      const add = (a: string, b: string): void => {
        if (a === b) return;
        (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
        (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
      };
      const ph = excludeOrigins.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT src, dst FROM edges WHERE dst IS NOT NULL AND origin NOT IN (${ph})`)
        .all(...excludeOrigins) as { src: string; dst: string }[];
      for (const e of rows) {
        const a = nodeToNote.get(e.src);
        const b = nodeToNote.get(e.dst);
        if (a && b) add(a, b);
      }
      return adj;
    };
    const hops = (adj: Map<string, Set<string>>, from: string, to: string): number => {
      if (from === to) return 0;
      const seen = new Set([from]);
      let frontier = [from];
      let d = 0;
      while (frontier.length > 0) {
        d++;
        const next: string[] = [];
        for (const n of frontier) {
          for (const m of adj.get(n) ?? []) {
            if (m === to) return d;
            if (!seen.has(m)) {
              seen.add(m);
              next.push(m);
            }
          }
        }
        frontier = next;
      }
      return Infinity;
    };

    const all = buildAdj([]);
    const noTriples = buildAdj(['triple', 'synonym']);
    let checked = 0;
    for (const q of readQueries()) {
      if (q.kind !== 'multi-hop' || !q.seed || !(q.seed in DEEP_TRIPLES)) continue;
      const target = flatExpected(q.expected_passages)[0].split('#')[0];
      assert.ok(Number.isFinite(hops(all, q.seed, target)), `query ${q.id}: seed and target are connected`);
      assert.equal(hops(noTriples, q.seed, target), Infinity, `query ${q.id}: a non-triple path exists`);
      checked++;
    }
    assert.ok(checked >= 4, `expected at least 4 deep multi-hop queries, found ${checked}`);
  } finally {
    db.close();
  }
});

test('remote-association pairs are the required graph distance apart', () => {
  const dir = join(tmp, 'graph');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'graph.sqlite');
  buildIndex(dir, cfg, { dbPath });
  const { db } = openIndex(dbPath);
  try {
    const nodeToNote = new Map<string, string>();
    for (const r of db.prepare(`SELECT id, kind, note_id FROM nodes`).all() as { id: string; kind: string; note_id: string | null }[]) {
      nodeToNote.set(r.id, r.kind === 'passage' && r.note_id ? r.note_id : r.id);
    }
    const adj = new Map<string, Set<string>>();
    const add = (a: string, b: string): void => {
      if (a === b) return;
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
      (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
    };
    for (const e of db.prepare(`SELECT src, dst FROM edges WHERE dst IS NOT NULL`).all() as { src: string; dst: string }[]) {
      const a = nodeToNote.get(e.src);
      const b = nodeToNote.get(e.dst);
      if (a && b) add(a, b);
    }
    const hops = (from: string, to: string): number => {
      if (from === to) return 0;
      const seen = new Set([from]);
      let frontier = [from];
      let d = 0;
      while (frontier.length > 0) {
        d++;
        const next: string[] = [];
        for (const n of frontier) {
          for (const m of adj.get(n) ?? []) {
            if (m === to) return d;
            if (!seen.has(m)) {
              seen.add(m);
              next.push(m);
            }
          }
        }
        frontier = next;
      }
      return Infinity;
    };
    for (const q of readQueries()) {
      if (!q.seed) continue;
      const target = flatExpected(q.expected_passages)[0].split('#')[0];
      if (q.kind === 'remote-association-2hop') {
        assert.equal(hops(q.seed, target), 2, `query ${q.id}: 2-hop pair`);
      } else if (q.kind === 'remote-association-3hop') {
        assert.ok(hops(q.seed, target) >= 3, `query ${q.id}: 3-hop pair`);
      }
    }
  } finally {
    db.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
