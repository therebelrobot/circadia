# src/consolidation: the "sleep" job (Phase 4, contract only)

Nothing here is implemented yet. See `docs/ARCHITECTURE.md` §2, §3, and §6, and
`docs/ROADMAP.md` Phase 4.

## Pipeline

```
select episodes (consolidated: missing or older than mtime)
  → extract candidates  {subject, predicate, object, valid?, episode}   (local LLM, JSON-constrained)
  → resolve entities     id / alias / title → note, else propose new     (pattern separation)
  → schema-fit gate      promote | queue(.circadia/pending.jsonl)       (Tse et al. 2007)
  → apply                append via formatFact(); supersede conflicts bi-temporally
  → reflect              (re)write schemas/<entity>-overview.md when importance accumulates
  → mark                 set consolidated: YYYY-MM-DD on processed episodes
  → commit               one git commit per run (or print diff with --dry-run)
```

## Gate rules

| candidate | action |
|---|---|
| known entity, known predicate, no conflict | promote: `by:: agent`, `src:: [[episode]]`, `at:: today` |
| same fact already current | no-op; count as corroboration |
| new entity or unknown predicate | queue |
| contradicts a current fact | queue, unless the episode is `by: user` and explicit ("we moved X to Y"), in which case supersede |
| from a `by: web` or `by: tool` episode | **always queue**; never auto-promote |

## Invariants (must have tests)

- Never delete a fact line. Supersede with `~~…~~ [superseded:: date]` and move it to
  `## History`.
- The only episode edit allowed is setting `consolidated:`.
- Idempotent: running twice on the same vault produces no second diff.
- Human edits to `schemas/` notes win over regenerated text.
