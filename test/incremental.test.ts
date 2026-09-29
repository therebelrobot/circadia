// Incremental indexing (Phase 2, item 1). Uses temp vaults and temp index paths;
// never touches examples/vault/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex, incrementalIndex } from '../src/index/indexer.ts';
import { openIndex, getMeta, INDEX_SCHEMA_VERSION } from '../src/index/db.ts';
import { main } from '../src/cli/main.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-incremental-'));

const CONFIG = {
  graph: { defaultExtraction: 'typed' },
  predicates: {
    strict: false,
    defs: {
      runs_on: { object: 'entity' },
      related_to: { object: 'entity' },
    },
  },
};

/** Build a small 3-note vault under dir and return its root. */
function makeVault(dir: string): string {
  const v = join(dir, 'vault');
  mkdirSync(join(v, 'entities', 'people'), { recursive: true });
  mkdirSync(join(v, 'entities', 'projects'), { recursive: true });
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify(CONFIG));
  writeFileSync(join(v, 'entities', 'people', 'ann.md'), '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn works on [[proj]].\n');
  writeFileSync(join(v, 'entities', 'people', 'bo.md'), '---\ntype: entity\nkind: person\naliases: [Bo]\n---\n# Bo\n\nBo is a friend.\n');
  writeFileSync(join(v, 'entities', 'projects', 'proj.md'), '---\ntype: entity\nkind: project\n---\n# Proj\n\nA project.\n\n## Facts\n- [runs_on:: [[ann]]] [by:: user]\n');
  return v;
}

const dbFor = (v: string) => join(v, '.circadia', 'index.sqlite');

