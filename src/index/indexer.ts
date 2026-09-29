// Full rebuild and incremental update of the derived index from the vault.
// The index is DERIVED: deleting it and running a full rebuild must reproduce it
// (plus the access log and the triple cache). Incremental indexing (Phase 2)
// re-parses only changed notes and re-resolves edges whose targets may have moved.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { GraphMode, ParsedNote, Problem, SourceKind, Trust, WikiLink } from '../types.ts';
import { DEFAULT_TRUST } from '../vault/facts.ts';
import { parseNote } from '../vault/parse.ts';
import { walkVault } from '../vault/walk.ts';
import { normKey, slugify } from '../vault/util.ts';
import { extractionModeFor, MODE_RANK } from '../extract/scope.ts';
import { loadTriples, passageHash } from '../extract/triples.ts';
import { createEmbeddingsClient, NullEmbeddingsClient, type EmbeddingsClient } from '../retrieval/embeddings.ts';
import { INDEX_SCHEMA_VERSION, openIndex, setMeta, getMeta } from './db.ts';

export interface IndexStats {
  notes: number;
  passages: number;
  edges: Record<string, number>;
  placeholders: number;
  phrases: number;
  staleTriples: number;
  byExtraction: Record<GraphMode, number>;
  fts: boolean;
  ms: number;
  /** incremental only: files whose content changed (re-parsed) this run */
  changed?: number;
  /** incremental only: files removed from the vault this run */
  removed?: number;
}

export interface IndexResult {
  stats: IndexStats;
  problems: Problem[];
  notes: ParsedNote[];
}

/** Parse every note without touching the index (used by `lint`). */
export function parseVault(vaultRoot: string, config: Config): ParsedNote[] {
  return walkVault(vaultRoot, config.vault.ignore).map((f) =>
    parseNote(f.path, readFileSync(f.abs, 'utf8'), f.mtime, config),
  );
}

const TRUST_RANK: Record<Trust, number> = { low: 0, medium: 1, high: 2 };

/** Episodes inherit trust from who produced them; human-maintained notes are high. */
export function noteTrust(n: ParsedNote): Trust {
  if (n.type === 'episode') {
    const by = String(n.frontmatter.by ?? 'user') as SourceKind;
    return DEFAULT_TRUST[by] ?? 'low';
  }
  if (n.type === 'schema') return 'medium'; // machine-written summary
  return 'high';
}

/** A facts passage is only as trustworthy as its least-trusted current fact. */
export function passageTrust(n: ParsedNote, kind: 'prose' | 'facts'): Trust {
  const base = noteTrust(n);
  if (kind !== 'facts') return base;
  let t: Trust = base;
  for (const f of n.facts) if (f.status !== 'superseded' && TRUST_RANK[f.trust] < TRUST_RANK[t]) t = f.trust;
  return t;
}

export class NameResolver {
  private byName = new Map<string, { id: string; tier: number }[]>();

  add(name: string, id: string, tier: number): void {
    const k = normKey(name);
    if (!k) return;
    const list = this.byName.get(k) ?? [];
    if (!list.some((e) => e.id === id)) list.push({ id, tier });
    this.byName.set(k, list);
  }

  /** Best (lowest tier) match; ties are ambiguous and return the first registered. */
  resolve(target: string): { id: string; ambiguous: boolean } | null {
    const list = this.byName.get(normKey(target)) ?? this.byName.get(slugify(target));
    if (!list || list.length === 0) return null;
    const best = Math.min(...list.map((e) => e.tier));
    const top = list.filter((e) => e.tier === best);
    return { id: top[0].id, ambiguous: top.length > 1 };
  }

  entries(): [string, { id: string; tier: number }[]][] {
    return [...this.byName.entries()];
  }
}

export function buildResolver(notes: ParsedNote[]): { resolver: NameResolver; problems: Problem[] } {
  const resolver = new NameResolver();
  const problems: Problem[] = [];
  const seen = new Map<string, string>();
  for (const n of notes) {
    const prev = seen.get(n.id);
    if (prev) {
      problems.push({
        severity: 'error',
        path: n.path,
        code: 'note.duplicate-id',
        message: `id "${n.id}" also used by ${prev}`,
      });
    }
    seen.set(n.id, n.path);
    resolver.add(n.id, n.id, 0);
    for (const a of n.aliases) resolver.add(a, n.id, 1);
    resolver.add(n.title, n.id, 2);
  }
  return { resolver, problems };
}

