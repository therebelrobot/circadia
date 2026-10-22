# ADR-0015: Additive, weighted corroboration and entity creation

## Context

The schema-fit gate (ARCHITECTURE §3) is the memory-poisoning defense: a candidate promotes
only when its subject is a known entity, its predicate is declared, and it does not conflict
— otherwise it queues in `pending.jsonl` for `circadia review`. That is deliberately
conservative, and it is right for untrusted sources.

It has two gaps for a single operator running agents against their own vault:

1. **Corroboration is documented but not implemented.** `docs/ROADMAP.md` Phase 4 says a
   new-entity or unknown-predicate candidate needs "corroboration by a second episode or
   confirmation through `circadia review`". Only review exists; the gate queues on
   `new entity` / `unknown predicate` and never promotes from agreement.
2. **Nothing creates entities.** `resolveEntity` only looks up a note. `review` accept also
   requires the subject to resolve (`src/cli/review.ts`). So on a vault with no entity notes,
   *no path* can promote anything: the operator reviews forever and the vault never learns.
   Observed on a real vault: 20 episodes → 114 queued, 0 promoted, unpromotable by review.

The operator also stated a preference: corroboration should be **additive** — as more things
agree, the fact's strength strengthens — and **human assertions should weigh more than
automated ones**.

## Decision

Add opt-in, additive, weighted corroboration plus entity creation.

- **Support is weighted and graded.** `SOURCE_WEIGHT` (`src/vault/facts.ts`): `user`/`import`
  = 2, `agent` = 1, `tool`/`web` = 0. Support is the sum over *distinct episodes* asserting
  the same resolved claim, counted across the pending queue and the current run.
- **Promotion.** A claim that would queue only for a new entity or unknown predicate promotes
  once support reaches `consolidation.corroborationMinSupport` (default 2). One human episode
  clears it alone; an agent needs two.
- **Confidence curves with support.** `conf:: = min(1, 0.5 + 0.25·(support − 1))` at
  promotion, and an already-current fact is **strengthened** by `0.125 × weight` as each new
  independent episode agrees. `conf` is the fact-edge weight and the reflection importance
  sum, so this is behavioral, not cosmetic.
- **Entity creation.** `deriveEntityNote` writes `entities/<slug>.md` (id = file stem, so it
  is tier-0 resolvable next run) when a corroborated promotion — or a `review` accept — is
  about a subject the vault has not seen.
- **Firewalls preserved.** The C4 gate (untrusted sources), the contradiction path, and
  `rejected.jsonl` all run/return *before* corroboration, so agreement can never launder an
  untrusted claim, suppress a conflict, or resurrect a human rejection.
- **Default off.** `consolidation.corroboration` is `false`. A vault opts in; the
  `retrieval.factExpansion` pattern (flag → measure → flip) is available for a later default.

## Consequences

- A cold vault can now accrete entities and facts from the nightly sleep, and a reviewed
  candidate can always be accepted (the reviewer authorizes creating the entity).
- The poisoning defense is loosened *only* for non-untrusted sources, and only by agreement
  count. An attacker who controls an agent can still only promote a claim another independent
  episode also made, and cannot move `conf` past 1 or touch contradictions.
- Strengthening rewrites one fact line (`conf::`) via `replaceLine`, reserialized with
  `formatFact`. The claim and every other byte are preserved; a hand-added non-canonical
  formatting on that line would be normalized.
- A new config section (`consolidation.*`), documented in CONFIG.md.

## Status

Accepted. Implemented behind `consolidation.corroboration` (default `false`); see issue #14.
