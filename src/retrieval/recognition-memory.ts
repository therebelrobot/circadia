/**
 * Recognition-memory seed filter (HippoRAG 2).
 *
 * Matches query against triples by embedding, then filters with a cheap LLM check.
 * Returns phrases and passages from high-confidence triples to seed recall.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { loadTriples, type CachedTriple } from '../extract/triples.ts';
import { topKByCosine } from './embeddings.ts';

/** Embedding for a passage with its ID */
export interface PassageEmbedding {
  id: string;
  embedding: Float32Array;
}

export interface TripleMatch {
  triple: CachedTriple;
  passageId: string;
  confidence: number;
}

/**
 * Interface for cheap LLM verification of triple relevance.
 */
export interface TripleVerifier {
  /**
   * Verify if a triple is relevant to the query.
   * @param query The user query
   * @param triple The triple to verify
   * @returns Confidence score (0-1)
   */
  verify(query: string, triple: CachedTriple): Promise<number>;
}

/**
 * HTTP-based verifier using a lightweight model endpoint.
 */
export class HttpTripleVerifier implements TripleVerifier {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKeyEnv: string | null;

  constructor(endpoint: string, model: string, apiKeyEnv: string | null) {
    this.endpoint = endpoint;
    this.model = model;
    this.apiKeyEnv = apiKeyEnv;
  }

  async verify(query: string, triple: CachedTriple): Promise<number> {
    const apiKey = this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Lightweight relevance check prompt
    const prompt =
      `Determine if the following triple is relevant to the query.
Return a JSON object with a single key "confidence" (0-1 score).

Query: ${query}

Triple: (${triple.subject}, ${triple.predicate}, ${triple.object})

JSON:`;

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        prompt,
        temperature: 0.0,
        max_tokens: 64,
      }),
    });

    if (!res.ok) {
      throw new Error(`verification endpoint returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? '{}';

    let parsed: { confidence?: number };
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (match) {
        parsed = JSON.parse(match[1]);
      } else {
        parsed = {};
      }
    }

    return typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
  }
}

/**
 * No-op verifier for testing.
 */
export class NoopVerifier implements TripleVerifier {
  async verify(): Promise<number> {
    return 1.0; // Always pass
  }
}

/**
 * Find candidate triples by embedding similarity to the query.
 */
export async function findCandidateTriples(
  vaultRoot: string,
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  cfg: Config,
): Promise<TripleMatch[]> {
  const { triples } = loadTriples(vaultRoot);
  if (triples.length === 0) return [];

  // Get passage embeddings for all passages
  const rows = db
    .prepare(`SELECT id, embedding FROM nodes WHERE kind = 'passage' AND embedding IS NOT NULL`)
    .all() as { id: string; embedding: Uint8Array }[];

  const passages: PassageEmbedding[] = rows.map((r) => ({
    id: r.id,
    embedding: new Float32Array(new Uint8Array(r.embedding).buffer),
  }));

  if (passages.length === 0) return [];

  // Find passages similar to query
  const topPassages = topKByCosine(queryEmbedding, passages, cfg.retrieval.seedLimit * 2);
  const passageIds = new Set(topPassages.map((p) => p.id));

  // Filter triples by matching passage
  const candidates: TripleMatch[] = [];

  for (const triple of triples) {
    // Match triple to passages by content hash or passageId
    if (passageIds.has(triple.passageId)) {
      candidates.push({
        triple,
        passageId: triple.passageId,
        confidence: 1.0, // Embedding match already passed
      });
    }
  }

  // Sort by confidence and return top candidates
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, cfg.graph.hipporag.recognitionMemory.topCandidates);
}

/**
 * Verify candidate triples with LLM and return high-confidence results.
 */
export async function filterTriplesWithLLM(
  candidates: TripleMatch[],
  query: string,
  verifier: TripleVerifier,
  cfg: Config,
): Promise<TripleMatch[]> {
  const minConfidence = cfg.graph.hipporag.recognitionMemory.minConfidence;
  const verified: TripleMatch[] = [];

  for (const candidate of candidates) {
    const newConfidence = await verifier.verify(query, candidate.triple);
    const combinedConfidence = (candidate.confidence + newConfidence) / 2;

    if (combinedConfidence >= minConfidence) {
      verified.push({
        ...candidate,
        confidence: combinedConfidence,
      });
    }
  }

  // Sort by combined confidence
  verified.sort((a, b) => b.confidence - a.confidence);
  return verified;
}

/**
 * Extract passage IDs from verified triples for seeding recall.
 */
export function extractSeeds(triples: TripleMatch[]): {
  passageIds: string[];
  phrases: string[];
} {
  const passageIds = new Set<string>();
  const phrases = new Set<string>();

  for (const t of triples) {
    passageIds.add(t.passageId);
    // Extract key phrases from triple
    phrases.add(t.triple.subject);
    phrases.add(t.triple.object);
    phrases.add(`${t.triple.subject} ${t.triple.predicate}`);
    phrases.add(`${t.triple.predicate} ${t.triple.object}`);
  }

  return {
    passageIds: [...passageIds],
    phrases: [...phrases],
  };
}
