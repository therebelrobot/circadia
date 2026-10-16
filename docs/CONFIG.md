# Configuration reference

The config file is `circadia.config.json` in the **vault root**, so a vault is
self-describing. Every key is optional. Your file is deep-merged over the defaults:
objects merge, while arrays and scalars replace. Defaults live in `src/config.ts`
(`DEFAULT_CONFIG`), and validation in `validateConfig()`. An invalid config fails loudly on
load.

## vault

| key | default | meaning |
|---|---|---|
| `vault.factsHeading` | `"Facts"` | `##` heading whose list items are parsed as current facts |
| `vault.historyHeading` | `"History"` | `##` heading for historical and superseded facts |
| `vault.ignore` | `[]` | vault-relative globs never indexed. `_meta/`, dot-folders, and `node_modules/` are always skipped |

## index

| key | default | meaning |
|---|---|---|
| `index.path` | `".circadia/index.sqlite"` | derived index; safe to delete |
| `index.accessLog` | `".circadia/access.jsonl"` | retrieval log; **not derivable, back it up** |

## graph

| key | default | meaning |
|---|---|---|
| `graph.defaultExtraction` | `"typed"` | extraction mode when no scope rule matches (`wikilink` \| `typed` \| `hipporag`) |
| `graph.scopes` | `[]` | ordered rules `{ match: { tags?, paths?, kinds?, types? }, extract }`; first match wins |
| `graph.query.mode` | `"auto"` | default query mode (`wikilink` \| `typed` \| `hipporag` \| `auto`) |
| `graph.query.auto.ladder` | `["wikilink","typed","hipporag"]` | rungs tried in order |
| `graph.query.auto.minTopMargin` | `0.05` | escalate when `(s1−s2)/s1` is below this |
| `graph.query.auto.minSeeds` | `2` | escalate when fewer seeds were found |
| `graph.query.auto.multiEntityThreshold` | `2` | start one rung up when the cue names this many entities |
| `graph.originWeights` | contains 1, link 1, fact 1.5, provenance 0.5, triple 1, synonym 0.5, dream 0 | multiplier per edge origin. `dream` defaults to **0**: `addEdge` drops weight ≤ 0, so unconfirmed REM associations are in the index and in no PageRank graph. Turning them on is a separate, measured decision (RFC-0001 Stage 5) |
| `graph.damping` | `0.5` | PageRank damping d (HippoRAG uses 0.5); must be in (0, 1) |
| `graph.maxIterations` | `100` | power-iteration cap |
| `graph.tolerance` | `1e-8` | L1 convergence threshold |

## retrieval

| key | default | meaning |
|---|---|---|
| `retrieval.topK` | `8` | max hits |
| `retrieval.tokenBudget` | `2000` | approximate tokens of passage text (characters ÷ 4); the first hit always fits |
| `retrieval.seedLimit` | `20` | keyword hits considered as seeds |
| `retrieval.weights` | graph 1.0, activation 0.3, importance 0.2 | score weights |
| `retrieval.actrDecay` | `0.5` | ACT-R decay d |
| `retrieval.actrThresholdDays` | `30` | age at which a single-presentation memory has P = 0.5 |
| `retrieval.actrNoise` | `1.0` | ACT-R noise s in the retrieval-probability logistic |
| `retrieval.trustFloor` | `"low"` | **traversal** floor: drop edges and passages below this trust (`low` \| `medium` \| `high`). Distinct from `dreaming.trustFloor`, the **sampling** floor |
| `retrieval.includeSuperseded` | `false` | traverse superseded fact edges |
| `retrieval.logAccess` | `true` | append returned hits to the access log |
| `retrieval.factExpansion.enabled` | `false` | RFC-0002 entity-anchored fact expansion. This key is the feature flag (Circadia has no flag service); off during rollout |
| `retrieval.factExpansion.perHit` | `1` | fact targets inserted per cue entity; must be a non-negative integer |
| `retrieval.factExpansion.maxInserted` | `3` | passages one query may insert in total; must be a non-negative integer |

## dreaming (Phase 8)

The REM pass (RFC-0001). A user who never sets any of these gets no dreaming at all:
`dreaming.enabled` is `false`, so `consolidate --dream` skips the pass. The explicit
`circadia dream` command always runs — typing it is consent. Dream state lives under
`.circadia/dreams/`, is disposable, and is never committed to git (ADR-0011).

