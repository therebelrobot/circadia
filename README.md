# Palimpsest

**Agent memory that lives in a markdown vault you can read, with a derived graph index that
retrieves the way human memory does.**

A *palimpsest* is a manuscript that was scraped and written over, with the older text still
faintly visible underneath. That is how this system treats knowledge. Superseded facts are
struck through and kept, never deleted. Recalling a memory can revise it. The history under
the current text stays readable.

```
 ┌──────────────── Agent (MCP client, Phase 3) ────────────────┐
 │   remember → writes an episode          recall → reads index │
 └────────────┬───────────────────────────────────┬────────────┘
              ▼                                   ▼
 ┌── Vault (markdown, git, Obsidian) ──┐   ┌── Index (SQLite, derived) ──┐
 │  episodes/  append-only events      │──▶│  nodes: notes, passages     │
 │  entities/  notes + typed facts     │   │  edges: link, fact (bi-     │
 │  schemas/   consolidated summaries  │   │   temporal), provenance,    │
 │  procedures/ how-tos                │   │   triple (hipporag)         │
 └──────────────▲──────────────────────┘   │  FTS5 / BM25 keyword index  │
                │                          └─────────────────────────────┘
        Consolidation (Phase 4): nightly replay of episodes → facts, with
        schema-fit gating, bi-temporal invalidation, one git commit per run
```

The design is grounded in cognitive neuroscience. Each mechanism maps to a finding (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)):

| Brain | Palimpsest |
|---|---|
| Hippocampal indexing: the hippocampus stores *pointers* to cortical content | The vault holds content; the SQLite index holds only pointers, edges, and scores, and can be rebuilt from the vault |
| Complementary learning systems: fast episodic store, slow semantic consolidation | Episodes are written immediately; facts only come from consolidation |
| Spreading activation (Collins & Loftus) | Personalized PageRank from cue-matched seeds (as in HippoRAG) |
| ACT-R base-level activation: recency × frequency, power-law decay | Access log → activation term in ranking; forgetting demotes, never deletes |
| Reconsolidation: recall makes a memory labile | Every recall is logged; contradicted recalls get flagged for revision (Phase 4) |
| Source monitoring: false memories are mostly source errors | Every fact records `by::`, `src::`, `trust::`; low-trust recall is fenced as data |
| Event segmentation | Episodes are cut at topic shifts, not token counts (Phase 3) |
| Schemas accelerate consolidation | Schema-fit gate: facts that fit known entities merge fast; novel ones need corroboration |

## Status

**Phase 1 (this scaffold) is done and tested.** It includes:

- Vault schema v1: [`docs/SCHEMA.md`](docs/SCHEMA.md)
  - inline typed facts in entity notes
  - Dataview-queryable fields
  - bi-temporal validity
  - provenance and trust on every fact
- Parser, linter, and full-rebuild indexer on `node:sqlite`, with zero runtime dependencies.
- Configurable graph modes: `wikilink`, `typed`, and `hipporag`.
  - Extraction scopes choose the mode per tag, path, kind, or note.
  - An `auto` query ladder escalates only when a result looks weak.
- Recall pipeline:
  1. keyword (FTS5, or a BM25 fallback) and entity-name cues
  2. reciprocal-rank fusion of those cues into seeds
  3. personalized PageRank from the seeds
  4. ranking with ACT-R activation and note importance
  5. token budget
  6. `--as-of` time travel
- Untrusted-content fencing for low-trust recall.
- An example vault that exercises every feature, 34 tests, and a clean strict typecheck.

**Next:** Phase 2 adds incremental indexing and embeddings. Phase 3 adds the MCP server and
episode writing. Phase 4 adds consolidation. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Quick start

Requires **Node ≥ 22.18**. `node:sqlite` is built in and TypeScript runs natively.

```bash
npm install                 # dev-only: typescript + @types/node for `npm run typecheck`
npm test                    # 34 tests
npm run example:index       # build the example vault's index
npm run example:recall -- "where does the orchard collector run"
```

Or use the CLI directly:

