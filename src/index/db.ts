// SQLite index: schema, open, FTS5 probe. The index is DERIVED — deleting the file
// and running `palimpsest index` must always reproduce it (plus the access log).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const INDEX_SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- kind: note | passage | placeholder (unresolved link target) | phrase (hipporag)
CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  note_type       TEXT,            -- entity|episode|schema|procedure (notes only)
  note_id         TEXT,            -- owning note (passages only)
  path            TEXT,
  title           TEXT,
  heading         TEXT,
  text            TEXT,            -- passage text (passages/phrases only)
  passage_kind    TEXT,            -- prose|facts
  importance      REAL,
  created         INTEGER,
  updated         INTEGER,
  extraction_mode TEXT,            -- wikilink|typed|hipporag (notes only)
  extraction_why  TEXT,
  tags            TEXT,            -- JSON array
  content_hash    TEXT,            -- passages: sha of text, for triple-cache staleness
  trust           TEXT             -- high|medium|low: source-monitoring label used at recall
);
CREATE INDEX IF NOT EXISTS nodes_note ON nodes(note_id);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);

-- lower-cased names (id, aliases, title) that resolve to a note; used for links and cue matching
CREATE TABLE IF NOT EXISTS names (
  name    TEXT NOT NULL,
  node_id TEXT NOT NULL,
  tier    INTEGER NOT NULL,        -- 0 id, 1 alias, 2 title
  PRIMARY KEY (name, node_id)
);

CREATE TABLE IF NOT EXISTS edges (
  id           INTEGER PRIMARY KEY,
  src          TEXT NOT NULL,
  dst          TEXT,               -- null when the object is a literal
  value        TEXT,               -- literal object
  origin       TEXT NOT NULL,      -- contains|link|fact|provenance|triple|synonym
  type         TEXT NOT NULL,      -- predicate, 'link', 'contains', 'src', 'mentions', ...
  weight       REAL NOT NULL DEFAULT 1,
  valid_from   INTEGER,            -- world time, inclusive
  valid_to     INTEGER,            -- world time, exclusive
  recorded_at  INTEGER,            -- system time
  expired_at   INTEGER,            -- system time; non-null = superseded
  source_kind  TEXT,               -- user|agent|tool|web|import
  trust        TEXT,               -- high|medium|low
  conf         REAL,
  provenance   TEXT,               -- episode node id (src::)
  fact_id      TEXT,
  declared_in  TEXT                -- note whose file declares this edge
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS edges_origin ON edges(origin);
CREATE INDEX IF NOT EXISTS edges_fact ON edges(fact_id);
`;

export interface IndexDb {
  db: DatabaseSync;
  fts: boolean;
}

/** FTS5 is missing from some official Node builds of node:sqlite; probe, don't assume. */
export function probeFts5(db: DatabaseSync): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x); DROP TABLE temp.__fts_probe;');
    return true;
  } catch {
    return false;
  }
}

export function openIndex(file: string, opts: { fresh?: boolean } = {}): IndexDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  if (opts.fresh) {
    db.exec(`
      DROP TABLE IF EXISTS passages_fts;
      DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS names;
      DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS meta;`);
  }
  db.exec(SCHEMA_SQL);
  const fts = probeFts5(db);
  if (fts) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
      passage_id UNINDEXED, title, heading, text, tokenize = 'porter unicode61'
    );`);
  }
  return { db, fts };
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string | number): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}
