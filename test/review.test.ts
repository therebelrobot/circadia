// C9 regression tests: `circadia review` must write accepted facts, record rejections,
// keep edits queued, and re-prompt on unknown input.
//
// The decision logic is exercised directly through `applyReviewDecision` (no TTY), and
// the assertions check effects on disk (file contents, rejected.jsonl, lint), not counts.
// The accept test is the "fails before" test: against the pre-fix review.ts the fact is
// never written, so the on-disk assertion fails.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, STATE_DIR, loadConfig } from '../src/config.ts';
import { applyReviewDecision } from '../src/cli/review.ts';
import { candidateKey, rejectedPath, type PendingRecord } from '../src/consolidation/pending.ts';
import { main } from '../src/cli/main.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'circadia.mjs');

/** A minimal vault: two entities, one episode, and a single-valued `runs_on` predicate. */
function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-review-'));
  mkdirSync(join(v, 'entities', 'tools'), { recursive: true });
  mkdirSync(join(v, 'entities', 'projects'), { recursive: true });
  mkdirSync(join(v, 'episodes', '2026', '09'), { recursive: true });
  mkdirSync(join(v, STATE_DIR), { recursive: true });
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify({
      predicates: {
        strict: false,
        defs: {
          runs_on: { object: 'entity', cardinality: 'single' },
          status: { object: 'literal', cardinality: 'single' },
        },
      },
    }),
  );
  writeFileSync(
    join(v, 'entities', 'tools', 'pi-cluster.md'),
    '---\ntype: entity\nkind: tool\n---\n# Pi cluster\n\n## Facts\n- [status:: active] [by:: user]\n',
  );
  writeFileSync(
    join(v, 'entities', 'projects', 'orchard-sensors.md'),
    '---\ntype: entity\nkind: project\n---\n# Orchard sensors\n',
  );
  writeFileSync(
    join(v, 'entities', 'tools', 'old-host.md'),
    '---\ntype: entity\nkind: tool\n---\n# Old host\n',
  );
  writeFileSync(
    join(v, 'episodes', '2026', '09', '2026-09-20-move.md'),
    '---\ntype: episode\nstarted: 2026-09-20\nby: user\nsource: chat\nboundary: topic-shift\nimportance: 0.5\n---\n# Move\n',
  );
  return v;
}

/** A pending record with a stable key, matching the ADR-0007 shape. */
function record(over: Partial<PendingRecord> = {}): PendingRecord {
  const base = {
    v: 2 as const,
    subject: 'pi-cluster',
    predicate: 'runs_on',
    object: '[[orchard-sensors]]',
    episode: '2026-09-20-move',
    by: 'user' as const,
    trust: 'high' as const,
    origin: 'episode' as const,
    reason: 'known entity + known predicate + no conflict',
    queuedAt: 1759190400000,
  };
  const merged = { ...base, ...over };
  return {
    ...merged,
    key:
      over.key ??
      candidateKey({
        subject: merged.subject,
        predicate: merged.predicate,
        object: merged.object,
        src: merged.episode,
      }),
  };
}

