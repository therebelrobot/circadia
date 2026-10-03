// SQLite index: schema, open, FTS5 probe. The index is DERIVED — deleting the file
// and running `circadia index` must always reproduce it (plus the access log).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const INDEX_SCHEMA_VERSION = 3;

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
  trust           TEXT,            -- high|medium|low: source-monitoring label used at recall
  embedding       BLOB,            -- Phase 2: Float32Array bytes (passages only)
  embedding_model TEXT             -- Phase 2: model that produced the embedding
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

-- (path, mtime, sha256, commit_hash) per note file; drives incremental indexing (Phase 2)
CREATE TABLE IF NOT EXISTS files (
  path   TEXT PRIMARY KEY,
  mtime  REAL NOT NULL,
  sha256 TEXT NOT NULL,
  commit_hash TEXT
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

/**
 * Open the index. `readOnly` opens a vault mounted read-only (RFC-0004 §8): SQLite in WAL
 * mode needs to create `-shm`/`-wal` beside the database, which fails on a read-only
 * filesystem ("unable to open database file"). `immutable=1` tells SQLite the file cannot
 * change, so it skips the WAL sidecar entirely. Verified against a `:ro` bind mount in
 * `scripts/container-smoke.sh` (RFC-0004 open question 6). A read-only open skips the WAL
 * pragma and schema creation; the index must already exist and be current.
 */
export function openIndex(file: string, opts: { fresh?: boolean; readOnly?: boolean } = {}): IndexDb {
  const readOnly = opts.readOnly === true && file !== ':memory:';
  if (file !== ':memory:' && !readOnly) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(readOnly ? sqliteImmutableUri(file) : file);
  if (!readOnly) db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  if (opts.fresh) {
    db.exec(`
      DROP TABLE IF EXISTS passages_fts;
      DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS names;
      DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS meta;`);
  }
  if (!readOnly) db.exec(SCHEMA_SQL);
  const fts = probeFts5(db);
  if (fts && !readOnly) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
      passage_id UNINDEXED, title, heading, text, tokenize = 'porter unicode61'
    );`);
  }
  return { db, fts };
}

/** A `file:` URI that opens `file` immutable, so SQLite never needs a WAL sidecar. */
function sqliteImmutableUri(file: string): string {
  // Percent-encode `?` and `#` so a vault path can't be read as URI syntax.
  const encoded = encodeURI(file).replace(/\?/g, '%3F').replace(/#/g, '%23');
  return `file:${encoded}?immutable=1`;
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
