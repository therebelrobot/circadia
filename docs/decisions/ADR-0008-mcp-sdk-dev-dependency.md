# ADR-0008: `@modelcontextprotocol/sdk` as a dev-only dependency

**Status:** accepted (2026-09-30)

## Context

`AGENTS.md` §3 and `docs/SECURITY.md` T6 limit dev dependencies to `typescript` and
`@types/node`, and require an ADR before adding any other dependency. The MCP server
(`src/mcp/server.ts`) is hand-rolled JSON-RPC over stdio with zero runtime dependencies
(ADR-0004), and that must not change.

The hand-written stdio tests in `test/mcp-stdio.test.ts` assert on raw bytes, but they do
not validate the handshake the way a real client does. That gap shipped a real bug: the
`initialize` result was missing `protocolVersion`, so the official MCP TypeScript SDK —
and every client built on it, including Mastra — rejected the connection with
`invalid_type at "protocolVersion"` before any tool call. A hand-written client that does
not validate the handshake cannot catch a spec-conformance gap like this.

## Decision

Add `@modelcontextprotocol/sdk` as a **dev dependency only**, used solely by
`test/mcp-sdk.test.ts`. The test spawns the real server over `StdioClientTransport`,
connects with the official `Client`, lists the tools, and calls one. It is the only
reliable conformance check for the MCP wire protocol: the SDK encodes the spec's
validation rules, so it catches handshake and result-shape gaps that a hand-written
client misses.

The dependency is never imported by `src/`, never bundled, and never shipped: `npm test`
is the only thing that loads it. The runtime stays zero-dependency (ADR-0004).

## Consequences

- `test/mcp-sdk.test.ts` fails with `invalid_type at "protocolVersion"` when the field is
  removed, and will catch the next spec gap in the handshake or tool-result shape.
- The dev-dependency allowlist grows from two packages to three. `AGENTS.md` §3 and
  `docs/SECURITY.md` T6 are updated to name it and point here.
- The SDK pulls a transitive tree (94 packages at v1.31.0). It is dev-only, so it does not
  affect the published package or the runtime supply chain; Dependabot should still track
  it.
- If the SDK's validation ever diverges from the spec, the test is the place to notice;
  the server itself remains hand-rolled and dependency-free.
