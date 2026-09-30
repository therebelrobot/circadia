// C14: access-log compaction must not freeze ACT-R learning, must respect as-of, and must
// use the optimized-learning frequency term. Policy (no raw-log rotation) is in
// docs/decisions/ADR-0009-access-log-compaction-policy.md.
//
// Expected values are derived from the spec (docs/ARCHITECTURE.md §8, docs/RETRIEVAL.md
// §Scoring, the ACT-R optimized-learning equation), not from current output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendAccess, baseLevel, baseLevelFromParts, optimizedLearningSum, readAccessLog, readAccessLogFrom, type AccessEvent } from '../src/retrieval/activation.ts';
import {
  compactAccessLog,
  loadAccessSummaries,
  writeAccessSummaries,
  presentationsForActivation,
  type AccessSummaries,
} from '../src/retrieval/log-compact.ts';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { recall } from '../src/retrieval/recall.ts';

const VAULT = resolve(import.meta.dirname, '..', 'examples', 'vault');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 30);  // 2026-09-30, fixed so the numbers are reproducible
const D = 0.5;                       // canonical ACT-R decay

const ev = (t: number, node: string): AccessEvent => ({ t, node, kind: 'recall' });

test('C14 equivalence: compacted activation matches the exact pre-compaction value', () => {
  const enc = NOW - 200 * DAY;
  // 100 evenly spaced daily accesses, oldest first (the raw log is append-only)
  const accesses = Array.from({ length: 100 }, (_, i) => NOW - (100 - i) * DAY);
  const exact = baseLevel([enc, ...accesses], NOW, D);

  const summaries = compactAccessLog(accesses.map((t) => ev(t, 'n')));
  const p = presentationsForActivation(summaries, [], null).get('n')!;
  const compacted = baseLevelFromParts(p.compacted, [enc], NOW, D);

  // The optimized-learning form is exact for uniform spacing in the limit; the error is
  // O(1/n). For n = 100 the gap is ~0.07 nats, so 0.15 is a safe bound.
  assert.ok(Math.abs(exact - compacted) < 0.15, `exact ${exact} vs compacted ${compacted}`);

  // And it equals the formula value, computed independently from the spec:
  //   B = ln( n/(1-d) · L^-d + Σ_recent t^-d )
  const L = (NOW - (NOW - 100 * DAY)) / 1000;
  const expectedSum = (100 / (1 - D)) * Math.pow(L, -D) + Math.pow((NOW - enc) / 1000, -D);
  assert.ok(Math.abs(compacted - Math.log(expectedSum)) < 1e-9, `compacted ${compacted}`);
});

test('C14 learning continues: post-watermark accesses flip the ranking', () => {
  const first = NOW - 100 * DAY;
  // node A: many compacted presentations, no recent activity
  const a = baseLevelFromParts({ count: 20, first }, [], NOW, D);
  // node B: one compacted presentation, but three accesses after the watermark
  const b = baseLevelFromParts({ count: 1, first }, [NOW - 1000, NOW - 2000, NOW - 3000], NOW, D);
  assert.ok(b > a, `recent accesses must raise B above the frozen summary (a=${a}, b=${b})`);

  // the same combination, through the summary + raw-event merge
  const summaries: AccessSummaries = {
    watermark: NOW - 10 * DAY,
    offset: 0,
    nodes: new Map([['b', { node: 'b', count: 1, first, last: NOW - 10 * DAY, accesses: [] }]]),
  };
  const events = [ev(NOW - 5 * DAY, 'b'), ev(NOW - 1 * DAY, 'b')];
  const p = presentationsForActivation(summaries, events, null).get('b')!;
  assert.deepEqual(p.compacted, { count: 1, first });
  assert.deepEqual(p.recent, [NOW - 5 * DAY, NOW - 1 * DAY]);
});

test('C14 as-of: a query before the watermark ignores later accesses', () => {
  const first = NOW - 50 * DAY;
  const summaries: AccessSummaries = {
    watermark: NOW - 10 * DAY,
    offset: 0,
    nodes: new Map([['n', { node: 'n', count: 5, first, last: NOW - 10 * DAY, accesses: [] }]]),
  };
  const events = [ev(NOW - 30 * DAY, 'n'), ev(NOW - 5 * DAY, 'n'), ev(NOW - 1 * DAY, 'n')];
  const asOf = NOW - 20 * DAY;

  const p = presentationsForActivation(summaries, events, asOf).get('n')!;
  // The summary aggregates events after asOf, so it is ignored; only the pre-asOf raw
  // event remains (the raw log is never rotated — ADR-0009).
  assert.equal(p.compacted, null);
  assert.deepEqual(p.recent, [NOW - 30 * DAY]);

  const B = baseLevelFromParts(p.compacted, p.recent, asOf, D);
  const expected = Math.log(Math.pow((asOf - (NOW - 30 * DAY)) / 1000, -D));
  assert.ok(Math.abs(B - expected) < 1e-9, `B=${B} expected=${expected}`);

  // Using the summary would include the post-asOf accesses and score higher; it must not.
  const withSummary = baseLevelFromParts({ count: 5, first }, [NOW - 30 * DAY], asOf, D);
  assert.ok(B < withSummary, `as-of B=${B} must exclude the summary (${withSummary})`);
});

