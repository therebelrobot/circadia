// Interactive CLI for reviewing pending consolidation candidates.
// Prompts the user to accept/reject/edit queued candidates from .circadia/pending.jsonl.
//
// C6: reads the versioned PendingRecord format (ADR-0007) and writes a rejected
// candidate to .circadia/rejected.jsonl so it does not come back on the next run.
// C9 (accept writing the fact) is out of scope for this change.

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  appendRecords,
  pendingPath,
  rejectedPath,
  readRecords,
  serializeRecords,
  type PendingRecord,
} from '../consolidation/pending.ts';

/**
 * Interactive review loop for pending candidates.
 * Returns { promoted, rejected, edited } counts.
 */
export async function review(vault: string): Promise<{ promoted: number; rejected: number; edited: number }> {
  const pending = pendingPath(vault);
  const records = readRecords(pending);

  if (records.length === 0) {
    console.log('No pending candidates to review.');
    if (existsSync(pending)) unlinkSync(pending);
    return { promoted: 0, rejected: 0, edited: 0 };
  }

  const newCandidates: PendingRecord[] = [];
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

  console.log(`\nReviewing ${records.length} pending candidate(s):\n`);

  for (let i = 0; i < records.length; i++) {
    const c = records[i];
    console.log(`[${i + 1}] ${c.subject} ${c.predicate} ${c.object}`);
    console.log(`    episode: ${c.episode}`);
    console.log(`    by: ${c.by}`);
    console.log(`    reason: ${c.reason}`);
    console.log('');

    const choice = await question('  accept (a), reject (r), or edit (e)? ');

    if (choice === 'a') {
      // Mark as promoted (C9 will write the fact through the shared writer).
      promoted++;
      console.log(`    → promoted`);
    } else if (choice === 'r') {
      // C6: record the rejection so the candidate does not reappear.
      rejected++;
      appendRecords(rejectedPath(vault), [c]);
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
    writeFileSync(pending, serializeRecords(newCandidates));
  } else {
    unlinkSync(pending);
  }

  console.log(`\nReview complete: ${promoted} promoted, ${rejected} rejected, ${edited} edited`);

  return { promoted, rejected, edited };
}
