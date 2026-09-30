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
- [x] **Adjacency cache.** `createGraphCache(db)` keeps the per-mode graph in memory
      between queries and self-invalidates when the index's `built_at` changes. `recall()`
      accepts it via `graphCache`; the MCP server opens the index once and passes one.
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
- [x] **Replay.** Select episodes with no `consolidated:` date, or whose body has changed
      since consolidation last ran. The body hash is recorded in `.circadia/consolidated.json`
      (not in the episode, whose only permitted edit is `consolidated:`). Re-selection is
      content-based, not mtime-based: a vault copy, checkout, rsync, or restore moves mtimes
      without changing content and must not re-trigger consolidation. A changed body means a
      manual fix (or C1-style damage), not a new event — episodes are append-only, so a
      legitimate new event is a new file.
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
  Never delete. A claim older than the current fact it contradicts never supersedes it — it
  queues with reason `older than the current fact`, and supersession refuses to write an
  interval that ends before it starts.
- [x] **Reconsolidation window.** Facts recalled in the same `session` as a contradicting
      episode are prioritized for review: the queued record is marked
      `priority: "reconsolidation"` and `circadia review` sorts it first. Recall log
      entries carry a session id (Phase 3 landed).
- [x] **Reflection.**
  - When the summed `importance` of newly consolidated episodes about an entity passes a
    threshold, (re)write `schemas/<entity>-overview.md` with `derived: true` and
    `sources:`.
  - Human edits to a schema note are preserved. The generated body's hash is stored in the
    note's frontmatter as `generated_hash`; on the next run, a body whose hash differs is
    treated as human-edited and left alone. This is content-based, so it works without git
    and catches committed edits (the old `git diff HEAD` check only saw uncommitted ones).
- [x] **Mark episodes** with `consolidated: YYYY-MM-DD`. This is the only permitted episode
      edit.
- [x] **One git commit per run**, with a message summarizing promoted, queued, and
      superseded counts. `--dry-run` prints the diff instead.
- [x] **`circadia review`**: an interactive CLI over the pending queue (accept, reject,
      edit).

**Notes**

- `predicates.defs` defaults to `{}`: with no predicates declared, every candidate is an
  unknown predicate and queues — nothing auto-promotes until predicates are defined.
