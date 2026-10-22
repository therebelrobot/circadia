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
//
// Kinds generated: `single-hop` (per entity), `multi-hop` (per link fact, plus 2-hop chains),
// `temporal` (any fact with a `valid.from`, `as_of` at the start), `preference` (a
// `prefer*` predicate). `trust` and explicit `expect_absent` checks are NOT generated — they
// need the evaluator's judgement, not a derivation.

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

/** Natural phrasings per predicate; `{s}` is the subject id. Mechanical fallback otherwise. */
const PHRASES: Record<string, string[]> = {
  runs_on: ['{s} run on', 'where does {s} run'],
  related_to: ['{s} related to', 'what is {s} related to'],
  part_of: ['{s} part of', 'what is {s} part of'],
  depends_on: ['{s} depend on', 'what does {s} depend on'],
  uses: ['{s} use', 'what does {s} use'],
  contains: ['{s} contain'],
  maintained_by: ['{s} maintainer', 'who maintains {s}'],
};

function phrasesFor(subject: string, predicate: string): string[] {
  const spaced = `${subject} ${predicate.replace(/_/g, ' ')}`;
  const templated = (PHRASES[predicate] ?? []).map((t) => t.replace('{s}', subject));
  return [...new Set([spaced, ...templated])];
}

/** Derive a query set from the vault. Only passage ids that exist are used. */
export function generatePersonalQueries(vault: string, cfg: Config): EvalQuery[] {
  const notes = parseVault(vault, cfg);
  const noteIds = new Set(notes.map((n) => n.id));
  const passageIds = new Set(notes.flatMap((n) => n.passages.map((p) => p.id)));
  const exists = (id: string): boolean => passageIds.has(id);

  const out: EvalQuery[] = [];
  const push = (q: EvalQuery): void => {
    out.push(q);
  };

  // Adjacency over current link facts, for 2-hop chain queries.
  const adj = new Map<string, { predicate: string; target: string }[]>();

  for (const n of notes) {
    if (n.type !== 'entity') continue;

    // single-hop: the note itself.
    if (exists(`${n.id}#0`)) {
      push({ id: `gen-sh-${n.id}`, query: n.id, kind: 'single-hop', expected_passages: [`${n.id}#0`], split: splitFor(`sh-${n.id}`) });
    }

    for (const f of n.facts) {
      if (f.status !== 'current') continue;
      const pred = f.predicate;
      const isLink = f.object.kind === 'link' && noteIds.has(f.object.link.target);
      const obj = f.object.kind === 'link' ? f.object.link.target : null;

      // Gold for this fact: the object's first passage (if it is a note) and/or the
      // subject's facts passage, whichever exist.
      const gold = [...(obj && exists(`${obj}#0`) ? [`${obj}#0`] : []), ...(exists(`${n.id}#facts`) ? [`${n.id}#facts`] : [])];
      if (gold.length === 0) continue;

      if (isLink && obj) {
        const list = adj.get(n.id) ?? [];
        list.push({ predicate: pred, target: obj });
        adj.set(n.id, list);

        // multi-hop: paraphrase variants, all gold = the object + subject facts.
        const phrases = phrasesFor(n.id, pred);
        phrases.forEach((query, i) => {
          push({
            id: i === 0 ? `gen-mh-${n.id}-${pred}` : `gen-mh-${n.id}-${pred}-${i}`,
            query,
            kind: 'multi-hop',
            expected_passages: [gold],
            split: splitFor(`mh-${n.id}-${pred}-${i}`),
          });
        });
      } else if (/^prefer/.test(pred)) {
        // preference: a `prefer*` predicate, answered by the subject's facts passage.
        push({ id: `gen-pref-${n.id}-${pred}`, query: `${n.id} ${pred.replace(/_/g, ' ')}`, kind: 'preference', expected_passages: [`${n.id}#facts`], split: splitFor(`pref-${n.id}-${pred}`) });
      }

      // temporal: any fact with a world-time start (open or closed interval).
      if (f.valid.from !== null) {
        push({
          id: `gen-t-${n.id}-${pred}`,
          query: phrasesFor(n.id, pred)[0],
          kind: 'temporal',
          as_of: isoDate(f.valid.from),
          expected_passages: [gold],
          split: splitFor(`t-${n.id}-${pred}`),
        });
      }
    }
  }

  // 2-hop chains: x -> y -> z, asked about x, gold = z's passage (and y's facts). Capped, so
  // a densely linked vault does not explode the set.
  const CHAIN_CAP_PER_SOURCE = 3;
  for (const [x, first] of adj) {
    let perSource = 0;
    for (const { predicate: p1, target: y } of first) {
      for (const { predicate: p2, target: z } of adj.get(y) ?? []) {
        if (z === x || perSource >= CHAIN_CAP_PER_SOURCE) continue;
        const gold = [...(exists(`${z}#0`) ? [`${z}#0`] : []), ...(exists(`${y}#facts`) ? [`${y}#facts`] : [])];
        if (gold.length === 0) continue;
        push({
          id: `gen-chain-${x}-${y}-${p2}`,
          query: `${x} ${p1.replace(/_/g, ' ')} ${y} ${p2.replace(/_/g, ' ')}`,
          kind: 'multi-hop',
          expected_passages: [gold],
          split: splitFor(`chain-${x}-${y}-${p2}`),
        });
        perSource++;
      }
    }
  }

  return out;
}
