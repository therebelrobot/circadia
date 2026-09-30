# Circadia: remediation handoff

Audit of `therebelrobot/circadia` at commit `c67157e` (2026-09-29, package version 0.1.3).
The roadmap marks Phases 1–6 complete. The tests pass (90/90) and the typecheck is clean, but the
consolidation ("sleep") pipeline destroys data on its first run. Several checked roadmap items
are not wired up, and two security invariants are missing. This document lists every issue
found, with its evidence and a fix direction. It is written for an agent picking up the repo
with no other context.

---

## 0. Ground rules for the agent doing this work

1. **Read `AGENTS.md` in full first.** Its hard constraints still apply:
   - zero runtime dependencies;
   - type-stripped TypeScript with `.ts` imports;
   - no private hostnames or machine names;
   - no OpenAI or xAI models.
2. **Reproduce each issue before fixing it.** The repro steps below are exact. Fix only what
   you've reproduced. If something here turns out to be wrong, say so in your report instead of
   "fixing" it.
3. **Every fix gets a regression test that fails before the fix and passes after it.** Many of
   these bugs survived because the tests assert counts, not effects. Tests must check what ends
   up in the files on disk.
4. **Never run anything against a real vault.** Use temp copies of `examples/vault/`. Tests
   must not mutate `examples/vault/` (AGENTS.md §7).
5. **Don't cut a release.** The owner decides when to publish. The package is on npm, but
   nobody else uses it, so there's no urgency to deprecate it.
6. **Work in the priority order in §2.** P0 items block everything else, because consolidation
   is currently unsafe to run.
7. Don't expand scope. Features that are listed as unimplemented get either implemented or
   unchecked on the roadmap. Say which you chose in your report.

Scratch repro setup, used throughout:

```bash
npm ci && npm test && npm run typecheck      # baseline: 90 pass
S=$(mktemp -d)
cp -r examples/vault "$S/v"
node bin/circadia.mjs index --vault "$S/v"
```

---

## 1. Summary

| ID | Sev | Area | Issue |
|---|---|---|---|
| C1 | P0 | consolidation | Marking episodes rewrites their frontmatter without `---` fences, corrupting every processed episode |
| C2 | P0 | consolidation | Promoted facts are never written to the vault |
| C3 | P0 | consolidation | Supersession is never called; `superseded` is always 0 |
| C4 | P0 | security | The "web/tool episodes always queue" gate rule is a TODO (memory-poisoning defense missing) |
| C5 | P0 | security | Shell injection via `--as-of <git ref>` in the CLI |
| C6 | P1 | consolidation | Not idempotent: each run re-appends the same queued candidates |
| C7 | P1 | consolidation | `--dry-run` writes `pending.jsonl`, runs reflection, and stages the whole working tree |
| C8 | P1 | consolidation | The consolidation commit uses `git add -A`, sweeping in unrelated user edits |
| C9 | P1 | review | `circadia review` can't read the pending format; "accept" silently drops the candidate |
| C10 | P1 | LLM clients | All three LLM clients send `prompt` to a chat-completions endpoint, which is the wrong wire format |
| C11 | P1 | consolidation | The candidate prompt and parser disagree (array vs `{candidates}` object); no predicate validation |
| C12 | P1 | security | Synonym edges are hardcoded to `trust: medium`, laundering low-trust content past the trust floor |
| C13 | P1 | security | Triple promotion ignores source trust and records a note, not an episode, as `src` |
| C14 | P1 | retrieval | Once access-log summaries exist, recall ignores new accesses and `--as-of` for ACT-R |
| C15 | P1 | retrieval | `resolveCommit` returns HEAD's timestamp for any non-date git ref |
| C16 | P1 | MCP | The MCP `recall` hardcodes `logAccess: false` and ignores `scope` and `session` |
| C17 | P2 | Phase 6 | Git-backed as-of for prose isn't wired (`readFileAtCommit` has no callers) |
| C18 | P2 | Phase 4 | Reconsolidation window: session ids are logged but nothing reads them |
| C19 | P2 | Phase 3 | Recall `scope` isn't implemented anywhere |
| C20 | P2 | Phase 3 | The Mastra integration example is checked but doesn't exist |
| C21 | P2 | consolidation | Reflection only detects uncommitted human edits (`git diff HEAD`) |
| C22 | P2 | consolidation | `selectEpisodes` ignores the "re-process if mtime is newer than `consolidated`" rule |
| C23 | P2 | consolidation | Fact ids are `f-${Date.now()}` and collide within one run; the entity-resolution regex is broken |
| C24 | P2 | consistency | `.circadia` is hardcoded in 5 places instead of using `STATE_DIR` |
| C25 | P2 | tests | Consolidation tests write `palimpsest.config.json`, which is now ignored |
| C26 | P2 | tests | No tests for log compaction, recognition memory, review, git as-of, commit-per-run, segmentation |
| C27 | P3 | shell safety | Remaining `execSync` calls interpolate paths into shell strings |
| C28 | P3 | hygiene | `src/.DS_Store` is committed |
| C29 | P3 | docs | The roadmap overstates completion; `predicates.defs` defaults to `{}`, so nothing can ever auto-promote |

