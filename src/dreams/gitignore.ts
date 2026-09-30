// Refuse to run the REM pass when dream state could leak into git (ADR-0011).
//
// Dream state is disposable and must never be committed: committing it would put every
// dream in the vault's history forever and undo the forgetting the design depends on.
// `circadia init` writes `.circadia/dreams/` into `.gitignore`; for existing vaults the
// pass checks at runtime and refuses loudly with a one-line fix.
//
// SECURITY (C5): every git invocation uses `execFileSync` with an argument array, never a
// shell string. `test/git-safety.test.ts` guards this.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { STATE_DIR } from '../config.ts';
import { isGitRepo } from '../vault/git.ts';

export interface DreamsIgnoredCheck {
  ok: boolean;
  /** one-line reason when `ok` is false */
  reason?: string;
}

const GIT_OPTS = { encoding: 'utf8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

/** Run git with an argv array; return the exit status and stdout instead of throwing. */
function gitExit(cwd: string, args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, ...GIT_OPTS });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string | Buffer };
    const status = typeof err.status === 'number' ? err.status : 128;
    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout ? err.stdout.toString() : '';
    return { status, stdout };
  }
}

/**
 * Check that `.circadia/dreams/` is safe to write in a git vault.
 *
 * - Not a git repo: nothing to leak into git, so the pass may run.
 * - `git check-ignore -q .circadia/dreams/candidates.jsonl` exit 0: ignored, run.
 * - exit 1: not ignored, refuse with a one-line fix.
 * - exit 128 or any other error: refuse and say so.
 * - `git ls-files .circadia/dreams` lists anything: refuse (tracked files are not
 *   protected by `.gitignore`).
 */
export function checkDreamsIgnored(vaultRoot: string): DreamsIgnoredCheck {
  if (!isGitRepo(vaultRoot)) return { ok: true };

  const candidateRel = join(STATE_DIR, 'dreams', 'candidates.jsonl');
  const ignored = gitExit(vaultRoot, ['check-ignore', '-q', candidateRel]);
  if (ignored.status === 1) {
    return {
      ok: false,
      reason: `${candidateRel} is not git-ignored; add "${STATE_DIR}/dreams/" to .gitignore`,
    };
  }
  if (ignored.status !== 0) {
    return { ok: false, reason: `git check-ignore failed (exit ${ignored.status}); refusing to run the dream pass` };
  }

  const tracked = gitExit(vaultRoot, ['ls-files', join(STATE_DIR, 'dreams')]);
  if (tracked.status !== 0) {
    return { ok: false, reason: `git ls-files failed (exit ${tracked.status}); refusing to run the dream pass` };
  }
  if (tracked.stdout.trim() !== '') {
    return {
      ok: false,
      reason: `tracked files under ${STATE_DIR}/dreams/ are not protected by .gitignore; run \`git rm --cached\` on them`,
    };
  }
  return { ok: true };
}
