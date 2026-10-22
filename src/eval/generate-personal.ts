// Generate a personal eval query set from a vault's own typed facts (#21).
//
// The eval harness needs gold passages, and hand-authoring them is unreasonable for an
// operator — which made every personal measurement (including RFC-0002 step 3) effectively
// impossible. A vault with typed facts already encodes `(subject, predicate, object, valid?)`,
// which is enough to derive a faithful set.
//
// This is a REGRESSION set: it asks whether recall resurfaces the vault's own assertions. It
// is circular by construction and is NOT an answer-quality eval — see docs/EVAL.md. That is
// exactly what step 3 needs (does fact expansion find the fact?).

import type { Config } from '../config.ts';
import { parseVault } from '../index/indexer.ts';
import { shortHash } from '../vault/util.ts';
import type { EvalQuery } from './types.ts';

/** Deterministic dev/holdout split: ~1 in 4 to holdout, stable across runs. */
function splitFor(seed: string): 'dev' | 'holdout' {
  return Number.parseInt(shortHash(seed).slice(0, 8), 16) % 4 === 0 ? 'holdout' : 'dev';
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Derive a query set from the vault. Only passage ids that exist are used, so the result
 * passes `circadia eval` without `--allow-missing`.
 */
export function generatePersonalQueries(vault: string, cfg: Config): EvalQuery[] {
  const notes = parseVault(vault, cfg);
  const noteIds = new Set(notes.map((n) => n.id));
  const passageIds = new Set(notes.flatMap((n) => n.passages.map((p) => p.id)));
  const exists = (id: string): boolean => passageIds.has(id);

  const out: EvalQuery[] = [];
  for (const n of notes) {
    if (n.type !== 'entity') continue;

    // single-hop: the note itself.
    if (exists(`${n.id}#0`)) {
      out.push({
        id: `gen-sh-${n.id}`,
        query: n.id,
        kind: 'single-hop',
        expected_passages: [`${n.id}#0`],
        split: splitFor(`sh-${n.id}`),
      });
    }

    for (const f of n.facts) {
      if (f.status !== 'current' || f.object.kind !== 'link') continue;
      const obj = f.object.link.target;
      if (!noteIds.has(obj)) continue;

      // Gold: the object's first passage and/or the subject's facts passage, whichever exist.
      const gold = [`${obj}#0`, `${n.id}#facts`].filter(exists);
      if (gold.length === 0) continue;

      const phrase = `${n.id} ${f.predicate.replace(/_/g, ' ')}`;
      out.push({
        id: `gen-mh-${n.id}-${f.predicate}`,
        query: phrase,
        kind: 'multi-hop',
        expected_passages: [gold],
        split: splitFor(`mh-${n.id}-${f.predicate}`),
      });

      if (f.valid.from !== null && f.valid.to !== null) {
        out.push({
          id: `gen-t-${n.id}-${f.predicate}`,
          query: phrase,
          kind: 'temporal',
          as_of: isoDate(f.valid.from),
          expected_passages: [gold],
          split: splitFor(`t-${n.id}-${f.predicate}`),
        });
      }
    }
  }
  return out;
}
