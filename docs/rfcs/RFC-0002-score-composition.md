# RFC-0002: How graph and lexical scores combine

Status: proposed · 2026-09-30 · written against `5308e0e` (RFC-0001 Stage 4)

## Summary

Recall today can't surface a passage that is reached only through the graph. The graph
score is PageRank mass divided by the maximum mass, and the maximum always belongs to the
seed passages, because they hold the restart mass. A fact target, a multi-hop answer or a
dream target scores about 0.01 against a seed's 1.0, so it never reaches the top 5,
whatever its edge weight.

This RFC proposes two changes, measured with a prototype against the Phase 7 eval:

1. **Rank fusion.** Rank passages by reciprocal rank fusion (RRF) of two lists: the seed
   ranking, and the ranking by *propagated* mass (PageRank minus the restart mass each
   seed injects). This replaces dividing raw PageRank mass by its maximum.
2. **Fact-target expansion.** When a `#facts` passage is a hit, place the targets of its
   currently valid fact edges directly after it. Edges are filtered by the same
   bi-temporal rules the graph uses, and ordered by how well the predicate matches the
   query.

On the fixture, together (hipporag mode; auto is the same except where noted):

- **Temporal recall** goes from 0.17 / 0.50 to **1.00 / 1.00** (dev / holdout). Vacuous
  absence checks drop from **6 to 0** with no absence violations, so the eval can now show
  that as-of filtering is correct end to end.
- **Multi-hop** goes from 0.17 / 0.00 to **0.33 / 0.50**. In auto it goes to 0.17 / 0.50:
  auto stays in wikilink mode for some multi-hop queries, where there are no fact edges to
  expand.
- The **tea/coffee ordering failure is fixed** (order violations 1 → 0).
- **Single-hop and preference stay at 1.00.** Trust violations stay at 0.
- **The cost:** holdout MRR falls from 0.377 to 0.339 (0.349 in auto) while dev MRR rises.
  That's a real trade-off and needs a human decision.