| key | default | meaning |
|---|---|---|
| `dreaming.enabled` | `false` | `consolidate --dream` runs the REM pass only when true |
| `dreaming.samplesPerNight` | `20` | model calls per night |
| `dreaming.minHops` | `2` | minimum graph distance between a pair, over non-dream origins |
| `dreaming.recentDays` | `7` | window (days) for the recent side |
| `dreaming.noiseShare` | `0.25` | share of partners that are uniformly random older notes |
| `dreaming.trustFloor` | `"medium"` | **sampling** floor: notes below this trust are never sampled. Distinct from `retrieval.trustFloor`, the **traversal** floor |
| `dreaming.recallFragments` | `3` | fragments shown by `wake` |
| `dreaming.logTtlHours` | `12` | unread log lifetime in hours; `0` turns the TTL off |
| `dreaming.candidateTtlNights` | `14` | candidate lifetime in nights |

Proposals use the configured `extraction` endpoint, a local model by default. A hosted
endpoint is the user's choice and carries passage text off the machine.

## mcp

| key | default | meaning |
|---|---|---|
| `mcp.logAccess` | `true` | log MCP `recall` hits to the access log. The log stores only the query hash, never the query text, so this is privacy-safe; without it, agent use through MCP never feeds ACT-R or the reconsolidation window. Set `false` to keep MCP traffic out of the log |

## embeddings

Passage embeddings for vector seeds (Phase 2). With `provider: "http"`,
`circadia index` embeds new/changed passages after indexing, `watch` does so
best-effort after each reindex, and `recall` embeds the query and adds a vector
seed list. A down server degrades to text-only recall with a warning.

| key | default | meaning |
|---|---|---|
| `embeddings.provider` | `"none"` | `none` \| `http` |
| `embeddings.endpoint` | `"http://127.0.0.1:8080/v1/embeddings"` | an OpenAI-compatible **wire format** endpoint, e.g. llama.cpp `llama-server --embedding` |
| `embeddings.model` | `"nomic-embed-text"` | model name sent to the endpoint; changing it re-embeds every passage |
| `embeddings.apiKeyEnv` | `null` | name of an env var holding a bearer token; the token itself never goes in config |
| `embeddings.apiKeyFileEnv` | `null` | name of an env var holding a *path* to a file with the token (Docker secrets). Additive; wins over `apiKeyEnv` when set and non-empty (RFC-0003 §7) |
| `embeddings.batchSize` | `32` | texts per request |

## extraction (Phase 4/5; keys reserved)

LLM used for hipporag triple extraction and for consolidation.

| key | default | meaning |
|---|---|---|
| `extraction.provider` | `"none"` | `none` \| `http` |
| `extraction.endpoint` | `"http://127.0.0.1:8080/v1/chat/completions"` | local llama.cpp by default. For hosted models use OpenRouter with a **non-OpenAI, non-xAI** model (owner requirement; see AGENTS.md §3) |
| `extraction.model` | `""` | model id |
| `extraction.apiKeyEnv` | `null` | env var name for the key. Use a spend-capped key (e.g. an OpenRouter key with a per-key `limit`) |
| `extraction.apiKeyFileEnv` | `null` | env var naming a *file* that holds the key (Docker secrets). Additive; wins over `apiKeyEnv` when set and non-empty (RFC-0003 §7) |

## serve (`circadia serve`, RFC-0003)

`circadia serve` runs the MCP tool surface over **Streamable HTTP** (`POST /mcp`) as a
long-lived service, with a built-in nightly consolidate scheduler. Every key here is inert
for the stdio server and the one-shot commands, so a user who never runs `serve` gets
exactly the stdio behavior. Tokens are **never** in this file: it lives in the git-tracked
vault, and config validation rejects any `serve.*token*` key. See
[RFC-0003](rfcs/RFC-0003-server-container.md) and `docs/SECURITY.md` T2.

