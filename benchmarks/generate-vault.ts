// Synthetic vault generator for benchmarks.
// Usage: node --experimental-strip-types benchmarks/generate-vault.ts <outDir> [--notes N] [--links L] [--facts F]
//
// Writes N entity notes (default 10,000) with a total of L wikilinks
// (default 50,000) distributed round-robin, plus F facts per note (default 0).
// Facts are opt-in: the default vault has no facts and no `fact` edges, which
// keeps docs/PERFORMANCE.md comparable with its pre-facts history. Pass
// `--facts 3` for the shape RFC-0002 criterion 9 measures. Notes carry valid
// frontmatter so they parse cleanly at the default `typed` extraction mode.
// Deterministic (fixed PRNG seeds) so benchmark runs are comparable; facts use
// a separate seed, so adding facts does not move the wikilink targets.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeRng } from '../src/util/rng.ts';

export interface GenOptions {
  notes: number;
  links: number;
  /**
   * Facts per note. Opt-in: the default is 0, so the generated vault has no
   * facts and no `fact` edges (the pre-facts shape). RFC-0002 criterion 9
   * measures a vault with three facts per note, so pass 3 explicitly. Facts use
   * their own PRNG seed, so changing this does not move the wikilink targets.
   */
  factsPerNote?: number;
}

/** Predicates cycled across a note's facts. All take an entity object. */
const FACT_PREDICATES = ['runs_on', 'depends_on', 'measures'] as const;

export function generateVault(outDir: string, opts: GenOptions): void {
  const { notes, links } = opts;
  const factsPerNote = opts.factsPerNote ?? 0;
  const rand = makeRng(42);
  const factRand = makeRng(1337);
  const id = (i: number) => `note-${String(i).padStart(5, '0')}`;

  mkdirSync(join(outDir, 'entities'), { recursive: true });
  writeFileSync(
    join(outDir, 'circadia.config.json'),
    JSON.stringify(
      {
        graph: { defaultExtraction: 'typed' },
        predicates: {
          strict: false,
          defs: {
            related_to: { object: 'entity' },
            runs_on: { object: 'entity' },
            depends_on: { object: 'entity' },
            measures: { object: 'entity' },
          },
        },
      },
      null,
      2,
    ) + '\n',
  );

  // distribute links: each note gets floor(links/notes), the remainder get one extra
  const base = Math.floor(links / notes);
  const extra = links % notes;
  for (let i = 0; i < notes; i++) {
    const n = base + (i < extra ? 1 : 0);
    const targets: string[] = [];
    for (let j = 0; j < n; j++) {
      let t = Math.floor(rand() * notes);
      if (t === i) t = (t + 1) % notes; // no self-links
      targets.push(id(t));
    }
    const prose = `Some prose about topic ${i} and its measurements. ${targets.map((t) => `[[${t}]]`).join(' ')}`;
    const facts: string[] = [];
    for (let j = 0; j < factsPerNote; j++) {
      let t = Math.floor(factRand() * notes);
      if (t === i) t = (t + 1) % notes; // no self-facts
      facts.push(`- [${FACT_PREDICATES[j % FACT_PREDICATES.length]}:: [[${id(t)}]]] [by:: user]`);
    }
    const factsBlock = facts.length > 0 ? `\n## Facts\n${facts.join('\n')}\n` : '';
    writeFileSync(
      join(outDir, 'entities', `${id(i)}.md`),
      `---\ntype: entity\nkind: concept\ncreated: 2026-01-01\n---\n# ${id(i)}\n\n${prose}\n${factsBlock}`,
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith('generate-vault.ts')) {
  const argv = process.argv.slice(2);
  const outDir = argv[0];
  if (!outDir) {
    console.error('usage: generate-vault.ts <outDir> [--notes N] [--links L] [--facts F]');
    process.exit(1);
  }
  const num = (flag: string, dflt: number): number => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
  };
  if (existsSync(outDir)) {
    console.error(`refusing to generate into existing dir ${outDir}`);
    process.exit(1);
  }
  generateVault(outDir, {
    notes: num('--notes', 10_000),
    links: num('--links', 50_000),
    factsPerNote: num('--facts', 0),
  });
  console.log(`generated vault at ${outDir}`);
}
