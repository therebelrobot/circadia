# ADR-0010: Eval harness determinism and read-only guarantees

## Context

Phase 7 adds an evaluation harness (`src/eval/`, `eval/`) so retrieval changes can
be measured rather than asserted. An eval that is not reproducible, or that
mutates the thing it measures, is worse than no eval: it produces numbers that
cannot be compared across runs and can corrupt a vault. The harness also has to
run with zero network access and zero runtime dependencies (AGENTS.md §3.1), and
it must not let a tuning pass silently change production defaults.

## Decision

1. **Determinism contract.** Every run uses a fixed clock (`FIXED_NOW`), never
   logs access (`logAccess: false`), and uses the deterministic trigram lexical
   client instead of the HTTP embeddings client. The fixture is generated from a
   pinned LCG seed. Two runs of the same fixture and query set are byte-identical
   (`test/eval-determinism.test.ts`, `test/eval-fixture.test.ts`).

2. **Two-tier fixture policy.** Tier A is the generated synthetic fixture
   (`eval/.fixture`), which carries the shapes the eval needs and is rebuilt by
   `npm run eval`. Tier B is any personal vault, run with `embeddings: 'none'`
   when it has no embedding provider. The runner is the same for both.

3. **Read-only guarantee.** The runner builds the index in a temp directory and
   never writes under the vault — not even `.circadia/`
   (`test/eval-readonly.test.ts`). The vault is the source of truth; the index is
   derived.

4. **Trust is a hard gate.** A trust-gate violation is a violation count, never
   averaged into recall. A single violation fails the run and makes the CLI exit
   non-zero. Absence and ordering violations are reported and diffed against the
   baseline but do not fail the run on their own.

5. **Tuning never mutates defaults.** `tuneThresholds` returns a suggested config
   and never writes `DEFAULT_CONFIG` or edits `src/config.ts`. A human applies
   the suggestion by hand (`test/eval-tune.test.ts`).

6. **External sets are holdout.** The LongMemEval and LoCoMo adapters read a
   local file only, are off by default, and always mark their queries `holdout`,
   so tuning can never read them.

## Consequences

- A retrieval change is judged by a diff against `eval/baseline.json`, not by a
  claim. The baseline records the fixture hash, per-query hits and metrics,
  aggregates, and forced-mode aggregates, with absolute paths and timestamps
  stripped so it is portable.
- The trigram client is a lexical stand-in, not a semantic model; vector-seed
  results are a lower bound (see `docs/EVAL.md` §3).
- The harness measures retrieval only. There is no answer model or judge by
  default, so the numbers are not comparable to vendor-reported LongMemEval or
  LoCoMo figures (`docs/SOURCES.md` L14, L15).
- The trust gate is currently unreachable end-to-end: `runRung` filters hits by
  `retrieval.trustFloor` and `countTrustViolations` counts hits below the same
  floor, so the count is always zero. The gate is wired and unit-tested
  (`test/eval-trust.test.ts`); making it fire would require a path that returns a
  below-floor hit, which the filter prevents. This is recorded as a known
  limitation rather than silently "fixed".

## Status

Accepted.
