// RFC-0001 Stage 4: the eval fixture's dream edges and the 0-delta gate.
//
// The fixture generator copies the committed `eval/dreams.fixture.jsonl` into the
// fixture's `.circadia/dreams/candidates.jsonl`. The indexer builds `dream` edges from it;
// at the default weight 0 they change no ranking, so the Phase 7 baseline shows 0 deltas
// in hits, metrics and aggregates. These tests prove that gate and the `relate` exclusion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateFixture } from '../eval/generate-fixture.ts';
import { deepMerge, loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { relate, type RelateResult } from '../src/retrieval/relate.ts';
import { buildAblations } from '../src/eval/ablate.ts';
import { buildReport, runEval } from '../src/eval/run.ts';
import { aggregate } from '../src/eval/metrics.ts';
import { diffBaseline, readBaseline, toBaseline, type Baseline } from '../src/eval/baseline.ts';
import type { EvalAggregate, EvalQuery } from '../src/eval/types.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const BASELINE_PATH = join(EVAL_DIR, 'baseline.json');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-dreams-'));

function readQueries(): EvalQuery[] {
  return readFileSync(join(EVAL_DIR, 'queries.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

/** Run auto + each forced mode against one index build, and project to a baseline. */
async function freshBaseline(dir: string): Promise<Baseline> {
  const cfg = loadConfig(dir);
  const queries = readQueries();
  const dbPath = join(tmp, 'baseline.sqlite');
  const auto = await runEval(dir, queries, { config: cfg, dbPath });
  const report = buildReport(dir, cfg, auto);
  const modes: Record<string, EvalAggregate[]> = {};
  for (const mode of ['wikilink', 'typed', 'hipporag'] as const) {
    const modeCfg = deepMerge(cfg, { graph: { query: { mode } } });
    const results = await runEval(dir, queries, { config: modeCfg, dbPath, reuseIndex: true });
    modes[mode] = [...aggregate(results, 'kind'), ...aggregate(results, 'kind-split')];
  }
  return toBaseline(report, modes);
}

function relateShape(r: RelateResult): { found: boolean; paths: string[][] } {
  return { found: r.found, paths: r.paths.map((p) => p.nodes) };
}

test('the fixture plants one dream edge per true and decoy candidate', () => {
  const dir = join(tmp, 'vault');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'vault.sqlite');
  buildIndex(dir, cfg, { dbPath });

  const { db } = openIndex(dbPath);
  try {
    const n = (db.prepare(`SELECT count(*) AS n FROM edges WHERE origin = 'dream'`).get() as { n: number }).n;
    assert.equal(n, 32, '16 true + 16 decoy candidates');
    const truePair = db
      .prepare(`SELECT count(*) AS n FROM edges WHERE origin = 'dream' AND src = 'electrode-drift' AND dst = 'aquifer-salinity'`)
      .get() as { n: number };
    assert.equal(truePair.n, 1, 'a true remote-association pair has a dream edge');
  } finally {
    db.close();
  }
});

test('at weight 0 the committed baseline shows 0 deltas in hits, metrics and aggregates', async () => {
  const dir = join(tmp, 'baseline-vault');
  generateFixture(dir);
  const fresh = await freshBaseline(dir);
  const committed = readBaseline(BASELINE_PATH);

  const deltas = diffBaseline(committed, fresh);
  // The gate is explicit: no hit, metric, aggregate or forced-mode delta.
  const rankingDeltas = deltas.filter((d) => ['hits', 'metrics', 'aggregates', 'modes'].includes(d.field));
  assert.deepEqual(deltas, [], 'the refreshed baseline matches a fresh run');
  assert.deepEqual(rankingDeltas, [], 'dream edges at weight 0 change no ranking');
});

test('relate output is unchanged by the fixture candidates', () => {
  const withC = join(tmp, 'relate-with');
  const withoutC = join(tmp, 'relate-without');
  generateFixture(withC);
  generateFixture(withoutC);
  // Remove the candidate file from the second fixture: the only difference is dream edges.
  rmSync(join(withoutC, '.circadia', 'dreams'), { recursive: true, force: true });

  const cfgW = loadConfig(withC);
  const cfgWo = loadConfig(withoutC);
  const dbW = join(tmp, 'relate-with.sqlite');
  const dbWo = join(tmp, 'relate-without.sqlite');
  buildIndex(withC, cfgW, { dbPath: dbW });
  buildIndex(withoutC, cfgWo, { dbPath: dbWo });

  const { db: a } = openIndex(dbW);
  const { db: b } = openIndex(dbWo);
  try {
    for (const [x, y] of [
      ['electrode-drift', 'aquifer-salinity'], // a true pair
      ['electrode-drift', 'lighthouse-foghorn'], // a decoy pair
      ['pi-cluster', 'old-laptop'],
    ]) {
      assert.deepEqual(relateShape(relate(a, x, y, cfgW)), relateShape(relate(b, x, y, cfgWo)), `relate ${x} ${y}`);
    }
  } finally {
    a.close();
    b.close();
  }
});

test('the dream ablations appear in --ablate output with no eval code changes', () => {
  const names = buildAblations().map((a) => a.name);
  assert.ok(names.includes('origin:typed:dream=0'), 'typed dream ablation');
  assert.ok(names.includes('origin:hipporag:dream=0'), 'hipporag dream ablation');
  assert.ok(!names.includes('origin:wikilink:dream=0'), 'wikilink stays "links you wrote"');
});

test('a planted candidate cannot make its own pair look close', () => {
  const dir = join(tmp, 'distance');
  generateFixture(dir);
  const cfg = loadConfig(dir);
  const dbPath = join(tmp, 'distance.sqlite');
  buildIndex(dir, cfg, { dbPath });

  const { db } = openIndex(dbPath);
  try {
    const nodeToNote = new Map<string, string>();
    for (const r of db.prepare(`SELECT id, kind, note_id FROM nodes`).all() as { id: string; kind: string; note_id: string | null }[]) {
      nodeToNote.set(r.id, r.kind === 'passage' && r.note_id ? r.note_id : r.id);
    }
    const hops = (excludeDream: boolean, from: string, to: string): number => {
      const adj = new Map<string, Set<string>>();
      const add = (a: string, b: string): void => {
        if (a === b) return;
        (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
        (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
      };
      const sql = excludeDream
        ? `SELECT src, dst FROM edges WHERE dst IS NOT NULL AND origin != 'dream'`
        : `SELECT src, dst FROM edges WHERE dst IS NOT NULL`;
      for (const e of db.prepare(sql).all() as { src: string; dst: string }[]) {
        const a = nodeToNote.get(e.src);
        const b = nodeToNote.get(e.dst);
        if (a && b) add(a, b);
      }
      if (from === to) return 0;
      const seen = new Set([from]);
      let frontier = [from];
      let d = 0;
      while (frontier.length > 0) {
        d++;
        const next: string[] = [];
        for (const n of frontier) {
          for (const m of adj.get(n) ?? []) {
            if (m === to) return d;
            if (!seen.has(m)) {
              seen.add(m);
              next.push(m);
            }
          }
        }
        frontier = next;
      }
      return Infinity;
    };

    // With dream edges the planted pair is 1 hop; excluded, it is the real distance.
    assert.equal(hops(false, 'electrode-drift', 'aquifer-salinity'), 1, 'the candidate makes the pair 1 hop');
    assert.equal(hops(true, 'electrode-drift', 'aquifer-salinity'), 2, 'excluded, the 2-hop pair is 2 hops');
    assert.equal(hops(false, 'weathervane-anemometer', 'lighthouse-foghorn'), 1, 'the candidate makes the pair 1 hop');
    assert.ok(hops(true, 'weathervane-anemometer', 'lighthouse-foghorn') >= 3, 'excluded, the 3-hop pair is >= 3 hops');
  } finally {
    db.close();
  }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
