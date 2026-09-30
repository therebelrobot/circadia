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
import { loadConfig, type Config } from '../config.ts';
import { parseVault, buildResolver } from '../index/indexer.ts';
import { appendFactLine, type WritableFact } from '../vault/fact-write.ts';
import { applySupersede } from '../consolidation/supersede.ts';
import { isSingleValued } from '../consolidation/schema.ts';
import { asWikiLink, shortHash } from '../vault/util.ts';
import { DEFAULT_TRUST } from '../vault/facts.ts';
import { systemDateNow } from '../vault/time.ts';
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

/**
 * Interactive review loop for pending candidates.
 * Returns { promoted, rejected, edited } counts.
 */
export async function review(vault: string): Promise<{ promoted: number; rejected: number; edited: number }> {
  const cfg = loadConfig(vault);
  const pending = pendingPath(vault);
  // C18: reconsolidation-priority records are reviewed first. The sort is stable, so the
  // on-disk order is preserved within each group.
  const records = prioritizeForReview(readRecords(pending));

  if (records.length === 0) {
    console.log('No pending candidates to review.');
    if (existsSync(pending)) unlinkSync(pending);
    return { promoted: 0, rejected: 0, edited: 0 };
  }

  const kept: PendingRecord[] = [];
  let promoted = 0;
  let rejected = 0;
  let edited = 0;

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

  rl.close();

  // Write remaining candidates back
  if (kept.length > 0) {
    writeFileSync(pending, serializeRecords(kept));
  } else if (existsSync(pending)) {
    unlinkSync(pending);
  }

  // The summary is printed by the CLI (main.ts); printing it here too duplicated it.
  return { promoted, rejected, edited };
}
