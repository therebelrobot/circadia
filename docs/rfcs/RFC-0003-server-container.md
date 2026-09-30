# RFC-0003: Server container (`circadia-server`)

Status: proposed · 2026-09-30 · written against `cf10312`

Depends on the Packaging roadmap item (the stdio container, image `circadia`). This RFC
adds a **second, separate image**; it doesn't change the first.

## Summary

Publish a second image, `ghcr.io/<owner>/circadia-server`, that runs Circadia as a
long-lived service. A new command, `circadia serve`, runs everything in one Node process:

1. the MCP server over **Streamable HTTP**, with bearer-token auth and read/write scopes;
2. a **built-in scheduler** for nightly consolidation ("sleep") and, when enabled, the REM
   dreaming pass;
3. optionally, the `watch` reindexer.

The first image stays as it is: stdio only, no network listener, no scheduler. Anyone who
doesn't opt in to `circadia-server` gets exactly today's security posture.

## Motivation

- **Remote agents.** Stdio needs the MCP client to spawn the server. That works when the
  agent and the vault share a machine. It doesn't work when the vault lives on a Pi and
  the agents run elsewhere (a Mastra service, LibreChat, a laptop).
- **Sleep without host setup.** Today, nightly consolidation is a cron line or systemd
  timer that each host has to configure. It depends on host `PATH`, Node version and
  timezone, and it fails silently. A service that owns its schedule can log and report
  its last run.
- **One writer.** A long-running MCP server plus a cron-launched `consolidate` means two
  processes writing the same vault and index. SQLite is in WAL mode with no
  `busy_timeout`, and nothing coordinates writers across processes today. One process
  that owns both is easier to make correct.

## Non-goals

- **Multi-tenancy or per-user ACLs.** One container serves one vault, and one vault is one
  trust domain (SECURITY.md T4). Two trust domains means two containers.
- **TLS.** Terminate TLS in a reverse proxy. The service speaks plain HTTP on a private
  network.
- **Interactive `review` in the service.** Review needs a human at a keyboard. It stays a
  CLI command, run with `docker exec -it`.
- **Pushing the vault to a git remote.** The container gets no git credentials. Push from
  the host or from a separate sidecar.
- **A web UI.**

## Design

### 1. Images

One Dockerfile with two final targets:

| target | image | entrypoint | network listener | scheduler |
|---|---|---|---|---|
| `runtime` | `circadia` | `circadia mcp --vault /vault` (stdio) | none | none |
| `server` | `circadia-server` | `circadia serve --vault /vault` | HTTP | built in |

`server` is `FROM runtime`. It adds no packages and no npm dependencies. The only
difference is its `CMD`, its `HEALTHCHECK`, and a documented port. Both keep the same
hardening: non-root user, read-only root filesystem, `/vault` as the only writable
mount, and `/tmp` as tmpfs.

Both images are built by the same workflow and share one version, the one in
`package.json`.

### 2. `circadia serve`

`serve` is a CLI command in the npm package too, not only in the image. That way it's
testable with `node:test` and usable without Docker. It starts:

- the HTTP MCP transport (§3);
- the scheduler (§5);
- the watcher, if `serve.watch` is true (default `false`: in `serve`, `remember` already
  reindexes after writing, so `watch` only matters when people edit the vault by hand);

and routes every mutating operation through one write lock (§4).

`serve` never offers stdio. So "one auth path for all transports" (T2) holds trivially:
the service has one transport, and it is authenticated.

### 3. HTTP transport

Streamable HTTP per the MCP spec, written on `node:http`. It needs no dependency, and
the existing JSON-RPC handler in `src/mcp/` is reused unchanged.

- **One route: `POST /mcp`.** Responses are `application/json`. The spec lets a server
  answer a POST with plain JSON instead of an SSE stream, and every Circadia tool returns
  a single result, so v1 has no SSE, no `GET /mcp` stream, and no server-initiated
  messages. Every other method or path gets `404` *after* the auth check, so there are no
  unauthenticated routes.
- **Protocol sessions.** Honor `Mcp-Session-Id` as the spec requires. Don't confuse it
  with the `session` argument on `recall`/`remember`: that one is Circadia's
  reconsolidation session (C16/C18), supplied by the caller. The two are unrelated and
  the code must not merge them.
- **Bind.** The process defaults to `127.0.0.1` (T2). Inside a container, loopback is
  unreachable through a published port, so the documented compose file sets
  `CIRCADIA_BIND=0.0.0.0` *and* publishes on the host's loopback only
  (`127.0.0.1:8711:8711`). The image itself does **not** set `0.0.0.0`. When the service
  detects it is bound to loopback inside a container (`/.dockerenv` exists), it logs a
  warning explaining why it may be unreachable.
