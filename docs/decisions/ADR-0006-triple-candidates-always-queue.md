# ADR-0006: Triple-cache candidates always queue

**Status:** accepted (2026-09-30)

## Context

Phase 5's promotion path proposes high-confidence HippoRAG triples to consolidation as
candidate facts. A cached triple records only a `passageId` (`<noteId>#<n>`), not the
episode it came from. The previous implementation used the source *note* id as the
candidate's `episodeId`, which would make a promoted fact's `src::` point at an entity
note.

`docs/SCHEMA.md` §4.5 requires `by: agent|tool|web` facts to cite `src::` pointing at the
episode they came from, and `lint` errors otherwise. A triple has no such episode, so
promoting one would either produce a lint error or fabricate provenance — both
unacceptable for the memory-poisoning defense (ARCHITECTURE §3, SECURITY T1).

## Decision

Triple-cache candidates are marked `origin: 'triple'` and the schema-fit gate **always
queues** them, with reason `derived from triple cache`. They never auto-promote.

The source note's `by` and `trust` are still carried into the candidate so the gate can
reason about them (an untrusted triple queues as `untrusted source` before the triple
rule is even reached). A human can promote a queued triple through `circadia review`,
which is the point at which real provenance can be supplied.

## Consequences

- No promoted fact ever carries a `src::` that points at a non-episode note.
- Triple-derived knowledge still reaches the vault, but only through explicit human
  confirmation, which is the correct trust boundary for LLM-extracted content.
- The promotion path is intentionally conservative: it surfaces candidates rather than
  writing them. If a future phase gives triples real episode provenance, this ADR should
  be revisited.
