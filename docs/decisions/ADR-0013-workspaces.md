# ADR-0013: Workspaces — layered vaults for one operator

**Status:** accepted (2026-10-03)

## Context
One operator runs several agents (a coder, an architect, a QA agent) against one memory.
Sharing a single vault lets them pollute each other: a throwaway spike becomes a project
fact, two agents' contradicting values both stay current on a `single` predicate, and one
agent's recalls raise another's ACT-R activation through the shared access log. The
existing `scope` is a filter, not a boundary — consolidation, entity resolution, the
schema-fit gate, dreaming and the access log all ignore it. Prior art (the
librechat-mnemonic and Hindsight audits) failed in exactly this place: default recall
spanning every project, and an import path that let row data choose the destination bank.

At the same time, shared memory has to exist: the architect's decision that the service
uses Postgres is something the coder must see. The design needs a defined place for shared
memory and a defined, gated route into it. See [RFC-0004](../rfcs/RFC-0004-workspaces.md).

## Decision
- **A workspace is a folder of ordinary vaults plus `circadia.workspace.json`.** Each vault
  stays exactly what it is today: its own schema, index, access log, consolidation,
  dreaming and git repo. A workspace adds no new storage format for memory.
- **Flat vault layout.** Vaults are flat siblings under the workspace root; the directory
  name is the vault id. The walker skips only dot-folders, `_meta/` and `node_modules`, so
  a vault nested inside another would be indexed as part of its parent. Flat siblings avoid
  that with no walker change. Ids match `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$`; a
  path is always `join(workspace, id)`, built only after the id is found in the registry
  and passes that pattern (SECURITY.md T3).
- **Two-axis cell lattice and lineage precedence.** A cell is a coordinate
  `(project, agent)`, either side possibly `*`. The four layers are `global` `(*,*)`,
  `project` `(p,*)`, `agent` `(p,a)` and `global-agent` `(*,a)`. At most one vault exists
  per cell. A binding's lineage, in precedence order, is `agent`, `project`,
  `global-agent`, `global`, skipping absent cells. `project` outranks `global-agent`
  because a project's conventions should beat an agent's personal habits. Siblings are
  invisible: `(work, coder)` never reads `(work, architect)` or `(personal, coder)`.
- **Location is the sharing marker.** A fact in `work` is shared with every agent on
  `work`; a fact in `global` is shared with every agent. There is no `shared: true` field
  to forget, misread or spoof, and isolation never depends on a filter being applied.
  Shared memory is reached by exactly three routes: a permitted agent writes an episode
  there, a human runs `circadia lift`, or a human edits the vault directly. All of them end
  at that layer's own schema-fit gate or at a human.
- **One git repo per vault.** `readFileAtCommit()` runs `git show <hash>:<path>`, and git
  resolves that path from the repository root, not the working directory. A vault in a
  subfolder of a larger repo would get `null` for every note and silently fall back to
  current text for `--as-of`. One repo per vault avoids this and keeps each vault's history
  and `history <note>` output to its own changes.
- **`workspace init` and `workspace add` run `git init` per vault.** Single-vault
  `circadia init` does **not** run `git init` (it only scaffolds folders, config and
  templates); the workspace commands do, because the RFC's `--as-of` prose guarantee
  depends on each vault being its own repository. `workspace adopt` does not, since the
  adopted vault already exists and may already have its own history.

## Consequences
- Isolation is physical (separate vaults), not a filter every code path must remember to
  apply. A pinned MCP server opens only its lineage's vaults, so a sibling's files are
  never opened and no bug in recall can leak them.
- The destination vault is always resolved by the server from the registry plus the
  binding. No argument, frontmatter field or archive content can choose a vault directly
  (the lesson of Hindsight finding 2).
- The default write policy is `["self"]`, so a user who never configures `writes` gets
  complete isolation and no agent ever writes shared memory. Sharing is opted into per
  agent.
- Per-vault dreaming loses the agent-to-project pairs that made up most of the discovery
  experiment's samples; that cost is recorded in RFC-0004 §7 and Open question 7.
- `workspace init`/`add` now require `git` on `PATH`. A vault with no commit at or before
  `--as-of` still falls back to current prose and the CLI says so.
- Existing users are unaffected: `--vault` behaves exactly as today, and no vault's format
  changes except two optional episode frontmatter fields (`agent`, `origin`).
