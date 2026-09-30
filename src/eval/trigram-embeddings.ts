// Deterministic lexical embeddings for the eval harness (Phase 7, Step 3).
//
// The eval must be reproducible with zero network access, so it cannot use the
// HTTP embeddings client. This client extracts character trigrams, hashes each
// into a fixed-dimension vector (feature hashing), and L2-normalizes. Same text
// -> identical vector; near-identical wording -> higher cosine than unrelated
// text. Dependency-free and deterministic.

import type { EmbeddingInput, EmbeddingResult, EmbeddingsClient } from '../retrieval/embeddings.ts';

export const TRIGRAM_DIMENSIONS = 256;

/** FNV-1a 32-bit hash. Deterministic across platforms. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Feature-hashed character-trigram vector, L2-normalized. Signed hashing
 * (a bit of the hash picks the sign) keeps collisions from systematically
 * inflating similarity.
 */
export function trigramVector(text: string, dims: number = TRIGRAM_DIMENSIONS): Float32Array {
  const v = new Float32Array(dims);
  const s = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  for (let i = 0; i + 3 <= s.length; i++) {
    const h = fnv1a(s.slice(i, i + 3));
    const idx = h % dims;
    v[idx] += (h & 0x80000000) !== 0 ? -1 : 1;
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

export class TrigramEmbeddingsClient implements EmbeddingsClient {
  readonly model = 'trigram-hash-v1';
  readonly dimensions: number | null = TRIGRAM_DIMENSIONS;

  async embed(texts: EmbeddingInput[]): Promise<EmbeddingResult[]> {
    return texts.map((t) => ({ id: t.id, embedding: trigramVector(t.text) }));
  }
}
