// Interactive CLI for reviewing pending consolidation candidates.
// Prompts the user to accept/reject/edit queued candidates from <STATE_DIR>/pending.jsonl.
//
// C6: reads the versioned PendingRecord format (ADR-0007) and writes a rejected
// candidate to <STATE_DIR>/rejected.jsonl so it does not come back on the next run.
// C9: accept writes the fact through the shared writer (src/vault/fact-write.ts) with
//     by:: user and src:: [[<episode>]], superseding a contradicting single-valued fact
//     via src/consolidation/supersede.ts. Unknown input re-prompts instead of dropping
//     the candidate. The decision logic is a pure function so it is testable without a TTY.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CONFIG_FILENAME, loadConfig, type Config } from '../config.ts';
import { parseVault, buildResolver } from '../index/indexer.ts';
import { appendFactLine, writeFactToNote, type WritableFact } from '../vault/fact-write.ts';
import { applySupersede } from '../consolidation/supersede.ts';
import { isSingleValued } from '../consolidation/schema.ts';
import { asWikiLink, shortHash } from '../vault/util.ts';
import { DEFAULT_TRUST } from '../vault/facts.ts';
import { localDateString, systemDateNow } from '../vault/time.ts';
import { fenceData } from '../llm/chat.ts';
import { readCandidates, transitionCandidate, type DreamCandidate } from '../dreams/candidates.ts';
import type { Fact } from '../types.ts';
import {
  appendRecords,
  pendingPath,
  prioritizeForReview,
  rejectedPath,
  readRecords,
  serializeRecords,
  type PendingRecord,
} from '../consolidation/pending.ts';

/** The three decisions a reviewer can make, plus the re-prompt signal. */
export type ReviewAction = 'accept' | 'reject' | 'edit' | 'reprompt';

/** Normalize a raw answer to a decision. Anything unrecognized re-prompts. */
export function normalizeReviewChoice(raw: string): ReviewAction {
  const c = raw.trim().toLowerCase();
  if (c === 'a' || c === 'accept') return 'accept';
  if (c === 'r' || c === 'reject') return 'reject';
  if (c === 'e' || c === 'edit') return 'edit';
  return 'reprompt';
}

/** New values for an edited candidate; an omitted or empty field keeps the record's value. */
export interface ReviewEdit {
  subject?: string;
  predicate?: string;
  object?: string;
}

export interface ReviewDecision {
  /** what happened */
  action: 'accepted' | 'rejected' | 'edited' | 'reprompt' | 'error';
  /** the record to keep in the queue; null when it leaves the queue */
  keep: PendingRecord | null;
  /** human-readable detail for the CLI */
  message: string;
}

/**
 * Apply one review decision to one pending record.
 *
 * This is the whole decision, with no readline: the CLI loop only collects the raw
 * answer (and, for an edit, the new values) and calls this. It performs the side effects
 * (writing a fact, appending to rejected.jsonl) and returns the record to keep, if any.
 *
 * Semantics of the fact written on accept:
 * - `by:: user` — a human confirmed it, so it is a user assertion, not an agent one.
 * - `src:: [[<episode>]]` — provenance is recorded even though `by:: user` does not
 *   require it, so the claim stays traceable to the episode it came from.
 * - `at::` is system time (when the reviewer accepted it); `valid.from` is world time
 *   (the source episode's `created`, falling back to now).
 * - `trust` is the default for `by:: user` (high).
 */
