// Optional LongMemEval adapter (Phase 7, Step 10).
//
// Reads a LOCAL JSON array or JSONL file only — no download, no dependency. Off
// by default; the CLI enables it with `--adapter longmemeval`. External sets are
// always `holdout`: tuning must never read them (ADR-0010).
//
// The mapping is deliberately conservative. LongMemEval records carry a question
// and a question type; passage ids are taken from `expected_passages` when the
// file has them, else from `answer_session_ids` (mapped to `<id>#0`). A record
// with no question is dropped.

import { readFileSync } from 'node:fs';
import type { EvalKind, EvalQuery } from '../types.ts';

/**
 * Read a JSON array or JSONL file, skipping malformed lines instead of throwing.
 * A leading `[` selects the JSON-array form; otherwise the text is JSONL.
 */
export function readRecords(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a malformed line is skipped, not thrown
    }
  }
  return out;
}

const KIND_BY_TYPE: Record<string, EvalKind> = {
  'single-session-user': 'single-hop',
  'single-session-assistant': 'single-hop',
  'single-session-preference': 'preference',
  'multi-session': 'multi-hop',
  'temporal-reasoning': 'temporal',
  'knowledge-update': 'temporal',
};
// LongMemEval marks abstention questions with an `_abs` suffix on `question_id`;
// there is no `abstention` question_type. They are skipped (see parseLongMemEvalText):
// "the answer is absent" is not Circadia's trust gate, which is about provenance.

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Map one LongMemEval record to an EvalQuery, or null when it has no question. */
export function mapLongMemEvalRecord(rec: unknown, index: number): EvalQuery | null {
  if (rec === null || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  const query = typeof r.question === 'string' ? r.question : typeof r.query === 'string' ? r.query : null;
  if (!query) return null;
  const id = typeof r.question_id === 'string' ? r.question_id : typeof r.id === 'string' ? r.id : `longmemeval-${index}`;
  const type = typeof r.question_type === 'string' ? r.question_type : '';
  const kind = KIND_BY_TYPE[type] ?? 'single-hop';
  const explicit = asStringArray(r.expected_passages);
  const sessions = asStringArray(r.answer_session_ids).map((s) => `${s}#0`);
  const expected = explicit.length > 0 ? explicit : sessions;
  return { id, query, kind, expected_passages: expected, split: 'holdout' };
}

export interface AdapterParseResult {
  queries: EvalQuery[];
  /** records skipped because they are abstention (`_abs`) questions. */
  skippedAbs: number;
}

export function parseLongMemEvalText(text: string): AdapterParseResult {
  const out: EvalQuery[] = [];
  let skippedAbs = 0;
  readRecords(text).forEach((rec, i) => {
    const id = rec !== null && typeof rec === 'object' ? (rec as Record<string, unknown>).question_id : undefined;
    if (typeof id === 'string' && id.endsWith('_abs')) {
      skippedAbs++;
      return;
    }
    const q = mapLongMemEvalRecord(rec, i);
    if (q) out.push(q);
  });
  return { queries: out, skippedAbs };
}

export function parseLongMemEval(path: string): AdapterParseResult {
  return parseLongMemEvalText(readFileSync(path, 'utf8'));
}
