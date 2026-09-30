// RFC-0001 Stage 5, 5.1: the committed canned model responses.
//
// `eval/dreams.responses.jsonl` holds one record per case, keyed by pair. A mock
// chat-completions endpoint serves the record for the pair it sees in the prompt.
// The vault below is the contract the file's grounded quotes are written against:
// n0 -> n1 -> n2, with an access to n0, so the sampled pair is always (n0, n2).
// The cases mirror the Stage 2 recorded-response set (test/dreams-rem.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { runRem } from '../src/dreams/rem.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const NOW = Date.parse('2026-09-30T12:00:00Z');

interface ResponseRecord {
  v: number;
  case: string;
  pair: [string, string];
  content: string | null;
}

function readResponses(): ResponseRecord[] {
  return readFileSync(join(EVAL_DIR, 'dreams.responses.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ResponseRecord);
}

/** The pair the prompt is about, from the note ids embedded in the passage text. */
function pairFromPrompt(user: string): [string, string] {
  const ids = [...user.matchAll(/Note (n\d+):/g)].map((m) => m[1]);
  return [ids[0] ?? '', ids[1] ?? ''];
}

interface Mock {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

/** Serve the record whose pair matches the prompt. A null content never responds. */
async function startMock(records: ResponseRecord[]): Promise<Mock> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: { messages?: { role: string; content: string }[] } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        // a non-JSON body has no messages; the handler still runs with an empty user
      }
      const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
      requests.push(user);
      const [a, b] = pairFromPrompt(user);
      const rec = records.find(
        (r) => (r.pair[0] === a && r.pair[1] === b) || (r.pair[0] === b && r.pair[1] === a),
      );
      if (!rec || rec.content === null) return; // never respond -> the client times out
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: rec.content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** n0 -> n1 -> n2, access to n0, so the sampled pair is always (n0, n2). */
function makeVault(endpoint: string): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-dreams-responses-'));
  mkdirSync(join(v, 'entities'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  const ids = ['n0', 'n1', 'n2'];
  for (let i = 0; i < ids.length; i++) {
    const next = ids[i + 1];
    const link = next ? ` See [[${next}]].` : '';
    writeFileSync(
      join(v, 'entities', `${ids[i]}.md`),
      `---\ntype: entity\nkind: concept\ncreated: 2020-01-01\n---\n# ${ids[i]}\n\nNote ${ids[i]}: calibration drift is real; recalibrate before the season.${link}\n`,
    );
  }
  writeFileSync(
    join(v, '.circadia', 'access.jsonl'),
    JSON.stringify({ t: NOW - 3_600_000, node: 'n0#0', kind: 'recall', q: 'abc' }) + '\n',
  );
  const cfg = {
    extraction: { provider: 'http', endpoint, model: 'mock', apiKeyEnv: null },
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
    },
  };
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  return v;
}

const EXPECTED: Record<string, { kept: number; pruned: number; errors?: Record<string, number> }> = {
  grounded: { kept: 1, pruned: 0 },
  ungrounded: { kept: 0, pruned: 1 },
  null: { kept: 0, pruned: 1 },
  malformed: { kept: 0, pruned: 1, errors: { malformed: 1 } },
  'prompt-injection-shaped': { kept: 0, pruned: 1 },
  timeout: { kept: 0, pruned: 1, errors: { 'llm.timeout': 1 } },
};

for (const rec of readResponses()) {
  test(`dream responses: "${rec.case}" is handled`, async () => {
    const mock = await startMock([rec]);
    const v = makeVault(mock.url);
    try {
      const cfg = loadConfig(v);
      const dbPath = join(v, '.circadia', 'index.sqlite');
      buildIndex(v, cfg, { dbPath });
      const r = await runRem(v, cfg, { now: NOW, dbPath, timeoutMs: 150 });
      const want = EXPECTED[rec.case];
      assert.ok(want, `unknown case ${rec.case}`);
      assert.equal(r.kept, want.kept, `${rec.case}: kept`);
      assert.equal(r.pruned, want.pruned, `${rec.case}: pruned`);
      if (want.errors) assert.deepEqual(r.errors, want.errors, `${rec.case}: error classes`);
      assert.equal(r.fragments.length, 1, `${rec.case}: every sample becomes a fragment`);
      assert.equal(mock.requests.length, 1, `${rec.case}: one model call`);
    } finally {
      await mock.close();
      rmSync(v, { recursive: true, force: true });
    }
  });
}
