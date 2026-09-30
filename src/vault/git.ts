// Git utilities for time-travel recall. Zero-dependency: we invoke git via child_process
// and parse its output. This module handles commit resolution and reading note content
// at a specific commit.
//
// SECURITY (C5): every git invocation uses execFileSync with an argument array, never a
// shell string. Refs and paths are passed as discrete argv elements, so shell
// metacharacters (`;`, `$()`, backticks, spaces) cannot be interpreted. Refs are also
// validated with `git rev-parse --verify` before use.

import { execFileSync } from 'node:child_process';

export interface ConsolidationCommitOptions {
  promoted: number;
  queued: number;
  superseded: number;
}

export interface CommitResult {
  hash: string;
}

/** Shared exec options: capture stdout/stderr, never inherit a shell. */
const GIT_OPTS = { encoding: 'utf8' as const, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };

/**
 * Return the vault-relative paths among `paths` that already have uncommitted changes
 * (staged or unstaged). `consolidate` calls this BEFORE it writes, so it can refuse to
 * commit a path a human was already editing (C8).
 */
export function getDirtyPaths(vaultRoot: string, paths: string[]): string[] {
  if (!isGitRepo(vaultRoot) || paths.length === 0) return [];
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      cwd: vaultRoot,
      ...GIT_OPTS,
    });
    return out
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.slice(3).trim());
  } catch {
    return [];
  }
}

/**
 * Create a git commit for consolidation changes.
 *
 * C8: stages ONLY `paths` (the files this run wrote), never the whole tree. An unrelated
 * uncommitted user edit is left alone. The caller is responsible for refusing to commit
 * when one of `paths` was already dirty before the run (see `getDirtyPaths`).
 */
export function createConsolidationCommit(
  vaultRoot: string,
  paths: string[],
  opts: ConsolidationCommitOptions,
): CommitResult | null {
  if (!isGitRepo(vaultRoot)) {
    return null;
  }
  if (paths.length === 0) {
    return null;
  }

  try {
    // Stage only the paths this run wrote. `--` separates flags from paths, and each
    // path is its own argv element, so a path with spaces is inert.
    execFileSync('git', ['add', '--', ...paths], {
      cwd: vaultRoot,
      ...GIT_OPTS,
    });

    // Check if there are any staged changes among those paths
    const statusOutput = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      cwd: vaultRoot,
      ...GIT_OPTS,
    });

    if (!statusOutput.trim()) {
      // No changes, nothing to commit
      return null;
    }

    // Build commit message summary
    const parts: string[] = ['consolidation run'];
    if (opts.promoted > 0) {
      parts.push(`promoted ${opts.promoted} candidate(s)`);
    }
    if (opts.queued > 0) {
      parts.push(`queued ${opts.queued} candidate(s)`);
    }
    if (opts.superseded > 0) {
      parts.push(`superseded ${opts.superseded} fact(s)`);
    }

    const message = parts.join('; ');

    // Commit with the message. The message is a single argv element, so quotes and
    // shell metacharacters in it are inert.
    execFileSync('git', ['commit', '-m', message], {
      cwd: vaultRoot,
      ...GIT_OPTS,
    });

    // Get the commit hash
    const hashOutput = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: vaultRoot,
      ...GIT_OPTS,
    });

    return { hash: hashOutput.trim() };
  } catch (e) {
    console.error(`git commit failed: ${(e as Error).message}`);
    throw e;
  }
}

export interface GitCommit {
  hash: string;
  timestamp: number; // epoch ms
  message: string;
}

/**
 * Validate a ref and resolve it to a commit hash.
 *
 * `git rev-parse --verify` accepts both ref names (`main`, `HEAD`) and rev expressions
 * (`HEAD~3`), and rejects anything that is not a real object. Because the ref is passed
 * as a single argv element (no shell), an injection payload like `HEAD;touch /tmp/x`
 * simply fails to resolve and returns null. Returns null on any failure.
 */
function resolveRefHash(vaultRoot: string, ref: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: vaultRoot,
      ...GIT_OPTS,
    });
    const hash = out.trim();
    return hash || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a git ref (e.g., "HEAD~3", "2026-09-10", "main") to a commit.
 * Returns the commit whose timestamp <= target if target is a date.
 */
