import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, splitFrontmatter } from '../src/vault/frontmatter.ts';
import { parseInterval, parseInstant, intervalContains } from '../src/vault/time.ts';
import { extractFields, parseFactLine, formatFact } from '../src/vault/facts.ts';
import { findWikiLinks, globToRegExp } from '../src/vault/util.ts';
import { parseNote } from '../src/vault/parse.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const ctx = { noteId: 'n', path: 'entities/x/n.md', line: 1, section: 'facts' as const, defaultRecordedAt: 0 };

test('frontmatter: scalars, inline + block lists, quoted wikilinks, bare key = null', () => {
  const { data, errors } = parseFrontmatter(
    ['type: entity', 'importance: 0.7', 'tags: [a, "b c"]', 'aliases:', '  - Project X', '  - px', 'src: "[[ep-1]]"', 'model:', 'ok: true'].join('\n'),
  );
  assert.deepEqual(errors, []);
  assert.equal(data.type, 'entity');
  assert.equal(data.importance, 0.7);
  assert.deepEqual(data.tags, ['a', 'b c']);
  assert.deepEqual(data.aliases, ['Project X', 'px']);
  assert.equal(data.src, '[[ep-1]]');
  assert.equal(data.model, null);
  assert.equal(data.ok, true);
});

test('frontmatter: nested maps are reported, not silently accepted', () => {
  const { errors } = parseFrontmatter('a:\n  b: 1');
  assert.equal(errors.length, 1);
});

test('splitFrontmatter tracks body line offset', () => {
  const r = splitFrontmatter('---\ntype: entity\n---\n# T\nbody');
  assert.equal(r.frontmatter, 'type: entity');
  assert.equal(r.bodyLineOffset, 3);
});

test('time: periods, half-open intervals, bare value means from', () => {
  assert.equal(parseInstant('2026-08'), Date.UTC(2026, 7, 1));
  const iv = parseInterval('2026-07..2026-08-11')!;
  assert.ok(intervalContains(iv, Date.UTC(2026, 7, 10)));
  assert.ok(!intervalContains(iv, Date.UTC(2026, 7, 11)));
  assert.deepEqual(parseInterval('2026-08'), { from: Date.UTC(2026, 7, 1), to: null });
  assert.deepEqual(parseInterval('..'), { from: null, to: null });
  assert.equal(parseInterval('2026-09..2026-08'), null, 'reversed interval rejected');
  assert.equal(parseInterval('soon..'), null);
});

test('wikilinks: alias, heading, path-qualified', () => {
  assert.deepEqual(findWikiLinks('see [[a|A]] and [[dir/b#Sec]] and ![[c]]'), [
    { target: 'a', alias: 'A' },
    { target: 'b', heading: 'Sec' },
    { target: 'c' },
  ]);
});

test('glob: ** and *', () => {
  assert.ok(globToRegExp('entities/people/**').test('entities/people/a/b.md'));
  assert.ok(globToRegExp('**/*.md').test('x.md'));
  assert.ok(!globToRegExp('entities/*.md').test('entities/a/b.md'));
});

test('fields: balanced brackets keep nested wikilinks intact', () => {
  const r = extractFields('[runs_on:: [[host|The Host]]] [by:: user] — note');
  assert.deepEqual(r.fields.map((f) => [f.key, f.value]), [
    ['runs_on', '[[host|The Host]]'],
    ['by', 'user'],
  ]);
  assert.equal(r.rest, '— note');
});

test('fact: full line with block id, provenance, trust default from by', () => {
  const { fact, problems } = parseFactLine(
    '- [runs_on:: [[pi]]] [valid:: 2026-08-11..] [at:: 2026-08-11] [by:: agent] [src:: [[ep-1]]] [conf:: 0.7] ^f-abc',
    ctx,
  );
  assert.deepEqual(problems, []);
  assert.ok(fact);
  assert.equal(fact.id, 'f-abc');
  assert.equal(fact.predicate, 'runs_on');
  assert.deepEqual(fact.object, { kind: 'link', link: { target: 'pi' } });
  assert.equal(fact.trust, 'medium');
  assert.equal(fact.conf, 0.7);
  assert.equal(fact.src?.target, 'ep-1');
  assert.equal(fact.status, 'current');
});

