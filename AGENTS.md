# AGENTS.md

You are picking up **Circadia**, a markdown-vault memory system with a derived graph
index. Assume you have **no other context**. This file tells you how to work in the repo
without breaking its invariants. Read it fully before editing anything.

## 1. Orientation, in order

1. Read `README.md` for what this is and the current status.
2. Read `docs/SCHEMA.md`. It is the contract; the vault format beats the code.
3. Read `docs/ARCHITECTURE.md` for why each piece exists. Every mechanism traces to a
   cognitive-science finding; keep that traceability when you add things.
4. Read `docs/ROADMAP.md` and find the first phase whose items aren't checked. That is your
   work.
5. Run `npm install && npm test && npm run typecheck`. All three must pass before and after
   your change.

## 2. Commands

```bash
npm test                  # node:test, ~16s. 341 tests.
npm run typecheck         # tsc --noEmit, strict + erasableSyntaxOnly
npm run example:index     # index examples/vault (incremental; --full for a full rebuild)
node bin/circadia.mjs watch --vault examples/vault   # reindex on change (Ctrl-C to stop)
npm run example:recall -- "query"   # --no-log is baked in so the example access log stays clean
node bin/circadia.mjs relate --vault examples/vault orchard-sensors pi-cluster
node bin/circadia.mjs timeline --vault examples/vault orchard-sensors
node bin/circadia.mjs dream --vault examples/vault --sample-only   # sample REM pairs; no model calls
node bin/circadia.mjs wake --vault examples/vault   # read the night's dream log once and forget it
npm run benchmark         # 10k-note synthetic vault: index, incremental, recall p50/p95, RSS
npm run eval              # generate the eval fixture, then run the retrieval eval
npm run eval:check        # same, but exit non-zero on any baseline delta (CI)
node bin/circadia.mjs eval --dream-sweep   # dream-edge weight sweep (report only)
docker buildx build --load -t circadia:local .   # build the stdio image locally
./scripts/container-smoke.sh circadia:local      # non-root, read-only, MCP stdio, git checks
node bin/circadia.mjs --help
```

## 3. Hard constraints

1. **Zero runtime dependencies.** Use Node built-ins only: `node:sqlite`, `node:crypto`,
   `node:fs`, `node:test`, `node:http` (test mocks only), and global `fetch`. Dev
   dependencies stay limited to `typescript`, `@types/node`, and
   `@modelcontextprotocol/sdk` (dev-only, for MCP conformance tests — see ADR-0008). If
   you believe another dependency is truly needed, write an ADR in `docs/decisions/`
   arguing for it and stop for human review.
2. **TypeScript that Node can run with type stripping.** No build step for development:
   the CLI, tests and scripts run `src/*.ts` directly. The one exception is publish time
   (ADR-0012): `prepack` emits plain JS to `dist/` because Node won't strip types under
   `node_modules`, and `bin/circadia.mjs` uses `dist/` only when installed there. Never
   import from `dist/`, and never commit it. That means:
   - Import with `.ts` extensions (`import { x } from './y.ts'`).
   - Use `import type` for type-only imports; `verbatimModuleSyntax` is on.
   - No `enum`, no `namespace`, no constructor parameter properties, no decorators.
     `erasableSyntaxOnly` enforces this. Use string-literal unions and `as const` objects.
3. **Node ≥ 22.18.** Don't use APIs newer than that without bumping `engines`.
4. **Model providers.** Never default to, recommend, or configure OpenAI or xAI (Grok)
   models, and avoid Meta models unless the alternatives are poor. This is an owner
   requirement. "OpenAI-compatible HTTP API" as a *wire format* is fine; llama.cpp's
   `llama-server` speaks it. Defaults point at `http://127.0.0.1:8080` (local llama.cpp).
   For hosted models, route through OpenRouter to non-OpenAI, non-xAI models.
5. **No private hostnames, personal domains, or machine names** in code, config, docs, or
   examples. Use `example.com`, `127.0.0.1`, or `<docker-host>`.
