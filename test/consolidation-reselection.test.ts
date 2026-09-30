// C22: episode re-selection. An episode with a valid `consolidated:` date is re-processed
// when its file mtime is newer than the consolidated day; an untouched episode is not.
//
// Decision (C22): a newer mtime means a manual fix (or C1-style damage), not a new event —
// episodes are append-only, so a legitimate new event is a new file. The comparison is
// against the END of the consolidated local day, so the mtime consolidation itself sets on
// the same day does not re-select the episode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, STATE_DIR, loadConfig } from '../src/config.ts';
import { consolidate } from '../src/consolidation/consolidate.ts';

const CONFIG = {
  vault: { factsHeading: '## Facts', historyHeading: '## History', ignore: [] },
  index: { path: `${STATE_DIR}/index.sqlite`, accessLog: `${STATE_DIR}/access.jsonl` },
  graph: {
    defaultExtraction: 'typed',
    scopes: [],
    query: { mode: 'auto', auto: { ladder: ['typed'], minTopMargin: 0.1, minSeeds: 2, multiEntityThreshold: 2 } },
    originWeights: { contains: 1, link: 1, fact: 1, provenance: 1, triple: 1, synonym: 1 },
    damping: 0.5,
    maxIterations: 100,
    tolerance: 0.001,
  },
  retrieval: {
    topK: 20,
    tokenBudget: 5000,
    seedLimit: 10,
    weights: { graph: 0.6, activation: 0.25, importance: 0.15 },
    actrDecay: 0.5,
    actrThresholdDays: 14,
    actrNoise: 0.3,
    trustFloor: 'low',
    includeSuperseded: false,
    logAccess: true,
  },
  embeddings: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null, batchSize: 8 },
  extraction: { provider: 'none', endpoint: '', model: '', apiKeyEnv: null },
  predicates: { strict: false, defs: {} },
};

function episode(consolidated: string): string {
  return `---\ntype: episode\nstarted: 2026-09-16\nby: user\nsource: chat\nboundary: topic-shift\nconsolidated: ${consolidated}\nimportance: 0.5\n---\n# Episode\n`;
}

test('C22: an episode modified after its consolidated day is re-selected; an untouched one is not', async () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-c22-'));
  mkdirSync(join(v, 'episodes', '2026', '09'), { recursive: true });
  writeFileSync(join(v, CONFIG_FILENAME), JSON.stringify(CONFIG));

  const untouched = join(v, 'episodes', '2026', '09', '2026-09-16-untouched.md');
  const touched = join(v, 'episodes', '2026', '09', '2026-09-16-touched.md');
  writeFileSync(untouched, episode('2026-09-16'));
  writeFileSync(touched, episode('2026-09-16'));

  // untouched: mtime on the consolidated day (what consolidation itself would set)
  const sameDay = new Date(2026, 8, 16, 12, 0, 0);
  utimesSync(untouched, sameDay, sameDay);
  // touched: mtime three days later — a manual fix after consolidation
  const later = new Date(2026, 8, 19, 12, 0, 0);
  utimesSync(touched, later, later);

  const cfg = loadConfig(v);
  const result = await consolidate(v, cfg, { dryRun: true });

  assert.ok(
    result.processedEpisodes.includes('episodes/2026/09/2026-09-16-touched.md'),
    'episode modified after consolidation must be re-selected',
  );
  assert.ok(
    !result.processedEpisodes.includes('episodes/2026/09/2026-09-16-untouched.md'),
    'episode not modified since consolidation must be skipped',
  );
});
