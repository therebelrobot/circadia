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
  | 'trust'
  // Scoped correctness checks. These are reported separately and never folded
  // into the per-kind recall headline: a scope shrinks the retrieval problem, so
  // a scoped pass is not evidence the unscoped query works.
  | 'multi-hop-scoped'
  | 'temporal-scoped';

/** Which half of the eval set a query belongs to. Tuning reads `dev` only. */
export type EvalSplit = 'dev' | 'holdout';

/**
 * For a temporal query, which clock the `as_of` is testing:
 *   - `world`  — what was true then (`valid::` intervals on fact edges);
 *   - `system` — what was believed then (`at::` / `superseded::`).
 */
export type TemporalAxis = 'world' | 'system';

/**
 * A gold group: a passage id, or an array of ids meaning "any of these counts".
 * A group counts once, at the rank of its first member (see metrics.ts).
 */
export type ExpectedGroup = string | string[];

/** One line of `eval/queries.jsonl`. */
export interface EvalQuery {
  id: string;
  query: string;
  kind: EvalKind;
  /** ISO date/datetime; parsed with the vault's own time parser. */
  as_of?: string;
  temporal_axis?: TemporalAxis;
  /**
   * Gold groups. A plain string is a single-member group; an array is an
   * any-of group. A group counts once, at the rank of its first member.
   */
  expected_passages: ExpectedGroup[];
  /** passage ids that must NOT be retrieved (trust / temporal-absence checks). */
  expect_absent?: string[];
  /**
   * Ordering constraints: `[a, b]` means `a` must rank above `b`, or `b` must be
   * absent. Reported as `orderViolations`; not a hard gate.
   */
  expect_before?: [string, string][];
  /**
   * For an `expect_absent` check: the id of a query whose results must retrieve
   * the absent passage. If the paired query does not retrieve it, the absence
   * check is `vacuous` (it proves nothing) and is counted separately.
   */
  paired_with?: string;
  /**
   * The note the query is expected to seed. Used by fixture tests to prove a
   * path exists (or does not) between the seed and the target.
   */
  seed?: string;
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
  /**
   * RRF seed provenance for the query. `via` includes `'vector'` when the dense
   * path contributed a seed list, so a test can prove the vector path ran. Not
   * part of the portable baseline (`toBaseline` projects only hits + metrics).
   * Optional so hand-built test doubles need not supply it.
   */
  seeds?: { nodeId: string; score: number; via: string[] }[];
  metrics: EvalMetrics;
  /** hits whose passage id is in `expect_absent` (should be 0). */
  absentViolations: number;
  /** `expect_before` pairs violated (should be 0). */
  orderViolations: number;
  /** trust-gate violations: a low-trust passage returned under a higher floor. */
  trustViolations: number;
  /** `expect_absent` checks whose paired query did not retrieve the passage. */
  vacuousAbsences: number;
  /**
   * Gold ids this query names (`expected_passages`, `expect_absent`, `expect_before`)
   * that are not passages in the built index. A non-empty list means the query can
   * never score, so the CLI fails the run unless `--allow-missing` is passed.
   */
  missingIds: string[];
}

/** Aggregated metrics for one group of results. */
export interface EvalAggregate {
  group: string;
  count: number;
  recallAtK: Record<string, number>;
  precisionAtK: Record<string, number>;
  mrr: number;
}

/** The whole run. `failed` is true only on a trust-gate violation. */
export interface EvalReport {
  fixtureHash: string;
  config: Config;
  results: EvalQueryResult[];
  aggregates: EvalAggregate[];
  /** total trust-gate violations across all queries (the hard gate). */
  trustViolations: number;
  /** total expect_absent violations across all queries. */
  absentViolations: number;
  /** total expect_before violations across all queries. */
  orderViolations: number;
  /** total expect_absent checks that proved nothing (paired query missed). */
  vacuousAbsences: number;
  /** union of every query's `missingIds`, sorted. */
  missingIds: string[];
  failed: boolean;
}

/** A named config variant for an ablation run. */
export interface AblationSpec {
  name: string;
  description: string;
  config: Config;
}
