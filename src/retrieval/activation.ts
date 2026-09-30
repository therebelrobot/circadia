// ACT-R base-level activation (Anderson & Schooler 1991): B = ln( Σ_j t_j^-d )
// t_j = seconds since the j-th presentation. Encoding (note creation) counts as the first
// presentation; every recall that returns the node counts as another. Memories are never
// deleted for low activation — they just stop winning ties (eviction without deletion).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface AccessEvent {
  /** epoch ms */
  t: number;
  /** passage or note id */
  node: string;
  kind: 'recall' | 'write' | 'confirm';
  /** sha256 prefix of the query; the query text itself is never logged */
  q?: string;
  /** consolidation session id (for reconsolidation window tracking) */
  session?: string;
}

function parseAccessLines(text: string): AccessEvent[] {
  const out: AccessEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AccessEvent;
      if (typeof e.t === 'number' && typeof e.node === 'string') out.push(e);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

export function readAccessLog(file: string): AccessEvent[] {
  return readAccessLogWithOffset(file).events;
}

/**
 * Read the whole access log plus the byte offset at its end. Compaction records that
 * offset in the summaries file so recall can read only the tail (the events appended
 * after compaction) instead of re-parsing the entire log on every query.
 */
export function readAccessLogWithOffset(file: string): { events: AccessEvent[]; offset: number } {
  if (!existsSync(file)) return { events: [], offset: 0 };
  const buf = readFileSync(file);
  return { events: parseAccessLines(buf.toString('utf8')), offset: buf.length };
}

/**
 * Read only the events appended after `offset` bytes. `offset` is the file size recorded
 * at compaction, which is always a line boundary (appendAccess always terminates a line
 * with `\n`), so no partial line is parsed. A defensive check skips a partial line if the
 * offset ever lands mid-line.
 */
export function readAccessLogFrom(file: string, offset: number): AccessEvent[] {
  if (!existsSync(file)) return [];
  if (offset <= 0) return readAccessLog(file);
  const buf = readFileSync(file);
  if (offset >= buf.length) return [];
  let start = offset;
  if (buf[start - 1] !== 0x0a) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) return [];
    start = nl + 1;
  }
  return parseAccessLines(buf.subarray(start).toString('utf8'));
}

export function appendAccess(file: string, events: AccessEvent[]): void {
  if (events.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

export function queryHash(q: string): string {
  return createHash('sha256').update(q).digest('hex').slice(0, 12);
}

export function baseLevel(presentations: number[], now: number, decay: number): number {
  let sum = 0;
  for (const t of presentations) {
    const secs = Math.max(1, (now - t) / 1000);
    sum += Math.pow(secs, -decay);
  }
  return sum > 0 ? Math.log(sum) : -Infinity;
}

/**
 * ACT-R optimized-learning approximation (Anderson & Schooler 1991; Anderson, Bothell,
 * Lebiere & Matessa 1998). For a run of `n` presentations whose first occurred `L`
 * seconds before `now`, the exact sum Σ_j t_j^(-d) is approximated by
 *   n / (1 - d) · L^(-d)
 * which is exact for evenly spaced presentations and close otherwise (error is O(1/n)).
 * This is what lets a compacted summary stand in for the raw events it replaced, without
 * keeping every timestamp.
 */
export function optimizedLearningSum(n: number, firstT: number, now: number, decay: number): number {
  if (n <= 0) return 0;
  const L = Math.max(1, (now - firstT) / 1000);
  // d = 0.5 is canonical; guard the denominator so a misconfigured d >= 1 can't produce NaN.
  const denom = Math.max(1e-6, 1 - decay);
  return (n / denom) * Math.pow(L, -decay);
}

/**
 * Base-level activation from a compacted run plus exact recent presentations:
 *   B = ln( optimizedLearningSum(compacted) + Σ_recent t^(-d) ).
 * The compacted part uses the optimized-learning form (frequency via `count`); the recent
 * part keeps exact terms, so accesses logged after the summary's watermark still learn.
 */
export function baseLevelFromParts(
  compacted: { count: number; first: number } | null,
  recent: number[],
  now: number,
  decay: number,
): number {
  let sum = 0;
  if (compacted && compacted.count > 0) {
    sum += optimizedLearningSum(compacted.count, compacted.first, now, decay);
  }
  for (const t of recent) {
    const secs = Math.max(1, (now - t) / 1000);
    sum += Math.pow(secs, -decay);
  }
  return sum > 0 ? Math.log(sum) : -Infinity;
}

/** Map node -> presentation timestamps (encoding + accesses). */
export function presentationsByNode(
  events: AccessEvent[],
  encoded: Map<string, number | null>,
): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const [id, t] of encoded) if (t !== null) m.set(id, [t]);
  for (const e of events) {
    const list = m.get(e.node) ?? [];
    list.push(e.t);
    m.set(e.node, list);
  }
  return m;
}

/**
 * ACT-R retrieval probability: P = 1 / (1 + e^(-(B - tau) / s)), with tau set so that a
 * memory presented once `thresholdDays` ago sits at P = 0.5. Unlike min-max scaling this
 * doesn't exaggerate tiny age differences between candidates.
 */
export function retrievalProbability(B: number, decay: number, thresholdDays: number, noise: number): number {
  if (!Number.isFinite(B)) return 0;
  const tau = -decay * Math.log(Math.max(1, thresholdDays * 86_400));
  return 1 / (1 + Math.exp(-(B - tau) / noise));
}