test('fact: strikethrough + superseded -> superseded status', () => {
  const { fact } = parseFactLine('- ~~[runs_on:: [[old]]] [valid:: 2026-06..2026-08]~~ [superseded:: 2026-08-11]', ctx);
  assert.equal(fact?.status, 'superseded');
  assert.equal(fact?.supersededAt, Date.UTC(2026, 7, 11));
});

test('fact: history section without superseded -> historical', () => {
  const { fact } = parseFactLine('- [status:: active] [valid:: 2026-01..2026-08]', { ...ctx, section: 'history' });
  assert.equal(fact?.status, 'historical');
});

test('fact: source monitoring — agent/tool/web facts must cite src', () => {
  const { problems } = parseFactLine('- [status:: active] [by:: web]', ctx);
  assert.ok(problems.some((p) => p.code === 'fact.missing-src' && p.severity === 'error'));
});

test('fact: exactly one predicate', () => {
  assert.ok(parseFactLine('- [valid:: 2026]', ctx).problems.some((p) => p.code === 'fact.no-predicate'));
  assert.ok(parseFactLine('- [a:: 1] [b:: 2]', ctx).problems.some((p) => p.code === 'fact.multiple-predicates'));
});

test('fact: arrow form of valid is accepted', () => {
  const { fact } = parseFactLine('- [status:: active] [valid:: 2026-06 → 2026-08]', ctx);
  assert.equal(fact?.valid.to, Date.UTC(2026, 7, 1));
});

test('fact: formatFact round-trips through the parser', () => {
  const { fact } = parseFactLine('- [runs_on:: [[pi]]] [valid:: 2026-08-11..] [at:: 2026-08-11] [by:: agent] [src:: [[ep]]] ^f-1', ctx);
  const line = formatFact(fact!);
  const again = parseFactLine(line, ctx).fact!;
  assert.deepEqual({ ...again, raw: '', line: 0 }, { ...fact!, raw: '', line: 0 });
});

test('note: passages split by heading; facts section parsed, not prose', () => {
  const md = [
    '---',
    'type: entity',
    'kind: project',
    'aliases: [PX]',
    '---',
    '# Project X',
    'Uses [[a]].',
    '## Design',
    'Talks to [[b]].',
    '```',
    '[[not-a-link]]',
    '```',
    '## Facts',
    '- [depends_on:: [[a]]] [by:: user]',
    '## History',
    '- ~~[depends_on:: [[c]]]~~ [superseded:: 2026-01-01]',
  ].join('\n');
  const n = parseNote('entities/projects/project-x.md', md, 0, DEFAULT_CONFIG);
  assert.deepEqual(n.problems, []);
  assert.equal(n.title, 'Project X');
  assert.deepEqual(
    n.passages.map((p) => [p.id, p.kind]),
    [
      ['project-x#0', 'prose'],
      ['project-x#1', 'prose'],
      ['project-x#facts', 'facts'],
    ],
  );
  assert.deepEqual(
    n.links.map((l) => [l.link.target, l.passage]),
    [
      ['a', 'project-x#0'],
      ['b', 'project-x#1'],
    ],
    'links in code fences and fact lines are not prose links',
  );
  assert.equal(n.facts.length, 2);
  assert.equal(n.facts[1].status, 'superseded');
});

test('note: missing required fields are errors', () => {
  const n = parseNote('episodes/e.md', '---\ntype: episode\n---\nhi', 0, DEFAULT_CONFIG);
  const codes = n.problems.filter((p) => p.severity === 'error').map((p) => p.message);
  assert.ok(codes.some((m) => m.includes('"started"')));
  assert.ok(codes.some((m) => m.includes('"by"')));
});
