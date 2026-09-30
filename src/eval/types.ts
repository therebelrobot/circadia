// Evaluation types (Phase 7). String-literal unions only — no enums — so the
// module runs under Node type-stripping (AGENTS.md §3.2).

import type { Config } from '../config.ts';
import type { GraphMode, Trust } from '../types.ts';

/**
 * What a query is testing. `trust` is special: it is a hard gate, not a recall
 * average (see metrics.ts and run.ts).
 */
export type EvalKind =
  | 'single-hop'
  | 'multi-hop'
  | 'temporal'
  | 'preference'
  | 'remote-association-2hop'
  | 'remote-association-3hop'
  | 'trust';

/** Which half of the eval set a query belongs to. Tuning reads `dev` only. */
export type EvalSplit = 'dev' | 'holdout';

/**
 * For a temporal query, which clock the `as_of` is testing:
 *   - `world`  — what was true then (`valid::` intervals on fact edges);
 *   - `system` — what was believed then (`at::` / `superseded::`).
 */
export type TemporalAxis = 'world' | 'system';

/** One line of `eval/queries.jsonl`. */
export interface EvalQuery {
  id: string;
  query: string;
  kind: EvalKind;
  /** ISO date/datetime; parsed with the vault's own time parser. */
  as_of?: string;
  temporal_axis?: TemporalAxis;
  /** passage ids that must be retrieved (e.g. `projects/alpha/overview#0`). */
  expected_passages: string[];
  /** passage ids that must NOT be retrieved (trust / temporal-absence checks). */
  expect_absent?: string[];
  split: EvalSplit;
  /**
   * Config overrides for this query. The runner allowlists the keys (see
   * `ALLOWED_OVERRIDE_KEYS` in run.ts); anything else is rejected.
   */
  config_overrides?: Record<string, unknown>;
}

/** A trimmed recall hit, enough to score and to explain a ranking. */
export interface EvalHit {
  passageId: string;
  noteId: string;
  score: number;
  /** 1-based position in the returned ranking. */
  rank: number;
  trust: Trust;
}

/** Per-query metrics. Keys of the `*AtK` maps are the k values as strings. */
export interface EvalMetrics {
  recallAtK: Record<string, number>;
  precisionAtK: Record<string, number>;
  mrr: number;
}

/** One query's full result. */
export interface EvalQueryResult {
  id: string;
  query: string;
  kind: EvalKind;
  split: EvalSplit;
  modeUsed: GraphMode;
  escalations: { from: GraphMode; to: GraphMode; reason: string }[];
  hits: EvalHit[];
  metrics: EvalMetrics;
  /** hits whose passage id is in `expect_absent` (should be 0). */
  absentViolations: number;
  /** trust-gate violations: a low-trust passage returned under a higher floor. */
  trustViolations: number;
}

/** Aggregated metrics for one group of results. */
export interface EvalAggregate {
  group: string;
  count: number;
  recallAtK: Record<string, number>;
  precisionAtK: Record<string, number>;
  mrr: number;
}

/** The whole run. `failed` is true when any hard gate (trust) was violated. */
export interface EvalReport {
  fixtureHash: string;
  config: Config;
  results: EvalQueryResult[];
  aggregates: EvalAggregate[];
  /** total trust-gate violations across all queries. */
  trustViolations: number;
  /** total expect_absent violations across all queries. */
  absentViolations: number;
  failed: boolean;
}

/** A named config variant for an ablation run. */
export interface AblationSpec {
  name: string;
  description: string;
  config: Config;
}