/**
 * Rebuild a NameResolver from the `names` table. Registration order must match
 * buildIndex's (notes in walkVault path order, then id/alias/title tiers) so
 * ambiguous-name tie-breaking matches a full rebuild. The SQL ORDER BY is only
 * a stable base: SQLite's BINARY collation can disagree with walkVault's
 * localeCompare, so the rows are re-sorted in JS with the same comparator.
 */
export function resolverFromDb(db: DatabaseSync): NameResolver {
  const resolver = new NameResolver();
  const rows = db
    .prepare(
      `SELECT n.name, n.node_id, n.tier, x.path FROM names n
       JOIN nodes x ON x.id = n.node_id
       ORDER BY x.path, n.tier, n.name`,
    )
    .all() as { name: string; node_id: string; tier: number; path: string }[];
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.tier - b.tier || a.name.localeCompare(b.name));
  for (const r of rows) resolver.add(r.name, r.node_id, r.tier);
  return resolver;
}

// ---- shared emission context and helpers (used by both build and incremental) ----

interface IndexCtx {
  db: DatabaseSync;
  fts: boolean;
  config: Config;
  resolver: NameResolver;
  problems: Problem[];
  placeholders: Set<string>;
  phrases: Set<string>;
  /** passageId -> content hash, for triple-cache staleness */
  hashes: Map<string, string>;
  edgeCounts: Record<string, number>;
  byExtraction: Record<GraphMode, number>;
  hipporagNotes: Set<string>;
  passageCount: number;
  staleTriples: number;
  insNode: StatementSync;
  insName: StatementSync;
  insEdge: StatementSync;
  insFts: StatementSync | null;
}