6. **Network services bind to loopback and require auth by default** (Phase 3+). See
   `docs/SECURITY.md`. Prior audits of comparable projects found unauthenticated `0.0.0.0`
   binds to be the most common real-world failure; don't repeat it.

## 4. Invariants (tests rely on these; don't break them)

- **The vault is the source of truth.** Everything in `.circadia/index.sqlite` must be
  reproducible by deleting it and running `circadia index`. The only non-derivable state
  is the vault itself, `.circadia/access.jsonl`, `.circadia/triples/` (a cache of LLM
  output), and `.circadia/consolidated.json` (each episode's body hash at the last
  consolidation, so re-selection is content-based rather than mtime-based — C22).
  `.circadia/dreams/` (the REM log and candidate queue) is non-derivable but **disposable**
  and never committed to git; losing it loses nothing the user asked to keep (ADR-0011).
- **Episodes are append-only.** Code never edits an episode body. The one exception:
  consolidation may set the `consolidated:` frontmatter field.
- **Facts are never deleted.** A changed fact is struck through
  (`~~claim~~ [superseded:: date]`) and moved to `## History`. The new fact goes in
  `## Facts`. See `formatFact()` in `src/vault/facts.ts` for the canonical serializer.
- **Agents never write facts directly.** The MCP `remember` tool writes *episodes*. Only
  consolidation promotes episode content to facts, and those facts carry `by:: agent` and
  `src:: [[episode]]`. This is the memory-poisoning defense.
- **Provenance is mandatory for non-human facts.** `by:: agent|tool|web` requires `src::`.
  The linter errors otherwise.
- **Low-trust content is fenced as data.** `renderForContext()` wraps `trust: low`
  passages in `<untrusted-data>` and escapes attempts to close the fence. Anything new
  that emits memory into a model context must do the same.
- **Query text is never logged.** The access log stores a hash (`q`), not the query.
- **The index is only an index.** Passage text is copied into SQLite for FTS, but nothing
  may write to the index that isn't derived from the vault or the triple cache.

## 5. Repo map and responsibilities

