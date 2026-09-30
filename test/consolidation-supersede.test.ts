import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatFact, parseFactLine } from '../src/vault/facts.ts';
import { applySupersede } from '../src/consolidation/supersede.ts';
import type { Fact } from '../src/types.ts';

describe('supersede', () => {
  test('strikes old fact and adds superseded date', () => {
    const oldFact: Fact = {
      id: 'f-1',
      predicate: 'runs_on',
      object: { kind: 'literal', value: 'server-a' },
      valid: { from: null, to: null },
      recordedAt: Date.now(),
      supersededAt: null,
      by: 'agent',
      trust: 'medium',
      conf: 1,
      src: { target: 'episode-1' },
      status: 'current',
      comment: null,
      line: 0,
      raw: '',
    };

    const line = formatFact(oldFact);
    const ctx = {
      noteId: 'test-note',
      path: 'test.md',
      line: 1,
      section: 'facts' as const,
      defaultRecordedAt: Date.now(),
    };
    const parsed = parseFactLine(line, ctx);

    if (!parsed.fact) throw new Error('Failed to parse fact');

    // Strike it
    const supersededFact: Fact = {
      ...parsed.fact,
      supersededAt: Date.now(),
      status: 'superseded',
    };

    const supersededLine = formatFact(supersededFact);
    if (!supersededLine.includes('~~')) throw new Error('Should include strikethrough');
    if (!supersededLine.includes('superseded')) throw new Error('Should include superseded date');
  });

  test('formatFact produces canonical output', () => {
    const f: Fact = {
      id: 'f-test',
      predicate: 'located_in',
      object: { kind: 'link', link: { target: 'california' } },
      valid: { from: Date.parse('2024-01-01'), to: null },
      recordedAt: Date.parse('2024-01-15'),
      supersededAt: null,
      by: 'user',
      trust: 'high',
      conf: 1,
      src: null,
      status: 'current',
      comment: 'updated in Q1',
      line: 5,
      raw: '',
    };

    const line = formatFact(f);
    if (!line.includes('located_in')) throw new Error('Should include predicate');
    if (!line.includes('[[california]]')) throw new Error('Should include wikilink');
    if (!line.includes('valid:: 2024-01-01..')) throw new Error('Should include valid range');
    if (!line.includes('at:: 2024-01-15')) throw new Error('Should include at date');
    if (!line.includes('^f-test')) throw new Error('Should include id');
  });

  test('C22: refuses to close a fact before its valid interval starts', () => {
    const content =
      '---\ntype: entity\nkind: project\n---\n# x\n\n## Facts\n' +
      '- [runs_on:: [[new-host]]] [valid:: 2026-09-20..] [at:: 2026-09-20] [by:: user] ^f-x-new\n';
    const r = applySupersede(content, {
      path: 'x.md',
      supersededAt: Date.parse('2026-09-25'),
      validAt: Date.parse('2026-09-10'),
      newFact: {
        id: 'f-x-old',
        predicate: 'runs_on',
        object: { kind: 'link', link: { target: 'old-host' } },
        valid: { from: Date.parse('2026-09-10'), to: null },
        recordedAt: Date.parse('2026-09-25'),
        supersededAt: null,
        by: 'agent',
        trust: 'high',
        conf: 0.9,
        src: { target: '2026-09-10-old' },
        status: 'current',
        comment: null,
      },
    });
    assert.equal(r.changed, false, 'a backwards interval must not be written');
    assert.equal(r.content, content, 'the note is left byte-identical');
    assert.ok(r.problems.some((p) => p.code === 'supersede.backwards-interval'));
  });
});
