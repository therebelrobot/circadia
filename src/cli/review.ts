// Interactive CLI for reviewing pending consolidation candidates.
// Prompts user to accept/reject/edit queued candidates from .circadia/pending.jsonl

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { STATE_DIR } from '../config.ts';

export interface ReviewCandidate {
  subject: string;
  predicate: string;
  object: string;
  episode: string;
  by: string;
  queuedAt: number;
  reason: string;
  action: 'promote' | 'queue';
}

/**
 * Interactive review loop for pending candidates.
 * Returns { promoted, rejected, edited } counts.
 */
export async function review(vault: string): Promise<{ promoted: number; rejected: number; edited: number }> {
  const pendingPath = join(vault, STATE_DIR, 'pending.jsonl');

  if (!existsFileSync(pendingPath)) {
    console.log('No pending candidates to review.');
    return { promoted: 0, rejected: 0, edited: 0 };
  }

  const content = readFileSync(pendingPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());

  if (lines.length === 0) {
    console.log('No pending candidates to review.');
    unlinkSync(pendingPath);
    return { promoted: 0, rejected: 0, edited: 0 };
  }

  const candidates: ReviewCandidate[] = lines.map((line) => JSON.parse(line));
  const newCandidates: ReviewCandidate[] = [];
  let promoted = 0;
  let rejected = 0;
  let edited = 0;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });

  console.log(`\nReviewing ${candidates.length} pending candidate(s):\n`);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    console.log(`[${i + 1}] ${c.subject} ${c.predicate} ${c.object}`);
    console.log(`    episode: ${c.episode}`);
    console.log(`    by: ${c.by}`);
    console.log(`    reason: ${c.reason}`);
    console.log('');

    const choice = await question('  accept (a), reject (r), or edit (e)? ');

    if (choice === 'a') {
      // Mark as promoted (will be added to the candidate)
      promoted++;
      console.log(`    → promoted`);
    } else if (choice === 'r') {
      // Don't add back to queue
      rejected++;
      console.log(`    → rejected`);
    } else if (choice === 'e') {
      edited++;
      const newSubject = await question(`    new subject [${c.subject}]: `);
      const newPredicate = await question(`    new predicate [${c.predicate}]: `);
      const newObject = await question(`    new object [${c.object}]: `);

      newCandidates.push({
        ...c,
        subject: newSubject || c.subject,
        predicate: newPredicate || c.predicate,
        object: newObject || c.object,
      });

      console.log(`    → edited`);
    }

    console.log('');
  }

  rl.close();

  // Write remaining candidates back
  if (newCandidates.length > 0) {
    writeFileSync(pendingPath, newCandidates.map((c) => JSON.stringify(c)).join('\n') + '\n');
  } else {
    unlinkSync(pendingPath);
  }

  console.log(`\nReview complete: ${promoted} promoted, ${rejected} rejected, ${edited} edited`);

  return { promoted, rejected, edited };
}

function existsFileSync(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
