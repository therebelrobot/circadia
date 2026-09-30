# ADR-0009: Access-log compaction does not rotate the raw log

**Status:** accepted (2026-09-30)

## Context

`.circadia/access.jsonl` is append-only and grows without bound. Phase 6 added
`circadia access-log compact`, which rolls events into per-node summaries
(`.circadia/index-access-summaries.jsonl`) so ACT-R base-level activation can be computed
without scanning every event. The first implementation had three defects (C14):

1. Recall used the summaries **instead of** the raw log, so accesses logged after the last
   compaction were ignored and activation stopped learning.
2. The as-of filter was applied to raw events but not to summaries, so `--as-of` activation
   included future accesses (violating ARCHITECTURE §8).
3. `summariesToPresentations` returned `[first, ...last10]`, discarding `count`, so the
   frequency term was lost and the "optimized-learning approximation" the roadmap names was
   never implemented.

The remaining question is whether compaction should also **rotate** (truncate) the raw log
to bound its growth.

Two invariants constrain the answer:

- **The raw log is not derivable** (AGENTS.md §4). The vault, `.circadia/access.jsonl`, and
  `.circadia/triples/` are the only non-derivable state. Summaries are a derived cache.
- **As-of activation must be exact** (ARCHITECTURE §8, RETRIEVAL §5). A summary aggregates
  every event up to its watermark; it cannot answer a query dated *before* that watermark,
  because the individual timestamps are gone.

## Decision

**Compaction does not rotate or truncate the raw log.** It writes summaries and leaves
`access.jsonl` intact.

The summaries file records a `{"kind":"meta","version":3,"watermark":…,"offset":…}` line.
`watermark` is the timestamp up to which the summary accounts for events; `offset` is the
raw log's byte length at that point. Recall combines a node's summary with the raw events
that post-date the watermark, both filtered to `≤ asOf`:

- `asOf === null` or `asOf ≥ watermark`: use the summary (optimized-learning form) plus the
  raw log **read from `offset`** — only the tail, so compaction bounds the per-query cost
  instead of re-parsing the whole log.
- `asOf < watermark`: ignore the summary and read the **whole** log, because a summary
  cannot un-aggregate. The events are still there because the log was not rotated.

The compacted part uses ACT-R's optimized-learning form
`B ≈ ln(n / (1 − d)) − d·ln(L)` (implemented as `optimizedLearningSum` in
`src/retrieval/activation.ts`); the recent part keeps exact `t^(−d)` terms.

If a user needs to bound disk usage, they archive the log manually — copying it somewhere
first, since it is not derivable. Compaction will not do it for them.

## Consequences

- **As-of correctness is preserved.** A query dated before the watermark still sees the
  exact events, because the raw log is intact.
- **The log keeps growing.** This is accepted: it is one line per returned hit, it is the
  only non-derivable usage record, and it is the audit trail for reconsolidation. Bounding
  it is a manual, backed-up operation, not an automatic one.
- **Activation cost is bounded for "now" queries**: recall reads only the tail from the
  recorded byte offset, so the per-query cost is proportional to the events logged since the
  last compaction, not to the whole log. An as-of query before the watermark still scans the
  whole log. That is the price of exactness.
- **The summaries are a pure cache.** Deleting `.circadia/index-access-summaries.jsonl` and
  re-running `access-log compact` reproduces it from the raw log, so it is safe to lose.
- If a future phase versions the access log in git (an open question in ROADMAP), rotation
  could be revisited, because the history would then be recoverable.
