// #15: a long episode must be able to extract. `extraction.timeoutMs` (default 60s) is
// passed to the chat client; a timeout is isolated but never retried, so a persistently
// slow episode would otherwise never consolidate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { buildIndex } from '../src/index/indexer.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-extraction-timeout-'));

/** A mock that waits `delayMs` before answering with a valid (empty) candidate list. */
async function withSlowMock(delayMs: number, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"candidates":[]}' } }] }));
      }, delayMs);
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

function makeVault(name: string, endpoint: string, timeoutMs: number): string {
  const v = join(tmp, name);
  mkdirSync(join(v, 'episodes', '2026', '09'), { recursive: true });
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify({
      extraction: { provider: 'http', endpoint, model: 'm', apiKeyEnv: null, timeoutMs },
      predicates: { strict: false, defs: {} },
    }),
  );
  writeFileSync(
    join(v, 'episodes', '2026', '09', 'e.md'),
    '---\ntype: episode\nstarted: 2026-09-20T10:00:00-04:00\nsource: chat\nby: agent\nboundary: manual\nimportance: 0.5\n---\n# E\n\nA long episode.\n',
  );
  return v;
}

test('#15: an episode slower than extraction.timeoutMs is isolated; a larger timeout succeeds', async () => {
  await withSlowMock(300, async (url) => {
    // Timeout shorter than the response: extraction fails and the episode is left unmarked.
    const tight = makeVault('tight', url, 80);
    buildIndex(tight, loadConfig(tight));
    const r1 = await consolidate(tight, loadConfig(tight));
    assert.equal(r1.processedEpisodes.length, 0, 'a timeout leaves the episode unmarked (isolated)');

    // Timeout longer than the response: the same episode extracts.
    const loose = makeVault('loose', url, 2000);
    buildIndex(loose, loadConfig(loose));
    const r2 = await consolidate(loose, loadConfig(loose));
    assert.equal(r2.processedEpisodes.length, 1, 'a sufficient timeout lets the episode consolidate');
  });
});