| path | owns | notes |
|---|---|---|
| `src/types.ts` | shared types | string-literal unions only |
| `src/config.ts` | defaults, deep-merge, validation | every new key needs a default, a validation rule if constrained, and a row in `docs/CONFIG.md` |
| `src/vault/frontmatter.ts` | YAML **subset** parser | flat maps only; don't grow it into full YAML |
| `src/vault/time.ts` | period/interval parsing | half-open intervals, UTC for date-only values |
| `src/vault/facts.ts` | fact-line grammar + serializer | must match `docs/SCHEMA.md` §4 exactly |
| `src/vault/fact-write.ts` | append a fact line to a note's `## Facts` | pure `appendFactLine` + I/O wrapper; idempotent; used by consolidation |
| `src/vault/parse.ts` | note → passages, links, facts, problems | passage ids are `<noteId>#<n>` and `<noteId>#facts` |
| `src/vault/walk.ts` | file discovery | skips dot-folders, `_meta/`, `vault.ignore` globs |
| `src/extract/scope.ts` | per-note extraction mode | precedence: frontmatter > first scope rule > default |
| `src/extract/triples.ts` | hipporag triple cache + `TripleExtractor` contract | Phase 5 implements an extractor |
| `src/index/db.ts` | SQLite schema, FTS5 probe | bump `INDEX_SCHEMA_VERSION` on schema changes |
| `src/index/indexer.ts` | full rebuild + incremental update + `embedPassages` + dream-edge emission | `buildIndex` (full) and `incrementalIndex` (diffs the `files` table) stay synchronous; `embedPassages` is the async follow-up. `emitDreamEdges()` rebuilds `dream` edges from `.circadia/dreams/candidates.jsonl` on every index (RFC-0001 Stage 4) |
| `src/retrieval/*` | keyword, PPR, ACT-R, modes, recall, embeddings, relate, timeline, graph cache | `recall.ts` is the orchestrator; `graph-cache.ts` owns edge loading/filtering (`loadGraph`) shared by recall and the cache |
| `src/cli/main.ts` | CLI | `main(argv)` is async and returns an exit code, so it's testable (`await main(...)`) |
| `src/cli/watch.ts` | `watch` command | reindexes on change; embeds best-effort after each reindex |
| `benchmarks/` | synthetic vault generator + benchmark runner | `npm run benchmark`; results in `docs/PERFORMANCE.md` |
| `src/consolidation/` | episode replay → candidate extraction → schema-fit gate → promote/queue/supersede | `schema.ts` `evaluateGate` is pure (facts are read in `consolidate.ts`); untrusted sources and triple candidates always queue (ADR-0006) |
| `src/dreams/` | REM pass → candidate associations → read-once wake recall | writes only under `.circadia/dreams/`; never writes the vault; dream edges ship at weight 0 (ADR-0011); contract in its README |
| `src/mcp/` | MCP server (stdio) | contract in its README |
| `src/eval/` | eval runner, metrics, ablations, baseline, tuning, adapters, dream sweep | strictly read-only; determinism contract in ADR-0010 |
| `eval/` | fixture generator, query set, committed baseline | `npm run eval`; `eval/.fixture/` is generated and gitignored |
| `bin/circadia.mjs`, `tsconfig.build.json` | launcher and publish-time build | the launcher runs `src/` from a clone and `dist/` only when installed under `node_modules` (ADR-0012); `test/build.test.ts` guards it |
| `docs/media/` | README and docs GIFs, plus their Remotion source in `blueprints/` | not shipped to npm; its own `package.json`, outside the root tests and typecheck; regenerate with `npm run gifs` there |
| `Dockerfile`, `.dockerignore` | stdio container image | multi-arch; non-root, read-only root (via the `--read-only` run flag), vault the only writable host mount plus an ephemeral `/tmp` tmpfs; no listener, no scheduler, no `EXPOSE` (RFC-0003 covers the server image) |
| `.github/workflows/container-*.yml` | container CI and GHCR publish | `container-build.yml` is reusable (`workflow_call`); `container-publish.yml` runs on `v*` tags; `container-pr.yml` builds amd64 and runs the smoke script; actions SHA-pinned |

## 6. How to make a change

1. **Schema changes** (vault format): update `docs/SCHEMA.md` first, then the parser, then
   `templates/` and `examples/vault/`, then tests. If existing vaults break, bump the schema
   version and add a migration under `src/vault/migrate/`.
2. **New config**: update `src/config.ts` (type, default, validation), then
   `docs/CONFIG.md`, then add a test.
3. **Retrieval changes**: keep scores explainable. Every hit carries
   `components: { graph, activation, importance, seed }`. If you add a signal, add a
   component, a weight in `retrieval.weights`, and a line in `docs/RETRIEVAL.md` §Scoring.
4. **Design decisions**: add `docs/decisions/ADR-NNNN-title.md` using the existing ADRs'
   format (Context / Decision / Consequences / Status).
5. **Sources**: if a paper, doc, or issue informed the change, add it to `docs/SOURCES.md`.
6. Update the checkboxes in `docs/ROADMAP.md`.
7. **Keep this file current.** When a change alters behavior, commands, the repo map, or a
   known limitation, update the matching section of `AGENTS.md` in the same change — it is
   the first thing the next agent reads, and a stale AGENTS.md is worse than none.

## 7. Testing expectations

- Unit tests for every parser rule and scoring function; integration tests over
  `examples/vault/`.
- Tests must **not** mutate `examples/vault/`. Pass `dbPath` to a temp dir and
  `logAccess: false`.
- If you change the example vault, update the counts asserted in
  `test/integration.test.ts` and state why in the commit.
- Security behaviors (fencing, trust floor, provenance lint) have tests. Keep them green;
  add one for every new path that emits memory content.

## 8. Style

- Small modules, pure functions where possible, and I/O at the edges (the CLI, and recall's
  db and access-log calls).
