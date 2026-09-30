// Stage 3 MCP tools (RFC-0001 "Confirmation"). Temp vaults; never touches examples/vault/.
//
// Gate coverage:
//   - endorse_dream / dismiss_dream change only dream state; they never write under the
//     vault's note folders
//   - wake returns the fenced report and deletes the log
//   - tools/list advertises wake, endorse_dream, dismiss_dream
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { handleToolsCall } from '../src/mcp/server.ts';
import { writeLog, logPath, type DreamLog } from '../src/dreams/log.ts';
import { candidatesPath, readCandidates, type DreamCandidate } from '../src/dreams/candidates.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');
const NOW = Date.parse('2026-09-30T12:00:00Z');
const NIGHT = '2026-09-29';

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-dreams-mcp-'));
  mkdirSync(join(v, 'entities'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  writeFileSync(join(v, 'entities', 'soil-probe.md'), '---\ntype: entity\nkind: concept\n---\n# Soil Probe\n\nBody.\n');
  writeFileSync(join(v, 'entities', 'old-laptop.md'), '---\ntype: entity\nkind: tool\n---\n# Old Laptop\n\nBody.\n');
  writeFileSync(
    join(v, 'circadia.config.json'),
    JSON.stringify({ predicates: { strict: false, defs: { related_to: { object: 'entity' } } } }, null, 2) + '\n',
  );
  return v;
}

function writeCandidate(v: string, over: Partial<DreamCandidate> = {}): DreamCandidate {
  const c: DreamCandidate = {
    v: 1,
    id: 'd-2026-09-29-abc123',
    a: 'soil-probe',
    b: 'old-laptop',
    gist: 'both drift until recalibrated',
    quotes: { a: 'soil-probe#0', b: 'old-laptop#0' },
    hops: 4,
    salience: 0.61,
    model: 'mock',
    night: NIGHT,
    expires: '2026-10-13',
    state: 'open',
    ...over,
  };
  mkdirSync(dirname(candidatesPath(v)), { recursive: true });
  writeFileSync(candidatesPath(v), JSON.stringify(c) + '\n');
  return c;
}

function makeLog(): DreamLog {
  return {
    night: NIGHT,
    seed: 12345,
    ranAt: NOW,
    model: 'mock',
    report: {
      consolidation: { ran: true, episodes: 12, promoted: 3, queued: 2 },
      rem: { ran: true, samples: 20, kept: 1, pruned: 19, errors: {} },
    },
    fragments: [{ a: 'soil-probe', b: 'old-laptop', gist: 'both drift until recalibrated', status: 'kept', salience: 0.9 }],
  };
}

/** Hash every file except .circadia/dreams/ and the derived index. */
function snapshot(v: string): string[] {
  const out: string[] = [];
  for (const rel of readdirSync(v, { recursive: true, encoding: 'utf8' }) as string[]) {
    if (rel.startsWith('.circadia/dreams/')) continue;
    if (rel.includes('index.sqlite')) continue;
    const abs = join(v, rel);
    if (!statSync(abs).isFile()) continue;
    out.push(`${rel}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
  }
  return out.sort();
}

test('MCP endorse_dream: changes only dream state, never the vault', async () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    buildIndex(v, cfg, { dbPath: join(v, '.circadia', 'index.sqlite') });
    writeCandidate(v);
    const before = snapshot(v);

    const res = await handleToolsCall(v, cfg, 'endorse_dream', { id: 'd-2026-09-29-abc123', note: 'liked it' });
    assert.equal((res.result as { ok: boolean }).ok, true);
    assert.deepEqual(snapshot(v), before, 'nothing outside .circadia/dreams/ changed');

    const c = readCandidates(v).find((x) => x.id === 'd-2026-09-29-abc123');
    assert.equal(c?.state, 'endorsed');
    assert.equal(c?.by, 'agent');
    assert.equal(c?.note, 'liked it');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('MCP dismiss_dream: changes only dream state, never the vault', async () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    buildIndex(v, cfg, { dbPath: join(v, '.circadia', 'index.sqlite') });
    writeCandidate(v);
    const before = snapshot(v);

    const res = await handleToolsCall(v, cfg, 'dismiss_dream', { id: 'd-2026-09-29-abc123' });
    assert.equal((res.result as { ok: boolean }).ok, true);
    assert.deepEqual(snapshot(v), before, 'nothing outside .circadia/dreams/ changed');
    assert.equal(readCandidates(v).find((x) => x.id === 'd-2026-09-29-abc123')?.state, 'dismissed');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('MCP wake: returns the fenced report and deletes the log', async () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    buildIndex(v, cfg, { dbPath: join(v, '.circadia', 'index.sqlite') });
    writeLog(v, makeLog());

    const res = await handleToolsCall(v, cfg, 'wake', {});
    const result = res.result as { content: { text: string }[]; night: string | null; fragments: unknown[] };
    assert.equal(result.night, NIGHT);
    assert.equal(result.fragments.length, 1);
    assert.match(result.content[0].text, /<untrusted-data source="dreams">/);
    assert.equal(existsSync(logPath(v, NIGHT)), false, 'the log is deleted on read');

    const again = await handleToolsCall(v, cfg, 'wake', {});
    assert.equal((again.result as { night: string | null }).night, null, 'a second call reports nothing left');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('MCP tools/list: advertises wake, endorse_dream, dismiss_dream', () => {
  const v = makeVault();
  try {
    const input =
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) +
      '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
      '\n';
    const out = execFileSync(process.execPath, [BIN, 'mcp', '--vault', v], { input, encoding: 'utf8' });
    const lines = out
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { id: number; result?: { tools?: { name: string }[] } });
    const list = lines.find((l) => l.id === 2);
    const names = (list?.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes('wake'), 'wake is advertised');
    assert.ok(names.includes('endorse_dream'), 'endorse_dream is advertised');
    assert.ok(names.includes('dismiss_dream'), 'dismiss_dream is advertised');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});
