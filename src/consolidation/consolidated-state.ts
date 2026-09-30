// C22: per-episode body-hash state, so re-selection is driven by content, not mtime.
//
// Why not mtime: a vault copy, `git clone`/`checkout`, rsync to the Pi, or a restore from
// backup all move file mtimes without changing content. An mtime rule would re-select every
// episode on the next run, re-extract it (LLM cost), and — because an old episode can
// contradict a newer fact — silently revert memory to a stale value. A body hash changes
// only on a real edit, which is exactly the "manual fix" case the roadmap wants to catch.
//
// The state file is NOT derivable from the vault: it records each episode's body as it was
// when consolidation last ran. It lives beside `pending.jsonl` in `.circadia/`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_DIR } from '../config.ts';
import { splitFrontmatter } from '../vault/frontmatter.ts';

/** Bump when the state shape changes; readers may branch on it. */
export const CONSOLIDATED_STATE_VERSION = 1;

export interface ConsolidatedState {
  v: typeof CONSOLIDATED_STATE_VERSION;
  /** vault-relative episode path -> sha256 of its body (frontmatter excluded) */
  hashes: Record<string, string>;
}

export function consolidatedStatePath(vaultRoot: string): string {
  return join(vaultRoot, STATE_DIR, 'consolidated.json');
}

/**
 * sha256 of a note's body (everything after the frontmatter block). The body is hashed, not
 * the whole file, because consolidation itself edits the frontmatter (`consolidated:`) and
 * that must not look like a content change.
 */
export function noteBodyHash(raw: string): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  return createHash('sha256').update(frontmatter === null ? raw : body).digest('hex');
}

/** Read the state file; a missing or malformed file is treated as empty. */
export function readConsolidatedState(path: string): ConsolidatedState {
  if (!existsSync(path)) return { v: CONSOLIDATED_STATE_VERSION, hashes: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConsolidatedState>;
    if (parsed && typeof parsed === 'object' && parsed.hashes && typeof parsed.hashes === 'object') {
      return { v: CONSOLIDATED_STATE_VERSION, hashes: parsed.hashes as Record<string, string> };
    }
  } catch {
    // A malformed state file is not one of ours; treat it as empty and rewrite it.
  }
  return { v: CONSOLIDATED_STATE_VERSION, hashes: {} };
}

export function serializeConsolidatedState(state: ConsolidatedState): string {
  return JSON.stringify(state, null, 2) + '\n';
}
