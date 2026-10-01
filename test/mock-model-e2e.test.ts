// C26: the mock-model end-to-end scenario from docs/remediation.md §5.
//
// This is the check that has caught more real bugs than any unit test: it drives the real
// `consolidate` and `review` code paths against a tiny loopback chat server, over a temp
// copy of examples/vault/. It never touches examples/vault/ itself.
//
// The server answers /v1/chat/completions, returns 400 for a body without `messages`, and
// otherwise returns canned {"candidates":[...]} keyed by marker words in the fenced
// episode text. The seven checks are numbered in the phase comments below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  utimesSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, STATE_DIR, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { main } from '../src/cli/main.ts';
import { localDateString } from '../src/vault/time.ts';
import { rejectedPath, type PendingRecord } from '../src/consolidation/pending.ts';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXAMPLE_VAULT = join(REPO, 'examples', 'vault');

interface MockModel {
  url: string;
  close: () => Promise<void>;
}

/** Canned candidates keyed by marker words in the fenced episode text. */
function candidatesFor(user: string): unknown[] {
  if (user.includes('MOVED_TO_BROKER')) {
    return [{ subject: 'orchard-sensors', predicate: 'runs_on', object: '[[mqtt-broker]]', valid: true, confidence: 0.9 }];
  }
  if (user.includes('DEPENDS_ON_SOIL')) {
    return [{ subject: 'orchard-sensors', predicate: 'depends_on', object: '[[soil-moisture]]', valid: true, confidence: 0.9 }];
  }
  if (user.includes('OLD_CLAIM')) {
    return [{ subject: 'orchard-sensors', predicate: 'runs_on', object: '[[old-laptop]]', valid: true, confidence: 0.9 }];
  }
  if (user.includes('forum')) {
    return [{ subject: 'soil-moisture', predicate: 'status', object: 'active', valid: true, confidence: 0.99 }];
  }
  return [];
}

/** Start a loopback chat-completions server. */
async function startMockModel(): Promise<MockModel> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: { messages?: { role: string; content: string }[] } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        // fall through: a non-JSON body has no messages and gets a 400
      }
      if (!Array.isArray(body.messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'messages required' }));
        return;
      }
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      const candidates = candidatesFor(user);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ candidates }) } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Copy examples/vault to a temp dir, clean derived state, and point extraction at the mock. */
function makeTempVault(endpoint: string): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-e2e-'));
  cpSync(EXAMPLE_VAULT, v, { recursive: true });
  // The index is derived: rebuild it. The hand-written triple cache is removed so only
  // episode candidates reach the gate, keeping the pending queue deterministic.
  for (const f of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) {
    rmSync(join(v, STATE_DIR, f), { force: true });
  }
  rmSync(join(v, STATE_DIR, 'triples'), { recursive: true, force: true });

  const cfgPath = join(v, CONFIG_FILENAME);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  cfg.extraction = { provider: 'http', endpoint, model: 'mock', apiKeyEnv: null };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return v;
}

function episode(by: string, started: string, text: string): string {
  return `---\ntype: episode\nstarted: ${started}\nsource: chat\nby: ${by}\nboundary: manual\nimportance: 0.5\n---\n# Episode\n\n${text}\n`;
}

/** All vault files as `relpath:base64`, excluding the derived index and the access log. */
function snapshot(vault: string): string[] {
  const out: string[] = [];
  for (const rel of readdirSync(vault, { recursive: true, encoding: 'utf8' }) as string[]) {
    if (rel.includes('index.sqlite')) continue;
    if (rel.endsWith('access.jsonl')) continue;
    const abs = join(vault, rel);
    if (!statSync(abs).isFile()) continue;
    out.push(`${rel}:${readFileSync(abs).toString('base64')}`);
  }
  return out.sort();
}

