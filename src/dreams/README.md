# src/dreams: the REM pass and wake recall (Phase 8, contract)

RFC-0001. See `docs/ARCHITECTURE.md` §11, `docs/ROADMAP.md` Phase 8, and
`docs/decisions/ADR-0011-dreaming-disposable-state.md`.

## Pipeline

```
recent side   highest ACT-R activation over dreaming.recentDays (read-only access log)
  → remote side   a partner ≥ dreaming.minHops away over non-dream origins, PPR-weighted
                  toward low mass; dreaming.noiseShare uniformly random older notes
  → propose       one passage per note → extraction model (chatComplete, fenced as data)
  → ground        quotes must appear verbatim (≥ 12 chars, distinct) else pruned
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
  `<untrusted-data source="dreams">` with the narration rules outside the fence.
- The pass refuses to run when `.circadia/dreams/` is not git-ignored, or when anything under
  it is tracked.
- Re-running a night is a no-op: candidate ids are `d-<night>-<hash(a, b)>` and existing ids
  are skipped.
- A model timeout or malformed response prunes that sample; the pass never retries in a loop
  and never fails `consolidate`.
- `wake` deletes the log on read; a second call reports nothing left.

## Gate rules

| sample | action |
|---|---|
| model returns `{"association": null}` | pruned (the normal answer) |
| quotes grounded in the cited passages | kept → `candidates.jsonl` |
| quotes missing, too short, or identical | pruned |
| timeout / malformed response | pruned, error class recorded |
| candidate accepted in `circadia review` | `by:: user` `related_to` fact; no dream edge |
| candidate endorsed / dismissed | state change only; no vault write |
