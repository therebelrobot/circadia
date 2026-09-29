// HippoRAG-style triple cache (docs/RETRIEVAL.md §hipporag).
//
// Triples are LLM output: expensive to regenerate and not authored by a human, so they
// are NOT written into notes. They live in `.circadia/triples/<noteId>.jsonl`, keyed by
// the passage content hash so a changed passage invalidates its triples automatically.
//
// Phase 1 ships the cache format, the loader, and the extractor interface.
// Phase 5 implements the LLM-backed extractor.

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
  return join(vaultRoot, '.circadia', 'triples');
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

export interface TripleCacheEntry {
  passageId: string;
  contentHash: string;
  triples: CachedTriple[];
  model: string;
  extractedAt: string;
}

/**
 * Check if cached triples for a passage are stale given the current model.
 * Returns true if:
 *   - No cache exists for this passage
 *   - The cached model differs from the current model
 *   - The passage content has changed (hash mismatch)
 */
export function isStale(
  vaultRoot: string,
  noteId: string,
  passageId: string,
  contentHash: string,
  model: string,
): boolean {
  const dir = triplesDir(vaultRoot);
  if (!existsSync(dir)) return true;
  const cacheFile = join(dir, `${noteId}.jsonl`);
  if (!existsSync(cacheFile)) return true;

  const lines = readFileSync(cacheFile, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as CachedTriple & { passageId: string; model: string };
      if (t.passageId === passageId && t.model === model) {
        // Found cache for this passage + model; check hash
        return t.contentHash !== contentHash;
      }
    } catch {
      continue;
    }
  }
  return true;
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

/**
 * HTTP-based TripleExtractor using llama.cpp server.
 * Uses OpenIE-style extraction prompt inspired by HippoRAG.
 */
export class HttpTripleExtractor implements TripleExtractor {
  readonly model: string;
  readonly endpoint: string;
  readonly apiKeyEnv: string | null;

  constructor(endpoint: string, model: string, apiKeyEnv: string | null) {
    this.endpoint = endpoint;
    this.model = model;
    this.apiKeyEnv = apiKeyEnv;
  }

  async extract(passage: { id: string; title: string; heading: string | null; text: string }): Promise<
    Omit<CachedTriple, 'passageId' | 'contentHash' | 'model' | 'extractedAt'>[]
  > {
    // Build OpenIE-style prompt (HippoRAG-inspired entity-first extraction)
    const prompt =
      `Extract semantic triples from the following text in JSON format.
For each (subject, predicate, object) triple:
- subject: the entity or concept being described
- predicate: the relationship or property (one of: located_at, operates_on, uses, connected_to, measured_by, controls, monitored_by, related_to)
- object: the target entity or value

Return ONLY a JSON array of objects with keys: subject, predicate, object, conf (0-1 confidence).
Example: [{"subject": "sensor", "predicate": "located_at", "object": "greenhouse", "conf": 0.95}]

Text:
${passage.text}

JSON:`;

    const apiKey = this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        prompt,
        temperature: 0.1,  // Low temp for deterministic extraction
        max_tokens: 512,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      throw new Error(`extraction endpoint returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? '{}';

    // Parse the JSON response
    let parsed: { triples?: Array<{ subject: string; predicate: string; object: string; conf?: number }> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fallback: try to extract JSON from markdown code blocks
      const match = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (match) {
        parsed = JSON.parse(match[1]);
      } else {
        parsed = {};
      }
    }

    return (parsed.triples ?? []).map((t) => ({
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      conf: typeof t.conf === 'number' ? t.conf : 0.5,
    }));
  }
}

/**
 * No-op extractor for testing or when extraction is disabled.
 */
export class NoopExtractor implements TripleExtractor {
  readonly model = 'noop';

  async extract(): Promise<
    Omit<CachedTriple, 'passageId' | 'contentHash' | 'model' | 'extractedAt'>[]
  > {
    return [];
  }
}
