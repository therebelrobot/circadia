# src/serve: `circadia serve` (RFC-0003, contract)

The long-lived HTTP MCP service. One process runs the MCP tool surface over **Streamable
HTTP** (`POST /mcp`) with bearer-token auth, a built-in nightly consolidate scheduler, and —
when `serve.watch` is true — the reindexer. It is the only module allowed to import
`node:http` at runtime (ADR-0014); the runtime stays zero-dependency.

Read `docs/rfcs/RFC-0003-server-container.md`, `docs/SECURITY.md` T2, and `docs/CONFIG.md`
§serve first. `serve` is a CLI command, so it is testable with `node:test` and runnable
without Docker.

## Files

| file | owns |
|---|---|
| `tokens.ts` | load/validate the write and read tokens; constant-time comparison; scope classification |
| `gate.ts` | the in-process write mutex plus the advisory lockfile (`WriteGate`) |
| `protocol.ts` | route one JSON-RPC message to the existing `src/mcp` handlers; enforce scopes |
| `http.ts` | `node:http` transport: a single `POST /mcp` route, auth, browser defenses, limits |
| `scheduler.ts` | `HH:MM` schedule math (timezone + DST), the disposable state file |
| `run.ts` | wiring: open the index, start HTTP + scheduler + watcher, heartbeat, `--check` |

## Invariants (must have tests)

- **Auth before routing.** No request reaches a handler, or a 404, without a valid token.
  401 is the only unauthenticated response.
- **One auth path.** `serve` has one transport, so there is no way to disable auth for one
  path and not another. No CORS headers are ever sent; `Origin` is rejected unless
  allowlisted.
- **One writer.** Every mutating operation (`remember`, `wake`, `endorse_dream`,
  `dismiss_dream`, a reindex, a scheduled `consolidate`/`dream`) runs under the `WriteGate`,
  which also holds `.circadia/write.lock`. A CLI command in another process is refused while
  the lock is held; a mutating tool call that waits past `serve.lockWaitMs` fails with a
  retryable JSON-RPC error naming the running job.
- **Reads do not take the gate.** `recall`, `timeline`, `relate`, `get_note` tolerate a
  concurrent reindex through the graph cache's `built_at` check.
- **The write token covers every tool; the read token only reads.** A read token on a write
  tool is refused and the tool does not run.
- **Tokens never log and never live in config.** Config validation rejects any
  `serve.*token*` key; the startup log redacts secrets.
- **No unauthenticated health route.** `serve --check` reads a heartbeat file under the OS
  temp dir; the HTTP surface has no health endpoint.
- **State is disposable.** `.circadia/serve-state.json` and the heartbeat are non-derivable
  but never committed; losing them costs at most one catch-up run.

## Scope (v1)

- One vault per service (RFC-0003 non-goals: no multi-tenancy, no TLS, no web UI). TLS is
  terminated by a reverse proxy; the service speaks plain HTTP on a private network.
- No SSE and no `GET /mcp` stream: every Circadia tool returns a single result.
- A workspace target (`--workspace`) is served the same way as the stdio workspace server
  (pinned or request-selected). The scheduler runs against the bound vault; a
  request-selected serve logs that it has no bound vault to schedule against.
