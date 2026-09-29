# Palimpsest → Circadia Rename Inventory

Generated: 2026-09-29. ~177 occurrences across ~35 files (excluding `.git/` internals and `node_modules/`).

---

## 1. Files to Rename (git mv)

These files contain "palimpsest" in their **filename or path** and must be renamed.

| Current path | New path | Notes |
|---|---|---|
| `bin/palimpsest.mjs` | `bin/circadia.mjs` | CLI launcher; package.json `bin` field points here |
| `examples/vault/palimpsest.config.json` | `examples/vault/circadia.config.json` | Example vault config file |
| `examples/vault/.palimpsest/` | `examples/vault/.circadia/` | Example vault state dir (contains `index.sqlite`, `triples/`) |

**Directory-level renames** (vault state directory):
- `.palimpsest/` → `.circadia/` — this is the vault-internal state directory name. It appears as a **path component** in ~60 references across code, tests, docs, and config defaults. The directory itself is never checked into git (`.gitignore` excludes `**/.palimpsest/index.sqlite*`), but the example vault ships `examples/vault/.palimpsest/triples/capacitive-sensing.jsonl`.

---

## 2. Files to Edit — Source Code

### 2A. Constants and Defaults (rename origin points)

These are the **source-of-truth definitions** that propagate the name. Change these first.

| File | Line(s) | What | Current value |
|---|---|---|---|
| [`src/config.ts`](src/config.ts:172) | 172 | `CONFIG_FILENAME` constant | `'palimpsest.config.json'` → `'circadia.config.json'` |
| [`src/config.ts`](src/config.ts:114-115) | 114–115 | `DEFAULT_CONFIG.index.path` and `.accessLog` | `'.palimpsest/index.sqlite'`, `'.palimpsest/access.jsonl'` → `'.circadia/...'` |
| [`src/config.ts`](src/config.ts:2) | 2 | Comment | `palimpsest.config.json` mention |
| [`package.json`](package.json:2) | 2 | `"name"` | `"palimpsest"` → `"circadia"` |
| [`package.json`](package.json:8) | 8 | `"bin"` key | `"palimpsest": "bin/palimpsest.mjs"` → `"circadia": "bin/circadia.mjs"` |
| [`package.json`](package.json:15) | 15 | `"scripts".palimpsest` | rename script key to `"circadia"` |

### 2B. CLI Module (`src/cli/`)

| File | Line(s) | What |
|---|---|---|
| [`src/cli/main.ts`](src/cli/main.ts:1) | 1 | Comment: `` `palimpsest` CLI `` |
| [`src/cli/main.ts`](src/cli/main.ts:21-23) | 21–23 | `HELP` string: `palimpsest — markdown-vault...`, `usage: palimpsest <command>` |
| [`src/cli/main.ts`](src/cli/main.ts:101) | 101 | `init` command: creates `.palimpsest` directory |
| [`src/cli/main.ts`](src/cli/main.ts:124) | 124 | `.gitignore` content: references `.palimpsest/` |
| [`src/cli/main.ts`](src/cli/main.ts:131) | 131 | `_meta/README.md` content: "Managed by Palimpsest" |
| [`src/cli/main.ts`](src/cli/main.ts:140,290,315,447) | 140, 290, 315, 447 | Error messages: `run \`palimpsest index\`` |
| [`src/cli/review.ts`](src/cli/review.ts:2) | 2 | Comment: `.palimpsest/pending.jsonl` |
| [`src/cli/review.ts`](src/cli/review.ts:24) | 24 | Path construction: `'.palimpsest', 'pending.jsonl'` |
| [`src/cli/watch.ts`](src/cli/watch.ts:1) | 1 | Comment: `` `palimpsest watch` `` |
| [`src/cli/watch.ts`](src/cli/watch.ts:104) | 104 | Ignore filter: `filename.startsWith('.palimpsest')` |

### 2C. Index and Extraction

| File | Line(s) | What |
|---|---|---|
| [`src/index/db.ts`](src/index/db.ts:2) | 2 | Comment: `` `palimpsest index` `` |
| [`src/index/indexer.ts`](src/index/indexer.ts:374-375) | 374–375 | Problem path: `'.palimpsest/triples'` |
| [`src/index/indexer.ts`](src/index/indexer.ts:402-403) | 402–403 | Problem path: `'.palimpsest/triples'` |
| [`src/extract/triples.ts`](src/extract/triples.ts:4) | 4 | Comment: `.palimpsest/triples/<noteId>.jsonl` |
| [`src/extract/triples.ts`](src/extract/triples.ts:31) | 31 | `triplesDir()`: `'.palimpsest', 'triples'` |

### 2D. Retrieval

| File | Line(s) | What |
|---|---|---|
| [`src/retrieval/recall.ts`](src/retrieval/recall.ts:187) | 187 | Error: `run \`palimpsest index\` first` |
| [`src/retrieval/relate.ts`](src/retrieval/relate.ts:1) | 1 | Comment: `` `palimpsest relate` `` |
| [`src/retrieval/timeline.ts`](src/retrieval/timeline.ts:1) | 1 | Comment: `` `palimpsest timeline` `` |

