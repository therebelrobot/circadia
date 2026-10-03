# RFC-0004: Workspaces (layered vaults for one operator)

Status: proposed · 2026-10-02 · written against `ef39638` · tracks issue #3

Discovery (RRF phases 2–4: measured pollution, five whys, workflows, risk register):
[RFC-0004-discovery.md](RFC-0004-discovery.md).

## Summary

Add a **workspace**: a folder of several ordinary vaults, plus a small registry file that
places each vault on two axes, **project** and **agent**. That gives four layers:

| layer | project | agent | example | holds |
|---|---|---|---|---|
| `global` | any | any | `global` | who the operator is, standing preferences |
| `project` | `work` | any | `work` | the project's decisions, conventions, architecture |
| `agent` | `work` | `coder` | `work.coder` | what the coder learned on this project |
| `global-agent` | any | `coder` | `coder` | how the coder works, across every project |

An agent is **bound** to one cell, for example `(work, coder)`. It reads from its
**lineage**: the cells on its own row and column that exist, `work.coder`, `work`,
`coder` and `global`. It never reads a sibling such as `work.architect` or
`personal.coder`. It writes to its own cell by default, and to a broader cell only when
the workspace's write policy allows it.

Each vault stays exactly what it is today: its own schema, index, access log,
consolidation, dreaming, and git repo. A workspace adds **no new storage format for
memory**. It adds a registry, a binding, federated recall across the lineage, and
explicit routes for moving memory into a shared layer.

Plain `--vault` keeps working unchanged. Workspaces are opt-in.

## Motivation

- **Agents pollute each other, measurably.** Three agents sharing one vault through
  three `circadia mcp` processes (discovery, phase 2) showed:
  - in every recall probe, 3–4 of 5 episode hits came from *other* agents, and the
    architect's top hit about datastores was the coder's throwaway redis spike, above
    the architect's own decision against redis;
  - after one nightly consolidation, that spike was a current project fact
    (`uses_cache:: [[redis]]`), and the architect's `retry_max_attempts:: 3` and QA's `5`
    were *both* current on a `single` predicate;
  - QA's recalls raised the activation of the coder's episode from 0.33 to 0.97, through
    the shared access log;
  - nothing records which agent wrote an episode, so the vault can't be split by agent
    after the fact.

  Issue #3 asks for banks that don't do this.
- **The existing `scope` is a filter, not a boundary.** `recall({ scope })` restricts
  seeds and traversal to a path prefix or tag (SECURITY.md T4). Consolidation, entity
  resolution, the schema-fit gate, dreaming and the access log ignore it. An agent's
  candidate about `api-gateway` resolves to whichever `api-gateway` note exists,
  including one another agent wrote.
- **Prior art failed in exactly this place.** The librechat-mnemonic audit (finding 5)
  found default recall spanning every project in the vault with no partition. The
  Hindsight audit (finding 2) found an import path that let row data choose the
  destination bank. This RFC makes isolation physical (separate vaults) and makes the
  server, never the request, resolve the destination.
- **Shared memory still has to exist.** Issue #3 also asks what shared memory looks like.
  The architect's decision that the service uses Postgres is something the coder must
  see. That needs a defined place and a defined, gated route into it.

### Cognitive grounding

AGENTS.md asks every mechanism to trace to a finding. Three apply:

- **Encoding specificity and context-dependent memory** (Tulving & Thomson 1973; Godden &
  Baddeley 1975). Retrieval works best when the retrieval context matches the encoding
  context. The binding is that context: the coder recalls first from what was encoded as
  the coder on this project.
- **Interference** (proactive and retroactive interference; Anderson & Neely 1996 for a
  review). Similar memories from different contexts compete at retrieval. Separate
  vaults remove the competition between siblings rather than trying to out-score it.
- **Transactive memory** (Wegner 1987). Groups remember well when members specialize and
  a shared directory records who knows what. The `project` and `global` layers are that
  shared directory; the agent layers are the specialists.

## Non-goals

