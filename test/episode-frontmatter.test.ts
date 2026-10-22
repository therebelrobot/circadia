// #19: a written episode must carry `started`, which the schema requires (lint:
// note.missing-field). `remember` wrote episodes with no `started`, so every remembered
// episode failed lint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEpisodes } from '../src/episodes/episode.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

test('#19: a written episode frontmatter carries a valid started date', async () => {
  const v = mkdtempSync(join(tmpdir(), 'circadia-episode-fm-'));
  const result = await writeEpisodes(
    v,
    DEFAULT_CONFIG,
    [{ title: 'Probe', boundary: 'none', text: 'The pi cluster runs on the old laptop.' }],
    {},
  );
  assert.equal(result.episodes.length, 1);
  const raw = readFileSync(join(v, result.episodes[0].path), 'utf8');
  assert.match(raw, /^started: \d{4}-\d{2}-\d{2}$/m, 'frontmatter must declare started');
  assert.match(raw, /^type: episode$/m);
});
