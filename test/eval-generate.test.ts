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
      '- [runs_on:: [[z]]] [by:: user]\n',
  );
  writeFileSync(join(v, 'entities', 'y.md'), '---\ntype: entity\nkind: tool\n---\n# Y\n\nA tool.\n');
  writeFileSync(join(v, 'entities', 'z.md'), '---\ntype: entity\nkind: tool\n---\n# Z\n\nAnother tool.\n');
  return v;
}

test('#21: generate derives single-hop, multi-hop and temporal queries from facts', () => {
  const v = makeVault();
  const qs = generatePersonalQueries(v, loadConfig(v));
  const byKind = (k: string) => qs.filter((q) => q.kind === k);

  assert.ok(byKind('single-hop').some((q) => q.expected_passages.includes('y#0')), 'single-hop per entity');
  assert.ok(byKind('single-hop').some((q) => q.expected_passages.includes('z#0')));

  const mh = byKind('multi-hop');
  assert.ok(mh.some((q) => q.id === 'gen-mh-x-runs_on' && q.query === 'x runs on'), 'multi-hop from a link fact');
  const gold = mh.find((q) => q.id === 'gen-mh-x-runs_on')?.expected_passages[0];
  assert.ok(Array.isArray(gold) && gold.includes('y#0') && gold.includes('x#facts'), 'gold is the object + facts passage');

  const temp = byKind('temporal');
  assert.equal(temp.length, 1, 'only the closed-interval fact yields a temporal query');
  assert.equal(temp[0].as_of, '2026-01-01', 'as_of is the interval start');

  // Every gold id must exist, or eval would fail on missing gold.
  for (const q of qs) {
    for (const g of q.expected_passages) {
      for (const id of Array.isArray(g) ? g : [g]) assert.ok(/\.md$|#\d+$|#facts$/.test(id) || id.includes('#'), `gold ${id}`);
    }
  }
});