### 2E. Consolidation

| File | Line(s) | What |
|---|---|---|
| [`src/consolidation/consolidate.ts`](src/consolidation/consolidate.ts:77) | 77 | Path: `'.palimpsest', 'pending.jsonl'` |
| [`src/consolidation/README.md`](src/consolidation/README.md:12) | 12 | Reference: `.palimpsest/pending.jsonl` |

### 2F. MCP Server

| File | Line(s) | What |
|---|---|---|
| [`src/mcp/server.ts`](src/mcp/server.ts:45) | 45 | `serverInfo.name`: `'palimpsest'` → `'circadia'` |

---

## 3. Files to Edit — Tests

Every test that creates a temp vault writes `palimpsest.config.json` and references `.palimpsest/` paths.

| File | Line(s) | Occurrences |
|---|---|---|
| [`test/integration.test.ts`](test/integration.test.ts:15) | 15, 42 | temp dir prefix `'palimpsest-test-'`, `palimpsest.config.json` |
| [`test/consolidation.test.ts`](test/consolidation.test.ts:10) | 10, 15, 17, 35, 37, 54, 56, 73, 75 | temp dir prefix, config filename, `.palimpsest/` paths in inline config |
| [`test/incremental.test.ts`](test/incremental.test.ts:13) | 13, 31, 38, 122, 141, 184 | temp dir prefix, config filename, `dbFor()` path |
| [`test/embeddings.test.ts`](test/embeddings.test.ts:21) | 21, 132, 142 | temp dir prefix, config filename, `.palimpsest/` path |
| [`test/vector-seeds.test.ts`](test/vector-seeds.test.ts:18) | 18, 24, 33, 67, 79–81 | temp dir prefix, config filename, `.palimpsest/` paths |
| [`test/relate-timeline.test.ts`](test/relate-timeline.test.ts:15) | 15, 43 | temp dir prefix, config filename |
| [`test/watch.test.ts`](test/watch.test.ts:1) | 1, 13, 23, 28 | comment, temp dir prefix, config filename, `dbFor()` |
| [`test/mcp.test.ts`](test/mcp.test.ts:9) | 9, 24, 31, 54, 140 | temp dir prefix, `.palimpsest/` path, `serverInfo.name` assertion |
| [`test/mcp-invariants.test.ts`](test/mcp-invariants.test.ts:10) | 10, 25, 34 | temp dir prefix, `.palimpsest/` paths |
| [`test/triple-extraction.test.ts`](test/triple-extraction.test.ts:33) | 33, 125 | temp dir prefix |

---

## 4. Files to Edit — Benchmarks

| File | Line(s) | Occurrences |
|---|---|---|
| [`benchmarks/run.ts`](benchmarks/run.ts:25) | 25, 27, 41 | temp dir prefix `'palimpsest-bench-'`, `.palimpsest/` path, console banner |
| [`benchmarks/generate-vault.ts`](benchmarks/generate-vault.ts:33) | 33 | writes `palimpsest.config.json` |

---

## 5. Files to Edit — Documentation

| File | Occurrences | What |
|---|---|---|
| [`README.md`](README.md) | ~20 | Title, metaphor paragraph, brain mapping table, CLI examples, architecture tree, explanation prose |
| [`AGENTS.md`](AGENTS.md) | ~15 | Commands section, invariants, repo map references |
| [`CLAUDE.md`](CLAUDE.md) | 0 | No occurrences (just points to AGENTS.md) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | ~5 | Title, brain-mapping table, `.palimpsest/` references |
| [`docs/CONFIG.md`](docs/CONFIG.md) | ~5 | Config filename, `.palimpsest/` defaults, CLI command references |
| [`docs/RETRIEVAL.md`](docs/RETRIEVAL.md) | ~8 | CLI references, `.palimpsest/` paths, project name |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | ~8 | `.palimpsest/` in vault layout, `palimpsest lint`, `palimpsest.config.json`, `palimpsest init` |
| [`docs/SECURITY.md`](docs/SECURITY.md) | ~1 | "Palimpsest stores personal memory" |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | ~15 | CLI command names throughout |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | 0–1 | Check for mentions |
| [`docs/SOURCES.md`](docs/SOURCES.md) | 0 | No project-name references expected |
| [`docs/decisions/ADR-0001-vault-is-source-of-truth.md`](docs/decisions/ADR-0001-vault-is-source-of-truth.md) | 3 | `.palimpsest/` paths, `palimpsest index` |
| [`docs/decisions/ADR-0003-configurable-graph-modes.md`](docs/decisions/ADR-0003-configurable-graph-modes.md) | 1 | `.palimpsest/triples/` |
| [`examples/vault/_meta/README.md`](examples/vault/_meta/README.md) | ~5 | `.palimpsest/triples/`, CLI commands |

---

## 6. Files to Edit — Config / Build