export function applyReviewDecision(
  record: PendingRecord,
  choice: string,
  vault: string,
  cfg: Config,
  edit?: ReviewEdit,
): ReviewDecision {
  const action = normalizeReviewChoice(choice);

  if (action === 'reprompt') {
    return {
      action: 'reprompt',
      keep: record,
      message: `unrecognized answer "${choice.trim()}"; enter a, r, or e`,
    };
  }

  if (action === 'reject') {
    // C6: the record already carries the stable key, so a rejected candidate does not
    // come back on the next consolidation run.
    appendRecords(rejectedPath(vault), [record]);
    return { action: 'rejected', keep: null, message: 'rejected' };
  }

  if (action === 'edit') {
    const next: PendingRecord = {
      ...record,
      subject: edit?.subject?.trim() || record.subject,
      predicate: edit?.predicate?.trim() || record.predicate,
      object: edit?.object?.trim() || record.object,
    };
    return { action: 'edited', keep: next, message: 'edited; still queued' };
  }

  // accept
  const notes = parseVault(vault, cfg);
  const { resolver } = buildResolver(notes);
  const subjectRef = resolver.resolve(record.subject);
  const subjectNote = subjectRef ? notes.find((n) => n.id === subjectRef.id) : undefined;
  if (!subjectNote) {
    // Never drop silently: keep the candidate and tell the reviewer why.
    return {
      action: 'error',
      keep: record,
      message: `subject "${record.subject}" does not resolve to a note; left in the queue`,
    };
  }

  const objLink = asWikiLink(record.object);
  const objectRef = objLink ? resolver.resolve(objLink.target) : null;

  // System time for `at::`/`superseded::` is the LOCAL calendar date (systemDateNow), so
  // an evening accept in a negative-offset timezone does not stamp tomorrow's UTC date.
  const now = systemDateNow();
  const episodeNote = notes.find((n) => n.id === record.episode);
  const validFrom = episodeNote?.created ?? now;

  const newFact = buildUserFact(record, subjectNote.id, objectRef?.id ?? null, now, validFrom);

  const abs = join(vault, subjectNote.path);
  const content = readFileSync(abs, 'utf8');

  let updated = content;
  let superseded = false;
  if (isSingleValued(cfg, record.predicate)) {
    // A single-valued predicate with a different object is a contradiction: strike the
    // old fact and move it to ## History rather than accumulating a second value.
    const r = applySupersede(content, {
      path: subjectNote.path,
      supersededAt: now,
      validAt: validFrom,
      newFact,
    });
    if (r.changed) {
      updated = r.content;
      superseded = true;
    }
  }
  if (!superseded) {
    updated = appendFactLine(content, newFact, { factsHeading: cfg.vault.factsHeading });
  }
  if (updated !== content) writeFileSync(abs, updated, 'utf8');

  return {
    action: 'accepted',
    keep: null,
    message: superseded ? 'accepted; superseded the previous fact' : 'accepted',
  };
}

/**
 * Build the fact an accepted candidate becomes. Mirrors consolidate's `buildFact`, but
 * the reviewer is the source: `by:: user`, `trust` = the user default, and the episode
 * is still cited as `src::` for provenance.
 */
function buildUserFact(
  record: PendingRecord,
  subjectId: string,
  objectId: string | null,
  recordedAt: number,
  validFrom: number,
): WritableFact {
  const object: Fact['object'] = objectId
    ? { kind: 'link', link: { target: objectId } }
    : { kind: 'literal', value: asWikiLink(record.object)?.target ?? record.object };
  const objectKey = object.kind === 'link' ? `[[${object.link.target}]]` : object.value;
  return {
    id: `f-${shortHash(subjectId, record.predicate, objectKey, validFrom)}`,
    predicate: record.predicate,
    object,
    valid: { from: validFrom, to: null },
    recordedAt,
    supersededAt: null,
    by: 'user',
    trust: DEFAULT_TRUST.user,
    conf: 1,
    src: { target: record.episode },
    status: 'current',
    comment: null,
  };
}

/** Counts returned by `review()`. */
export interface ReviewSummary {
  promoted: number;
  rejected: number;
  edited: number;
  dreamAccepted: number;
  dreamRejected: number;
}

/** The decision a reviewer can make on a dream candidate, plus the re-prompt signal. */
export type DreamReviewAction = 'accepted' | 'rejected' | 'reprompt' | 'error';

export interface DreamReviewDecision {
  action: DreamReviewAction;
  message: string;
}

/** passage id -> passage text, so review can show the passages a candidate's quotes cite. */
function passageTextMap(vault: string, cfg: Config): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of parseVault(vault, cfg)) {
    for (const p of n.passages) out.set(p.id, p.text);
  }
  return out;
}

