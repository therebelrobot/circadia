// Bi-temporal fact supersession. Implements docs/ROADMAP.md Phase 4:
// strike old facts, mark with [superseded:: date], move to ## History, append new facts.
// Never delete a fact.
//
// A contradiction is the SAME predicate with a DIFFERENT object (a single-valued
// predicate can only hold one object at a time). The old fact's world-time interval is
// closed at the supersession date, and the new fact opens there, so "what was true in
// July" and "what did we believe in July" stay independently answerable.

import { readFileSync, writeFileSync } from 'node:fs';
import { formatFact, parseFactLine } from '../vault/facts.ts';
import type { Fact, Problem } from '../types.ts';

export interface SupersedeOptions {
  /** vault-relative path, used only for problem reporting */
  path?: string;
  /** epoch ms for the superseded date (system time: when we stopped believing it) */
  supersededAt: number;
  /**
   * epoch ms for the world-time boundary (when the change actually happened, normally the
   * source episode's `started`). Closes the old fact's `valid` interval. Defaults to
   * `supersededAt` when the caller has no better world-time value.
   */
  validAt?: number;
  /** new fact to append */
  newFact: Omit<Fact, 'line' | 'raw'>;
}

export interface SupersedeResult {
  /** old facts that were superseded */
  superseded: Fact[];
  /** problems encountered */
  problems: Problem[];
  /** true if any changes were made */
  changed: boolean;
}

/** Result of the pure supersession transform: the new file content, not a write. */
export interface SupersedeApplyResult extends SupersedeResult {
  /** the transformed note content (equal to the input when `changed` is false) */
  content: string;
}

function objectKey(f: { object: Fact['object'] }): string {
  return f.object.kind === 'link' ? `[[${f.object.link.target}]]` : f.object.value;
}

/**
 * Apply bi-temporal supersession to a note:
 * 1. Find current fact(s) with the same predicate but a different object in ## Facts.
 * 2. Strike them, close their `valid` interval, and move them to ## History.
 * 3. Append the new fact via formatFact().
 *
 * Pure: string in, string out. `consolidate` uses this to build its in-memory change
 * set (C7); `supersede` below is the thin I/O wrapper.
 */
export function applySupersede(content: string, opts: SupersedeOptions): SupersedeApplyResult {
  const problems: Problem[] = [];
  const superseded: Fact[] = [];
  const lines = content.split('\n');

  // Locate ## Facts and ## History.
  let factsStart = -1;
  let factsEnd = -1;
  let historyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '## Facts') {
      factsStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith('## ')) {
          factsEnd = j;
          break;
        }
      }
      if (factsEnd === -1) factsEnd = lines.length;
    } else if (t === '## History') {
      historyStart = i;
    }
  }

  const reportPath = opts.path ?? '<note>';

  if (factsStart === -1) {
    problems.push({
      severity: 'error',
      path: reportPath,
      code: 'supersede.no-facts-section',
      message: 'no ## Facts section found',
    });
    return { superseded, problems, changed: false, content };
  }

  const newObjKey = objectKey(opts.newFact);

  // Find current facts with the same predicate and a different object.
  const toSupersede: { index: number; fact: Fact }[] = [];
  for (let i = factsStart + 1; i < factsEnd; i++) {
    if (!lines[i].trim().startsWith('- ')) continue;
    const parsed = parseFactLine(lines[i], {
      noteId: 'supersede',
      path: reportPath,
      line: i + 1,
      section: 'facts',
      defaultRecordedAt: null,
    });
    if (!parsed.fact) continue;
    if (parsed.fact.predicate !== opts.newFact.predicate) continue;
    if (parsed.fact.status !== 'current') continue;
    if (objectKey(parsed.fact) === newObjKey) continue; // identical: corroboration, not supersession
    toSupersede.push({ index: i, fact: parsed.fact });
  }

  if (toSupersede.length === 0) {
    problems.push({
      severity: 'warning',
      path: reportPath,
      code: 'supersede.no-match',
      message: `no current fact matches predicate=${opts.newFact.predicate} with a different object`,
    });
    return { superseded, problems, changed: false, content };
  }

  // Strike the old facts, closing their world-time interval at the change date (not the
  // run date: `valid` is world time, `superseded` is system time).
  const validAt = opts.validAt ?? opts.supersededAt;

  // Refuse to write an interval that ends before it starts. A fact whose world time opens
  // after the change date cannot be closed by it; superseding it would produce a backwards
  // `valid` interval (and a lint error). The gate already queues this case; this is the
  // last line of defense.
  const eligible = toSupersede.filter(({ fact }) => fact.valid.from === null || validAt >= fact.valid.from);
  if (eligible.length === 0) {
    problems.push({
      severity: 'warning',
      path: reportPath,
      code: 'supersede.backwards-interval',
      message: 'refusing to close a fact before its valid interval starts',
    });
    return { superseded, problems, changed: false, content };
  }

  const struckLines = eligible.map(({ fact }) =>
    formatFact({
      ...fact,
      valid: { from: fact.valid.from, to: fact.valid.to ?? validAt },
      supersededAt: opts.supersededAt,
      status: 'superseded',
    }),
  );
  for (const { fact } of eligible) superseded.push(fact);

  const remove = new Set(eligible.map((f) => f.index));

  // Rebuild: everything up to and including the Facts heading, minus the superseded
  // lines, then the new fact.
  const out: string[] = [];
  for (let i = 0; i <= factsStart; i++) out.push(lines[i]);
  for (let i = factsStart + 1; i < factsEnd; i++) {
    if (!remove.has(i)) out.push(lines[i]);
  }
  while (out.length > factsStart + 1 && out[out.length - 1].trim() === '') out.pop();
  out.push(formatFact(opts.newFact));
  out.push('');

  // Append the struck lines to History, creating the section if it is absent.
  const rest = lines.slice(factsEnd);
  if (historyStart === -1) {
    out.push('## History');
    out.push(...struckLines);
    out.push('');
    out.push(...rest);
  } else {
    const relHistory = historyStart - factsEnd;
    let hEnd = rest.length;
    for (let i = relHistory + 1; i < rest.length; i++) {
      if (rest[i].trim().startsWith('## ')) {
        hEnd = i;
        break;
      }
    }
    const before = rest.slice(0, hEnd);
    while (before.length > relHistory + 1 && before[before.length - 1].trim() === '') before.pop();
    out.push(...before);
    out.push(...struckLines);
    out.push('');
    out.push(...rest.slice(hEnd));
  }

  return { superseded, problems, changed: true, content: out.join('\n') };
}

/**
 * I/O wrapper: read `notePath`, apply supersession, write it back when changed.
 * Kept for callers that want the side effect directly (tests, future review).
 */
export function supersede(notePath: string, opts: SupersedeOptions): SupersedeResult {
  const content = readFileSync(notePath, 'utf8');
  const result = applySupersede(content, { ...opts, path: opts.path ?? notePath });
  if (result.changed) writeFileSync(notePath, result.content);
  return { superseded: result.superseded, problems: result.problems, changed: result.changed };
}
