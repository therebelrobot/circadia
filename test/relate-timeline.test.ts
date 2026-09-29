// relate + timeline (Phase 2, item 6) over the example vault, with a temp
// index path so examples/vault/ is never modified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { relate } from '../src/retrieval/relate.ts';
import { timeline } from '../src/retrieval/timeline.ts';

const VAULT = resolve(import.meta.dirname, '..', 'examples', 'vault');
const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-relate-'));
const dbPath = join(tmp, 'index.sqlite');
const cfg = loadConfig(VAULT);
buildIndex(VAULT, cfg, { dbPath });

const dbFor = () => openIndex(dbPath).db;

test('relate: orchard-sensors → pi-cluster finds the runs_on fact edge with provenance', () => {
  const db = dbFor();
  try {
    const r = relate(db, 'orchard-sensors', 'pi-cluster', cfg);
    assert.equal(r.found, true);
    assert.ok(r.paths.length >= 1);
    // a depth-1 path through the runs_on fact edge exists
    const factPath = r.paths.find((p) => p.edges.some((e) => e.type === 'runs_on' && e.origin === 'fact'));
    assert.ok(factPath, 'a path uses the runs_on fact edge');
    assert.deepEqual(factPath!.nodes, ['orchard-sensors', 'pi-cluster']);
    const edge = factPath!.edges.find((e) => e.type === 'runs_on')!;
    assert.equal(edge.provenance, '2026-08-11-migration', 'edge chain carries provenance');
    assert.equal(edge.fact_id, 'f-orch-host');
  } finally {
    db.close();
  }
});

test('relate: unconnected notes return found: false', () => {
  const v = join(tmp, 'isolated');
  mkdirSync(join(v, 'entities', 'people'), { recursive: true });
  writeFileSync(join(v, 'palimpsest.config.json'), JSON.stringify({ graph: { defaultExtraction: 'typed' } }));
  writeFileSync(join(v, 'entities', 'people', 'one.md'), '---\ntype: entity\nkind: person\n---\n# One\n\nOne is alone.\n');
  writeFileSync(join(v, 'entities', 'people', 'two.md'), '---\ntype: entity\nkind: person\n---\n# Two\n\nTwo is alone too.\n');
  const dbPath2 = join(tmp, 'isolated.sqlite');
  buildIndex(v, loadConfig(v), { dbPath: dbPath2 });
  const db = openIndex(dbPath2).db;
  try {
    const r = relate(db, 'one', 'two', loadConfig(v));
    assert.equal(r.found, false);
    assert.deepEqual(r.paths, []);
  } finally {
    db.close();
  }
});

test('relate: an unresolvable name errors clearly', () => {
  const db = dbFor();
  try {
    assert.throws(() => relate(db, 'no-such-note', 'pi-cluster', cfg), /does not resolve/);
  } finally {
    db.close();
  }
});

test('timeline: orchard-sensors facts ordered by valid_from, including the superseded runs_on', () => {
  const db = dbFor();
  try {
    const rows = timeline(db, 'orchard-sensors', cfg);
    assert.equal(rows.length, 8, 'six current facts + two history facts');
    // valid_from ASC with NULLs first
    const keys = rows.map((r) => r.valid_from ?? Number.NEGATIVE_INFINITY);
    assert.deepEqual(keys, [...keys].sort((a, b) => a - b), 'ordered by valid_from, NULLs first');
    const old = rows.find((r) => r.predicate === 'runs_on' && r.object === 'Old laptop');
    assert.ok(old, 'the superseded runs_on old-laptop fact is present');
    assert.equal(old!.status, 'superseded');
    assert.equal(old!.expired_at !== null, true);
    const cur = rows.find((r) => r.predicate === 'runs_on' && r.object === 'Pi cluster');
    assert.ok(cur, 'the current runs_on pi-cluster fact is present');
    assert.equal(cur!.status, 'current');
    assert.equal(cur!.provenance, 'Migrated collector to the cluster');
  } finally {
    db.close();
  }
});

test('timeline: an entity with no facts returns empty', () => {
  const db = dbFor();
  try {
    assert.deepEqual(timeline(db, 'capacitive-sensing', cfg), []);
  } finally {
    db.close();
  }
});

test('timeline: inverse facts appear through the predicate inverse', () => {
  const db = dbFor();
  try {
    // sam is the object of orchard-sensors' maintained_by fact
    const rows = timeline(db, 'sam', cfg);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].predicate, 'maintains', 'inverse of maintained_by');
    assert.equal(rows[0].inverse, true);
    assert.equal(rows[0].object, 'Orchard sensors');
  } finally {
    db.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
