// Keyword seeds: SQLite FTS5 (bm25) when available, else a small in-process BM25.
// At personal-vault scale (~10^4 passages) the JS fallback is fast enough; it exists
// because some official Node builds of node:sqlite ship without FTS5.

import type { DatabaseSync } from 'node:sqlite';

export interface KeywordHit {
  passageId: string;
  score: number; // higher = better
}

const STOP = new Set(
  'a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who why will with'.split(' '),
);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

export function ftsSearch(db: DatabaseSync, query: string, limit: number): KeywordHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  const rows = db
    .prepare(
      `SELECT passage_id AS id, bm25(passages_fts, 0.0, 2.0, 1.5, 1.0) AS rank
       FROM passages_fts WHERE passages_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(match, limit) as { id: string; rank: number }[];
  // FTS5 bm25() is negative-is-better
  return rows.map((r) => ({ passageId: r.id, score: -r.rank }));
}

export class Bm25Index {
  private docs: { id: string; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  add(id: string, text: string): void {
    const toks = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.push({ id, tf, len: toks.length });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / this.docs.length;
  }

  search(query: string, limit: number): KeywordHit[] {
    const terms = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const out: KeywordHit[] = [];
    for (const d of this.docs) {
      let s = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgLen || 1)));
      }
      if (s > 0) out.push({ passageId: d.id, score: s });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function bm25Search(db: DatabaseSync, query: string, limit: number): KeywordHit[] {
  const idx = new Bm25Index();
  const rows = db.prepare(`SELECT id, title, heading, text FROM nodes WHERE kind = 'passage'`).all() as {
    id: string;
    title: string;
    heading: string | null;
    text: string;
  }[];
  for (const r of rows) idx.add(r.id, `${r.title} ${r.heading ?? ''} ${r.text}`);
  return idx.search(query, limit);
}
