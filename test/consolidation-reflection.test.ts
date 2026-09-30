import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe, before, after } from 'node:test';
import { reflect } from '../src/consolidation/reflection.ts';
import type { Fact } from '../src/types.ts';

describe('reflection', () => {
  const testVault = '/tmp/test-vault-' + Date.now();
  const schemaDir = join(testVault, 'schemas');

  before(() => {
    mkdirSync(schemaDir, { recursive: true });
  });

  after(() => {
    rmSync(testVault, { recursive: true, force: true });
  });

  test('generates schema note when importance exceeds threshold', () => {
    const facts: Fact[] = [
      {
        id: 'f-1',
        predicate: 'runs_on',
        object: { kind: 'literal', value: 'server-a' },
        valid: { from: null, to: null },
        recordedAt: Date.now(),
        supersededAt: null,
        by: 'agent',
        trust: 'medium',
        conf: 1,
        src: { target: 'ep-1' },
        status: 'current',
        comment: null,
        line: 0,
        raw: '',
      },
      {
        id: 'f-2',
        predicate: 'depends_on',
        object: { kind: 'link', link: { target: 'database' } },
        valid: { from: null, to: null },
        recordedAt: Date.now(),
        supersededAt: null,
        by: 'agent',
        trust: 'medium',
        conf: 1,
        src: { target: 'ep-2' },
        status: 'current',
        comment: null,
        line: 0,
        raw: '',
      },
    ];

    const result = reflect(testVault, 'orchard-sensors', facts, 1);

    if (!result?.changed) throw new Error('Should generate schema note');

    const schemaPath = join(testVault, 'schemas', 'orchard-sensors-overview.md');
    const content = readFileSync(schemaPath, 'utf8');

    if (!content.includes('derived: true')) throw new Error('Should have derived flag');
    if (!content.includes('sources:')) throw new Error('Should have sources');
    if (!content.includes('runs_on')) throw new Error('Should include facts');
  });

  test('returns null when importance below threshold', () => {
    const facts: Fact[] = [
      {
        id: 'f-3',
        predicate: 'has_status',
        object: { kind: 'literal', value: 'active' },
        valid: { from: null, to: null },
        recordedAt: Date.now(),
        supersededAt: null,
        by: 'agent',
        trust: 'medium',
        conf: 0.5,
        src: { target: 'ep-3' },
        status: 'current',
        comment: null,
        line: 0,
        raw: '',
      },
    ];

    const result = reflect(testVault, 'test-entity', facts, 10);

    if (result !== null) throw new Error('Should return null below threshold');
  });

  test('includes sources from facts', () => {
    const facts: Fact[] = [
      {
        id: 'f-4',
        predicate: 'located_in',
        object: { kind: 'literal', value: 'us' },
        valid: { from: null, to: null },
        recordedAt: Date.now(),
        supersededAt: null,
        by: 'agent',
        trust: 'medium',
        conf: 1,
        src: { target: 'ep-4' },
        status: 'current',
        comment: null,
        line: 0,
        raw: '',
      },
    ];

    const result = reflect(testVault, 'test-entity2', facts, 1);

    if (!result?.changed) throw new Error('Should generate schema note');

    const schemaPath = join(testVault, 'schemas', 'test-entity2-overview.md');
    const content = readFileSync(schemaPath, 'utf8');

    if (!content.includes('[[ep-4]]')) throw new Error('Should include source in sources');
  });

  test('C21: a human edit to the generated body survives a re-run (no git required)', () => {
    const facts: Fact[] = [
      {
        id: 'f-5',
        predicate: 'runs_on',
        object: { kind: 'literal', value: 'server-b' },
        valid: { from: null, to: null },
        recordedAt: Date.now(),
        supersededAt: null,
        by: 'agent',
        trust: 'medium',
        conf: 1,
        src: { target: 'ep-5' },
        status: 'current',
        comment: null,
        line: 0,
        raw: '',
      },
    ];

    // First generation records a content hash in the frontmatter.
    const first = reflect(testVault, 'human-edit-entity', facts, 1);
    if (!first?.changed) throw new Error('Should generate schema note');
    const schemaPath = join(testVault, 'schemas', 'human-edit-entity-overview.md');
    const generated = readFileSync(schemaPath, 'utf8');
    if (!generated.includes('generated_hash:')) throw new Error('Should record generated_hash');

    // A human edits the body (the test vault is not a git repo, so this proves the
    // detection works without git).
    writeFileSync(schemaPath, generated.replace('## Facts', '## Facts\n\nHuman note: keep this.'));

    // Re-running with the same facts must not overwrite the human edit.
    const second = reflect(testVault, 'human-edit-entity', facts, 1);
    if (second?.changed !== false) throw new Error('Should not regenerate over a human edit');
    if (second?.hasHumanEdits !== true) throw new Error('Should report human edits');
    const after = readFileSync(schemaPath, 'utf8');
    if (!after.includes('Human note: keep this.')) throw new Error('Human edit must survive');
  });
});
