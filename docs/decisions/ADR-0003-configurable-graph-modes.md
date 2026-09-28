# ADR-0003: Configurable graph modes with per-note extraction and an auto query ladder

**Status:** accepted (2026-09-28)

## Context
Wikilinks are free and precise but sparse. Typed facts add time and relationship types at
no LLM cost. HippoRAG-style phrase graphs improve multi-hop association, but cost LLM calls
and add low-precision machine structure. The owner wants wikilinks by default and HippoRAG
for advanced topics.

## Decision
- Three modes (`wikilink` ⊂ `typed` ⊂ `hipporag`), defined as sets of edge origins.
- **Extraction** is chosen per note: frontmatter `graph:`, then the first matching
  `graph.scopes` rule (tags / paths / kinds / types), then `graph.defaultExtraction`.
- **Querying** is chosen per query: a fixed mode, or `auto`, which climbs a ladder only
  when the result looks weak. Weak means too few seeds, no hits, or a flat top-score
  margin. The ladder also skips wikilink for as-of queries and starts higher for
  multi-entity cues.
- HippoRAG triples live in `.palimpsest/triples/`, keyed by passage content hash. They are
  not stored in notes.

## Consequences
- LLM cost is confined to scoped notes.
- Every escalation is reported with a reason, so tuning is evidence-based (Phase 7).
- Triples can go stale when passages change; the indexer detects and reports this.