test('C14 watermark: summaries record it and presentations include only post-watermark events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-c14-'));
  try {
    const file = join(dir, 'index-access-summaries.jsonl');
    const events = [ev(NOW - 15 * DAY, 'n'), ev(NOW - 5 * DAY, 'n'), ev(NOW - 1 * DAY, 'n')];
    const summaries = compactAccessLog(events, 4096);
    assert.equal(summaries.watermark, NOW - 1 * DAY);
    assert.equal(summaries.offset, 4096);
    writeAccessSummaries(file, summaries);

    const loaded = loadAccessSummaries(file);
    assert.equal(loaded.watermark, NOW - 1 * DAY, 'watermark survives the round-trip');
    assert.equal(loaded.offset, 4096, 'byte offset survives the round-trip');
    assert.equal(loaded.nodes.get('n')!.count, 3);

    // A summary whose watermark is NOW-10d: only events after it are "recent".
    const partial: AccessSummaries = {
      watermark: NOW - 10 * DAY,
      offset: 0,
      nodes: new Map([['n', { node: 'n', count: 1, first: NOW - 15 * DAY, last: NOW - 15 * DAY, accesses: [] }]]),
    };
    const p = presentationsForActivation(partial, events, null).get('n')!;
    assert.deepEqual(p.compacted, { count: 1, first: NOW - 15 * DAY });
    assert.deepEqual(p.recent, [NOW - 5 * DAY, NOW - 1 * DAY]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C14 tail read: recall parses only the events appended after the offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-c14-tail-'));
  try {
    const file = join(dir, 'access.jsonl');
    const old = [ev(NOW - 15 * DAY, 'n'), ev(NOW - 5 * DAY, 'n')];
    const oldText = old.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(file, oldText);
    const offset = Buffer.byteLength(oldText, 'utf8');
    const summaries = compactAccessLog(old, offset);
    assert.equal(summaries.offset, offset);

    // two events appended after compaction
    appendAccess(file, [ev(NOW - 1 * DAY, 'n'), ev(NOW - 1000, 'n')]);

    const tail = readAccessLogFrom(file, summaries.offset);
    assert.equal(tail.length, 2, 'only the appended events are parsed');
    assert.deepEqual(tail.map((e) => e.t), [NOW - 1 * DAY, NOW - 1000]);

    // nothing was deleted: the full log still has all four events
    assert.equal(readAccessLog(file).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C14 frequency: the compacted part uses count', () => {
  const first = NOW - 100 * DAY;
  const many = baseLevelFromParts({ count: 50, first }, [], NOW, D);
  const few = baseLevelFromParts({ count: 2, first }, [], NOW, D);
  assert.ok(many > few, `many=${many} few=${few}`);
  // The B difference is ln(50/2) = ln(25), independent of L.
  assert.ok(Math.abs((many - few) - Math.log(25)) < 1e-9, `delta ${many - few}`);
  // optimizedLearningSum scales linearly with n.
  assert.ok(Math.abs(optimizedLearningSum(50, first, NOW, D) / optimizedLearningSum(2, first, NOW, D) - 25) < 1e-9);
});

test('C14 backward compat: with no summaries, raw events are used exactly', () => {
  const events = [ev(NOW - 3 * DAY, 'n'), ev(NOW - 1 * DAY, 'n')];
  const p = presentationsForActivation({ watermark: 0, offset: 0, nodes: new Map() }, events, null).get('n')!;
  assert.equal(p.compacted, null);
  assert.deepEqual(p.recent, [NOW - 3 * DAY, NOW - 1 * DAY]);
  const B = baseLevelFromParts(p.compacted, p.recent, NOW, D);
  assert.ok(Math.abs(B - baseLevel([NOW - 3 * DAY, NOW - 1 * DAY], NOW, D)) < 1e-9);
});

test('C14 end-to-end: recall learns from accesses logged after compaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-c14-e2e-'));
  try {
    // copy the example vault so the repo copy is never touched
    const vault = join(dir, 'vault');
    cpSync(VAULT, vault, { recursive: true });
    const cfg = loadConfig(vault);
    const dbPath = join(dir, 'index.sqlite');
    buildIndex(vault, cfg, { dbPath });

    const accessFile = join(vault, cfg.index.accessLog);
    const summaryFile = join(vault, cfg.index.path.replace(/\.sqlite$/, '-access-summaries.jsonl'));
    const opts = { dbPath, logAccess: false, now: NOW, topK: 20, tokenBudget: 100_000 };

    // find a passage the query actually returns, then give it a compacted history
    const probe = await recall(vault, cfg, 'orchard sensors', opts);
    const target = probe.hits[0].passageId;
    const old = [NOW - 100 * DAY, NOW - 90 * DAY, NOW - 80 * DAY].map((t) => ev(t, target));
    const oldText = old.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(accessFile, oldText);
    // record the real byte offset so recall reads only the tail (the appended events)
    writeAccessSummaries(summaryFile, compactAccessLog(old, Buffer.byteLength(oldText, 'utf8')));

    const before = await recall(vault, cfg, 'orchard sensors', opts);
    const a0 = before.hits.find((h) => h.passageId === target)?.components.activation;
    assert.ok(a0 !== undefined, 'target passage is recalled');

    // three fresh accesses after the watermark must raise activation
    appendAccess(accessFile, [NOW - 1000, NOW - 2000, NOW - 3000].map((t) => ev(t, target)));
    const after = await recall(vault, cfg, 'orchard sensors', opts);
    const a1 = after.hits.find((h) => h.passageId === target)?.components.activation;
    assert.ok(a1 !== undefined && a1 > a0, `activation must rise after post-watermark accesses (${a0} -> ${a1})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
