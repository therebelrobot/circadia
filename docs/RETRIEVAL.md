# Retrieval

How Palimpsest turns a cue into passages, and how graph modes are configured. The code is
in `src/retrieval/`, with `recall.ts` as the orchestrator.

## 1. Two independent decisions

There are two separate questions, configured separately:

1. **Extraction: how much structure to build per note.** This decides what edges *exist*.
2. **Query: how much structure to traverse per query.** This decides which existing edges
   a query *uses*.

### 1.1 Extraction mode (per note)

Precedence, in `src/extract/scope.ts`:

1. The note's frontmatter `graph: wikilink | typed | hipporag`.
2. The first matching rule in `graph.scopes`.
3. `graph.defaultExtraction` (default `typed`).

A scope rule matches when **all** of its criteria match. Inside one criterion, **any**
value matches.

```json
"graph": {
  "defaultExtraction": "typed",
  "scopes": [
    { "match": { "tags": ["deep", "research"] },        "extract": "hipporag" },
    { "match": { "paths": ["entities/people/**"] },      "extract": "wikilink" },
    { "match": { "kinds": ["concept"], "tags": ["ml"] }, "extract": "hipporag" }
  ]
}
```

| mode | edges built for the note | cost |
|---|---|---|
| `wikilink` | `contains` (note → passage), `link` (passage → target) | parse only |
| `typed` | + `fact` (note → object, bi-temporal), `provenance` (note → `src` episode) | parse only |
| `hipporag` | + `triple` (passage → phrase, phrase → phrase), `synonym` (phrase → note it names) | LLM extraction, cached |

`palimpsest stats` shows how many notes landed in each mode. Each note row in the index
records `extraction_mode` and `extraction_why`, the rule that chose it.

### 1.2 Query mode (per query)

`graph.query.mode` sets the default, and `--mode` or `RecallOptions.mode` overrides it.
Values are `wikilink`, `typed`, `hipporag`, or `auto` (the default). A fixed mode traverses
exactly that mode's edge origins (`src/retrieval/modes.ts`). Traversing `hipporag` over a
vault with no triples behaves like `typed`.

## 2. The `auto` ladder

`graph.query.auto.ladder` defaults to `["wikilink", "typed", "hipporag"]`. The idea is to
start cheap and escalate only when the result looks weak.

Before running the first rung:

- **No triples indexed**: `hipporag` is dropped from the ladder.
- **As-of query**: rungs whose edges carry no time (`wikilink`) are skipped. Time lives
  only on fact edges.
- **Multi-entity cue**: if the query names at least `multiEntityThreshold` entities
  (default 2), the ladder starts one rung up. Several entities suggest a relationship or
  multi-hop question.

After each rung, the ladder escalates to the next rung if any of these holds:

- fewer than `minSeeds` seeds were found (default 2);
- there were no hits;
- the top-score margin `(s₁ − s₂) / s₁` is below `minTopMargin` (default 0.05). A flat top
  of the ranking means the graph didn't separate candidates.

Every escalation is reported in `RecallResult.escalations` with its reason, and the CLI
prints them. Tune thresholds against your own vault. These defaults were checked only on
the example vault.

## 3. Pipeline

1. **Cues.**
   - Keyword: FTS5 `bm25()` over `title`, `heading`, and `text`, weighted 2 : 1.5 : 1.
     Without FTS5, an in-process BM25 (k1 = 1.2, b = 0.75) is used instead.
   - Entity names: whole-word matches of note ids, aliases, and titles (at least 3
     characters) against the query, for `type: entity` notes.
   - Vector (optional): when the caller supplies a query embedding
     (`RecallOptions.queryEmbedding`; the CLI does this automatically when
     `embeddings.provider` is `http`), the passages whose stored embeddings are
     closest to the query, by brute-force cosine, up to `retrieval.seedLimit`.
2. **Seeds.** Reciprocal-rank fusion (k = 60) of the keyword list (passage ids), the
   entity list (note ids), and — when available — the vector list (passage ids).
   Vector seeds feed the **same** RRF fusion as the other two; they are not a new
   ranking signal, so no new score component or weight is added. Every hit still
   carries exactly `components: { graph, activation, importance, seed }` (§4), and a
   hit seeded only by vector similarity is explainable as "the query embedding was
   close to this passage's embedding".
3. **Graph.** Edges come from the mode's origins, weighted
   `originWeights[origin] × edge.weight`. For facts, `edge.weight` is `conf`. The graph is
   undirected. An edge is dropped if:
   - its `trust` is below `retrieval.trustFloor`;
   - it is superseded and this is a "now" query without `includeSuperseded`;
   - it fails the as-of filter (§5).
4. **Spread.** Personalized PageRank, `p = (1−d)·s + d·Wᵀp`, with damping d = 0.5 as in
   HippoRAG. Mass on nodes with no edges returns to the seeds.
