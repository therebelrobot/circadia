# src/dreams: the REM pass and wake recall (Phase 8, contract)

RFC-0001. See `docs/ARCHITECTURE.md` §10, `docs/ROADMAP.md` Phase 8, and
`docs/decisions/ADR-0011-dreaming-disposable-state.md`.

## Pipeline

```
recent side   highest ACT-R activation over dreaming.recentDays (read-only access log)
  → remote side   a partner ≥ dreaming.minHops away over non-dream origins, PPR-weighted
                  toward low mass; dreaming.noiseShare uniformly random older notes
  → propose       one passage per note → extraction model (chatComplete, fenced as data)
  → ground        quotes must appear verbatim (≥ 12 chars, distinct) and the gist is
                  ≤ 200 chars, else pruned
  → score         salience = hopsNorm × confidence × activationNorm
  → record        every sample → log/<night>.json; kept → candidates.jsonl
```

`circadia dream [--dry-run | --sample-only]` runs the pass; `circadia consolidate --dream`
runs consolidation, then its commit, then the pass. `circadia wake [--json]` reads the log
once and forgets it.

## Invariants (must have tests)

- The pass writes only under `.circadia/dreams/`. It never writes the vault.
- The pass never appends to `access.jsonl` (no false familiarity).
- Notes below `dreaming.trustFloor` are never sampled.
- Passage text is fenced with `fenceData(text, 'passage-data')`; `wake` output is fenced as
  `<untrusted-data source="dreams">` with the one-line summary and the narration rules
  outside the fence (they are Circadia's judgment and instructions, not model output).
- The pass refuses to run when `.circadia/dreams/` is not git-ignored, or when anything under
  it is tracked.
- Re-running a night is a no-op: candidate ids are `d-<night>-<hash(a, b)>` and existing ids
  are skipped. The log records `ranAt`, and a re-run reuses it for the recent-side scoring
  window, so the same pairs are sampled even hours later.
- A model timeout or malformed response prunes that sample; the pass never retries in a loop
  and never fails `consolidate`.
- A `gist` over 200 characters is pruned, and its text is dropped from the fragment.
- `wake` deletes the log on read; a second call reports nothing left.
- `--dry-run` and `--sample-only` write nothing at all (the C7 rule).
- `--sample-only` samples and prints with `extraction.provider: none`; it never needs a model.
- `relate` never returns a path through a `dream` edge.
- Hop distances, in the pass and in the eval fixture tests, exclude `dream` edges.

## Gate rules

| sample | action |
|---|---|
| model returns `{"association": null}` | pruned (the normal answer) |
| quotes grounded in the cited passages, gist ≤ 200 chars | kept → `candidates.jsonl` |
| quotes missing, too short, or identical | pruned |
| gist over 200 characters | pruned; the gist is dropped from the fragment |
| timeout / malformed response | pruned, error class recorded |
| candidate accepted in `circadia review` | `by:: user` `related_to` fact; no dream edge |
| candidate endorsed / dismissed | state change only; no vault write |
