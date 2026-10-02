// Benchmark: synthetic vault -> full index -> incremental index (10 notes,
// 1 note) -> recall latency p50/p95 per mode -> peak RSS.
// Usage: npm run benchmark [-- --notes N --links L --queries Q --facts F]
//
// Facts are opt-in and default to 0, so the default vault has no facts and no
// `fact` edges (the pre-facts shape docs/PERFORMANCE.md is comparable with).
// RFC-0002 criterion 9 needs facts, so run it as `npm run benchmark -- --facts 3`.
//
// The single-note incremental time is the roadmap acceptance criterion:
// "editing one note reindexes in under 200 ms on a 10k-note vault".

import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepMerge, loadConfig } from '../src/config.ts';
import { buildIndex, incrementalIndex } from '../src/index/indexer.ts';
import { recall } from '../src/retrieval/recall.ts';
import { generateVault } from './generate-vault.ts';

const argv = process.argv.slice(2);
const num = (flag: string, dflt: number): number => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const NOTES = num('--notes', 10_000);
const LINKS = num('--links', 50_000);
const QUERIES = num('--queries', 100);
const FACTS = num('--facts', 0);

const tmp = mkdtempSync(join(tmpdir(), 'circadia-bench-'));
const vault = join(tmp, 'vault');
const dbPath = join(vault, '.circadia', 'index.sqlite');

const rss = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);
let peakRss = rss();
const bump = (): void => {
  peakRss = Math.max(peakRss, rss());
};

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

console.log(`circadia benchmark: ${NOTES} notes, ${LINKS} links, ${FACTS} facts/note, ${QUERIES} queries/mode`);
console.log(`machine: ${process.platform} ${process.arch}, node ${process.version}`);
bump();

// 1. generate + full index
const tGen = performance.now();
generateVault(vault, { notes: NOTES, links: LINKS, factsPerNote: FACTS });
const genMs = performance.now() - tGen;
bump();

const t0 = performance.now();
const full = buildIndex(vault, loadConfig(vault), { dbPath });
const fullMs = performance.now() - t0;
bump();
console.log(`\n[1] vault generated in ${Math.round(genMs)} ms`);
console.log(`    full index: ${Math.round(fullMs)} ms (${full.stats.notes} notes, ${full.stats.passages} passages, ${Object.values(full.stats.edges).reduce((a, b) => a + b, 0)} edges, keyword: ${full.stats.fts ? 'fts5' : 'bm25-js'})`);

// 2. modify 10 notes -> incremental
const cfg = loadConfig(vault);
const noteFiles = readdirSync(join(vault, 'entities')).sort();
const modify = (file: string, tag: string): void => {
  const p = join(vault, 'entities', file);
  writeFileSync(p, readFileSync(p, 'utf8') + `\nEdited ${tag} for the benchmark.\n`);
};
for (let i = 0; i < 10; i++) modify(noteFiles[i], `batch-${i}`);
const t1 = performance.now();
const inc10 = incrementalIndex(vault, cfg, { dbPath });
const inc10Ms = performance.now() - t1;
bump();
console.log(`\n[2] incremental, 10 changed notes: ${Math.round(inc10Ms)} ms (changed=${inc10.stats.changed})`);

// 3. modify 1 note -> incremental (roadmap acceptance: < 200 ms)
modify(noteFiles[10], 'single');
const t2 = performance.now();
const inc1 = incrementalIndex(vault, cfg, { dbPath });
const inc1Ms = performance.now() - t2;
bump();
const pass = inc1Ms < 200 ? 'PASS' : 'FAIL';
console.log(`\n[3] incremental, 1 changed note: ${inc1Ms.toFixed(1)} ms (changed=${inc1.stats.changed}) — acceptance < 200 ms: ${pass}`);