/** One-line preview of a passage for the review prompt. */
function preview(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Apply one review decision to one dream candidate.
 *
 * Accept writes `[related_to:: [[b]]] [by:: user]` to note `a` (a = recent side, b = remote
 * side) through the shared fact writer, exactly like an accepted fact today, then marks the
 * candidate `accepted`. Reject marks it `rejected`, so the pair is not proposed again.
 * Unknown input re-prompts. `related_to` must be in `predicates.defs`; the caller offers to
 * add it before calling this.
 */
export function applyDreamDecision(
  candidate: DreamCandidate,
  choice: string,
  vault: string,
  cfg: Config,
  today: string = localDateString(),
): DreamReviewDecision {
  const c = choice.trim().toLowerCase();

  if (c === 'r' || c === 'reject') {
    const r = transitionCandidate(vault, candidate.id, 'reject', { today });
    return r.ok ? { action: 'rejected', message: 'rejected' } : { action: 'error', message: r.message };
  }
  if (c !== 'a' && c !== 'accept') {
    return { action: 'reprompt', message: `unrecognized answer "${choice.trim()}"; enter a or r` };
  }

  if (!cfg.predicates.defs || !('related_to' in cfg.predicates.defs)) {
    return {
      action: 'error',
      message: 'related_to is not in predicates.defs; add it to circadia.config.json to accept',
    };
  }

  const notes = parseVault(vault, cfg);
  const noteA = notes.find((n) => n.id === candidate.a);
  const noteB = notes.find((n) => n.id === candidate.b);
  if (!noteA) return { action: 'error', message: `note "${candidate.a}" does not resolve; left open` };
  if (!noteB) return { action: 'error', message: `note "${candidate.b}" does not resolve; left open` };

  // Don't write a duplicate: if note a already has a current `related_to:: [[b]]`, accept
  // just marks the candidate accepted. The exact-line guard in `appendFactLine` is not
  // enough, because the line carries `at::` and a block id that differ per day.
  const already = noteA.facts.some(
    (f) =>
      f.predicate === 'related_to' &&
      f.status === 'current' &&
      f.object.kind === 'link' &&
      f.object.link.target === candidate.b,
  );

  let changed = false;
  if (!already) {
    // System time for `at::` is the LOCAL calendar date, so an evening accept does not
    // stamp tomorrow's UTC date (same rule as an accepted fact).
    const now = systemDateNow();
    const fact: WritableFact = {
      id: `f-${shortHash(candidate.a, 'related_to', `[[${candidate.b}]]`, now)}`,
      predicate: 'related_to',
      object: { kind: 'link', link: { target: candidate.b } },
      valid: { from: now, to: null },
      recordedAt: now,
      supersededAt: null,
      by: 'user',
      trust: DEFAULT_TRUST.user,
      conf: 1,
      src: null,
      status: 'current',
      comment: null,
    };
    changed = writeFactToNote(vault, noteA.path, fact, { factsHeading: cfg.vault.factsHeading });
  }

  const r = transitionCandidate(vault, candidate.id, 'accept', { today });
  if (!r.ok) return { action: 'error', message: r.message };
  return {
    action: 'accepted',
    message: already ? 'accepted; related_to fact already present' : changed ? 'accepted; wrote related_to fact' : 'accepted; fact already present',
  };
}

/**
 * Offer to add `related_to` to `predicates.defs` when a vault lacks it (RFC-0001
 * "Confirmation"). Returns true when it is present or was added.
 */
async function ensureRelatedTo(vault: string, question: (prompt: string) => Promise<string>): Promise<boolean> {
  console.log('related_to is not in predicates.defs; accepting a dream writes a related_to fact.');
  const answer = (await question('  add related_to to circadia.config.json? (y/n) ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return false;
  const path = join(vault, CONFIG_FILENAME);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const predicates = (raw.predicates as Record<string, unknown>) ?? {};
  const defs = (predicates.defs as Record<string, unknown>) ?? {};
  defs.related_to = { object: 'entity', description: 'generic association; prefer a specific predicate' };
  predicates.defs = defs;
  raw.predicates = predicates;
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  console.log('  added related_to to predicates.defs');
  return true;
}

/**
 * Interactive review loop for pending candidates and dream candidates.
 * Returns the counts of each decision.
 */
export async function review(vault: string): Promise<ReviewSummary> {
  let cfg = loadConfig(vault);
  const pending = pendingPath(vault);
  // C18: reconsolidation-priority records are reviewed first. The sort is stable, so the
  // on-disk order is preserved within each group.
  const records = prioritizeForReview(readRecords(pending));

  // RFC-0001 "Confirmation": open and endorsed dream candidates, endorsed first.
  const dreamCandidates = readCandidates(vault)
    .filter((c) => c.state === 'open' || c.state === 'endorsed')
    .sort((a, b) => {
      const ea = a.state === 'endorsed' ? 0 : 1;
      const eb = b.state === 'endorsed' ? 0 : 1;
      return ea - eb || b.salience - a.salience || a.id.localeCompare(b.id);
    });

  if (records.length === 0 && dreamCandidates.length === 0) {
    console.log('No pending candidates to review.');
    if (existsSync(pending)) unlinkSync(pending);
    return { promoted: 0, rejected: 0, edited: 0, dreamAccepted: 0, dreamRejected: 0 };
  }

  const kept: PendingRecord[] = [];
  let promoted = 0;
  let rejected = 0;
  let edited = 0;
  let dreamAccepted = 0;
  let dreamRejected = 0;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Buffer lines that arrive before the next prompt is listening, so scripted input
  // (`printf 'a\nr\n' | circadia review`) is not dropped. readline emits every buffered
  // line in one tick; without a queue the later ones have no listener and are lost.
  const EOF = '\u0000eof';
  const buffered: string[] = [];
  let waiting: ((line: string) => void) | null = null;
  let closed = false;

  rl.on('line', (line) => {
    const value = line.trim();
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(value);
    } else {
      buffered.push(value);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(EOF);
    }
  });

  const question = (prompt: string): Promise<string> => {
    if (closed) return Promise.resolve(EOF);
    process.stdout.write(prompt);
    if (buffered.length > 0) return Promise.resolve(buffered.shift()!);
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };

  if (records.length > 0) {
    console.log(`\nReviewing ${records.length} pending candidate(s):\n`);

    for (let i = 0; i < records.length; i++) {
      const c = records[i];
      console.log(`[${i + 1}] ${c.subject} ${c.predicate} ${c.object}`);
      console.log(`    episode: ${c.episode}`);
      console.log(`    by: ${c.by}`);
      console.log(`    reason: ${c.reason}`);
      if (c.priority === 'reconsolidation') {
        // C18: the subject fact was recalled in the same session as the contradicting episode.
        console.log('    priority: reconsolidation (recalled in the same session)');
      }
      console.log('');

      // Unknown input re-prompts rather than dropping the candidate (C9).
      for (; ;) {
        const choice = await question('  accept (a), reject (r), or edit (e)? ');
        if (choice === EOF) {
          // Input ended (scripted input ran out): keep the candidate and stop.
          kept.push(c);
          break;
        }

        let edit: ReviewEdit | undefined;
        if (normalizeReviewChoice(choice) === 'edit') {
          const newSubject = await question(`    new subject [${c.subject}]: `);
          const newPredicate = await question(`    new predicate [${c.predicate}]: `);
          const newObject = await question(`    new object [${c.object}]: `);
          if (newSubject === EOF || newPredicate === EOF || newObject === EOF) {
            kept.push(c);
            break;
          }
          edit = { subject: newSubject, predicate: newPredicate, object: newObject };
        }

        const d = applyReviewDecision(c, choice, vault, cfg, edit);
        if (d.action === 'reprompt') {
          console.log(`    ${d.message}`);
          continue;
        }

        if (d.keep) kept.push(d.keep);
        if (d.action === 'accepted') promoted++;
        else if (d.action === 'rejected') rejected++;
        else if (d.action === 'edited') edited++;
        console.log(`    → ${d.message}`);
        break;
      }

      console.log('');
    }

    // Write remaining candidates back
    if (kept.length > 0) {
      writeFileSync(pending, serializeRecords(kept));
    } else if (existsSync(pending)) {
      unlinkSync(pending);
    }
  }

  // --- Dreams section (RFC-0001 "Confirmation") ---------------------------------
  if (dreamCandidates.length > 0) {
    console.log(`\nReviewing ${dreamCandidates.length} dream candidate(s):\n`);
    const passages = passageTextMap(vault, cfg);

    for (let i = 0; i < dreamCandidates.length; i++) {
      const c = dreamCandidates[i];
      console.log(`[${i + 1}] ${c.a} × ${c.b}  (${c.state})`);
      console.log(`    gist: ${c.gist}`);
      console.log(`    a: ${preview(passages.get(c.quotes.a) ?? '(passage not found)')}`);
      console.log(`    b: ${preview(passages.get(c.quotes.b) ?? '(passage not found)')}`);
      if (c.note) {
        // The endorsement note is free text from the agent; show it fenced as data.
        console.log('    note:');
        for (const line of fenceData(c.note, 'dream-note').split('\n')) console.log(`      ${line}`);
      }
      console.log('');

      // Unknown input re-prompts; EOF leaves the candidate open.
      for (; ;) {
        const choice = await question('  accept (a) or reject (r)? ');
        if (choice === EOF) break;

        const norm = choice.trim().toLowerCase();
        if (norm === 'a' || norm === 'accept') {
          if (!cfg.predicates.defs || !('related_to' in cfg.predicates.defs)) {
            const added = await ensureRelatedTo(vault, question);
            if (!added) {
              console.log('    related_to is required to accept; left open');
              break;
            }
            cfg = loadConfig(vault);
          }
        }

        const d = applyDreamDecision(c, choice, vault, cfg);
        if (d.action === 'reprompt') {
          console.log(`    ${d.message}`);
          continue;
        }
        if (d.action === 'accepted') dreamAccepted++;
        else if (d.action === 'rejected') dreamRejected++;
        console.log(`    → ${d.message}`);
        break;
      }

      console.log('');
    }
  }

  rl.close();

  // The summary is printed by the CLI (main.ts); printing it here too duplicated it.
  return { promoted, rejected, edited, dreamAccepted, dreamRejected };
}
