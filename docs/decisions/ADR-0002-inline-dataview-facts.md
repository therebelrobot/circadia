# ADR-0002: Typed facts live inline in entity notes as Dataview bracketed fields

**Status:** accepted (2026-09-28)

## Context
Facts could live (a) inline in entity notes, (b) one file per fact, or (c) only in the
index. The owner chose inline for readability. The line syntax had to be:
- unambiguous for a zero-dependency parser;
- able to carry wikilinks as values;
- able to hold several fields per line;
- queryable in Obsidian.

## Decision
- One fact per list item under `## Facts` or `## History`.
- Fields use Dataview's bracketed inline-field form: `[key:: value]`.
- Exactly one non-reserved key per line is the predicate; the subject is the note itself.
- Reserved keys carry world time (`valid`), system time (`at`, `superseded`), provenance
  (`by`, `src`), `trust`, `conf`, and `id`.
- An optional trailing Obsidian block id (`^f-…`) is the stable fact id.
- Superseded facts are struck through, never deleted.

## Consequences
- Balanced brackets make parsing robust, including nested `[[wikilinks|aliases]]`.
- Dataview can query facts natively. The Tasks plugin uses the same syntax, so it is
  familiar.
- Lines are longer than a prose convention like `runs_on:: x · valid:: …`; the
  Obsidian templates and `formatFact()` offset that.
- The strict one-predicate rule keeps each line a single claim, which consolidation
  depends on.
