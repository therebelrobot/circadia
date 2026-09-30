# Security model

Circadia stores personal memory and feeds it back into LLM context windows. The two
things that can go wrong are **someone else reading or writing your memory**, and **your
memory telling your model to do something it shouldn't**. This document covers both and
records the defaults that address them.

It draws on security audits of comparable memory systems: Hindsight, librechat-mnemonic,
and the memory MCP servers with published CVEs listed in `SOURCES.md`. The recurring
failures there were unauthenticated services bound to `0.0.0.0`, automatic memory
extraction acting as a persistent prompt-injection channel, recall scoped across trust
domains by default, and path traversal in import tools.

## Threats and controls

### T1: Memory poisoning, meaning persistent prompt injection

Hostile text in a web page, tool output, or pasted document gets condensed into memory and
re-injected into later sessions as trusted context.

Controls (✔ = implemented in Phase 1, ◻ = planned):

- ✔ **Source monitoring on every fact.** `by::` and `src::` are recorded, and
  `by: agent|tool|web` facts without `src::` are lint errors.
- ✔ **Trust labels.** Episodes inherit trust from `by`; a facts passage takes the lowest
  trust among its current facts.
- ✔ **Fencing.** `renderForContext()` wraps `trust: low` passages in `<untrusted-data>`
  and escapes any attempt to close the fence early. Tested.
- ✔ **Trust floor.** `retrieval.trustFloor: "medium"` removes low-trust content from
  recall entirely.
- ◻ **Agents can't write facts** (Phase 3). The MCP `remember` tool writes episodes only.
- ◻ **Schema-fit gate** (Phase 4). Novel or contradicting facts need corroboration or user
  confirmation before promotion.
- ◻ **Consolidation diff review** (Phase 4). Each run is a single git commit, so you can
  review or revert everything "sleep" changed.
- ✔ **Dream firewall** (Phase 8). The REM pass writes only under `.circadia/dreams/`; the
  only route into the vault is a human accept in `circadia review`. The MCP `wake`,
  `endorse_dream` and `dismiss_dream` tools change dream state only and write nothing in
  the vault. Dream output is fenced as `<untrusted-data source="dreams">` with the
  narration rules outside the fence, and a model `gist` over 200 characters is pruned.

### T2: Unauthorized access to the memory service

Controls, required for Phase 3 and later; the defaults here are non-negotiable:

- **stdio transport first.** The first MCP server speaks only stdio, so it has no network
  surface.
- If HTTP is added:
  - bind `127.0.0.1` by default;
  - **require a bearer token**, and refuse to start without one;
  - use one auth path for *all* transports. Hindsight's MCP auth could be disabled
    independently of its HTTP auth; don't allow that;
  - send no CORS headers by default;
  - never use `allow_origins=*` with credentials. mcp-memory-service CVE-2026-33010 did
    exactly this.
- Every route checks auth, including document and import routes. mcp-memory-service
  CVE-2026-50027 left `/api/documents/*` unauthenticated even with an API key configured.
- Mutating tools need a write scope, not a read scope. See mcp-memory-service
  CVE-2026-49291.

### T3: Path traversal and file access

- ✔ The walker only reads `*.md` under the vault root and skips dot-folders and `_meta/`.
- ◻ Any tool that takes a path or name from a caller (import, export, note creation) must:
  - resolve the path;
  - reject it unless it stays inside the vault;
  - reject absolute paths, `..`, and NUL.
  mcp-memory-keeper CVE-2026-54561 was an arbitrary file read through an import `filePath`.
- ◻ Note ids created by agents go through `slugify()`. Caller strings never become paths
  directly.

### T4: Cross-domain leakage

- One vault is one trust domain. There are no per-user ACLs, and adding them would be a
  separate design with its own review.
- ◻ Phase 3: an optional `scope` on `recall` that restricts seeds and traversal to a path
  prefix or tag, for keeping projects apart within one vault.

### T5: Data leaving the machine

- ✔ **No telemetry of any kind.** Adding any is a policy change needing an ADR.
- ✔ **Queries are never logged in plaintext.** The access log stores a 12-hex-character
  hash.
- ✔ The embedding and extraction defaults point at local llama.cpp (`127.0.0.1`).
- Hosted providers are opt-in per config, with the key read from an env var named in
  config, never stored in config.
- Dream proposals use the configured `extraction` endpoint, a local model by default. A
  hosted endpoint carries passage text off the machine; `docs/CONFIG.md` says so next to
  the key.
- Use a **spend-capped** key: an OpenRouter key with a per-key `limit` and `limit_reset`.
  Note that a hosted provider receives the text of passages sent for embedding or
  extraction.

### T6: Supply chain

- ✔ **Zero runtime dependencies.**
- Dev dependencies are limited to `typescript`, `@types/node`, and
  `@modelcontextprotocol/sdk` (dev-only, never shipped; see ADR-0008).
- ◻ If published, publish via GitHub Actions OIDC with SLSA provenance
  (`actions/attest-build-provenance` or `npm --provenance`). Pin actions by SHA, enable
  Dependabot for `github-actions`, and verify with `gh attestation verify`.

## Reporting

Until a public repo exists, report issues to the owner directly. When published, add a
`SECURITY.md` with a GitHub Security Advisory contact.
