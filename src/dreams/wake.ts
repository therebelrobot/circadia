// Wake recall: read the night's log once and forget it (RFC-0001 "Wake recall").
//
// `circadia wake [--json]` and the MCP `wake` tool return the sleep report and the top
// `dreaming.recallFragments` kept fragments by salience, reduced to note titles and gist.
// Quotes, scores and pruned fragments stay out.
//
// The log is renamed to `<night>.json.reading-<pid>-<random>` before reading, so two
// sessions can't both read it, and the temp file is deleted in a `finally`. An unread log
// is deleted after `dreaming.logTtlHours` by the next `dream` or `wake` call. If the log is
// absent, already read, or expired, wake says "nothing left to recall" and does not
// reconstruct it.
//
// The report and fragments are fenced together in one `<untrusted-data source="dreams">`
// block, with tags inside escaped the way `renderForContext()` does. The narration rules
// sit outside the fence: they are Circadia's instructions, not model output.

import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { openIndex } from '../index/db.ts';
import { shortHash } from '../vault/util.ts';
import { deleteExpiredLogs, logDir, logPath, type DreamLog, type SleepReport } from './log.ts';

/** One fragment as the agent sees it: note titles and gist, no quotes or scores. */
export interface WakeFragment {
  /** the candidate id, `d-<night>-<hash(a, b)>` */
  id: string;
  /** recent-side note title */
  a: string;
  /** remote-side note title */
  b: string;
  gist: string;
}

export interface WakeResult {
  /** the night read, or null when nothing was left to recall */
  night: string | null;
  report: SleepReport | null;
  fragments: WakeFragment[];
  /** kept fragments not shown, so "there was another, but it's gone" is true */
  forgotten: number;
  rules: string[];
  /** one-line honest answer to "how did you sleep?" */
  summary: string;
  /** true when a log was read */
  recalled: boolean;
  /** human-readable reason when nothing was recalled */
  message?: string;
}

export interface WakeOptions {
  now?: number;
  /** override db path (tests) */
  dbPath?: string;
}

/**
 * The narration rules, outside the fence. They forbid claims of subjective experience and
 * tell the agent to report only what the pass recorded (RFC-0001 "Honesty").
 */
export const WAKE_RULES: string[] = [
  'Describe only what the fragments contain; do not add detail.',
  'If a detail is gone, say it is gone rather than fill it in.',
  'Never present a fragment as a fact; frame it as what the overnight pass turned up.',
  'Do not claim to have experienced anything; report what the pass produced.',
];

/** Random suffix for the temp name; not security-sensitive, just collision-avoiding. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Claim and read the night's log. The rename is the atomic claim: two concurrent readers
 * race on it and only one wins. The temp file is deleted in a `finally`.
 */
