// Append a fact line to a note's `## Facts` section, minimally.
//
// Why this exists: consolidation (C2), supersession (C3), and review (C9) all need to
// add a fact to an entity note without disturbing the rest of the file. Reserializing
// the whole note would drop comments, blank-line structure, and the `## History`
// section. This module does a single-line insertion, mirroring the byte-preserving
// approach of `episode-mark.ts`.
//
// The core is pure (string in, string out) so it is trivially testable; the I/O wrapper
// is a thin edge.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from '../types.ts';
import { formatFact } from './facts.ts';

export interface FactWriteOptions {
  /** Heading text without the `## ` prefix, e.g. "Facts" (from cfg.vault.factsHeading). */
  factsHeading: string;
}

/** A fact ready to serialize: everything `formatFact()` needs, minus parse-only fields. */
export type WritableFact = Omit<Fact, 'line' | 'raw'>;

const HEADING_RE = /^#{1,6}\s/;

/**
 * Return `raw` with `fact` appended to its `## <factsHeading>` section.
 *
 * - If the section exists, the line is inserted after the last non-empty line of the
 *   section (before any trailing blank lines and the next heading).
 * - If the section is absent, a new `## <factsHeading>` section is appended at the end
 *   of the note, separated by one blank line.
 * - Idempotent: if the exact formatted line is already present in the section, `raw` is
 *   returned unchanged. This is the guard that keeps re-running consolidation from
 *   duplicating a fact.
 */
export function appendFactLine(raw: string, fact: WritableFact, opts: FactWriteOptions): string {
  const line = formatFact(fact);
  const heading = `## ${opts.factsHeading}`;
  const lines = raw.split('\n');

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) {
    // No section: append one at the end of the note.
    const body = raw.endsWith('\n') ? raw : `${raw}\n`;
    const sep = body.endsWith('\n\n') ? '' : '\n';
    return `${body}${sep}${heading}\n${line}\n`;
  }

  // Section end: the next heading of any level, or EOF.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  // Idempotency guard: the exact line already lives in this section.
  for (let i = headingIdx + 1; i < end; i++) {
    if (lines[i].trim() === line.trim()) return raw;
  }

  // Insert after the last non-empty line of the section.
  let insertAt = headingIdx + 1;
  for (let i = headingIdx + 1; i < end; i++) {
    if (lines[i].trim() !== '') insertAt = i + 1;
  }

  const out = [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)];
  return out.join('\n');
}

/**
 * I/O wrapper: read `notePath` (vault-relative), append the fact, write it back.
 * Returns true when the file changed, false when the fact was already present.
 */
export function writeFactToNote(
  vaultRoot: string,
  notePath: string,
  fact: WritableFact,
  opts: FactWriteOptions,
): boolean {
  const abs = join(vaultRoot, notePath);
  const raw = readFileSync(abs, 'utf8');
  const updated = appendFactLine(raw, fact, opts);
  if (updated === raw) return false;
  writeFileSync(abs, updated, 'utf8');
  return true;
}
