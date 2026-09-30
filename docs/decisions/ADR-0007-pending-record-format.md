# ADR-0007: Versioned pending-record format

**Status:** accepted (2026-09-30)

## Context

Consolidation queues candidates it cannot auto-promote into
`.circadia/pending.jsonl`. Before this ADR, each line was a raw `GateDecision` object
(`{ action, reason, candidate: { subject, predicate, object, episodeId, … } }`). Two
problems followed:

1. **No stable identity.** Nothing distinguished one candidate from another across runs,
   so every run re-appended the same candidates (C6: run 1 → 9 lines, run 2 → 18).
2. **A nested shape that readers got wrong.** `circadia review` read `c.subject`,
   `c.predicate`, and `c.object` off the top-level object, but those fields live under
   `candidate`, so every prompt showed `undefined undefined undefined` (C9).

A rejected candidate also had nowhere to go, so it came back on the next run.

## Decision

One **versioned, flat** JSON-line record type is shared by `consolidate` (writer) and
`review` (reader/decider), defined in `src/consolidation/pending.ts`:

```jsonc
{
  "v": 1,                 // record format version
  "key": "a1b2c3d4e5",    // stable candidate key: hash(subject, predicate, object, src)
  "subject": "x",
  "predicate": "runs_on",
  "object": "[[y]]",
  "episode": "2026-09-20-move",  // src episode id (or source note id for a triple)
  "by": "user",
  "trust": "high",
  "origin": "episode",    // "episode" | "triple"
  "reason": "known entity + known predicate + no conflict",
  "queuedAt": 1759190400000      // system time (epoch ms)
}
```

- The `key` is `shortHash(subject, predicate, object, src)` over the **resolved**
  identity (subject note id, object wikilink target or literal, episode id). Resolution
  is deterministic for a given vault, so the key is stable across runs.
- `consolidate` skips a candidate whose key is already in `pending.jsonl`,
  `rejected.jsonl`, or matches a current fact in the vault.
- `review` writes a rejected record to `.circadia/rejected.jsonl`, so a rejected
  candidate does not return.
- `v` is bumped when the shape changes; readers may branch on it.

## Consequences

- Consolidation is idempotent: a second run over an unchanged vault produces no new
  pending lines and no file changes.
- `review` reads real fields instead of `undefined` (the C9 fix builds on this type).
- `rejected.jsonl` is a durable, human-readable record of what was declined and why.
- The record is flat, so a future field addition is a version bump rather than a nested
  lookup that can silently miss.
- `queuedAt` is system time (when the queue entry was written), not world time; it is
  informational and never used for ordering or dedup.
