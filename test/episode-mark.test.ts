// Tests for the minimal, byte-preserving episode `consolidated:` edit (C1 fix).
// The vault is the source of truth and episodes are append-only: marking an episode
// consolidated must change exactly one line and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setConsolidatedDate, hasFencedFrontmatter } from '../src/vault/episode-mark.ts';
import { splitFrontmatter, parseFrontmatter } from '../src/vault/frontmatter.ts';
import { main } from '../src/cli/main.ts';

const VAULT = resolve(import.meta.dirname, '..', 'examples', 'vault');

/** Line-level diff: returns the lines only in `b` (added) and only in `a` (removed). */
function lineDiff(a: string, b: string): { added: string[]; removed: string[] } {
  const al = a.split('\n');
  const bl = b.split('\n');
  const aSet = new Map<string, number>();
  for (const l of al) aSet.set(l, (aSet.get(l) ?? 0) + 1);
  const bSet = new Map<string, number>();
  for (const l of bl) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [l, n] of bSet) {
    const d = n - (aSet.get(l) ?? 0);
    for (let i = 0; i < d; i++) added.push(l);
  }
  for (const [l, n] of aSet) {
    const d = n - (bSet.get(l) ?? 0);
    for (let i = 0; i < d; i++) removed.push(l);
  }
  return { added, removed };
}

const EPISODE = '---\ntype: episode\nstarted: 2026-08-11\nby: user\nsource: manual\nboundary: manual\nimportance: 0.7\n---\n# Migrated\n\nBody text.\n';

test('episode-mark: inserts exactly one line when no consolidated field exists', () => {
  const out = setConsolidatedDate(EPISODE, '2026-09-30');
  const { added, removed } = lineDiff(EPISODE, out);
  assert.deepEqual(removed, []);
  assert.deepEqual(added, ['consolidated: 2026-09-30']);
  // The inserted line sits immediately before the closing fence.
  const lines = out.split('\n');
  assert.equal(lines[lines.indexOf('consolidated: 2026-09-30') + 1], '---');
});

test('episode-mark: is idempotent', () => {
  const once = setConsolidatedDate(EPISODE, '2026-09-30');
  const twice = setConsolidatedDate(once, '2026-09-30');
  assert.equal(twice, once);
});

test('episode-mark: replaces an existing consolidated value and changes nothing else', () => {
  const raw = '---\ntype: episode\nconsolidated: 2026-01-01\nimportance: 0.7\n---\n# T\n';
  const out = setConsolidatedDate(raw, '2026-09-30');
  const { added, removed } = lineDiff(raw, out);
  assert.deepEqual(added, ['consolidated: 2026-09-30']);
  assert.deepEqual(removed, ['consolidated: 2026-01-01']);
  assert.equal(out.split('\n').length, raw.split('\n').length);
});

test('episode-mark: preserves quotes, comments, and block lists byte-for-byte', () => {
  const raw = '---\ntype: episode\nsource: "[[x]]"\n# a comment\ntags:\n  - alpha\n  - beta\n---\n# Body\n';
  const out = setConsolidatedDate(raw, '2026-09-30');
  const { added, removed } = lineDiff(raw, out);
  assert.deepEqual(removed, []);
  assert.deepEqual(added, ['consolidated: 2026-09-30']);
  assert.ok(out.includes('source: "[[x]]"'), 'quoted wikilink preserved');
  assert.ok(out.includes('# a comment'), 'comment preserved');
  assert.ok(out.includes('  - alpha') && out.includes('  - beta'), 'block list preserved');
});

test('episode-mark: output re-parses with type and consolidated intact', () => {
  const out = setConsolidatedDate(EPISODE, '2026-09-30');
  const { frontmatter } = splitFrontmatter(out);
  assert.ok(frontmatter !== null);
  const { data } = parseFrontmatter(frontmatter);
  assert.equal(data.type, 'episode');
  assert.equal(data.consolidated, '2026-09-30');
});

test('episode-mark: leaves a file with no fenced frontmatter unchanged', () => {
  const raw = '# No frontmatter\n\njust body\n';
  assert.equal(hasFencedFrontmatter(raw), false);
  assert.equal(setConsolidatedDate(raw, '2026-09-30'), raw);
});

test('episode-mark: end-to-end consolidate keeps lint clean and edits one line per episode', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'circadia-episode-mark-'));
  const v = join(tmp, 'vault');
  cpSync(VAULT, v, { recursive: true });

  assert.equal(await main(['index', '--vault', v]), 0);
  assert.equal(await main(['consolidate', '--vault', v, '--no-commit']), 0);
  assert.equal(await main(['lint', '--vault', v]), 0, 'lint must be clean after consolidation');

  // Every episode must differ from its original by exactly the consolidated line.
  const episodesDir = join(v, 'episodes');
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (name.endsWith('.md')) out.push(p);
    }
    return out;
  };
  const files = walk(episodesDir);
  assert.ok(files.length > 0, 'example vault has episodes');
  for (const file of files) {
    const rel = file.slice(v.length + 1);
    const before = readFileSync(join(VAULT, rel), 'utf8');
    const after = readFileSync(file, 'utf8');
    const { added, removed } = lineDiff(before, after);
    assert.deepEqual(removed, [], `${rel}: no lines removed`);
    assert.equal(added.length, 1, `${rel}: exactly one line added`);
    assert.match(added[0], /^consolidated: \d{4}-\d{2}-\d{2}$/, `${rel}: added line is consolidated`);
  }
});
