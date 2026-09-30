// Git utilities for time-travel recall. Zero-dependency: we invoke git via child_process
// and parse its output. This module handles commit resolution and reading note content
// at a specific commit.

import { execSync } from 'node:child_process';

export interface ConsolidationCommitOptions {
  promoted: number;
  queued: number;
  superseded: number;
}

export interface CommitResult {
  hash: string;
}

/**
 * Create a git commit for consolidation changes.
 */
export function createConsolidationCommit(vaultRoot: string, opts: ConsolidationCommitOptions): CommitResult | null {
  if (!isGitRepo(vaultRoot)) {
    return null;
  }

  try {
    // Stage all changed files in the vault
    execSync('git add -A', {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Check if there are any changes
    const statusOutput = execSync('git status --porcelain', {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
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

    // Commit with the message
    execSync(`git commit -m "${message}"`, {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Get the commit hash
    const hashOutput = execSync('git rev-parse HEAD', {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return { hash: hashOutput.trim() };
  } catch (e) {
    console.error(`git commit failed: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Print the git diff that would be committed (for --dry-run mode).
 */
export function printConsolidationDiff(vaultRoot: string): void {
  if (!isGitRepo(vaultRoot)) {
    console.log('not a git repository');
    return;
  }

  try {
    // Stage all changes temporarily
    execSync('git add -A', {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Print diff
    const diff = execSync('git diff --staged', {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    console.log(diff);
  } catch (e) {
    console.error(`git diff failed: ${(e as Error).message}`);
  }
}

export interface GitCommit {
  hash: string;
  timestamp: number; // epoch ms
  message: string;
}

/**
 * Resolve a git ref (e.g., "HEAD~3", "2026-09-10", "main") to a commit.
 * Returns the commit whose timestamp <= target if target is a date.
 */
export function resolveCommit(vaultRoot: string, ref: string): GitCommit | null {
  try {
    // If ref looks like a date, find the commit at or before that date
    if (/^\d{4}(-\d{2}){0,2}/.test(ref)) {
      // Parse the date
      const dateStr = ref.length === 4 ? ref + '-01-01' :
        ref.length === 7 ? ref + '-01' : ref;
      const targetDate = new Date(dateStr);
      if (isNaN(targetDate.getTime())) return null;

      // Get all commits with their timestamps
      const output = execSync(
        'git log --format="%H %at" --reverse',
        { cwd: vaultRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
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

    // Otherwise, resolve as a normal git ref
    // Validate ref format to prevent shell injection (only allow alphanumeric, /, -, ~, ^, .)
    if (!/^[a-zA-Z0-9/_~^.\-]+$/.test(ref)) {
      return null;
    }
    const output = execSync(
      `git rev-parse ${ref}^{commit} 2>/dev/null`,
      { cwd: vaultRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const hash = output.trim();

    const meta = execSync(
      'git log -1 --format="%at %s"',
      { cwd: vaultRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const [epochSec, ...msgParts] = meta.trim().split(' ');
    const timestamp = Number(epochSec) * 1000;
    const message = msgParts.join(' ');

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
    const output = execSync(
      `git log${maxCommit ? ` ${maxCommit}` : ''} --format="%H %at %s" --reverse`,
      { cwd: vaultRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
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

/**
 * Read a file's content at a specific commit.
 */
export function readFileAtCommit(vaultRoot: string, relativePath: string, commitHash: string): string | null {
  try {
    const output = execSync(
      `git show ${commitHash}:${relativePath} 2>/dev/null`,
      { cwd: vaultRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
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
    execSync('git rev-parse --git-dir', {
      cwd: vaultRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
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
    const output = execSync(
      `git log -1 --format="%H" --before=${epochSec} -- "${relativePath}" 2>/dev/null`,
      { cwd: vaultRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
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
    const output = execSync(
      `git log --format="%H %at %s" -- "${relativePath}"`,
      { cwd: vaultRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
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
