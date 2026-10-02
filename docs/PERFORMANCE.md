# Performance

Benchmark methodology and recorded results. Run with `npm run benchmark`
(10k notes / 50k links / 3 facts per note by default; `--notes`, `--links`,
`--queries` override).

## Methodology

`benchmarks/run.ts`:

1. **Generate** a synthetic vault with `benchmarks/generate-vault.ts`: N entity
   notes (default 10,000), each with valid frontmatter (`type: entity`,
   `kind: concept`, `created:`) and one prose passage, carrying a total of L
   wikilinks (default 50,000) distributed round-robin. Each note also carries F
   facts (default 3) in a `## Facts` section — `[predicate:: [[target]]]
   [by:: user]` lines that parse into a `#facts` passage and `fact` edges per
   note (the shape RFC-0002 criterion 9 measures). Deterministic PRNG (LCG,
   seed 42 for links, seed 1337 for facts) so runs are comparable; the separate
   fact seed means adding facts does not move the wikilink targets.
2. **Full index**: time `buildIndex()` over the generated vault.
3. **Incremental, 10 notes**: append one line to 10 notes, time
   `incrementalIndex()`.
4. **Incremental, 1 note**: append one line to 1 note, time
   `incrementalIndex()`. This is the roadmap acceptance criterion: *editing one
   note reindexes in under 200 ms on a 10k-note vault*.
5. **Recall latency**: 100 deterministic queries per mode (`wikilink`,
   `typed`), each targeting a real passage (`topic <n> measurements`). Report
   p50/p95/max. `logAccess: false` so the access log does not grow.
6. **RFC-0002 criterion 9**: 40 entity-cued queries (`note-<n>`, typed mode),
   each naming a note so the cue-entity path fires. Recall is awaited and the
   fact-expansion flag is toggled off/on per query (interleaved, so both see
   the same cache state); the bound is p50 on ≤ 1.10× p50 off. The run exits
   non-zero if the bound is exceeded.
7. **Peak RSS**: `process.memoryUsage().rss` sampled after each phase.

The vault is generated in a temp dir and deleted afterwards; nothing in the
repo is modified.

## Recorded results

Machine: Apple Silicon (darwin arm64), Node v24.14.1, recorded 2026-10-02.

| metric | value |
|---|---|
| vault generated (10k notes, 50k links, 3 facts/note) | 1,838 ms |
| full index (10k notes, 20k passages, ~100k edges, FTS5) | 3,836 ms |
| incremental, 10 changed notes | 3,089 ms |
| incremental, 1 changed note | **1,050.6 ms** (acceptance < 200 ms: **FAIL** — see caveat) |
| recall `wikilink` p50 / p95 / max | 234.3 / 352.0 / 1,098.7 ms |
| recall `typed` p50 / p95 / max | 301.1 / 359.9 / 458.9 ms |
| entity-cued p50 off / on (RFC-0002 §9) | 271.0 / 280.9 ms (ratio 1.036: **PASS**) |
| peak RSS | 767 MB |

## Notes and scale limits

- **Incremental indexing** is O(affected notes): it re-parses only changed
  files and re-resolves edges into changed/removed notes. The 1-note case is
  dominated by fixed per-run costs (SQLite open + file walk) rather than
  re-parsing, but on the current facts-bearing vault it measures 1,050.6 ms —
  above the 200 ms acceptance bound. This is a known failure, tracked
  separately; it is not fixed here.
- **Recall** re-reads the mode's edges from SQLite per query and runs
  personalized PageRank in JS. At 10k notes / ~100k edges that is ~230–300 ms
  per query on this machine (the `wikilink` max of 1,098.7 ms is an outlier
  well above p95). The per-mode graph cache (`src/retrieval/graph-cache.ts`)
  removes the edge read for long-running processes (MCP server); PPR itself
  still runs per query.
- **Vector seeds** are brute-force cosine over all stored passage embeddings
  (`src/retrieval/embeddings.ts`, `topKByCosine`). At 10⁵ passages that is on
  the order of a few hundred ms in JS — fine for the target scale, but an ANN
  index (and therefore a dependency, via ADR) would be needed beyond it.
- **Embedding** a 10k-passage vault against a local llama.cpp server is
  network-bound, not CPU-bound; `embedPassages` batches by
  `embeddings.batchSize` and only (re)embeds passages and phrase nodes whose
  `embedding` is NULL or whose `embedding_model` differs from the configured
  model.
