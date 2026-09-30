// C9 regression tests: `circadia review` must write accepted facts, record rejections,
// keep edits queued, and re-prompt on unknown input.
//
// The decision logic is exercised directly through `applyReviewDecision` (no TTY), and
// the assertions check effects on disk (file contents, rejected.jsonl, lint), not counts.
// The accept test is the "fails before" test: against the pre-fix review.ts the fact is
// never written, so the on-disk assertion fails.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, STATE_DIR, loadConfig } from '../src/config.ts';
import { applyReviewDecision } from '../src/cli/review.ts';
import { candidateKey, rejectedPath, type PendingRecord } from '../src/consolidation/pending.ts';
import { main } from '../src/cli/main.ts';

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
    v: 1 as const,
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
});
