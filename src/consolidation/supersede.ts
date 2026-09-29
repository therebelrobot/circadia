// Bi-temporal fact supersession. Implements docs/ROADMAP.md Phase 4:
// strike old facts, mark with [superseded:: date], move to ## History, append new facts.
// Never delete a fact.

import { readFileSync, writeFileSync } from 'node:fs';
import { formatFact, parseFactLine } from '../vault/facts.ts';
import type { Fact, Problem } from '../types.ts';

export interface SupersedeOptions {
  /** epoch ms for the superseded date */
  supersededAt: number;
  /** new fact to append */
  newFact: Omit<Fact, 'line' | 'raw' | 'line'>;
  /** note path to update */
  notePath: string;
}

export interface SupersedeResult {
  /** old facts that were superseded */
  superseded: Fact[];
  /** problems encountered */
  problems: Problem[];
  /** true if any changes were made */
  changed: boolean;
}

/**
 * Apply bi-temporal supersession to a note:
 * 1. Find fact(s) with the same predicate+object in ## Facts
 * 2. Strike them and move to ## History
 * 3. Append the new fact via formatFact()
 */
export function supersede(notePath: string, opts: SupersedeOptions): SupersedeResult {
  const problems: Problem[] = [];
  const superseded: Fact[] = [];
  let changed = false;

  const content = readFileSync(notePath, 'utf8');
  const lines = content.split('\n');

  // Find ## Facts and ## History sections
  let factsStart = -1;
  let factsEnd = -1;
  let historyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '## Facts') {
      factsStart = i;
      // Find end of Facts section (next ## header)
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith('## ')) {
          factsEnd = j;
          break;
        }
      }
      if (factsEnd === -1) factsEnd = lines.length;
    } else if (lines[i].trim() === '## History') {
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

  // Find facts to supersede (matching predicate and object)
  const factLines: { index: number; fact: string }[] = [];
  for (let i = factsStart + 1; i < factsEnd; i++) {
    if (lines[i].trim().startsWith('- ')) {
      const ctx = {
        noteId: `note-${Date.now()}`,
        path: notePath,
        line: i + 1,
        section: 'facts' as const,
        defaultRecordedAt: Date.now(),
      };
      const parsed = parseFactLine(lines[i], ctx);
      if (parsed.fact) {
        // Check if this fact matches the one to supersede (same predicate+object)
        const newPred = opts.newFact.predicate;
        const newObj = opts.newFact.object.kind === 'link' ? `[[${opts.newFact.object.link.target}]]` : opts.newFact.object.value;
        if (parsed.fact.predicate === newPred && parsed.fact.status === 'current') {
          const oldObj = parsed.fact.object.kind === 'link' ? `[[${parsed.fact.object.link.target}]]` : parsed.fact.object.value;
          if (oldObj === newObj) {
            factLines.push({ index: i, fact: lines[i] });
            superseded.push(parsed.fact);
          }
        }
      }
    }
  }

  if (factLines.length === 0) {
    problems.push({
      severity: 'warning',
      path: notePath,
      code: 'supersede.no-match',
      message: `no current fact matches predicate=${opts.newFact.predicate} object=${opts.newFact.object.kind === 'link' ? opts.newFact.object.link.target : opts.newFact.object.value}`,
    });
    return { superseded, problems, changed: false };
  }

  // Build new content
  const newLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i === factsStart) {
      // Output ## Facts header
      newLines.push(lines[i]);
      // Add superseded facts to History
      const supersededLines = factLines
        .map(({ fact }) => {
          const ctx = {
            noteId: `note-${Date.now()}`,
            path: notePath,
            line: 0,
            section: 'history' as const,
            defaultRecordedAt: Date.now(),
          };
          const parsed = parseFactLine(fact, ctx);
          if (parsed.fact) {
            // Add superseded date if not already present
            const updatedFact = {
              ...parsed.fact,
              supersededAt: opts.supersededAt,
              status: 'superseded' as const,
            };
            return formatFact(updatedFact);
          }
          return fact;
        })
        .join('\n');
      newLines.push(supersededLines ? `\n${supersededLines}\n` : '\n');

      // Output new fact
      const newFactLine = formatFact(opts.newFact);
      newLines.push(newFactLine);

      // Skip old fact lines
      i = factLines[factLines.length - 1].index;
      continue;
    }

    newLines.push(lines[i]);
  }

  // If there's no History section, create one
  if (historyStart === -1) {
    // Find where to insert ## History (after Facts section)
    const insertAt = factsEnd;
    newLines.splice(insertAt, 0, '## History', '', newLines.slice(factsEnd).join('\n').replace('## History', '').trimStart());
  }

  writeFileSync(notePath, newLines.join('\n'));
  changed = true;

  return { superseded, problems, changed };
}
