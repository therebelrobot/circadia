// Resolve the LLM request settings for a call site, and turn config routing preferences
// into the wire `provider` object (#13).
//
// Consolidation / triple extraction reads `extraction.*` directly. The dream (REM) pass
// may override any field via `dreaming.llm`, falling back to `extraction.*` per field, so
// an unset `dreaming.llm` is exactly the pre-#13 behavior. Keeping the resolution here —
// not inline at each call site — is what makes "no override == no change" testable.

import type { Config, LlmRouting } from '../config.ts';

export interface LlmRequest {
  provider: 'none' | 'http';
  endpoint: string;
  model: string;
  apiKeyEnv: string | null;
  apiKeyFileEnv: string | null;
  routing: LlmRouting;
}

/** Consolidation and triple extraction: straight from `extraction.*`. */
export function resolveExtraction(cfg: Config): LlmRequest {
  const e = cfg.extraction;
  return {
    provider: e.provider,
    endpoint: e.endpoint,
    model: e.model,
    apiKeyEnv: e.apiKeyEnv,
    apiKeyFileEnv: e.apiKeyFileEnv ?? null,
    routing: e.routing ?? {},
  };
}

/**
 * The dream (REM) pass. Each `dreaming.llm.*` field falls back to the matching
 * `extraction.*` value when unset. `routing` is not overridable per pass: ZDR/data-policy
 * preferences apply to every hosted call, so it mirrors `extraction.routing`.
 */
export function resolveDream(cfg: Config): LlmRequest {
  const base = resolveExtraction(cfg);
  const o = cfg.dreaming.llm ?? {};
  return {
    provider: o.provider ?? base.provider,
    endpoint: o.endpoint ?? base.endpoint,
    model: o.model ?? base.model,
    // `??` is wrong for the key fields: an explicit `null` (no key) must win over the
    // extraction key, so test for `undefined` instead.
    apiKeyEnv: o.apiKeyEnv === undefined ? base.apiKeyEnv : o.apiKeyEnv,
    apiKeyFileEnv: o.apiKeyFileEnv === undefined ? base.apiKeyFileEnv : (o.apiKeyFileEnv ?? null),
    routing: base.routing,
  };
}

/**
 * Map routing preferences to the OpenAI-compatible `provider` request object, or
 * `undefined` when nothing is set — so an unconfigured request body stays byte-identical.
 * The config's camelCase `dataCollection` becomes the wire's `data_collection`.
 */
export function providerBody(routing: LlmRouting): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (routing.zdr !== undefined) out.zdr = routing.zdr;
  if (routing.dataCollection !== undefined) out.data_collection = routing.dataCollection;
  return Object.keys(out).length > 0 ? out : undefined;
}
