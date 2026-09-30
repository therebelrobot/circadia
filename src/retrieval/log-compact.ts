// Access-log compaction: roll events into per-node summaries for ACT-R learning.
//
// The access log (access.jsonl) is append-only and unbounded. For long-running vaults,
// we compact events into per-node summaries that preserve:
//   - count of accesses
//   - the first presentation the summary accounts for
//   - the watermark: the timestamp up to which the summary accounts for events
//
// Recall combines a node's summary with the raw events that post-date the watermark, so
// learning continues after compaction (C14). The summary is a *derived cache*: the raw log
// is never rotated or deleted (ADR-0009), because it is the only non-derivable record of
// usage and as-of queries dated before the watermark need it.
//
// Schema version: 2
//
// File format (JSONL):
//   {"kind":"meta","version":2,"watermark":1726089234567}
//   {"node":"orchard-sensors#0","count":5,"first":1724512345678,"last":1726089234567,"accesses":[...]}
//
// `first` is the earliest presentation the summary accounts for; `accesses` keeps the most
// recent timestamps for observability. Activation uses `count` + `first` via ACT-R's
// optimized-learning approximation (see activation.ts), not the `accesses` array.

import { dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { AccessEvent } from './activation.ts';

/** Per-node access summary. */
export interface NodeAccessSummary {
  node: string;
  count: number;
  first: number;  // earliest presentation the summary accounts for (ms epoch)
  last: number;   // most recent access (ms epoch)
  accesses: number[];  // recent access timestamps (up to 10), for observability
}

/** A summaries file: the watermark plus per-node summaries. */
export interface AccessSummaries {
  /** epoch ms: the summary accounts for every event with t <= watermark */
  watermark: number;
  nodes: Map<string, NodeAccessSummary>;
}

/** ACT-R presentation inputs for one node: a compacted run plus exact recent timestamps. */
export interface NodePresentations {
  /** compacted run (count + first presentation), or null when no summary covers this node */
  compacted: { count: number; first: number } | null;
  /** exact presentation timestamps not covered by the summary (post-watermark, <= asOf) */
  recent: number[];
}

const SUMMARY_VERSION = 2;

/** Compact the access log into per-node summaries. */
export function compactAccessLog(events: AccessEvent[]): AccessSummaries {
  const nodes = new Map<string, NodeAccessSummary>();
  let watermark = 0;

  for (const e of events) {
    if (e.t > watermark) watermark = e.t;
    const existing = nodes.get(e.node);

    if (!existing) {
      // First event for this node
      nodes.set(e.node, {
        node: e.node,
        count: 1,
        first: e.t,
        last: e.t,
        accesses: [e.t],
      });
    } else {
      // Update existing summary. `first`/`last` are min/max rather than positional, so a
      // log that is not strictly chronological still yields a correct optimized-learning
      // anchor (the raw log is append-only, but this costs nothing and removes the
      // assumption).
      existing.count++;
      if (e.t < existing.first) existing.first = e.t;
      if (e.t > existing.last) existing.last = e.t;
      // Keep at most 10 most recent accesses (drop oldest when we exceed)
      existing.accesses.push(e.t);
      if (existing.accesses.length > 10) {
        existing.accesses.shift();  // remove oldest
      }
    }
  }

  return { watermark, nodes };
}

/** Load a summaries file. Returns an empty summary (watermark 0) if the file is missing. */
export function loadAccessSummaries(file: string): AccessSummaries {
  const out: AccessSummaries = { watermark: 0, nodes: new Map() };
  if (!existsSync(file)) return out;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.kind === 'meta' && typeof rec.watermark === 'number') {
        out.watermark = rec.watermark;
      } else if (typeof rec.node === 'string' && typeof rec.count === 'number') {
        out.nodes.set(rec.node, rec as unknown as NodeAccessSummary);
      }
    } catch {
      // skip malformed line
    }
  }

  return out;
}

/** Write a summaries file. Overwrites the file entirely. */
export function writeAccessSummaries(file: string, summaries: AccessSummaries): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = [JSON.stringify({ kind: 'meta', version: SUMMARY_VERSION, watermark: summaries.watermark })];
  for (const s of summaries.nodes.values()) lines.push(JSON.stringify(s));
  writeFileSync(file, lines.join('\n') + '\n');
}

/**
 * Build ACT-R presentation inputs for every node from compacted summaries plus the raw
 * events that post-date the summary's watermark. Both are filtered to <= asOf.
 *
 * as-of correctness (ARCHITECTURE §8): a summary aggregates every event up to its
 * watermark, so it cannot answer a query dated before that watermark. When asOf <
 * watermark we ignore the summary and fall back to the raw log, which is never rotated
 * (ADR-0009) — so the events are still there.
 */
export function presentationsForActivation(
  summaries: AccessSummaries,
  events: AccessEvent[],
  asOf: number | null,
): Map<string, NodePresentations> {
  const out = new Map<string, NodePresentations>();
  const useSummary = asOf === null || asOf >= summaries.watermark;

  if (useSummary) {
    for (const [node, s] of summaries.nodes) {
      out.set(node, { compacted: { count: s.count, first: s.first }, recent: [] });
    }
  }

  for (const e of events) {
    if (asOf !== null && e.t > asOf) continue;
    if (useSummary && e.t <= summaries.watermark) continue;  // already in the summary
    const p = out.get(e.node) ?? { compacted: null, recent: [] };
    p.recent.push(e.t);
    out.set(e.node, p);
  }

  return out;
}
