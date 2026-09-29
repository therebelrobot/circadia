// Git utilities for time-travel recall. Zero-dependency: we invoke git via child_process
// and parse its output. This module handles commit resolution and reading note content
// at a specific commit.

import { execSync } from 'node:child_process';

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
