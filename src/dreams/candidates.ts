// Dream candidate queue: `.circadia/dreams/candidates.jsonl` (RFC-0001 "Data model and
// state").
//
// A candidate is a kept association between a recent note (`a`) and a remote note (`b`).
// It is non-derivable but DISPOSABLE (ADR-0011): losing it loses nothing the user asked to
// keep, and it is never committed to git. Full state transitions (endorse / dismiss /
// accept / reject) are Stage 3; this module owns the record shape, append, and lazy expiry.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { localDateString } from '../vault/time.ts';

export const DREAM_CANDIDATE_VERSION = 1;

export type DreamCandidateState = 'open' | 'endorsed' | 'accepted' | 'rejected' | 'dismissed' | 'expired';

export interface DreamCandidate {
  /** record format version */
  v: typeof DREAM_CANDIDATE_VERSION;
  /** `d-<night>-<hash(a, b)>`; stable, so a re-run skips an id already present */
  id: string;
  /** recent side */
  a: string;
  /** remote side */
  b: string;
  gist: string;
  /** passage ids the quotes were grounded in; the quote text lives only in the log */
  quotes: { a: string; b: string };
  hops: number;
  salience: number;
  model: string;
  /** local date of the night, YYYY-MM-DD */
  night: string;
  /** local date after which the candidate is expired, YYYY-MM-DD */
  expires: string;
  state: DreamCandidateState;
}

export function dreamsDir(vaultRoot: string): string {
  return join(vaultRoot, STATE_DIR, 'dreams');
}

export function candidatesPath(vaultRoot: string): string {
  return join(dreamsDir(vaultRoot), 'candidates.jsonl');
}

/** Add `n` days to a `YYYY-MM-DD` local date string. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** A candidate is expired when its `expires` date is strictly before `today`. */
export function isExpired(c: DreamCandidate, today: string): boolean {
  return (c.state === 'open' || c.state === 'endorsed') && today > c.expires;
}

/** Parse a JSONL file, ignoring blank and malformed lines. */
function parseLines(text: string): DreamCandidate[] {
  const out: DreamCandidate[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as DreamCandidate;
      if (c && typeof c.id === 'string' && typeof c.a === 'string' && typeof c.b === 'string') out.push(c);
    } catch {
      // A malformed line is not one of our records; skip it rather than crash.
    }
  }
  return out;
}

/**
 * Read the candidate queue. Expiry is evaluated on read: an open/endorsed candidate whose
 * `expires` date has passed is returned with `state: 'expired'` (set lazily — the file is
 * not rewritten by a read).
 */
export function readCandidates(vaultRoot: string, today: string = localDateString()): DreamCandidate[] {
  const path = candidatesPath(vaultRoot);
  if (!existsSync(path)) return [];
  return parseLines(readFileSync(path, 'utf8')).map((c) => (isExpired(c, today) ? { ...c, state: 'expired' } : c));
}

/** Every candidate id present, regardless of state. Used to make a re-run idempotent. */
export function readCandidateIds(vaultRoot: string): Set<string> {
  const path = candidatesPath(vaultRoot);
  if (!existsSync(path)) return new Set();
  return new Set(parseLines(readFileSync(path, 'utf8')).map((c) => c.id));
}

/**
 * Pairs already connected by an open or dismissed candidate, as a normalized
 * `min\0max` key. A dismissed pair is not proposed again (RFC-0001 step 2).
 *
 * Candidates from `night` itself are excluded: a re-run of a night must sample the same
 * pairs (the seed is the night's date), and the candidate ids make the re-run idempotent.
 * Only pairs from *other* nights are blocked.
 */
export function readBlockedPairs(vaultRoot: string, night: string, today: string = localDateString()): Set<string> {
  const out = new Set<string>();
  for (const c of readCandidates(vaultRoot, today)) {
    if (c.night === night) continue;
    if (c.state === 'open' || c.state === 'dismissed') out.add(pairKey(c.a, c.b));
  }
  return out;
}

/** Order-independent pair key, so (a, b) and (b, a) are the same pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Append candidates to the queue. Expiry is evaluated on write: existing open/endorsed
 * candidates past their `expires` date are persisted as `expired` before the new lines are
 * added. The file is rewritten (not appended) so the lazy expiry is durable.
 */
export function appendCandidates(vaultRoot: string, records: DreamCandidate[], today: string = localDateString()): void {
  if (records.length === 0) return;
  const path = candidatesPath(vaultRoot);
  const existing = existsSync(path)
    ? parseLines(readFileSync(path, 'utf8')).map((c) => (isExpired(c, today) ? { ...c, state: 'expired' } : c))
    : [];
  const all = [...existing, ...records];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, all.map((c) => JSON.stringify(c)).join('\n') + '\n');
}
