# Performance

Benchmark methodology and recorded results. Run with `npm run benchmark`
(10k notes / 50k links; facts are opt-in via `--facts` and default to 0, so the
default vault has no `fact` edges; `--notes`, `--links`, `--queries` override).

## Methodology

`benchmarks/run.ts`:

1. **Generate** a synthetic vault with `benchmarks/generate-vault.ts`: N entity
   notes (default 10,000), each with valid frontmatter (`type: entity`,
   `kind: concept`, `created:`) and one prose passage, carrying a total of L
   wikilinks (default 50,000) distributed round-robin. Each note also carries F
   facts (opt-in; default 0, `--facts 3` for the facts-bearing shape) in a
   `## Facts` section — `[predicate:: [[target]]] [by:: user]` lines that parse
   into a `#facts` passage and `fact` edges per note (the shape RFC-0002
   criterion 9 measures). Deterministic PRNG (LCG,
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

The incremental rows above predate the transaction fix below; see that
subsection for the before/after numbers.

### Incremental transaction fix (2026-10-02)

`incrementalIndex()` ran its file-snapshot loop (`upsertFile.run` for every file
on disk) outside a transaction, so a 10k-note vault did 10k autocommits on every
incremental run. The loop is now wrapped in a single transaction, committed
before the later `BEGIN`, so the snapshot commits once. Before/after on the same
machine (darwin arm64, Node v24.14.1):

| setting | [2] 10 changed notes (before) | [3] 1 changed note (before) | [2] (after) | [3] (after) |
|---|---|---|---|---|
| facts off | 1,274 ms | 1,003.2 ms (FAIL) | 513 ms | 206.5 ms (FAIL) |
| `--facts 3` | 1,747 ms | 905.4 ms (FAIL) | 1,201 ms | 269.0 ms (FAIL) |

A second facts-off run measured [2] 524 ms / [3] 211.5 ms. The fix decouples the
one-note case from the ten-note case (facts-off ratio drops from ~0.79 to
~0.40), but the 1-note case still sits just above the 200 ms acceptance bound:
the remaining cost is the per-run file walk and the 10k snapshot upserts, not
re-parsing.

## Notes and scale limits

- **Incremental indexing** is O(affected notes): it re-parses only changed
  files and re-resolves edges into changed/removed notes. The 1-note case is
  dominated by fixed per-run costs (SQLite open + file walk + the 10k-row
  snapshot upsert) rather than re-parsing. Wrapping the snapshot loop in one
  transaction (2026-10-02) cut the 1-note case from 1,003.2 ms to 206.5 ms
  (facts off) and from 905.4 ms to 269.0 ms (`--facts 3`), but it still sits
  just above the 200 ms acceptance bound. This remains a known failure, tracked
  separately.
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
