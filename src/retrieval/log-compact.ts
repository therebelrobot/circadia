// Access-log compaction: roll events into per-node summaries for ACT-R learning.
//
// The access log (access.jsonl) is append-only and unbounded. For long-running vaults,
// we compact events into per-node summaries that preserve:
//   - count of accesses
//   - encoding time (first presentation)
//   - access times (recent ones kept for ACT-R base-level activation)
//
// Compaction is idempotent: running it multiple times produces the same result.
//
// Schema version: 1
//
// Example compacted record:
// {
//   "node": "orchard-sensors#0",
//   "count": 5,
//   "first": 1724512345678,  // encoding time (note created)
//   "last": 1726089234567,   // most recent access
//   "accesses": [1726000000000, 1726050000000, 1726089234567]  // recent accesses (up to 10)
// }

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type { AccessEvent } from './activation.ts';

/** Per-node access summary. */
export interface NodeAccessSummary {
  node: string;
  count: number;
  first: number;  // encoding or first access (ms epoch)
  last: number;   // most recent access (ms epoch)
  accesses: number[];  // recent access timestamps (up to 10)
}

export interface CompactResult {
  eventsProcessed: number;
  nodesSummarized: number;
  newEventsAdded: number;
}

/** Compact the access log into per-node summaries. */
export function compactAccessLog(events: AccessEvent[]): Map<string, NodeAccessSummary> {
  const summaries = new Map<string, NodeAccessSummary>();

  for (const e of events) {
    const existing = summaries.get(e.node);

    if (!existing) {
      // First event for this node
      summaries.set(e.node, {
        node: e.node,
        count: 1,
        first: e.t,
        last: e.t,
        accesses: [e.t],
      });
    } else {
      // Update existing summary
      existing.count++;
      existing.last = e.t;
      // Keep at most 10 most recent accesses (drop oldest when we exceed)
      existing.accesses.push(e.t);
      if (existing.accesses.length > 10) {
        existing.accesses.shift();  // remove oldest
      }
    }
  }

  return summaries;
}

/**
 * Load existing compacted summaries from a file. Returns empty map if file doesn't exist.
 */
export function loadSummaries(file: string): Map<string, NodeAccessSummary> {
  if (!existsSync(file)) return new Map();

  const summaries = new Map<string, NodeAccessSummary>();
  const text = readFileSync(file, 'utf8');

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as NodeAccessSummary;
      if (typeof s.node === 'string' && typeof s.count === 'number') {
        summaries.set(s.node, s);
      }
    } catch {
      // skip malformed line
    }
  }

  return summaries;
}

/**
 * Write compacted summaries to a file. Overwrites the file entirely.
 */
export function writeSummaries(file: string, summaries: Map<string, NodeAccessSummary>): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const lines = [...summaries.values()].map((s) => JSON.stringify(s));
  writeFileSync(file, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

/**
 * Incremental compact: add new events to existing summaries.
 * Returns the updated summaries and count of new events processed.
 */
export function incrementalCompact(
  existing: Map<string, NodeAccessSummary>,
  newEvents: AccessEvent[],
): { summaries: Map<string, NodeAccessSummary>; count: number } {
  for (const e of newEvents) {
    const existingSum = existing.get(e.node);

    if (!existingSum) {
      existing.set(e.node, {
        node: e.node,
        count: 1,
        first: e.t,
        last: e.t,
        accesses: [e.t],
      });
    } else {
      existingSum.count++;
      existingSum.last = e.t;
      existingSum.accesses.push(e.t);
      if (existingSum.accesses.length > 10) {
        existingSum.accesses.shift();
      }
    }
  }

  return { summaries: existing, count: newEvents.length };
}

/**
 * Convert summaries to presentation timestamps format (compatible with presentationsByNode).
 * Returns a Map from node id to array of presentation timestamps.
 */
export function summariesToPresentations(summaries: Map<string, NodeAccessSummary>): Map<string, number[]> {
  const m = new Map<string, number[]>();

  for (const [node, s] of summaries) {
    const presentations = [s.first, ...s.accesses];
    m.set(node, presentations);
  }

  return m;
}

/**
 * Load summaries from a file and use them for ACT-R base-level activation instead of raw log.
 */
export function loadSummariesForActivation(file: string): Map<string, number[]> {
  if (!existsSync(file)) return new Map();

  return summariesToPresentations(loadSummaries(file));
}
