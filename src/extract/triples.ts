// HippoRAG-style triple cache (docs/RETRIEVAL.md §hipporag).
//
// Triples are LLM output: expensive to regenerate and not authored by a human, so they
// are NOT written into notes. They live in `.palimpsest/triples/<noteId>.jsonl`, keyed by
// the passage content hash so a changed passage invalidates its triples automatically.
//
// Phase 1 ships the cache format, the loader, and the extractor interface.
// The LLM-backed extractor is Phase 5 (docs/ROADMAP.md).

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface CachedTriple {
  passageId: string;
  /** sha256 (hex, first 16) of the passage text the triple was extracted from */
  contentHash: string;
  subject: string;
  predicate: string;
  object: string;
  conf?: number;
  model?: string;
  extractedAt?: string;
}

export function passageHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function triplesDir(vaultRoot: string): string {
  return join(vaultRoot, '.palimpsest', 'triples');
}

export function loadTriples(vaultRoot: string): { triples: CachedTriple[]; badLines: number } {
  const dir = triplesDir(vaultRoot);
  const triples: CachedTriple[] = [];
  let badLines = 0;
  if (!existsSync(dir)) return { triples, badLines };
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as CachedTriple;
        if (t.passageId && t.contentHash && t.subject && t.predicate && t.object) triples.push(t);
        else badLines++;
      } catch {
        badLines++;
      }
    }
  }
  return { triples, badLines };
}

export function writeTriples(vaultRoot: string, noteId: string, triples: CachedTriple[]): void {
  const dir = triplesDir(vaultRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${noteId}.jsonl`), triples.map((t) => JSON.stringify(t)).join('\n') + '\n');
}

/**
 * Contract for the Phase 5 extractor. Implementations call an LLM (OpenIE-style prompt,
 * see HippoRAG) and return subject–predicate–object triples for one passage.
 * Must be deterministic enough to cache: same text + model → same triples, modulo noise.
 */
export interface TripleExtractor {
  readonly model: string;
  extract(passage: { id: string; title: string; heading: string | null; text: string }): Promise<
    Omit<CachedTriple, 'passageId' | 'contentHash' | 'model' | 'extractedAt'>[]
  >;
}