- **Multiple operators or tenants.** Issue #3 says so explicitly. A workspace is one
  person's memory used by several agents. There are no users, no per-user ACLs, and no
  authentication between agents. SECURITY.md T4 still holds: one vault is one trust
  domain, and a workspace is several trust domains owned by one operator.
- **Defending against the operator's own agents on purpose.** Request-selected binding
  (§3) lets a caller pick any registered cell. The pinned binding is the isolation
  boundary; request mode is a convenience for trusted hosts.
- **A cross-vault graph.** v1 runs retrieval per vault and merges ranked lists. Edges
  never cross vaults (Open question 1).
- **Splitting an existing vault into cells.** Episodes are append-only and facts carry
  `src::` links to episodes in the same vault, so moving files between vaults breaks
  provenance. v1 offers adopting a whole vault as one cell only (§10).
- **Team cells** (a vault shared by the architect and QA but not the coder). Open
  question 5.

## Design

### 1. The model: two axes, four layers

A **cell** is a coordinate `(project, agent)`, where either side may be `*`:

- `(*, *)` is the `global` layer;
- `(p, *)` is the `project` layer;
- `(p, a)` is the `agent` layer;
- `(*, a)` is the `global-agent` layer.

At most one vault exists per cell. A cell with no vault is simply absent from every
lineage; nothing requires all four.

The **lineage** of a binding `(p, a)` is, in precedence order:

1. `agent` `(p, a)`
2. `project` `(p, *)`
3. `global-agent` `(*, a)`
4. `global` `(*, *)`

A binding with no agent, `(p, *)`, has lineage `project`, `global`. A binding with no
project, `(*, a)`, has lineage `global-agent`, `global`. A binding `(*, *)` sees `global`
only.

**Why `project` outranks `global-agent`.** When the two disagree, the project's
conventions should beat the agent's personal habits: a coder who prefers tabs should
still use spaces in a repo that mandates them. This is a default, not a law (Open
question 4).

**Siblings are invisible.** `(work, coder)` never reads `(work, architect)`,
`(personal, coder)`, or `(personal, *)`. Anything two agents on a project should both
know belongs in the `project` layer.

### 2. Workspace layout and registry

```
<workspace>/
  circadia.workspace.json
  global/            # a normal vault: circadia.config.json, episodes/, entities/, .circadia/, .git/
  work/
  personal/
  coder/
  work.architect/
  work.coder/
  work.qa/
```

- **Flat, never nested.** The walker skips only dot-folders, `_meta/` and `node_modules`
  (`src/vault/walk.ts`), so a vault nested inside another would be indexed as part of
  its parent. Flat siblings avoid that with no walker change.
- **The directory name is the vault id.** The registry stores coordinates, never paths.
  Ids match `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$`. A path is always
  `join(workspace, id)`, built only after the id is found in the registry and has
  passed that pattern (T3).

`circadia.workspace.json`:

```json
{
  "workspace": 1,
  "vaults": {
    "global":         {},
    "work":           { "project": "work" },
    "personal":       { "project": "personal" },
    "coder":          { "agent": "coder" },
    "work.architect": { "project": "work", "agent": "architect" },
    "work.coder":     { "project": "work", "agent": "coder" },
    "work.qa":        { "project": "work", "agent": "qa" }
  },
  "writes": {
    "default": ["self"],
    "agents": { "architect": ["self", "project"] }
  },
  "recall": {
    "layerWeights": { "agent": 1.0, "project": 0.9, "global-agent": 0.8, "global": 0.7 }
  },
  "defaults": {
    "extraction": { "provider": "http", "endpoint": "http://127.0.0.1:8080/v1/chat/completions" }
  }
}
```

- **`vaults`**: id → coordinates. Validation rejects two vaults on one cell, an id that
  fails the pattern, and a registered id with no directory (as a warning for `list`, an
  error when a binding needs it).
