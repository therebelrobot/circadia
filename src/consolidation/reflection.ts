// Schema note generation (reflection). Auto-writes schemas/<entity>-overview.md when
// consolidated episode importance accumulates past a threshold. Detects human edits via git diff.

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { Fact } from '../types.ts';

export interface ReflectionResult {
  entity: string;
  /** was the schema note written/updated */
  changed: boolean;
  /** human edits detected */
  hasHumanEdits: boolean;
  /** path to schema note */
  path: string;
}

/**
 * Generate or update an entity's overview schema note based on consolidated facts.
 * Returns false if human edits are detected (to avoid overwriting).
 */
export function reflect(
  vaultPath: string,
  entity: string,
  facts: Fact[],
  threshold: number,
): ReflectionResult | null {
  // Compute summed importance
  const importance = facts.reduce((acc, f) => acc + (f.conf ?? 1), 0);

  if (importance < threshold) {
    return null;
  }

  const schemaPath = join(vaultPath, 'schemas', `${entity}-overview.md`);
  const relPath = `schemas/${entity}-overview.md`;

  // Check for human edits via git
  let hasHumanEdits = false;
  if (existsSync(join(vaultPath, '.git'))) {
    try {
      const diff = execSync(`git diff HEAD -- "${relPath}"`, {
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
    return {
      entity,
      changed: false,
      hasHumanEdits: true,
      path: schemaPath,
    };
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

  writeFileSync(schemaPath, lines.join('\n'));

  return {
    entity,
    changed: true,
    hasHumanEdits: false,
    path: schemaPath,
  };
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
