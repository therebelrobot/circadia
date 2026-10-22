// Additive corroboration (Phase 4): a claim that would queue only for a new entity or an
// unknown predicate promotes once enough weighted, independent episodes agree; the fact's
// conf grows with support, and an already-current fact is strengthened as more agree.
// Human sources count double an agent's. Contradictions, untrusted sources, and rejected
// claims are never corroborated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONFIG_FILENAME, STATE_DIR, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { buildIndex } from '../src/index/indexer.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-corroboration-'));

function episodeNote(by: string, marker: string): string {
  return `---\ntype: episode\nstarted: 2026-09-20T10:00:00-04:00\nsource: chat\nby: ${by}\nboundary: manual\nimportance: 0.5\n---\n# Episode\n\n${marker}\n`;
}

function entityNote(id: string, facts: string): string {
  return `---\ntype: entity\nkind: concept\n---\n# ${id}\n\n## Facts\n${facts}\n## History\n`;
}

/** Mock model: reads `CANDIDATE <subject> <predicate> <object>` from the episode text. */
async function withMock(fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = raw.match(/CANDIDATE ([\w-]+) ([\w-]+) ([\w-]+)/);
      const candidates = m ? [{ subject: m[1], predicate: m[2], object: m[3], valid: true, confidence: 0.9 }] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ candidates }) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function makeVault(name: string, endpoint: string, files: Record<string, string>, corr = true): string {
  const v = join(tmp, name);
  mkdirSync(v, { recursive: true });
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify({
      extraction: { provider: 'http', endpoint, model: 'm', apiKeyEnv: null },
      predicates: { strict: false, defs: {} },
      consolidation: { corroboration: corr, corroborationMinSupport: 2 },
    }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(v, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return v;
}

test('corroboration: two agent episodes promote a new entity and create it', async () => {
  await withMock(async (url) => {
    const v = makeVault('two-agents', url, {
      'episodes/2026/09/2026-09-20-a.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
      'episodes/2026/09/2026-09-21-b.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
    });
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await consolidate(v, cfg);
    assert.equal(r.promoted, 1, 'the corroborated claim promotes');
    assert.equal(r.queued, 0, 'nothing queues once corroborated');

    const note = readFileSync(join(v, 'entities', 'alpha.md'), 'utf8');
    assert.match(note, /\[runs_on:: delta\]/, 'the entity note carries the fact');
    assert.match(note, /\[conf:: 0\.75\]/, 'conf reflects two agent units (0.5 + 0.25)');
    assert.ok(!existsSync(join(v, STATE_DIR, 'pending.jsonl')), 'the promoted claim leaves no pending record');
  });
});

test('corroboration: a single agent episode still queues', async () => {
  await withMock(async (url) => {
    const v = makeVault('one-agent', url, {
      'episodes/2026/09/2026-09-20-a.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
    });
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await consolidate(v, cfg);
    assert.equal(r.promoted, 0);
    assert.equal(r.queued, 1, 'one agent episode is below the threshold');
    assert.ok(!existsSync(join(v, 'entities', 'alpha.md')), 'no entity is created without corroboration');
  });
});

test('corroboration: a single human episode clears the threshold (human weight 2)', async () => {
  await withMock(async (url) => {
    const v = makeVault('one-user', url, {
      'episodes/2026/09/2026-09-20-a.md': episodeNote('user', 'CANDIDATE alpha runs_on delta'),
    });
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await consolidate(v, cfg);
    assert.equal(r.promoted, 1, 'a human assertion carries double weight');
    const note = readFileSync(join(v, 'entities', 'alpha.md'), 'utf8');
    assert.match(note, /\[conf:: 0\.75\]/, 'weight 2 => 0.75');
  });
});

test('corroboration: an agreeing episode strengthens an already-current fact', async () => {
  await withMock(async (url) => {
    const v = makeVault('strengthen', url, {
      'entities/alpha.md': entityNote('alpha', '- [runs_on:: delta] [by:: agent] [conf:: 0.5] ^f-x\n'),
      'episodes/2026/09/2026-09-20-a.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
    });
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    await consolidate(v, cfg);
    const note = readFileSync(join(v, 'entities', 'alpha.md'), 'utf8');
    assert.match(note, /\[conf:: 0\.625\]/, 'conf moves one step (agent weight 1 => +0.125)');
    assert.equal((note.match(/runs_on:: delta/g) ?? []).length, 1, 'the fact is strengthened, not duplicated');
  });
});

test('corroboration: a rejected claim is never corroborated', async () => {
  await withMock(async (url) => {
    const v = makeVault('rejected', url, {
      'episodes/2026/09/2026-09-20-a.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
      'episodes/2026/09/2026-09-21-b.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
      [`${STATE_DIR}/rejected.jsonl`]:
        JSON.stringify({
          v: 2,
          key: 'k-old',
          subject: 'alpha',
          predicate: 'runs_on',
          object: 'delta',
          episode: 'e-old',
          by: 'agent',
          trust: 'medium',
          origin: 'episode',
          reason: 'new entity',
          queuedAt: 0,
        }) + '\n',
    });
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await consolidate(v, cfg);
    assert.equal(r.promoted, 0, 'a human rejection stands');
    assert.ok(!existsSync(join(v, 'entities', 'alpha.md')));
  });
});

test('corroboration: a contradiction still queues even with corroboration on', async () => {
  await withMock(async (url) => {
    const v = makeVault('contradiction', url, {
      'entities/alpha.md': entityNote('alpha', '- [runs_on:: delta] [by:: agent] [conf:: 1] ^f-x\n'),
      'episodes/2026/09/2026-09-20-a.md': episodeNote('agent', 'CANDIDATE alpha runs_on epsilon'),
      'episodes/2026/09/2026-09-21-b.md': episodeNote('agent', 'CANDIDATE alpha runs_on epsilon'),
    });
    // Make runs_on single-valued so a different object is a contradiction.
    writeFileSync(
      join(v, CONFIG_FILENAME),
      JSON.stringify({
        extraction: { provider: 'http', endpoint: url, model: 'm', apiKeyEnv: null },
        predicates: { strict: false, defs: { runs_on: { object: 'entity', cardinality: 'single' } } },
        consolidation: { corroboration: true, corroborationMinSupport: 2 },
      }),
    );
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await consolidate(v, cfg);
    assert.equal(r.promoted, 0);
    assert.equal(r.superseded, 0, 'an agent contradiction never supersedes');
    assert.ok(r.queued >= 1, 'the contradiction queues for review');
    const note = readFileSync(join(v, 'entities', 'alpha.md'), 'utf8');
    assert.match(note, /\[runs_on:: delta\]/, 'the current fact is untouched');
    assert.ok(!note.includes('epsilon'), 'the contradicting claim is not written');
  });
});

test('#17: an entity-typed predicate creates the object entity and writes a link', async () => {
  await withMock(async (url) => {
    const v = makeVault('object-entity', url, {
      'episodes/2026/09/2026-09-20-a.md': episodeNote('agent', 'CANDIDATE alpha related_to gamma'),
      'episodes/2026/09/2026-09-21-b.md': episodeNote('agent', 'CANDIDATE alpha related_to gamma'),
    });
    // related_to is declared with an entity object, so the fact must carry a [[link]].
    writeFileSync(
      join(v, CONFIG_FILENAME),
      JSON.stringify({
        extraction: { provider: 'http', endpoint: url, model: 'm', apiKeyEnv: null },
        predicates: { strict: false, defs: { related_to: { object: 'entity' } } },
        consolidation: { corroboration: true, corroborationMinSupport: 2 },
      }),
    );
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await consolidate(v, cfg);
    assert.equal(r.promoted, 1);
    assert.ok(existsSync(join(v, 'entities', 'gamma.md')), 'the object entity is created');
    const note = readFileSync(join(v, 'entities', 'alpha.md'), 'utf8');
    assert.match(note, /\[related_to:: \[\[gamma\]\]\]/, 'the fact object is a wikilink, not a literal');
  });
});

test('corroboration: off by default changes nothing', async () => {
  await withMock(async (url) => {
    const v = makeVault(
      'off',
      url,
      {
        'episodes/2026/09/2026-09-20-a.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
        'episodes/2026/09/2026-09-21-b.md': episodeNote('agent', 'CANDIDATE alpha runs_on delta'),
      },
      false,
    );
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const r = await consolidate(v, cfg);
    assert.equal(r.promoted, 0, 'with the flag off, both episodes queue as before');
    assert.ok(r.queued >= 1);
    assert.ok(!existsSync(join(v, 'entities', 'alpha.md')));
  });
});