export function readOnceLog(vaultRoot: string, night: string): DreamLog | null {
  const src = logPath(vaultRoot, night);
  const tmp = `${src}.reading-${process.pid}-${randomSuffix()}`;
  try {
    renameSync(src, tmp);
  } catch {
    return null; // absent, or another reader claimed it first
  }
  try {
    const log = JSON.parse(readFileSync(tmp, 'utf8')) as DreamLog;
    return log && typeof log.night === 'string' ? log : null;
  } catch {
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The most recent unread night in the log dir, or null. `.reading-*` temps are ignored. */
function latestNight(vaultRoot: string): string | null {
  const dir = logDir(vaultRoot);
  if (!existsSync(dir)) return null;
  const nights = readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
  return nights.length > 0 ? nights[nights.length - 1] : null;
}

/**
 * Note id -> title, from the index. Falls back to the id when the index is absent, so wake
 * never creates an index file as a side effect.
 */
function noteTitles(vaultRoot: string, cfg: Config, dbPath: string | undefined, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const path = dbPath ?? join(vaultRoot, cfg.index.path);
  if (!existsSync(path)) {
    for (const id of ids) out.set(id, id);
    return out;
  }
  try {
    const { db } = openIndex(path);
    try {
      const stmt = db.prepare(`SELECT id, title FROM nodes WHERE kind = 'note' AND id = ?`);
      for (const id of ids) {
        const row = stmt.get(id) as { id: string; title: string | null } | undefined;
        out.set(id, row?.title ?? id);
      }
    } finally {
      db.close();
    }
  } catch {
    for (const id of ids) out.set(id, id);
  }
  return out;
}

/**
 * The honest one-line answer to "how did you sleep?" (RFC-0001 "Answering ...").
 *
 * "Slept badly" means the REM pass actually failed, or every sample errored. A standalone
 * `circadia dream` records consolidation as "did not run" — that is not a failure, so a
 * clean standalone pass reads "slept fine". A few errors out of many samples are reported
 * but do not make the night bad.
 */
function summarize(report: SleepReport, keptShown: number): string {
  const rem = report.rem;
  if (rem.skipped) return 'slept fine, no dreaming happened';

  const errs = Object.entries(rem.errors)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const errorCount = Object.values(rem.errors).reduce((s, n) => s + n, 0);
  const allFailed = rem.samples > 0 && errorCount >= rem.samples;

  if (!rem.ran || allFailed) return errs ? `slept badly (${errs})` : 'slept badly';

  // A clean pass, or one with a few errors, is fine; report the errors if any.
  if (errs) return `slept fine (${errs})`;
  if (keptShown === 0) return 'slept fine, no dreams it remembers';
  return 'slept fine';
}

function nothingToRecall(): WakeResult {
  return {
    night: null,
    report: null,
    fragments: [],
    forgotten: 0,
    rules: WAKE_RULES,
    summary: 'nothing left to recall',
    recalled: false,
    message: 'nothing left to recall',
  };
}

/**
 * Read the night's log once. TTL deletion runs first, so an expired log is gone before it
 * can be read. Returns "nothing left to recall" when there is no log, it was already read,
 * or it expired.
 */
export function wake(vaultRoot: string, cfg: Config, opts: WakeOptions = {}): WakeResult {
  const now = opts.now ?? Date.now();
  // An unread log is deleted after `dreaming.logTtlHours` by the next dream or wake call.
  deleteExpiredLogs(vaultRoot, cfg.dreaming.logTtlHours, now);

  const night = latestNight(vaultRoot);
  if (!night) return nothingToRecall();

  const log = readOnceLog(vaultRoot, night);
  if (!log || !log.report) return nothingToRecall();

  const kept = log.fragments
    .filter((f) => f.status === 'kept' && f.gist !== null)
    .sort((a, b) => b.salience - a.salience || a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
  const shown = cfg.dreaming.recallFragments > 0 ? kept.slice(0, cfg.dreaming.recallFragments) : [];
  const forgotten = kept.length - shown.length;

  const ids = [...new Set(shown.flatMap((f) => [f.a, f.b]))];
  const titles = noteTitles(vaultRoot, cfg, opts.dbPath, ids);
  const fragments: WakeFragment[] = shown.map((f) => ({
    id: `d-${log.night}-${shortHash(f.a, f.b)}`,
    a: titles.get(f.a) ?? f.a,
    b: titles.get(f.b) ?? f.b,
    gist: f.gist as string,
  }));

  return {
    night: log.night,
    report: log.report,
    fragments,
    forgotten,
    rules: WAKE_RULES,
    summary: summarize(log.report, fragments.length),
    recalled: true,
  };
}

/** The exact `--json` shape (RFC-0001 "Wake recall"). */
export function wakeJson(r: WakeResult): {
  night: string | null;
  report: SleepReport | null;
  fragments: WakeFragment[];
  forgotten: number;
  rules: string[];
} {
  return { night: r.night, report: r.report, fragments: r.fragments, forgotten: r.forgotten, rules: r.rules };
}

/**
 * The escaped form of `<`. Built by concatenation so this source file never contains the
 * HTML entity literally (some editors decode it back to `<`), mirroring `chat.ts`.
 */
const LT = '&' + 'lt;';

/** Escape a fence-closing attempt the way `renderForContext()` does. */
function escapeFence(text: string): string {
  return text.replace(/<\/?\s*untrusted-data/gi, (m) => m.replace('<', LT));
}

/**
 * Render the report and fragments in one fence, with the narration rules outside it. The
 * one-line summary is Circadia's own judgment, not model output, so it sits outside the
 * fence with the rules.
 */
export function renderWake(r: WakeResult): string {
  if (!r.recalled || !r.report) return r.message ?? 'nothing left to recall';

  const lines: string[] = [];
  lines.push(`night: ${r.night}`);
  const c = r.report.consolidation;
  lines.push(
    `consolidation: ${c.ran ? 'ran' : 'did not run'}, ${c.episodes} episode(s), ${c.promoted} promoted, ${c.queued} queued`,
  );
  const rem = r.report.rem;
  if (rem.skipped) lines.push(`rem: skipped (${rem.skipped})`);
  else lines.push(`rem: ${rem.ran ? 'ran' : 'did not run'}, ${rem.samples} sample(s), ${rem.kept} kept, ${rem.pruned} pruned`);
  if (Object.keys(rem.errors).length > 0) {
    lines.push(`errors: ${Object.entries(rem.errors).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (r.fragments.length > 0) {
    lines.push('fragments:');
    for (const f of r.fragments) lines.push(`- ${f.a} × ${f.b}: ${f.gist}`);
  } else {
    lines.push('fragments: none');
  }
  if (r.forgotten > 0) lines.push(`forgotten: ${r.forgotten}`);

  const fence = `<untrusted-data source="dreams">\n${escapeFence(lines.join('\n'))}\n</untrusted-data>`;
  const rules = `rules:\n${r.rules.map((x) => `- ${x}`).join('\n')}`;
  return `${r.summary}\n\n${fence}\n\n${rules}`;
}
