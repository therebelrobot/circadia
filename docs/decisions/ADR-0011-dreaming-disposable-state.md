# ADR-0011: Dreaming state is disposable; dream edges ship at weight 0

**Status:** accepted (2026-09-30)

## Context

RFC-0001 adds a REM pass to Circadia's night. `circadia consolidate` is the NREM half: it
replays episodes into facts through the schema-fit gate. The REM pass pairs recently active
notes with distant ones, asks the local extraction model whether anything connects them, and
records the answers as *candidate associations* under `.circadia/dreams/`. A human accepts
one in `circadia review`, which writes an ordinary `by:: user` fact; nothing else reaches the
vault.

Three properties of the feature force decisions the existing ADRs do not cover:

1. The pass produces non-derivable state (a log and a candidate queue) that the user never
   asked to keep. AGENTS.md §4 lists the non-derivable state as the vault, `access.jsonl`,
   `.circadia/triples/` and `.circadia/consolidated.json`; dream state is a new category.
2. The state must not be committed to git. Committing it would put every dream in the vault's
   history forever and undo the forgetting the design depends on (D6).
3. Dream associations are unconfirmed. Carrying them into retrieval as if they were
   connections the user wrote would be a confabulation leak — the "Robot Dreams" risk the
   RFC is built around.

## Decision

1. **A disposable state category.** `.circadia/dreams/log/<night>.json` and
   `.circadia/dreams/candidates.jsonl` are non-derivable but **disposable**: losing them loses
   nothing the user asked to keep. They are never committed to git. `circadia init` adds
   `.circadia/dreams/` to the `.gitignore` it writes; for existing vaults the pass refuses to
   run unless `git check-ignore -q .circadia/dreams/candidates.jsonl` exits 0 and
   `git ls-files .circadia/dreams` is empty. The index stays reproducible from the vault plus
   the candidate file.

2. **A new edge origin at weight 0.** The indexer builds `dream` edges from open and endorsed
   candidates (`type: 'association'`, `trust: low`, `weight = salience`). `EdgeOrigin` gains
   `'dream'`; `MODE_ORIGINS` adds it to `typed` and `hipporag`, not `wikilink`;
   `graph.originWeights.dream` defaults to **0**. `addEdge()` drops weight ≤ 0, so at the
   default the edges are in the index and in no PageRank graph. `relate` excludes `dream`
   always, because it finds paths by BFS and ignores weights — a path through an unconfirmed
   dream presented as "how these notes are connected" is exactly the leak this design
   prevents. No DDL change, so `INDEX_SCHEMA_VERSION` is not bumped; dream edges are rebuilt
   from the candidate file on every index.

3. **Confirmation is CLI-only.** The MCP surface is `wake`, `endorse_dream` and
   `dismiss_dream`. `endorse_dream` sets a candidate's state and writes nothing in the vault;
   `dismiss_dream` removes. Only `circadia review`, with a human at the keyboard, writes the
   accepted `related_to` fact. This follows the remediation rule that `remember` refuses
   `by: user`: an agent reading hostile text must not be able to mint trusted memories.

## Consequences

- Dream state is lost on a fresh checkout, by design. A re-run of a night re-samples the same
  pairs (the seed is the night's local date) and skips candidate ids already present, so
  losing the queue costs at most the un-reviewed candidates.
- Losing dream state also loses rejections and dismissals, so after a fresh checkout a pair
  the user rejected can be proposed again. That is acceptable for a disposable queue, but it
  is written down here: if it ever becomes annoying, a small rejected-pair list is the one
  piece of dream state worth keeping.
- At the default weight 0, dreaming changes no ranking. Wake recall and review still deliver
  value, because an accepted association becomes a `fact` edge. Turning dreams on is a
  separate, measured decision (RFC-0001 Stage 5) and is not made by this ADR.
- The gitignore check is a runtime refusal, not a silent skip, so a vault that would leak
  dreams into git fails loudly with a one-line fix.
- `relate` output is unchanged by dreaming, and the eval fixture's hop-distance tests exclude
  `dream`, so a planted candidate cannot make its own pair look close.

## Status

Accepted.
