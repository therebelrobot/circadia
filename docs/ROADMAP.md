# Roadmap

Phases are ordered by dependency. Each phase lists its **deliverables**, its **acceptance
criteria** (what "done" means, testable), and **notes**. Check items off as you land them.
The owner's platform targets are a Raspberry Pi (arm64) homelab and a laptop. The owner
works in TypeScript and uses Mastra as their agent framework.

---

## Phase 1: Vault schema, indexer, configurable graph retrieval ✅

- [x] Vault schema v1 (`docs/SCHEMA.md`): note types, frontmatter subset, passages, inline
      Dataview-style typed facts, bi-temporal fields, provenance and trust, predicate
      vocabulary
- [x] Parser and linter with stable problem codes
- [x] Full-rebuild SQLite index (`node:sqlite`), FTS5 probe with BM25 fallback
- [x] Extraction scopes: frontmatter > rules (tags/paths/kinds/types) > default
- [x] Query modes `wikilink` / `typed` / `hipporag` / `auto` with an escalation ladder
- [x] Recall: RRF seeds → personalized PageRank → ACT-R + importance → token budget
- [x] `--as-of` bi-temporal recall (world time and system time)
- [x] Trust fencing, trust floor, hashed access log
- [x] hipporag triple cache format, loader, staleness check, extractor contract
- [x] CLI (`init`, `lint`, `index`, `recall`, `stats`), templates, example vault
- [x] 34 tests, strict typecheck

---

## Phase 2: Index maturity and embeddings ✅

**Deliverables**

- [x] **Incremental indexing.**
  - Store `(path, mtime, sha256)` per note in a `files` table.
  - Re-parse only changed notes; delete rows for removed files.
  - Recompute `link`/`fact` edges *into* changed notes, since resolution can change when
    aliases change.
  - Keep a full rebuild as `index --full`.
- [x] **`circadia watch`**: `fs.watch` recursive plus a 500 ms debounce, then an
      incremental index.
- [x] **Embeddings client** (`src/retrieval/embeddings.ts`).
  - Zero-dependency `fetch` to `embeddings.endpoint`, using the OpenAI-compatible
    `/v1/embeddings` wire format that llama.cpp's `llama-server --embedding` serves.
  - Batch by `embeddings.batchSize`; bearer token from `process.env[apiKeyEnv]`.
- [x] **Vector storage.** Add an `embedding BLOB` column (Float32Array bytes) and an
      `embedding_model` column on passage nodes. Re-embed when `content_hash` or the model
      changes.
- [x] **Vector seeds.**
  - Brute-force cosine over passages; fine to about 10⁵ passages on a Pi (~medium
    confidence; benchmark it).
  - Add a third list to RRF, `via: 'vector'`.
- [x] **Query commands.**
  - `circadia relate <a> <b>`: shortest paths via BFS or a recursive CTE over allowed
    edges, printing the edge chain with provenance.
  - `circadia timeline <entity>`: every fact about the entity (and its inverses),
    ordered by `valid_from`, including superseded ones.
- [x] **Adjacency cache.** Keep the per-mode graph in memory between queries in
      long-running processes (MCP server), and invalidate on reindex.
- [x] **Benchmark script.**
  - Generate a synthetic vault of 10k notes and 50k links.
  - Report index time, recall p50/p95 per mode, and memory use.
  - Record the results in `docs/PERFORMANCE.md`.

**Acceptance**

- Editing one note reindexes in under 200 ms on a 10k-note vault on the laptop.
- With embeddings enabled against a local llama.cpp server, a paraphrased query with no
  keyword overlap still retrieves the right passage in a test fixture.
- `relate` and `timeline` have tests over the example vault.

---

## Phase 3: MCP server and episode writing ✅

**Deliverables**

- [x] **MCP server over stdio** (`src/mcp/`). Implement JSON-RPC 2.0 framing with no
      dependencies; the protocol surface for tools-only servers is small. If you want
      `@modelcontextprotocol/sdk`, write an ADR first (AGENTS.md §3).
- [x] **Tools** (contract in `src/mcp/README.md`):
  - `recall(query, mode?, as_of?, top_k?, scope?)`: returns hits rendered with
    `renderForContext()`, plus structured metadata.
  - `remember(text, session?, by?, source?)`: writes **one episode** file. It never writes
    facts.
  - `timeline(entity)` and `relate(a, b)`, from Phase 2.
  - `get_note(id)`: read-only.
- [x] **Event segmentation for `remember`** (`src/episodes/segment.ts`).
  - When `text` is a long transcript, split at topic shifts: an embedding-distance jump
    between consecutive windows above a threshold. That jump is the prediction-error
    proxy from event segmentation theory.
  - Fall back to heading or turn boundaries when there are no embeddings.
  - Each resulting episode records `boundary:`.
- [x] **Episode file naming.** `episodes/YYYY/MM/YYYY-MM-DD-<slug>.md`, with a
      collision-safe suffix. Paths are always derived with `slugify()` and never taken from
      the caller.
- [x] **Optional `scope` on recall** (a path prefix or tag) to keep projects apart.
- [x] **Mastra integration example**: a Mastra agent using the MCP server through
      Mastra's MCP client support.

**Acceptance**

- [x] The stdio server passes an MCP conformance smoke test (initialize, tools/list,
  tools/call).
- [x] `remember` with 3 topics in one transcript produces 3 episodes in a test fixture.
- [x] A test proves `remember` can't create or modify anything under `entities/`.
- [x] There is no network listener. If HTTP is added later, it must meet every item under T2 in
  `docs/SECURITY.md`, and have tests.

---

## Phase 4: Consolidation ("sleep")

