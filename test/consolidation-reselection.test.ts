// C22: episode re-selection is content-based, not mtime-based.
//
// A vault copy, `git clone`/`checkout`, rsync, or restore moves file mtimes without changing
// content. An mtime rule re-selects every episode, re-extracts it (LLM cost), and — because
// an old episode can contradict a newer fact — silently reverts memory to a stale value.
// These tests pin the two required outcomes:
//   1. touch + consolidate leaves the current fact and the lint results unchanged;
//   2. a late-arriving older episode queues instead of superseding a newer fact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { buildIndex, parseVault } from '../src/index/indexer.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-c22-'));

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
      runs_on: { object: 'entity', inverse: 'hosts', cardinality: 'single' },
      status: { object: 'literal', values: ['active', 'paused', 'archived'], cardinality: 'single' },
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

function episodeNote(by: string, started: string, text: string): string {
  return `---\ntype: episode\nstarted: ${started}\nsource: chat\nby: ${by}\nboundary: manual\nimportance: 0.5\n---\n# Episode\n\n${text}\n`;
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

/** Move every markdown file's mtime, as a vault copy/checkout/restore would. */
function touchAll(vault: string, when: Date): void {
  for (const rel of readdirSync(vault, { recursive: true, encoding: 'utf8' }) as string[]) {
    if (!rel.endsWith('.md')) continue;
    utimesSync(join(vault, rel), when, when);
  }
}

test('C22: a touched episode is not re-selected; an edited one is', async () => {
  const v = makeVault('hash', {
    'episodes/2026/09/2026-09-16-note.md': episodeNote('user', '2026-09-16T10:00:00-04:00', 'First body.'),
  });
  const cfg = loadConfig(v);
  const epPath = join(v, 'episodes/2026/09/2026-09-16-note.md');
  const rel = 'episodes/2026/09/2026-09-16-note.md';

  // No candidates are needed here; the mock keeps the extraction call off the network.
  const restore = mockFetch([]);
  try {
    const first = await consolidate(v, cfg);
    assert.ok(first.processedEpisodes.includes(rel), 'the first run selects the episode');

    // A copy moves the mtime but not the content.
    const later = new Date(2026, 9, 15, 12, 0, 0);
    utimesSync(epPath, later, later);
    const second = await consolidate(v, cfg);
    assert.deepEqual(second.processedEpisodes, [], 'a touch must not re-select the episode');

    // A real body edit (frontmatter, including `consolidated:`, is preserved).
    const afterFirst = readFileSync(epPath, 'utf8');
    writeFileSync(epPath, afterFirst.replace('First body.', 'Corrected body.'));
    const third = await consolidate(v, cfg);
    assert.ok(third.processedEpisodes.includes(rel), 'a body edit must re-select the episode');
  } finally {
    restore();
  }
});

test('C22: a vault copy does not re-select episodes or revert a superseded fact', async () => {
  const v = makeVault('copy', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/old-laptop.md': entityNote('old-laptop', ''),
    'entities/tools/mqtt-broker.md': entityNote('mqtt-broker', ''),
    'episodes/2026/09/2026-09-10-move.md': episodeNote('user', '2026-09-10T10:00:00-04:00', 'We moved the collector to the old laptop.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  // Run 1: the Sep 10 episode promotes runs_on [[old-laptop]].
  let restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[old-laptop]]', valid: true, confidence: 0.9 }]);
  try {
    const r1 = await consolidate(v, cfg);
    assert.equal(r1.promoted, 1);
  } finally {
    restore();
  }

  // Run 2: a Sep 20 episode supersedes it with runs_on [[mqtt-broker]].
  writeFileSync(
    join(v, 'episodes/2026/09/2026-09-20-move.md'),
    episodeNote('user', '2026-09-20T10:00:00-04:00', 'We moved it to the broker host.'),
  );
  restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[mqtt-broker]]', valid: true, confidence: 0.9 }]);
  try {
    const r2 = await consolidate(v, cfg);
    assert.equal(r2.superseded, 1);
  } finally {
    restore();
  }

  const before = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.ok(before.includes('[runs_on:: [[mqtt-broker]]]'), 'the broker host is the current fact');
  assert.ok(before.includes('~~[runs_on:: [[old-laptop]]]'), 'the laptop fact is struck through');
  assert.deepEqual(lintErrors(v), [], 'lint is clean after supersession');

  // Simulate a vault copy: every file's mtime moves, content is unchanged.
  touchAll(v, new Date(2026, 9, 15, 12, 0, 0));

  // Run 3: the mock would return the OLD candidate if any episode were re-selected.
  restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[old-laptop]]', valid: true, confidence: 0.9 }]);
  let r3;
  try {
    r3 = await consolidate(v, cfg);
  } finally {
    restore();
  }

  assert.deepEqual(r3.processedEpisodes, [], 'a copy must not re-select any episode');
  const after = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.equal(after, before, 'the entity note must be byte-identical after a copy');
  assert.deepEqual(lintErrors(v), [], 'lint must stay clean after a copy');
});

test('C22: a late-arriving older episode queues instead of superseding a newer fact', async () => {
  const v = makeVault('late', {
    'entities/projects/x.md': entityNote(
      'x',
      '## Facts\n- [runs_on:: [[new-host]]] [valid:: 2026-09-20..] [at:: 2026-09-20] [by:: user] ^f-x-new\n',
    ),
    'entities/tools/new-host.md': entityNote('new-host', ''),
    'entities/tools/old-host.md': entityNote('old-host', ''),
    'episodes/2026/09/2026-09-10-old.md': episodeNote('user', '2026-09-10T10:00:00-04:00', 'x runs on the old host.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  const restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[old-host]]', valid: true, confidence: 0.9 }]);
  let result;
  try {
    result = await consolidate(v, cfg);
  } finally {
    restore();
  }

  assert.equal(result.superseded, 0, 'an older claim must not supersede a newer fact');
  assert.equal(result.queued, 1);

  const text = readFileSync(join(v, 'entities/projects/x.md'), 'utf8');
  assert.ok(text.includes('[runs_on:: [[new-host]]]'), 'the newer fact must remain current');
  assert.ok(!text.includes('~~'), 'nothing may be struck through');

  const pending = readFileSync(join(v, '.circadia/pending.jsonl'), 'utf8');
  assert.ok(pending.includes('older than the current fact'), 'queued with the world-time reason');
});