---

## 2. Issues in detail

### P0: fix before consolidation is run on anything

#### C1. Consolidation corrupts every episode it marks

- **Where:** `src/consolidation/consolidate.ts`, the "Mark episodes as consolidated" block
  (~line 127) and `serializeFrontmatter` (~line 182).
- **What:** `serializeFrontmatter` returns `key: value` lines with no `---` fences and no
  trailing newline. The file is then written as `fmOut + body`. Every processed episode loses
  its frontmatter delimiters, and `consolidated: <date>` is glued onto the H1 line. The files
  stop parsing as episodes. The serializer also drops quotes, so `source: "[[x]]"` loses the
  quotes SCHEMA §2 requires, and it drops comments. This happens even with
  `extraction.provider: none`.
- **Invariant broken:** AGENTS.md §4 says episodes are append-only, and the only permitted edit
  is setting `consolidated:`.
- **Repro:**
  ```bash
  node bin/circadia.mjs consolidate --vault "$S/v" --no-commit
  head -9 "$S/v/episodes/2026/08/2026-08-11-migration.md"   # no fences; "consolidated: …# Migrated…"
  node bin/circadia.mjs lint --vault "$S/v"                  # 3 × note.missing-type
  ```
- **Fix direction:** Don't reserialize the frontmatter. Do a minimal text edit on the raw file:
  - if a `consolidated:` line exists inside the fenced block, replace that line;
  - otherwise insert one line before the closing `---`.

  Leave every other byte unchanged. Put this in a small pure function in `src/vault/`, since
  episodes are a vault concern, and delete `serializeFrontmatter`.
- **Tests:**
  - Before and after the edit, the file differs by exactly one line.
  - The file re-parses as `type: episode`, and `lint` is clean.
  - Quoted wikilinks, comments and block lists survive.
  - Running it twice produces the same bytes.

#### C2. Promoted facts are never written

- **Where:** `consolidate.ts` ~line 92 (the `decision.action === 'promote'` branch).
- **What:** The branch builds a `Fact`, increments `promoted`, and passes it to reflection. It
  never appends the fact to the entity note. Nothing outside `supersede.ts` calls `formatFact()`.
  The fact is also built wrongly:
  - `object` is always a literal, even when the candidate object resolved to a note;
  - `valid` is empty, and `recordedAt` isn't written as `at::`;
  - `trust` is hardcoded to `medium` instead of being inherited from the episode.
- **Fix direction:**
  - Write the promoted fact into the subject note's `## Facts` section using `formatFact()`.
  - Use a wikilink object when `objectRef` resolved, and a literal otherwise.
  - Set `by:: agent`, `src:: [[<episode id>]]`, `at:: <today>`, and a `conf::` value.
  - Inherit trust from the source episode.
  - Put the section edit in `src/vault/` and reuse it from `supersede.ts` and `review` (C9).