describe('review (C9)', () => {
  test('accept writes the fact with by:: user and src:: [[episode]]; lint stays clean', async () => {
    const v = makeVault();
    const cfg = loadConfig(v);
    const rec = record();

    const d = applyReviewDecision(rec, 'a', v, cfg);

    assert.equal(d.action, 'accepted');
    assert.equal(d.keep, null, 'an accepted record leaves the queue');

    const body = readFileSync(join(v, 'entities', 'tools', 'pi-cluster.md'), 'utf8');
    assert.match(body, /\[runs_on:: \[\[orchard-sensors\]\]\]/, 'the accepted fact line is written');
    assert.match(body, /\[by:: user\]/, 'the fact is a user assertion');
    assert.match(body, /\[src:: \[\[2026-09-20-move\]\]\]/, 'provenance cites the source episode');

    const code = await main(['lint', '--vault', v]);
    assert.equal(code, 0, 'lint must stay clean after an accept');
  });

  test('accept supersedes a contradicting single-valued fact into ## History', () => {
    const v = makeVault();
    // pi-cluster already runs on old-host; the candidate says orchard-sensors.
    writeFileSync(
      join(v, 'entities', 'tools', 'pi-cluster.md'),
      '---\ntype: entity\nkind: tool\n---\n# Pi cluster\n\n## Facts\n- [runs_on:: [[old-host]]] [by:: user]\n',
    );
    const cfg = loadConfig(v);
    const rec = record({ object: '[[orchard-sensors]]' });

    const d = applyReviewDecision(rec, 'a', v, cfg);
    assert.equal(d.action, 'accepted');

    const body = readFileSync(join(v, 'entities', 'tools', 'pi-cluster.md'), 'utf8');
    const factsIdx = body.indexOf('## Facts');
    const historyIdx = body.indexOf('## History');
    assert.ok(factsIdx !== -1, '## Facts section exists');
    assert.ok(historyIdx !== -1, '## History section is created');
    const factsSection = body.slice(factsIdx, historyIdx);
    const historySection = body.slice(historyIdx);

    assert.match(factsSection, /\[runs_on:: \[\[orchard-sensors\]\]\]/, 'new fact is under ## Facts');
    assert.ok(!factsSection.includes('old-host'), 'the old fact leaves ## Facts');
    assert.match(historySection, /~~\[runs_on:: \[\[old-host\]\]\].*~~/, 'the old fact is struck through');
    assert.match(historySection, /\[superseded:: \d{4}-\d{2}-\d{2}\]/, 'the old fact carries a superseded date');
  });

  test('reject records the stable key in rejected.jsonl and leaves the queue', () => {
    const v = makeVault();
    const cfg = loadConfig(v);
    const rec = record();

    const d = applyReviewDecision(rec, 'r', v, cfg);

    assert.equal(d.action, 'rejected');
    assert.equal(d.keep, null, 'a rejected record leaves the queue');
    const rej = readFileSync(rejectedPath(v), 'utf8');
    assert.ok(rej.includes(rec.key), 'rejected.jsonl contains the stable key from C6');
  });

  test('edit keeps the record in the queue with the new values', () => {
    const v = makeVault();
    const cfg = loadConfig(v);
    const rec = record();

    const d = applyReviewDecision(rec, 'e', v, cfg, { object: '[[old-host]]' });

    assert.equal(d.action, 'edited');
    assert.ok(d.keep, 'an edited record stays in the queue');
    assert.equal(d.keep.object, '[[old-host]]', 'the edited object is kept');
    assert.equal(d.keep.subject, 'pi-cluster', 'untouched fields are preserved');
    assert.equal(d.keep.key, rec.key, 'the record keeps its stable key');
  });

  test('unknown input re-prompts instead of dropping the candidate', () => {
    const v = makeVault();
    const cfg = loadConfig(v);
    const rec = record();

    const d = applyReviewDecision(rec, 'maybe', v, cfg);

    assert.equal(d.action, 'reprompt');
    assert.ok(d.keep, 'the candidate is not dropped');
    assert.equal(d.keep.key, rec.key);
  });

  test('accept stamps the local calendar date for at:: and superseded::, not UTC', () => {
    const prevTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    // 2026-09-30T01:00:00Z is 2026-09-29 21:00 in America/New_York (UTC-4): the UTC date
    // is already tomorrow, so a raw Date.now() would stamp 2026-09-30.
    const now = Date.parse('2026-09-30T01:00:00Z');
    mock.timers.enable({ apis: ['Date'], now });
    try {
      assert.equal(new Date(now).getHours(), 21, 'TZ=America/New_York must be active');

      // No conflict: at:: is the local date.
      const v = makeVault();
      const cfg = loadConfig(v);
      const d = applyReviewDecision(record(), 'a', v, cfg);
      assert.equal(d.action, 'accepted');
      const body = readFileSync(join(v, 'entities', 'tools', 'pi-cluster.md'), 'utf8');
      assert.match(body, /\[at:: 2026-09-29\]/, 'at:: is the local date, not the UTC date');

      // Contradiction: superseded:: is the local date too.
      const v2 = makeVault();
      writeFileSync(
        join(v2, 'entities', 'tools', 'pi-cluster.md'),
        '---\ntype: entity\nkind: tool\n---\n# Pi cluster\n\n## Facts\n- [runs_on:: [[old-host]]] [by:: user]\n',
      );
      const cfg2 = loadConfig(v2);
      applyReviewDecision(record({ object: '[[orchard-sensors]]' }), 'a', v2, cfg2);
      const body2 = readFileSync(join(v2, 'entities', 'tools', 'pi-cluster.md'), 'utf8');
      assert.match(body2, /\[superseded:: 2026-09-29\]/, 'superseded:: is the local date, not the UTC date');
    } finally {
      mock.timers.reset();
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  test('review output shows the source episode agent beside a queued candidate', () => {
    const v = makeVault();
    // An episode authored by agent "coder"; the candidate cites it as its source.
    writeFileSync(
      join(v, 'episodes', '2026', '09', '2026-09-21-agent.md'),
      '---\ntype: episode\nstarted: 2026-09-21\nby: agent\nagent: coder\nsource: chat\nboundary: topic-shift\nimportance: 0.5\n---\n# Agent note\n',
    );
    const rec = record({ episode: '2026-09-21-agent' });
    writeFileSync(join(v, STATE_DIR, 'pending.jsonl'), JSON.stringify(rec) + '\n');

    const out = execFileSync(process.execPath, [BIN, 'review', '--vault', v], { input: 'r\n', encoding: 'utf8' });
    assert.match(out, /agent: coder/, 'the source episode agent must be shown');
  });

  test('review output renders a placeholder when the source episode is missing', () => {
    const v = makeVault();
    const rec = record({ episode: 'does-not-exist' });
    writeFileSync(join(v, STATE_DIR, 'pending.jsonl'), JSON.stringify(rec) + '\n');

    const out = execFileSync(process.execPath, [BIN, 'review', '--vault', v], { input: 'r\n', encoding: 'utf8' });
    assert.match(out, /agent: \(unknown\)/, 'a missing source episode must render a placeholder');
  });

  test('guard: only time.ts and non-date callers use Date.now()', () => {
    // A date written to a note must go through systemDateNow() (local calendar date), not
    // Date.now() (which formatFact renders as UTC). This fails if a new file starts
    // stamping Date.now() directly.
    const allowed = new Set([
      'src/vault/time.ts', // the helper itself
      'src/index/indexer.ts', // built_at meta (system time, not a note date)
      'src/retrieval/recall.ts', // activation "now"
      'src/consolidation/consolidate.ts', // now + ?? fallbacks; note dates use systemDateNow
      'src/dreams/rem.ts', // the pass's "now"; the night is a local date, not a note date
      'src/dreams/wake.ts', // the TTL "now"; the night is a local date, not a note date
    ]);
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const offenders: string[] = [];
    for (const rel of readdirSync(srcDir, { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue;
      const relPosix = `src/${rel.split(sep).join('/')}`;
      if (allowed.has(relPosix)) continue;
      if (readFileSync(join(srcDir, rel), 'utf8').includes('Date.now()')) offenders.push(relPosix);
    }
    assert.deepEqual(offenders, [], `these files stamp Date.now() directly: ${offenders.join(', ')}`);
  });
});