| key | default | meaning |
|---|---|---|
| `serve.bind` | `"127.0.0.1"` | interface to bind. Loopback by default (SECURITY.md T2). Set `"0.0.0.0"` (or `CIRCADIA_BIND=0.0.0.0`) to reach it from another LAN host; the server logs a warning when non-loopback |
| `serve.port` | `8711` | TCP port. `CIRCADIA_PORT` overrides |
| `serve.allowedOrigins` | `[]` | exact `Origin` values allowed. Empty rejects every request that carries an `Origin` (DNS-rebinding defense). `"*"` is rejected: T2 forbids `allow_origins=*` with credentials |
| `serve.maxBodyBytes` | `1048576` | request body cap, enforced while streaming (buffering stops at the cap); over it is `413` |
| `serve.maxInFlight` | `8` | concurrent request cap; over it is `503` + `Retry-After` |
| `serve.lockWaitMs` | `10000` | how long a mutating tool call waits for the write lock before a retryable JSON-RPC error that names the running job (RFC-0003 §4) |
| `serve.watch` | `false` | reindex on vault file changes in the service. `remember` already reindexes, so this only matters when editing the vault by hand |
| `serve.schedule.consolidate` | `null` | local time `"HH:MM"` for the nightly consolidate, or `null` to disable. `null` (the default) means a user who never sets it gets no model calls |
| `serve.schedule.timezone` | `null` | IANA zone for the schedule; `null` means `TZ`, else UTC |

**Tokens** load from files named by env vars, for Docker secrets:
`CIRCADIA_WRITE_TOKEN_FILE` and (optional) `CIRCADIA_READ_TOKEN_FILE`. A bare
`CIRCADIA_WRITE_TOKEN` is accepted for development and logs a warning. The server refuses to
start without a write token, with a token shorter than 32 bytes, or with a read token equal
to the write token. The write token covers every tool; the read token covers only `recall`,
`timeline`, `relate` and `get_note` (`wake` counts as a write: it deletes the dream log).

**State:** the last scheduled run is recorded in `.circadia/serve-state.json`, which is
non-derivable but **disposable** (like `.circadia/dreams/`); losing it costs at most one
extra catch-up run. The health heartbeat is a file under the OS temp dir (tmpfs in a
container), never the vault, so `circadia serve --check` needs no network call and there is
no unauthenticated health route.

## predicates

| key | default | meaning |
|---|---|---|
| `predicates.strict` | `false` | unknown predicates are errors (true) or warnings (false) |
| `predicates.defs` | `{}` | `name → { object?: entity\|literal\|any, inverse?, values?, description?, cardinality? }`. `cardinality` is `many` (default) or `single`. `many` accumulates objects; `single` treats a second, different object as a contradiction the consolidation gate resolves (queue, or supersede when a `by: user` episode states it explicitly). Set `single` only where replacement makes sense, e.g. `runs_on`, `status` |

## Workspaces (`circadia.workspace.json`)

A workspace is a folder of ordinary vaults plus a registry file. It is **not** a vault
config: it lives at the workspace root, next to the vault directories, and holds no
secrets and no memory. See [WORKSPACES.md](WORKSPACES.md) and
[RFC-0004](rfcs/RFC-0004-workspaces.md).

| key | default | meaning |
|---|---|---|
| `workspace` | — | must be `1` |
| `vaults` | — | `id → { project?, agent? }`. At most one vault per cell. Ids match `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$` |
| `writes.default` | `["self"]` | layers `remember` may target: `self`, `project`, `global-agent`, `global`. The default gives complete isolation |
| `writes.agents.<name>` | — | replaces `writes.default` for one agent |
| `recall.layerWeights` | `{ agent: 1.0, project: 0.9, "global-agent": 0.8, global: 0.7 }` | weight each layer's ranked list gets in the federated merge |
| `defaults` | `{}` | a config object deep-merged **under** each vault's own `circadia.config.json` |

**Merge order for `defaults`:** built-in defaults, then workspace `defaults`, then the
vault file. This lets one model endpoint serve every vault while each vault can still
override. `defaults.index.*` is rejected, because index paths are per vault.

## Example

```json
{
  "graph": {
    "defaultExtraction": "typed",
    "scopes": [
      { "match": { "tags": ["deep"] }, "extract": "hipporag" },
      { "match": { "paths": ["entities/people/**"] }, "extract": "wikilink" }
    ],
    "query": { "mode": "auto", "auto": { "minTopMargin": 0.08 } }
  },
  "retrieval": { "topK": 6, "trustFloor": "medium" },
  "predicates": {
    "strict": true,
    "defs": {
      "runs_on": { "object": "entity", "inverse": "hosts" },
      "status":  { "object": "literal", "values": ["active", "paused", "done", "archived"] }
    }
  }
}
```
