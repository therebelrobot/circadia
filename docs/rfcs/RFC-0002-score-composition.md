# RFC-0002: Entity-anchored fact expansion

Status: proposed · 2026-09-30 · measured against `1bb6a8a` (vector seeds wired into MCP and eval)

Replaces an earlier draft titled "How graph and lexical scores combine". That draft's
numbers were measured before vector seeds reached the eval, and they don't hold on the
current baseline (see [History](#history-of-this-rfc)).

## Summary

Recall can't surface a passage that is reached only through the graph. When a query names
an entity ("what does the alpha project run on"), the answer is one fact edge away. Today,
that answer ranks 69th to 161st and never reaches the top 5.

This RFC proposes **entity-anchored fact expansion**. When a hit belongs to a note the query
names (a cue entity), recall places that note's `#facts` passage next, then the targets of
its facts that are valid at the query time. It adds one step after ranking, and it doesn't
change scoring.

Prototyped against the Phase 7 eval at `1bb6a8a`, auto mode (dev / holdout):

| | Current | Proposed |
| --- | --- | --- |
| Macro recall@5 (six unscoped kinds) | 0.361 / 0.417 | **0.556 / 0.500** |
| MRR | 0.328 / 0.443 | **0.368 / 0.465** |
| Temporal recall@5 | 0.17 / 0.50 | **1.00 / 1.00** |
| Multi-hop recall@5 | 0.00 / 0.00 | **0.33 / 0.00** (hipporag: 0.50 / 0.00) |
| Single-hop, preference | 1.00 / 1.00 | 1.00 / 1.00 |
| Vacuous absence checks | 6 | **0** |
| Trust / order / missing violations | 0 / 0 / 0 | 0 / 0 / 0 |
| Absence violations | 1 | 1 (the same known scoped case) |

- **No kind regresses**, in any mode, on either split. Forced typed and hipporag also gain
  single-hop holdout (0.75 → 1.00).
- **MRR rises on both splits.** The earlier draft's rank-fusion change cost holdout MRR;
  this one doesn't need it.
- **Accepted associations now surface.** When RFC-0001's dream associations are accepted
  into the vault as `related_to` facts, remote-association recall rises from 0 to between
  0.33 and 0.67 (see [Consequences for dreaming](#consequences-for-dreaming)).

## Background

**Why graph-reached passages lose.** `runRung()` scores
`w.graph × ppr(p) / max ppr + w.activation × activation + w.importance × importance`.
The PageRank maximum always belongs to a seed passage, because seeds hold the restart
mass `(1 − d)·s`. A passage one fact edge from a seed gets a graph component of about
0.01–0.04 against a seed's 1.0. The seeds, many of them lexical matches for other
entities ("run on" matches every project's `runs_on` line), then fill the top 5.

**What changed with vector seeds.** Wiring the query embedding into MCP and eval
(`fd12997`) changed the seed mix.
- It fixed the tea/coffee ordering failure on its own. The earlier draft needed rank
  fusion for that.
- It also moved prose passages (`#0`) above facts passages in the seed ranking.

That second change broke the earlier draft's expansion rule, which fired only on
`#facts` hits. With `#facts` passages lower, expansion fired from *other* entities' facts
instead (Cy's and Dee's preferences for a question about Gus) and crowded out the right
answer.

**The fix is to anchor expansion on the query's subject,** not on whichever facts
passage ranks highest. `recall()` already computes the query's cue entities
(`cueEntities()`, the entity seed list). Those name the subject.

## Proposal

After ranking, and before the token budget is applied, walk the hits in order. On the
**first** hit whose note is a cue entity of this query, and only for modes whose origins
include `fact` (typed, hipporag):

1. **Insert the note's `#facts` passage** right after the hit, if it has one and it isn't
   already placed.
2. **Choose fact edges.** Take the note's `fact` edges that:
   - pass `edgeAllowed(e, asOf, cfg)`: trust floor, supersession, system time; and
   - are valid in world time at `asOf ?? now`. For now-queries, `edgeAllowed` keeps
     ended-but-true history. That's right for traversal, but wrong for "what does X run
     on now".
3. **Order them** by how many query tokens match the predicate's parts after light
   suffix stripping (`maintained_by` matches "maintainer"). Ties keep index order.
4. **Insert targets.** For up to `retrieval.factExpansion.perHit` targets (default 2),
   insert the target note's first passage, then its `#facts` passage if present, skipping
   anything already placed.
5. **Mark every inserted hit** `via: "fact-expansion"` with the predicate that brought
   it. `renderForContext()` shows it, so the agent can see why the passage is there.

Each cue entity expands once per query.

**Invariants** (each needs a test):

- Only `fact` edges. **Never** `dream`, `triple`, `synonym` or `link` edges. Expansion
  follows claims the user or consolidation asserted, not associations.
- Only passages already in the candidate set are inserted, so the trust floor and the
  recall scope have already applied.
- An expired or future fact target is never inserted for an as-of query. The eval's
  6 → 0 vacuous absences depend on this.
- No new score component. `components` keeps its current shape. Inserted hits keep their
  own components; only their position changes.

**Config** (in `DEFAULT_CONFIG`, validated, with CONFIG.md rows):

| Key | Default | Meaning |
| --- | --- | --- |
| `retrieval.factExpansion.enabled` | `false` during rollout | Turn expansion on |
| `retrieval.factExpansion.perHit` | `2` | Fact targets inserted per cue entity |

## Experiments

These came from a scratch copy of `src/` with switches in `runRung()`; nothing was
committed. They ran against the Phase 7 fixture and query set at `1bb6a8a` through
`runEval`, with trigram embeddings for passages and queries.

Macro recall@5 over the six unscoped kinds, with MRR in brackets (dev / holdout):

| Variant | auto | typed | hipporag |
| --- | --- | --- | --- |
| current | 0.361 / 0.417 (0.328 / 0.443) | 0.361 / 0.375 (0.307 / 0.402) | 0.361 / 0.375 (0.336 / 0.431) |
| rank fusion (RRF of seed and propagated rank) | 0.417 / 0.417 (0.272 / 0.333) | 0.389 / 0.375 (0.248 / 0.298) | 0.417 / 0.375 (0.272 / 0.327) |
| RRF + expansion from any `#facts` hit | 0.472 / 0.417 (0.300 / 0.343) | 0.500 / 0.375 (0.280 / 0.299) | 0.500 / 0.375 (0.304 / 0.328) |
| RRF + entity-anchored expansion | 0.528 / 0.417 (0.318 / 0.352) | 0.528 / 0.417 (0.298 / 0.337) | 0.556 / 0.417 (0.324 / 0.366) |
| **current scoring + entity-anchored expansion** | **0.556 / 0.500 (0.368 / 0.465)** | **0.583 / 0.500 (0.352 / 0.453)** | **0.583 / 0.500 (0.381 / 0.482)** |

What the table shows:

- **Rank fusion no longer earns its place.** It helps macro recall a little and costs MRR
  on both splits. Its one clear win in the earlier draft, the tea/coffee ordering, now
  comes from vector seeds.
- **Expanding from any `#facts` hit** costs preference recall on dev (1.00 → 0.83),
  because other people's facts expand.
- **Entity anchoring is what makes expansion safe.** It is the only variant with no kind
  regression.

## Consequences for dreaming

RFC-0001 stays as decided: dream edges at weight 0. The flat sweep's cause (restart-mass
normalization) is unchanged by this RFC, and remote-association recall stays at 0.00 with
dream edges alone.

The path that does work is the one RFC-0001 made the only route into memory: a human
accepts a dream in `circadia review`, which writes `related_to:: [[b]]` on note `a`. With
the fixture's true associations written as accepted facts, same fixture, remote recall@5
(dev / holdout):

| | auto | hipporag |
| --- | --- | --- |
| Current, accepted facts present | 0.00 / 0.00 (2-hop), 0.00 / 0.00 (3-hop) | same |
| **Proposed, accepted facts present** | **0.50 / 0.00** (2-hop), **0.33 / 0.50** (3-hop) | **0.67 / 0.50** (2-hop), **0.50 / 0.50** (3-hop) |

Macro recall rises to 0.694 / 0.583 (auto) and 0.778 / 0.667 (hipporag), with no kind
regressing.

That's a mechanism result: the fixture's accepted associations are true by construction.
But it confirms the design: **dreams earn their place in recall through review, not
through edge weight.** An associations channel (the earlier draft's "RFC-0003") is no
longer needed for accepted associations. It stays an option only for *unconfirmed* ones.

## Rollout

1. **Flag and config.** Add `retrieval.factExpansion.*`, off by default.
   - *Gate:* the Phase 7 baseline shows 0 deltas.
2. **Implement behind the flag.** Code in `runRung()`, or a small `expandFacts()` helper
   it calls. `recall()` passes `entities` to `runRung()`; the prototype passed them through
   an environment variable, which the real code must not do. Tests, one per invariant:
   - fact edges only (a `related_to` target is inserted; a `link`, `triple`, `dream` or
     `synonym` neighbour is not);
   - as-of correctness (expired and future targets are never inserted);
   - trust floor and scope respected;
   - each cue entity expands once;
   - the per-hit cap holds;
   - `via` marking, and how `renderForContext()` shows it.
   - *Gate:* flag-on eval reproduces this RFC's numbers within noise; vacuous absences
     are 0; no kind regresses on either split in any mode.
3. **Measure on a personal vault.** Run the private eval with the flag on and off.
   - Turn on only if no kind regresses on either split of either tier, and trust and
     absence violations don't rise.
   - Flipping the default is a human decision in its own commit, with a line in
     RETRIEVAL.md. It's the one change here that can't easily be undone.

## Open questions

1. **A total cap.** One cue entity can insert up to 1 + 2 × 2 = 5 passages, the whole
   top 5 at default settings. That's fine for "what does X run on", but maybe too much when
   a query names two entities. Should inserted passages be capped at, say, half of `topK`?
   The eval can measure it.
2. **The predicate-ordering rule** was designed against dev failures. Holdout agrees, but
   it's crude. A per-predicate synonym list in `predicates.defs` would be less brittle.
3. **Auto mode.** Expansion needs `fact` edges, so an auto query that stays in wikilink
   mode gets none. Should a cue entity with facts be an escalation signal on its own?
4. **Seed crowding.** Predicate names in `#facts` passages ("runs_on") match many queries
   lexically. Should the keyword index skip predicate names, since the graph already
   carries them?
5. **Restart-mass normalization** remains the reason graph-only neighbours can't rank.
   That matters for unconfirmed dream edges and for triple paths, and it's left for a
   later RFC if one of those becomes worth pursuing.

## History of this RFC

The first draft (same day) proposed rank fusion plus expansion from any `#facts` hit,
measured before vector seeds reached the eval: temporal 0.17 / 0.50 → 1.00 / 1.00 at a
cost of holdout MRR. After `fd12997`, the same proposal gains nothing on holdout macro
recall, loses MRR on both splits, and regresses preference on dev. The entity-anchored
version replaces it.