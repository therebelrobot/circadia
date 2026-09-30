# Circadia: remediation status

Last updated 2026-09-29, at commit `79d37e9`. The original audit was taken at `c67157e`.

Every P0 and P1 issue from the audit is fixed, and each fix has been verified end to end:
through the real CLI against a mock model, through the official MCP SDK client, and with
regression tests that fail on the old code. Several further issues found during remediation
are fixed too (§2). Five small items remain (§3). None of them affects correctness or safety.

At `79d37e9`: 175 tests pass, the typecheck is clean, the example vault lints clean, runtime
dependencies are zero, and `git grep "execSync(" src` is empty.

---

## 1. Audit issues

| ID | Issue | Status | Commit(s) |
|---|---|---|---|
| C1 | Consolidation corrupted episode frontmatter | Fixed: a one-line in-place `consolidated:` edit | `68067c2` |
| C2 | Promoted facts never written | Fixed | `3a776b5`, `564e8e6` |
| C3 | Supersession never wired in | Fixed; many-valued default, world-time dates | `3a776b5`, `16d23ad` |
| C4 | Web/tool episodes could auto-promote | Fixed: untrusted sources always queue | `3a776b5` |
| C5 | Shell injection via `--as-of` | Fixed: `execFileSync` everywhere, refs verified | `0a5fbc7` |
| C6 | Consolidation not idempotent | Fixed: stable keys, `rejected.jsonl`, triple re-proposal tracking | `6dcc2cd` |
| C7 | `--dry-run` had side effects | Fixed: in-memory change set, in-process diff | `6dcc2cd` |
| C8 | Commit swept in unrelated edits | Fixed: commits only run paths; refuses if they were already dirty | `6dcc2cd` |
| C9 | `review` lost accepted candidates | Fixed: accept writes the fact, reject is recorded, unknown input re-prompts | `bff09b4`, `5b0b61d` |
| C10 | LLM clients used the wrong wire format | Fixed: shared `src/llm/chat.ts` client | `b88e2ce` |
| C11 | Candidate prompt/parser mismatch, unfenced text | Fixed: `{"candidates":[...]}` contract, validation, escaped fences | `b88e2ce`, `b3950f7` |
| C12 | Synonym edges laundered trust | Fixed: min of endpoint trust | `8bcd219`, `80f091b` |
| C13 | Triple promotion ignored trust and provenance | Fixed: triple candidates always queue (ADR-0006) | `3a776b5` |
| C14 | Access-log summaries froze ACT-R, ignored as-of | Fixed: optimized-learning form, watermark, tail read (ADR-0009) | `3cc8c91`, `f057227` |
| C15 | `resolveCommit` returned HEAD's timestamp | Fixed | `0a5fbc7` |
| C16 | MCP `recall` didn't log access or pass scope/session | Fixed: `mcp.logAccess` (default on) | `6e15443` |
| C17 | Git-backed as-of for prose not wired | Fixed: falls back to current text and says so | `e288c30` |
| C18 | Reconsolidation window unimplemented | **Open**: see §3 | none |
| C19 | Recall `scope` not implemented | Fixed: path prefix or `tag:name`, CLI and MCP | `6e15443`, `b343a94` |
| C20 | Mastra example missing | **Open**: see §3 | none |
| C21 | Reflection missed committed human edits | Fixed: `generated_hash`, no git needed | `e288c30` |
| C22 | Episode re-selection policy | Fixed: body-hash state; world-time supersession guard | `e288c30`, `79d37e9` |
| C23 | Fact-id collisions, broken wikilink regex | Fixed | `3a776b5`, `6dcc2cd` |
| C24 | `.circadia` hardcoded in 5 places | Fixed: `STATE_DIR` | `24d973b` |
| C25 | Tests wrote stale `palimpsest` fixtures | Fixed | `24d973b` |
| C26 | Test coverage gaps | **Mostly closed**: see §3 | many |
| C27 | Paths interpolated into shell strings | Fixed | `0a5fbc7` |
| C28 | `src/.DS_Store` committed | **Open**: see §3 | none |
| C29 | Roadmap overstates completion | **Open**: see §3 | none |

## 2. Issues found during remediation (all fixed)

| Issue | Why it mattered | Commit(s) |
|---|---|---|
| MCP `remember` let callers claim `by: user` (the default was `user`) | An agent reading a hostile page could mint trusted episodes that skip the C4 queue and supersede facts. Now it defaults to `agent`, and `user` is refused over MCP | `b3950f7` |
| Data fences could be closed by the text inside them | Pasted `</episode-data>` put attacker text outside the fence. Tags inside the text are now escaped | `b3950f7` |
| MCP transport unusable by real clients | Responses had `id: null`, stdin was read in chunks, a banner went to stdout, notifications got replies, and `initialize` lacked `protocolVersion`. Now verified with `@modelcontextprotocol/sdk` (dev-only, ADR-0008) | `8e5c00c`, `6010a56`, `c4230a7`, `afec071` |
| Phrase nodes never embedded | Synonym edges (Phase 5) never formed in a real vault | `80f091b` |
| Compaction gave no speed benefit | Recall read the whole raw log anyway. It now reads from the summary's byte offset (~600 ms → ~250 ms at 300k events) | `f057227` |
| mtime-based re-selection reverted facts (from the first C22 attempt) | A vault copy re-selected old episodes; an old claim superseded a newer fact and wrote a backwards interval. Replaced with body hashes plus a world-time guard | `79d37e9` |
| UTC dates stamped in consolidation, review and episode filenames | Evening runs west of UTC stamped tomorrow's date | `0a5fbc7`, `5b0b61d`, `8e5c00c` |

