# ADR-0014: `node:http` at runtime, scoped to `circadia serve`

**Status:** accepted (2026-10-16)

## Context

`AGENTS.md` §3.1 says the runtime stays zero-dependency and lists `node:http` as "test mocks
only". RFC-0003 adds a second, long-lived deployment shape: `circadia serve`, one process
that serves the existing MCP tool surface over **Streamable HTTP** (`POST /mcp`) for agents
that cannot spawn a stdio child — a Mastra service, LibreChat, or a laptop reaching a Pi on
the LAN. That transport is an HTTP listener.

The alternatives to a listener are worse and are the reason this decision is scope-narrow:

1. **A third-party HTTP framework** (Express, Hono, Fastify). This breaks zero runtime
   dependencies (ADR-0004) and drags a supply-chain tree into a program that stores personal
   memory. One `POST` route does not justify it.
2. **A stdio-to-HTTP bridge** (`mcp-proxy` and friends). RFC-0003 §Alternatives rejects this:
   the bridge brings its own auth implementation, which can drift from Circadia's. Hindsight's
   separately-disableable MCP auth is exactly that failure, and `docs/SECURITY.md` T2 exists
   because of it.

A single-route `node:http` server is a Node built-in: adding it costs nothing at the supply
chain and keeps one auth path (`serve` has exactly one transport).

## Decision

`node:http` may be imported **at runtime**, but only from `src/serve/`. The scoped exception:

- No other module imports `node:http` at runtime. Tests may keep using it as a mock server.
- `src/serve/` is still zero-dependency: `node:http`, `node:crypto`, `node:fs`, and global
  `fetch` only.
- The stdio server (`src/mcp/server.ts`) and the base image are unchanged: no listener, no
  scheduler, no `node:http`. A user who never runs `serve` keeps today's exact security
  posture.

`AGENTS.md` §3.1 is amended to record the exception rather than delete the rule: the rule
still holds for every other module, and CI can grep that `node:http` appears only under
`src/serve/`.

## Consequences

- `circadia serve` is testable with `node:test` (bind an ephemeral port, drive it with the
  official MCP SDK's `StreamableHTTPClientTransport`) and runnable without Docker.
- The transport is hand-rolled, so RFC-0003's spec-conformance test (the SDK client) is the
  safety net, exactly as `test/mcp-sdk.test.ts` is for stdio.
- The security surface is opt-in and reviewed against T2 in the same change: loopback bind by
  default, a required bearer token, auth before routing, no CORS, `Origin` rejected unless
  allowlisted.
- If a future transport (SSE, a second route, a web UI) is ever wanted, it needs its own
  decision; this ADR does not pre-approve one.

## Status

Accepted.
