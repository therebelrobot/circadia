// The consolidation extraction prompt must steer the model toward the vault's declared
// predicates and durable, concrete facts — not ad-hoc invented verbs or fragments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, STATE_DIR, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { buildIndex } from '../src/index/indexer.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-extract-prompt-'));

test('extraction prompt: prefers declared predicates; bans ad-hoc verbs and fragments', async () => {
  let prompt = '';
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
        prompt = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      } catch {
        // a non-JSON body has no messages; the assertion below will fail loudly
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"candidates": []}' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  try {
    const v = join(tmp, 'vault');
    mkdirSync(join(v, 'episodes'), { recursive: true });
    writeFileSync(join(v, CONFIG_FILENAME), JSON.stringify({
      vault: { factsHeading: '## Facts', historyHeading: '## History', ignore: [] },
      index: { path: `${STATE_DIR}/index.sqlite`, accessLog: `${STATE_DIR}/access.jsonl` },
      graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'auto', auto: { ladder: ['typed'], minTopMargin: 0.1, minSeeds: 2, multiEntityThreshold: 2 } }, originWeights: { contains: 1, link: 1, fact: 1, provenance: 1, triple: 1, synonym: 1 }, damping: 0.5, maxIterations: 100, tolerance: 0.001 },
      retrieval: { topK: 20, tokenBudget: 5000, seedLimit: 10, weights: { graph: 0.6, activation: 0.25, importance: 0.15 }, actrDecay: 0.5, actrThresholdDays: 14, actrNoise: 0.3, trustFloor: 'low', includeSuperseded: false, logAccess: false },
      embeddings: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 },
      extraction: { provider: 'http', endpoint: url, model: 'mock', apiKeyEnv: null },
      predicates: { strict: false, defs: { runs_on: { object: 'entity' }, depends_on: { object: 'entity' }, related_to: { object: 'entity' } } },
    }));
    writeFileSync(
      join(v, 'episodes', '2026-09-17.md'),
      '---\ntype: episode\nstarted: 2026-09-17\nby: user\nsource: chat\nboundary: topic-shift\nimportance: 0.5\n---\n# Standup\n\ncs1 runs_on the fleet.\n',
    );
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    await consolidate(v, cfg, { dryRun: true });

    assert.ok(prompt.length > 0, 'the mock captured the extraction prompt');
    assert.match(prompt, /prefer one of the vault's declared predicates/i);
    assert.match(prompt, /use related_to\. Do NOT invent an ad-hoc verb/i);
    assert.match(prompt, /concrete entity/i);
    assert.match(prompt, /durable facts the episode states explicitly/i);
    assert.doesNotMatch(prompt, /otherwise use a snake_case predicate/i, 'the old invitation to invent must be gone');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