## 3. Open items

### C18: reconsolidation window

The roadmap (Phase 4) says facts recalled in the same `session` as a contradicting episode
are prioritized for review. Session ids are now logged on every recall (C16), but nothing in
`src/consolidation/` reads them.

- **Implement:** when a queued contradiction's subject fact was recalled in the same
  session as the contradicting episode, mark the pending record `priority: "reconsolidation"`
  and sort those records first in `circadia review`. Test: a recall with `session: s1` plus
  an episode with `session: s1` contradicting that fact produces a prioritized record; the
  same scenario with different sessions doesn't.
- **Or uncheck** the roadmap item and say why.

### C20: Mastra integration example

It's checked on the roadmap, but `examples/` contains only `vault/`.

- **Implement:** `examples/mastra/` with a minimal agent that connects to `circadia mcp`
  over stdio through Mastra's MCP client, calls `recall` and `remember`, and a README.
  Keep its dependencies inside `examples/mastra/package.json`, never in the root package.
- **Or uncheck** it.

### C26: test coverage sweep

Most gaps closed as each fix added tests. Do one sweep:
- list every module in `src/`, and for each one without a direct test, add one, or record
  in the report why it's covered indirectly;
- add the **mock-model end-to-end scenario** (§5) as a permanent test, if it isn't one
  already. It has caught more real bugs than any unit test.

### C28: `src/.DS_Store`

`git rm --cached src/.DS_Store`, and add `.DS_Store` to `.gitignore`.

### C29: roadmap accuracy

Do a final pass over `docs/ROADMAP.md` so every checkbox matches the code:
- C18 and C20 are currently checked but not done;
- Phase 5's acceptance criterion depends on the Phase 7 eval set, which doesn't exist yet.
  Mark it "implemented; acceptance pending Phase 7";
- note that `predicates.defs` defaults to `{}`, so nothing auto-promotes until predicates
  are defined, and that `cardinality` defaults to `many`.

## 4. Working rules for the next agent

These rules came from real failures during remediation.

**Verification**
- Report only what you verified by running it. For each issue ID: "fixed" (name the test),
  "partial" (say what's missing), or "not started".
- A claim like "idempotent" or "safe" must state its exact scope.

**Data safety**
- Never run a mutating command (`consolidate`, `review`, `index --full`, migrations) on
  anything tracked in the repo, including `examples/vault/`. Copy it to a temp directory.
- Before committing, run `git status` and `git diff --stat`. If anything changed that you
  didn't intend, stop and explain.

**Scope**
- Don't modify or revert code outside the issue IDs you were given. If earlier work looks
  wrong, report it; don't undo it. (An earlier session silently reverted a security fix.)
- List every file you touched and the issue ID it belongs to.

**Tests**
- Take expected values from the spec (`docs/SCHEMA.md`, the ROADMAP acceptance criteria),
  not from what the code currently outputs. A test once locked in the wrong `valid::` date.
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
- Don't commit new untracked files unless asked; list them in the report instead.

## 5. Verification recipes

These are the checks that found real bugs the unit tests missed. Run them after any change
to consolidation, review, recall or MCP.

**Mock-model end-to-end** (consolidation, supersession, review): run a tiny `node:http`
server on `127.0.0.1` that answers `/v1/chat/completions`. It returns `400` for bodies
without `messages`, and otherwise returns canned `{"candidates":[...]}` keyed by marker words
in the fenced episode text. Point a temp copy of `examples/vault/` at it, then check:
1. a user episode "moved X to Y" supersedes `runs_on` with `valid::` = the episode date and
   `at::` = the run date;
2. a user episode adding a second `depends_on` accumulates rather than superseding;
3. a `by: web` episode queues as "untrusted source";
4. running consolidation twice is a no-op;
5. `touch -d "+2 days"` on every episode, then consolidating, changes nothing and lints clean;
6. an old episode remembered after a newer fact queues as "older than the current fact";
7. `circadia review` with paced input: garbage re-prompts, accept writes a `by:: user` fact,
   reject goes to `rejected.jsonl`.

**MCP SDK client**: connect `@modelcontextprotocol/sdk`'s `Client` over
`StdioClientTransport` to `node bin/circadia.mjs mcp --vault <temp>`, then:
- list the tools;
- make two concurrent calls, and check each response matches its request;
- call `remember` (the episode gets `by: agent`);
- call `remember` with `by: "user"` (expect an `isError` result);
- check `access.jsonl` holds session ids and query hashes, never query text.

**Timezone**: run date-stamping paths with `TZ=America/New_York` in the evening (after
20:00 local, when UTC is already the next day). Stamped dates must be the local date.

**Scale**: generate a 300k-event `access.jsonl` and time `recall` before and after
`access-log compact`. The compacted run should be close to the tiny-log baseline; an
`--as-of` before the watermark should read the full log.