test('incremental: full rebuild then one changed note re-parses only that note', () => {
  const v = makeVault(join(tmp, 't1'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  const full = buildIndex(v, cfg, { dbPath });
  assert.equal(full.stats.notes, 3);

  // modify ann.md's prose
  const ann = join(v, 'entities', 'people', 'ann.md');
  writeFileSync(ann, '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn now leads [[proj]] and [[bo]].\n');

  const inc = incrementalIndex(v, cfg, { dbPath });
  assert.equal(inc.stats.changed, 1, 'exactly one file changed');
  assert.equal(inc.stats.removed, 0);
  assert.equal(inc.stats.notes, 3, 'total notes unchanged');

  // ann's passage text was updated in the index
  const { db } = openIndex(dbPath);
  const passage = db.prepare(`SELECT text FROM nodes WHERE id = 'ann#0'`).get() as { text: string };
  assert.match(passage.text, /Ann now leads/);
  // ann now links to bo as well as proj (link edges are declared from the passage)
  const annEdges = db.prepare(`SELECT dst FROM edges WHERE src LIKE 'ann#%' AND origin = 'link'`).all() as { dst: string }[];
  const dsts = annEdges.map((e) => e.dst).sort();
  assert.deepEqual(dsts, ['bo', 'proj']);
  db.close();
});

test('incremental: deleted file drops its rows', () => {
  const v = makeVault(join(tmp, 't2'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  rmSync(join(v, 'entities', 'people', 'bo.md'));
  const inc = incrementalIndex(v, cfg, { dbPath });
  assert.equal(inc.stats.removed, 1);
  assert.equal(inc.stats.notes, 2);

  const { db } = openIndex(dbPath);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM nodes WHERE id = 'bo' OR note_id = 'bo'`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM names WHERE node_id = 'bo'`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM edges WHERE declared_in = 'bo'`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM files WHERE path = 'entities/people/bo.md'`).get() as { n: number }).n, 0);
  db.close();
});

test('incremental: FTS rows stay in sync with passage nodes on change and removal', () => {
  const v = makeVault(join(tmp, 't9'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  const full = buildIndex(v, cfg, { dbPath });
  if (!full.stats.fts) return; // FTS5 unavailable in this node:sqlite build; nothing to assert

  const { db } = openIndex(dbPath);
  const ftsCount = () => (db.prepare(`SELECT count(*) AS n FROM passages_fts`).get() as { n: number }).n;
  const passageCount = () => (db.prepare(`SELECT count(*) AS n FROM nodes WHERE kind = 'passage'`).get() as { n: number }).n;
  assert.equal(ftsCount(), passageCount(), 'baseline: one FTS row per passage node');

  // modify one note: its old FTS rows must be deleted before its nodes rows
  const ann = join(v, 'entities', 'people', 'ann.md');
  writeFileSync(ann, '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn edited for FTS.\n');
  incrementalIndex(v, cfg, { dbPath });
  assert.equal(ftsCount(), passageCount(), 'after change: FTS rows still match passage nodes');

  // remove a note: its passages must leave no FTS rows behind
  rmSync(join(v, 'entities', 'people', 'bo.md'));
  incrementalIndex(v, cfg, { dbPath });
  assert.equal(ftsCount(), passageCount(), 'after removal: FTS rows still match passage nodes');
  assert.equal(
    (db.prepare(`SELECT count(*) AS n FROM passages_fts WHERE passage_id LIKE 'bo#%'`).get() as { n: number }).n,
    0,
    'removed note leaves no FTS rows',
  );
  db.close();
});

test('incremental: config change triggers a full rebuild', () => {
  const v = makeVault(join(tmp, 't10'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  // change a config value that affects extraction of every note
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify({ ...CONFIG, graph: { defaultExtraction: 'wikilink' } }));
  const cfg2 = loadConfig(v);

  const inc = incrementalIndex(v, cfg2, { dbPath });
  assert.equal(inc.stats.notes, 3);

  const { db } = openIndex(dbPath);
  const modes = (db.prepare(`SELECT DISTINCT extraction_mode FROM nodes WHERE kind = 'note'`).all() as { extraction_mode: string }[])
    .map((m) => m.extraction_mode)
    .sort();
  assert.deepEqual(modes, ['wikilink'], 'all notes re-extracted at the new default mode');
  // fact edges are only emitted at >= typed, so a full rebuild at wikilink drops them
  assert.equal((db.prepare(`SELECT count(*) AS n FROM edges WHERE origin = 'fact'`).get() as { n: number }).n, 0, 'fact edges dropped at wikilink mode');
  db.close();
});

test('incremental: ambiguous-name tie-break matches the full rebuild', () => {
  const v = join(tmp, 't11');
  mkdirSync(join(v, 'entities', 'people'), { recursive: true });
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify(CONFIG));
  // two notes share the title "Dup". BINARY collation orders "Zed.md" before
  // "amy.md" (uppercase sorts first); localeCompare orders "amy.md" first.
  writeFileSync(join(v, 'entities', 'people', 'Zed.md'), '---\ntype: entity\nkind: person\n---\n# Dup\n\nZed.\n');
  writeFileSync(join(v, 'entities', 'people', 'amy.md'), '---\ntype: entity\nkind: person\n---\n# Dup\n\nAmy.\n');
  writeFileSync(join(v, 'entities', 'people', 'linker.md'), '---\ntype: entity\nkind: person\n---\n# Linker\n\nLinker knows [[Dup]].\n');
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  const dstOf = (): string => {
    const { db } = openIndex(dbPath);
    const e = db.prepare(`SELECT dst FROM edges WHERE src LIKE 'linker#%' AND origin = 'link'`).get() as { dst: string };
    db.close();
    return e.dst;
  };
  assert.equal(dstOf(), 'amy', 'full build resolves the ambiguous title to the localeCompare-first note');

  // force a re-resolve through the incremental path
  writeFileSync(join(v, 'entities', 'people', 'linker.md'), '---\ntype: entity\nkind: person\n---\n# Linker\n\nLinker still knows [[Dup]].\n');
  incrementalIndex(v, cfg, { dbPath });
  assert.equal(dstOf(), 'amy', 'incremental re-resolve picks the same note as a full rebuild');
});

test('incremental: no-op run reports zero changed and does not re-parse', () => {
  const v = makeVault(join(tmp, 't3'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  const inc1 = incrementalIndex(v, cfg, { dbPath });
  assert.equal(inc1.stats.changed, 0);
  assert.equal(inc1.stats.removed, 0);
  assert.equal(inc1.notes.length, 0, 'no notes re-parsed');

  const inc2 = incrementalIndex(v, cfg, { dbPath });
  assert.equal(inc2.stats.changed, 0);
  assert.equal(inc2.stats.removed, 0);
});

test('incremental: alias change propagates to an unchanged note\'s link', () => {
  const v = join(tmp, 't4');
  mkdirSync(join(v, 'entities', 'people'), { recursive: true });
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify(CONFIG));
  // A links to [[x]]; B has alias x
  writeFileSync(join(v, 'entities', 'people', 'a.md'), '---\ntype: entity\nkind: person\n---\n# A\n\nA knows [[x]].\n');
  writeFileSync(join(v, 'entities', 'people', 'b.md'), '---\ntype: entity\nkind: person\naliases: [x]\n---\n# B\n\nB.\n');
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  // initially [[x]] resolves to b
  {
    const { db } = openIndex(dbPath);
    const e = db.prepare(`SELECT dst FROM edges WHERE src LIKE 'a#%' AND origin = 'link'`).get() as { dst: string };
    assert.equal(e.dst, 'b');
    db.close();
  }

  // change B's alias to y, add C with alias x
  writeFileSync(join(v, 'entities', 'people', 'b.md'), '---\ntype: entity\nkind: person\naliases: [y]\n---\n# B\n\nB.\n');
  writeFileSync(join(v, 'entities', 'people', 'c.md'), '---\ntype: entity\nkind: person\naliases: [x]\n---\n# C\n\nC.\n');

  const inc = incrementalIndex(v, cfg, { dbPath });
  assert.equal(inc.stats.changed, 2, 'b modified + c new');

  // A (unchanged) must now point at C
  const { db } = openIndex(dbPath);
  const e = db.prepare(`SELECT dst FROM edges WHERE src LIKE 'a#%' AND origin = 'link'`).get() as { dst: string };
  assert.equal(e.dst, 'c', 'A\'s link re-resolved to the new note holding alias x');
  db.close();
});

test('incremental: mtime-only change (same content) does not re-parse', () => {
  const v = makeVault(join(tmp, 't5'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  // rewrite ann.md with identical content -> mtime changes, sha256 does not
  const ann = join(v, 'entities', 'people', 'ann.md');
  const content = readFileSync(ann, 'utf8');
  writeFileSync(ann, content);
  // nudge mtime forward explicitly so the mtime comparison triggers
  const t = Date.now() / 1000 + 5;
  utimesSync(ann, t, t);

  const inc = incrementalIndex(v, cfg, { dbPath });
  assert.equal(inc.stats.changed, 0, 'content unchanged -> no re-parse');
  assert.equal(inc.notes.length, 0);
});

test('incremental: v1 index falls back to a full rebuild and lands on v2', () => {
  const v = makeVault(join(tmp, 't6'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  // simulate an old (v1) index by downgrading the recorded schema version
  {
    const { db } = openIndex(dbPath);
    db.prepare(`INSERT INTO meta(key, value) VALUES('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
    db.close();
  }
  assert.equal(getMeta(openIndex(dbPath).db, 'schema_version'), '1');
  openIndex(dbPath).db.close();

  const inc = incrementalIndex(v, cfg, { dbPath });
  assert.equal(inc.stats.notes, 3);
  const { db } = openIndex(dbPath);
  assert.equal(getMeta(db, 'schema_version'), String(INDEX_SCHEMA_VERSION), 'rebuilt at the current schema version');
  // the files table is populated by the rebuild
  assert.equal((db.prepare(`SELECT count(*) AS n FROM files`).get() as { n: number }).n, 3);
  db.close();
});

test('cli: index is incremental by default; --full forces a full rebuild', async () => {
  const v = makeVault(join(tmp, 't8'));
  const log = console.log;
  console.log = () => { };
  try {
    // first index (no index yet) -> incremental falls back to full
    assert.equal(await main(['index', '--vault', v]), 0);
    const dbPath = dbFor(v);
    assert.equal(getMeta(openIndex(dbPath).db, 'schema_version'), String(INDEX_SCHEMA_VERSION));
    openIndex(dbPath).db.close();

    // modify a note, then a default (incremental) index picks it up
    const ann = join(v, 'entities', 'people', 'ann.md');
    writeFileSync(ann, '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn edited.\n');
    assert.equal(await main(['index', '--vault', v]), 0);
    {
      const { db } = openIndex(dbPath);
      const p = db.prepare(`SELECT text FROM nodes WHERE id = 'ann#0'`).get() as { text: string };
      assert.match(p.text, /Ann edited/);
      db.close();
    }

    // --full does a full rebuild and still yields the same totals
    assert.equal(await main(['index', '--full', '--vault', v]), 0);
    {
      const { db } = openIndex(dbPath);
      assert.equal((db.prepare(`SELECT count(*) AS n FROM nodes WHERE kind = 'note'`).get() as { n: number }).n, 3);
      db.close();
    }
  } finally {
    console.log = log;
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
