# Workspaces

A **workspace** is a folder of several ordinary vaults plus a small registry file,
`circadia.workspace.json`, that places each vault on two axes: **project** and **agent**.
It is one operator's memory used by several agents. Plain `--vault` keeps working
unchanged; workspaces are opt-in. See [RFC-0004](rfcs/RFC-0004-workspaces.md).

## The lattice

A **cell** is a coordinate `(project, agent)`, where either side may be `*`:

| layer | project | agent | example | holds |
|---|---|---|---|---|
| `global` | any | any | `global` | who the operator is, standing preferences |
| `project` | `work` | any | `work` | the project's decisions, conventions, architecture |
| `agent` | `work` | `coder` | `work.coder` | what the coder learned on this project |
| `global-agent` | any | `coder` | `coder` | how the coder works, across every project |

At most one vault exists per cell. A cell with no vault is simply absent from every
lineage; nothing requires all four.

The **lineage** of a binding `(p, a)` is, in precedence order:

1. `agent` `(p, a)`
2. `project` `(p, *)`
3. `global-agent` `(*, a)`
4. `global` `(*, *)`

A binding with no agent, `(p, *)`, has lineage `project`, `global`. A binding with no
project, `(*, a)`, has lineage `global-agent`, `global`. A binding `(*, *)` sees `global`
only. **Siblings are invisible**: `(work, coder)` never reads `(work, architect)` or
`(personal, coder)`.

## Layout

```
<workspace>/
  circadia.workspace.json
  global/            # a normal vault: circadia.config.json, episodes/, entities/, .circadia/, .git/
  work/
  coder/
  work.architect/
  work.coder/
```

Flat, never nested: the walker skips only dot-folders, `_meta/` and `node_modules`, so a
vault nested inside another would be indexed as part of its parent. The directory name is
the vault id; ids match `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$`. A path is always
`join(workspace, id)`, built only after the id is found in the registry and passes that
pattern.

**One git repo per vault.** `readFileAtCommit()` runs `git show <hash>:<path>`, and git
resolves that path from the repository root, not the working directory, so a vault in a
subfolder of a larger repo would silently fall back to current text for `--as-of`.
`workspace init` and `workspace add` run `git init` in each vault they create. Single-vault
`circadia init` does **not** run `git init`; `workspace adopt` does not either, since the
adopted vault already exists and may already have its own history.

## Registry

