// Phase 3 consolidation core tests: C2 (write promoted facts), C3 (supersession),
// C4 (untrusted-source gate), C13 (triple candidates always queue), idempotency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONFIG_FILENAME, loadConfig, validateConfig, DEFAULT_CONFIG } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { appendFactLine } from '../src/vault/fact-write.ts';
import { buildIndex, parseVault } from '../src/index/indexer.ts';
import { writeTriples } from '../src/extract/triples.ts';
import { localDateString } from '../src/vault/time.ts';
import { shortHash } from '../src/vault/util.ts';
import type { Fact } from '../src/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-consolidation-core-'));

const CONFIG = {
  vault: { factsHeading: 'Facts', historyHeading: 'History', ignore: [] },
  index: { path: '.circadia/index.sqlite', accessLog: '.circadia/access.jsonl' },
  graph: {
    defaultExtraction: 'typed',
    scopes: [],
    query: { mode: 'auto', auto: { ladder: ['typed'], minTopMargin: 0.1, minSeeds: 2, multiEntityThreshold: 2 } },
    originWeights: { contains: 1, link: 1, fact: 1, provenance: 1, triple: 1, synonym: 1 },
    damping: 0.5,
    maxIterations: 100,
    tolerance: 0.001,
  },
  retrieval: {
    topK: 20,
    tokenBudget: 5000,
    seedLimit: 10,
    weights: { graph: 0.6, activation: 0.25, importance: 0.15 },
    actrDecay: 0.5,
    actrThresholdDays: 14,
    actrNoise: 0.3,
    trustFloor: 'low',
    includeSuperseded: false,
    logAccess: false,
  },
  embeddings: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 },
  extraction: { provider: 'http', endpoint: 'http://127.0.0.1:8080/v1/chat/completions', model: 'test', apiKeyEnv: null },
  predicates: {
    strict: false,
    defs: {
      // single: a second, different object is a contradiction
      runs_on: { object: 'entity', inverse: 'hosts', cardinality: 'single' },
      status: { object: 'literal', values: ['active', 'paused', 'archived'], cardinality: 'single' },
      // many (default): a second object is a new fact to accumulate
      depends_on: { object: 'entity', inverse: 'dependency_of' },
    },
  },
};

function makeVault(name: string, files: Record<string, string>): string {
  const v = join(tmp, name);
  mkdirSync(v, { recursive: true });
  writeFileSync(join(v, CONFIG_FILENAME), JSON.stringify(CONFIG));
  for (const [p, content] of Object.entries(files)) {
    const abs = join(v, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return v;
}

function entityNote(id: string, body: string): string {
  return `---\ntype: entity\nkind: project\n---\n# ${id}\n\n${body}`;
}

function episodeNote(by: string, text: string): string {
  return `---\ntype: episode\nstarted: 2026-09-20T10:00:00-04:00\nsource: chat\nby: ${by}\nboundary: manual\nimportance: 0.5\n---\n# Episode\n\n${text}\n`;
}

/** Replace global fetch with a canned extraction response; returns a restore fn. */
function mockFetch(candidates: unknown[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] }),
  })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function lintErrors(vault: string): string[] {
  const cfg = loadConfig(vault);
  const notes = parseVault(vault, cfg);
  const problems = [...notes.flatMap((n) => n.problems)];
  const r = buildIndex(vault, cfg, { dbPath: ':memory:' });
  problems.push(...r.problems);
  return problems.filter((p) => p.severity === 'error').map((p) => `${p.code}: ${p.message}`);
}

test('C2: promotes a known entity + known predicate and writes the exact fact line', async () => {
  const v = makeVault('c2', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
    'episodes/2026/09/2026-09-20-move.md': episodeNote('user', 'We moved x to y.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  const restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[y]]', valid: true, confidence: 0.9 }]);
  try {
    const result = await consolidate(v, cfg);
    assert.equal(result.promoted, 1);
    assert.equal(result.queued, 0);

    const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
    const today = localDateString();
    // World time opens at the episode's `started`; the id hashes that same value.
    const episodeStartMs = Date.parse('2026-09-20T10:00:00-04:00');
    const id = `f-${shortHash('x', 'runs_on', '[[y]]', episodeStartMs)}`;
    const expected = `- [runs_on:: [[y]]] [valid:: 2026-09-20..] [at:: ${today}] [by:: agent] [src:: [[2026-09-20-move]]] [trust:: high] [conf:: 0.9] ^${id}`;
    assert.ok(text.includes(expected), `expected fact line not found.\nwant: ${expected}\ngot:\n${text}`);
  } finally {
    restore();
  }

  assert.deepEqual(lintErrors(v), [], 'lint must stay clean after promotion');
});

