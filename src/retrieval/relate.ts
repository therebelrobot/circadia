// `palimpsest relate <a> <b>`: shortest paths between two notes over the
// edges a query mode allows, with the edge chain (type, origin, provenance,
// fact id) so a relationship can be traced back to its source.
//
// BFS in JS rather than a recursive CTE: SQLite forbids aggregates in the
// recursive SELECT, which makes carrying the edge chain awkward. At personal
// vault scale the edge table is small enough that a JS BFS is trivially fast.
// Edges below retrieval.trustFloor are excluded, consistent with recall.

import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { GraphMode, Trust } from '../types.ts';
import { normKey, slugify } from '../vault/util.ts';
import { MODE_ORIGINS } from './modes.ts';
import { TRUST_RANK } from './graph-cache.ts';

export interface RelateEdge {
  /** edge id in the edges table */
  id: number;
  src: string;
  dst: string;
  origin: string;
  type: string;
  provenance: string | null;
  fact_id: string | null;
}

export interface RelatePath {
  /** node chain from `from` to `to`, inclusive */
  nodes: string[];
  edges: RelateEdge[];
}

export interface RelateResult {
  from: string;
  to: string;
  found: boolean;
  paths: RelatePath[];
}

interface NameRow {
  name: string;
  node_id: string;
  tier: number;
}

/** Resolve a name (id, alias, or title) to a note id; null when unresolvable. */
export function resolveName(db: DatabaseSync, name: string): { id: string; ambiguous: boolean } | null {
  const rows = db.prepare('SELECT name, node_id, tier FROM names').all() as unknown as NameRow[];
  const k = normKey(name);
  const k2 = slugify(name);
  const matches = rows.filter((r) => normKey(r.name) === k || normKey(r.name) === k2);
  if (matches.length === 0) return null;
  const best = Math.min(...matches.map((m) => m.tier));
  const top = matches.filter((m) => m.tier === best);
  return { id: top[0].node_id, ambiguous: top.length > 1 };
}

/**
 * Shortest paths between two notes over the mode's allowed edge origins,
 * traversed undirected (both directions). Returns up to `maxPaths` shortest
 * paths, each with its node chain and edge chain.
 */
export function relate(
  db: DatabaseSync,
  from: string,
  to: string,
  cfg: Config,
  opts: { mode?: GraphMode; maxDepth?: number; maxPaths?: number } = {},
): RelateResult {
  const mode = opts.mode ?? 'typed';
  const maxDepth = opts.maxDepth ?? 5;
  const maxPaths = opts.maxPaths ?? 3;
  const a = resolveName(db, from);
  const b = resolveName(db, to);
  if (!a) throw new Error(`"${from}" does not resolve to a note (no matching id, alias, or title)`);
  if (!b) throw new Error(`"${to}" does not resolve to a note (no matching id, alias, or title)`);

  const origins = [...MODE_ORIGINS[mode]];
  const ph = origins.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, src, dst, origin, type, provenance, fact_id, trust FROM edges
       WHERE dst IS NOT NULL AND origin IN (${ph})`,
    )
    .all(...origins) as unknown as (RelateEdge & { trust: string | null })[];
  const floor = TRUST_RANK[cfg.retrieval.trustFloor];
  const edges = rows.filter((e) => !e.trust || TRUST_RANK[e.trust as Trust] >= floor);

  // undirected adjacency: node -> (neighbour, edge)
  const adj = new Map<string, { to: string; edge: RelateEdge }[]>();
  const link = (u: string, v: string, edge: RelateEdge): void => {
    const list = adj.get(u) ?? [];
    list.push({ to: v, edge });
    adj.set(u, list);
  };
  for (const e of edges) {
    const clean: RelateEdge = { id: e.id, src: e.src, dst: e.dst, origin: e.origin, type: e.type, provenance: e.provenance, fact_id: e.fact_id };
    link(e.src, e.dst, clean);
    link(e.dst, e.src, clean);
  }

  // BFS with parent tracking; keep every shortest parent so we can return
  // several distinct shortest paths, not just one.
  const depth = new Map<string, number>([[a.id, 0]]);
  const parents = new Map<string, { node: string; edge: RelateEdge }[]>();
  const queue: string[] = [a.id];
  let qi = 0;
  while (qi < queue.length) {
    const u = queue[qi++];
    const d = depth.get(u)!;
    if (d >= maxDepth) continue;
    for (const { to: v, edge } of adj.get(u) ?? []) {
      const dv = depth.get(v);
      if (dv === undefined) {
        depth.set(v, d + 1);
        const ps = parents.get(v);
        if (ps) ps.push({ node: u, edge });
        else parents.set(v, [{ node: u, edge }]);
        queue.push(v);
      } else if (dv === d + 1) {
        parents.get(v)!.push({ node: u, edge });
      }
    }
  }

  const paths: RelatePath[] = [];
  if (depth.has(b.id)) {
    // walk back from b to a, collecting up to maxPaths distinct chains
    const walk = (node: string, nodes: string[], edges: RelateEdge[]): void => {
      if (paths.length >= maxPaths) return;
      if (node === a.id) {
        // nodes was pushed from b back toward a; prepend a for the forward chain
        paths.push({ nodes: [a.id, ...[...nodes].reverse()], edges: [...edges].reverse() });
        return;
      }
      for (const p of parents.get(node) ?? []) {
        nodes.push(node);
        edges.push(p.edge);
        walk(p.node, nodes, edges);
        nodes.pop();
        edges.pop();
        if (paths.length >= maxPaths) return;
      }
    };
    walk(b.id, [], []);
  }
  return { from: a.id, to: b.id, found: paths.length > 0, paths };
}