```json
{
  "workspace": 1,
  "vaults": {
    "global":         {},
    "work":           { "project": "work" },
    "coder":          { "agent": "coder" },
    "work.coder":     { "project": "work", "agent": "coder" }
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
  fails the pattern, and `defaults.index.*`. A registered id with no directory warns in
  `workspace list` and errors when a binding needs it.
- **`writes`**: which layers `remember` may target, as a list of `self`, `project`,
  `global-agent`, `global`. `self` is the binding's own cell. `default` applies to every
  agent; `agents.<name>` replaces it for one agent. **The default is `["self"]`**, so a
  user who never sets this gets complete isolation and no agent ever writes shared memory.
- **`recall.layerWeights`**: the weight each layer's ranked list gets in the federated
  merge (see below).
- **`defaults`**: a config object deep-merged *under* each vault's own
  `circadia.config.json`. Order: built-in defaults, then workspace `defaults`, then the
  vault file. `defaults.index.*` is rejected, because index paths are per vault.

## CLI

```
circadia workspace init <dir>                                   # registry + global vault (git init)
circadia workspace add --workspace <dir> [--project p] [--agent a]   # scaffold + git init
circadia workspace adopt --workspace <dir> <id> [--project p] [--agent a]
circadia workspace list --workspace <dir> [--json]
circadia lift --workspace <dir> --from <id> --to <id> <note>^<fact>
```

`add` and `adopt` reject a coordinate whose cell is already occupied by a different vault
id, matching the registry's `workspace.duplicate-cell` rule.

Every command that takes `--vault` also accepts `--workspace <dir>` with
`--project`/`--agent`; the two are mutually exclusive. Read commands (`recall`) use the
lineage. `mcp` binds as below.

**Write commands** (`index`, `consolidate`, `dream`, `lint`) act on **one** vault, never
the lineage: with a binding they run on the bound cell only. With `--workspace` and **no**
`--project`/`--agent` they iterate every registered vault in id order, each with its own
index, lock and commit, and print a per-vault summary. One vault failing (a model endpoint
down, a bad config) does not stop the rest: the loop continues and the command exits
non-zero with the failures listed. `review` and `wake` are interactive or read-once and
**refuse** the unbound form; they need a binding.

## Reading: federated recall

`recall` runs once per vault in the (possibly narrowed) lineage and merges the results by
**weighted reciprocal-rank fusion**: `score = layerWeight / (60 + rank)`, summed per hit.
PageRank scores from different graphs are not comparable, so the merge uses ranks. Ties
break by layer precedence, then by the vault's own score. `topK` and `tokenBudget` apply
to the merged list, not per vault. There is no dedupe across vaults: `entities/api-gateway`
in `work` and in `global` are two notes with two histories. Every hit gains `vault` and
`layer` fields, and `renderForContext()` prints the layer with each passage.

`recall` takes an optional `layers` argument to narrow the lineage (it can only narrow).
A lineage vault that can't be read is skipped, `byVault.<id>.error` names the problem, and
the rendered text says that layer was unavailable.

## Writing: `remember` targets

`remember` gains `target?: "self" | "project" | "global-agent" | "global"`, default
`self`. The server checks the target against the agent's `writes` policy and that the
target cell exists; a refusal is a tool error and nothing is written. Episodes record
their author in the optional `agent:` frontmatter, set by the server from the binding.

## Shared memory

Shared memory is marked by **where it lives**, not by a tag. There are exactly three
routes into a shared layer:

1. A permitted agent writes an episode there (`remember({ target: "project" })`). The
   target's own consolidation decides what becomes a fact, under the same gate.
2. A human lifts a fact: `circadia lift`. It writes an *episode* into the target with
   `by: user`, `source: import` and `origin:`, so the target's invariant (only
   consolidation promotes) holds and `src::` links never cross vaults.
3. A human edits the shared vault directly.

## MCP binding

**Pinned (the default, and the isolation boundary).**

```
circadia mcp --workspace <dir> --project work --agent coder
```

The server resolves the lineage once, at startup, and opens **only** those vaults. Tool
calls cannot name a project or agent; they can narrow to a subset of the lineage
(`layers`) and pick a write target among the allowed ones (`target`). `initialize` states
the binding in `serverInfo` and the server instructions. A launch naming an unregistered
project or agent refuses to start and lists the registered names.

**Request-selected (opt-in, for one process hosting many agents).**

```
circadia mcp --workspace <dir> --select-per-request
```

Every tool call must carry `project` and/or `agent`. The server resolves the cell from the
registry; an unknown name is an error, and nothing is ever auto-created over MCP.

**Rule for both modes.** The destination vault is always resolved by the server from the
registry plus the binding. No argument, frontmatter field or archive content can choose a
vault directly.

## Containers

Mount the lineage only, and mount read-only every layer the agent may not write. The
kernel then enforces both isolation (siblings aren't present) and the write policy (shared
layers aren't writable), independently of Circadia's own checks.

```
docker run -i --rm --read-only --tmpfs /tmp --network none --user <uid>:<gid> \
  -v <ws>/circadia.workspace.json:/workspace/circadia.workspace.json:ro \
  -v <ws>/work.coder:/workspace/work.coder \
  -v <ws>/work:/workspace/work:ro \
  -v <ws>/coder:/workspace/coder:ro \
  -v <ws>/global:/workspace/global:ro \
  ghcr.io/therebelrobot/circadia:<version> mcp --workspace /workspace --project work --agent coder
```

For read-only layers the server opens the index read-only and skips access logging, so
their indexes must be kept current by a host-side `index` or `consolidate` job.

**Read-only layers and SQLite WAL (verified).** The index runs in WAL mode, and SQLite
needs to create `-shm`/`-wal` files beside the database. On a `:ro` mount that fails with
`unable to open database file`; `mode=ro` does not help, because the sidecar is still
required. Circadia therefore opens a read-only layer's index with SQLite's `immutable=1`
URI, which tells SQLite the file cannot change and skips the sidecar entirely.
`scripts/container-smoke.sh` proves this end to end: a pinned server recalls from a `:ro`
layer, and the layer's directory is byte-for-byte unchanged afterward (no access log, no
`-shm`/`-wal`). The trade-off is that `immutable=1` assumes the file never changes while
it is open, so a read-only layer's index must be rebuilt by a host-side
`index`/`consolidate` job and the container restarted (or the mount refreshed) to see the
new index. A writable layer is opened normally and logs access as usual.