// 4. recall latency per mode: random queries that hit a real passage
const queries: string[] = [];
for (let i = 0; i < QUERIES; i++) {
  const n = Math.floor((i * 7919) % NOTES); // deterministic spread
  queries.push(`topic ${n} measurements`);
}
const recallStats: Record<string, { p50: number; p95: number; max: number }> = {};
for (const mode of ['wikilink', 'typed'] as const) {
  const times: number[] = [];
  for (const q of queries) {
    const t = performance.now();
    recall(vault, cfg, q, { dbPath, mode, logAccess: false });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  bump();
  recallStats[mode] = { p50: percentile(times, 50), p95: percentile(times, 95), max: times[times.length - 1] };
  console.log(`\n[4] recall ${mode}: p50 ${recallStats[mode].p50.toFixed(1)} ms, p95 ${recallStats[mode].p95.toFixed(1)} ms, max ${recallStats[mode].max.toFixed(1)} ms`);
}

// 5. RFC-0002 criterion 9: 40 entity-cued queries, typed mode. p50 with fact
// expansion on must be no more than 10% above expansion off. Each query names a
// note, so the cue-entity path fires; this needs facts, so run the benchmark
// with `--facts 3` (the vault has three facts per note). Unlike section [4],
// recall is awaited here, so the timing covers the whole call.
const ENTITY_QUERIES = 40;
const entityQueries: string[] = [];
for (let i = 0; i < ENTITY_QUERIES; i++) {
  const n = Math.floor((i * 7919) % NOTES); // deterministic spread
  entityQueries.push(`note-${String(n).padStart(5, '0')}`);
}
const cfgOn = deepMerge(cfg, { retrieval: { factExpansion: { enabled: true } } });
// Warm the index/page cache so the first measured query is not a cold-start outlier.
await recall(vault, cfg, entityQueries[0], { dbPath, mode: 'typed', logAccess: false });
// Interleave off/on per query so both see the same cache state. A sequential
// off-then-on pass would let warmup mask a real regression.
const timesOff: number[] = [];
const timesOn: number[] = [];
let entityFired = 0;
for (const q of entityQueries) {
  const tOff = performance.now();
  await recall(vault, cfg, q, { dbPath, mode: 'typed', logAccess: false });
  timesOff.push(performance.now() - tOff);
  const tOn = performance.now();
  const r = await recall(vault, cfgOn, q, { dbPath, mode: 'typed', logAccess: false });
  timesOn.push(performance.now() - tOn);
  if (r.expanded && r.expanded > 0) entityFired++;
}
timesOff.sort((a, b) => a - b);
timesOn.sort((a, b) => a - b);
bump();
const p50Off = percentile(timesOff, 50);
const p50On = percentile(timesOn, 50);
const entityRatio = p50Off > 0 ? p50On / p50Off : 1;
const perfPass = entityRatio <= 1.1;
console.log(
  `\n[5] RFC-0002 criterion 9: entity-cued p50 typed — off ${p50Off.toFixed(1)} ms, on ${p50On.toFixed(1)} ms (ratio ${entityRatio.toFixed(3)}), expansion fired on ${entityFired}/${ENTITY_QUERIES} — bound <= 1.10: ${perfPass ? 'PASS' : 'FAIL'}`,
);

console.log(`\npeak RSS: ${peakRss} MB`);
console.log('\nsummary');
console.log('  metric                              value');
console.log('  ------------------------------------  ----------------');
console.log(`  full index (${NOTES} notes)          ${Math.round(fullMs)} ms`);
console.log(`  incremental (10 notes)              ${Math.round(inc10Ms)} ms`);
console.log(`  incremental (1 note)                ${inc1Ms.toFixed(1)} ms  (acceptance < 200 ms: ${pass})`);
console.log(`  recall wikilink p50 / p95           ${recallStats.wikilink.p50.toFixed(1)} / ${recallStats.wikilink.p95.toFixed(1)} ms`);
console.log(`  recall typed p50 / p95              ${recallStats.typed.p50.toFixed(1)} / ${recallStats.typed.p95.toFixed(1)} ms`);
console.log(`  entity-cued p50 off / on            ${p50Off.toFixed(1)} / ${p50On.toFixed(1)} ms  (criterion 9 <= 1.10x: ${perfPass ? 'PASS' : 'FAIL'})`);
console.log(`  peak RSS                            ${peakRss} MB`);

// Criterion 9 is a hard bound: `npm run benchmark` exits non-zero when it fails.
if (!perfPass) process.exitCode = 1;

rmSync(tmp, { recursive: true, force: true });
