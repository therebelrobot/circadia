// Recall = pattern completion from a partial cue (docs/RETRIEVAL.md).
//   1. cues      – keyword hits on passages + entity names mentioned in the query
//   2. seeds     – reciprocal-rank fusion of the cue lists
//   3. spread    – personalized PageRank over the edges the mode allows, filtered by
//                  trust and (optionally) an as-of time
//   4. rank      – graph score + ACT-R base-level activation + importance
//   5. budget    – return passages until the token budget is spent; log the access
// In `auto` mode, steps 3–5 run on successive rungs of the ladder until the result is
// confident enough (or the ladder ends).

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { AsOfProse, GraphMode, QueryMode, RecallHit, RecallResult, Trust } from '../types.ts';
import { getMeta, openIndex } from '../index/db.ts';
import { getNoteCommitAtTime, isGitRepo, readFileAtCommit } from '../vault/git.ts';
import { parseNote } from '../vault/parse.ts';
import { bm25Search, ftsSearch, type KeywordHit } from './keyword.ts';
import { findCandidateTriples, filterTriplesWithLLM, extractSeeds, HttpTripleVerifier, type TripleVerifier } from './recognition-memory.ts';
import { MODE_ORIGINS } from './modes.ts';
import { addEdge, makeGraph, personalizedPageRank, type Graph } from './ppr.ts';
import { appendAccess, baseLevelFromParts, queryHash, readAccessLog, readAccessLogFrom, retrievalProbability } from './activation.ts';
import { loadAccessSummaries, presentationsForActivation, type NodePresentations } from './log-compact.ts';
import { edgeAllowed, loadGraph, TRUST_RANK, type EdgeRow, type GraphCache } from './graph-cache.ts';
import { topKByCosine } from './embeddings.ts';

export interface RecallOptions {
  mode?: QueryMode;
  /** epoch ms: answer as the vault stood / as the world was at this time */
  asOf?: number | null;
  topK?: number;
  tokenBudget?: number;
  logAccess?: boolean;
  /** session id for reconsolidation window tracking */
  session?: string;
  /**
   * Restrict seeds and traversal to a path prefix or tag (docs/SECURITY.md T4). A value
   * beginning with `tag:` matches notes carrying that tag; any other value is a
   * vault-relative path prefix. See docs/RETRIEVAL.md §11.
   */
  scope?: string;
  now?: number;
  /** override db path (tests) */
  dbPath?: string;
  /**
   * Embedding of the query. When provided (and the index has the embedding
   * columns, schema v2+), a third RRF seed list is added: the passages whose
   * stored embeddings are closest to the query. This is how a paraphrased
   * query with no keyword overlap still finds its passage.
   */
  queryEmbedding?: Float32Array;
  /**
   * Per-mode graph cache for long-running processes (MCP server). The one-shot
   * CLI recall does not use one.
   */
  graphCache?: GraphCache;
}

const RRF_K = 60;

interface PassageRow {
  id: string;
  note_id: string;
  path: string;
  title: string;
  heading: string | null;
  text: string;
  importance: number | null;
  created: number | null;
  updated: number | null;
  trust: Trust | null;
}

/** Entity names (id, alias, title) that occur in the query as whole words. */
export function cueEntities(db: DatabaseSync, query: string): string[] {
  const q = ` ${query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const rows = db
    .prepare(
      `SELECT n.name, n.node_id FROM names n JOIN nodes x ON x.id = n.node_id
       WHERE x.note_type = 'entity' AND length(n.name) >= 3`,
    )
    .all() as { name: string; node_id: string }[];
  const found = new Set<string>();
  for (const r of rows) {
    const needle = ` ${r.name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    if (needle.trim() && q.includes(needle)) found.add(r.node_id);
  }
  return [...found];
}

function rrf(lists: { via: string; ids: string[] }[]): Map<string, { score: number; via: string[] }> {
  const out = new Map<string, { score: number; via: string[] }>();
  for (const { via, ids } of lists) {
    ids.forEach((id, rank) => {
      const e = out.get(id) ?? { score: 0, via: [] };
      e.score += 1 / (RRF_K + rank + 1);
      if (!e.via.includes(via)) e.via.push(via);
      out.set(id, e);
    });
  }
  return out;
}

