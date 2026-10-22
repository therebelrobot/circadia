// Unit tests for additive corroboration: the source weights, the conf curve, and the
// schema-fit gate's corroboration branch. The end-to-end behavior is in
// test/consolidation-corroboration.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.ts';
import { sourceWeight, confForSupport, strengthenConf } from '../src/vault/facts.ts';
import { evaluateGate } from '../src/consolidation/schema.ts';
import type { Candidate } from '../src/consolidation/candidate.ts';
import type { NoteRef } from '../src/consolidation/entity.ts';
import type { Fact } from '../src/types.ts';

function cfg(corroboration: boolean, minSupport = 2): Config {
  return { ...DEFAULT_CONFIG, consolidation: { corroboration, corroborationMinSupport: minSupport } };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    subject: 'alpha',
    predicate: 'runs_on',
    object: 'delta',
    valid: true,
    explicit: true,
    origin: 'episode',
    episodeId: 'e1',
    confidence: 0.9,
    by: 'agent',
    trust: 'medium',
    ...over,
  };
}

const alphaRef: NoteRef = { id: 'alpha', title: 'alpha', path: 'entities/alpha.md' };

test('corroboration weights: a human assertion counts double an agent', () => {
  assert.equal(sourceWeight('user'), 2);
  assert.equal(sourceWeight('import'), 2);
  assert.equal(sourceWeight('agent'), 1);
  assert.equal(sourceWeight('tool'), 0);
  assert.equal(sourceWeight('web'), 0);
});

test('conf curve: one agent unit is 0.5, each further unit +0.25, capped at 1', () => {
  assert.equal(confForSupport(1), 0.5);
  assert.equal(confForSupport(2), 0.75);
  assert.equal(confForSupport(3), 1);
  assert.equal(confForSupport(9), 1);
});

test('strengthening: a human episode moves conf further than an agent episode', () => {
  assert.equal(strengthenConf(0.5, 'agent'), 0.625);
  assert.equal(strengthenConf(0.5, 'user'), 0.75);
  assert.equal(strengthenConf(1, 'user'), 1);
});

test('gate: a new-entity claim queues unless corroborated, then promotes', () => {
  const c = candidate();
  const off = evaluateGate(c, cfg(false), null, null, [], null, 5);
  assert.equal(off.action, 'queue');

  const one = evaluateGate(c, cfg(true), null, null, [], null, 1);
  assert.equal(one.action, 'queue', 'one agent unit is below the threshold');

  const two = evaluateGate(c, cfg(true), null, null, [], null, 2);
  assert.equal(two.action, 'promote');
  assert.match(two.reason, /corroborated/);
});

test('gate: corroboration never rescues an untrusted source', () => {
  const web = candidate({ by: 'web', trust: 'low' });
  const d = evaluateGate(web, cfg(true), null, null, [], null, 99);
  assert.equal(d.action, 'queue');
  assert.equal(d.reason, 'untrusted source');
});

test('gate: corroboration never overrides a contradiction', () => {
  const current: Fact[] = [
    {
      id: 'f-x',
      predicate: 'runs_on',
      object: { kind: 'literal', value: 'delta' },
      valid: { from: null, to: null },
      recordedAt: null,
      supersededAt: null,
      by: 'agent',
      trust: 'medium',
      conf: 1,
      src: null,
      status: 'current',
      comment: null,
      line: 1,
      raw: '',
    },
  ];
  const cfgSingle: Config = {
    ...cfg(true),
    predicates: { strict: false, defs: { runs_on: { object: 'entity', cardinality: 'single' } } },
  };
  const contradiction = candidate({ object: 'epsilon' });
  const d = evaluateGate(contradiction, cfgSingle, alphaRef, null, current, null, 99);
  assert.equal(d.action, 'queue', 'a single-valued contradiction still queues');
  assert.match(d.reason, /contradicts/);
});
