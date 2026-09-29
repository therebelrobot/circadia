// Per-mode graph cache for long-running processes (MCP server, Phase 3).
// The graph is built lazily on first access and cached per (mode, asOf).
// Invalidation: the index's built_at meta is re-stamped by both buildIndex
// and incrementalIndex, so the cache key includes it. When the index
// changes, the key changes, and the graph is rebuilt on next access.
// This is the simpler correct approach vs. requiring callers to remember
// to call invalidate() after every reindex.

import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { EdgeOrigin, GraphMode, Trust } from '../types.ts';
import { getMeta } from '../index/db.ts';
import { MODE_ORIGINS } from './modes.ts';
import { addEdge, makeGraph, type Graph } from './ppr.ts';

export const TRUST_RANK: Record<Trust, number> = { low: 0, medium: 1, high: 2 };

export interface EdgeRow {
  src: string;
  dst: string;
  origin: EdgeOrigin;
  weight: number;
  valid_from: number | null;
  valid_to: number | null;
  recorded_at: number | null;
  expired_at: number | null;
  trust: string | null;
  /** creation time of the note that declares the edge */
  declared_created: number | null;
}

export function edgeAllowed(e: EdgeRow, asOf: number | null, cfg: Config): boolean {
  if (e.trust && TRUST_RANK[e.trust as Trust] < TRUST_RANK[cfg.retrieval.trustFloor]) return false;
  if (asOf === null) {
    // "now": drop superseded beliefs unless asked for; keep ended-but-true history
    return cfg.retrieval.includeSuperseded || e.expired_at === null;
  }
  // system time: what was recorded and not yet superseded at asOf.
  // Edges declared by notes that didn't exist yet are invisible (prose links carry no
  // time of their own, so note creation is the best available system time for them).
  if (e.declared_created !== null && e.declared_created > asOf) return false;
  if (e.recorded_at !== null && e.recorded_at > asOf) return false;
  if (e.expired_at !== null && e.expired_at <= asOf && !cfg.retrieval.includeSuperseded) return false;
  // world time: what was true at asOf
  if (e.valid_from !== null && e.valid_from > asOf) return false;
  if (e.valid_to !== null && e.valid_to <= asOf) return false;
  return true;
}

/**
 * Load and filter edges for a mode, building the undirected Graph.
 * Shared by recall's runRung and the graph cache.
 */
export function loadGraph(db: DatabaseSync, mode: GraphMode, asOf: number | null, cfg: Config): Graph {
  const origins = MODE_ORIGINS[mode];
  const placeholders = origins.map(() => '?').join(',');
  const edges = db
    .prepare(
      `SELECT e.src, e.dst, e.origin, e.weight, e.valid_from, e.valid_to, e.recorded_at, e.expired_at, e.trust,
              n.created AS declared_created
       FROM edges e LEFT JOIN nodes n ON n.id = e.declared_in
       WHERE e.dst IS NOT NULL AND e.origin IN (${placeholders})`,
    )
    .all(...origins) as unknown as EdgeRow[];

  const g = makeGraph();
  for (const e of edges) {
    if (!edgeAllowed(e, asOf, cfg)) continue;
    addEdge(g, e.src, e.dst, (cfg.graph.originWeights[e.origin] ?? 1) * e.weight);
  }
  return g;
}

export interface GraphCache {
  getGraph(mode: GraphMode, asOf: number | null, cfg: Config): Graph;
  invalidate(): void;
}

/**
 * Create a graph cache keyed on (mode, asOf, built_at).
 * The built_at meta is re-stamped by both buildIndex and incrementalIndex,
 * so the cache automatically rebuilds when the index changes.
 */
export function createGraphCache(db: DatabaseSync): GraphCache {
  const cache = new Map<string, { builtAt: string; graph: Graph }>();

  return {
    getGraph(mode, asOf, cfg) {
      const builtAt = getMeta(db, 'built_at') ?? '';
      const key = `${mode}:${asOf ?? 'now'}`;
      const entry = cache.get(key);
      if (entry && entry.builtAt === builtAt) return entry.graph;
      const graph = loadGraph(db, mode, asOf, cfg);
      cache.set(key, { builtAt, graph });
      return graph;
    },
    invalidate() {
      cache.clear();
    },
  };
}