interface RungResult {
  hits: RecallHit[];
  margin: number;
  /** RFC-0002: hits inserted by fact expansion (0 when the flag is off). */
  expanded: number;
}

/**
 * Node ids allowed by a recall `scope` (docs/SECURITY.md T4). SECURITY T4 says "a path
 * prefix or tag" without saying how one string selects between them, so this takes the
 * narrower reading: the form is explicit, never guessed.
 *   - `tag:<name>`  → notes whose `tags` include `<name>`, plus their passages;
 *   - anything else → notes and passages whose vault-relative path is the prefix itself
 *                     or lies under it at a path-segment boundary (`projects/alpha` does
 *                     not match `projects/alphabet`).
 * Phrase nodes (hipporag) carry no path or tags; a phrase is in scope only when an
 * in-scope passage mentions it, so a scoped hipporag traversal stays inside the scope.
 */
export function resolveScope(db: DatabaseSync, scope: string): Set<string> {
  const ids = new Set<string>();
  if (scope.startsWith('tag:')) {
    const tag = scope.slice('tag:'.length);
    const notes = db.prepare(`SELECT id, tags FROM nodes WHERE kind = 'note'`).all() as { id: string; tags: string | null }[];
    const noteIds: string[] = [];
    for (const n of notes) {
      let tags: string[] = [];
      try {
        const parsed: unknown = JSON.parse(n.tags ?? '[]');
        if (Array.isArray(parsed)) tags = parsed as string[];
      } catch {
        tags = [];
      }
      if (tags.includes(tag)) {
        ids.add(n.id);
        noteIds.push(n.id);
      }
    }
    if (noteIds.length > 0) {
      const ph = noteIds.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT id FROM nodes WHERE note_id IN (${ph})`).all(...noteIds) as { id: string }[]) {
        ids.add(r.id);
      }
    }
  } else {
    const prefix = scope.replace(/\/+$/, '');
    if (prefix.length > 0) {
      const rows = db.prepare(`SELECT id, path FROM nodes WHERE path IS NOT NULL`).all() as { id: string; path: string }[];
      for (const r of rows) {
        if (r.path === prefix || r.path.startsWith(prefix + '/')) ids.add(r.id);
      }
    }
  }
  // Keep phrase nodes reachable from in-scope passages so hipporag traversal survives a scope.
  const mentions = db
    .prepare(`SELECT src, dst FROM edges WHERE origin = 'triple' AND type = 'mentions' AND dst IS NOT NULL`)
    .all() as { src: string; dst: string }[];
  for (const m of mentions) if (ids.has(m.src)) ids.add(m.dst);
  return ids;
}

/** Keep only edges whose both endpoints are in `allowed` — a scoped traversal. */
function filterGraph(g: Graph, allowed: Set<string>): Graph {
  const out = makeGraph();
  for (let i = 0; i < g.ids.length; i++) {
    const a = g.ids[i];
    if (!allowed.has(a)) continue;
    const nb = g.nbr[i];
    const ws = g.w[i];
    for (let k = 0; k < nb.length; k++) {
      const j = nb[k];
      if (j <= i) continue; // undirected edges are stored twice; add each once
      const b = g.ids[j];
      if (!allowed.has(b)) continue;
      addEdge(out, a, b, ws[k]);
    }
  }
  return out;
}

/**
 * RFC-0002: `expanded > maxInserted` on any recall is a bug. The expansion loop caps
 * itself, so this is a safety net; criterion 6's test proves the cap holds, and this
 * assertion is what makes an over-cap result fail loudly instead of silently.
 */
export function assertExpandedWithinCap(expanded: number, maxInserted: number): void {
  if (expanded > maxInserted) {
    throw new Error(`fact expansion inserted ${expanded} passages, over maxInserted ${maxInserted}`);
  }
}

/** Light suffix stripping so `maintained_by` matches "maintainer" (RFC-0002 step 3). */
function lightStem(w: string): string {
  for (const suf of ['ing', 'ed', 'er', 'es', 's']) {
    if (w.length > suf.length + 1 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}

/** Query tokens, each with its light stem, for predicate matching. */
function queryTokenSet(query: string): Set<string> {
  const out = new Set<string>();
  for (const w of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    out.add(w);
    out.add(lightStem(w));
  }
  return out;
}

/** How many of a predicate's parts match a query token (raw or stemmed). */
function predicateMatch(predicate: string, tokens: Set<string>): number {
  let n = 0;
  for (const part of predicate.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (tokens.has(part) || tokens.has(lightStem(part))) n++;
  }
  return n;
}

/** World-time validity at `t`: `valid_from <= t < valid_to` (null bounds are open). */
function worldValidAt(e: EdgeRow, t: number): boolean {
  if (e.valid_from !== null && e.valid_from > t) return false;
  if (e.valid_to !== null && e.valid_to <= t) return false;
  return true;
}

/**
 * RFC-0002 entity-anchored fact expansion. After ranking and before the token budget,
 * insert a cue entity's `#facts` passage and up to `perHit` fact targets, capped at
 * `maxInserted` passages per query. Only passages already in the candidate set are
 * inserted, so the trust floor and the recall scope have already applied. Only `fact`
 * edges are followed — never `dream`, `triple`, `synonym` or `link`.
 *
 * `hits` is the full ranked candidate list (post trust/as-of filter), not the budgeted
 * output, so a target that ranked below the top K can still be inserted.
 */
export function expandFacts(
  db: DatabaseSync,
  cfg: Config,
  mode: GraphMode,
  entities: readonly string[],
  asOf: number | null,
  now: number,
  query: string,
  hits: RecallHit[],
): { hits: RecallHit[]; expanded: number } {
  const fe = cfg.retrieval.factExpansion;
  // Expansion needs fact edges; wikilink has none, so it is a no-op there.
  if (!fe.enabled || fe.maxInserted <= 0 || entities.length === 0 || !MODE_ORIGINS[mode].includes('fact')) {
    return { hits, expanded: 0 };
  }

  // The candidate set: only passages already ranked (and thus already past the trust
  // floor, the as-of created filter, and the scope) may be inserted.
  const byId = new Map(hits.map((h) => [h.passageId, h]));
  const entitySet = new Set(entities);
  const tokens = queryTokenSet(query);
  const worldNow = asOf ?? now;

  const out: RecallHit[] = [];
  // `placed` tracks the output, not the candidate set: a target that ranked below the
  // top K is still in the candidate set and must be insertable, while a passage already
  // in the output is never duplicated.
  const placed = new Set<string>();
  const expandedEntities = new Set<string>();
  let expanded = 0;

  for (const h of hits) {
    if (placed.has(h.passageId)) continue; // already inserted as a target
    out.push(h);
    placed.add(h.passageId);
    if (expanded >= fe.maxInserted) continue;
    // Each cue entity expands once, at the position of its first (highest-ranked) hit.
    if (!entitySet.has(h.noteId) || expandedEntities.has(h.noteId)) continue;
    expandedEntities.add(h.noteId);

    // 1. the entity's own `#facts` passage, right after the hit. It is inserted before a
    // predicate is chosen, so it carries no `via.predicate`.
    const factsId = `${h.noteId}#facts`;
    const factsHit = byId.get(factsId);
    if (factsHit && !placed.has(factsId)) {
      out.push({ ...factsHit, via: { kind: 'fact-expansion', from: h.noteId } });
      placed.add(factsId);
      expanded++;
    }

    // 2. the entity's fact edges that pass edgeAllowed (trust, supersession, system time)
    // and are valid in world time at the query time. `edgeAllowed` keeps ended-but-true
    // history for a now-query, which is right for traversal but wrong for "runs on now".
    const edges = db
      .prepare(
        `SELECT e.src, e.dst, e.origin, e.weight, e.valid_from, e.valid_to, e.recorded_at,
                e.expired_at, e.trust, n.created AS declared_created, e.type AS predicate
         FROM edges e LEFT JOIN nodes n ON n.id = e.declared_in
         WHERE e.src = ? AND e.origin = 'fact' AND e.dst IS NOT NULL`,
      )
      .all(h.noteId) as unknown as (EdgeRow & { predicate: string })[];

    // 3. order by predicate token match; ties keep index order.
    const ordered = edges
      .filter((e) => edgeAllowed(e, asOf, cfg) && worldValidAt(e, worldNow))
      .map((e, i) => ({ e, i, score: predicateMatch(e.predicate, tokens) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.e);
    // 4. insert up to `perHit` targets: the target's first passage, then its `#facts`.
    let insertedTargets = 0;
    for (const e of ordered) {
      if (insertedTargets >= fe.perHit || expanded >= fe.maxInserted) break;
      const targetNote = e.dst as string;
      let insertedThis = false;
      const firstId = `${targetNote}#0`;
      if (!placed.has(firstId)) {
        const t = byId.get(firstId);
        if (t) {
          out.push({ ...t, via: { kind: 'fact-expansion', from: h.noteId, predicate: e.predicate } });
          placed.add(firstId);
          expanded++;
          insertedThis = true;
        }
      }
      const targetFactsId = `${targetNote}#facts`;
      if (expanded < fe.maxInserted && !placed.has(targetFactsId)) {
        const t = byId.get(targetFactsId);
        if (t) {
          out.push({ ...t, via: { kind: 'fact-expansion', from: h.noteId, predicate: e.predicate } });
          placed.add(targetFactsId);
          expanded++;
          insertedThis = true;
        }
      }
      if (insertedThis) insertedTargets++;
    }
  }

  assertExpandedWithinCap(expanded, fe.maxInserted);
  return { hits: out, expanded };
}

function runRung(
  db: DatabaseSync,
  cfg: Config,
  mode: GraphMode,
  seeds: Map<string, number>,
  asOf: number | null,
  now: number,
  presentations: Map<string, NodePresentations>,
  topK: number,
  tokenBudget: number,
  scopeIds: Set<string> | null,
  entities: readonly string[],
  query: string,
  graphCache?: GraphCache,
): RungResult {
  const loaded = graphCache?.getGraph(mode, asOf, cfg) ?? loadGraph(db, mode, asOf, cfg);
  // A scope is a traversal filter: only edges with both endpoints in scope participate,
  // so activation cannot leak in from a project outside the scope.
  const g = scopeIds ? filterGraph(loaded, scopeIds) : loaded;

  const ppr = personalizedPageRank(g, seeds, {
    damping: cfg.graph.damping,
    maxIterations: cfg.graph.maxIterations,
    tolerance: cfg.graph.tolerance,
  });
  // seeds with no edges still count as candidates
  for (const [id, v] of seeds) if (!ppr.has(id)) ppr.set(id, v * (1 - cfg.graph.damping));

  const ranked = [...ppr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400);
  const ids = ranked.map(([id]) => id);
  if (ids.length === 0) return { hits: [], margin: 0, expanded: 0 };

  const rows = db
    .prepare(
      `SELECT id, note_id, path, title, heading, text, importance, created, updated, trust
       FROM nodes WHERE kind = 'passage' AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as unknown as PassageRow[];

  const pprMax = Math.max(...rows.map((r) => ppr.get(r.id) ?? 0), 1e-12);
  const acts = rows.map((r) => {
    // compacted run (optimized-learning form) + exact recent presentations; the note's
    // encoding time is always an exact presentation.
    const p = presentations.get(r.id);
    const recent = [...(p?.recent ?? [])];
    const enc = r.created ?? r.updated;
    if (enc !== null && !recent.includes(enc)) recent.push(enc);
    return baseLevelFromParts(p?.compacted ?? null, recent, now, cfg.retrieval.actrDecay);
  });
  const w = cfg.retrieval.weights;
  const rp = cfg.retrieval;

  const rankedHits: RecallHit[] = rows
    .filter((r) => TRUST_RANK[(r.trust ?? 'low') as Trust] >= TRUST_RANK[cfg.retrieval.trustFloor])
    // as-of: passages from notes created after asOf weren't in memory yet
    .filter((r) => asOf === null || r.created === null || r.created <= asOf)
    .map((r, i) => {
      const graph = (ppr.get(r.id) ?? 0) / pprMax;
      const activation = retrievalProbability(acts[i], rp.actrDecay, rp.actrThresholdDays, rp.actrNoise);
      const importance = r.importance ?? 0.5;
      return {
        passageId: r.id,
        noteId: r.note_id,
        path: r.path,
        title: r.title,
        heading: r.heading,
        text: r.text,
        score: w.graph * graph + w.activation * activation + w.importance * importance,
        components: { graph, activation, importance, seed: seeds.get(r.id) ?? 0 },
        trust: (r.trust ?? 'low') as Trust,
      };
    })
    .sort((a, b) => b.score - a.score);

  // RFC-0002: entity-anchored fact expansion runs after ranking and before the token
  // budget, so inserted hits compete for the same top-K and budget as ranked ones.
  const expandedResult = expandFacts(db, cfg, mode, entities, asOf, now, query, rankedHits);
  const hits = expandedResult.hits;

  const out: RecallHit[] = [];
  let budget = tokenBudget;
  for (const h of hits) {
    if (out.length >= topK) break;
    const cost = Math.ceil(h.text.length / 4);
    if (out.length > 0 && cost > budget) continue;
    out.push(h);
    budget -= cost;
  }
  // A single hit is not evidence of confidence: with nothing to compare against,
  // the margin is 0 so `auto` keeps escalating (a lone seed can still be the wrong
  // rung). Two or more hits use the relative top-1/top-2 gap.
  const margin = out.length >= 2 && out[0].score > 0 ? (out[0].score - out[1].score) / out[0].score : 0;
  return { hits: out, margin, expanded: expandedResult.expanded };
}

/**
 * C17: replace each hit's prose with the note's text at the last commit <= `asOf`.
 *
 * The index stores the CURRENT passage text (it is derived from the working tree), so an
 * as-of query would otherwise return today's prose. Here we re-read the note at the commit
 * that was HEAD at `asOf`, re-parse it, and map the hit's passage id onto the historical
 * passage. Passage ids are `<noteId>#<n>`, so a passage that did not exist at that commit
 * (or a note with no commit <= asOf) keeps the current text — the documented fallback.
 *
 * Facts are unaffected: their as-of filtering happens on the fact edges, and the `#facts`
 * passage is re-rendered from the same commit for consistency.
 */
function applyAsOfProse(vaultRoot: string, cfg: Config, hits: RecallHit[], asOf: number): AsOfProse {
  if (!isGitRepo(vaultRoot)) {
    return { fromGit: false, reason: 'vault is not a git repository; using current prose' };
  }
  // One git read + parse per note, not per hit.
  const byPath = new Map<string, ReturnType<typeof parseNote> | null>();
  let replaced = 0;
  let missing = 0;
  for (const h of hits) {
    let note = byPath.get(h.path);
    if (note === undefined) {
      const commit = getNoteCommitAtTime(vaultRoot, h.path, asOf);
      const raw = commit ? readFileAtCommit(vaultRoot, h.path, commit) : null;
      note = raw === null ? null : parseNote(h.path, raw, 0, cfg);
      byPath.set(h.path, note);
    }
    const p = note?.passages.find((x) => x.id === h.passageId);
    if (!p) {
      missing++;
      continue;
    }
    h.text = p.text;
    h.heading = p.heading;
    h.title = note!.title;
    replaced++;
  }
  if (replaced === 0) {
    return { fromGit: false, reason: 'no commit at or before as-of; using current prose' };
  }
  return {
    fromGit: true,
    reason:
      missing > 0
        ? `prose read from git history for ${replaced} passage(s); ${missing} had no commit at or before as-of`
        : `prose read from git history for ${replaced} passage(s)`,
  };
}

export async function recall(vaultRoot: string, cfg: Config, query: string, opts: RecallOptions = {}): Promise<RecallResult> {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ?? null;
  const topK = opts.topK ?? cfg.retrieval.topK;
  const tokenBudget = opts.tokenBudget ?? cfg.retrieval.tokenBudget;
  const modeRequested = opts.mode ?? cfg.graph.query.mode;

  const { db } = openIndex(opts.dbPath ?? join(vaultRoot, cfg.index.path));
  try {
    if (getMeta(db, 'schema_version') === null) {
      throw new Error('index is empty — run `circadia index` first');
    }
    const backend = (getMeta(db, 'fts') ?? 'bm25-js') as 'fts5' | 'bm25-js';

    // 1–2. cues and seeds
    const kw: KeywordHit[] =
      backend === 'fts5' ? ftsSearch(db, query, cfg.retrieval.seedLimit) : bm25Search(db, query, cfg.retrieval.seedLimit);
    const entities = cueEntities(db, query);
    const lists: { via: string; ids: string[] }[] = [
      { via: 'keyword', ids: kw.map((k) => k.passageId) },
      { via: 'entity', ids: entities },
    ];
    // vector seeds: brute-force cosine over stored passage embeddings. They feed
    // the same RRF fusion as keyword/entity seeds, so no new score component is
    // needed — the existing { graph, activation, importance, seed } stays complete.
    if (opts.queryEmbedding) {
      const version = Number(getMeta(db, 'schema_version') ?? 0);
      if (version >= 2) {
        const rows = db
          .prepare(`SELECT id, embedding FROM nodes WHERE kind = 'passage' AND embedding IS NOT NULL`)
          .all() as { id: string; embedding: Uint8Array }[];
        const candidates = rows.map((r) => ({ id: r.id, embedding: new Float32Array(new Uint8Array(r.embedding).buffer) }));
        const top = topKByCosine(opts.queryEmbedding, candidates, cfg.retrieval.seedLimit);
        if (top.length > 0) lists.push({ via: 'vector', ids: top.map((t) => t.id) });
      }
    }
    // recognition-memory seed filter (HippoRAG 2): filter triples by embedding + LLM verification
    if (opts.queryEmbedding && cfg.graph.hipporag.recognitionMemory.enabled) {
      const version = Number(getMeta(db, 'schema_version') ?? 0);
      if (version >= 2) {
        const candidates = await findCandidateTriples(vaultRoot, db, opts.queryEmbedding, cfg);
        if (candidates.length > 0) {
          // Create verifier from config
          const verifier: TripleVerifier = new HttpTripleVerifier(
            cfg.extraction.endpoint,
            cfg.extraction.model || 'llama3',
            cfg.extraction.apiKeyEnv,
          );
          const verified = await filterTriplesWithLLM(candidates, query, verifier, cfg);
          const { passageIds } = extractSeeds(verified);
          if (passageIds.length > 0) {
            lists.push({ via: 'recognition-memory', ids: passageIds });
          }
        }
      }
    }
    // A scope filters seeds as well as traversal: an out-of-scope cue must not seed the
    // walk, or its neighbours would surface even with the graph filtered.
    const scopeIds = opts.scope ? resolveScope(db, opts.scope) : null;
    let fused = rrf(lists);
    if (scopeIds) fused = new Map([...fused.entries()].filter(([id]) => scopeIds.has(id)));
    const seeds = new Map([...fused.entries()].map(([id, v]) => [id, v.score]));

    // ACT-R presentations: compacted summaries + raw events after the summary's watermark,
    // both filtered to <= asOf. The raw log is never rotated (ADR-0009), so an as-of query
    // dated before the watermark falls back to it. as-of recall evaluates activation as it
    // stood then: no future accesses, "now" = asOf.
    const accessFile = join(vaultRoot, cfg.index.accessLog);
    const activationNow = asOf ?? now;
    const summaryFile = join(vaultRoot, cfg.index.path.replace(/\.sqlite$/, '-access-summaries.jsonl'));
    const summaries = loadAccessSummaries(summaryFile);
    // Only an as-of query dated before the watermark needs the whole log; otherwise read
    // the tail from the summary's byte offset, so compaction bounds the per-query cost.
    const useSummary = asOf === null || asOf >= summaries.watermark;
    const events = useSummary ? readAccessLogFrom(accessFile, summaries.offset) : readAccessLog(accessFile);
    const presentations = presentationsForActivation(summaries, events, asOf);

    // 3–5 on the mode ladder
    const escalations: RecallResult['escalations'] = [];
    let ladder: GraphMode[];
    if (modeRequested === 'auto') {
      ladder = [...cfg.graph.query.auto.ladder];
      const hasTriples = (db.prepare(`SELECT 1 FROM edges WHERE origin = 'triple' LIMIT 1`).get() ?? null) !== null;
      if (!hasTriples && ladder.includes('hipporag')) ladder = ladder.filter((m) => m !== 'hipporag');
      // time only lives on typed fact edges, so an as-of query skips wikilink-only rungs
      if (asOf !== null) {
        while (ladder.length > 1 && MODE_ORIGINS[ladder[0]].indexOf('fact') === -1) {
          escalations.push({ from: ladder[0], to: ladder[1], reason: 'as-of query needs time-stamped fact edges' });
          ladder = ladder.slice(1);
        }
      }
      if (entities.length >= cfg.graph.query.auto.multiEntityThreshold && ladder.length > 1 && escalations.length === 0) {
        escalations.push({ from: ladder[0], to: ladder[1], reason: `cue names ${entities.length} entities (multi-hop signal)` });
        ladder = ladder.slice(1);
      }
    } else {
      ladder = [modeRequested];
    }

    let modeUsed = ladder[0];
    let result: RungResult = { hits: [], margin: 0, expanded: 0 };
    for (let i = 0; i < ladder.length; i++) {
      modeUsed = ladder[i];
      result = runRung(db, cfg, modeUsed, seeds, asOf, activationNow, presentations, topK, tokenBudget, scopeIds, entities, query, opts.graphCache);
      if (modeRequested !== 'auto' || i === ladder.length - 1) break;
      const a = cfg.graph.query.auto;
      const reasons: string[] = [];
      if (seeds.size < a.minSeeds) reasons.push(`only ${seeds.size} seed(s)`);
      if (result.hits.length === 0) reasons.push('no hits');
      else if (result.margin < a.minTopMargin) reasons.push(`top-score margin ${result.margin.toFixed(3)} < ${a.minTopMargin}`);
      if (reasons.length === 0) break;
      escalations.push({ from: modeUsed, to: ladder[i + 1], reason: reasons.join('; ') });
    }

    // C17: an as-of query renders prose from the note at the last commit <= asOf. This runs
    // after ranking (scores are computed from the current index) and before logging, so the
    // access log still records the passage id, not the historical text.
    const asOfProse =
      asOf !== null && result.hits.length > 0 ? applyAsOfProse(vaultRoot, cfg, result.hits, asOf) : undefined;

    if (opts.logAccess ?? cfg.retrieval.logAccess) {
      const q = queryHash(query);
      appendAccess(
        accessFile,
        result.hits.map((h) => ({ t: now, node: h.passageId, kind: 'recall' as const, q, session: opts.session })),
      );
    }

    return {
      query,
      modeRequested,
      modeUsed,
      escalations,
      asOf,
      hits: result.hits,
      seeds: [...fused.entries()].map(([nodeId, v]) => ({ nodeId, score: v.score, via: v.via })).sort((a, b) => b.score - a.score),
      keywordBackend: backend,
      asOfProse,
      // RFC-0002: absent when expansion is off, so a flag-off result is byte-identical to
      // the pre-expansion shape.
      ...(cfg.retrieval.factExpansion.enabled ? { expanded: result.expanded } : {}),
    };
  } finally {
    db.close();
  }
}

/**
 * Render hits for an LLM context window. Low-trust passages are fenced as data so a
 * poisoned memory cannot masquerade as an instruction (docs/SECURITY.md).
 */
export function renderForContext(r: RecallResult): string {
  const parts = r.hits.map((h) => {
    // RFC-0002: show why an expanded passage is present, so the agent can see the fact
    // edge that pulled it in. The entity's own `#facts` passage has no predicate.
    const via = h.via
      ? ` · via: fact-expansion from ${h.via.from}${h.via.predicate ? ` (${h.via.predicate})` : ''}`
      : '';
    const head = `### ${h.title}${h.heading && h.heading !== h.title ? ` › ${h.heading}` : ''}\n_source: ${h.path} · trust: ${h.trust}${via}_`;
    if (h.trust === 'low') {
      // neutralise any attempt by the content to close the fence early
      const body = h.text.replace(/<\/?\s*untrusted-data/gi, (m) => m.replace('<', '&lt;'));
      return `${head}\n<untrusted-data source="${h.path.replace(/"/g, '&quot;')}">\n${body}\n</untrusted-data>`;
    }
    return `${head}\n\n${h.text}`;
  });
  return parts.join('\n\n---\n\n');
}
