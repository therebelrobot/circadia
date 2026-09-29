// Embeddings client (Phase 2). Zero dependencies: global fetch against an
// OpenAI-compatible /v1/embeddings endpoint (llama.cpp's `llama-server
// --embedding` speaks this wire format). The default endpoint is a local
// llama.cpp server; hosted models go through OpenRouter with a non-OpenAI,
// non-xAI model (owner requirement, AGENTS.md §3).

import type { Config } from '../config.ts';

export interface EmbeddingInput {
  id: string;
  text: string;
}

export interface EmbeddingResult {
  id: string;
  embedding: Float32Array;
}

export interface EmbeddingsClient {
  /** Model name as configured; recorded on passage rows as `embedding_model`. */
  readonly model: string;
  /** Dimensionality of the vectors; null until the first response arrives. */
  readonly dimensions: number | null;
  embed(texts: EmbeddingInput[]): Promise<EmbeddingResult[]>;
}

const RETRY_DELAY_MS = 1000;

export class HttpEmbeddingsClient implements EmbeddingsClient {
  readonly model: string;
  private readonly endpoint: string;
  private readonly apiKeyEnv: string | null;
  private readonly batchSize: number;
  private _dimensions: number | null = null;

  constructor(cfg: Config['embeddings']) {
    this.model = cfg.model;
    this.endpoint = cfg.endpoint;
    this.apiKeyEnv = cfg.apiKeyEnv;
    this.batchSize = Math.max(1, cfg.batchSize);
  }

  get dimensions(): number | null {
    return this._dimensions;
  }

  async embed(texts: EmbeddingInput[]): Promise<EmbeddingResult[]> {
    const out: EmbeddingResult[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.requestBatch(batch.map((t) => t.text));
      for (let j = 0; j < batch.length; j++) {
        out.push({ id: batch[j].id, embedding: vectors[j] });
      }
    }
    return out;
  }

  private async requestBatch(input: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKeyEnv) {
      const token = process.env[this.apiKeyEnv];
      if (token) headers.authorization = `Bearer ${token}`;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS);
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ input, model: this.model }),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`embeddings endpoint returned HTTP ${res.status}`);
          continue; // retry once on rate-limit / server errors
        }
        if (!res.ok) throw new Error(`embeddings endpoint returned HTTP ${res.status}`);
        const body = (await res.json()) as { data?: { embedding?: number[] }[] };
        const data = body.data;
        if (!Array.isArray(data) || data.length !== input.length) {
          throw new Error('embeddings response missing or mis-sized data[]');
        }
        return data.map((d) => {
          if (!Array.isArray(d.embedding)) throw new Error('embeddings response row missing embedding');
          const v = Float32Array.from(d.embedding);
          if (this._dimensions === null) this._dimensions = v.length;
          return v;
        });
      } catch (e) {
        // network failure or malformed response: retry once, then throw
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Provider 'none': recall stays text-only. Calling embed() is a programming error. */
export class NullEmbeddingsClient implements EmbeddingsClient {
  readonly model = '';
  readonly dimensions: number | null = null;

  async embed(_texts: EmbeddingInput[]): Promise<EmbeddingResult[]> {
    throw new Error('embeddings are disabled (embeddings.provider is "none")');
  }
}

export function createEmbeddingsClient(cfg: Config['embeddings']): EmbeddingsClient {
  return cfg.provider === 'http' ? new HttpEmbeddingsClient(cfg) : new NullEmbeddingsClient();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cosine similarity in [-1, 1]; 0 when either vector has zero norm. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Brute-force top-K by cosine similarity. Fine to about 10⁵ passages on a Pi
 * (a few hundred ms); beyond that an ANN index would be needed, which would
 * require an ADR for a dependency.
 */
export function topKByCosine(
  query: Float32Array,
  candidates: { id: string; embedding: Float32Array }[],
  k: number,
): { id: string; score: number }[] {
  const scored = candidates.map((c) => ({ id: c.id, score: cosineSimilarity(query, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