/** Poll until `pred()` is true, or throw after `timeoutMs`. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for review output');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('mock-model e2e: consolidation, supersession, and review over a temp copy of examples/vault', async () => {
  const mock = await startMockModel();
  const v = makeTempVault(mock.url);
  const cfg = loadConfig(v);
  const today = localDateString();
  // Tracked outside the try so a failed waitFor still kills the review child. An
  // orphaned child keeps this test file's event loop alive, so `node --test` would
  // hang waiting for the file process to exit instead of failing fast.
  let reviewChild: ChildProcessWithoutNullStreams | undefined;

  try {
    // --- Phase A: (1) supersede, (2) accumulate, (3) untrusted queue ------------
    writeFileSync(
      join(v, 'episodes/2026/09/2026-09-20-move.md'),
      episode('user', '2026-09-20T10:00:00-04:00', 'MOVED_TO_BROKER: we moved the orchard-sensors collector to the mqtt-broker.'),
    );
    writeFileSync(
      join(v, 'episodes/2026/09/2026-09-25-depends.md'),
      episode('user', '2026-09-25T10:00:00-04:00', 'DEPENDS_ON_SOIL: orchard-sensors also depends on soil-moisture.'),
    );

    buildIndex(v, cfg);
    const run1 = await consolidate(v, cfg);

    // (1) a user episode "moved X to Y" supersedes runs_on: valid:: = episode date,
    //     at:: = run date.
    assert.equal(run1.superseded, 1, 'the move episode supersedes the current runs_on');
    const orch = readFileSync(join(v, 'entities/projects/orchard-sensors.md'), 'utf8');
    assert.ok(
      orch.includes(`[runs_on:: [[mqtt-broker]]] [valid:: 2026-09-20..] [at:: ${today}]`),
      `new runs_on fact must open at the episode date and be recorded at the run date:\n${orch}`,
    );
    assert.ok(
      orch.includes('~~[runs_on:: [[pi-cluster]]] [valid:: 2026-08-11..2026-09-20]~~'),
      `old runs_on fact must be struck and closed at the episode date:\n${orch}`,
    );
    assert.ok(orch.includes(`[superseded:: ${today}]`), 'the old fact carries the run date as superseded::');

    // (2) a second depends_on accumulates rather than superseding.
    assert.ok(orch.includes('[depends_on:: [[mqtt-broker]]]'), 'the existing depends_on stays current');
    assert.ok(orch.includes('[depends_on:: [[soil-moisture]]]'), 'the new depends_on is added');
    assert.ok(!orch.includes('~~[depends_on'), 'a many-valued predicate is never struck through');

    // (3) a by: web episode queues as "untrusted source".
    const pending1 = readFileSync(join(v, STATE_DIR, 'pending.jsonl'), 'utf8');
    assert.ok(pending1.includes('untrusted source'), 'the web candidate queues as untrusted');
    assert.ok(pending1.includes('"subject":"soil-moisture"'), 'the web candidate is the soil-moisture status');

    // --- Phase B: (4) running consolidation twice is a no-op --------------------
    const afterRun1 = snapshot(v);
    const run2 = await consolidate(v, cfg);
    assert.equal(run2.promoted, 0);
    assert.equal(run2.queued, 0);
    assert.equal(run2.superseded, 0);
    assert.deepEqual(run2.processedEpisodes, [], 'no episode is re-selected');
    assert.deepEqual(snapshot(v), afterRun1, 'a second run changes nothing on disk');

    // --- Phase C: (5) touching every episode's mtime changes nothing ------------
    const later = new Date(2026, 9, 15, 12, 0, 0);
    for (const rel of readdirSync(v, { recursive: true, encoding: 'utf8' }) as string[]) {
      if (!rel.endsWith('.md')) continue;
      utimesSync(join(v, rel), later, later);
    }
    const run3 = await consolidate(v, cfg);
    assert.deepEqual(run3.processedEpisodes, [], 'a touch must not re-select an episode');
    assert.deepEqual(snapshot(v), afterRun1, 'a touch must not change the vault');
    assert.equal(await main(['lint', '--vault', v]), 0, 'the vault lints clean after a touch');

    // --- Phase D: (6) an old episode after a newer fact queues ------------------
    writeFileSync(
      join(v, 'episodes/2026/09/2026-09-10-old-claim.md'),
      episode('user', '2026-09-10T10:00:00-04:00', 'OLD_CLAIM: orchard-sensors runs on the old-laptop.'),
    );
    const run4 = await consolidate(v, cfg);
    assert.equal(run4.superseded, 0, 'an older claim must not supersede a newer fact');
    assert.equal(run4.queued, 1);
    const pending2 = readFileSync(join(v, STATE_DIR, 'pending.jsonl'), 'utf8');
    assert.ok(pending2.includes('older than the current fact'), 'the old claim queues with the world-time reason');

    // --- Phase E: (7) review with paced input -----------------------------------
    // The queue holds the web record (Phase A) then the old-claim record (Phase D).
    const records = pending2
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as PendingRecord);
    assert.equal(records.length, 2, 'two records are queued for review');
    const rejectKey = records[1].key;

    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        join(REPO, 'src', 'cli', 'main.ts'),
        'review',
        '--vault',
        v,
      ],
      { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    reviewChild = child;
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (out += c.toString()));

    // Pace the answers: wait for each prompt before writing the next line.
    await waitFor(() => out.includes('accept (a)'), 5000);
    child.stdin.write('garbage\n');
    await waitFor(() => out.includes('unrecognized answer'), 5000);
    child.stdin.write('a\n');
    await waitFor(() => out.includes('accepted'), 5000);
    child.stdin.write('r\n');
    await waitFor(() => out.includes('rejected'), 5000);
    child.stdin.end();
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 5000);
      child.on('exit', () => {
        clearTimeout(t);
        r();
      });
    });

    // accept wrote a by:: user fact to the subject note.
    const soil = readFileSync(join(v, 'entities/concepts/soil-moisture.md'), 'utf8');
    assert.ok(soil.includes('[status:: active]'), 'the accepted fact is written');
    assert.ok(soil.includes('[by:: user]'), 'an accepted candidate is a user assertion');

    // reject recorded the stable key.
    const rejected = readFileSync(rejectedPath(v), 'utf8');
    assert.ok(rejected.includes(rejectKey), 'the rejected record key is in rejected.jsonl');

    // Both records left the queue.
    assert.equal(existsSync(join(v, STATE_DIR, 'pending.jsonl')), false, 'the queue is emptied');
  } finally {
    if (reviewChild && reviewChild.exitCode === null && reviewChild.signalCode === null) {
      reviewChild.kill('SIGKILL');
    }
    await mock.close();
  }
});
