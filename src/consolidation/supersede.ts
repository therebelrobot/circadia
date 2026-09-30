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
  /** epoch ms for the superseded date */
  supersededAt: number;
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

function objectKey(f: { object: Fact['object'] }): string {
  return f.object.kind === 'link' ? `[[${f.object.link.target}]]` : f.object.value;
}

/**
 * Apply bi-temporal supersession to a note:
 * 1. Find current fact(s) with the same predicate but a different object in ## Facts.
 * 2. Strike them, close their `valid` interval, and move them to ## History.
 * 3. Append the new fact via formatFact().
 */
export function supersede(notePath: string, opts: SupersedeOptions): SupersedeResult {
  const problems: Problem[] = [];
  const superseded: Fact[] = [];
  const content = readFileSync(notePath, 'utf8');
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

  if (factsStart === -1) {
    problems.push({
      severity: 'error',
      path: notePath,
      code: 'supersede.no-facts-section',
      message: 'no ## Facts section found',
    });
    return { superseded, problems, changed: false };
  }

  const newObjKey = objectKey(opts.newFact);

  // Find current facts with the same predicate and a different object.
  const toSupersede: { index: number; fact: Fact }[] = [];
  for (let i = factsStart + 1; i < factsEnd; i++) {
    if (!lines[i].trim().startsWith('- ')) continue;
    const parsed = parseFactLine(lines[i], {
      noteId: 'supersede',
      path: notePath,
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
      path: notePath,
      code: 'supersede.no-match',
      message: `no current fact matches predicate=${opts.newFact.predicate} with a different object`,
    });
    return { superseded, problems, changed: false };
  }

  // Strike the old facts, closing their world-time interval at the supersession date.
  const struckLines = toSupersede.map(({ fact }) =>
    formatFact({
      ...fact,
      valid: { from: fact.valid.from, to: fact.valid.to ?? opts.supersededAt },
      supersededAt: opts.supersededAt,
      status: 'superseded',
    }),
  );
  for (const { fact } of toSupersede) superseded.push(fact);

  const remove = new Set(toSupersede.map((f) => f.index));

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

  writeFileSync(notePath, out.join('\n'));
  return { superseded, problems, changed: true };
}
