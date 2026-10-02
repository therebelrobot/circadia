// RFC-0002 entity-anchored fact expansion (Rollout step 2). One test per acceptance
// criterion 1–7, plus the `expanded > maxInserted` assertion. Criterion 8 (flag-on eval
// reproduces the RFC's numbers) lives in test/fact-expansion-eval.test.ts. Criterion 9
// (10k-note p50 bound) is enforced by `npm run benchmark` (benchmarks/run.ts section
// [5]); the fast unit test here covers the mechanism the bound depends on — bounded
// insertions and one `edges` query per cue entity.
//
// The vault is built in a temp dir; examples/vault is never touched. `dbPath` points at
// the temp vault and `logAccess: false` keeps the access log clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CONFIG_FILENAME, DEFAULT_CONFIG, deepMerge, loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { assertExpandedWithinCap, expandFacts, recall, renderForContext } from '../src/retrieval/recall.ts';
import { handleToolsCall } from '../src/mcp/server.ts';
import type { RecallHit } from '../src/types.ts';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01

function entity(id: string, kind: string, body: string, facts: string[] = [], extra = ''): string {
  const factsBlock = facts.length > 0 ? `\n## Facts\n${facts.map((f) => `- ${f}`).join('\n')}\n` : '';
  return `---\ntype: entity\nkind: ${kind}\ncreated: 2026-01-01\n---\n# ${id}\n\n${body}\n${factsBlock}${extra}`;
}

/**
 * A vault with the shapes the criteria need:
 *   - alpha: a valid `runs_on` fact, an ended fact, a future fact, a low-trust target,
 *     and a superseded fact in History.
 *   - eta: a `link` neighbour and no facts.
 *   - theta: five valid facts.
 *   - alpha-scoped / beta-scoped: a fact that crosses a scope boundary.
 */
function makeVault(overrides: Record<string, unknown> = {}): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-fe-'));
  const cfg = deepMerge(DEFAULT_CONFIG, {
    graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'typed' } },
    predicates: { strict: false, defs: {} },
    embeddings: { provider: 'none' },
    index: { path: '.circadia/index.sqlite' },
    retrieval: { logAccess: false, factExpansion: { enabled: true, perHit: 1, maxInserted: 3 } },
    ...overrides,
  });
  writeFileSync(join(v, CONFIG_FILENAME), JSON.stringify(cfg, null, 2));
  mkdirSync(join(v, '.circadia'), { recursive: true });
  const write = (rel: string, content: string): void => {
    mkdirSync(dirname(join(v, rel)), { recursive: true });
    writeFileSync(join(v, rel), content);
  };

  // ended_on is first so a tie on the query token "on" picks it, which is what makes the
  // as-of test meaningful: at 2026-06 it must be filtered out, at 2026-01 it must win.
  write(
    'entities/alpha.md',
    entity('alpha', 'project', 'Alpha runs the orchard.', [
      '[ended_on:: [[delta]]] [valid:: 2026-01..2026-02] [by:: user]',
      '[future_on:: [[epsilon]]] [valid:: 2027-01..] [by:: user]',
      '[runs_on:: [[beta]]] [valid:: 2026-01..] [by:: user]',
      '[low_on:: [[web-note]]] [by:: user]',
    ], '\n## History\n- ~~[old_on:: [[gamma]]]~~ [superseded:: 2026-02-01] [by:: user]\n'),
  );
  write('entities/beta.md', entity('beta', 'tool', 'Beta is the host.', ['[status:: active] [by:: user]']));
  write('entities/gamma.md', entity('gamma', 'tool', 'Gamma is retired.'));
  write('entities/delta.md', entity('delta', 'tool', 'Delta is old.'));
  write('entities/epsilon.md', entity('epsilon', 'tool', 'Epsilon is future.'));
  // a low-trust episode: its prose passage is below a `medium` trust floor
  write(
    'episodes/2026/01/web-note.md',
    '---\ntype: episode\nstarted: 2026-01-01T00:00:00Z\nsource: import\nby: web\n---\n# Web note\n\nWeb note is untrusted content.\n',
  );
  // a link neighbour with no facts
  write('entities/eta.md', entity('eta', 'concept', 'Eta links to [[iota]].'));
  write('entities/iota.md', entity('iota', 'concept', 'Iota is a neighbour.'));
  // five valid facts
  write(
    'entities/theta.md',
    entity('theta', 'project', 'Theta has many facts.', [
      '[runs_on:: [[t1]]] [by:: user]',
      '[depends_on:: [[t2]]] [by:: user]',
      '[measures:: [[t3]]] [by:: user]',
      '[maintained_by:: [[t4]]] [by:: user]',
      '[status:: active] [by:: user]',
    ]),
  );
  for (const t of ['t1', 't2', 't3', 't4']) write(`entities/${t}.md`, entity(t, 'tool', `${t} is a tool.`));
  // a fact that crosses a scope boundary
  write('projects/alpha/alpha-scoped.md', entity('alpha-scoped', 'project', 'Alpha scoped runs.', ['[runs_on:: [[beta-scoped]]] [by:: user]']));
  write('projects/beta/beta-scoped.md', entity('beta-scoped', 'tool', 'Beta scoped.'));
  return v;
}

