// Pending / rejected queue records (C6, ADR-0007).
//
// One versioned JSON-line record type is shared by `consolidate` (writer) and `review`
// (reader/decider). The `key` is a stable content hash of (subject, predicate, object,
// src), so the same candidate is never queued twice and a rejected candidate never
// returns. The record is deliberately flat (no nested `candidate` object) so a reader
// cannot silently read `undefined` fields, which is what broke `review` (C9).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { STATE_DIR } from '../config.ts';
import type { SourceKind, Trust } from '../types.ts';
import { shortHash } from '../vault/util.ts';

/** Bump when the record shape changes; readers may branch on it. */
export const PENDING_RECORD_VERSION = 1;

export interface PendingRecord {
  /** record format version */
  v: typeof PENDING_RECORD_VERSION;
  /** stable candidate key: hash(subject, predicate, object, src) */
  key: string;
  subject: string;
  predicate: string;
  object: string;
  /** source episode id (or source note id for a triple candidate) */
  episode: string;
  by: SourceKind;
  trust: Trust;
  origin: 'episode' | 'triple';
  reason: string;
  /** system time: when the candidate was queued (epoch ms) */
  queuedAt: number;
}

/**
 * Stable identity for a candidate. Two runs that see the same
 * (subject, predicate, object, src) produce the same key, which is what makes
 * consolidation idempotent. `src` is the episode id (or source note id for a triple).
 */
export function candidateKey(parts: {
  subject: string;
  predicate: string;
  object: string;
  src: string;
}): string {
  return shortHash(parts.subject, parts.predicate, parts.object, parts.src);
}

export function pendingPath(vaultRoot: string): string {
  return join(vaultRoot, STATE_DIR, 'pending.jsonl');
}

export function rejectedPath(vaultRoot: string): string {
  return join(vaultRoot, STATE_DIR, 'rejected.jsonl');
}

/** Parse a JSONL file of records, ignoring blank and malformed lines. */
export function readRecords(path: string): PendingRecord[] {
  if (!existsSync(path)) return [];
  const out: PendingRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as PendingRecord;
      if (r && typeof r.key === 'string') out.push(r);
    } catch {
      // A malformed line is not one of our records; skip it rather than crash.
    }
  }
  return out;
}

/** The set of candidate keys already present in a JSONL file. */
export function readKeys(path: string): Set<string> {
  return new Set(readRecords(path).map((r) => r.key));
}

/** Serialize records to JSONL (one line each, trailing newline). */
export function serializeRecords(records: PendingRecord[]): string {
  if (records.length === 0) return '';
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Append records to a JSONL file, creating the state dir if needed. */
export function appendRecords(path: string, records: PendingRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRecords(records), { flag: 'a' });
}
