// #12: one episode's extraction failure must not lose the whole night.
//
// Before this, `extractCandidates` threw straight through the consolidation loop, so a
// single failing episode aborted the run: nothing was promoted, queued, or committed, and
// every other episode went unprocessed. Now a failed episode is isolated (warned and
// skipped), left unmarked, and re-selected on the next run. This test drives the real code
// path against a loopback mock model that fails one episode with a non-transient 400.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { buildIndex } from '../src/index/indexer.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-consolidation-failure-'));

const POISON = 'FAIL_ME_MARKER';

function episodeNote(text: string): string {
  return `---\ntype: episode\nstarted: 2026-10-20T10:00:00-04:00\nsource: chat\nby: user\nboundary: manual\nimportance: 0.5\n---\n# Episode\n\n${text}\n`;
}

/** A vault with a good episode and a "poison" one the mock model rejects. */
function makeVault(name: string, endpoint: string): string {
  const v = join(tmp, name);
  mkdirSync(v, { recursive: true });
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify({
      extraction: { provider: 'http', endpoint, model: 'test-model', apiKeyEnv: null },
      predicates: { strict: false, defs: {} },
    }),
  );
  for (const [rel, text] of [
    ['episodes/2026/10/2026-10-20-good.md', 'The pi cluster runs on the old laptop.'],
    ['episodes/2026/10/2026-10-20-poison.md', `Something the model cannot handle. ${POISON}`],
  ] as const) {
    const abs = join(v, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, episodeNote(text));
  }
  return v;
}

/** Start the mock, run `fn`, then tear it down. `failPoison` can be flipped mid-test. */
async function withMock(fn: (url: string, state: { failPoison: boolean }) => Promise<void>): Promise<void> {
  const state = { failPoison: true };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const poison = raw.includes(POISON);
      if (poison && state.failPoison) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cannot process this episode' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"candidates":[]}' } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  try {
    await fn(url, state);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('#12 isolation: one failing episode does not abort the night', async () => {
  await withMock(async (url, state) => {
    const v = makeVault('isolation', url);
    const cfg = loadConfig(v);
    buildIndex(v, cfg);

    const goodPath = join(v, 'episodes/2026/10/2026-10-20-good.md');
    const poisonPath = join(v, 'episodes/2026/10/2026-10-20-poison.md');

    const first = await consolidate(v, cfg);
    assert.deepEqual(
      first.processedEpisodes,
      ['episodes/2026/10/2026-10-20-good.md'],
      'the good episode is processed; the failing one is isolated, not marked',
    );
    assert.ok(readFileSync(goodPath, 'utf8').includes('consolidated:'), 'the good episode is marked');
    assert.ok(!readFileSync(poisonPath, 'utf8').includes('consolidated:'), 'the failed episode is left unmarked');

    // Let the model succeed, then run again: the failed episode must be re-selected.
    state.failPoison = false;
    const second = await consolidate(v, cfg);
    assert.deepEqual(
      second.processedEpisodes,
      ['episodes/2026/10/2026-10-20-poison.md'],
      'only the previously failed episode is re-processed',
    );
    assert.ok(readFileSync(poisonPath, 'utf8').includes('consolidated:'), 'the retried episode is now marked');
  });
});

test('#12 isolation: an edited episode that fails extraction is re-selected next run', async () => {
  await withMock(async (url, state) => {
    const v = makeVault('isolation-edited', url);
    const cfg = loadConfig(v);
    buildIndex(v, cfg);
    const poisonPath = join(v, 'episodes/2026/10/2026-10-20-poison.md');

    // Consolidate the poison episode once, successfully.
    state.failPoison = false;
    const first = await consolidate(v, cfg);
    assert.ok(first.processedEpisodes.includes('episodes/2026/10/2026-10-20-poison.md'));
    assert.ok(readFileSync(poisonPath, 'utf8').includes('consolidated:'));

    // A manual edit changes the body, so C22 re-selects it. Now make extraction fail:
    // the episode must NOT have its new body adopted as the baseline, or it would look
    // consolidated forever and never be retried.
    writeFileSync(poisonPath, episodeNote(`Edited body the model cannot handle. ${POISON}`));
    state.failPoison = true;
    await consolidate(v, cfg);

    // Next run (model healthy again) must still select it.
    state.failPoison = false;
    const third = await consolidate(v, cfg);
    assert.ok(
      third.processedEpisodes.includes('episodes/2026/10/2026-10-20-poison.md'),
      'the edited-and-failed episode must be re-selected',
    );
  });
});
