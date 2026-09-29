// Synthetic vault generator for benchmarks.
// Usage: node --experimental-strip-types benchmarks/generate-vault.ts <outDir> [--notes N] [--links L]
//
// Writes N entity notes (default 10,000) with a total of L wikilinks
// (default 50,000) distributed round-robin. Notes carry valid frontmatter so
// they parse cleanly at the default `typed` extraction mode. Deterministic
// (fixed PRNG seed) so benchmark runs are comparable.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GenOptions {
  notes: number;
  links: number;
}

/** Small deterministic PRNG (LCG) so generated vaults are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function generateVault(outDir: string, opts: GenOptions): void {
  const { notes, links } = opts;
  const rand = makeRng(42);
  const id = (i: number) => `note-${String(i).padStart(5, '0')}`;

  mkdirSync(join(outDir, 'entities'), { recursive: true });
  writeFileSync(
    join(outDir, 'circadia.config.json'),
    JSON.stringify(
      {
        graph: { defaultExtraction: 'typed' },
        predicates: { strict: false, defs: { related_to: { object: 'entity' } } },
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
    writeFileSync(
      join(outDir, 'entities', `${id(i)}.md`),
      `---\ntype: entity\nkind: concept\ncreated: 2026-01-01\n---\n# ${id(i)}\n\n${prose}\n`,
    );
  }
}

if (process.argv[1] && process.argv[1].endsWith('generate-vault.ts')) {
  const argv = process.argv.slice(2);
  const outDir = argv[0];
  if (!outDir) {
    console.error('usage: generate-vault.ts <outDir> [--notes N] [--links L]');
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
  generateVault(outDir, { notes: num('--notes', 10_000), links: num('--links', 50_000) });
  console.log(`generated vault at ${outDir}`);
}
