// Schema note generation (reflection). Auto-writes schemas/<entity>-overview.md when
// consolidated episode importance accumulates past a threshold.
//
// C21: human-edit detection is content-based, not git-based. The generated body's hash is
// stored in the note's frontmatter as `generated_hash`; on the next run, if the current
// body's hash differs, a human edited the note and it is left alone. This works without git
// and catches committed edits, which the old `git diff HEAD` check missed.
//
// `renderReflection` is pure (no writes) so `consolidate` can build its in-memory change
// set for `--dry-run` (C7). `reflect` is the thin I/O wrapper.

import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from '../types.ts';
import { splitFrontmatter } from '../vault/frontmatter.ts';
import { localDateString, systemDateNow } from '../vault/time.ts';

export interface ReflectionResult {
  entity: string;
  /** was the schema note written/updated */
  changed: boolean;
  /** human edits detected */
  hasHumanEdits: boolean;
  /** absolute path to schema note */
  path: string;
}

/** Pure render result: the content to write, not the write itself. */
export interface ReflectionRender {
  entity: string;
  /** vault-relative path of the schema note */
  relPath: string;
  /** the schema note content */
  content: string;
  changed: boolean;
  hasHumanEdits: boolean;
}

/** Hash of the generated body (everything after the frontmatter block). */
function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/** The `generated_hash` recorded in an existing schema note, or null if absent. */
function readGeneratedHash(raw: string): string | null {
  const m = /^generated_hash:\s*(\S+)\s*$/m.exec(raw);
  return m ? m[1] : null;
}

/**
 * The `generated:` date a `type: schema` note must declare (parse.ts). Deterministic: the
 * newest fact's recorded time, so a re-run on the same facts does not churn the note (#20).
 */
function newestFactDate(facts: Fact[]): string {
  const times = facts.map((f) => f.recordedAt).filter((t): t is number => typeof t === 'number');
  // A note date must be a local calendar date via systemDateNow(), never a raw UTC stamp
  // (see the determinism guard in test/review.test.ts).
  const t = times.length ? Math.max(...times) : systemDateNow();
  return localDateString(new Date(t));
}

/**
 * Compute the schema note for an entity, without writing it.
 * Returns null when the summed importance is below the threshold.
 */
export function renderReflection(
  vaultPath: string,
  entity: string,
  facts: Fact[],
  threshold: number,
  generated: string = newestFactDate(facts),
): ReflectionRender | null {
  // Compute summed importance
  const importance = facts.reduce((acc, f) => acc + (f.conf ?? 1), 0);

  if (importance < threshold) {
    return null;
  }

  const relPath = `schemas/${entity}-overview.md`;
  const absPath = join(vaultPath, relPath);

  const sources = [...new Set(facts.map((f) => f.src?.target).filter(Boolean))];

  // #22: do NOT use the facts heading — the parser would treat these human-readable summary
  // lines as fact lines and flag every one (fact.no-fields). A derived overview is not a
  // facts container.
  const bodyLines = [`# ${entity}`, '', `## Summary`, ''];
  for (const f of facts) {
    const obj = f.object.kind === 'link' ? `[[${f.object.link.target}]]` : f.object.value;
    bodyLines.push(`- ${f.predicate} ${obj}`);
    bodyLines.push(`  - valid: ${f.valid.from ? formatDate(f.valid.from) : '…'}..${f.valid.to ? formatDate(f.valid.to) : '…'}`);
    bodyLines.push(`  - by: ${f.by}`);
    if (f.supersededAt) {
      bodyLines.push(`  - superseded: ${formatDate(f.supersededAt)}`);
    }
    bodyLines.push('');
  }
  const body = bodyLines.join('\n');
  const hash = bodyHash(body);

  // C21: if the note exists and its body no longer matches the hash we generated, a human
  // edited it — leave it alone. A note with no `generated_hash` was not written by this
  // mechanism (or predates it), so it is treated as human-authored and also left alone.
  if (existsSync(absPath)) {
    const raw = readFileSync(absPath, 'utf8');
    const recorded = readGeneratedHash(raw);
    const { frontmatter, body: currentBody } = splitFrontmatter(raw);
    const current = frontmatter === null ? raw : currentBody;
    if (recorded === null || bodyHash(current) !== recorded) {
      return { entity, relPath, content: '', changed: false, hasHumanEdits: true };
    }
  }

  const content = [
    '---',
    'type: schema',
    'derived: true',
    `sources: ${sources.map((s) => `[[${s}]]`).join(', ') || 'none'}`,
    `generated: ${generated}`,
    `generated_hash: ${hash}`,
    '---',
    body,
  ].join('\n');

  return { entity, relPath, content, changed: true, hasHumanEdits: false };
}

/**
 * Generate or update an entity's overview schema note based on consolidated facts.
 * Returns null if the importance is below the threshold; `changed: false` if human edits
 * are detected (to avoid overwriting).
 */
export function reflect(
  vaultPath: string,
  entity: string,
  facts: Fact[],
  threshold: number,
): ReflectionResult | null {
  const render = renderReflection(vaultPath, entity, facts, threshold);
  if (!render) return null;
  if (render.changed) {
    writeFileSync(join(vaultPath, render.relPath), render.content);
  }
  return {
    entity,
    changed: render.changed,
    hasHumanEdits: render.hasHumanEdits,
    path: join(vaultPath, render.relPath),
  };
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