- **`writes`**: which layers `remember` may target, as a list of `self`, `project`,
  `global-agent`, `global`. `self` means the binding's own cell. `default` applies to
  every agent; `agents.<name>` replaces it for one agent. **The default is `["self"]`**,
  so a user who never sets this gets complete isolation and no agent ever writes shared
  memory. That is the value that cannot pollute anything; sharing is opted into per
  agent.
- **`recall.layerWeights`**: §4.
- **`defaults`**: a config object deep-merged *under* each vault's own
  `circadia.config.json`. Order: built-in defaults, then workspace `defaults`, then the
  vault file. This lets one model endpoint serve every vault without seven copies, while
  each vault can still override (for example `retrieval.trustFloor: "medium"` on
  `global`). Validation rejects `defaults.index.*`, because index paths are per vault by
  definition.

The registry holds no secrets and no memory. It belongs in whatever repo or backup holds
the workspace root, separately from the vaults' own repos (§7).

### 3. Binding: who chooses the cell

The issue asks for vaults "selectable from within the request". Who selects matters,
because a request is text an agent produced, and an agent can be prompt-injected. So
there are two modes, and the launch command decides which applies.

**Pinned (the default, and the isolation boundary).**

```
circadia mcp --workspace <dir> --project work --agent coder
```

- The server resolves the lineage once, at startup, and opens **only** those vaults'
  indexes and config. A sibling vault's files are never opened, so no bug in recall can
  leak them.
- Tool calls cannot name a project or agent. They can narrow to a subset of the lineage
  (`layers`, §4) and pick a write target among the allowed ones (`target`, §5).
- The `remember.target` enum in `tools/list` contains only the targets the write policy
  allows this agent. The model cannot name a forbidden layer; the server still checks.
- `initialize` states the binding: the bound cell, the lineage's vault ids and the
  allowed write targets, in `serverInfo` and the server instructions. A wrong binding
  (a typo in the client config) is then visible from the client before anything is
  written (discovery R8).
- A launch naming an unregistered project or agent refuses to start and lists the
  registered names.
- This is the expected setup: one MCP server entry per agent in each client config,
  which is how Mastra agents, Zoo Code modes and similar tools are configured anyway.

**Request-selected (opt-in, for one process hosting many agents).**

```
circadia mcp --workspace <dir> --select-per-request
```

- Every tool call must carry `project` and/or `agent`. The server resolves the cell from
  the registry; an unknown name is an error, and nothing is ever auto-created over MCP.
- The ceiling is the whole workspace, so any caller can bind to any cell. That is
  acceptable only because there is one operator (Non-goals), and the flag's name says
  what it does.
- This is the mode RFC-0003's `circadia serve` would use for a Mastra service that runs
  several agents in one process (§9).

**Rule for both modes.** The destination vault is always resolved by the server from
the registry plus the binding. No argument, frontmatter field or archive content can
choose a vault directly. That is the lesson of Hindsight finding 2.

### 4. Reading: federated recall

`recall` runs once per vault in the (possibly narrowed) lineage and merges the results.

1. **Per-vault recall, unchanged.** Each vault uses its own config, index, graph cache,
   mode ladder, trust floor and `scope` handling. `scope` applies inside every vault, as
   today. Each returns up to `topK` ranked hits.
2. **Merge by weighted reciprocal-rank fusion.** PageRank scores from different graphs
   aren't comparable (each is normalized over its own graph), so the merge uses ranks:
   `score = layerWeight / (60 + rank)`, summed per hit. RRF already fuses seeds in recall
   (ARCHITECTURE §5), so this is the same tool one level up. Ties break by layer
   precedence, then by the vault's own score.
3. **One budget.** `topK` and `tokenBudget` apply to the merged list, not per vault, so a
   four-layer lineage doesn't quadruple the context.
4. **No dedupe across vaults.** `entities/api-gateway` in `work` and in `global` are two
   notes with two histories. Both may appear, each labeled. Merging them would be the
   cross-vault identity decision this RFC defers.
5. **Labels.** Each hit gains `vault` and `layer`. `renderForContext()` prints the layer
   with each passage (for example `[project: work]`). The label is server data, outside
   any fence. Fencing of `trust: low` passages is unchanged and still applies per hit.
