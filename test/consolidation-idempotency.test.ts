// Regression tests for C6 (idempotency), C7 (side-effect-free dry run), C8 (scoped
// commit), and C23 (fact ids + wikilink stripping).
//
// Every assertion is on-disk (file bytes, git state), not on counts alone. Each test
// fails against the pre-fix code:
//   - C6: the old code re-appended the triple every run (pending.jsonl grew).
//   - C6 rejected: rejected.jsonl did not exist and was never consulted.
//   - C7: the old dry run wrote pending.jsonl and ran `git add -A`.
//   - C8: the old commit ran `git add -A`, sweeping in the unrelated edit.
//   - C23: the old object stripper was a character-class regex, not the wikilink parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONFIG_FILENAME, STATE_DIR, loadConfig } from '../src/config.ts';
import { consolidate, buildFact } from '../src/consolidation/consolidate.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { writeTriples } from '../src/extract/triples.ts';
import { appendRecords, rejectedPath, pendingPath, type PendingRecord } from '../src/consolidation/pending.ts';
import type { Candidate } from '../src/consolidation/candidate.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-consolidation-idem-'));

const CONFIG = {
  extraction: { provider: 'none' },
  predicates: { strict: false, defs: { runs_on: { object: 'entity', cardinality: 'single' } } },
};

