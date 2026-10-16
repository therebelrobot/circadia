// Date helpers for test fixtures, so fixtures do not rot as the clock advances.
//
// A hardcoded future date (e.g. `expires: '2026-10-13'`) is correct only until that date
// passes; after that the "open" candidate reads as expired and the test fails for reasons
// unrelated to the code. These helpers derive a fixture date from the *real* clock instead.

import { addDays } from '../../src/dreams/candidates.ts';
import { localDateString } from '../../src/vault/time.ts';

/**
 * A dream-candidate `expires` that is never in the past. The default matches the product
 * default `dreaming.candidateTtlNights: 14`, so the candidate is "fresh" whenever the suite
 * runs.
 */
export function freshExpires(days = 14): string {
  return addDays(localDateString(), days);
}

/**
 * Today at 12:00 UTC as a number. A fixed time-of-day makes `now + N hours` arithmetic stay
 * on the same calendar day regardless of when the suite runs (unlike `Date.now()`), while a
 * *dynamic date* keeps activity-window fixtures inside their window forever.
 */
export function todayAtUtcNoon(): number {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  return d.getTime();
}