- **Auth.** See §6.
- **Browser defenses.**
  - No CORS headers, ever. The server doesn't answer `OPTIONS` preflights.
  - Reject any request carrying an `Origin` header unless it is listed in
    `serve.allowedOrigins`, which is empty by default. This follows the MCP spec's
    DNS-rebinding guidance.
- **Limits.**
  - request body at most `serve.maxBodyBytes` (default 1 MiB), checked while streaming,
    not after buffering;
  - a per-request timeout;
  - a cap on in-flight requests (default 8). Over the cap the server returns `503` with
    `Retry-After`.

### 4. Write coordination

Mutating operations (`remember`, `wake`, `endorse_dream`, `dismiss_dream`, reindex,
scheduled `consolidate`/`dream`) run under a single in-process async mutex. Reads
(`recall`, `timeline`, `relate`, `get_note`) don't take it. They already tolerate a
concurrent reindex through the graph cache's `built_at` check.

Cross-process access still happens, for example `docker exec … circadia review` while
the service runs. So:

- **Add an advisory lockfile**, `.circadia/write.lock` (pid, hostname, command, start
  time), taken by `serve`'s mutex holder *and* by every mutating CLI command in the base
  package. A CLI command that finds a live lock exits with a clear message and a nonzero
  code rather than waiting. A lock whose pid is gone on this host is stale and is
  replaced. The lockfile protects the plain CLI as well, so it lands in the base package
  as its own change, before `serve`.
- **Set `PRAGMA busy_timeout`** (for example 5 s) in `openIndex()`. It's cheap, and it
  turns rare index contention into a wait instead of `SQLITE_BUSY`.

**Consolidation takes minutes.** It makes model calls per episode. Holding the lock the
whole time would block `remember` for the whole run. v1 accepts that, within limits: a
`remember` that can't get the lock within `serve.lockWaitMs` (default 10 s) fails with a
retryable JSON-RPC error that names the running job. Episodes are cheap to resend, and a
nightly run lands when agents are usually idle. Splitting consolidation into an unlocked
propose phase and a locked write phase is left as an open question (§Open questions).

### 5. Scheduler

It is built in, not cron.

- **Syntax.** `serve.schedule.consolidate` is a local time, `"HH:MM"`, or `null` to
  disable it. The default is `null`: nothing runs until the user asks, so a user who
  never sets it gets no model calls. `serve.schedule.timezone` is an IANA name and
  defaults to `TZ` or UTC. Daily is the only frequency. Nobody has asked for more, and a
  hand-written cron parser is exactly the kind of code this repo keeps out.
- **Dreaming.** The scheduled run is `consolidate --dream` when `dreaming.enabled` is
  true, and plain `consolidate` otherwise. Existing config decides; `serve` adds no
  second switch.
- **Missed runs.** At startup, if the last *successful* scheduled run is more than 24 h
  old and today's slot has passed, run once (catch-up), then return to the normal
  schedule. Never run more than one catch-up.
- **DST.** A slot that doesn't exist on a given day (a spring-forward gap) runs at the
  first valid minute after it. A slot that repeats (fall-back) runs once.
- **State.** Record the last run's start, end, outcome, and counts (promoted, queued,
  superseded) in `.circadia/serve-state.json`. The file is non-derivable but
  **disposable**, like `.circadia/dreams/`. Losing it costs at most one extra catch-up
  run. Add it to the AGENTS.md invariants list.
- **Failure.** A failed run is logged and is not retried until the next slot. A model
  endpoint that is down must not become a hot loop of model calls.
- **Git.** Consolidation already makes one commit per run. The image ships `git` and
  sets:
  - `safe.directory=/vault` in the **system** gitconfig. It names that path only, never
    `*`. This fixes "dubious ownership" when the vault's uid differs from the
    container's;
  - `HOME=/tmp`;
  - a default identity through `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` =
    `Circadia <circadia@example.invalid>`, which the user can override.

### 6. Authentication and scopes

- **Two tokens.**
  - A **write** token covers every tool.
  - An optional **read** token covers only `recall`, `timeline`, `relate` and `get_note`.
  - `wake` counts as a write, because it deletes the dream log.

  This meets the T2 rule that mutating tools need a write scope.