- Explain *why* in comments, especially where a cognitive mechanism is implemented.
- Errors are `Problem` objects with stable `code`s (`fact.missing-src`, `link.unresolved`,
  and so on). Add new codes rather than reusing ones with a different meaning.
- Keep the CLI output human-readable, and support `--json` for anything an agent will parse.

## 9. Known limitations at handoff (all tracked in ROADMAP)

- `index` is incremental by default (re-parses only changed notes); `index --full` forces a
  full rebuild. Incremental re-resolution is O(affected notes), so it stays fast well past
  10⁴ notes (measured: 134 ms for one note on a 10k-note vault; `docs/PERFORMANCE.md`).
- Embeddings are implemented (Phase 2) but **off by default** (`embeddings.provider:
  "none"`). Vector seeds are brute-force cosine over stored passage embeddings — fine to
  about 10⁵ passages; beyond that an ANN index would need an ADR for a dependency.
- `--as-of` is exact for facts and, when the vault is a git repo, for prose too: each hit's
  passage is re-read from the note at the last commit ≤ T (C17). A note with no commit ≤ T,
  or a non-git vault, falls back to the current text and the CLI says so.
- The hipporag triple extractor is not implemented. The example vault ships a
  hand-written triple cache to exercise the path.
- One-shot recall re-reads edges from SQLite per query. Long-running processes pass a
  `graphCache` (`createGraphCache(db)`) to `recall()`; it caches per (mode, asOf) and
  self-invalidates when the index's `built_at` meta changes. The MCP server does this.
- The eval harness (`npm run eval`) measures retrieval only — recall@k/MRR over gold
  passages, no answer model or judge — so its numbers are not comparable to vendor
  LongMemEval/LoCoMo figures. It is deterministic (fixed clock, no logging, trigram
  lexical embeddings) and strictly read-only. Tuning (`eval --tune`) is report-only and
  never writes defaults. The trust gate recomputes each hit's trust from the index, so
  it fires when the trust filter regresses rather than agreeing with it. A gold id not
  in the index fails the run unless `--allow-missing`; a non-fixture target has no
  default baseline and is aggregate-only. See `docs/EVAL.md` and ADR-0010.

## 10. Working rules for agents

These came from real failures during remediation (`docs/remediation.md` §4). They apply to
every change.

**Verification**

- Report only what you verified by running it. For each issue ID say "fixed" (and name the
  test that proves it), "partial" (say what's missing), or "not started". Never summarize as
  "resolved".
- A claim like "idempotent" or "safe" must state its exact scope.

**Data safety**

- Never run a mutating command (`consolidate`, `review`, `index --full`, migrations) against
  anything tracked in the repo, including `examples/vault/`. Copy it to a temp directory.
- Before committing, run `git status` and `git diff --stat`. If anything changed that you
  didn't intend, stop and explain.

**Scope**

- Don't modify or revert code outside the issue IDs you were given. If earlier work looks
  wrong, report it; don't undo it.

**Tests**

- Take expected values from the spec (`docs/SCHEMA.md`, the ROADMAP acceptance criteria),
  not from what the code currently outputs.
- Assert effects on disk: file contents, lint results, which fact is current. Checking which
  episodes were *selected* missed a regression that reverted facts.
- Each fix gets a test that fails before the fix, and the report must say so.

**Semantics**

- For a new config key or default, choose the value that can't lose or misstate data for a
  user who never sets it, and say what that user gets. `cardinality: single` as the default
  struck out correct facts.
- Name what each written value means: world time (`valid::`) vs system time (`at::`,
  `superseded::`, `consolidated:`), plus trust and provenance.
- Never trust mtime as evidence of an edit. Copies, checkouts and restores all change it.

**Commits**

- Name the issue IDs in the commit message. Commit when done. Say "committed, not pushed"
  unless you were told to push.
- Never amend, rebase, or force-push a commit that has already been pushed; make a new
  commit instead.
- Don't commit new untracked files unless asked; list them in the report instead.
