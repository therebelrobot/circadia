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


<p align="center"><img src="media/vault-index.gif" alt="Animated diagram: markdown notes on a floor with index nodes above them, dashed pointers dropping to each note. The index is erased and redrawn from the notes." width="100%"></p>

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

<p align="center"><img src="media/sleep.gif" alt="Animated diagram: episode cards pass through a schema-fit gate and become facts on a note; an untrusted, dashed card stops at the gate and drops into a review tray." width="100%"></p>

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

<p align="center"><img src="media/bi-temporal.gif" alt="Animated chart: world time runs left to right, system time runs back. 'runs_on old-laptop' is struck through when 'runs_on pi-cluster' replaces it; an --as-of pin at July reads old-laptop, then at now reads pi-cluster." width="100%"></p>

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

<p align="center"><img src="media/dream.gif" alt="Animated diagram: a dashed arc links a recently active note to a distant, older one. Labels: 'a candidate link, never a fact' and 'only you can promote it, in review'. The arc fades." width="100%"></p>

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

## 11. Workspaces: context, interference and transactive memory

A **workspace** is a folder of ordinary vaults plus a registry that places each vault on
two axes, **project** and **agent** (RFC-0004). An agent is bound to one cell, for example
`(work, coder)`, and reads from its **lineage**: the cells on its own row and column that
exist — `work.coder`, `work`, `coder`, `global`. It never reads a sibling such as
`work.architect`. Three findings drive the design.

**Findings.**

- **Encoding specificity and context-dependent memory** (Tulving & Thomson 1973; Godden &
  Baddeley 1975). Retrieval works best when the retrieval context matches the encoding
  context; a cue that was encoded underwater is recalled best underwater. [S19, S20]
- **Interference** (proactive and retroactive interference; Anderson & Neely 1996). Similar
  memories from different contexts compete at retrieval, and the competition is what makes
  the wrong one win. [S21]
- **Transactive memory** (Wegner 1987). A group remembers well when members specialize and
  a shared directory records who knows what. [S22]

**Decision.**

| finding | decision |
|---|---|
| Encoding specificity: match the retrieval context to the encoding context (S19, S20) | The binding *is* the context. The coder recalls first from what was encoded as the coder on this project, so the cue and the memory share a context. |
| Interference: similar memories from different contexts compete (S21) | Separate vaults remove the competition between siblings rather than trying to out-score it. `(work, coder)` never reads `(work, architect)`, so the architect's throwaway spike cannot outrank the coder's own decision. |
| Transactive memory: specialists plus a shared directory (S22) | The `project` and `global` layers are the shared directory; the agent layers are the specialists. A fact in `work` is shared with every agent on `work`; a fact in `global` is shared with every agent. |

**Decision.** Federated recall runs once per vault in the lineage and merges the ranked
lists by weighted reciprocal-rank fusion, because PageRank scores from different graphs are
not comparable. The merge uses ranks — the same tool recall already uses to fuse seeds, one
level up. Location is the sharing marker: there is no `shared: true` field to forget or
spoof, and isolation never depends on a filter being applied. Shared memory is reached only
by a permitted agent writing an episode there, a human running `circadia lift`, or a human
editing the vault directly — all of which end at that layer's own schema-fit gate or at a
human. See [RFC-0004](rfcs/RFC-0004-workspaces.md) and ADR-0013.

## 12. Why these technology choices

- **SQLite via `node:sqlite`**: zero dependencies, one file, runs on a Raspberry Pi,
  recursive CTEs for path queries. See ADR-0004.
- **No graph database**: at personal scale (about 10⁴ notes and 10⁵ edges), PageRank by
  power iteration in plain TypeScript runs in milliseconds. A graph DB adds operations and
  dependencies for no benefit at this size. Revisit above about 10⁶ edges.
- **FTS5 with a BM25 fallback**: some official Node builds ship `node:sqlite` without
  FTS5 [S18]. The indexer probes for it and falls back to an in-process BM25.
- **Dataview bracketed fields for facts**: unambiguous delimiters (balanced brackets) that
  are also queryable in Obsidian. See ADR-0002.
