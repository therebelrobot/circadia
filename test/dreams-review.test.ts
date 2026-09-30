// Stage 3 review of dream candidates (RFC-0001 "Confirmation"). Temp vaults; never touches
// examples/vault/.
//
// Gate coverage:
//   - review accept writes exactly one `by:: user` `related_to` fact
//   - reject marks the candidate rejected; unknown input re-prompts
//   - accept without `related_to` in predicates.defs is refused
//   - timezone: an evening accept in America/New_York stamps the local date, not tomorrow UTC
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { applyDreamDecision } from '../src/cli/review.ts';
import { candidatesPath, readCandidates, transitionCandidate, type DreamCandidate } from '../src/dreams/candidates.ts';

// Pin the timezone so the evening-accept test is deterministic: 2026-09-30T01:30:00Z is
// 2026-09-29 21:30 in America/New_York, so the local calendar date differs from the UTC date.
process.env.TZ = 'America/New_York';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');

function makeVault(withRelatedTo = true): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-dreams-review-'));
  mkdirSync(join(v, 'entities'), { recursive: true });
  mkdirSync(join(v, '.circadia'), { recursive: true });
  writeFileSync(join(v, 'entities', 'soil-probe.md'), '---\ntype: entity\nkind: concept\n---\n# Soil Probe\n\nBody.\n');
  writeFileSync(join(v, 'entities', 'old-laptop.md'), '---\ntype: entity\nkind: tool\n---\n# Old Laptop\n\nBody.\n');
  const defs = withRelatedTo ? { related_to: { object: 'entity' } } : {};
  writeFileSync(
    join(v, 'circadia.config.json'),
    JSON.stringify({ predicates: { strict: false, defs } }, null, 2) + '\n',
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
    night: '2026-09-29',
    expires: '2026-10-13',
    state: 'open',
    ...over,
  };
  mkdirSync(dirname(candidatesPath(v)), { recursive: true });
  writeFileSync(candidatesPath(v), JSON.stringify(c) + '\n');
  return c;
}

test('review: accept writes exactly one by:: user related_to fact', () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    const c = writeCandidate(v);
    const d = applyDreamDecision(c, 'a', v, cfg);
    assert.equal(d.action, 'accepted');

    const body = readFileSync(join(v, 'entities', 'soil-probe.md'), 'utf8');
    assert.equal((body.match(/\[related_to:: \[\[old-laptop\]\]\]/g) ?? []).length, 1, 'exactly one fact');
    assert.match(body, /\[by:: user\]/, 'the fact is a user assertion');
    assert.equal(readCandidates(v).find((x) => x.id === c.id)?.state, 'accepted');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('review: reject marks the candidate rejected and writes no fact', () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    const c = writeCandidate(v);
    const d = applyDreamDecision(c, 'r', v, cfg);
    assert.equal(d.action, 'rejected');
    assert.equal(readCandidates(v).find((x) => x.id === c.id)?.state, 'rejected');
    const body = readFileSync(join(v, 'entities', 'soil-probe.md'), 'utf8');
    assert.doesNotMatch(body, /related_to/, 'no fact is written on reject');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('review: unknown input re-prompts and leaves the candidate open', () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    const c = writeCandidate(v);
    const d = applyDreamDecision(c, 'maybe', v, cfg);
    assert.equal(d.action, 'reprompt');
    assert.equal(readCandidates(v).find((x) => x.id === c.id)?.state, 'open');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('review: accept without related_to in predicates.defs is refused', () => {
  const v = makeVault(false);
  try {
    const cfg = loadConfig(v);
    const c = writeCandidate(v);
    const d = applyDreamDecision(c, 'a', v, cfg);
    assert.equal(d.action, 'error');
    assert.match(d.message, /related_to/);
    assert.equal(readCandidates(v).find((x) => x.id === c.id)?.state, 'open', 'left open');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('review CLI: accepting a dream writes the fact and marks it accepted', () => {
  const v = makeVault();
  try {
    writeCandidate(v);
    execFileSync(process.execPath, [BIN, 'review', '--vault', v], { input: 'a\n', encoding: 'utf8' });
    const body = readFileSync(join(v, 'entities', 'soil-probe.md'), 'utf8');
    assert.equal((body.match(/\[related_to:: \[\[old-laptop\]\]\]/g) ?? []).length, 1);
    assert.equal(readCandidates(v).find((x) => x.id === 'd-2026-09-29-abc123')?.state, 'accepted');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('candidates: the first endorse resets expiry; later ones do not extend it', () => {
  const v = makeVault();
  try {
    writeCandidate(v, { expires: '2026-10-01' });
    const r1 = transitionCandidate(v, 'd-2026-09-29-abc123', 'endorse', { today: '2026-09-30', ttlNights: 14 });
    assert.equal(r1.ok, true);
    assert.equal(r1.candidate?.expires, '2026-10-14', 'the first endorse resets expiry');
    assert.equal(r1.candidate?.by, 'agent');

    const r2 = transitionCandidate(v, 'd-2026-09-29-abc123', 'endorse', { today: '2026-10-05', ttlNights: 14 });
    assert.equal(r2.ok, true);
    assert.equal(r2.candidate?.expires, '2026-10-14', 'a later endorse does not extend it');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('candidates: an endorsement note is truncated to 280 characters', () => {
  const v = makeVault();
  try {
    writeCandidate(v);
    const r = transitionCandidate(v, 'd-2026-09-29-abc123', 'endorse', {
      note: 'x'.repeat(400),
      today: '2026-09-30',
      ttlNights: 14,
    });
    assert.equal(r.candidate?.note?.length, 280);
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('review CLI: offers to add related_to when predicates.defs lacks it', () => {
  const v = makeVault(false);
  try {
    writeCandidate(v);
    // 'a' accepts, 'y' adds related_to to the config.
    execFileSync(process.execPath, [BIN, 'review', '--vault', v], { input: 'a\ny\n', encoding: 'utf8' });
    const cfg = JSON.parse(readFileSync(join(v, 'circadia.config.json'), 'utf8')) as {
      predicates: { defs: Record<string, unknown> };
    };
    assert.ok('related_to' in cfg.predicates.defs, 'related_to was added to predicates.defs');
    const body = readFileSync(join(v, 'entities', 'soil-probe.md'), 'utf8');
    assert.equal((body.match(/\[related_to:: \[\[old-laptop\]\]\]/g) ?? []).length, 1);
    assert.equal(readCandidates(v).find((x) => x.id === 'd-2026-09-29-abc123')?.state, 'accepted');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});

test('review: an evening accept stamps the local date, not tomorrow UTC', () => {
  const v = makeVault();
  try {
    const cfg = loadConfig(v);
    const c = writeCandidate(v);
    // 2026-09-30T01:30:00Z is 2026-09-29 21:30 in America/New_York.
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-30T01:30:00Z') });
    try {
      const d = applyDreamDecision(c, 'a', v, cfg);
      assert.equal(d.action, 'accepted');
    } finally {
      mock.timers.reset();
    }
    const body = readFileSync(join(v, 'entities', 'soil-probe.md'), 'utf8');
    assert.match(body, /\[at:: 2026-09-29\]/, 'the local date, not 2026-09-30');
  } finally {
    rmSync(v, { recursive: true, force: true });
  }
});
