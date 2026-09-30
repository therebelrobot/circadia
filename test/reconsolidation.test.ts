// C18: reconsolidation window (docs/remediation.md §3, docs/ROADMAP.md Phase 4).
//
// A fact recalled in the same `session` as the episode that contradicts it was active when
// it was contradicted, so its queued record is marked `priority: "reconsolidation"` and
// `circadia review` sorts it first.
//
// The first test is the "fails before" test: before the fix, `consolidate` never read the
// access log, so the pending record had no `priority` field and the on-disk assertion
// failed. The assertions read the record back off disk (not a count), per the working rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { recall } from '../src/retrieval/recall.ts';
import { prioritizeForReview, type PendingRecord } from '../src/consolidation/pending.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-reconsolidation-'));

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

/** An episode with an optional `session` frontmatter field (the C16/C18 session id). */
function episodeNote(by: string, text: string, session?: string): string {
  const sessionLine = session ? `session: ${session}\n` : '';
  return `---\ntype: episode\nstarted: 2026-09-20T10:00:00-04:00\nsource: chat\nby: ${by}\n${sessionLine}boundary: manual\nimportance: 0.5\n---\n# Episode\n\n${text}\n`;
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

/** Read the pending queue off disk as parsed records. */
function readPending(v: string): PendingRecord[] {
  const raw = readFileSync(join(v, '.circadia/pending.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PendingRecord);
}

/** The vault used by the two end-to-end tests: x runs_on z, and an episode that moves it. */
function contradictionVault(name: string, session: string): string {
  return makeVault(name, {
    'entities/projects/x.md': entityNote(
      'x',
      'Orchard telemetry hub.\n\n## Facts\n- [runs_on:: [[z]]] [valid:: 2026-06-01..] [at:: 2026-06-01] [by:: user] ^f-x-old\n\n## History\n',
    ),
    'entities/tools/y.md': entityNote('y', ''),
    'entities/tools/z.md': entityNote('z', ''),
    'episodes/2026/09/2026-09-21-move.md': episodeNote('agent', 'We moved x to y.', session),
  });
}

test('C18: a fact recalled in the same session as the contradicting episode is prioritized', async () => {
  const v = contradictionVault('same-session', 's1');
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  // A recall in session s1 returns x's passage and logs the access with the session id.
  const r = await recall(v, cfg, 'orchard', { session: 's1', logAccess: true });
  assert.ok(
    r.hits.some((h) => h.noteId === 'x'),
    'the recall must return a passage of the subject note, or the session link cannot form',
  );

  const restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[y]]', valid: true, confidence: 0.9 }]);
  try {
    const result = await consolidate(v, cfg);
    assert.equal(result.queued, 1, 'the contradiction queues (agent episode, not user-confirmed)');
  } finally {
    restore();
  }

  const records = readPending(v);
  const rec = records.find((x) => x.subject === 'x');
  assert.ok(rec, 'a pending record for x must exist on disk');
  assert.equal(rec.reason, 'contradicts a current fact', 'the record is a queued contradiction');
  assert.equal(rec.priority, 'reconsolidation', 'same-session recall marks the record prioritized');
});

test('C18: a fact recalled in a different session is not prioritized', async () => {
  const v = contradictionVault('diff-session', 's2');
  const cfg = loadConfig(v);
  buildIndex(v, cfg);

  // The recall is in s1; the contradicting episode is in s2. No session link.
  await recall(v, cfg, 'orchard', { session: 's1', logAccess: true });

  const restore = mockFetch([{ subject: 'x', predicate: 'runs_on', object: '[[y]]', valid: true, confidence: 0.9 }]);
  try {
    await consolidate(v, cfg);
  } finally {
    restore();
  }

  const rec = readPending(v).find((x) => x.subject === 'x');
  assert.ok(rec, 'a pending record for x must exist on disk');
  assert.equal(rec.priority, undefined, 'a different session must not prioritize the record');
});

test('C18: prioritizeForReview sorts reconsolidation records first, stably', () => {
  const base = {
    v: 2 as const,
    predicate: 'runs_on',
    object: '[[y]]',
    episode: 'ep',
    by: 'agent' as const,
    trust: 'medium' as const,
    origin: 'episode' as const,
    reason: 'contradicts a current fact',
    queuedAt: 0,
  };
  const plainA: PendingRecord = { ...base, key: 'a', subject: 'a' };
  const prioritized: PendingRecord = { ...base, key: 'b', subject: 'b', priority: 'reconsolidation' };
  const plainC: PendingRecord = { ...base, key: 'c', subject: 'c' };

  const ordered = prioritizeForReview([plainA, prioritized, plainC]);
  assert.deepEqual(
    ordered.map((r) => r.key),
    ['b', 'a', 'c'],
    'the prioritized record moves first; the rest keep their on-disk order',
  );
  // The input array is not mutated.
  assert.deepEqual([plainA, prioritized, plainC].map((r) => r.key), ['a', 'b', 'c']);
});