6. **Access log per vault.** Each hit is logged to its own vault's `access.jsonl`, with
   the same query hash, so ACT-R in `global` learns from use by every agent. A vault the
   process may not write (§8, read-only mounts) is recalled with `logAccess: false`.
7. **`layers` argument.** `recall` takes optional `layers: ("agent" | "project" |
   "global-agent" | "global")[]` to narrow the lineage, for example to ask only the
   project what its conventions are. It can only narrow.

**Result shape.** `modeUsed` and `escalations` become per-vault (`byVault: { id: {
modeUsed, escalations, seeds, error? } }`), and the top-level `modeUsed` reports the bound
cell's mode. Every hit gains `vault` and `layer` fields; `passageId` and `noteId` keep
their current, unqualified form. That keeps the MCP change additive: a client that
parses ids today keeps working, and a client that wants uniqueness uses
`(vault, passageId)` (discovery D8). Inside `recall()` nothing changes: it still takes
one vault.

**A lineage vault that can't be read** (missing directory, unreadable, corrupt index)
does not fail the recall. It is skipped, `byVault.<id>.error` names the problem, and the
rendered text says that layer was unavailable. The bound cell itself being missing is a
startup error, not a degraded recall (discovery E10).

**Other read tools.**

- `get_note`: takes `id` either qualified (`work:api-gateway`) or bare. A bare id is
  looked up through the lineage in precedence order; the first match wins and the result
  names its vault.
- `timeline`: runs per vault in the lineage and returns one section per vault that has
  the entity, in precedence order. It never interleaves facts from different vaults into
  one timeline, because their system times come from different histories.
- `relate`: runs inside one vault, the first in the lineage that has both endpoints, or
  the vault named by an optional `layer`. Paths never cross vaults (no cross-vault
  edges).

### 5. Writing: `remember` targets

`remember` gains `target?: "self" | "project" | "global-agent" | "global"`, default
`self`.

- `self` is the bound cell. For a binding `(work, *)` that is the `work` vault.
- The server checks the target against the agent's `writes` policy and that the target
  cell exists. A refusal is a tool error (`isError`), and nothing is written.
- Everything else about `remember` is unchanged: segmentation, `slugify()`d paths from
  server data, `episodes/` only, `by: agent` default, `by: user` refused over MCP.

**Episodes record their author.** New optional episode frontmatter: `agent: <name>`.
The server sets it from the binding (pinned) or the validated `agent` argument
(request mode), never from free text. It answers "which agent said this" when an episode
lands in a shared vault, where `by: agent` alone can't. Consolidation copies nothing new:
facts promoted from that episode already carry `src:: [[episode]]`, and the episode
carries `agent:`, so the chain is intact and stays inside one vault. `circadia review`
prints the source episode's `agent:` beside each queued candidate, so a reviewer can see
that "billing-api uses sqlite" came from the coder's local-dev note (discovery P4, E9).

`endorse_dream` and `dismiss_dream` act on the bound cell's dream state only (§7).

### 6. Shared memory: what it is and how it gets there

**Shared memory is marked by where it lives, not by a tag.** A fact in `work` is shared
with every agent on `work`. A fact in `global` is shared with every agent. There is no
`shared: true` field to forget, misread or spoof, and isolation never depends on a
filter being applied.

There are exactly three routes into a shared layer. All of them end at that layer's own
schema-fit gate or at a human.

1. **A permitted agent writes an episode there.** The architect, allowed `project`,
   calls `remember({ text, target: "project" })`. The episode lands in `work/episodes/`
   with `by: agent` and `agent: architect`, and `work`'s nightly consolidation decides
   what becomes a fact, under the same gate and trust rules as any agent episode. Shared
   memory gets no shortcut.