- **Loading.** Tokens load from files named by env vars: `CIRCADIA_WRITE_TOKEN_FILE` and
  `CIRCADIA_READ_TOKEN_FILE`, meant for Docker secrets. `CIRCADIA_WRITE_TOKEN` is also
  accepted for development and logs a warning.
  - **Tokens never go in `circadia.config.json`.** That file lives in the vault, and the
    vault is a git repo.
  - Config validation rejects any `serve.*token*` key.
- **Startup.** The server refuses to start without a write token. It also refuses a token
  shorter than 32 bytes, or a read token equal to the write token.
- **Comparison.** Compare with `crypto.timingSafeEqual` over SHA-256 digests, so the
  comparison doesn't leak token length. The check runs on every request before routing.
  A missing or bad token gets `401` with `WWW-Authenticate: Bearer`. A valid read token
  on a write tool gets a JSON-RPC error, and the tool doesn't run.
- **Rotation.** Restart the container. v1 doesn't hot-reload secrets.
- **OAuth.** The MCP spec's OAuth authorization flow is out of scope for v1. Static
  bearer tokens suit a single-owner homelab service. Revisit if clients start to require
  OAuth.

### 7. Model endpoint and secrets

- **Endpoint.** Inside the container, `127.0.0.1:8080` means the container itself, so the
  default `extraction.endpoint` points at nothing. The docs and the compose example set it
  to a service name (`http://llama:8080`) or `http://<docker-host>:8080`. At startup,
  `serve` probes each configured endpoint once. It logs a clear warning if one is
  unreachable, but doesn't fail, since sleep may be hours away.
- **API keys.** `apiKeyEnv` puts the key in the environment, and `docker inspect` shows
  the environment. Add a sibling config key, `apiKeyFileEnv`: the name of an env var that
  holds a *path* to a file containing the key, for Docker secrets. It is additive, and
  `apiKeyEnv` keeps working. Hosted providers still follow T5: spend-capped keys only.

### 8. Network placement (documented, not enforced)

The compose example ships two networks:

- **`internal: true`** for the clients that call the MCP endpoint;
- a normal network, joined only if the model endpoint is hosted. Local llama.cpp on the
  same internal network needs no egress at all.

Wide-open egress is never the default. This follows the egress pattern from the opencode
sandbox work: containment at the network layer, not by trusting a process to behave.

### 9. Health and logs

- **Health.** `HEALTHCHECK` runs `circadia serve --check`. The check reads a heartbeat
  file that the service rewrites every 30 s on `/tmp` (tmpfs, never the vault), plus the
  last scheduled run's outcome. It doesn't call the HTTP endpoint, so no unauthenticated
  health route exists.
- **Logs.** JSON lines on stdout: startup config (with secrets redacted), each scheduled
  run's summary, auth failures (with a counter, not a line per request after the first
  few), and lock contention.
- **What logs never contain:** query text, which T5 already forbids; episode text; and
  token material. The logs also include no telemetry.

## Alternatives considered

1. **The base image plus host cron.** This is available today once the stdio image
   ships, and it stays the recommended setup for a single machine. It doesn't solve
   remote agents.
2. **supercronic (or busybox crond) inside the container, plus a stdio-to-HTTP bridge.**
   - It adds a binary dependency and cron-format config.
   - It puts two writers in one container with no coordination.
   - A bridge like `mcp-proxy` brings its own auth implementation, which can drift from
     Circadia's. Hindsight's separately disableable MCP auth is exactly that failure.
   Rejected.
3. **A separate scheduler container sharing the vault volume.** This one is viable, and
   the §4 lockfile makes it safe. It is deferred because it adds a second deployable
   while bringing no new capability. Revisit if people want the scheduler without the
   HTTP endpoint.
4. **A third-party HTTP framework.** It breaks zero runtime dependencies (ADR-0004). One
   POST route doesn't justify one.

## Security review against T2

| T2 requirement | How this design meets it |
|---|---|
| Bind `127.0.0.1` by default | Process default is loopback; the image doesn't override it; compose publishes on host loopback |
| Require a bearer token; refuse to start without one | §6; startup check, plus a test |
| One auth path for all transports | `serve` has exactly one transport; stdio stays in the separate `circadia` image with no network surface |
| No CORS by default; never `*` with credentials | §3; no CORS headers at all, and `Origin` is rejected unless allowlisted |
| Every route checks auth | §3; auth runs before routing, so unknown paths 404 only after auth |
| Mutating tools need a write scope | §6; read and write tokens |

It adds these controls beyond T2: a body-size cap, a concurrency cap, the advisory write
lock, no secrets in the git-tracked vault config, and no unauthenticated health route.

## Changes this requires