test('C2: a resolved object renders as a wikilink, an unresolved object as a literal', async () => {
  const v = makeVault('c2-render', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
    'episodes/2026/09/2026-09-20-move.md': episodeNote('user', 'We moved x to y and also to ghost.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  const restore = mockFetch([
    { subject: 'x', predicate: 'runs_on', object: '[[y]]', valid: true, confidence: 1 },
    { subject: 'x', predicate: 'runs_on', object: '[[ghost]]', valid: true, confidence: 1 },
  ]);
  try {
    await consolidate(v, cfg);
  } finally {
    restore();
  }

  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.ok(text.includes('[runs_on:: [[y]]]'), 'resolved object should be a wikilink');
  assert.ok(text.includes('[runs_on:: ghost]'), 'unresolved object should be a literal');
});

test('C3: a user episode supersedes a contradicting fact (roadmap Phase 4 fixture)', async () => {
  const v = makeVault('c3', {
    'entities/projects/x.md': entityNote(
      'x',
      '## Facts\n- [runs_on:: [[z]]] [valid:: 2026-06-01..] [at:: 2026-06-01] [by:: user] ^f-x-old\n\n## History\n',
    ),
    'entities/tools/y.md': entityNote('y', ''),
    'entities/tools/z.md': entityNote('z', ''),
    'episodes/2026/09/2026-09-21-move.md': episodeNote('user', 'We moved x to y.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  const restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[y]]', valid: true, confidence: 0.9 }]);
  try {
    const result = await consolidate(v, cfg);
    assert.equal(result.superseded, 1);
    assert.equal(result.promoted, 0);
  } finally {
    restore();
  }

  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  const today = localDateString();
  // World time is the episode's `started` (2026-09-20T10:00:00-04:00 -> UTC 2026-09-20),
  // not the run date. `at::` and `superseded::` keep the run date.
  const episodeStart = '2026-09-20';

  // New fact in ## Facts, opening its world-time interval at the change date.
  assert.ok(
    text.includes(`[runs_on:: [[y]]] [valid:: ${episodeStart}..] [at:: ${today}] [by:: agent] [src:: [[2026-09-21-move]]] [trust:: high] [conf:: 0.9]`),
    `new fact missing or malformed:\n${text}`,
  );

  // Old fact struck through, interval closed at the change date, moved to ## History.
  const struck = `~~[runs_on:: [[z]]] [valid:: 2026-06-01..${episodeStart}]~~ [at:: 2026-06-01] [superseded:: ${today}] [by:: user] ^f-x-old`;
  assert.ok(text.includes(struck), `struck fact missing or malformed:\n${text}`);

  const historyIdx = text.indexOf('## History');
  assert.ok(historyIdx !== -1 && text.indexOf(struck) > historyIdx, 'struck fact must live under ## History');
  assert.ok(text.indexOf('[runs_on:: [[y]]]') < historyIdx, 'new fact must live under ## Facts');
});

