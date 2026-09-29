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

export function readAccessLog(file: string): AccessEvent[] {
  if (!existsSync(file)) return [];
  const out: AccessEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
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
