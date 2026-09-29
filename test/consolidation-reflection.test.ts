import { readFileSync, mkdirSync, rmSync } from 'node:fs';
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
});