export function resolveCommit(vaultRoot: string, ref: string): GitCommit | null {
  try {
    // If ref looks like a date, find the commit at or before that date. Anchored so a
    // 40-char hex commit hash that happens to begin with four digits is not mistaken
    // for a date (which would make hash refs resolve to null ~15% of the time).
    if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(ref) || /^\d{4}-\d{2}-\d{2}T/.test(ref)) {
      // Parse the date
      const dateStr = ref.length === 4 ? ref + '-01-01' :
        ref.length === 7 ? ref + '-01' : ref;
      const targetDate = new Date(dateStr);
      if (isNaN(targetDate.getTime())) return null;

      // Get all commits with their timestamps
      const output = execFileSync(
        'git',
        ['log', '--format=%H %at', '--reverse'],
        { cwd: vaultRoot, ...GIT_OPTS }
      );

      const lines = output.trim().split('\n').filter(l => l);
      let closestCommit: GitCommit | null = null;
      const targetMs = targetDate.getTime();

      for (const line of lines) {
        const [hash, epochSec] = line.split(' ');
        const epochMs = Number(epochSec) * 1000;
        if (epochMs <= targetMs) {
          closestCommit = { hash, timestamp: epochMs, message: '' };
        } else {
          break;
        }
      }

      return closestCommit;
    }

    // Otherwise, validate and resolve as a normal git ref. An invalid ref (including
    // any shell-injection payload) resolves to null rather than executing anything.
    const hash = resolveRefHash(vaultRoot, ref);
    if (!hash) return null;

    // C15: read the timestamp/message of the RESOLVED commit, not HEAD. `%x00` is a NUL
    // byte, which cannot appear in a commit subject, so the split is unambiguous.
    const meta = execFileSync(
      'git',
      ['log', '-1', '--format=%at%x00%s', hash],
      { cwd: vaultRoot, ...GIT_OPTS }
    );
    const [epochSec, message = ''] = meta.split('\u0000');
    const timestamp = Number(epochSec) * 1000;

    return { hash, timestamp, message };
  } catch {
    return null;
  }
}

/**
 * Get the list of commits up to (and including) a given commit hash.
 * Used for finding the latest commit before or at a specific point in time.
 */
export function getCommits(vaultRoot: string, maxCommit?: string): GitCommit[] {
  try {
    const args = ['log'];
    if (maxCommit) args.push(maxCommit);
    args.push('--format=%H %at %s', '--reverse');
    const output = execFileSync('git', args, { cwd: vaultRoot, ...GIT_OPTS });

    const lines = output.trim().split('\n').filter(l => l);
    return lines.map(line => {
      const [hash, epochSec, ...msgParts] = line.split(' ');
      return {
        hash,
        timestamp: Number(epochSec) * 1000,
        message: msgParts.join(' ')
      };
    });
  } catch {
    return [];
  }
}

/**
 * Read a file's content at a specific commit.
 */
export function readFileAtCommit(vaultRoot: string, relativePath: string, commitHash: string): string | null {
  try {
    // `${commitHash}:${relativePath}` is one argv element; a path with spaces is fine.
    const output = execFileSync(
      'git',
      ['show', `${commitHash}:${relativePath}`],
      { cwd: vaultRoot, ...GIT_OPTS }
    );
    return output;
  } catch {
    return null;
  }
}

/**
 * Check if the vault is a git repository.
 */
export function isGitRepo(vaultRoot: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: vaultRoot,
      ...GIT_OPTS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the commit hash for a note at a specific timestamp.
 * Returns the most recent commit that included changes to this note.
 */
export function getNoteCommitAtTime(vaultRoot: string, relativePath: string, timestamp: number): string | null {
  try {
    const epochSec = Math.floor(timestamp / 1000);
    // `--` separates flags from the path; the path is its own argv element (C27).
    const output = execFileSync(
      'git',
      ['log', '-1', '--format=%H', `--before=${epochSec}`, '--', relativePath],
      { cwd: vaultRoot, ...GIT_OPTS }
    );
    const hash = output.trim();
    return hash || null;
  } catch {
    return null;
  }
}

/**
 * Get all commits that modified a specific file.
 */
export function getNoteCommits(vaultRoot: string, relativePath: string): GitCommit[] {
  try {
    const output = execFileSync(
      'git',
      ['log', '--format=%H %at %s', '--', relativePath],
      { cwd: vaultRoot, ...GIT_OPTS }
    );

    const lines = output.trim().split('\n').filter(l => l);
    return lines.map(line => {
      const [hash, epochSec, ...msgParts] = line.split(' ');
      return {
        hash,
        timestamp: Number(epochSec) * 1000,
        message: msgParts.join(' ')
      };
    });
  } catch {
    return [];
  }
}