function withVault(fn: (v: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const v = makeVault();
    try {
      await fn(v);
    } finally {
      rmSync(v, { recursive: true, force: true });
    }
  };
}

const viaOf = (h: { via?: { kind: string; from: string; predicate?: string } }) => h.via;

test('criterion 1: the entity #facts passage and the fact target follow the entity hit', withVault(async (v) => {
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  const r = await recall(v, cfg, 'what does alpha run on', { logAccess: false, now: NOW });
  const ids = r.hits.map((h) => h.passageId);
  const i = ids.indexOf('alpha#0');
  assert.ok(i >= 0, 'alpha#0 is a hit');
  assert.equal(ids[i + 1], 'alpha#facts', 'the entity #facts passage comes right after the hit');
  assert.equal(ids[i + 2], 'beta#0', 'the fact target comes next');
  const facts = r.hits.find((h) => h.passageId === 'alpha#facts')!;
  const target = r.hits.find((h) => h.passageId === 'beta#0')!;
  assert.deepEqual(viaOf(facts), { kind: 'fact-expansion', from: 'alpha' }, 'the #facts passage has no predicate');
  assert.deepEqual(viaOf(target), { kind: 'fact-expansion', from: 'alpha', predicate: 'runs_on' });
  assert.equal(r.expanded, 3, 'facts + target first passage + target facts');
}));

test('criterion 2: an expired or future fact target is never inserted for an as-of query', withVault(async (v) => {
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  // 2026-06: ended_on (valid ..2026-02) and future_on (valid 2027-01..) are both invalid.
  const late = await recall(v, cfg, 'alpha on', { logAccess: false, now: NOW, asOf: Date.UTC(2026, 5, 1) });
  const lateIds = late.hits.map((h) => h.passageId);
  assert.ok(!lateIds.includes('delta#0'), 'the ended target is not inserted');
  assert.ok(!lateIds.includes('epsilon#0'), 'the future target is not inserted');
  assert.ok(lateIds.includes('beta#0'), 'the valid target is inserted');
  // 2026-01: ended_on is valid, future_on is still future.
  const early = await recall(v, cfg, 'alpha on', { logAccess: false, now: NOW, asOf: Date.UTC(2026, 0, 15) });
  const earlyIds = early.hits.map((h) => h.passageId);
  assert.ok(earlyIds.includes('delta#0'), 'the then-valid target is inserted');
  assert.ok(!earlyIds.includes('epsilon#0'), 'the future target is still not inserted');
}));

test('criterion 3: a superseded fact target is never inserted', withVault(async (v) => {
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  const r = await recall(v, cfg, 'alpha on', { logAccess: false, now: NOW });
  assert.ok(!r.hits.some((h) => h.passageId === 'gamma#0'), 'the superseded target is not inserted');
}));

test('criterion 4: a target below the trust floor is never inserted', withVault(async (v) => {
  const cfg = deepMerge(loadConfig(v), { retrieval: { trustFloor: 'medium' } });
  buildIndex(v, cfg);
  const r = await recall(v, cfg, 'what does alpha run on', { logAccess: false, now: NOW });
  assert.ok(!r.hits.some((h) => h.passageId === 'web-note#0'), 'the low-trust target is not inserted');
}));

test('criterion 4: a target outside the recall scope is never inserted', withVault(async (v) => {
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  const r = await recall(v, cfg, 'alpha scoped', { logAccess: false, now: NOW, scope: 'projects/alpha' });
  assert.ok(!r.hits.some((h) => h.passageId === 'beta-scoped#0'), 'the out-of-scope target is not inserted');
}));

test('criterion 5: only fact edges are followed (link, triple, synonym, dream are not)', withVault(async (v) => {
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  // Add non-fact edges from eta to iota directly, so the test does not depend on the
  // triple cache or a dream candidate file. Expansion must ignore all of them.
  const { db } = openIndex(join(v, cfg.index.path));
  const ins = db.prepare(
    `INSERT INTO edges (src, dst, origin, type, weight, trust, declared_in) VALUES (?, ?, ?, ?, 1, 'high', ?)`,
  );
  for (const origin of ['triple', 'synonym', 'dream']) ins.run('eta', 'iota', origin, origin, 'eta');
  db.close();
  const r = await recall(v, cfg, 'eta', { logAccess: false, now: NOW });
  assert.ok(r.hits.some((h) => h.passageId === 'eta#0'), 'eta is a hit');
  assert.ok(!r.hits.some((h) => h.via), 'no non-fact neighbour is inserted');
  assert.equal(r.expanded, 0);
}));

