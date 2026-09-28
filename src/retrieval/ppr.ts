// Personalized PageRank by power iteration — the spreading-activation step
// (Collins & Loftus 1975; HippoRAG / HippoRAG 2 use PPR for exactly this).

export interface Graph {
  /** node id -> index */
  index: Map<string, number>;
  ids: string[];
  /** adjacency: for node i, neighbours and edge weights (undirected: both directions stored) */
  nbr: number[][];
  w: number[][];
}

export function makeGraph(): Graph {
  return { index: new Map(), ids: [], nbr: [], w: [] };
}

export function nodeIndex(g: Graph, id: string): number {
  let i = g.index.get(id);
  if (i === undefined) {
    i = g.ids.length;
    g.index.set(id, i);
    g.ids.push(id);
    g.nbr.push([]);
    g.w.push([]);
  }
  return i;
}

/** Undirected weighted edge. Activation spreads both ways along every association. */
export function addEdge(g: Graph, a: string, b: string, weight: number): void {
  if (a === b || !(weight > 0)) return;
  const i = nodeIndex(g, a);
  const j = nodeIndex(g, b);
  g.nbr[i].push(j);
  g.w[i].push(weight);
  g.nbr[j].push(i);
  g.w[j].push(weight);
}

/**
 * p = (1 - d) * s + d * W^T p, where s is the normalised seed (personalization) vector
 * and d is the damping factor. Dangling mass returns to the seeds.
 */
export function personalizedPageRank(
  g: Graph,
  seeds: Map<string, number>,
  opts: { damping: number; maxIterations: number; tolerance: number },
): Map<string, number> {
  const n = g.ids.length;
  const s = new Float64Array(n);
  let total = 0;
  for (const [id, v] of seeds) {
    const i = g.index.get(id);
    if (i !== undefined && v > 0) {
      s[i] += v;
      total += v;
    }
  }
  const out = new Map<string, number>();
  if (total === 0) return out;
  for (let i = 0; i < n; i++) s[i] /= total;

  const deg = new Float64Array(n);
  for (let i = 0; i < n; i++) for (const x of g.w[i]) deg[i] += x;

  let p = Float64Array.from(s);
  const d = opts.damping;
  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (p[i] === 0) continue;
      if (deg[i] === 0) {
        dangling += p[i];
        continue;
      }
      const share = p[i] / deg[i];
      const nb = g.nbr[i];
      const ws = g.w[i];
      for (let k = 0; k < nb.length; k++) next[nb[k]] += d * share * ws[k];
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i] += (1 - d) * s[i] + d * dangling * s[i];
      delta += Math.abs(next[i] - p[i]);
    }
    p = next;
    if (delta < opts.tolerance) break;
  }
  for (let i = 0; i < n; i++) if (p[i] > 0) out.set(g.ids[i], p[i]);
  return out;
}
