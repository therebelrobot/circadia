// Schema note generation (reflection). Auto-writes schemas/<entity>-overview.md when
// consolidated episode importance accumulates past a threshold. Detects human edits via git diff.
//
// `renderReflection` is pure (no writes) so `consolidate` can build its in-memory change
// set for `--dry-run` (C7). `reflect` is the thin I/O wrapper.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Fact } from '../types.ts';

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

/**
 * Compute the schema note for an entity, without writing it.
 * Returns null when the summed importance is below the threshold.
 */
export function renderReflection(
  vaultPath: string,
  entity: string,
  facts: Fact[],
  threshold: number,
): ReflectionRender | null {
  // Compute summed importance
  const importance = facts.reduce((acc, f) => acc + (f.conf ?? 1), 0);

  if (importance < threshold) {
    return null;
  }

  const relPath = `schemas/${entity}-overview.md`;

  // Check for human edits via git
  let hasHumanEdits = false;
  if (existsSync(join(vaultPath, '.git'))) {
    try {
      // C27: the path is a discrete argv element after `--`, so spaces and shell
      // metacharacters in it are inert (no shell is involved).
      const diff = execFileSync('git', ['diff', 'HEAD', '--', relPath], {
        cwd: vaultPath,
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (diff) {
        hasHumanEdits = true;
      }
    } catch {
      // Git not available; assume no human edits
    }
  }

  if (hasHumanEdits) {
    return { entity, relPath, content: '', changed: false, hasHumanEdits: true };
  }

  // Build schema content
  const sources = [...new Set(facts.map((f) => f.src?.target).filter(Boolean))];

  const lines = [
    `# ${entity}`,
    '',
    `---`,
    `derived: true`,
    `sources: ${sources.map(s => `[[${s}]]`).join(', ') || 'none'}`,
    `---`,
    '',
    `## Facts`,
    '',
  ];

  for (const f of facts) {
    const obj = f.object.kind === 'link' ? `[[${f.object.link.target}]]` : f.object.value;
    lines.push(`- ${f.predicate} ${obj}`);
    lines.push(`  - valid: ${f.valid.from ? formatDate(f.valid.from) : '…'}..${f.valid.to ? formatDate(f.valid.to) : '…'}`);
    lines.push(`  - by: ${f.by}`);
    if (f.supersededAt) {
      lines.push(`  - superseded: ${formatDate(f.supersededAt)}`);
    }
    lines.push('');
  }

  return { entity, relPath, content: lines.join('\n'), changed: true, hasHumanEdits: false };
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