**Deliverables** (`src/consolidation/`; contract in its README)

- [x] **`circadia consolidate [--dry-run]`**, run nightly by a systemd timer or cron on
      the Pi.
- [x] **Replay.** Select episodes with no `consolidated:` date, or with a date older than
      the file's mtime.
- [x] **Candidate extraction.**
  - A small local model (llama.cpp) extracts `(subject, predicate, object, valid?)`
    candidates per episode. This is batch entity extraction, the defined role for small
    local models.
  - Hosted fallback via OpenRouter only, with a spend-capped key and no OpenAI or xAI
    models.
  - Constrain output to JSON, and validate predicates against `predicates.defs`.
- [x] **Entity resolution (pattern separation).** Match a candidate subject or object to an
      existing note by id, alias, or title, and later by embedding similarity. Otherwise
      propose a new entity.
- [x] **Schema-fit gate** (ARCHITECTURE §3).
  - Promote immediately: known entity, known predicate, and no conflict with a current
    fact.
  - Queue in `.circadia/pending.jsonl` and require corroboration by a second episode or
    confirmation through `circadia review`: new entity, unknown predicate, or a
    contradiction.
- [x] **Bi-temporal supersession.** On a confirmed contradiction:
  1. Strike the old fact.
  2. Add `[superseded:: today]`.
  3. Move it to `## History`.
  4. Append the new fact via `formatFact()`.
  Never delete.
- [x] **Reconsolidation window.** Facts recalled in the same `session` as a contradicting
      episode are prioritized for review. Recall log entries carry a session id once
      Phase 3 lands.
- [x] **Reflection.**
  - When the summed `importance` of newly consolidated episodes about an entity passes a
    threshold, (re)write `schemas/<entity>-overview.md` with `derived: true` and
    `sources:`.
  - Human edits to a schema note are preserved: detect them via git, and diff against the
    last generated version.
- [x] **Mark episodes** with `consolidated: YYYY-MM-DD`. This is the only permitted episode
      edit.
- [x] **One git commit per run**, with a message summarizing promoted, queued, and
      superseded counts. `--dry-run` prints the diff instead.
- [x] **`circadia review`**: an interactive CLI over the pending queue (accept, reject,
      edit).

**Acceptance**

- A fixture episode "we moved X to Y" supersedes `X runs_on Z` with correct `valid`, `at`,
  and `superseded` dates.
- A fixture web-sourced episode can only produce **queued** candidates, never promoted
  ones.
- Running consolidation twice is idempotent.

---

## Phase 5: hipporag extraction

**Deliverables**

- [x] **`TripleExtractor` implementation** using `extraction.endpoint`: an OpenIE-style
      prompt with entity-first extraction, as in HippoRAG. Run only for notes whose
      extraction mode is `hipporag`.
- [x] **`circadia extract [--note id] [--stale-only]`** fills
      `.circadia/triples/<noteId>.jsonl`, and skips passages whose `contentHash` already
      has triples from the same model.
- [ ] **Synonym edges between phrases.** Add a `synonym`/`similar` edge when embedding
      cosine is at least θ (HippoRAG's synonymy edges), weighted by similarity.
- [ ] **Recognition-memory seed filter** (HippoRAG 2). Match the query against triples by
      embedding, filter with a cheap LLM check, and seed from the surviving triples'
      phrases and passages.
- [ ] **Promotion path.** High-confidence triples about entities can be proposed to
      consolidation as candidate facts; they still go through the gate.

**Acceptance**

- On an eval set of multi-hop questions (Phase 7), `hipporag` beats `typed` on
  recall@5 for the scoped notes, and doesn't regress single-hop questions. This is HippoRAG
  2's "no factual-recall regression" bar.

---

## Phase 6: History and time travel ✅

- [x] **Git-backed as-of for prose.** When the vault is a git repo, `--as-of T` reads each
      note at the last commit ≤ T instead of current prose.
- [x] **`circadia history <note-id>`**: show all commits for a note.
- [ ] **Access-log compaction.** Roll old events into per-node summaries of count and
      timestamps sufficient for ACT-R's optimized-learning approximation.

---

## Phase 7: Evaluation and tuning

- [ ] **Personal eval set**: `eval/queries.jsonl` with
      `{query, as_of?, expected_passages[], kind: single-hop|multi-hop|temporal|preference}`.
- [ ] **`circadia eval`**: recall@k, MRR, per mode, per `kind`, and per escalation path.
- [ ] **Threshold tuning** for `minTopMargin`, `minSeeds`, `weights`, `actrThresholdDays`,
      and `damping`.
- [ ] **Ablations**: activation weight 0; importance weight 0; each mode alone.
- [ ] **Optional adapters** for LongMemEval and LoCoMo. Report the methodology honestly:
      the answer model, the judge, and single-run vs best-of. Vendor numbers in this space
      are rarely comparable (see SOURCES).

---

## Packaging (can run in parallel from Phase 3)

- [ ] **Multi-arch (amd64 and arm64) container for the MCP server**, published to GHCR via
      a reusable GitHub Actions workflow:
  - SHA-pinned actions;
  - `actions/attest-build-provenance` on the index digest;
  - Dependabot for actions;
  - non-root user, read-only root filesystem, and the vault as the only writable mount.
- [ ] **npm publish with provenance**, if published.

## Open questions

- Should the predicate vocabulary move from config into a vault note, `_meta/predicates.md`,
  for observability? That costs a markdown-table parser.
- Should access-log events be committed to git? It is personal usage data; the default is
  to keep it local but back it up.
- Per-passage `valid` intervals for prose, so a dated section is filtered by as-of? That
  would need a heading-level convention.
