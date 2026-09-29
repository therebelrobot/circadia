// Consolidation tests (Phase 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';

const tmp = mkdtempSync(join(tmpdir(), 'palimpsest-test-'));

test('consolidation: empty vault produces empty result', async () => {
  const v = join(tmp, 'empty-vault');
  mkdirSync(v, { recursive: true });
  writeFileSync(join(v, 'palimpsest.config.json'), JSON.stringify({
    vault: { factsHeading: '## Facts', historyHeading: '## History', ignore: [] },
    index: { path: '.palimpsest/index.sqlite', accessLog: '.palimpsest/access.jsonl' },
    graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'auto', auto: { ladder: ['typed', 'wikilink'], minTopMargin: 0.1, minSeeds: 2, multiEntityThreshold: 2 } }, originWeights: { contains: 1, link: 1, fact: 1, provenance: 1, triple: 1, synonym: 1 }, damping: 0.5, maxIterations: 100, tolerance: 0.001 },
    retrieval: { topK: 20, tokenBudget: 5000, seedLimit: 10, weights: { graph: 0.6, activation: 0.25, importance: 0.15 }, actrDecay: 0.5, actrThresholdDays: 14, actrNoise: 0.3, trustFloor: 'low', includeSuperseded: false, logAccess: true },
    embeddings: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 },
    extraction: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null },
    predicates: { strict: false, defs: {} },
  }));
  mkdirSync(join(v, 'episodes'), { recursive: true });
  const cfg = loadConfig(v);
  const result = await consolidate(v, cfg, { dryRun: true });
  assert.equal(result.promoted, 0);
  assert.equal(result.queued, 0);
  assert.ok(result.processedEpisodes.length === 0);
});

test('consolidation: episode without consolidated date is selected', async () => {
  const v = join(tmp, 'episode-vault');
  mkdirSync(join(v, 'episodes', '2026', '09'), { recursive: true });
  writeFileSync(join(v, 'palimpsest.config.json'), JSON.stringify({
    vault: { factsHeading: '## Facts', historyHeading: '## History', ignore: [] },
    index: { path: '.palimpsest/index.sqlite', accessLog: '.palimpsest/access.jsonl' },
    graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'auto', auto: { ladder: ['typed'], minTopMargin: 0.1, minSeeds: 2, multiEntityThreshold: 2 } }, originWeights: { contains: 1, link: 1, fact: 1, provenance: 1, triple: 1, synonym: 1 }, damping: 0.5, maxIterations: 100, tolerance: 0.001 },
    retrieval: { topK: 20, tokenBudget: 5000, seedLimit: 10, weights: { graph: 0.6, activation: 0.25, importance: 0.15 }, actrDecay: 0.5, actrThresholdDays: 14, actrNoise: 0.3, trustFloor: 'low', includeSuperseded: false, logAccess: true },
    embeddings: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 },
    extraction: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null },
    predicates: { strict: false, defs: {} },
  }));
  writeFileSync(join(v, 'episodes', '2026', '09', '2026-09-15-test.md'),
    '---\ntype: episode\nstarted: 2026-09-15\nby: user\nsource: chat\nboundary: topic-shift\nimportance: 0.5\n---\n# Test\n');
  const cfg = loadConfig(v);
  const result = await consolidate(v, cfg, { dryRun: true });
  assert.equal(result.processedEpisodes.length, 1);
});

test('consolidation: marked episode is not selected', async () => {
  const v = join(tmp, 'marked-vault');
  mkdirSync(join(v, 'episodes', '2026', '09'), { recursive: true });
  writeFileSync(join(v, 'palimpsest.config.json'), JSON.stringify({
    vault: { factsHeading: '## Facts', historyHeading: '## History', ignore: [] },
    index: { path: '.palimpsest/index.sqlite', accessLog: '.palimpsest/access.jsonl' },
    graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'auto', auto: { ladder: ['typed'], minTopMargin: 0.1, minSeeds: 2, multiEntityThreshold: 2 } }, originWeights: { contains: 1, link: 1, fact: 1, provenance: 1, triple: 1, synonym: 1 }, damping: 0.5, maxIterations: 100, tolerance: 0.001 },
    retrieval: { topK: 20, tokenBudget: 5000, seedLimit: 10, weights: { graph: 0.6, activation: 0.25, importance: 0.15 }, actrDecay: 0.5, actrThresholdDays: 14, actrNoise: 0.3, trustFloor: 'low', includeSuperseded: false, logAccess: true },
    embeddings: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 },
    extraction: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null },
    predicates: { strict: false, defs: {} },
  }));
  writeFileSync(join(v, 'episodes', '2026', '09', '2026-09-16-marked.md'),
    '---\ntype: episode\nstarted: 2026-09-16\nby: user\nsource: chat\nboundary: topic-shift\nconsolidated: 2026-09-16\nimportance: 0.5\n---\n# Marked\n');
  const cfg = loadConfig(v);
  const result = await consolidate(v, cfg, { dryRun: true });
  assert.equal(result.processedEpisodes.length, 0);
});

test('consolidation: extracts candidates from episodes', async () => {
  const v = join(tmp, 'candidate-vault');
  mkdirSync(join(v, 'episodes'), { recursive: true });
  writeFileSync(join(v, 'palimpsest.config.json'), JSON.stringify({
    vault: { factsHeading: '## Facts', historyHeading: '## History', ignore: [] },
    index: { path: '.palimpsest/index.sqlite', accessLog: '.palimpsest/access.jsonl' },
    graph: { defaultExtraction: 'typed', scopes: [], query: { mode: 'auto', auto: { ladder: ['typed'], minTopMargin: 0.1, minSeeds: 2, multiEntityThreshold: 2 } }, originWeights: { contains: 1, link: 1, fact: 1, provenance: 1, triple: 1, synonym: 1 }, damping: 0.5, maxIterations: 100, tolerance: 0.001 },
    retrieval: { topK: 20, tokenBudget: 5000, seedLimit: 10, weights: { graph: 0.6, activation: 0.25, importance: 0.15 }, actrDecay: 0.5, actrThresholdDays: 14, actrNoise: 0.3, trustFloor: 'low', includeSuperseded: false, logAccess: true },
    embeddings: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 },
    extraction: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null },
    predicates: { strict: false, defs: { runs_on: { object: 'entity' } } },
  }));
  writeFileSync(join(v, 'episodes', '2026-09-17.md'),
    '---\ntype: episode\nstarted: 2026-09-17\nby: user\nsource: chat\nboundary: topic-shift\nimportance: 0.5\n---\n# Standup\n');
  const cfg = loadConfig(v);
  const result = await consolidate(v, cfg, { dryRun: true });
  // With provider=none, no candidates extracted
  assert.equal(result.promoted, 0);
  assert.equal(result.queued, 0);
});