```bash
node bin/palimpsest.mjs init ~/memory            # scaffold a vault
node bin/palimpsest.mjs lint   --vault ~/memory  # check against the schema
node bin/palimpsest.mjs index  --vault ~/memory  # rebuild the derived index
node bin/palimpsest.mjs recall --vault ~/memory "what did we decide about the collector"
node bin/palimpsest.mjs recall --vault ~/memory --as-of 2026-07 "where did it run"
node bin/palimpsest.mjs recall --vault ~/memory --context "drip timing"   # LLM-ready output
node bin/palimpsest.mjs stats  --vault ~/memory
```

Point Obsidian at the vault. Set its templates folder to `_meta/templates`. Install Dataview
if you want to query facts inside Obsidian:

```dataview
TABLE runs_on, valid FROM "entities" WHERE runs_on
```

## A fact, as written

```md
## Facts
- [runs_on:: [[pi-cluster]]] [valid:: 2026-08-11..] [by:: user] [src:: [[2026-08-11-migration]]] ^f-orch-host

## History
- ~~[runs_on:: [[old-laptop]]] [valid:: 2026-06-01..2026-08-11]~~ [superseded:: 2026-08-11] [by:: user]
```

The subject is the note the fact lives in. `valid` is **world time**: when the fact was true.
`at` and `superseded` are **system time**: when the fact was believed. So Palimpsest can
answer both "what was true in July" and "what did we believe in July". Full grammar is in
[`docs/SCHEMA.md` §4](docs/SCHEMA.md).

## Graph modes

| mode | uses | cost | when |
|---|---|---|---|
| `wikilink` | links you wrote | none | default first rung; most everyday recall |
| `typed` | + typed, time-stamped facts + provenance | none | as-of queries, relationships, multi-entity cues |
| `hipporag` | + LLM-extracted phrase graph (triples) | LLM + cache | deep / research topics, scoped by tag or path |

**Extraction** is set per note: frontmatter `graph:` wins, then the first matching
`graph.scopes` rule, then `graph.defaultExtraction`. **Querying** uses `graph.query.mode`,
which defaults to `auto`. In `auto`, the ladder climbs `wikilink → typed → hipporag` only
when:

- there are too few seeds,
- the top result wins by too small a margin,
- the cue names several entities, or
- the query is time-travel.

Details are in [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md).

## Repository map

```
bin/palimpsest.mjs         launcher (runs the TS CLI with Node type stripping)
src/
  types.ts                 shared types
  config.ts                config defaults, loading, validation
  vault/                   frontmatter subset, time, wikilinks, fact grammar, note parser, walker
  index/                   SQLite schema + full-rebuild indexer
  extract/                 extraction-scope selection, hipporag triple cache + extractor contract
  retrieval/               keyword (FTS5/BM25), PPR, ACT-R, mode ladder, recall, context rendering
  cli/main.ts              CLI
  mcp/                     Phase 3 — contract only
  consolidation/           Phase 4 — contract only
templates/                 Obsidian note templates (copied into vaults by `init`)
examples/vault/            fictional vault exercising every feature
test/                      node:test suites
docs/                      SCHEMA, ARCHITECTURE, RETRIEVAL, CONFIG, SECURITY, ROADMAP, SOURCES, decisions/
AGENTS.md                  start here if you are an agent picking this up
```

## Documentation

- [`AGENTS.md`](AGENTS.md): conventions, invariants, and where to start. **Read first when
  handing off.**
- [`docs/SCHEMA.md`](docs/SCHEMA.md): the vault format, which is the contract.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the cognitive principles and each design
  decision they drive.
- [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md): modes, scopes, the escalation ladder, scoring,
  and as-of semantics.
- [`docs/CONFIG.md`](docs/CONFIG.md): every config key.
- [`docs/SECURITY.md`](docs/SECURITY.md): threat model and defaults.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): Phases 2–7 with acceptance criteria.
- [`docs/SOURCES.md`](docs/SOURCES.md): every paper, doc, and issue this design draws on.
- [`docs/decisions/`](docs/decisions/): architecture decision records.

## License

Not yet chosen (`UNLICENSED`). Pick one before publishing.