function makeVault(name: string, files: Record<string, string>): string {
  const v = join(tmp, name);
  mkdirSync(v, { recursive: true });
  writeFileSync(join(v, CONFIG_FILENAME), JSON.stringify(CONFIG));
  for (const [p, content] of Object.entries(files)) {
    const abs = join(v, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return v;
}

function entityNote(id: string, body: string): string {
  return `---\ntype: entity\nkind: project\n---\n# ${id}\n\n${body}`;
}

function episodeNote(by: string, text: string): string {
  return `---\ntype: episode\nstarted: 2026-09-20T10:00:00-04:00\nsource: chat\nby: ${by}\nboundary: manual\nimportance: 0.5\n---\n# Episode\n\n${text}\n`;
}

/** All vault files as `relpath:base64`, excluding the derived index and .git. */
function snapshotVault(vault: string): string[] {
  const out: string[] = [];
  for (const rel of readdirSync(vault, { recursive: true, encoding: 'utf8' }) as string[]) {
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    if (rel.includes('index.sqlite')) continue;
    const abs = join(vault, rel);
    if (!statSync(abs).isFile()) continue;
    out.push(`${rel}:${readFileSync(abs).toString('base64')}`);
  }
  return out.sort();
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(vault: string): void {
  git(vault, ['init', '-q']);
  git(vault, ['config', 'user.email', 't@example.com']);
  git(vault, ['config', 'user.name', 't']);
  // Keep the derived index out of git so `git status` reflects only vault content.
  writeFileSync(join(vault, '.gitignore'), `${STATE_DIR}/index.sqlite*\n`);
}

function commitAll(vault: string, message: string): void {
  git(vault, ['add', '-A']);
  git(vault, ['commit', '-qm', message]);
}

/** A vault with a triple candidate that the promotion path re-proposes every run. */
function tripleVault(name: string): string {
  const v = makeVault(name, {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  writeTriples(v, 'x', [
    { passageId: 'x#0', contentHash: 'h1', subject: 'x', predicate: 'runs_on', object: 'y', conf: 0.9 },
  ]);
  return v;
}

test('C6: running consolidation twice is byte-identical (vault + pending.jsonl)', async () => {
  const v = tripleVault('c6-idem');
  const cfg = loadConfig(v);

  const first = await consolidate(v, cfg);
  assert.equal(first.queued, 1, 'the triple must queue on the first run');

  const pending = pendingPath(v);
  const pending1 = readFileSync(pending, 'utf8');
  assert.equal(pending1.trim().split('\n').length, 1, 'exactly one pending line after run 1');
  const snapshot1 = snapshotVault(v);

  const second = await consolidate(v, cfg);
  assert.equal(second.queued, 0, 'an unchanged triple must not be re-queued');

  assert.deepEqual(snapshotVault(v), snapshot1, 'every vault file must be byte-identical');
  assert.equal(readFileSync(pending, 'utf8'), pending1, 'pending.jsonl must be byte-identical');
});

test('C6: pending dedup holds even when the triple is re-proposed', async () => {
  const v = tripleVault('c6-pending-dedup');
  const cfg = loadConfig(v);

  await consolidate(v, cfg);
  const pending = pendingPath(v);
  const pending1 = readFileSync(pending, 'utf8');

  // Force the promotion path to re-propose the triple by clearing the seen-hash state.
  rmSync(join(v, STATE_DIR, 'triples-seen.json'));

  const second = await consolidate(v, cfg);
  assert.equal(second.queued, 0, 'the pending key must suppress a re-proposal');
  assert.equal(readFileSync(pending, 'utf8'), pending1, 'pending.jsonl must not grow');
});

test('C6: a rejected key goes to rejected.jsonl and does not reappear', async () => {
  const v = tripleVault('c6-rejected');
  const cfg = loadConfig(v);

  await consolidate(v, cfg);
  const pending = pendingPath(v);
  const record = JSON.parse(readFileSync(pending, 'utf8').trim()) as PendingRecord;
  assert.ok(record.key, 'the pending record must carry a stable key');

  // Simulate `circadia review` rejecting the candidate.
  appendRecords(rejectedPath(v), [record]);
  assert.ok(readFileSync(rejectedPath(v), 'utf8').includes(record.key), 'rejection must be recorded');

  // Force re-proposal, then confirm the rejected key is skipped.
  rmSync(join(v, STATE_DIR, 'triples-seen.json'));
  const second = await consolidate(v, cfg);
  assert.equal(second.queued, 0, 'a rejected candidate must not be re-queued');
  assert.equal(readFileSync(pending, 'utf8').trim().split('\n').length, 1, 'pending.jsonl must not grow');
});

test('C7: a dry run leaves the vault and the git index byte-identical', async () => {
  const v = tripleVault('c7-dry');
  const cfg = loadConfig(v);
  initRepo(v);
  commitAll(v, 'init');

  const before = snapshotVault(v);
  const statusBefore = git(v, ['status', '--porcelain']);

  const result = await consolidate(v, cfg, { dryRun: true });

  assert.ok(result.diff && result.diff.length > 0, 'a dry run with changes must print a non-empty diff');
  assert.ok(result.diff!.includes('+++ b/.circadia/pending.jsonl'), 'the diff must name the pending file');
  assert.deepEqual(snapshotVault(v), before, 'a dry run must not change any file');
  assert.equal(git(v, ['status', '--porcelain']), statusBefore, 'a dry run must not touch the git index');
});

test('C8: a commit touches only the run paths, not an unrelated user edit', async () => {
  const v = makeVault('c8-commit', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
    'entities/people/sam.md': entityNote('sam', ''),
    'episodes/2026/09/2026-09-20-move.md': episodeNote('user', 'We moved x to y.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  initRepo(v);
  commitAll(v, 'init');

  // An unrelated user edit that must NOT be swept into the consolidation commit.
  writeFileSync(join(v, 'entities/people/sam.md'), entityNote('sam', 'unrelated user edit\n'));

  // A triple so the run has something to queue and commit.
  writeTriples(v, 'x', [
    { passageId: 'x#0', contentHash: 'h1', subject: 'x', predicate: 'runs_on', object: 'y', conf: 0.9 },
  ]);

  const result = await consolidate(v, cfg, { commit: true });
  assert.ok(result.queued >= 1, 'the triple must queue');

  const committed = git(v, ['show', '--name-only', '--format=', 'HEAD']);
  assert.ok(committed.includes('.circadia/pending.jsonl'), 'the run must commit its pending file');
  assert.ok(committed.includes('episodes/2026/09/2026-09-20-move.md'), 'the run must commit the marked episode');
  assert.ok(!committed.includes('entities/people/sam.md'), 'the unrelated edit must not be committed');

  // The unrelated edit is still uncommitted.
  assert.ok(git(v, ['status', '--porcelain']).includes('entities/people/sam.md'));
});

test('C8: refuses to commit when a run path was already dirty before the run', async () => {
  const v = makeVault('c8-predirty', {
    'entities/projects/x.md': entityNote('x', '## Facts\n- [status:: active] [by:: user]\n'),
    'entities/tools/y.md': entityNote('y', ''),
    'episodes/2026/09/2026-09-20-move.md': episodeNote('user', 'We moved x to y.'),
  });
  const cfg = loadConfig(v);
  buildIndex(v, cfg);
  initRepo(v);
  commitAll(v, 'init');
  const headBefore = git(v, ['rev-parse', 'HEAD']).trim();

  // Dirty a path the run will write (the episode it is about to mark).
  writeFileSync(join(v, 'episodes/2026/09/2026-09-20-move.md'), episodeNote('user', 'We moved x to y. (edited)\n'));

  writeTriples(v, 'x', [
    { passageId: 'x#0', contentHash: 'h1', subject: 'x', predicate: 'runs_on', object: 'y', conf: 0.9 },
  ]);

  await consolidate(v, cfg, { commit: true });

  assert.equal(git(v, ['rev-parse', 'HEAD']).trim(), headBefore, 'no commit may be created when a run path was dirty');
});

test('C23: buildFact strips wikilinks with the parser and hashes the fact id', () => {
  const base: Omit<Candidate, 'subject' | 'object'> = {
    predicate: 'runs_on',
    valid: true,
    explicit: true,
    origin: 'episode',
    episodeId: 'ep',
    confidence: 1,
    by: 'user',
    trust: 'high',
  };

  // A resolved object becomes a link to the resolved note id.
  const resolved = buildFact({ ...base, subject: 'x', object: '[[entity]]' }, 'x', 'entity', null, null);
  assert.deepEqual(resolved.object, { kind: 'link', link: { target: 'entity' } });

  // An unresolved `[[entity]]` becomes a literal with the brackets stripped.
  const plain = buildFact({ ...base, subject: 'x', object: '[[entity]]' }, 'x', null, null, null);
  assert.deepEqual(plain.object, { kind: 'literal', value: 'entity' });

  // An alias is stripped: `[[entity|alias]]` -> `entity`.
  const aliased = buildFact({ ...base, subject: 'x', object: '[[entity|alias]]' }, 'x', null, null, null);
  assert.deepEqual(aliased.object, { kind: 'literal', value: 'entity' });

  // A literal object is left untouched.
  const literal = buildFact({ ...base, subject: 'x', object: 'a literal value' }, 'x', null, null, null);
  assert.deepEqual(literal.object, { kind: 'literal', value: 'a literal value' });

  // The id is a content hash, stable across calls (never Date.now()).
  const a = buildFact({ ...base, subject: 'x', object: '[[entity]]' }, 'x', 'entity', 1000, 2000);
  const b = buildFact({ ...base, subject: 'x', object: '[[entity]]' }, 'x', 'entity', 1000, 2000);
  assert.equal(a.id, b.id, 'the fact id must be deterministic');
  assert.match(a.id, /^f-[0-9a-f]{10}$/, 'the fact id must be a content hash');
});