- `cardinality` defaults to `many`: an unconfigured predicate accumulates objects rather
  than treating a second object as a contradiction. Set `cardinality: "single"` only where
  replacement makes sense (e.g. `runs_on`, `status`).

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
- [x] **Synonym edges between phrases.** Add a `synonym`/`similar` edge when embedding
      cosine is at least θ (HippoRAG's synonymy edges), weighted by similarity.
- [x] **Recognition-memory seed filter** (HippoRAG 2). Match the query against triples by
      embedding, filter with a cheap LLM check, and seed from the surviving triples'
      phrases and passages.
- [x] **Promotion path.** High-confidence triples about entities can be proposed to
      consolidation as candidate facts; they still go through the gate.

**Acceptance**

- **Not met on the Phase 7 fixture.** On the eval set of multi-hop questions
  (`eval/queries.jsonl`), `hipporag` does not beat `typed` on recall@5 unscoped (both
  0.125), so HippoRAG 2's "no factual-recall regression" bar is not met. The scoped
  correctness check passes (`multi-hop-scoped`: hipporag 1.000, typed 0.000), but a scope
  shrinks the retrieval problem, so it is not evidence the unscoped query works. Numbers:
  [`eval/baseline.json`](../eval/baseline.json).

---

## Phase 6: History and time travel ✅

- [x] **Git-backed as-of for prose.** When the vault is a git repo, `--as-of T` reads each
      note at the last commit ≤ T instead of current prose. A note with no commit ≤ T, or a
      vault that is not a git repo, falls back to the current text; the CLI says which
      happened (`as-of prose: …`). Facts keep their existing exact as-of filtering.
- [x] **`circadia history <note-id>`**: show all commits for a note.
- [x] **Access-log compaction.** Roll old events into per-node summaries of count and
      timestamps sufficient for ACT-R's optimized-learning approximation.

---

## Phase 7: Evaluation and tuning ✅

- [x] **Personal eval set**: `eval/queries.jsonl` with
      `{query, as_of?, expected_passages[], kind: single-hop|multi-hop|temporal|preference}`.
- [x] **`circadia eval`**: recall@k, MRR, per mode, per `kind`, and per escalation path.
- [x] **Threshold tuning** for `minTopMargin`, `minSeeds`, `weights`, `actrThresholdDays`,
      and `damping`.
- [x] **Ablations**: activation weight 0; importance weight 0; each mode alone.
- [x] **Optional adapters** for LongMemEval and LoCoMo. Report the methodology honestly:
      the answer model, the judge, and single-run vs best-of. Vendor numbers in this space
      are rarely comparable (see SOURCES).

**Acceptance**

- **recall@k / MRR per mode, per `kind`, and per escalation path.** `circadia eval`
  reports all three; the full run is recorded in [`eval/baseline.json`](../eval/baseline.json).
  Methodology and caveats: [`docs/EVAL.md`](EVAL.md).
- **Two runs are identical.** `test/eval-determinism.test.ts` asserts byte-identical
  output; `test/eval-fixture.test.ts` asserts the fixture itself is byte-identical.
- **Trust violation count, with a single violation failing the run.**
  `test/eval-trust.test.ts` plants one violation and asserts `report.failed === true`;
  the CLI maps `report.failed` to a non-zero exit. The gate recomputes each hit's
  trust from the index rather than reading the value recall reported, so it fires
  when the trust filter regresses (a C12-style laundering path) instead of agreeing
  with it (ADR-0010 §Consequences).
- **Missing gold ids fail the run.** `runEval` checks every `expected_passages`,
  `expect_absent`, and `expect_before` id against the built index; the CLI exits
  non-zero unless `--allow-missing` (`test/eval-cli.test.ts`).
- **A personal vault cannot write the tracked baseline.** A non-fixture target has
  no default baseline, `--update-baseline` requires an explicit path outside the
  repo, and output is aggregate-only by default (`test/eval-cli.test.ts`).
- **hipporag beats typed on scoped multi-hop recall@5 and does not regress single-hop,
  met on synthetic triples.** Forced-mode aggregates: `multi-hop-scoped` recall@5
  hipporag 1.000 vs typed 0.000; `single-hop` recall@5 1.000 for both (MRR hipporag
  0.735 vs typed 0.720). The unscoped `multi-hop` bar is still not met (both 0.125) —
  see the Phase 5 acceptance note above.
- **Recall fix (Step 12).** A single-hit result no longer receives top confidence, so
  `auto` escalates instead of treating a lone seed as certain. Delta vs the pre-fix
  baseline: the four `multi-hop-scoped` deep queries moved `wikilink → hipporag`,
  recall@5 0.000 → 1.000; violation counts unchanged. Regression test:
  `test/recall-auto-escalation.test.ts`.

---

## Phase 8: Dreaming (REM pass and wake recall)

RFC-0001. Contract in `src/dreams/README.md`; decision in ADR-0011.

**Deliverables**

- [x] **Stage 1 — ADR and contract.** ADR-0011 (disposable state category, gitignore
      enforcement, the `dream` origin at weight 0, why confirmation is CLI-only),
      `src/dreams/README.md`, and the brain-map rows.
- [ ] **Stage 2 — REM pass, dry run.** `circadia dream [--dry-run | --sample-only]` and
      `consolidate --dream`: recent side by ACT-R activation, remote side by PPR-weighted
      sampling over non-dream origins, proposal through the extraction model, grounding,
      scoring, and the night's log. Shared `src/util/rng.ts` extracted from the two LCG
      copies. `circadia init` adds `.circadia/dreams/` to `.gitignore`.
- [ ] **Stage 3 — Candidates, wake, review.** `circadia wake [--json]`, MCP `wake`,
      `endorse_dream`, `dismiss_dream`, the dreams section in `circadia review`, and
      candidate expiry.
- [ ] **Stage 4 — Dream edges at weight 0.** `EdgeOrigin` gains `'dream'`, `MODE_ORIGINS`,
      `graph.originWeights.dream: 0`, the indexer's dream-edge emission, `relate` exclusion,
      the committed `eval/dreams.fixture.jsonl`, and a baseline refresh.
- [ ] **Stage 5 — Measure, then decide.** `circadia eval --dream-sweep` over
      `originWeights.dream` ∈ {0, 0.25, 0.5, 1}. Report-only; turning dreams on is a human
      decision.

**Acceptance**

- Stage 2 gate: the pass writes nothing outside `.circadia/dreams/`, never appends to
  `access.jsonl`, never samples below `dreaming.trustFloor`, and refuses to run when the
  path isn't git-ignored. Re-running a night is a no-op; every recorded-response case is
  handled.
- Stage 3 gate: `wake` deletes the log and a second call reports nothing left; two
  concurrent `wake` calls return the log once; a failed-pass fixture yields "slept badly";
  MCP tools never write under the vault's note folders; review accept writes exactly one
  `by:: user` `related_to` fact; timezone test in `America/New_York` after 20:00.
- Stage 4 gate: `index` rebuilds identical edges from the candidate file and expiry removes
  them; at weight 0 the Phase 7 baseline shows 0 deltas in hits, metrics and aggregates;
  `relate` output is unchanged; the `dream` ablations appear in `--ablate` output; the
  fixture distance tests still pass with `dream` excluded.
- Stage 5: dreams are turned on only if remote-association recall@5 rises on both dev and
  holdout, no kind regresses on either split in the decoys-only run, and trust stays at 0.
  If the sweep is flat, dreams stay at weight 0.

**Notes**

- A user who never sets any `dreaming.*` key gets no dreaming at all
  (`dreaming.enabled: false`).
- Dream state is disposable and never committed; see ADR-0011.

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
