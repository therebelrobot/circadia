# ADR-0004: Zero runtime dependencies on Node's built-in SQLite and type stripping

**Status:** accepted (2026-09-28)

## Context
Owner preferences: zero dependencies first, Node built-ins, TypeScript with `.ts`
imports, no build step, and Raspberry Pi as a deployment target. The supply-chain risk
from memory-tool dependency trees was a recurring theme in prior audits.

## Decision
- Storage: `node:sqlite` (Node ≥ 22.5; we require ≥ 22.18 for default type stripping).
- Code runs directly with Node's type stripping, so it uses erasable TypeScript syntax
  only.
- Keyword search uses FTS5 when the SQLite build has it, and an in-process BM25
  otherwise.
- No graph database. PageRank and traversal run in memory in plain TypeScript.
- Only `typescript` and `@types/node` as dev dependencies, for typechecking.

## Consequences
- `npm install` has nothing to audit at runtime.
- Performance ceiling: roughly 10⁵ passages and 10⁶ edges before a native index or graph
  store is worth revisiting. Benchmark in Phase 2.
- An MCP SDK would be a dependency; Phase 3 implements JSON-RPC stdio by hand unless an
  ADR argues otherwise.