It does **not** make remote associations surface: they stay at 0.00 under every variant
tried. That changes what RFC-0001 should aim for (see
[Consequences for dreaming](#consequences-for-dreaming)).

## Background: the diagnosis

`runRung()` in `src/retrieval/recall.ts` scores each passage as:

```
score = w.graph × (ppr(p) / max ppr) + w.activation × activation + w.importance × importance
```

`personalizedPageRank()` computes `p = (1 − d)·s + d·Wᵀp`. The `(1 − d)·s` term puts half
the mass (at `damping` 0.5) back on the seeds every iteration, so the maximum is always a
seed passage. Everything else is divided by that seed's mass.

Evidence from the fixture:

| Query | Target | Target's graph component | Target rank |
| --- | --- | --- | --- |
| "which tool does the beta project run on" (typed) | `greenhouse-controller#0`, one fact hop | 0.040 | 69 |
| "what does the alpha project run on" (typed) | `old-laptop#0`, one fact hop | 0.012 | 161 |
| "weathervane anemometer", dream edge weight 1 | `lighthouse-foghorn#0`, one dream hop | 0.007 | 143 |
| same, dream edge weight 50 | same | 0.005 | 148 |

The top hit's graph component is 1.0 in every case. A reached passage's ranking therefore
falls to activation and importance, which don't know about the query. This explains three
Phase 7 findings at once:

- raising `originWeights.fact` from 0.5 to 10 changed nothing;
- coffee outranks tea (tea sits one fact edge from Sam; coffee is an unlinked lexical twin
  of it); and
- RFC-0001's dream-weight sweep was completely flat.

A second, smaller cause is **seed crowding.** "What does the alpha project run on" gets
21 seeds, and every project's `#facts` passage matches "run on" because it contains
`runs_on`. Those seeds fill the top 5 before any graph-reached passage can compete.

## Experiments

A scratch copy of `src/` added a scoring switch and an expansion switch to `runRung()`.
Nothing was committed. Every run used the Phase 7 fixture and query set at `5308e0e`,
through `runEval`. The table shows macro recall@5 over the six unscoped kinds, as the
tuner defines it.

| Variant | Mode | dev macro | holdout macro | dev MRR | holdout MRR | order | vacuous |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **v0** current (PPR / max) | auto | 0.389 | 0.417 | 0.373 | 0.377 | 1 | 6 |
| **v1** 0.5 × seed + 0.5 × propagated, each max-normalized | auto | 0.389 | 0.375 | 0.342 | 0.363 | 1 | — |
| **v2** RRF(seed rank, propagated rank), k = 60 | auto | 0.389 | 0.417 | 0.373 | 0.325 | **0** | — |
| **v3** log-scaled PPR | auto | 0.365 | 0.375 | 0.311 | 0.325 | 0 | — |
| **v4** HippoRAG-style: seeds moved onto notes | auto | 0.317 | 0.333 | 0.241 | 0.322 | 1 | — |
| v0 + seed limit 5 or 10 | auto | 0.389 | 0.417 | ≈ | ≈ | 1 | — |
| v0 + expansion | auto | 0.500 | 0.500 | 0.433 | 0.417 | 1 | — |
| **v2 + expansion (proposed)** | auto | **0.528** | **0.583** | 0.411 | 0.349 | **0** | **0** |
| **v2 + expansion (proposed)** | hipporag | **0.556** | **0.583** | 0.417 | 0.339 | **0** | **0** |

Per kind, proposed vs current, hipporag mode, recall@5 (dev / holdout):

| Kind | Current | Proposed |
| --- | --- | --- |
| single-hop | 1.00 / 1.00 | 1.00 / 1.00 |
| preference | 1.00 / 1.00 | 1.00 / 1.00 |
| multi-hop | 0.17 / 0.00 | 0.33 / 0.50 |
| temporal | 0.17 / 0.50 | 1.00 / 1.00 |
| remote 2-hop | 0.00 / 0.00 | 0.00 / 0.00 |
| remote 3-hop | 0.00 / 0.00 | 0.00 / 0.00 |
| multi-hop-scoped | 1.00 / 1.00 | 1.00 / 1.00 |
| temporal-scoped | 1.00 / 1.00 | 1.00 / 1.00 |

What the variants show:

- **No scoring variant alone moves recall@5.** RRF (v2) fixes the ordering failure and
  lifts reached passages by a lot (the greenhouse controller goes from rank 69 to 31), but
  seed crowding still keeps them out of the top 5. Rescaling (v1, v3) and HippoRAG-style
  seeding (v4) are neutral or worse. v4 costs single-hop badly, because the seed passages
  lose their restart mass.
- **Expansion is what moves recall,** and it needs RRF to keep the ordering fix. Early
  versions of expansion took a note's first two fact edges in file order and missed. It
  works once edges are filtered to those valid at the query time (`asOf`, or now) and
  ordered by predicate match: "maintainer" picks `maintained_by`.
- **Expanding from any top-3 hit's note,** not only from `#facts` hits, raised remote
  recall a little when associations had been accepted as facts (dev typed: 2-hop 0.33,
  3-hop 0.17), but lost 0.08 macro on holdout. It's rejected.

**Honesty about the evidence.** The expansion ordering rule was designed after looking at
why the dev multi-hop query `q-mh-pref` failed. Holdout agrees (macro 0.417 → 0.583), but
holdout has only two queries per kind. The personal-vault eval has to confirm this before
any default changes.

## Proposal

### 1. Rank fusion in `runRung()`

```
restart(p)    = (1 − d) × seed(p) / Σ seed        (0 for non-seeds)
propagated(p) = max(0, ppr(p) − restart(p))
seedRank      = rank of p among passages with seed(p) > 0
propRank      = rank of p among passages with propagated(p) > 0
fused(p)      = Σ over the lists p appears in of 1 / (k + rank)
graph(p)      = fused(p) / max fused                   ← replaces ppr(p) / max ppr
```

- `k` defaults to 60, following common RRF practice and the seed fusion that already
  exists in `recall()`.
- `score` keeps its shape: `w.graph × graph + w.activation × activation + w.importance ×
  importance`.
- `components.graph` changes meaning, from normalized mass to normalized fused rank. Add
  `components.propagated` (normalized propagated mass) so the old signal stays inspectable.
- This is a score-component change under AGENTS.md §6.3 and needs an ADR and a
  RETRIEVAL.md update.

### 2. Fact-target expansion

After ranking and before the token budget is applied, walk hits in order. After each hit
whose passage is a `#facts` passage:

1. Take its note's `fact` edges that pass `edgeAllowed(e, asOf, cfg)` (trust floor,
   supersession, system time) **and** are valid in world time at `asOf ?? now`. Today,
   `edgeAllowed` keeps ended-but-true history for now-queries. That's right for graph
   traversal, but wrong for "what does X run on now".
2. Order the edges by the number of query tokens that match the predicate's parts
   (`maintained_by` → `maintain`, `by`), after light suffix stripping; ties keep index
   order.
3. For up to `retrieval.factExpansion.perHit` (default 2) targets, insert the target note's
   first passage, then its `#facts` passage if one exists. Skip any already placed.
4. Mark each inserted hit `via: "fact-expansion"`, with the predicate that brought it.
   `renderForContext()` shows that, so the agent can see why a passage is there.

Rules:

- Only in modes whose origins include `fact` (typed, hipporag).
- **Never along `dream`, `triple`, `synonym` or `link` edges.** Expansion is for claims the
  user or consolidation asserted, not for associations.
- Only passages already in the candidate set are inserted, so trust and scope filters have
  already applied. A test must prove that an out-of-scope or below-floor target is never
  inserted.

### Config

| Key | Default | Meaning |
| --- | --- | --- |
| `retrieval.scoring` | `"ppr-max"` during rollout, `"rrf"` after the decision | Which graph composition `runRung()` uses |
| `retrieval.rrfK` | `60` | RRF constant |
| `retrieval.factExpansion.enabled` | `false` during rollout | Fact-target expansion |
| `retrieval.factExpansion.perHit` | `2` | Targets inserted per `#facts` hit |

## Consequences for dreaming

No scoring or expansion variant made a remote-association target reach the top 5. That
held with true dream edges at any weight, and with the true associations written into the
vault as accepted `related_to` facts. The top 5 for "weathervane anemometer" belongs to
passages about the weathervane. That's arguably correct: a user asking about the
weathervane mostly wants the weathervane.

So for RFC-0001:

- **Stage 5 records a flat sweep and dreams stay at weight 0,** as that RFC already
  provides.
- **Top-5 recall is probably the wrong measure for associations.** A better fit may be a
  separate, labeled channel: recall returns its top k plus up to *n* "associated notes"
  reached through accepted `related_to` facts (and, if ever turned on, dream edges), each
  marked with how it was reached. That would get its own eval kind, measured on that
  channel rather than in competition with direct answers. It would be RFC-0003. It isn't
  proposed here.

## Related finding, out of scope

**MCP recall never uses vector seeds.** `src/mcp/server.ts` calls `recall()` without
`queryEmbedding`, and so does `runEval()`. Only the CLI embeds the query. An agent using
Circadia over MCP therefore gets keyword and entity seeds only, even with embeddings
configured, and the eval doesn't measure the dense path at all. This is a bug fix, not a
design change: embed the query in the MCP handler when `embeddings.provider` is set, and
let `runEval` embed with the trigram client. It should be fixed before this RFC's
personal-vault evaluation, or that evaluation measures a path agents don't use.

## Rollout

1. **ADR-0012 and flags.** Record the score-component change. Add `retrieval.scoring`,
   `retrieval.rrfK` and `retrieval.factExpansion.*`, all defaulting to current behavior.
   - *Gate:* the Phase 7 baseline shows 0 deltas.
2. **Rank fusion behind the flag.** Add the `propagated` component and tests: restart mass
   is removed; a seed-only passage and a reached-only passage both get a fused score; the
   tea/coffee ordering holds.
   `test/integration.test.ts` › "now-queries drop superseded fact edges unless
   includeSuperseded" asserts on the raw `graph` component. Under fusion it must assert on
   `components.propagated` instead (the prototype failed that test for exactly this reason).
   - *Gate:* default-off baseline has 0 deltas; flag-on numbers reported.
3. **Fact expansion behind the flag.** Tests:
   - as-of correctness: an expired target is never inserted, and a future target is
     never inserted;
   - scope and trust: out-of-scope or below-floor targets are never inserted;
   - no expansion along dream, triple, synonym or link edges;
   - `via` marking and rendering;
   - the per-hit cap.
   - *Gate:* flag-on eval reproduces this RFC's numbers within noise, and vacuous
     absences are 0.
4. **The MCP and eval vector-seed fix** (separate PR, see above).
5. **Measure on a personal vault, then decide.** Run the private eval with both flags on
   and off.
   - Turn on only if no kind regresses on either split of either tier, and trust and
     absence violations stay at 0.
   - The holdout MRR drop is a named, human decision.
   - Changing a retrieval default is the one step that can't easily be undone, so it
     happens in its own commit, with its own ADR entry.

## Open questions

1. **RRF `k`.** 60 is conventional, not tuned. The tuner can sweep it within its no-kind-
   regression rule.
2. **Holdout MRR.** RRF moves some top-1 hits to rank 2 on holdout. Is recall@5 or MRR
   the objective for an agent that reads the top 5 anyway?
3. **The expansion ordering rule.** Predicate-token matching with suffix stripping is
   crude and was designed against dev failures. Should edge recency, the edge's `conf`, or
   a small predicate synonym list (in `predicates.defs`) replace or join it?
4. **Seed crowding.** Every `#facts` passage matches its own predicate names ("run on"
   hits all `runs_on` lines). Should predicate text be down-weighted or excluded from the
   keyword index, since the predicate's meaning is already in the graph?
5. **An associations channel** (see Consequences for dreaming): RFC-0003, or part of
   RFC-0001's follow-up?

## Appendix: reproducing the prototype

The prototype was a scratch copy of `src/`, never committed. Its changes, all confined to
`runRung()`:

- compute `restart`, `propagated`, the two rank lists and `fused` as in the Proposal, and
  use `fused / max fused` as `graph` when `SCORE_VARIANT=v2`;
- after sorting, run the expansion walk above: `#facts` hits only; edges filtered by
  `edgeAllowed` plus world-time validity at `asOf ?? now`; ordered by predicate-token
  overlap; at most 2 targets, each followed by its `#facts` passage when present; only
  passages already in the candidate set.

With both switches on, the full suite passed except three tests. Two are the baseline
tests, which are expected to fail until a refresh. The third is the `components.graph`
assertion noted in Rollout step 2.
