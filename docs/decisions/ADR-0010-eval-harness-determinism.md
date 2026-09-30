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
- The trust gate recomputes each hit's trust from the index (`nodes.trust` for the
  passage and its source note) rather than reading the value recall reported, so a
  C12-style laundering regression — a synonym edge or path that lifts a low-trust
  passage's trust — is caught even though the filter and the counter would
  otherwise agree. It fires when the filter regresses; it does not depend on the
  filter's own output (`test/eval-trust.test.ts`).
- A gold id that is not a passage in the built index is reported (`missingIds`) and
  fails the run unless `--allow-missing`; a query that can never score is not
  silently averaged as 0.
- Only the generated fixture has a default baseline. A personal vault must name an
  explicit `--baseline` outside the repo, and its output is aggregate-only by
  default, so private note ids never land in the tracked baseline.
- A generated fixture carries a marker (`.circadia-eval-fixture`). A re-run
  replaces the directory only when the marker is present and refuses a non-empty
  directory without it, so a stray file (or a real vault) is never silently
  overwritten. The marker is excluded from `fixtureHash`, so it does not perturb
  the baseline.

## Status

Accepted.
