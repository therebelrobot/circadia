// Optional LoCoMo adapter (Phase 7, Step 10).
//
// Reads a LOCAL JSON array or JSONL file only — no download, no dependency. Off
// by default; the CLI enables it with `--adapter locomo`. External sets are
// always `holdout`: tuning must never read them (ADR-0010).
//
// LoCoMo is a list of conversations, each with a `qa` list. Each QA item becomes
// one EvalQuery; `evidence` dialog ids map to `<id>#0` passage ids. A QA item
// with no question is dropped.

import { readFileSync } from 'node:fs';
import type { EvalKind, EvalQuery } from '../types.ts';
import { readRecords } from './longmemeval.ts';

const KIND_BY_CATEGORY: Record<string, EvalKind> = {
  '1': 'multi-hop',
  '2': 'temporal',
  '3': 'single-hop',
  '4': 'single-hop',
  '5': 'trust',
};

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Map one LoCoMo conversation to its QA items as EvalQueries. */
export function mapLoCoMoConversation(conv: unknown, index: number): EvalQuery[] {
  if (conv === null || typeof conv !== 'object') return [];
  const c = conv as Record<string, unknown>;
  const sample = typeof c.sample_id === 'string' ? c.sample_id : `locomo-${index}`;
  const qa = Array.isArray(c.qa) ? c.qa : [];
  const out: EvalQuery[] = [];
  qa.forEach((item, j) => {
    if (item === null || typeof item !== 'object') return;
    const q = item as Record<string, unknown>;
    const query = typeof q.question === 'string' ? q.question : null;
    if (!query) return;
    const cat = typeof q.category === 'string' ? q.category : typeof q.category === 'number' ? String(q.category) : '';
    const kind = KIND_BY_CATEGORY[cat] ?? 'single-hop';
    const evidence = asStringArray(q.evidence).map((e) => `${e}#0`);
    out.push({ id: `${sample}-q${j}`, query, kind, expected_passages: evidence, split: 'holdout' });
  });
  return out;
}

export function parseLoCoMoText(text: string): EvalQuery[] {
  const out: EvalQuery[] = [];
  readRecords(text).forEach((conv, i) => out.push(...mapLoCoMoConversation(conv, i)));
  return out;
}

export function parseLoCoMo(path: string): EvalQuery[] {
  return parseLoCoMoText(readFileSync(path, 'utf8'));
}
