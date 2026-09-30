# Architecture

Circadia borrows its structure from how human memory is organised. This document maps
each cognitive finding to the design decision it drives, so future changes can be checked
against the same reasoning. Citations point to [`SOURCES.md`](SOURCES.md).

## 1. The core split: content vs. index

**Finding: hippocampal memory indexing theory** (Teyler & DiScenna 1986; Teyler & Rudy
2007). The hippocampus doesn't store memories. It stores a sparse *index* of pointers to
content held in the neocortex. A partial cue activates the index, which reactivates the
whole cortical pattern ("pattern completion"). New information can be integrated by
changing only the index. HippoRAG turned this into a retrieval system for LLMs. [S1–S4]

**Decision.**

| brain | Circadia | where |
|---|---|---|
| neocortex (content) | markdown vault | `examples/vault/`, `docs/SCHEMA.md` |
| hippocampal index (pointers) | `.circadia/index.sqlite`: nodes, edges, names, FTS | `src/index/` |
| pattern completion | recall: cues → seeds → spreading activation → passages | `src/retrieval/recall.ts` |

The index is derived and rebuildable. This lets a human read and edit memory directly
(observability) without giving up graph retrieval.

## 2. Two learning systems at two speeds

**Finding: complementary learning systems** (McClelland, McNaughton & O'Reilly 1995;
Kumaran, Hassabis & McClelland 2016). A fast hippocampal system binds specific episodes. A
slow neocortical system extracts regularities through interleaved *replay*, largely
offline and during sleep. [S5]

**Decision.** Two tiers of notes:

- `episodes/`: written immediately, append-only, one event per file.
- `entities/` facts and `schemas/`: produced by **consolidation**, an offline job that
  replays episodes (Phase 4).

Agents write episodes, not facts.

## 3. Prior knowledge gates consolidation

**Finding: schema-accelerated consolidation** (Tse et al. 2007; van Kesteren et al. 2012).
Information that fits an existing schema consolidates much faster. The brain effectively
chooses between *updating* an existing structure and *creating* a new trace. [S6, S7]

**Decision.** Consolidation (Phase 4) applies a **schema-fit gate**:

- A candidate fact about a known entity, with a known predicate, that doesn't contradict
  current facts → promoted in one pass.
- A novel entity, unknown predicate, or contradiction → stays episodic until corroborated
  by a second independent episode or by explicit user confirmation.

The same gate is the main defense against memory poisoning. One hostile paragraph can't
become a trusted fact.

## 4. Episodes have boundaries

**Finding: event segmentation theory** (Zacks et al. 2007; Radvansky & Zacks 2017). People
segment experience at points where prediction error spikes. Episodic memories begin and end
at those boundaries, and order memory is better within an event than across events.
[S8, S9]

**Decision.** Episode writing (Phase 3) cuts at **topic shifts**, not at token counts. The
first implementation will use embedding-distance jumps between consecutive windows as a
prediction-error proxy. Each episode records `boundary:`, the reason it was cut.

## 5. Retrieval is spreading activation plus use history

**Findings.**

- **Spreading activation** (Collins & Loftus 1975): activation spreads from cued concepts
  along associative links, weakening with distance. [S10]
- **ACT-R base-level activation** (Anderson & Schooler 1991): a memory's accessibility is
  `B = ln Σ t_j^(-d)` over past presentations. It rises with recency and frequency and
  decays as a power law; `d = 0.5` is canonical. Retrieval probability is a logistic
  function of `B` relative to a threshold. [S11, S12]

**Decision.**

1. Cues come from keyword search over passages plus entity names mentioned in the query.
   They are fused into a seed vector by reciprocal-rank fusion.
2. Spreading uses **personalized PageRank** from those seeds, as HippoRAG does [S1, S2].
   Edges are undirected (associations spread both ways) and weighted per origin.
3. Ranking is `graph score + ACT-R retrieval probability + note importance`, with
   configurable weights.
4. **Forgetting** means a lower retrieval probability, never deletion. Old memories stay
   in the vault and stop winning ties. [S12]

HippoRAG 2's key result applies here too. Graph-only retrieval hurts plain factual recall
unless the original **passages are nodes in the graph** [S2]. Passages are first-class nodes
here, linked to their note by `contains` edges and to what they mention by `link` and
`triple` edges.

## 6. Recall reopens a memory

**Finding: reconsolidation** (Nader et al. 2000; Lee, Nader & Schiller 2017). A retrieved
memory becomes temporarily labile, and new information present at retrieval can update it.
[S13, S14]

**Decision.**

