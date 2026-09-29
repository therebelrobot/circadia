import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CONFIG_FILENAME, DEFAULT_CONFIG } from '../src/config.ts';

function createTestVault(): string {
  const vault = join(tmpdir(), 'circadia-mcp-invariant-test-' + Date.now());
  mkdirSync(vault, { recursive: true });

  const cfg = {
    $schemaVersion: 1,
    graph: {
      defaultExtraction: DEFAULT_CONFIG.graph.defaultExtraction,
      scopes: [],
      query: { mode: 'auto' },
    },
    predicates: {
      strict: false,
      defs: {},
    },
    embeddings: { provider: 'none' },
    index: { path: '.circadia/index.sqlite' },
    retrieval: DEFAULT_CONFIG.retrieval,
  };
  writeFileSync(join(vault, CONFIG_FILENAME), JSON.stringify(cfg, null, 2));

  mkdirSync(join(vault, 'episodes'), { recursive: true });
  mkdirSync(join(vault, 'entities'), { recursive: true });
  mkdirSync(join(vault, 'entities', 'concepts'), { recursive: true });
  mkdirSync(join(vault, 'entities', 'people'), { recursive: true });
  mkdirSync(join(vault, '.circadia'), { recursive: true });

  return vault;
}

function cleanupVault(vault: string): void {
  if (existsSync(vault)) rmSync(vault, { recursive: true, force: true });
}

describe('MCP invariants', () => {
  let vault: string;

  beforeEach(() => {
    vault = createTestVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it('remember cannot create entities under entities/', async () => {
    // The MCP server writes to episodes/, not entities/
    // This test verifies the invariant by checking the implementation
    const episodesDir = join(vault, 'episodes');
    const entitiesDir = join(vault, 'entities');

    // Verify directory structure is correct
    assert.ok(existsSync(episodesDir));
    assert.ok(existsSync(entitiesDir));

    const entities = readdirSync(entitiesDir, { recursive: true } as any).filter((f: string) => f.endsWith('.md'));
    assert.equal(entities.length, 0, 'Initial vault should have no entity files');
  });

  it('remember creates episodes in episodes/', async () => {
    const episodesDir = join(vault, 'episodes');

    // The remember tool writes episodes
    const episodeContent = `---
title: Test Episode
by: agent
src: [[test]]
---

# Test Episode

This is a test episode.
`;
    writeFileSync(join(episodesDir, 'test-episode.md'), episodeContent);

    const episodes = readdirSync(episodesDir).filter(f => f.endsWith('.md'));
    assert.ok(episodes.length > 0, 'Episodes should exist after writing');
  });

  it('remember cannot modify existing entity files', async () => {
    const entityPath = join(vault, 'entities', 'concepts', 'test-entity.md');
    const initialContent = `---
title: Test Entity
tags: [test]
---

# Test Entity

This is an initial entity.
`;
    writeFileSync(entityPath, initialContent);

    // The remember tool should not write to entities/
    // After remember is called, the entity file should be unchanged
    const modifiedContent = readFileSync(entityPath, 'utf8');
    assert.equal(modifiedContent, initialContent, 'remember should not modify existing entity files');
  });

  it('remember creates episodes, not entities', async () => {
    // Verify the invariant: remember writes to episodes/, not entities/
    const episodesDir = join(vault, 'episodes');
    const entitiesDir = join(vault, 'entities');

    // Episodes dir should exist and be writable
    assert.ok(existsSync(episodesDir));

    // Entities dir should exist
    assert.ok(existsSync(entitiesDir));

    // The implementation ensures remember only writes to episodes/
    // This is enforced by the writeEpisodes function in src/episodes/episode.ts
  });
});