function makeCtx(db: DatabaseSync, fts: boolean, config: Config, resolver: NameResolver, problems: Problem[]): IndexCtx {
  return {
    db,
    fts,
    config,
    resolver,
    problems,
    placeholders: new Set(),
    phrases: new Set(),
    hashes: new Map(),
    edgeCounts: {},
    byExtraction: { wikilink: 0, typed: 0, hipporag: 0 },
    hipporagNotes: new Set(),
    passageCount: 0,
    staleTriples: 0,
    insNode: db.prepare(`INSERT OR REPLACE INTO nodes
      (id, kind, note_type, note_id, path, title, heading, text, passage_kind, importance, created, updated,
       extraction_mode, extraction_why, tags, content_hash, trust)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insName: db.prepare('INSERT OR IGNORE INTO names(name, node_id, tier) VALUES (?, ?, ?)'),
    insEdge: db.prepare(`INSERT INTO edges
      (src, dst, value, origin, type, weight, valid_from, valid_to, recorded_at, expired_at,
       source_kind, trust, conf, provenance, fact_id, declared_in)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insFts: fts ? db.prepare('INSERT INTO passages_fts(passage_id, title, heading, text) VALUES (?, ?, ?, ?)') : null,
  };
}

function emitEdge(
  ctx: IndexCtx,
  src: string,
  dst: string | null,
  origin: string,
  type: string,
  extra: Partial<{
    value: string | null;
    weight: number;
    validFrom: number | null;
    validTo: number | null;
    recordedAt: number | null;
    expiredAt: number | null;
    sourceKind: string | null;
    trust: string | null;
    conf: number | null;
    provenance: string | null;
    factId: string | null;
    declaredIn: string | null;
  }> = {},
): void {
  ctx.insEdge.run(
    src,
    dst,
    extra.value ?? null,
    origin,
    type,
    extra.weight ?? 1,
    extra.validFrom ?? null,
    extra.validTo ?? null,
    extra.recordedAt ?? null,
    extra.expiredAt ?? null,
    extra.sourceKind ?? null,
    extra.trust ?? null,
    extra.conf ?? null,
    extra.provenance ?? null,
    extra.factId ?? null,
    extra.declaredIn ?? null,
  );
  ctx.edgeCounts[origin] = (ctx.edgeCounts[origin] ?? 0) + 1;
}

function resolveOrPlaceholder(ctx: IndexCtx, link: WikiLink, from: ParsedNote, line: number): string {
  const r = ctx.resolver.resolve(link.target);
  if (r) {
    if (r.ambiguous) {
      ctx.problems.push({
        severity: 'warning',
        path: from.path,
        line,
        code: 'link.ambiguous',
        message: `[[${link.target}]] matches several notes; resolved to ${r.id}`,
      });
    }
    return r.id;
  }
  const pid = `?${normKey(link.target)}`;
  if (!ctx.placeholders.has(pid)) {
    ctx.placeholders.add(pid);
    ctx.insNode.run(pid, 'placeholder', null, null, null, link.target, null, null, null, 0, null, null, null, null, '[]', null, 'low');
  }
  ctx.problems.push({
    severity: 'warning',
    path: from.path,
    line,
    code: 'link.unresolved',
    message: `[[${link.target}]] does not resolve to a note (kept as placeholder)`,
  });
  return pid;
}

/** Insert the note row, its names, its passages, and the contains edges. */
function insertNoteRows(ctx: IndexCtx, n: ParsedNote): void {
  const { mode, reason } = extractionModeFor(n, ctx.config);
  ctx.byExtraction[mode]++;
  if (mode === 'hipporag') ctx.hipporagNotes.add(n.id);
  ctx.insNode.run(
    n.id,
    'note',
    n.type,
    null,
    n.path,
    n.title,
    null,
    null,
    null,
    n.importance,
    n.created,
    n.updated,
    mode,
    reason,
    JSON.stringify(n.tags),
    null,
    noteTrust(n),
  );
  ctx.insName.run(normKey(n.id), n.id, 0);
  for (const a of n.aliases) ctx.insName.run(normKey(a), n.id, 1);
  ctx.insName.run(normKey(n.title), n.id, 2);

  for (const p of n.passages) {
    const h = passageHash(p.text);
    ctx.hashes.set(p.id, h);
    ctx.insNode.run(p.id, 'passage', null, n.id, n.path, n.title, p.heading, p.text, p.kind, n.importance, n.created, n.updated, null, null, '[]', h, passageTrust(n, p.kind));
    ctx.insFts?.run(p.id, n.title, p.heading ?? '', p.text);
    emitEdge(ctx, n.id, p.id, 'contains', 'contains', { declaredIn: n.id });
    ctx.passageCount++;
  }
}

/** Emit link, fact, and provenance edges for one note. */
function emitNoteEdges(ctx: IndexCtx, n: ParsedNote): void {
  const mode = extractionModeFor(n, ctx.config).mode;

  // link edges: from the passage the link appears in (or the note, for frontmatter links)
  const counts = new Map<string, { src: string; dst: string; count: number }>();
  for (const { link, line, passage } of n.links) {
    const dst = resolveOrPlaceholder(ctx, link, n, line);
    if (dst === n.id) continue;
    const src = passage ?? n.id;
    const key = `${src}\u0000${dst}`;
    const c = counts.get(key) ?? { src, dst, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  for (const c of counts.values()) {
    emitEdge(ctx, c.src, c.dst, 'link', 'link', { weight: 1 + Math.log(c.count), declaredIn: n.id });
  }

  // typed facts + provenance, only for notes extracted at >= typed
  if (MODE_RANK[mode] < MODE_RANK.typed) return;
  for (const f of n.facts) {
    const pred = ctx.config.predicates.defs[f.predicate];
    if (!pred) {
      ctx.problems.push({
        severity: ctx.config.predicates.strict ? 'error' : 'warning',
        path: n.path,
        line: f.line,
        code: 'fact.unknown-predicate',
        message: `predicate "${f.predicate}" is not in predicates.defs`,
      });
    } else if (pred.object === 'entity' && f.object.kind !== 'link') {
      ctx.problems.push({ severity: 'error', path: n.path, line: f.line, code: 'fact.object-kind', message: `"${f.predicate}" expects a [[wikilink]] object` });
    } else if (pred.object === 'literal' && f.object.kind !== 'literal') {
      ctx.problems.push({ severity: 'error', path: n.path, line: f.line, code: 'fact.object-kind', message: `"${f.predicate}" expects a literal object` });
    } else if (pred.values && f.object.kind === 'literal' && !pred.values.includes(f.object.value)) {
      ctx.problems.push({ severity: 'warning', path: n.path, line: f.line, code: 'fact.value', message: `"${f.object.value}" not in allowed values for ${f.predicate}` });
    }

    const provenance = f.src ? resolveOrPlaceholder(ctx, f.src, n, f.line) : null;
    const dst = f.object.kind === 'link' ? resolveOrPlaceholder(ctx, f.object.link, n, f.line) : null;
    emitEdge(ctx, n.id, dst, 'fact', f.predicate, {
      value: f.object.kind === 'literal' ? f.object.value : null,
      weight: f.conf,
      validFrom: f.valid.from,
      validTo: f.valid.to,
      recordedAt: f.recordedAt,
      expiredAt: f.supersededAt ?? (f.status === 'superseded' ? f.recordedAt : null),
      sourceKind: f.by,
      trust: f.trust,
      conf: f.conf,
      provenance,
      factId: f.id,
      declaredIn: n.id,
    });
    if (provenance) {
      emitEdge(ctx, n.id, provenance, 'provenance', 'src', {
        recordedAt: f.recordedAt,
        expiredAt: f.supersededAt,
        sourceKind: f.by,
        trust: f.trust,
        factId: f.id,
        declaredIn: n.id,
      });
    }
  }
}

/**
 * Emit hipporag triple edges for the given note ids. `phrases` must be pre-seeded
 * with existing phrase node ids (incremental) so we don't duplicate them.
 */
function emitTriples(ctx: IndexCtx, vaultRoot: string, noteIds: Set<string>): void {
  const { triples, badLines } = loadTriples(vaultRoot);
  if (badLines) {
    ctx.problems.push({ severity: 'warning', path: '.palimpsest/triples', code: 'triples.bad-lines', message: `${badLines} malformed triple lines skipped` });
  }
  const phraseNode = (text: string): string => {
    const id = `p:${slugify(text)}`;
    if (!ctx.phrases.has(id)) {
      ctx.phrases.add(id);
      ctx.insNode.run(id, 'phrase', null, null, null, text, null, text, null, 0, null, null, null, null, '[]', null, 'medium');
      // phrases that name a note are bridged to it, so triples connect into the note graph
      const r = ctx.resolver.resolve(text);
      if (r) emitEdge(ctx, id, r.id, 'synonym', 'names', { weight: 1 });
    }
    return id;
  };
  for (const t of triples) {
    const noteId = t.passageId.split('#')[0];
    if (!noteIds.has(noteId)) continue;
    if (!ctx.hipporagNotes.has(noteId)) continue;
    if (ctx.hashes.get(t.passageId) !== t.contentHash) {
      ctx.staleTriples++;
      continue;
    }
    const s = phraseNode(t.subject);
    const o = phraseNode(t.object);
    emitEdge(ctx, t.passageId, s, 'triple', 'mentions', { declaredIn: noteId });
    emitEdge(ctx, t.passageId, o, 'triple', 'mentions', { declaredIn: noteId });
    emitEdge(ctx, s, o, 'triple', t.predicate, { conf: t.conf ?? null, weight: t.conf ?? 1, sourceKind: 'agent', trust: 'medium', declaredIn: noteId });
  }
  if (ctx.staleTriples) {
    ctx.problems.push({ severity: 'warning', path: '.palimpsest/triples', code: 'triples.stale', message: `${ctx.staleTriples} cached triples skipped: passage text changed since extraction` });
  }
}

/** Delete every row owned by the given note ids (note, passages, names, edges, fts). */
function deleteNoteRows(ctx: IndexCtx, noteIds: string[]): void {
  if (noteIds.length === 0) return;
  const ph = noteIds.map(() => '?').join(',');
  // FTS rows must go first: the subquery reads `nodes`, and deleting the
  // passage rows first would make it match nothing (stale FTS rows).
  if (ctx.fts) ctx.db.prepare(`DELETE FROM passages_fts WHERE passage_id IN (SELECT id FROM nodes WHERE note_id IN (${ph}))`).run(...noteIds);
  ctx.db.prepare(`DELETE FROM nodes WHERE id IN (${ph}) OR note_id IN (${ph})`).run(...noteIds, ...noteIds);
  ctx.db.prepare(`DELETE FROM names WHERE node_id IN (${ph})`).run(...noteIds);
  ctx.db.prepare(`DELETE FROM edges WHERE declared_in IN (${ph})`).run(...noteIds);
}

export function buildIndex(vaultRoot: string, config: Config, opts: { dbPath?: string } = {}): IndexResult {
  const t0 = performance.now();
  const notes = parseVault(vaultRoot, config);
  const problems: Problem[] = notes.flatMap((n) => n.problems);
  const { resolver, problems: resolveProblems } = buildResolver(notes);
  problems.push(...resolveProblems);

  const { db, fts } = openIndex(opts.dbPath ?? join(vaultRoot, config.index.path), { fresh: true });
  const ctx = makeCtx(db, fts, config, resolver, problems);

  db.exec('BEGIN');
  try {
    for (const n of notes) insertNoteRows(ctx, n);
    for (const n of notes) emitNoteEdges(ctx, n);
    emitTriples(ctx, vaultRoot, new Set(notes.map((n) => n.id)));

    // record (path, mtime, sha256) so a later incremental run can diff against this
    const insFile = db.prepare('INSERT OR REPLACE INTO files(path, mtime, sha256) VALUES (?, ?, ?)');
    for (const n of notes) {
      insFile.run(n.path, n.mtime, sha256OfFile(join(vaultRoot, n.path)));
    }

    setMeta(db, 'schema_version', INDEX_SCHEMA_VERSION);
    setMeta(db, 'built_at', Date.now());
    setMeta(db, 'fts', fts ? 'fts5' : 'bm25-js');
    setMeta(db, 'config_hash', configHash(config));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    throw e;
  }
  db.close();

  return {
    stats: {
      notes: notes.length,
      passages: ctx.passageCount,
      edges: ctx.edgeCounts,
      placeholders: ctx.placeholders.size,
      phrases: ctx.phrases.size,
      staleTriples: ctx.staleTriples,
      byExtraction: ctx.byExtraction,
      fts,
      ms: Math.round(performance.now() - t0),
    },
    problems,
    notes,
  };
}

function sha256OfFile(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

/**
 * Fingerprint of the loaded config. Config affects how every note is parsed and
 * extracted (predicates, scopes, defaultExtraction, ...), so a changed config
 * invalidates the whole index, not just changed files.
 */
function configHash(config: Config): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

/**
 * Incremental index update (Phase 2). Re-parses only notes whose content changed,
 * drops rows for removed files, and re-resolves edges whose targets may have moved
 * (aliases/ids changed, or a placeholder now resolves). Falls back to a full rebuild
 * when no index exists or the schema is older than the current version.
 */
export function incrementalIndex(vaultRoot: string, config: Config, opts: { dbPath?: string } = {}): IndexResult {
  const dbPath = opts.dbPath ?? join(vaultRoot, config.index.path);
  if (!existsSync(dbPath)) return buildIndex(vaultRoot, config, opts);

  const { db, fts } = openIndex(dbPath);
  const version = getMeta(db, 'schema_version');
  if (version === null || Number(version) < INDEX_SCHEMA_VERSION) {
    // no migration code: the index is fully derivable, so just rebuild
    db.close();
    return buildIndex(vaultRoot, config, opts);
  }
  if (getMeta(db, 'config_hash') !== configHash(config)) {
    // config changed since the last build: unchanged notes would keep stale
    // edges/modes, so fall back to a full rebuild (same path as the version check)
    db.close();
    return buildIndex(vaultRoot, config, opts);
  }

  const t0 = performance.now();
  const files = walkVault(vaultRoot, config.vault.ignore);
  const onDisk = new Map(files.map((f) => [f.path, f]));

  // load the previous (path, mtime, sha256) snapshot
  const prev = new Map<string, { mtime: number; sha256: string }>();
  for (const r of db.prepare('SELECT path, mtime, sha256 FROM files').all() as { path: string; mtime: number; sha256: string }[]) {
    prev.set(r.path, { mtime: r.mtime, sha256: r.sha256 });
  }

  // classify: changed (content differs), removed (in index, not on disk)
  const changed: { path: string; abs: string; mtime: number }[] = [];
  const removed: string[] = [];
  const upsertFile = db.prepare('INSERT OR REPLACE INTO files(path, mtime, sha256) VALUES (?, ?, ?)');
  for (const f of files) {
    const p = prev.get(f.path);
    if (!p) {
      changed.push(f);
      upsertFile.run(f.path, f.mtime, sha256OfFile(f.abs));
      continue;
    }
    if (p.mtime === f.mtime) continue; // untouched
    const hash = sha256OfFile(f.abs);
    if (hash === p.sha256) {
      // mtime-only change (touch): content identical, just refresh the mtime
      upsertFile.run(f.path, f.mtime, hash);
      continue;
    }
    changed.push(f);
    upsertFile.run(f.path, f.mtime, hash);
  }
  for (const path of prev.keys()) if (!onDisk.has(path)) removed.push(path);

  // note ids for changed files (parse to learn the id) and removed files (look up by path)
  const changedNotes = changed.map((f) => parseNote(f.path, readFileSync(f.abs, 'utf8'), f.mtime, config));
  const changedIds = new Set(changedNotes.map((n) => n.id));
  const removedIds: string[] = [];
  if (removed.length) {
    const ph = removed.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id FROM nodes WHERE kind = 'note' AND path IN (${ph})`).all(...removed) as { id: string }[]) {
      removedIds.push(r.id);
    }
  }
  const affectedIds = new Set([...changedIds, ...removedIds]);

  // which unchanged notes need their edges re-resolved?
  //  - notes with an edge whose dst is a changed/removed note id
  //  - notes with a placeholder edge (the target may now resolve)
  const reResolveIds = new Set<string>();
  if (affectedIds.size > 0) {
    const ph = [...affectedIds].map(() => '?').join(',');
    for (const r of db.prepare(`SELECT DISTINCT src FROM edges WHERE dst IN (${ph})`).all(...affectedIds) as { src: string }[]) {
      reResolveIds.add(r.src);
    }
  }
  for (const r of db.prepare(`SELECT DISTINCT src FROM edges WHERE dst LIKE '?%'`).all() as { src: string }[]) {
    reResolveIds.add(r.src);
  }
  // a re-resolve src may be a passage id; map it to its owning note
  const reResolveNoteIds = new Set<string>();
  if (reResolveIds.size > 0) {
    const ph = [...reResolveIds].map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id, note_id FROM nodes WHERE id IN (${ph}) OR note_id IN (${ph})`).all(...reResolveIds, ...reResolveIds) as { id: string; note_id: string | null }[]) {
      if (r.note_id) reResolveNoteIds.add(r.note_id);
      else reResolveNoteIds.add(r.id); // the src was a note id itself
    }
  }
  // drop any that are themselves changed/removed (they get fully re-emitted)
  for (const id of affectedIds) reResolveNoteIds.delete(id);

  const problems: Problem[] = [];
  const ctx = makeCtx(db, fts, config, resolverFromDb(db), problems);

  db.exec('BEGIN');
  try {
    // 1. delete rows for changed + removed notes
    deleteNoteRows(ctx, [...affectedIds]);
    for (const path of removed) db.prepare('DELETE FROM files WHERE path = ?').run(path);

    // 2. delete edges that will be re-emitted:
    //    - every link/fact/provenance edge of a reResolve note (re-emitted whole,
    //      so delete all of them to avoid duplicates)
    //    - every placeholder edge (its target may now resolve)
    //    - any remaining edge into a changed/removed note (safety net)
    for (const id of reResolveNoteIds) {
      db.prepare(`DELETE FROM edges WHERE declared_in = ? AND origin IN ('link', 'fact', 'provenance')`).run(id);
    }
    db.exec(`DELETE FROM edges WHERE dst LIKE '?%'`);
    if (affectedIds.size > 0) {
      const ph = [...affectedIds].map(() => '?').join(',');
      db.prepare(`DELETE FROM edges WHERE dst IN (${ph})`).run(...affectedIds);
    }

    // 3. re-insert changed notes (note row, names, passages, contains edges)
    for (const n of changedNotes) insertNoteRows(ctx, n);

    // 3b. rebuild the resolver from the updated names table so re-emitted edges
    //     resolve against the NEW aliases/ids, not the pre-change state
    ctx.resolver = resolverFromDb(db);

    // 4. re-emit edges for changed notes + affected unchanged notes
    const toEmit = new Map<string, ParsedNote>(changedNotes.map((n) => [n.id, n]));
    for (const id of reResolveNoteIds) {
      if (toEmit.has(id)) continue;
      const row = db.prepare(`SELECT path FROM nodes WHERE id = ? AND kind = 'note'`).get(id) as { path: string } | undefined;
      if (!row) continue;
      const abs = join(vaultRoot, row.path);
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      toEmit.set(id, parseNote(row.path, readFileSync(abs, 'utf8'), st.mtimeMs, config));
    }
    for (const n of toEmit.values()) emitNoteEdges(ctx, n);

    // 5. hipporag triples for changed hipporag notes
    const changedHipporag = new Set(changedNotes.filter((n) => extractionModeFor(n, config).mode === 'hipporag').map((n) => n.id));
    if (changedHipporag.size > 0) {
      // pre-seed phrases so we don't duplicate existing phrase nodes
      for (const r of db.prepare(`SELECT id FROM nodes WHERE kind = 'phrase'`).all() as { id: string }[]) {
        ctx.phrases.add(r.id);
      }
      emitTriples(ctx, vaultRoot, changedHipporag);
    }

    // 6. drop placeholder nodes no longer referenced by any edge
    db.exec(`DELETE FROM nodes WHERE kind = 'placeholder' AND id NOT IN (SELECT dst FROM edges WHERE dst IS NOT NULL)`);

    setMeta(db, 'schema_version', INDEX_SCHEMA_VERSION);
    setMeta(db, 'built_at', Date.now());
    setMeta(db, 'fts', fts ? 'fts5' : 'bm25-js');
    setMeta(db, 'config_hash', configHash(config));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    db.close();
    throw e;
  }

  // final counts for the stats block, read from the committed index before closing
  const scalar = (sql: string): number =>
    (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  const edges: Record<string, number> = {};
  for (const r of db.prepare(`SELECT origin, count(*) AS n FROM edges GROUP BY origin`).all() as { origin: string; n: number }[]) {
    edges[r.origin] = r.n;
  }
  const byExtraction: Record<GraphMode, number> = { wikilink: 0, typed: 0, hipporag: 0 };
  for (const r of db.prepare(`SELECT extraction_mode AS m, count(*) AS n FROM nodes WHERE kind = 'note' GROUP BY 1`).all() as { m: string; n: number }[]) {
    if (r.m in byExtraction) byExtraction[r.m as GraphMode] = r.n;
  }
  const notes = scalar(`SELECT count(*) AS n FROM nodes WHERE kind = 'note'`);
  const passages = scalar(`SELECT count(*) AS n FROM nodes WHERE kind = 'passage'`);
  const placeholders = scalar(`SELECT count(*) AS n FROM nodes WHERE kind = 'placeholder'`);
  const phrases = scalar(`SELECT count(*) AS n FROM nodes WHERE kind = 'phrase'`);
  db.close();

  return {
    stats: {
      notes,
      passages,
      edges,
      placeholders,
      phrases,
      staleTriples: ctx.staleTriples,
      byExtraction,
      fts,
      ms: Math.round(performance.now() - t0),
      changed: changed.length,
      removed: removed.length,
    },
    problems,
    notes: changedNotes,
  };
}

/**
 * Embed passage rows that lack an embedding or were embedded by a different
 * model (Phase 2). A changed passage gets a fresh row with NULL embedding via
 * the incremental delete/re-insert, so content changes are covered by the same
 * filter. buildIndex/incrementalIndex stay synchronous; this is the async
 * follow-up the CLI and watch call after a successful index.
 */
export async function embedPassages(
  dbPath: string,
  config: Config,
  client?: EmbeddingsClient,
): Promise<{ embedded: number; total: number }> {
  const { db } = openIndex(dbPath);
  try {
    const c = client ?? createEmbeddingsClient(config.embeddings);
    const total = (db.prepare(`SELECT count(*) AS n FROM nodes WHERE kind = 'passage'`).get() as { n: number }).n;
    if (c instanceof NullEmbeddingsClient) return { embedded: 0, total }; // provider 'none'
    const model = c.model;
    const rows = db
      .prepare(
        `SELECT id, text, embedding, embedding_model FROM nodes
         WHERE kind = 'passage' AND (embedding IS NULL OR embedding_model IS DISTINCT FROM ?)`,
      )
      .all(model) as { id: string; text: string; embedding: Uint8Array | null; embedding_model: string | null }[];
    if (rows.length === 0) return { embedded: 0, total };

    const results = await c.embed(rows.map((r) => ({ id: r.id, text: r.text ?? '' })));
    const upd = db.prepare('UPDATE nodes SET embedding = ?, embedding_model = ? WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const r of results) {
        upd.run(Buffer.from(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength), model, r.id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { embedded: results.length, total };
  } finally {
    db.close();
  }
}
