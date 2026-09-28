// Walk a vault and yield indexable markdown files (docs/SCHEMA.md §1).

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { matchesAnyGlob } from './util.ts';

export interface VaultFile {
  /** vault-relative, posix separators */
  path: string;
  abs: string;
  mtime: number;
}

export function walkVault(root: string, ignore: string[] = []): VaultFile[] {
  const out: VaultFile[] = [];
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (ent.isDirectory()) {
        if (rel === '_meta' || rel === 'node_modules') continue;
        visit(abs);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        if (matchesAnyGlob(rel, ignore)) continue;
        out.push({ path: rel, abs, mtime: statSync(abs).mtimeMs });
      }
    }
  };
  visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
