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
import type { GraphMode, QueryMode, RecallHit, RecallResult, Trust } from '../types.ts';
import { getMeta, openIndex } from '../index/db.ts';
import { bm25Search, ftsSearch, type KeywordHit } from './keyword.ts';
import { MODE_ORIGINS } from './modes.ts';
import { personalizedPageRank } from './ppr.ts';
import { appendAccess, baseLevel, presentationsByNode, queryHash, readAccessLog, retrievalProbability } from './activation.ts';
import { loadGraph, TRUST_RANK, type GraphCache } from './graph-cache.ts';
import { topKByCosine } from './embeddings.ts';

export interface RecallOptions {
  mode?: QueryMode;
  /** epoch ms: answer as the vault stood / as the world was at this time */
  asOf?: number | null;
  topK?: number;
  tokenBudget?: number;
  logAccess?: boolean;
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
}

function runRung(
  db: DatabaseSync,
  cfg: Config,
  mode: GraphMode,
  seeds: Map<string, number>,
  asOf: number | null,
  now: number,
  presentations: Map<string, number[]>,
  topK: number,
  tokenBudget: number,
  graphCache?: GraphCache,
): RungResult {
  const g = graphCache?.getGraph(mode, asOf, cfg) ?? loadGraph(db, mode, asOf, cfg);

  const ppr = personalizedPageRank(g, seeds, {
    damping: cfg.graph.damping,
    maxIterations: cfg.graph.maxIterations,
    tolerance: cfg.graph.tolerance,
  });
  // seeds with no edges still count as candidates
  for (const [id, v] of seeds) if (!ppr.has(id)) ppr.set(id, v * (1 - cfg.graph.damping));

  const ranked = [...ppr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400);
  const ids = ranked.map(([id]) => id);
  if (ids.length === 0) return { hits: [], margin: 0 };

  const rows = db
    .prepare(
      `SELECT id, note_id, path, title, heading, text, importance, created, updated, trust
       FROM nodes WHERE kind = 'passage' AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as unknown as PassageRow[];

  const pprMax = Math.max(...rows.map((r) => ppr.get(r.id) ?? 0), 1e-12);
  const acts = rows.map((r) => {
    const pres = [...(presentations.get(r.id) ?? [])];
    const enc = r.created ?? r.updated;
    if (enc !== null && !pres.includes(enc)) pres.push(enc);
    return baseLevel(pres, now, cfg.retrieval.actrDecay);
  });
  const w = cfg.retrieval.weights;
  const rp = cfg.retrieval;

  const hits: RecallHit[] = rows
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

  const out: RecallHit[] = [];
  let budget = tokenBudget;
  for (const h of hits) {
    if (out.length >= topK) break;
    const cost = Math.ceil(h.text.length / 4);
    if (out.length > 0 && cost > budget) continue;
    out.push(h);
    budget -= cost;
  }
  const margin = out.length >= 2 && out[0].score > 0 ? (out[0].score - out[1].score) / out[0].score : out.length === 1 ? 1 : 0;
  return { hits: out, margin };
}

export function recall(vaultRoot: string, cfg: Config, query: string, opts: RecallOptions = {}): RecallResult {
  const now = opts.now ?? Date.now();
  const asOf = opts.asOf ?? null;
  const topK = opts.topK ?? cfg.retrieval.topK;
  const tokenBudget = opts.tokenBudget ?? cfg.retrieval.tokenBudget;
  const modeRequested = opts.mode ?? cfg.graph.query.mode;

  const { db } = openIndex(opts.dbPath ?? join(vaultRoot, cfg.index.path));
  try {
    if (getMeta(db, 'schema_version') === null) {
      throw new Error('index is empty — run `palimpsest index` first');
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
    const fused = rrf(lists);
    const seeds = new Map([...fused.entries()].map(([id, v]) => [id, v.score]));

    // ACT-R presentations: encoding time + logged accesses
    const accessFile = join(vaultRoot, cfg.index.accessLog);
    // as-of recall evaluates activation as it stood then: no future accesses, "now" = asOf
    const events = readAccessLog(accessFile).filter((e) => asOf === null || e.t <= asOf);
    const activationNow = asOf ?? now;
    const presentations = presentationsByNode(events, new Map());

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
    let result: RungResult = { hits: [], margin: 0 };
    for (let i = 0; i < ladder.length; i++) {
      modeUsed = ladder[i];
      result = runRung(db, cfg, modeUsed, seeds, asOf, activationNow, presentations, topK, tokenBudget, opts.graphCache);
      if (modeRequested !== 'auto' || i === ladder.length - 1) break;
      const a = cfg.graph.query.auto;
      const reasons: string[] = [];
      if (seeds.size < a.minSeeds) reasons.push(`only ${seeds.size} seed(s)`);
      if (result.hits.length === 0) reasons.push('no hits');
      else if (result.margin < a.minTopMargin) reasons.push(`top-score margin ${result.margin.toFixed(3)} < ${a.minTopMargin}`);
      if (reasons.length === 0) break;
      escalations.push({ from: modeUsed, to: ladder[i + 1], reason: reasons.join('; ') });
    }

    if (opts.logAccess ?? cfg.retrieval.logAccess) {
      const q = queryHash(query);
      appendAccess(
        accessFile,
        result.hits.map((h) => ({ t: now, node: h.passageId, kind: 'recall' as const, q })),
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
    const head = `### ${h.title}${h.heading && h.heading !== h.title ? ` › ${h.heading}` : ''}\n_source: ${h.path} · trust: ${h.trust}_`;
    if (h.trust === 'low') {
      // neutralise any attempt by the content to close the fence early
      const body = h.text.replace(/<\/?\s*untrusted-data/gi, (m) => m.replace('<', '&lt;'));
      return `${head}\n<untrusted-data source="${h.path.replace(/"/g, '&quot;')}">\n${body}\n</untrusted-data>`;
    }
    return `${head}\n\n${h.text}`;
  });
  return parts.join('\n\n---\n\n');
}
