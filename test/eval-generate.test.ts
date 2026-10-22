// #21: derive a personal query set from a vault's own facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts';
import { generatePersonalQueries } from '../src/eval/generate-personal.ts';

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-eval-generate-'));
  mkdirSync(join(v, 'entities'), { recursive: true });
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify({ predicates: { strict: false, defs: { runs_on: { object: 'entity' } } } }),
  );
  writeFileSync(
    join(v, 'entities', 'x.md'),
    '---\ntype: entity\nkind: tool\n---\n# X\n\n## Facts\n' +
      '- [runs_on:: [[y]]] [valid:: 2026-01-01..2026-06-01] [by:: user]\n' +
      '- [runs_on:: [[z]]] [by:: user]\n' +
      '- [preference:: dark mode] [by:: user]\n',
  );
  writeFileSync(
    join(v, 'entities', 'y.md'),
    '---\ntype: entity\nkind: tool\n---\n# Y\n\nA tool.\n\n## Facts\n- [related_to:: [[z]]] [by:: user]\n',
  );
  writeFileSync(join(v, 'entities', 'z.md'), '---\ntype: entity\nkind: tool\n---\n# Z\n\nAnother tool.\n');
  return v;
}

test('#21: generate derives single-hop, multi-hop (with paraphrases + chains), temporal and preference', () => {
  const v = makeVault();
  const qs = generatePersonalQueries(v, loadConfig(v));
  const byKind = (k: string) => qs.filter((q) => q.kind === k);

  assert.ok(byKind('single-hop').some((q) => q.expected_passages.includes('y#0')), 'single-hop per entity');

  // multi-hop: the mechanical phrase and a natural paraphrase, both gold = object + facts.
  const mh = byKind('multi-hop');
  assert.ok(mh.some((q) => q.id === 'gen-mh-x-runs_on' && q.query === 'x runs on'), 'mechanical multi-hop phrase');
  assert.ok(mh.some((q) => q.query === 'x run on'), 'paraphrase variant');
  const gold = mh.find((q) => q.id === 'gen-mh-x-runs_on')?.expected_passages[0];
  assert.ok(Array.isArray(gold) && gold.includes('y#0') && gold.includes('x#facts'), 'gold is object + facts passage');

  // 2-hop chain x -> y -> z.
  assert.ok(mh.some((q) => q.id === 'gen-chain-x-y-related_to'), '2-hop chain query');

  const temp = byKind('temporal');
  assert.equal(temp.length, 1, 'only the fact with a world-time start yields a temporal query');
  assert.equal(temp[0].as_of, '2026-01-01', 'as_of is the interval start');

  const pref = byKind('preference');
  assert.ok(pref.some((q) => q.id === 'gen-pref-x-preference' && q.expected_passages.includes('x#facts')), 'prefer* predicate');

  // Deterministic.
  assert.deepEqual(generatePersonalQueries(v, loadConfig(v)), qs, 'same vault, same set');
});