- Every recall appends to `.circadia/access.jsonl`. This also feeds ACT-R.
- Phase 4: if an episode written in the same session contradicts a fact that was just
  recalled, consolidation treats that fact as open to revision. It is superseded
  bi-temporally, not overwritten.

## 7. Where a memory came from

**Finding: source monitoring** (Johnson, Hashtroudi & Lindsay 1993). Most memory distortions
are failures to attribute a memory to its correct source. [S15]

**Decision.**

- Every fact records `by::` (user / agent / tool / web / import), `src::` (provenance
  episode), and `trust::`.
- Episodes inherit trust from their `by`.
- Recall fences low-trust passages as `<untrusted-data>`, and `retrieval.trustFloor` can
  exclude them entirely.

See [`SECURITY.md`](SECURITY.md).

## 8. Time is two-dimensional

Not a neuroscience finding, but necessary for correct memory. The **bi-temporal** model,
as used by Graphiti/Zep [S16, S17], separates:

- **world time** (`valid:: from..to`): when a fact was true;
- **system time** (`at::`, `superseded::`): when a fact was believed.

`--as-of T` filters on both. It also hides edges declared by notes created after `T` and
evaluates ACT-R activation as of `T`. Prose is exact too: when the vault is a git repo, each
hit's passage is re-read from the note at the last commit ≤ `T` (C17). A note with no commit
≤ `T`, or a non-git vault, falls back to the current text and the CLI says so.

## 9. Components and data flow

```
vault/*.md ──walk──▶ parseNote ──▶ ParsedNote{passages, links, facts, problems}
                                          │
                     extractionModeFor ───┤  (frontmatter > scopes > default)
                                          ▼
                                   buildIndex (full) / incrementalIndex (diff)
                     nodes: note | passage | placeholder | phrase
                     edges: contains | link | fact | provenance | triple | synonym
                     names: id / alias / title → note
                     passages_fts (if FTS5)       triples cache ─┘
                                          │
query ──▶ cues (FTS5|BM25 + entity names) ─▶ RRF seeds
                                          │
          mode ladder (auto) ─▶ filter edges by mode origins, trust, as-of
                                          ▼
                             personalized PageRank ─▶ passages
                                          ▼
                 score = w_g·graph + w_a·P_actr + w_i·importance
                                          ▼
                    top-K within token budget ─▶ access log ─▶ render (fenced)
```

## 10. Sleep has two phases: consolidation and recombination

**Findings.** Slow-wave (NREM) sleep replays recent experience and groups it into schemas;
REM sleep, with hippocampus and cortex less coupled, recombines across those schemas. [D1–D8]

| finding | decision |
|---|---|
| NREM replay groups memories into schemas; REM recombines across them (D1) | The REM pass runs after consolidation and samples pairs from different regions of the graph |
| REM improves remote-association problem solving (D2) | Output is an association between distant notes, never a new fact |
| Only 1–2% of dream reports replay a waking episode (D3) | Recombination, not replay; faithful replay stays NREM's job |
| Dreaming about a recent task tracks its overnight consolidation (D4) | The recent side is chosen by ACT-R activation |
| Dream strangeness may prevent overfitting to the day (D5) | A share of partners are random older notes |
| REM-active MCH neurons suppress new hippocampal memories (D6) | Read-once log; candidates expire |
| Dream sleep may weaken spurious patterns (D7) | Ungrounded proposals are pruned, and logged as pruned |
| Sleep downscales synapses so only what earned it stays strong (D8) | Dream edges start at weight 0 |

**Decision.** `circadia dream` (and `consolidate --dream`) runs a REM pass that pairs
recently active notes with distant ones and asks the extraction model whether anything
connects them. The output is a *candidate association* under `.circadia/dreams/`, never a
fact. A human accepts one in `circadia review`, which writes an ordinary `by:: user` fact.
Dream edges enter the graph at weight 0 until the eval says they help. See RFC-0001 and
ADR-0011.

## 11. Why these technology choices

- **SQLite via `node:sqlite`**: zero dependencies, one file, runs on a Raspberry Pi,
  recursive CTEs for path queries. See ADR-0004.
- **No graph database**: at personal scale (about 10⁴ notes and 10⁵ edges), PageRank by
  power iteration in plain TypeScript runs in milliseconds. A graph DB adds operations and
  dependencies for no benefit at this size. Revisit above about 10⁶ edges.
- **FTS5 with a BM25 fallback**: some official Node builds ship `node:sqlite` without
  FTS5 [S18]. The indexer probes for it and falls back to an in-process BM25.
- **Dataview bracketed fields for facts**: unambiguous delimiters (balanced brackets) that
  are also queryable in Obsidian. See ADR-0002.
