# src/mcp: MCP server (Phase 3, contract only)

Nothing here is implemented yet. This file is the contract the Phase 3 implementation must
meet. Read `docs/ROADMAP.md` Phase 3 and `docs/SECURITY.md` T1–T3 first.

## Transport

- **stdio only** at first, with JSON-RPC 2.0 framing written by hand (zero dependencies,
  ADR-0004).
- If an HTTP transport is ever added:
  - bind `127.0.0.1`;
  - require a bearer token and refuse to start without one;
  - use one auth path for every transport;
  - send no CORS headers by default.

## Tools

| tool | args | effect | writes |
|---|---|---|---|
| `recall` | `query: string`, `mode?: wikilink\|typed\|hipporag\|auto`, `as_of?: string`, `top_k?: number`, `scope?: string`, `session?: string` | `recall()` + `renderForContext()` | access log only (query hash, never the query text; `mcp.logAccess`, default on) |
| `remember` | `text: string`, `session?: string`, `by?: user\|agent\|tool\|web`, `source?: chat\|tool\|import` | segment `text` at topic shifts and write one episode per segment | `episodes/**` **only** |
| `timeline` | `entity: string` | facts about an entity ordered by `valid_from`, incl. superseded | none |
| `relate` | `a: string`, `b: string`, `max_hops?: number` | shortest edge paths with provenance | none |
| `get_note` | `id: string` | raw note content | none |
| `wake` | none | read the night's dream log once and forget it; returns the sleep report and the top kept fragments, fenced as `<untrusted-data source="dreams">` with the narration rules outside the fence | none (deletes the log) |
| `endorse_dream` | `id: string`, `note?: string` | set a dream candidate's state to `endorsed`; the first endorsement resets expiry, later ones do not extend it; `note` is free text, at most 280 characters | dream state only |
| `dismiss_dream` | `id: string` | close a dream candidate | dream state only |

## Invariants (must have tests)

- `remember` never creates or modifies anything outside `episodes/`.
- `endorse_dream` and `dismiss_dream` write nothing in the vault; only the candidate's own
  state under `.circadia/dreams/` changes. Only `circadia review`, with a human at the
  keyboard, writes the accepted `related_to` fact (ADR-0011).
- `wake` deletes the log on read; a second call reports nothing left.
- `remember` derives every path with `slugify()` from server-side data (date + title).
  Caller strings never become paths.
- `recall` output always goes through `renderForContext()`, so low-trust passages are
  fenced.
- Query text is never logged. The access log gets `queryHash()`.
- Tool results carry structured metadata (`modeUsed`, `escalations`, per-hit `trust` and
  `path`) alongside the rendered text, so clients can show provenance.