2. **A human lifts a fact.** New CLI command:

   ```
   circadia lift --workspace <dir> --from work.coder --to work <note-id>^<fact-id>
   ```

   It writes a new episode into the target vault with `source: import`, `by: user`, a
   new optional frontmatter field `origin: "work.coder:<note-id>^<fact-id>"`, and a body
   stating the claim and its original `src::`. The target's consolidation then promotes
   it like any user episode, including supersession of a contradicted fact. A lift
   writes an *episode*, not a fact, so the target vault's invariant (only consolidation
   promotes) holds, and `src::` links never need to cross vaults. `lift` is CLI-only,
   like `review`: the same human firewall the dreaming design uses.
3. **A human edits the shared vault directly**, as today.

**Why not let consolidation push facts upward automatically?** Because the lower vault's
gate saw only that agent's episodes. A coder's conviction that the API is "flaky" would
become a project-wide fact without anyone checking it against the architect's or the
QA agent's view. Agents may *suggest* lifts in a later version (Open question 2).

### 7. Per-vault machinery is unchanged

Each vault in a workspace is a complete Circadia vault. In particular:

- **Index, access log, triple cache, consolidated state, pending queue, dream state**:
  per vault, in each vault's `.circadia/`. The derived-index invariant holds per vault.
- **Consolidation**: runs per vault, one commit per vault per run. The gate, entity
  resolution and supersession see only that vault. This is where most of the isolation
  comes from.
- **Dreaming**: per vault. The REM pass never pairs notes from two vaults: a pair across
  trust domains would be an association neither domain endorsed. `wake` over MCP reads
  only the bound cell's log, since the log is deleted on first read and a shared vault's
  log would otherwise go to whichever agent woke first. A shared vault's log is read
  with `circadia wake --vault <dir>` by the operator. **This has a cost.** In the
  discovery experiment only 1 of 13 sampled pairs joined two agents, but 9 of 13 joined
  an agent's episode to a shared entity. Under workspaces those 9 become cross-vault
  pairs, so per-vault dreaming loses most of what the REM pass samples in a mixed vault
  (discovery R7; Open question 7).
- **Git: one repo per vault.** `readFileAtCommit()` runs `git show <hash>:<path>`, and
  git resolves that path from the repository root, not the working directory. A vault
  in a subfolder of a larger repo would get `null` for every note and silently fall back
  to current text for `--as-of`. One repo per vault avoids this and keeps each vault's
  history and `history <note>` output to its own changes. `workspace init` and
  `workspace add` run `git init` per vault, as `circadia init` does.

### 8. CLI

New:

```
circadia workspace init <dir>                                   # registry + global vault
circadia workspace add --workspace <dir> [--project p] [--agent a]   # register a cell, scaffold it with init
circadia workspace adopt --workspace <dir> <id> [--project p] [--agent a]  # register an existing vault already at <dir>/<id>
circadia workspace list --workspace <dir> [--json]              # cells, lineage table, write policy, warnings
circadia lift --workspace <dir> --from <id> --to <id> <note>^<fact>
```

Changed:

- Every command that takes `--vault` also accepts `--workspace <dir>` with
  `--project`/`--agent`. The two are mutually exclusive.
- **Read commands** (`recall`, `timeline`, `relate`, `stats`) use the lineage, as in §4.
- **Write commands** (`index`, `consolidate`, `dream`, `review`, `wake`, `lint`) act on
  **one** vault: the bound cell, never the lineage. Writing to a lineage would be a
  surprising fan-out. With `--workspace` and no `--project`/`--agent`, `index`,
  `consolidate`, `dream` and `lint` iterate every registered vault in id order, each
  with its own lock and commit, and report per vault. One vault failing (a model
  endpoint down, a bad config) does not stop the rest: the loop continues, and the
  command exits non-zero with the failures listed (discovery E7). `review` and `wake`
  refuse the unbound form, since they are interactive or destructive.
- `mcp` as in §3.

**Containers.** The stdio image's single `/vault` mount generalizes well:

