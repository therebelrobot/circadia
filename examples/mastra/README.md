# Circadia × Mastra example

A minimal [Mastra](https://mastra.ai) agent that talks to `circadia mcp` over stdio through
Mastra's `MCPClient`. It lists the server's tools, calls `recall` and `remember`, and (when a
model is configured) hands the same tools to a Mastra `Agent`.

This is an **example**, not part of the root package. Its dependencies live in this
directory's `package.json` and are never added to the root `package.json`. It is not part of
the root test suite or the root typecheck.

## Prerequisites

- Node ≥ 22.18 (the same floor as Circadia).
- A vault, indexed. The MCP server answers `recall` from the derived index, so build it
  first:

  ```bash
  node ../../bin/circadia.mjs index --vault ../../examples/vault
  ```

## Install

```bash
cd examples/mastra
npm install
```

## Run

```bash
# against examples/vault (index it first, above)
npm start

# against any other vault
CIRCADIA_VAULT=/path/to/vault npm start
```

`agent.mjs` prints the tool list, the rendered `recall` result, and the episode `remember`
wrote. The direct tool calls need no model.

To also run the Mastra `Agent` over the same tools, set a model id (a local llama.cpp model
served at `http://127.0.0.1:8080`, or a non-OpenAI, non-xAI model via OpenRouter — see
`AGENTS.md` §3.4):

```bash
CIRCADIA_MODEL=llama3 npm start
```

## Smoke test

```bash
npm run smoke
```

`smoke.mjs` copies `examples/vault` to a temp directory, indexes the copy, then drives
`circadia mcp` through `MCPClient`: it asserts the `recall` and `remember` tools are exposed,
that `recall` returns text, and that `remember` writes an episode to disk. It never touches
the tracked `examples/vault`.

## Files

| file | what it is |
|---|---|
| `agent.mjs` | the example: `MCPClient` → `circadia mcp`, calls `recall` + `remember`, optional `Agent` wiring |
| `smoke.mjs` | self-contained smoke test over a temp copy of the vault |
| `package.json` | this example's dependencies (`@mastra/mcp`, `@mastra/core`) |

## How it connects

```js
import { MCPClient } from '@mastra/mcp';

const mcp = new MCPClient({
  servers: {
    circadia: {
      command: process.execPath,
      args: ['../../bin/circadia.mjs', 'mcp', '--vault', vault],
    },
  },
});

const tools = await mcp.listTools();          // namespaced: circadia_recall, circadia_remember, …
await tools['circadia_recall'].execute({ query: 'orchard sensors', session: 's1' }, { toolCallId: 'r', messages: [] });
await tools['circadia_remember'].execute({ text: '…', session: 's1' }, { toolCallId: 'm', messages: [] });
await mcp.disconnect();
```

Mastra namespaces MCP tools as `<server>_<tool>`, so the server key `circadia` yields
`circadia_recall`, `circadia_remember`, `circadia_timeline`, `circadia_relate`, and
`circadia_get_note`.

## Notes

- `remember` over MCP writes **episodes only** and defaults to `by: agent`; it refuses
  `by: user` (the memory-poisoning defense, `AGENTS.md` §4). Consolidation is what promotes
  episode content to facts.
- `recall` logs a query **hash**, never the query text. Passing `session` is what lets the
  reconsolidation window (C18) prioritize a contradicted fact for review.
- The stdio subprocess inherits only the MCP SDK's curated environment whitelist, not the
  full parent environment.
