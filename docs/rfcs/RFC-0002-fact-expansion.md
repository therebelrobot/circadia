# RFC-0002: Entity-anchored fact expansion

Status: proposed · 2026-10-01 · measured against `1bb6a8a` (no `src/` or `eval/` changes since,
checked at `a86f374`) · revised after delivery triage

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
4. **Insert targets.** For up to `retrieval.factExpansion.perHit` targets (default 1),
   insert the target note's first passage, then its `#facts` passage if present, skipping
   anything already placed. Stop when the query has inserted
   `retrieval.factExpansion.maxInserted` passages in total (default 3).
5. **Mark every inserted hit** with
   `via: { kind: 'fact-expansion', from: <cue entity note id> }` (the contract is in
   [Architecture answers](#architecture-answers)). The fact target also carries
   `predicate: <predicate>`. The entity's own `#facts` passage is inserted before any
   single predicate is chosen, so it has no `predicate`; omitting the field is honest,
   where a sentinel would name a predicate that doesn't exist.
   `renderForContext()` shows it, so the agent can see why the passage is there.

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
| `retrieval.factExpansion.enabled` | `false` during rollout | Turn expansion on. This config key is the feature flag; Circadia has no flag service |
| `retrieval.factExpansion.perHit` | `1` | Fact targets inserted per cue entity |
| `retrieval.factExpansion.maxInserted` | `3` | Passages one query may insert in total |

## Experiments

These came from a scratch copy of `src/` with switches in `runRung()`; nothing was
committed. They ran against the Phase 7 fixture and query set at `1bb6a8a` through
`runEval`, with trigram embeddings for passages and queries.

Macro recall@5 over the six unscoped kinds, with all-kinds overall MRR in brackets (dev / holdout):

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

### Choosing the caps

The first version allowed up to 5 inserted passages per cue entity, enough to fill the
top 5 of a query. The caps were measured on both fixtures (plain, and with accepted
associations), in auto and hipporag:

| perHit | maxInserted | Result |
| --- | --- | --- |
| 2 | unlimited | the numbers above |
| 2 | 4 | identical |
| 2 | 3 | identical |
| **1** | unlimited | **identical** |
| 2 | 2 | multi-hop dev drops (0.33 → 0.17 auto; 0.50 → 0.17 hipporag); macro dev −0.03 to −0.06 |

So the defaults are `perHit: 1` and `maxInserted: 3`: one fact target, plus the entity's
own facts and the target's facts, at most three insertions per query. That's the smallest
setting that keeps every gain.

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
through edge weight.** An associations channel (he earlier draft's associations-channel RFC) is no
longer needed for accepted associations. It stays an option only for *unconfirmed* ones.

## Delivery

### Tier

**Lightweight.** Circadia has one maintainer and no other users of record. Its data is
the owner's own vault. The change is behind a config flag that defaults off, and nothing
is migrated. The one step that can't easily be undone, turning expansion on by default
(Rollout step 3), is raised to its own review: the owner decides, with the personal-vault
eval in front of them, in a dedicated commit. An architecture review of this RFC happens
before step 2.

A one-way door usually raises the tier. It doesn't here, because the door only exists
for the person deciding to open it: there are no other users whose agents would adapt to
the new results without their say. If Circadia gains other users before step 3, the
default flip moves to a higher tier, with a release note and a way to opt out.

**Who notices first** if something goes wrong: the owner, through their own agents'
answers on their own vault. The eval and CI catch the same failures on the fixture before
that.

### Risks

| Risk | Likelihood | Blast radius | Detection | Mitigation | Rollback | Door |
| --- | --- | --- | --- | --- | --- | --- |
| Expansion inserts a target that isn't valid at the query time (wrong answer, stated confidently) | Low | Every recall naming that entity | Eval: absence and vacuous counts; invariant tests | `edgeAllowed` plus world-time check; test per case | Set `enabled: false` | Two-way |
| Expansion bypasses the trust floor or scope | Low | Security boundary (SECURITY T1, T4) | Invariant tests; eval trust gate | Only candidates already in the set are inserted | Set `enabled: false` | Two-way |
| Expansion crowds direct answers out of the top results | Medium | Recall quality for entity-cued queries | Eval single-hop and preference kinds; no-kind-regression gate | `perHit: 1`, `maxInserted: 3` | Lower the caps or disable | Two-way |
| Predicate ordering picks the wrong fact | Medium | Which target is shown | Eval multi-hop kind; personal-vault eval | Ordering is tie-broken by index order; open question 2 | Disable | Two-way |
| Expanded passages raise ACT-R activation for notes the user didn't search for | Medium | Future rankings | Access-log inspection | They were returned to the agent, so logging them is honest; `via` records why | Disable | Two-way |
| Default flipped on before personal-vault evidence | Low | All recall | Rollout step 3 gate | Owner decision in its own commit | Revert that commit | **One-way in practice** (agents adapt to the new results) |

### Architecture answers

- **Contract change.** Two additive, optional fields:
  - `RecallHit` in `src/types.ts` gains
    `via?: { kind: 'fact-expansion'; from: string; predicate?: string }`. `from` is the cue
    entity's note id. `predicate` is present on a fact target and absent on the entity's
    own `#facts` passage, which is inserted before a predicate is chosen. Hits that
    weren't inserted have no `via`.
  - `RecallResult` gains `expanded?: number`, the count of inserted hits. It's absent
    when expansion is off.

  The MCP `recall` payload carries both when present; clients that ignore unknown fields
  are unaffected. Documenting both in `src/mcp/README.md` and `docs/RETRIEVAL.md` is a
  Rollout step 2 deliverable.
- **Graph cache.** Not involved. Expansion runs after ranking. It reads the `edges` table
  with the same `edgeAllowed` filter `loadGraph` uses, and doesn't touch the cached
  PageRank graph.
- **Load.** At most `maxInserted` (3) inserted passages and one small `edges` query per
  cue entity per query. Measured on the 10k-note benchmark vault with three facts per
  note, typed mode, 40 queries that each name a note: p50 119.6 → 121.5 ms, p95
  182.4 → 177.2 ms. Expansion changed 23 of the 40 hit lists, so it was firing.
- **Observability and thresholds.** Circadia is a local tool with no telemetry, by
  design, so the monitors are tests and the eval:
  - `expanded > maxInserted` on any recall is a bug. Criterion 6 enforces it, and the
    implementation asserts it.
  - In CI, `npm run eval:check` fails on **any** baseline delta (one or more). With the
    flag off, that guards criterion 7; once the baseline is refreshed with the flag on,
    it guards criterion 8.
  - On a personal vault, the private eval reports, per kind, the share of queries with
    `expanded > 0` next to recall. A kind whose recall falls while its expansion share
    rises is the signature of crowding, and blocks step 3.
  - There's no runtime alerting threshold, because there's no runtime to alert from.
- **Access log.** Inserted hits are logged like any returned hit (they were shown to the
  agent), with the usual query hash and session. No new log fields.
- **Not applicable:** schema and index migrations (no DDL change, no
  `INDEX_SCHEMA_VERSION` bump), RBAC (single-user tool), vault format (unchanged).

### Acceptance criteria

All are owned by the maintainer; each maps to one test.

1. **Given** a query whose cue entity has a `runs_on` fact valid now, **when** recall runs
   in typed mode with expansion on, **then**, directly after the entity's first hit, come
   the entity's `#facts` passage, then the fact's target passage. Both carry
   `via.kind = 'fact-expansion'`; the target carries `via.predicate = 'runs_on'`, and the
   entity's `#facts` passage carries no `via.predicate`.
2. **Given** a fact whose world-time validity ended before `asOf` (or starts after it),
   **when** an as-of recall runs, **then** that target is never inserted.
3. **Given** a superseded fact, **when** recall runs with `includeSuperseded: false`,
   **then** its target is never inserted.
4. **Given** a target below `retrieval.trustFloor`, or outside the recall scope, **when**
   recall runs, **then** it is never inserted.
5. **Given** a cue entity with `link`, `triple`, `synonym` and `dream` neighbours and no
   facts, **when** recall runs, **then** nothing is inserted.
6. **Given** a cue entity with five valid facts, **when** recall runs, **then** at most
   `perHit` targets and at most `maxInserted` passages are inserted, and each entity
   expands once.
7. **Given** `factExpansion.enabled: false`, **when** the eval runs, **then** the committed
   baseline shows 0 deltas.
8. **Given** `factExpansion.enabled: true`, **when** the eval runs, **then** it reproduces
   this RFC's numbers exactly. The eval is deterministic (ADR-0010), so "within noise"
   means identical; any difference is investigated, not tolerated.
9. **Given** the 10k-note benchmark vault with facts, **when** 40 entity-cued queries run,
   **then** p50 latency with expansion on is no more than 10% above expansion off.

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
   - `via` marking (including the `#facts` passage's absent `predicate`), and how
     `renderForContext()` shows it.
   - Also: document `via` and `expanded` in `src/mcp/README.md` and `docs/RETRIEVAL.md`.
   - *Gate:* criteria 1–9 pass. Flag-on eval reproduces this RFC's numbers **exactly**
     (criterion 8); vacuous absences are 0; no kind regresses on either split in any mode.
3. **Measure on a personal vault.** Run the private eval with the flag on and off.
   - Turn on only if no kind regresses on either split of either tier, and trust and
     absence violations don't rise.
   - Flipping the default is a human decision in its own commit, with a line in
     RETRIEVAL.md. It's the one change here that can't easily be undone.

### Stories and dependencies

| Story | Depends on | Flag safety |
| --- | --- | --- |
| 1. Flag and config keys | none | Adds keys only; no behavior change, proven by 0 baseline deltas |
| 2. Expansion behind the flag, plus contract docs | 1 | Default off, so merged code changes nothing until enabled; criterion 7 proves it |
| 3. Personal-vault measurement | 2 | Read-only eval run; changes no code or default |
| 4. Default flip, if step 3 passes | 3 | The one-way step, in its own commit, reverted by reverting that commit |

All are owned by the maintainer.

## Open questions

All are accepted by the maintainer, with a point at which each is decided.

1. ~~A total cap.~~ Resolved: `perHit: 1`, `maxInserted: 3`, measured above. (Default
   `topK` is 8, so the cap leaves at least five ranked hits in place.)
2. **The predicate-ordering rule** was designed against dev failures. Holdout agrees, but
   it's crude. A per-predicate synonym list in `predicates.defs` would be less brittle.
   *Decide at step 3*, from the personal-vault multi-hop results. Also tracked as a risk
   above.
3. **Auto mode.** Expansion needs `fact` edges, so an auto query that stays in wikilink
   mode gets none. Should a cue entity with facts be an escalation signal on its own?
   *Decide after step 3*, as a separate change with its own eval run.
4. **Seed crowding.** Predicate names in `#facts` passages ("runs_on") match many queries
   lexically. Should the keyword index skip predicate names, since the graph already
   carries them? *Decide after step 3*, separately. It's an index change with its own
   baseline refresh.
5. **Restart-mass normalization** remains the reason graph-only neighbours can't rank.
   That matters for unconfirmed dream edges and for triple paths, and it's left for a
   later RFC if one of those becomes worth pursuing. *Deferred*; no decision is needed for
   this RFC.

## History of this RFC

The first draft (same day) proposed rank fusion plus expansion from any `#facts` hit,
measured before vector seeds reached the eval: temporal 0.17 / 0.50 → 1.00 / 1.00 at a
cost of holdout MRR. After `fd12997`, the same proposal gains nothing on holdout macro
recall, loses MRR on both splits, and regresses preference on dev. The entity-anchored
version replaces it.