- **Tests:** An episode with a known entity and a known predicate produces the exact expected
  fact line in the entity file. `lint` stays clean. Re-running consolidation doesn't add the
  line again (see C6).

#### C3. Supersession isn't wired in

- **Where:** `consolidate.ts`. `supersede()` in `src/consolidation/supersede.ts` has unit tests
  but no caller.
- **What:** The gate never checks candidates against current facts. "Contradiction" is never
  detected, so `superseded` is always 0. The Phase 4 acceptance fixture ("we moved X to Y
  supersedes `X runs_on Z`") is not tested end to end.
- **Fix direction:**
  - In the gate, look up current facts for the same subject and predicate.
  - If a single-valued predicate has a different object, that's a contradiction. Queue it,
    unless the episode is `by: user` and explicit, as the README gate table says. In that case,
    call `supersede()`.
  - Make the gate a pure function, so the IO lives in `consolidate.ts`.
- **Test:** The roadmap's Phase 4 acceptance fixture, run end to end through
  `circadia consolidate`, produces correct `valid`, `at` and `superseded` dates, and the old
  line moves to `## History`.

#### C4. The memory-poisoning gate rule is missing

- **Where:** `src/consolidation/schema.ts` ~line 24: `// … for now pass through`.
- **What:** The consolidation README requires that candidates from `by: web` or `by: tool`
  episodes **always queue** and never auto-promote. `SECURITY.md` T1 lists this as a planned
  control, and ARCHITECTURE §3 calls it the main defense against memory poisoning. It isn't
  implemented, and the `Candidate` type doesn't carry the episode's `by` or trust. The Phase 4
  acceptance criterion ("a web-sourced episode can only produce queued candidates") currently
  holds only by accident, because `predicates.defs` is empty by default (C29).
- **Fix direction:**
  - Carry `by` and `trust` from the episode, or the source note for triple candidates, into
    `Candidate`.
  - In `evaluateGate`, check `by ∈ {web, tool}` or `trust === 'low'` first, and queue with
    reason `untrusted source`.
- **Test:** The acceptance fixture, with a known entity, a known predicate and a
  `by: web` episode, queues and never promotes. Also test that a triple from a low-trust note
  queues.

#### C5. Shell injection through `--as-of`

- **Where:** `src/vault/git.ts` ~line 155: `` execSync(`git rev-parse ${ref}^{commit} …`) ``.
  It's reached from `src/cli/main.ts` recall when `--as-of` isn't a date.
- **What:** The ref string is interpolated into a shell command.
- **Repro:** `touch` is confirmed to run:
  ```bash
  cd "$S/v" && git init -q && git add -A && git -c user.email=t@example.com -c user.name=t commit -qm init && cd -
  node bin/circadia.mjs recall --vault "$S/v" --no-log --as-of 'HEAD;touch${IFS}'"$S"'/pwned;#' "x"
  ls "$S/pwned"   # exists
  ```
  The MCP `recall` isn't affected, because it uses `Date.parse` on `as_of`. Keep it that way,
  or route it through the same safe resolver.
- **Fix direction:**
  - Replace every `execSync` with a shell string in `git.ts` and `reflection.ts` with
    `execFileSync('git', [..args], { cwd })`. That passes arguments without a shell.
  - Validate refs with `git check-ref-format --allow-onelevel` or `rev-parse --verify`, and pass
    `--` before paths.
  - Add a lint rule or a grep test that fails if `execSync(` appears anywhere in `src/`.
- **Test:** The repro above no longer creates the file, and it returns a clear "invalid ref"
  error.

### P1: correctness and security

#### C6. Consolidation isn't idempotent

- **What:** `promoteTriplesToCandidates` re-proposes the whole triple cache on every run, and
  queued decisions are appended to `pending.jsonl` without deduplication. On the example vault,
  run 1 gives 9 pending lines and run 2 gives 18. This breaks the Phase 4 acceptance criterion
  ("running consolidation twice is idempotent").
- **Fix direction:**
  - Give each candidate a stable key: hash `(subject, predicate, object, src)`.
  - Skip keys that are already pending, rejected or promoted. Keep a small `rejected.jsonl`, so
    a rejected candidate doesn't come back.
  - Only propose triples whose `contentHash` has changed since the last run.
- **Test:** Running consolidation twice over the same fixture gives byte-identical vault files
  and `pending.jsonl`.

#### C7. `--dry-run` has side effects

- **What:**
  - The queue branch appends to `pending.jsonl` regardless of `dryRun`.
  - Reflection runs and writes `schemas/*.md` regardless of `dryRun`.
  - `printConsolidationDiff` in `git.ts` (~line 91) runs `git add -A`, which stages the user's
    entire working tree.
- **Repro:** `consolidate --dry-run` on a fresh copy creates `.circadia/pending.jsonl`.
- **Fix direction:**
  - Build the full change set in memory: fact edits, episode marks, pending lines, and
    reflections.
  - In a dry run, print it as a unified diff computed in-process. Git isn't needed for this.
  - Apply it only when not in a dry run.
- **Test:** A dry run leaves the vault byte-identical, including `.circadia/` and the git index.

#### C8. The consolidation commit sweeps in unrelated edits

- **Where:** `git.ts` ~line 27: `git add -A` in `createConsolidationCommit`.
- **What:** Any uncommitted user edits, plus `access.jsonl`, get committed as
  "consolidation run". That defeats SECURITY T1's "review or revert everything sleep changed".
- **Fix direction:**
  - Stage only the paths this run wrote, with `git add -- <paths>`.
  - If those paths already had uncommitted user changes before the run, refuse to commit, or
    commit only the run's hunks, and warn.
  - Have `createConsolidationCommit` take the list of paths.

#### C9. `circadia review` is broken and loses data

- **Where:** `src/cli/review.ts`.
- **What:**
  - It reads `c.subject`, `c.predicate` and `c.object`, but the pending lines are
    `GateDecision` objects (`{action, reason, candidate: {…}}`). Every prompt therefore shows
    `undefined undefined undefined`.
  - "Accept" only increments a counter: the fact is never written, and the candidate is dropped
    from the queue.
  - Any unrecognized answer also drops the candidate.
  - It hardcodes `.circadia/pending.jsonl`.
- **Fix direction:**
  - Define one pending-record type (a versioned JSON line) shared by `consolidate` and
    `review`.
  - Accept writes the fact through the same writer as C2, with `by:: user` and
    `src:: [[<episode>]]`. It supersedes if needed.
  - Reject goes to `rejected.jsonl`.
  - Unknown input re-prompts.
  - Pull the decision logic out of the readline loop so it can be tested.
- **Test:** Drive review with scripted input over a fixture queue. Check that the accepted fact
  line appears in the entity file, the rejected key goes to `rejected.jsonl`, and the edited
  record stays in the queue.

#### C10. The LLM clients use the wrong wire format

- **Where:**
  - `src/consolidation/candidate.ts` ~line 33;
  - `src/extract/triples.ts` ~line 158 (`HttpTripleExtractor`);
  - `src/retrieval/recognition-memory.ts` ~line 72 (`HttpTripleVerifier`).
- **What:** All three POST `{model, prompt, …}` to `extraction.endpoint`, which defaults to
  `/v1/chat/completions`, then read `choices[0].message.content`. Chat completions takes
  `messages`, not `prompt`. Read `docs/CONFIG.md` and llama.cpp's server docs to confirm the
  exact behavior against llama-server. Either way, the request shape doesn't match the endpoint
  the config names.

  `candidate.ts` also has two more problems:
  - It always sends `Authorization: Bearer ` (with an empty token) when no key is set.
  - It doesn't handle a missing `choices` field before indexing into it.
- **Fix direction:**
  - Write one shared `src/llm/chat.ts` client, with zero dependencies, that sends
    `{model, messages: [{role: 'system', …}, {role: 'user', …}], response_format?, temperature, max_tokens}`.
  - Send the bearer header only when the key env var is set.
  - Give it a timeout via `AbortSignal.timeout`.
  - Return a typed error on a malformed response.
  - Use it in all three places.
  - Add an integration test that runs against a tiny in-process `node:http` mock. The mock
    must reject requests that don't have `messages`.

#### C11. The candidate extraction contract is inconsistent

- **Where:** `candidate.ts`.
- **What:**
  - The prompt says "Output ONLY a JSON array", but `response_format: json_object` forces an
    object, and the parser reads `json.candidates`. A compliant model's output is therefore
    parsed as zero candidates.
  - The roadmap claims predicates are validated against `predicates.defs`, but the extractor
    doesn't validate anything.
  - Episode text is pasted into the prompt unfenced. A web-clipped episode is attacker-
    controlled text going into an extraction prompt. That's only acceptable because C4 would
    queue whatever comes out, and C4 isn't implemented.
- **Fix direction:**
  - Ask for `{"candidates": [...]}` explicitly.
  - Validate each item: its shape, a snake_case predicate, and a confidence between 0 and 1.
  - Drop and count invalid items.
  - Wrap episode text in a delimited data block, and tell the model it's data, not
    instructions.
  - Pass the known predicate list into the prompt.

#### C12. Synonym edges launder trust

- **Where:** `src/index/indexer.ts` ~line 439: synonym edges are inserted with a literal
  `'medium'` trust.
- **What:** A phrase that appears only in a `trust: low` (web) note gets a medium-trust edge to
  phrases in trusted notes. That lets low-trust content get past `retrieval.trustFloor` through
  the synonym path.
- **Fix direction:** Give each synonym edge the minimum trust of its two endpoint phrases, where
  a phrase's trust is the minimum trust of the passages it came from. Add a test with a
  low-trust fixture phrase, run with `trustFloor: medium`.

#### C13. Triple promotion ignores trust and provenance

- **Where:** `src/consolidation/promote.ts` ~line 43.
- **What:** Candidates from the triple cache use the source *note* id as `episodeId`. So the
  resulting fact's `src::` would point at an entity note, not an episode, which breaks the
  provenance model in SCHEMA §4. The note's trust and `by` aren't carried over either.
- **Fix direction:**
  - Carry trust and `by` from the source note.
  - Add a `srcKind: 'episode' | 'note'` to `Candidate`, or require triple candidates to always
    queue with reason `derived from triple cache`. Queuing is the simpler, safer default; if
    you choose it, record that in an ADR.

#### C14. Compacted summaries freeze ACT-R and break as-of

- **Where:** `src/retrieval/recall.ts` ~line 245 and `src/retrieval/log-compact.ts`.
- **What:**
  - If the summaries file exists, recall uses only the summaries. Accesses logged after the last
    `access-log compact` are ignored, so activation stops learning.
  - The as-of filter is applied to raw events but not to summaries, so `--as-of` activation
    includes future accesses. That violates ARCHITECTURE §8.
  - `summariesToPresentations` returns `[first, ...last10]` and discards `count`. So the
    frequency term is lost, and the "optimized-learning approximation" the roadmap names isn't
    implemented.
  - Compaction never truncates the raw log, so the log still grows without bound.
- **Fix direction:**
  - Presentations for a node = its compacted summary + raw events after the summary's
    watermark, with both filtered to `≤ asOf`.
  - Implement ACT-R's optimized-learning form for the compacted part:
    `B ≈ ln(n / (1 − d)) − d·ln(L)`, where `L` is the time since the first presentation. Keep
    exact terms for the recent events.
  - Store a watermark in the summaries file.
  - Decide explicitly whether compaction rotates the raw log, and record that in an ADR. The raw
    log isn't derivable (AGENTS.md §4), so never delete it without a backup.
- **Tests:**
  - Activation after compaction equals the pre-compaction activation, within tolerance.
  - New accesses after compaction change the ranking.
  - An as-of query before compaction ignores later accesses.

#### C15. The git-ref timestamp is wrong

- **Where:** `git.ts` ~line 161: `git log -1 --format="%at %s"` is run without the resolved
  hash.
- **What:** `--as-of <any ref>` resolves to HEAD's timestamp, not the ref's.
- **Fix:** Use `git log -1 --format=%at%x00%s <hash>`, through `execFileSync` (C5).
- **Test:** Two commits in a fixture repo; `--as-of <first-hash>` gives the first commit's
  time.

#### C16. The MCP `recall` drops learning and scoping

- **Where:** `src/mcp/server.ts` ~line 130.
- **What:**
  - `logAccess: false` is hardcoded, so agent use through MCP, which is the main use case,
    never feeds ACT-R or the reconsolidation window.
  - The `scope` and `session` params are advertised in the tool schema but ignored. Only
    `remember` passes a session through.
  - An invalid `as_of` becomes `NaN` instead of an error.
- **Fix direction:**
  - Default MCP recall to logging access. The access log stores only the query hash, so this is
    privacy-safe. Make it configurable.
  - Pass `session` and `scope` through (see C19).
  - Return a JSON-RPC error for an unparseable `as_of`.
- **Tests:** Extend `test/mcp.test.ts`:
  - a recall call appends an access event with the session id;
  - a bad `as_of` returns an error.

### P2: roadmap items checked but not delivered, and weaker bugs

- **C17. Git-backed as-of for prose (Phase 6).** `readFileAtCommit` and `getNoteCommitAtTime`
  exist in `git.ts`, but nothing calls them. Recall's prose is always the current text. Either
  implement it (at as-of time, render passages from the note at the last commit ≤ T) or uncheck
  the item.
- **C18. Reconsolidation window (Phase 4).** `session` is written to the access log
  (`recall.ts` ~line 293). Nothing in `src/consolidation/` reads it. Either implement it (queue
  priority for facts recalled in the same session as a contradicting episode; depends on C3) or
  uncheck it.
- **C19. Recall `scope` (Phase 3).** There's no scope handling in `recall.ts`. Implement it as a
  seed and traversal filter by path prefix or tag, per SECURITY T4, or uncheck it.
- **C20. Mastra integration example (Phase 3).** It's checked, but there's no example in the
  repo; `examples/` holds only `vault/`. Add `examples/mastra/` with a minimal agent that uses
  the stdio server, or uncheck it.
- **C21. Reflection's human-edit detection.** `reflection.ts` ~line 43 uses
  `git diff HEAD -- <path>`, which only sees uncommitted edits. Human edits that were committed
  later get overwritten. Compare against the last *generated* version instead: store a content
  hash in the schema note's frontmatter (`generated_hash`), and skip regeneration if the
  current body's hash differs. This also works without git.
- **C22. Episode re-selection.** `selectEpisodes` skips any episode with a valid `consolidated`
  date. The roadmap says to re-process when the file's mtime is newer than that date. Note the
  tension: episodes are append-only, so a newer mtime usually means C1-style damage or a manual
  fix. Decide which, and document it.
- **C23. Small consolidation bugs.**
  - Fact ids from `Date.now()` collide within one run. Use the existing block-id convention
    (`^f-…`), derived from a content hash.
  - `c.object.replace(/^[[\s*|\s*]]/g, '')` is a character class, not a wikilink stripper. Use
    the vault's wikilink parser.
- **C24. The state dir is hardcoded.** `'.circadia'` is a literal in:
  - `consolidate.ts:84`;
  - `review.ts:24`;
  - `triples.ts:31`;
  - `watch.ts:104`;
  - `main.ts:103`.

  Import `STATE_DIR` from `src/config.ts` everywhere. The rename was supposed to centralize
  this.
- **C25. Stale test fixtures.** `test/consolidation.test.ts` writes `palimpsest.config.json`
  and `.palimpsest/...` paths, which the renamed loader ignores. So those tests run on defaults,
  not the config they set up. Also, `test/triple-extraction.test.ts` and several temp-dir
  prefixes still say `palimpsest`. Use `CONFIG_FILENAME` and `STATE_DIR` in tests. Then
  `git grep -i palimpsest -- test src` should return nothing.
- **C26. Coverage gaps.** There are no tests for:
  - `log-compact.ts`;
  - `recognition-memory.ts` (beyond the noop path);
  - `review.ts`;
  - `git.ts` (commit-per-run, `resolveCommit`, `history`);
  - `episodes/segment.ts`;
  - `graph-cache.ts`.

  Each fix above adds tests. Also add at least one test per remaining module.

### P3: hygiene

- **C27.** After C5, no `execSync` with an interpolated string should remain anywhere.
  `getNoteCommitAtTime` (~line 238) and `reflection.ts` interpolate file paths into shell
  strings. Paths come from vault filenames, so this is lower risk, but it's the same class of
  bug.
- **C28.** `git rm --cached src/.DS_Store`, and add `.DS_Store` to `.gitignore`.
- **C29. Roadmap accuracy.**
  - Update `docs/ROADMAP.md` so every checkbox matches reality after your work.
  - Phase 5's acceptance criterion depends on the Phase 7 eval set, which doesn't exist. Mark
    Phase 5 "implemented, acceptance pending Phase 7".
  - Document that `predicates.defs` defaults to `{}`, so nothing auto-promotes until the user
    defines predicates. Consider shipping the example vault's predicate set as a documented
    starter.

---

## 3. Suggested commit sequence

Each commit is green on its own (`npm test && npm run typecheck`):

1. `test: fix stale fixtures to use CONFIG_FILENAME/STATE_DIR` (C25, C24). This comes first, so
   the later tests exercise real config.
2. `fix(git)!: replace shell-string execSync with execFileSync; validate refs` (C5, C15, C27)
3. `fix(consolidation): minimal in-place consolidated: edit; never reserialize frontmatter` (C1)
4. `feat(vault): fact-section writer shared by consolidate/supersede/review` (groundwork for C2)
5. `fix(consolidation): write promoted facts; wire supersession; enforce untrusted-source rule` (C2, C3, C4, C13)
6. `fix(consolidation): idempotent candidates, side-effect-free dry run, scoped commits` (C6, C7, C8, C23)
7. `fix(review): shared pending record type; accept writes facts; rejected.jsonl` (C9)
8. `refactor(llm): shared chat-completions client; fix wire format and prompts` (C10, C11)
9. `fix(index): synonym edge trust = min of endpoints` (C12)
10. `fix(retrieval): summaries + post-watermark events, as-of aware, optimized-learning ACT-R` (C14)
11. `fix(mcp): log access, pass session/scope, reject bad as_of` (C16), plus C19 if implemented
12. `feat or docs: C17, C18, C20, C21, C22` (implement or uncheck each one)
13. `docs: roadmap and CONFIG accuracy; chore: remove .DS_Store` (C28, C29)

Add ADRs for:

- the pending-record format and `rejected.jsonl`;
- triple candidates always queuing (if you choose that);
- the access-log compaction and rotation policy.

---

## 4. Definition of done

- Every P0 and P1 item is fixed, with a regression test that failed before the fix.
- The full end-to-end fixture runs on a temp vault that is a git repo: index → consolidate →
  review (scripted accept) → consolidate again. After it:
  - `lint` is clean;
  - episodes differ from their originals only in the `consolidated:` line;
  - the accepted fact appears with correct provenance;
  - the contradiction is superseded into `## History`;
  - the web-sourced candidate is still queued;
  - the second consolidate run produces no diff;
  - there's exactly one new git commit per non-empty run, touching only the files that run
    wrote.
- `git grep -n "execSync(" src` returns nothing.
- `git grep -n -i palimpsest -- src test` returns only the legacy-name constants, if they exist.
- `docs/ROADMAP.md` checkboxes match the code.
- `npm test` passes, with a higher count than 90, and `npm run typecheck` is clean.

## 5. Report back with

1. The commits you made, mapped to issue IDs.
2. For each issue, one of: fixed (with its test name), or intentionally deferred or unchecked
   (with the reason).
3. Any issue in this document that you found to be wrong, with evidence.
4. Decisions that need the owner:
   - whether to publish a fixed 0.1.4;
   - the compaction and rotation policy;
   - whether triple candidates always queue.