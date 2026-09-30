// Ablations by edge origin (Phase 7, Step 5).
//
// Variants are built in memory from DEFAULT_CONFIG via deepMerge; nothing is
// written to the vault. The origin list is driven by MODE_ORIGINS, never
// hardcoded, so a future origin (e.g. `dream`) appears automatically.

import type { Config } from '../config.ts';
import { DEFAULT_CONFIG, deepMerge } from '../config.ts';
import { MODE_ORIGINS } from '../retrieval/modes.ts';
import type { GraphMode } from '../types.ts';
import type { AblationSpec } from './types.ts';

/**
 * Build the ablation set:
 *   - each mode alone;
 *   - activation weight 0;
 *   - importance weight 0;
 *   - for each mode, each origin that mode traverses, with its weight zeroed.
 *
 * `origins` defaults to MODE_ORIGINS; pass a copy to prove a new origin is
 * picked up without code changes.
 */
export function buildAblations(
  cfg: Config = DEFAULT_CONFIG,
  origins: Record<GraphMode, readonly string[]> = MODE_ORIGINS,
): AblationSpec[] {
  const out: AblationSpec[] = [];
  const modes = Object.keys(origins) as GraphMode[];

  for (const mode of modes) {
    out.push({
      name: `mode:${mode}`,
      description: `query mode fixed to ${mode}`,
      config: deepMerge(cfg, { graph: { query: { mode } } }),
    });
  }

  out.push({
    name: 'weights:activation=0',
    description: 'activation weight zeroed',
    config: deepMerge(cfg, { retrieval: { weights: { activation: 0 } } }),
  });
  out.push({
    name: 'weights:importance=0',
    description: 'importance weight zeroed',
    config: deepMerge(cfg, { retrieval: { weights: { importance: 0 } } }),
  });

  for (const mode of modes) {
    for (const origin of origins[mode]) {
      out.push({
        name: `origin:${mode}:${origin}=0`,
        description: `${mode} mode with origin ${origin} weight zeroed`,
        config: deepMerge(cfg, {
          graph: { query: { mode }, originWeights: { [origin]: 0 } },
        }),
      });
    }
  }

  return out;
}
