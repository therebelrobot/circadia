// Eval fixture generator (Phase 7, Step 2). Generates into temp dirs only;
// never touches examples/vault/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generateFixture } from '../eval/generate-fixture.ts';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import type { EvalQuery } from '../src/eval/types.ts';

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

test('fixture generation is byte-identical across two runs', () => {
  const a = join(tmp, 'a');
  const b = join(tmp, 'b');
  generateFixture(a);
  generateFixture(b);
  const ha = treeHash(a);
  const hb = treeHash(b);
  assert.deepEqual([...ha.keys()].sort(), [...hb.keys()].sort(), 'same file set');
  for (const [rel, hash] of ha) assert.equal(hb.get(rel), hash, `content differs: ${rel}`);
  assert.equal(ha.size, 300 + 1 + 1 + 1, '300 notes + config + access log + triples');
});

test('fixture contains at least one note of each required shape', () => {
  const dir = join(tmp, 'shapes');
  generateFixture(dir);
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8');

  // three scoped projects
  for (const p of ['alpha', 'beta', 'gamma']) {
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
  assert.match(read('entities/concepts/alpha-topic.md'), /\[\[shared-hub\]\]/);
  assert.match(read('entities/concepts/beta-topic.md'), /\[\[shared-hub\]\]/);
  // remote-association 3-hop chain
  assert.match(read('entities/concepts/gamma-topic.md'), /\[\[hop-one\]\]/);
  assert.match(read('entities/concepts/hop-one.md'), /\[\[hop-two\]\]/);
  assert.match(read('entities/concepts/hop-two.md'), /\[\[delta-topic\]\]/);
  // prefers:: facts with by:: user, including one superseded
  const sam = read('entities/people/sam.md');
  assert.match(sam, /\[prefers:: \[\[tea\]\]\] \[by:: user\]/);
  assert.match(sam, /~~\[prefers:: \[\[coffee\]\]\]~~ \[superseded:: 2026-05-01\] \[by:: user\]/);
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
      for (const p of q.expected_passages) {
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

test('remote-association pairs are the required graph distance apart', () => {
  const dir = join(tmp, 'graph');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'graph.sqlite');
  buildIndex(dir, cfg, { dbPath });
  const { db } = openIndex(dbPath);
  try {
    // note-level graph over ALL edge origins: map each node to its owning note,
    // drop self-loops (contains edges collapse to note -> note).
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
    assert.equal(hops('alpha-topic', 'beta-topic'), 2, '2-hop pair shares exactly one neighbour');
    assert.ok(hops('gamma-topic', 'delta-topic') >= 3, '3-hop pair is at least 3 hops apart');
  } finally {
    db.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
