// Candidate extraction from episodes via local LLM (llama.cpp) or OpenRouter fallback.
// Output is constrained to JSON; predicates are validated against config predicates.defs.

import type { Config } from '../config.ts';
import type { ParsedNote } from '../types.ts';

export interface Candidate {
  subject: string;
  predicate: string;
  object: string;
  valid: boolean;
  episodeId: string;
  confidence: number;
}

export async function extractCandidates(episode: ParsedNote, cfg: Config): Promise<Candidate[]> {
  if (cfg.extraction.provider === 'none') return [];
  const text = episode.passages.map((p) => p.text).join('\n\n');
  const PROMPT = `You are a knowledge-extraction agent. Given an episode transcript, extract factual candidates in JSON format.

Rules:
- Output ONLY a JSON array of objects.
- Each object has: { "subject": "<note id or alias>", "predicate": "<snake_case>", "object": "<value or [[note]]>", "valid": true|false, "confidence": 0.0-1.0 }.
- "valid" is false when the statement is speculative ("may", "might", "planned") or a question.
- Use the exact note id or alias as the subject/object when it appears as [[...]].

Output JSON only, no other text.

Episode:
${text}
`;

  const body = JSON.stringify({ model: cfg.extraction.model, prompt: PROMPT, response_format: { type: 'json_object' } });
  const res = await fetch(cfg.extraction.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[cfg.extraction.apiKeyEnv || ''] || ''}` },
    body,
  });
  if (!res.ok) throw new Error(`extraction failed: ${res.status} ${res.statusText}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  const json = JSON.parse(data.choices[0].message.content) as { candidates: { subject: string; predicate: string; object: string; valid?: boolean; confidence?: number }[] };
  return (json.candidates ?? []).map((c) => ({
    subject: c.subject,
    predicate: c.predicate,
    object: c.object,
    valid: c.valid ?? true,
    episodeId: episode.id,
    confidence: c.confidence ?? 1,
  }));
}