test('C3: a many-valued predicate accumulates instead of superseding', async () => {
  const v = makeVault('c3-many', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [depends_on:: [[a]]] [by:: user]\n'),
    'entities/tools/a.md': entityNote('a', ''),
    'entities/tools/b.md': entityNote('b', ''),
    'episodes/2026/09/2026-09-25-more.md': episodeNote('user', 'x now also depends on b.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  const restore = mockFetch([{ subject: 'x', predicate: 'depends_on', object: '[[b]]', valid: true, confidence: 0.9 }]);
  try {
    const result = await consolidate(v, cfg);
    assert.equal(result.superseded, 0, 'a many predicate must not supersede');
    assert.equal(result.promoted, 1);
  } finally {
    restore();
  }

  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.ok(text.includes('[depends_on:: [[a]]]'), 'the existing fact must remain current');
  assert.ok(text.includes('[depends_on:: [[b]]]'), 'the new fact must be added');
  assert.ok(!text.includes('~~'), 'nothing should be struck through');
});

test('C4: a by: web episode queues and never promotes', async () => {
  const v = makeVault('c4-web', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
    'episodes/2026/09/2026-09-22-web.md': episodeNote('web', 'A page claims x runs on y.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  const restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[y]]', valid: true, confidence: 0.99 }]);
  try {
    const result = await consolidate(v, cfg);
    assert.equal(result.promoted, 0);
    assert.equal(result.queued, 1);
  } finally {
    restore();
  }

  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.ok(!text.includes('runs_on'), 'a web-sourced candidate must never be written as a fact');

  const pending = readFileSync(join(v, '.circadia/pending.jsonl'), 'utf8');
  assert.ok(pending.includes('untrusted source'), 'web candidate should queue as untrusted source');
});

test('C4: a triple from a low-trust note queues', async () => {
  const v = makeVault('c4-triple', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
    'episodes/2026/09/2026-09-23-web.md': episodeNote('web', 'A page claims x runs on y.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  writeTriples(v, '2026-09-23-web', [
    { passageId: '2026-09-23-web#0', contentHash: 'h', subject: 'x', predicate: 'runs_on', object: 'y', conf: 0.9 },
  ]);

  // The episode still runs extraction; return no episode candidates so only the triple
  // candidate reaches the gate.
  const restore = mockFetch([]);
  let result;
  try {
    result = await consolidate(v, cfg);
  } finally {
    restore();
  }
  assert.equal(result.promoted, 0);
  assert.equal(result.queued, 1);

  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.ok(!text.includes('runs_on'), 'a low-trust triple must never be written as a fact');
});

test('C13: a triple candidate always queues with reason "derived from triple cache"', async () => {
  const v = makeVault('c13', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  // Source note is a high-trust entity, so the untrusted rule does not fire first.
  writeTriples(v, 'x', [
    { passageId: 'x#0', contentHash: 'h', subject: 'x', predicate: 'runs_on', object: 'y', conf: 0.9 },
  ]);

  const result = await consolidate(v, cfg);
  assert.equal(result.promoted, 0);
  assert.equal(result.queued, 1);

  const pending = readFileSync(join(v, '.circadia/pending.jsonl'), 'utf8');
  // ADR-0007: the pending record is flat and versioned (no nested `candidate`).
  const decision = JSON.parse(pending.trim().split('\n').pop()!) as { v: number; reason: string; origin: string; episode: string };
  // ADR-0007: v2 (C18) adds the optional `priority` field; a field addition is a version bump.
  assert.equal(decision.v, 2);
  assert.equal(decision.reason, 'derived from triple cache');
  assert.equal(decision.origin, 'triple');
  assert.equal(decision.episode, 'x');

  // The candidate's src must never point at a note: nothing was written.
  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.ok(!text.includes('runs_on'), 'a triple candidate must never be promoted');
  assert.ok(!text.includes('src::'), 'no fact with src:: should be written for a triple candidate');
});

test('idempotency: appendFactLine does not duplicate an identical line', () => {
  const fact: Omit<Fact, 'line' | 'raw'> = {
    id: 'f-dup',
    predicate: 'runs_on',
    object: { kind: 'link', link: { target: 'y' } },
    valid: { from: null, to: null },
    recordedAt: Date.parse('2026-09-30'),
    supersededAt: null,
    by: 'agent',
    trust: 'high',
    conf: 0.9,
    src: { target: 'ep' },
    status: 'current',
    comment: null,
  };
  const raw = '---\ntype: entity\nkind: project\n---\n# x\n\n## Facts\n- [status:: active] [by:: user]\n';
  const once = appendFactLine(raw, fact, { factsHeading: 'Facts' });
  const twice = appendFactLine(once, fact, { factsHeading: 'Facts' });
  assert.equal(twice, once);
  assert.equal(once.split('\n').filter((l) => l.includes('^f-dup')).length, 1);
});

test('idempotency: re-running consolidation adds no duplicate fact line', async () => {
  const v = makeVault('idem', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
    'episodes/2026/09/2026-09-24-move.md': episodeNote('user', 'We moved x to y.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  const restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[y]]', valid: true, confidence: 0.9 }]);
  try {
    const first = await consolidate(v, cfg);
    assert.equal(first.promoted, 1);
    const second = await consolidate(v, cfg);
    assert.equal(second.promoted, 0, 'the episode is already consolidated');
  } finally {
    restore();
  }

  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  const occurrences = text.split('\n').filter((l) => l.includes('[runs_on:: [[y]]]')).length;
  assert.equal(occurrences, 1, 'the fact line must appear exactly once');
});

test('config: cardinality must be "single" or "many"', () => {
  const bad = structuredClone(DEFAULT_CONFIG);
  bad.predicates.defs = { runs_on: { cardinality: 'sometimes' as unknown as 'single' } };
  const errs = validateConfig(bad);
  assert.ok(errs.some((e) => e.includes('cardinality')), `expected a cardinality error, got: ${errs.join('; ')}`);
});