test('criterion 6: the per-hit and total caps hold, and no passage is duplicated', withVault(async (v) => {
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  const r = await recall(v, cfg, 'what does theta run on', { logAccess: false, now: NOW });
  assert.ok(r.expanded !== undefined && r.expanded <= cfg.retrieval.factExpansion.maxInserted, 'total cap holds');
  const targets = r.hits.filter((h) => h.via?.predicate);
  assert.ok(targets.length <= cfg.retrieval.factExpansion.perHit, 'per-hit cap holds');
  const ids = r.hits.map((h) => h.passageId);
  assert.equal(new Set(ids).size, ids.length, 'no passage is inserted twice');
}));

test('criterion 6: expanded > maxInserted is a bug (the assertion fires)', () => {
  assert.throws(() => assertExpandedWithinCap(4, 3), /over maxInserted 3/);
  assert.doesNotThrow(() => assertExpandedWithinCap(3, 3));
});

test('criterion 9 mechanism: one edges query per cue entity, at most maxInserted insertions', () => {
  // The latency bound depends on expansion doing bounded work: one small `edges`
  // query per cue entity (not per hit or per candidate) and at most `maxInserted`
  // insertions. A stub db records every prepared statement, so this proves the
  // bound without a 10k-note vault. The full p50 bound is enforced by
  // `npm run benchmark` (benchmarks/run.ts section [5]).
  const prepared: string[] = [];
  const edgesBySrc: Record<string, unknown[]> = {
    alpha: [
      {
        src: 'alpha',
        dst: 'beta',
        origin: 'fact',
        weight: 1,
        valid_from: null,
        valid_to: null,
        recorded_at: null,
        expired_at: null,
        trust: 'high',
        declared_created: null,
        predicate: 'runs_on',
      },
    ],
  };
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return { all: (src: string) => edgesBySrc[src] ?? [] };
    },
  } as unknown as DatabaseSync;

  const hit = (passageId: string, noteId: string): RecallHit => ({
    passageId,
    noteId,
    path: `${noteId}.md`,
    title: noteId,
    heading: null,
    text: '',
    score: 1,
    components: { graph: 0, activation: 0, importance: 0, seed: 0 },
    trust: 'high',
  });
  const hits = [hit('alpha#0', 'alpha'), hit('alpha#facts', 'alpha'), hit('beta#0', 'beta'), hit('beta#facts', 'beta')];
  const cfg = deepMerge(DEFAULT_CONFIG, {
    retrieval: { factExpansion: { enabled: true, perHit: 1, maxInserted: 3 } },
  });

  const r = expandFacts(db, cfg, 'typed', ['alpha'], null, NOW, 'alpha runs on', hits);
  assert.equal(r.expanded, 3, 'inserts the entity facts, the target, and the target facts');
  assert.ok(r.expanded <= cfg.retrieval.factExpansion.maxInserted, 'total cap holds');
  assert.equal(prepared.length, 1, 'one edges query per cue entity, not per hit');
});

test('criterion 7: with the flag off, recall carries no via and no expanded', withVault(async (v) => {
  const cfg = deepMerge(loadConfig(v), { retrieval: { factExpansion: { enabled: false } } });
  buildIndex(v, cfg);
  const r = await recall(v, cfg, 'what does alpha run on', { logAccess: false, now: NOW });
  assert.equal(r.expanded, undefined, 'expanded is absent when expansion is off');
  assert.ok(r.hits.every((h) => h.via === undefined), 'no hit carries via when expansion is off');
}));

test('via marking: renderForContext shows the fact edge, and the #facts passage has no predicate', withVault(async (v) => {
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  const r = await recall(v, cfg, 'what does alpha run on', { logAccess: false, now: NOW });
  const out = renderForContext(r);
  assert.match(out, /via: fact-expansion from alpha \(runs_on\)/, 'the target shows its predicate');
  assert.match(out, /via: fact-expansion from alpha_/, 'the #facts passage shows no predicate');
}));

test('the MCP recall payload carries expanded and per-hit via', withVault(async (v) => {
  const cfg = deepMerge(loadConfig(v), { mcp: { logAccess: false } });
  buildIndex(v, cfg);
  const res = await handleToolsCall(v, cfg, 'recall', { query: 'what does alpha run on' }, 1);
  const result = res.result as { expanded?: number; hits?: { passageId: string; via?: { predicate?: string } }[] };
  assert.equal(result.expanded, 3, 'the payload carries the inserted count');
  const target = result.hits?.find((h) => h.passageId === 'beta#0');
  assert.deepEqual(target?.via, { kind: 'fact-expansion', from: 'alpha', predicate: 'runs_on' });
  const facts = result.hits?.find((h) => h.passageId === 'alpha#facts');
  assert.deepEqual(facts?.via, { kind: 'fact-expansion', from: 'alpha' }, 'the #facts passage has no predicate');
}));
