# Example vault

A tiny fictional vault that exercises every part of the schema:

- typed facts with world time and system time, including a superseded fact in `## History`
- an agent-inferred fact with `by:: agent` and a `src::` episode (source monitoring)
- a `by: web` episode containing a prompt-injection sample (rendered as untrusted data)
- a note tagged `deep` that the config extracts in `hipporag` mode, with cached triples
  in `.palimpsest/triples/`
- people notes scoped down to `wikilink` extraction

Try:

    palimpsest index --vault examples/vault --warnings
    palimpsest recall --vault examples/vault --no-log "where does the orchard collector run"
    palimpsest recall --vault examples/vault --no-log --as-of 2026-07 "where does the orchard collector run"
    palimpsest recall --vault examples/vault --no-log --mode hipporag "why do probes corrode"
    palimpsest recall --vault examples/vault --no-log --context "drip irrigation timing"
