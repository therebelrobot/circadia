// Full rebuild of the derived index from the vault.
// Incremental indexing is a Phase 2 item (docs/ROADMAP.md); correctness first.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { GraphMode, ParsedNote, Problem, SourceKind, Trust, WikiLink } from '../types.ts';
import { DEFAULT_TRUST } from '../vault/facts.ts';
import { parseNote } from '../vault/parse.ts';
import { walkVault } from '../vault/walk.ts';
import { normKey, slugify } from '../vault/util.ts';
import { extractionModeFor, MODE_RANK } from '../extract/scope.ts';
import { loadTriples, passageHash } from '../extract/triples.ts';
import { INDEX_SCHEMA_VERSION, openIndex, setMeta } from './db.ts';

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

export function buildIndex(vaultRoot: string, config: Config, opts: { dbPath?: string } = {}): IndexResult {
  const t0 = performance.now();
  const notes = parseVault(vaultRoot, config);
  const problems: Problem[] = notes.flatMap((n) => n.problems);
  const { resolver, problems: resolveProblems } = buildResolver(notes);
  problems.push(...resolveProblems);

  const { db, fts } = openIndex(opts.dbPath ?? join(vaultRoot, config.index.path), { fresh: true });

  const insNode = db.prepare(`INSERT OR REPLACE INTO nodes
    (id, kind, note_type, note_id, path, title, heading, text, passage_kind, importance, created, updated,
     extraction_mode, extraction_why, tags, content_hash, trust)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insName = db.prepare('INSERT OR IGNORE INTO names(name, node_id, tier) VALUES (?, ?, ?)');
  const insEdge = db.prepare(`INSERT INTO edges
    (src, dst, value, origin, type, weight, valid_from, valid_to, recorded_at, expired_at,
     source_kind, trust, conf, provenance, fact_id, declared_in)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insFts = fts ? db.prepare('INSERT INTO passages_fts(passage_id, title, heading, text) VALUES (?, ?, ?, ?)') : null;

  const edgeCounts: Record<string, number> = {};
  const byExtraction: Record<GraphMode, number> = { wikilink: 0, typed: 0, hipporag: 0 };
  const placeholders = new Set<string>();
  const phrases = new Set<string>();
  let passageCount = 0;
  let staleTriples = 0;
  const hashes = new Map<string, string>();
  const hipporagNotes = new Set<string>();

  const edge = (
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
  ) => {
    insEdge.run(
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
    edgeCounts[origin] = (edgeCounts[origin] ?? 0) + 1;
  };

  const resolveOrPlaceholder = (link: WikiLink, from: ParsedNote, line: number): string => {
    const r = resolver.resolve(link.target);
    if (r) {
      if (r.ambiguous) {
        problems.push({
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
    if (!placeholders.has(pid)) {
      placeholders.add(pid);
      insNode.run(pid, 'placeholder', null, null, null, link.target, null, null, null, 0, null, null, null, null, '[]', null, 'low');
    }
    problems.push({
      severity: 'warning',
      path: from.path,
      line,
      code: 'link.unresolved',
      message: `[[${link.target}]] does not resolve to a note (kept as placeholder)`,
    });
    return pid;
  };

  db.exec('BEGIN');
  try {
    for (const n of notes) {
      const { mode, reason } = extractionModeFor(n, config);
      byExtraction[mode]++;
      if (mode === 'hipporag') hipporagNotes.add(n.id);
      insNode.run(
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
      insName.run(normKey(n.id), n.id, 0);
      for (const a of n.aliases) insName.run(normKey(a), n.id, 1);
      insName.run(normKey(n.title), n.id, 2);

      for (const p of n.passages) {
        const h = passageHash(p.text);
        hashes.set(p.id, h);
        insNode.run(p.id, 'passage', null, n.id, n.path, n.title, p.heading, p.text, p.kind, n.importance, n.created, n.updated, null, null, '[]', h, passageTrust(n, p.kind));
        insFts?.run(p.id, n.title, p.heading ?? '', p.text);
        edge(n.id, p.id, 'contains', 'contains', { declaredIn: n.id });
        passageCount++;
      }
    }

    for (const n of notes) {
      const mode = extractionModeFor(n, config).mode;

      // link edges: from the passage the link appears in (or the note, for frontmatter links)
      const counts = new Map<string, { src: string; dst: string; count: number }>();
      for (const { link, line, passage } of n.links) {
        const dst = resolveOrPlaceholder(link, n, line);
        if (dst === n.id) continue;
        const src = passage ?? n.id;
        const key = `${src}\u0000${dst}`;
        const c = counts.get(key) ?? { src, dst, count: 0 };
        c.count++;
        counts.set(key, c);
      }
      for (const c of counts.values()) {
        edge(c.src, c.dst, 'link', 'link', { weight: 1 + Math.log(c.count), declaredIn: n.id });
      }

      // typed facts + provenance, only for notes extracted at >= typed
      if (MODE_RANK[mode] < MODE_RANK.typed) continue;
      for (const f of n.facts) {
        const pred = config.predicates.defs[f.predicate];
        if (!pred) {
          problems.push({
            severity: config.predicates.strict ? 'error' : 'warning',
            path: n.path,
            line: f.line,
            code: 'fact.unknown-predicate',
            message: `predicate "${f.predicate}" is not in predicates.defs`,
          });
        } else if (pred.object === 'entity' && f.object.kind !== 'link') {
          problems.push({ severity: 'error', path: n.path, line: f.line, code: 'fact.object-kind', message: `"${f.predicate}" expects a [[wikilink]] object` });
        } else if (pred.object === 'literal' && f.object.kind !== 'literal') {
          problems.push({ severity: 'error', path: n.path, line: f.line, code: 'fact.object-kind', message: `"${f.predicate}" expects a literal object` });
        } else if (pred.values && f.object.kind === 'literal' && !pred.values.includes(f.object.value)) {
          problems.push({ severity: 'warning', path: n.path, line: f.line, code: 'fact.value', message: `"${f.object.value}" not in allowed values for ${f.predicate}` });
        }

        const provenance = f.src ? resolveOrPlaceholder(f.src, n, f.line) : null;
        const dst = f.object.kind === 'link' ? resolveOrPlaceholder(f.object.link, n, f.line) : null;
        edge(n.id, dst, 'fact', f.predicate, {
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
          edge(n.id, provenance, 'provenance', 'src', {
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

    // hipporag: load cached triples for passages of notes extracted at hipporag
    const { triples, badLines } = loadTriples(vaultRoot);
    if (badLines) {
      problems.push({ severity: 'warning', path: '.palimpsest/triples', code: 'triples.bad-lines', message: `${badLines} malformed triple lines skipped` });
    }
    const phraseNode = (text: string): string => {
      const id = `p:${slugify(text)}`;
      if (!phrases.has(id)) {
        phrases.add(id);
        insNode.run(id, 'phrase', null, null, null, text, null, text, null, 0, null, null, null, null, '[]', null, 'medium');
        // phrases that name a note are bridged to it, so triples connect into the note graph
        const r = resolver.resolve(text);
        if (r) edge(id, r.id, 'synonym', 'names', { weight: 1 });
      }
      return id;
    };
    for (const t of triples) {
      const noteId = t.passageId.split('#')[0];
      if (!hipporagNotes.has(noteId)) continue;
      if (hashes.get(t.passageId) !== t.contentHash) {
        staleTriples++;
        continue;
      }
      const s = phraseNode(t.subject);
      const o = phraseNode(t.object);
      edge(t.passageId, s, 'triple', 'mentions', { declaredIn: noteId });
      edge(t.passageId, o, 'triple', 'mentions', { declaredIn: noteId });
      edge(s, o, 'triple', t.predicate, { conf: t.conf ?? null, weight: t.conf ?? 1, sourceKind: 'agent', trust: 'medium', declaredIn: noteId });
    }
    if (staleTriples) {
      problems.push({ severity: 'warning', path: '.palimpsest/triples', code: 'triples.stale', message: `${staleTriples} cached triples skipped: passage text changed since extraction` });
    }

    setMeta(db, 'schema_version', INDEX_SCHEMA_VERSION);
    setMeta(db, 'built_at', Date.now());
    setMeta(db, 'fts', fts ? 'fts5' : 'bm25-js');
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
      passages: passageCount,
      edges: edgeCounts,
      placeholders: placeholders.size,
      phrases: phrases.size,
      staleTriples,
      byExtraction,
      fts,
      ms: Math.round(performance.now() - t0),
    },
    problems,
    notes,
  };
}