- **ADR-0013: `node:http` at runtime for `serve`.** AGENTS.md hard constraint 1 lists
  `node:http` as "test mocks only". The ADR records the scoped exception: runtime use
  only inside `serve`, still zero dependencies. Then update the constraint's text.
- **Base-package change, landed first:** `.circadia/write.lock` for all mutating CLI
  commands, plus `busy_timeout`. It has value without `serve`.
- **Config:**
  - `serve.bind`, `serve.port` (default 8711), `serve.allowedOrigins`,
    `serve.maxBodyBytes`, `serve.maxInFlight`, `serve.lockWaitMs`, `serve.watch`,
    `serve.schedule.consolidate`, `serve.schedule.timezone`;
  - `extraction.apiKeyFileEnv` and `embeddings.apiKeyFileEnv`;
  - rows in `docs/CONFIG.md` for each.
- **Docs:**
  - `docs/SECURITY.md`: T2 gains ✔/◻ markers for the HTTP controls;
  - `src/mcp/README.md`: the transport section, and the scope of each tool;
  - AGENTS.md: repo map, invariants (`serve-state.json`, `write.lock`), commands;
  - `docs/ROADMAP.md`: a new phase for this work;
  - README: a "Running as a service" section with the compose example.
- **CI:** a second entry in the container workflow's matrix, with the same attestation
  and the same tag scheme.

## Test plan

Each item below gets a test that fails without the feature, per AGENTS.md §10.

1. **Auth.**
   - `serve` exits nonzero with no write token, a token under 32 bytes, or read equal to
     write.
   - `401` without a token and with a wrong token, on `/mcp` and on an unknown path.
   - A read token on `remember` returns an error, and nothing appears under `episodes/`.
2. **Spec conformance.** Run `@modelcontextprotocol/sdk`'s `Client` with
   `StreamableHTTPClientTransport` against `serve` on an ephemeral port. Cover
   `initialize`, `tools/list`, two concurrent calls with matched ids, and `remember`
   writing an episode with `by: agent`. The SDK is already a dev dependency (ADR-0008).
3. **Browser defenses.**
   - A request with a non-allowlisted `Origin` is rejected.
   - No response carries `Access-Control-*` headers.
   - An `OPTIONS` request gets no preflight approval.
4. **Limits.** A 2 MiB body is rejected before it is fully read, and the in-flight cap
   returns `503`.
5. **Scheduler**, with an injected clock:
   - a slot fires once;
   - catch-up fires once after downtime and not again;
   - DST spring-forward and fall-back behave as specified;
   - a failed run is not retried before the next slot;
   - `null` schedules nothing.
   Run against a temp copy of `examples/vault/` with a mock model server: a
   `node:http` server answering `/v1/chat/completions` with canned candidates.
6. **Locking.**
   - `remember` during a scheduled consolidation waits and then returns the retryable
     error.
   - A CLI `consolidate` exits nonzero while `serve` holds the lock.
   - A stale lock (dead pid) is replaced.
7. **Container**, as a CI smoke job:
   - the container runs as a nonzero uid;
   - writing outside `/vault` and `/tmp` fails;
   - `HEALTHCHECK` turns healthy;
   - a consolidation commit succeeds when the vault's uid differs from the container's;
   - an SDK client over HTTP works through a published loopback port.
8. **Logs.** A test greps captured output from a run with known query and episode text,
   and asserts that neither appears.

## Rollout

1. Land the write lock and `busy_timeout` in the base package.
2. Land ADR-0013, then `circadia serve` with transport and auth (no scheduler), plus tests
   1–4.
3. Add the scheduler and state file, plus tests 5–6.
4. Add the `server` Dockerfile target, the CI matrix entry, the compose example and docs,
   plus tests 7–8.
5. Ship `circadia-server` with the next minor version.

## Open questions

1. **Two-phase consolidation.** Could consolidation hold the write lock only for its
   write phase? That needs a snapshot of the selected episodes and a re-check that
   nothing changed before writing. It would unblock `remember` during sleep, at the cost
   of real complexity in `consolidate.ts`. Decide after measuring real run lengths on a
   Pi.
2. **Streaming.** Is SSE needed for any client? Some MCP clients may insist on a `GET`
   stream. If one does, add it behind the same auth.
3. **Pending-review signal.** Should the service expose the pending-review count, say in
   the `--check` output or as a read-scoped tool, so users notice that sleep queued
   candidates?
4. **Port.** 8711 avoids librechat-mnemonic's 8710, but it is otherwise arbitrary. Is
   there a better convention?