```
docker run -i --rm --read-only --tmpfs /tmp --network none --user <uid>:<gid> \
  -v <ws>/circadia.workspace.json:/workspace/circadia.workspace.json:ro \
  -v <ws>/work.coder:/workspace/work.coder \
  -v <ws>/work:/workspace/work:ro \
  -v <ws>/coder:/workspace/coder:ro \
  -v <ws>/global:/workspace/global:ro \
  ghcr.io/therebelrobot/circadia:<version> mcp --workspace /workspace --project work --agent coder
```

Mount the lineage only, and mount read-only every layer the agent may not write. The
kernel then enforces both isolation (siblings aren't present) and the write policy
(shared layers aren't writable), independently of Circadia's own checks. A pinned server
opens only lineage vaults, so unmounted siblings never cause an error. For read-only
layers the server opens the index read-only and skips access logging (§4.6), so their
indexes must be kept current by a host-side `index` or `consolidate` job.

### 9. Relationship to RFC-0003 (`circadia serve`)

RFC-0003 serves one vault per container. With workspaces, one `serve` process could
serve a workspace in request-selected mode. This RFC does not change RFC-0003. If both
land, the follow-up is per-cell bearer tokens: a token bound to a cell is the pinned
mode over HTTP. That would be the first step toward multi-consumer use, which is out of
scope here and would need its own review against T2 and T4.

### 10. Migration

- **Nothing changes for existing users.** `--vault` behaves exactly as today, and no
  vault's format changes except two optional episode frontmatter fields.
- **Moving an existing vault into a workspace:** move or clone it to
  `<workspace>/global` (or any id), then `circadia workspace adopt`. Its git history,
  index and access log come along because they live inside it.
- **An existing vault that already mixes projects** stays one cell. Separating it is
  manual (Non-goals). Its `scope` filters keep working inside it.

## Alternatives considered

1. **Status quo: one MCP server per vault.** This works today: list three `circadia mcp
   --vault …` servers in the client config. The agent sees three copies of every tool,
   must decide which to call, gets three separate token budgets, and nothing tells it
   which layer outranks which. It stays the documented fallback.
2. **One vault, partitioned by tags and `scope`.** The cheapest option, and the one this
   RFC rejects. Consolidation, entity resolution, the gate, dreaming and ACT-R would all
   need to become scope-aware, and every one of them would become a place where a missing
   filter leaks memory between agents. Isolation that depends on every code path
   remembering a filter is what the librechat-mnemonic audit flagged.
3. **One merged graph across the lineage**, with bridge edges between same-id entities in
   different vaults. Better multi-hop recall across layers, but it breaks "each index is
   derived from one vault", makes entity identity across vaults a silent assumption, and
   lets activation from an agent layer flow into shared notes' rankings. Deferred to Open
   question 1, to be decided by eval.
4. **Nested vault folders** (`work/agents/coder/`). They read naturally, but the walker
   would index child vaults as part of their parent. Rejected for flat ids.
5. **One git repo for the whole workspace.** One history to push, but it breaks
   git-backed `--as-of` for every vault (§7) unless `git.ts` is changed to use
   `<hash>:./<path>` with the vault-relative prefix. Possible later; one repo per vault
   needs no code change.
6. **A `shared: true` marker on notes or facts.** Rejected in §6: location is the marker,
   and a marker can be forgotten or written by the wrong party.

## Security review

| concern | how this design meets it |
|---|---|
| T1, memory poisoning | Shared layers accept agent content only as episodes, through their own gate; the default write policy is `self` only; `lift` is CLI-only; `agent:` records which agent wrote a shared episode |
| T2, network surface | No new transport or listener. Request-selected mode is a flag on the existing stdio server |
| T3, paths from callers | Vault ids are registry keys matching a strict pattern; paths are `join(workspace, id)` only after lookup; `project`/`agent` arguments are looked up, never joined; nothing is created over MCP. This avoids the librechat-mnemonic finding 6 class, where project names became paths |
| T4, cross-domain leakage | Siblings are never opened by a pinned server; the destination vault is resolved by the server, never by request content (Hindsight finding 2); dreaming never pairs across vaults; container mounts can enforce both isolation and the write policy |
| T5, data leaving the machine | Unchanged. One `defaults.extraction` endpoint may now serve several vaults; the same local-first defaults and spend-capped-key guidance apply |

**What request-selected mode gives up.** Any caller can bind to any cell, so a
prompt-injected agent in a shared process could read a sibling's memory or write where
another agent may. This is acceptable only under the single-operator assumption, is off
by default, and is named for what it does.

## Changes this requires

- **ADR** (next free number; ADR-0013 is reserved by RFC-0003): workspaces, flat layout,
  the lineage and its precedence, location as the sharing marker, one repo per vault.
- **SCHEMA.md**: episode frontmatter gains optional `agent` (slug) and `origin` (string).
  Additive; schema stays v1. `lint` must accept both and validate `agent` as a slug.
- **New**: `docs/WORKSPACES.md` (registry reference, layer table, container mounts);
  `src/workspace/` (registry load/validate, lineage resolution, federated recall merge,
  `lift`).
- **CONFIG.md**: a section for `circadia.workspace.json`, including the merge order of
  `defaults`.
- **`src/mcp/`**: binding modes and the binding in `initialize`, `layers` and `target`
  arguments, `vault`/`layer` hit fields, per-binding `tools/list` enums; contract in
  `src/mcp/README.md`.
- **SECURITY.md**: T4 rewritten for workspaces (one vault per trust domain still; a
  workspace is several, one operator); T3 gains the registry-lookup rule.
- **ARCHITECTURE.md**: a section mapping encoding specificity, interference and
  transactive memory to the design. **SOURCES.md**: those citations.
- **AGENTS.md**: repo map (`src/workspace/`), commands, and an invariant: "the server
  resolves the destination vault; no caller-supplied string chooses a vault or a path."
- **ROADMAP.md**: a new phase for this work.
- **README**: a short "Several agents" section.

## Test plan

Each item gets a test that fails without the feature (AGENTS.md §10). Fixtures are temp
directories built from copies of `examples/vault/`, never the tracked vault.

1. **Registry.** Two vaults on one cell, a bad id (`../x`, `a/b`, `A`, empty), and
   `defaults.index.path` are each rejected with a stable problem code. A registered id
   with no directory warns in `list` and errors when bound.
2. **Lineage.** For each binding shape (`(p,a)`, `(p,*)`, `(*,a)`, `(*,*)`), the
   resolved lineage and its order match §1, skipping absent cells.
3. **Pinned isolation, on disk.** Make a sibling vault unreadable (`chmod 000`), bind a
   pinned server, and run every read tool. All succeed, and no hit names the sibling.
   Then plant a unique token in a sibling note and assert no recall ever returns it.
4. **Federated recall.** A query whose best passage is in `global` and whose second-best
   is in the agent layer returns both, labeled, within one token budget; with `layers:
   ["project"]` it returns only `project` hits; equal-rank hits order by precedence.
5. **Access log per vault.** After one recall that returns hits from two vaults, each
   vault's `access.jsonl` holds exactly its own hits and the query hash, never the text.
6. **Write policy.** With the default policy, `remember({ target: "project" })` is an
   error and nothing appears under `work/episodes/`; the `target` enum in `tools/list`
   is `["self"]`. With `architect: ["self","project"]`, the architect's episode lands in
   `work/episodes/` with `by: agent` and `agent: architect`.
7. **Request-selected mode.** A call with no `project`/`agent` errors; an unknown name
   errors; no directory is created for an unregistered name; a known name works.
8. **No caller path.** `project: "../global"`, an absolute path, and a NUL byte are each
   rejected before any filesystem call.
9. **Lift.** `lift` writes one episode in the target with `by: user`, `source: import`
   and `origin:`; the source vault is unchanged; the target's consolidation, against a
   mock model server, promotes the claim and, for a contradicted `single` predicate,
   supersedes the old fact.
10. **Per-vault consolidation.** `consolidate --workspace` with no binding makes exactly
    one commit in each vault that had work and none in the others; a candidate in
    `work.coder` never resolves to an entity that exists only in `work.architect`.
11. **Git per vault.** `--as-of` in a workspace vault reads the historical text of a
    note (guards §7).
12. **Containers** (smoke script): with the lineage mounted and shared layers `:ro`, a
    pinned server recalls from all four layers, `remember` writes to the agent layer,
    and nothing under the read-only layers changes.
13. **Eval.** A workspace fixture (two projects × two agents + global) with queries
    labeled by the layer that holds the answer and `expect_absent` entries for sibling
    content. A single sibling hit fails the run, like a trust violation.

## Rollout

0. **Prerequisites, landed as their own fixes** (discovery §Bugs). They are bugs in
   today's single-vault code, so they ship whether or not this RFC does.
   - **B1**: the gate must see facts promoted earlier in the same run, so two
     contradicting same-night claims on a `single` predicate can't both promote. Add a
     lint rule that flags more than one current fact on a `single` predicate, which also
     catches vaults already affected. **Blocks stage 3** (shared writes).
   - **B2**: consolidation must commit after MCP-written episodes, so each night stays a
     revertible unit. **Blocks stage 3**: `git revert` is the rollback path for a bad
     shared write.
   - **B3**: `remember` reindexes (or the docs require `watch` per vault). Shared memory
     is otherwise invisible until the next index run.
   - **B4**: cap the episode slug length. Independent, but more writers hit it more often.
1. ADR, SCHEMA additions (`agent`, `origin`) and lint support.
2. `src/workspace/`: registry, lineage, `workspace init/add/adopt/list`, `--workspace`
   on read commands with federated recall. Tests 1–5, 8.
3. MCP pinned binding, `layers`, `target`, write policy. Tests 3, 6.
4. Request-selected mode. Test 7.
5. `lift`, workspace-wide `index`/`consolidate`/`dream`/`lint`. Tests 9–11.
6. Container docs and smoke additions. Test 12.
7. Eval fixture, then tune `layerWeights` from it (report-only, as `eval --tune` is
   today). Test 13.

Stages 1–3 are useful on their own: pinned agents with isolation and layered recall.

## Open questions

1. **Cross-vault spreading.** Should activation cross layers through shared entity ids?
   Measure it on the stage 7 fixture before considering it. Phase 7 found that graph
   weights barely moved rankings, so the gain may not justify the coupling.
2. **Agent-proposed lifts.** An MCP `propose_lift` that queues a candidate under the
   *target* vault's `.circadia/`, for a human to accept in `review`, mirrors the dreaming
   firewall. Worth it once lifts are common enough to be tedious by hand.
3. **Reconsolidation across layers.** C18 matches a recalled fact and a contradicting
   episode by session within one vault. A fact recalled from `project` and contradicted
   by an episode the coder wrote to its own layer never meets. Should the session window
   look across the lineage, and queue in which vault?
4. **Precedence of `project` vs `global-agent`.** §1 argues project conventions win. The
   opposite case is an agent's hard-won general lesson ("never trust this library's
   retries") losing to a stale project note. Keep the default, make it per-agent
   configurable, or let eval decide?
5. **Team cells.** A vault shared by a subset of agents (architect and QA, not coder)
   doesn't fit the lattice. A named "team" coordinate would be a third axis. Wait for a
   real need.
6. **Read-only SQLite on read-only mounts.** The index runs in WAL mode; opening a WAL
   database on a read-only filesystem can fail when the `-shm` file can't be created.
   Verify `node:sqlite` read-only opens against a `:ro` bind mount on Node 22.18 before
   documenting §8's mount pattern, and fall back to `immutable=1` URIs if needed.
7. **Dreaming across the lineage, read-only.** Per-vault dreaming loses the
   agent-to-project pairs that made up 9 of 13 samples in the discovery experiment. One
   option: a vault's REM pass may draw partners from its lineage vaults, read-only, and
   writes candidates only to its own `.circadia/dreams/`. A shared vault would never
   receive candidates from an agent's pass, so the dream firewall holds. Decide after the
   stage 7 eval, with `eval --dream-sweep` on the workspace fixture.
