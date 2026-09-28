# ADR-0001: The markdown vault is the source of truth; the index is derived

**Status:** accepted (2026-09-28)

## Context
The owner values observability: being able to open memory in Obsidian, read it, edit it,
and diff it in git. Graph databases and memory services (Mem0, Graphiti, Cognee, Hindsight)
keep memory in opaque stores. Pure-markdown tools (Basic Memory, mnemonic) are readable but
retrieve with shallow search. Hippocampal indexing theory offers a third shape: the store
holds content, and a separate sparse index holds pointers and associations.

## Decision
- All memory content lives in markdown files in a vault.
- `.palimpsest/index.sqlite` is fully derived. Deleting it and running
  `palimpsest index` must reproduce it.
- The only non-derivable state outside the notes is `.palimpsest/access.jsonl` (usage
  history) and `.palimpsest/triples/` (a cache of LLM output).

## Consequences
- Humans and agents edit the same files; git gives history, review, and revert for free.
- Every index feature must be expressible as a function of the vault. That rules out
  "hidden" facts that live only in the database.
- Rebuild cost grows with vault size, so incremental indexing is Phase 2.