5. **Rank.** The 400 nodes with the most PageRank mass are considered; of those, the
   passage nodes are the candidates, scored as in §4.
6. **Budget.** Take the top K until the token budget (characters ÷ 4) is spent. The first
   hit is always included.
7. **Log.** Append `{t, node, kind: 'recall', q: sha256(query)[:12]}` per hit to
   `.palimpsest/access.jsonl`, unless `--no-log` is set or `logAccess` is false.

## 4. Scoring

```
score = w.graph · (ppr / max_ppr)
      + w.activation · P_actr
      + w.importance · importance
```

- `P_actr = 1 / (1 + e^(−(B − τ) / s))` is ACT-R's retrieval-probability equation.
  - `B = ln Σ_j t_j^(−d)` over presentations, where a presentation is the note's encoding
    time (`created`, else `started` for episodes, else `generated` for schemas) plus every
    logged access. `t` is in seconds.
  - `τ = −d · ln(actrThresholdDays · 86400)`, so a memory seen once `actrThresholdDays`
    ago (default 30) has P = 0.5.
  - `s = actrNoise` (default 1.0).
- `importance` is frontmatter salience in [0, 1], default 0.5.
- Default weights are `graph 1.0`, `activation 0.3`, `importance 0.2`.

Every hit carries `components: { graph, activation, importance, seed }`, so a ranking can
always be explained.

## 5. As-of semantics

`--as-of T` answers "as the vault stood, and as the world was, at T".

| layer | rule |
|---|---|
| world time | fact edges need `valid_from ≤ T < valid_to` (null bounds are open) |
| system time, facts | need `recorded_at ≤ T`; excluded if `expired_at ≤ T` |
| system time, prose | edges declared by notes with `created > T` are excluded; passages of such notes are excluded |
| activation | evaluated with now = T; accesses after T are ignored |

Limitation: prose edits made after T are not versioned in the index. A note that existed
at T is recalled with its *current* prose. Phase 6 adds git-backed as-of.

## 6. hipporag mode in detail

HippoRAG builds a knowledge graph from OpenIE triples extracted from passages, links
synonymous phrases, and runs personalized PageRank from query-matched nodes. HippoRAG 2
keeps passages as nodes so factual recall doesn't degrade. [SOURCES S1, S2]

In Palimpsest:

- The **triple cache** is `.palimpsest/triples/<noteId>.jsonl`. Each line is
  `{passageId, contentHash, subject, predicate, object, conf?, model?, extractedAt?}`.
  `contentHash` is `sha256(passage.text)[:16]`. If the passage text changes, its triples
  are skipped as **stale** and reported.
- **Graph**:
  - Each distinct subject or object becomes a phrase node `p:<slug>`.
  - Edges: `passage → phrase` (`triple`/`mentions`) and `phrase → phrase` (`triple`/`<predicate>`).
  - A phrase whose text resolves to a note name gets a `synonym`/`names` edge to that note.
    This bridges the phrase graph into the note graph.
- **Why a cache and not the vault**: triples are high-volume, machine-generated, and
  low-precision. Keeping them out of notes preserves the vault's readability. Keeping them
  cached avoids paying the LLM on every rebuild. Facts that *matter* get promoted into
  notes by consolidation. See ADR-0003.
- **Extractor**: the `TripleExtractor` interface is in `src/extract/triples.ts`. It is
  implemented in Phase 5, and only runs for notes whose extraction mode is `hipporag`.
  That is what "hipporag for advanced topics" means operationally: scope it by tag or path,
  and pay the LLM only there.

Not yet implemented, tracked in the roadmap: embedding-based synonym edges between phrases
(HippoRAG's synonymy edges), and query-to-triple matching for seed selection (HippoRAG 2's
"recognition memory" filter). Embedding seeds are implemented (Phase 2) as the third RRF
list in §3.

## 7. Vector seeds in detail

- **Storage.** Passage embeddings are `Float32Array` bytes in `nodes.embedding`, with the
  producing model in `nodes.embedding_model`. `palimpsest index` (and `watch`,
  best-effort) fills them via `embedPassages()`, which only (re)embeds passages whose
  embedding is NULL or whose model differs from `embeddings.model` — a changed passage
  gets a fresh row with a NULL embedding, so content changes are covered.
- **Client.** `HttpEmbeddingsClient` speaks the OpenAI-compatible `/v1/embeddings` wire
  format (what llama.cpp's `llama-server --embedding` serves), batches by
  `embeddings.batchSize`, sends a bearer token from `process.env[embeddings.apiKeyEnv]`
  when set, and retries once on 429/5xx. The default endpoint is a local llama.cpp
  server; hosted models go through OpenRouter with a non-OpenAI, non-xAI model.
- **Scale.** Cosine is brute force over all stored passage embeddings: fine to about
  10⁵ passages (a few hundred ms in JS on a Pi-class machine). Beyond that an ANN index
  would be needed, which means a dependency and an ADR. See `docs/PERFORMANCE.md`.
