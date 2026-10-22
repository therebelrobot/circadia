// #13: model routing.
//
// - `extraction.routing` becomes the request's `provider` object (wire test in
//   test/llm-chat.test.ts); the resolver is unit-tested in test/llm-resolve.test.ts.
// - `dreaming.llm.model` (and friends) override the extraction LLM for the REM pass only.
//   This file is the end-to-end proof: the same vault, one mock endpoint, and we assert
//   which `model` each call site sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { runRem } from '../src/dreams/rem.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';

const NOW = Date.parse('2026-09-30T12:00:00Z');

interface Sent {
  model: string;
  kind: 'dream' | 'consolidate';
}

/** A mock endpoint that records the model + call site of each request. */
async function startMock(): Promise<{
  url: string;
  sent: Sent[];
  close: () => Promise<void>;
}> {
  const sent: Sent[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: { model?: string; messages?: { role: string; content: string }[] } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        // ignore
      }
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      const kind = user.includes('Passage A') ? 'dream' : 'consolidate';
      sent.push({ model: body.model ?? '', kind });
      // A valid response for each call site: no association (dream) / no candidates.
      const content = kind === 'dream' ? '{"association":null}' : '{"candidates":[]}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    sent,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** n0 -> n1 -> n2, an access to n0 (so the sampled dream pair is (n0, n2)), and an episode. */
function makeVault(endpoint: string, dreamModel?: string): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-model-routing-'));
  mkdirSync(join(v, 'entities'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  mkdirSync(join(v, 'episodes', '2026', '09'), { recursive: true });
  const ids = ['n0', 'n1', 'n2'];
  for (let i = 0; i < ids.length; i++) {
    const next = ids[i + 1];
    writeFileSync(
      join(v, 'entities', `${ids[i]}.md`),
      `---\ntype: entity\nkind: concept\ncreated: 2020-01-01\n---\n# ${ids[i]}\n\nNote ${ids[i]}: calibration drift is real; recalibrate before the season.${next ? ` See [[${next}]].` : ''}\n`,
    );
  }
  writeFileSync(
    join(v, '.circadia', 'access.jsonl'),
    JSON.stringify({ t: NOW - 3_600_000, node: 'n0#0', kind: 'recall', q: 'abc' }) + '\n',
  );
  writeFileSync(
    join(v, 'episodes', '2026', '09', '2026-09-20-note.md'),
    '---\ntype: episode\nstarted: 2026-09-20T10:00:00-04:00\nsource: chat\nby: user\nboundary: manual\nimportance: 0.5\n---\n# Note\n\nThe pi cluster runs on the old laptop.\n',
  );
  writeFileSync(
    join(v, 'circadia.config.json'),
    JSON.stringify({
      extraction: { provider: 'http', endpoint, model: 'extract-model', apiKeyEnv: null },
      dreaming: {
        enabled: true,
        samplesPerNight: 1,
        minHops: 2,
        recentDays: 7,
        noiseShare: 0,
        trustFloor: 'medium',
        recallFragments: 3,
        logTtlHours: 12,
        candidateTtlNights: 14,
        ...(dreamModel ? { llm: { model: dreamModel } } : {}),
      },
    }) + '\n',
  );
  return v;
}

test('#13: dreaming.llm.model routes only the REM pass; consolidation keeps extraction.model', async () => {
  const mock = await startMock();
  const v = makeVault(mock.url, 'dream-model');
  try {
    const cfg = loadConfig(v);
    const dbPath = join(v, '.circadia', 'index.sqlite');
    buildIndex(v, cfg, { dbPath });

    await runRem(v, cfg, { now: NOW, dbPath, timeoutMs: 500 });
    await consolidate(v, cfg);

    const dream = mock.sent.filter((s) => s.kind === 'dream');
    const cons = mock.sent.filter((s) => s.kind === 'consolidate');
    assert.ok(dream.length >= 1, 'the REM pass must make at least one call');
    assert.ok(cons.length >= 1, 'consolidation must make at least one call');
    assert.ok(dream.every((s) => s.model === 'dream-model'), `dream calls must use the dream model: ${JSON.stringify(dream)}`);
    assert.ok(cons.every((s) => s.model === 'extract-model'), `consolidation must use the extraction model: ${JSON.stringify(cons)}`);
  } finally {
    await mock.close();
  }
});

test('#13: without dreaming.llm the REM pass uses extraction.model (unchanged)', async () => {
  const mock = await startMock();
  const v = makeVault(mock.url);
  try {
    const cfg = loadConfig(v);
    const dbPath = join(v, '.circadia', 'index.sqlite');
    buildIndex(v, cfg, { dbPath });

    await runRem(v, cfg, { now: NOW, dbPath, timeoutMs: 500 });

    const dream = mock.sent.filter((s) => s.kind === 'dream');
    assert.ok(dream.length >= 1, 'the REM pass must make at least one call');
    assert.ok(dream.every((s) => s.model === 'extract-model'), 'an unset dreaming.llm inherits extraction.model');
  } finally {
    await mock.close();
  }
});