| File | Line(s) | What |
|---|---|---|
| [`.gitignore`](.gitignore:4) | 4 | `**/.palimpsest/index.sqlite*` → `**/.circadia/index.sqlite*` |
| [`package-lock.json`](package-lock.json:2) | 2, 8, 12 | `"name": "palimpsest"`, bin entry — **regenerated by `npm install`** after `package.json` change |

---

## 7. Explicit Exceptions — Keep or Handle Specially

| Item | Decision | Rationale |
|---|---|---|
| `.git/` internals | **Skip** | Git history, FETCH_HEAD, remote URLs — these are not project content. The GitHub remote URL remains `therebelrobot/palimpsest` until a GitHub repo rename (separate operation). |
| `node_modules/.package-lock.json` | **Skip** | Regenerated by `npm install`; never committed. |
| `roo_task_sep-29-2026_12-49-34-pm.md` | **Skip** | Task log file, not project source. |
| README.md metaphor paragraph | **Decision needed** | "A *palimpsest* is a manuscript..." — this is the origin story. Options: (a) keep the etymology and say "formerly called Palimpsest", (b) replace with Circadia etymology, (c) remove entirely. |
| `package-lock.json` | **Do not hand-edit** | Run `npm install` after `package.json` changes to regenerate. |
| Existing user vaults with `.palimpsest/` dirs | **Legacy fallback needed** | `loadConfig()` and `DEFAULT_CONFIG` should check for `.palimpsest/` and fall back to it when `.circadia/` does not exist. Add a `circadia migrate-name` command to rename on disk. |

---

## 8. Occurrence Categories Summary

| Category | File count | Occurrence count | Complexity |
|---|---|---|---|
| File/dir renames (`git mv`) | 3 | 3 | Low — straightforward renames |
| Constants/defaults (source of truth) | 2 | 5 | Medium — all other references derive from these |
| CLI module | 3 | ~15 | Medium — help text, init scaffolding, error messages, watch filter |
| Core source (index, extract, retrieval, consolidation, mcp) | 6 | ~12 | Low — mostly comments and string literals |
| Tests | 10 | ~40 | Medium — many inline config objects, temp dir prefixes |
| Benchmarks | 2 | ~4 | Low |
| Documentation | 12 | ~60 | High volume but mechanical |
| Config/build | 2 | ~5 | Low — gitignore pattern + package.json |

**Total distinct source files to touch: ~38** (excluding `.git/` and `node_modules/`).

---

## 9. Key Invariants from AGENTS.md to Preserve

1. **Zero runtime dependencies.** The rename is pure string replacement; no new deps.
2. **`.ts` imports with `.ts` extensions, `erasableSyntaxOnly`.** No import paths contain "palimpsest" — they are all relative (`'./types.ts'`, `'../config.ts'`). No import changes needed.
3. **The vault is the source of truth.** `.palimpsest/` (→ `.circadia/`) is derived. Deleting it and running `circadia index` must reproduce it. The rename must not break this invariant.
4. **Episodes are append-only.** No episode files contain "palimpsest" in their content — safe.
5. **Config filename is the entry point for vault identity.** `CONFIG_FILENAME` in [`src/config.ts`](src/config.ts:172) is the single constant; all config loading flows through [`loadConfig()`](src/config.ts:219). Renaming the constant propagates to all call sites automatically.
6. **`index.path` default** in [`DEFAULT_CONFIG`](src/config.ts:114) is the single source for the state directory path. But ~20 test files hardcode `'.palimpsest/...'` in inline config objects — those must also change.
7. **No private hostnames or personal domains.** The rename introduces no new hostnames. `127.0.0.1` and `example.com` remain the only addresses.
8. **Tests must not mutate `examples/vault/`.** Tests pass `dbPath` to temp dirs. The example vault rename (config file + `.palimpsest/` dir) is a one-time structural change, not a test mutation.

---

## 10. Recommended Commit Sequence

1. **Commit 1: Constants + state dir** — Change `CONFIG_FILENAME`, `DEFAULT_CONFIG.index.*` paths, `triplesDir()`, consolidation pending path, watch ignore filter. This is the "source of truth" commit.
2. **Commit 2: File renames** — `git mv bin/palimpsest.mjs bin/circadia.mjs`, rename example vault config and `.palimpsest/` → `.circadia/`. Update `package.json` (name, bin, scripts). Run `npm install` to regenerate lockfile.
3. **Commit 3: CLI text** — Help strings, error messages, init scaffolding content, comment headers.
4. **Commit 4: Tests** — Temp dir prefixes, inline config filenames, `.palimpsest/` path references, MCP `serverInfo.name` assertion.
5. **Commit 5: Documentation** — README, AGENTS.md, all docs/*.md, ADRs, example vault `_meta/README.md`.
6. **Commit 6: .gitignore** — Update the glob pattern.
7. **Commit 7 (optional): Legacy fallback** — `loadConfig()` checks for old config filename; `init` creates `.circadia/`; add `circadia migrate-name` subcommand.

Each commit should pass `npm test && npm run typecheck` independently.
