# Performance

Benchmark methodology and recorded results. Run with `npm run benchmark`
(10k notes / 50k links by default; `--notes`, `--links`, `--queries` override).

## Methodology

`benchmarks/run.ts`:

1. **Generate** a synthetic vault with `benchmarks/generate-vault.ts`: N entity
   notes (default 10,000), each with valid frontmatter (`type: entity`,
   `kind: concept`, `created:`) and one prose passage, carrying a total of L
   wikilinks (default 50,000) distributed round-robin. Deterministic PRNG
   (LCG, seed 42) so runs are comparable.
2. **Full index**: time `buildIndex()` over the generated vault.
3. **Incremental, 10 notes**: append one line to 10 notes, time
   `incrementalIndex()`.
4. **Incremental, 1 note**: append one line to 1 note, time
   `incrementalIndex()`. This is the roadmap acceptance criterion: *editing one
   note reindexes in under 200 ms on a 10k-note vault*.
5. **Recall latency**: 100 deterministic queries per mode (`wikilink`,
   `typed`), each targeting a real passage (`topic <n> measurements`). Report
   p50/p95/max. `logAccess: false` so the access log does not grow.
6. **Peak RSS**: `process.memoryUsage().rss` sampled after each phase.

The vault is generated in a temp dir and deleted afterwards; nothing in the
repo is modified.

## Recorded results

Machine: Apple Silicon (darwin arm64), Node v24.14.1, recorded 2026-09-29.

| metric | value |
|---|---|
| vault generated (10k notes, 50k links) | 1,071 ms |
| full index (10k notes, 10k passages, ~60k edges, FTS5) | 1,081 ms |
| incremental, 10 changed notes | 334 ms |
| incremental, 1 changed note | **133.7 ms** (acceptance < 200 ms: **PASS**) |
| recall `wikilink` p50 / p95 / max | 143.5 / 183.8 / 271.5 ms |
| recall `typed` p50 / p95 / max | 141.8 / 172.7 / 208.7 ms |
| peak RSS | 553 MB |

## Notes and scale limits

- **Incremental indexing** is O(affected notes): it re-parses only changed
  files and re-resolves edges into changed/removed notes. The 1-note case is
  dominated by the SQLite open + file walk, not by re-parsing.
- **Recall** re-reads the mode's edges from SQLite per query and runs
  personalized PageRank in JS. At 10k notes / 60k edges that is ~140 ms per
  query on this machine. The per-mode graph cache (`src/retrieval/graph-cache.ts`)
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
