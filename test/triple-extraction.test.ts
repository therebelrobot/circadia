import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  passageHash,
  triplesDir,
  loadTriples,
  writeTriples,
  isStale,
  NoopExtractor,
} from '../src/extract/triples.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

describe('triple extraction', () => {
  describe('passageHash', () => {
    test('produces consistent sha256 hashes', () => {
      const text = 'test passage';
      const hash1 = passageHash(text);
      const hash2 = passageHash(text);
      assert.strictEqual(hash1, hash2);
      assert.strictEqual(hash1.length, 16);
    });

    test('different texts produce different hashes', () => {
      const hash1 = passageHash('text one');
      const hash2 = passageHash('text two');
      assert.notStrictEqual(hash1, hash2);
    });
  });

  describe('isStale', () => {
    const tmpRoot = join(tmpdir(), `palimpsest-triple-test-${Date.now()}`);

    test.beforeEach(() => {
      mkdirSync(tmpRoot, { recursive: true });
    });

    test.afterEach(() => {
      if (existsSync(tmpRoot)) {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    test('returns true when cache does not exist', () => {
      const result = isStale(tmpRoot, 'note1', 'note1#0', 'hash123', 'model-a');
      assert.strictEqual(result, true);
    });

    test('returns true when model differs', () => {
      const dir = triplesDir(tmpRoot);
      mkdirSync(dir, { recursive: true });
      writeTriples(
        tmpRoot,
        'note1',
        [{
          passageId: 'note1#0',
          contentHash: 'hash123',
          subject: 'A',
          predicate: 'relates_to',
          object: 'B',
          model: 'model-b',
        }]
      );

      const result = isStale(tmpRoot, 'note1', 'note1#0', 'hash123', 'model-a');
      assert.strictEqual(result, true);
    });

    test('returns true when content hash differs', () => {
      const dir = triplesDir(tmpRoot);
      mkdirSync(dir, { recursive: true });
      writeTriples(
        tmpRoot,
        'note1',
        [{
          passageId: 'note1#0',
          contentHash: 'old-hash',
          subject: 'A',
          predicate: 'relates_to',
          object: 'B',
          model: 'model-a',
        }]
      );

      const result = isStale(tmpRoot, 'note1', 'note1#0', 'new-hash', 'model-a');
      assert.strictEqual(result, true);
    });

    test('returns false when cache is fresh', () => {
      const dir = triplesDir(tmpRoot);
      mkdirSync(dir, { recursive: true });
      writeTriples(
        tmpRoot,
        'note1',
        [{
          passageId: 'note1#0',
          contentHash: 'hash123',
          subject: 'A',
          predicate: 'relates_to',
          object: 'B',
          model: 'model-a',
        }]
      );

      const result = isStale(tmpRoot, 'note1', 'note1#0', 'hash123', 'model-a');
      assert.strictEqual(result, false);
    });
  });

  describe('NoopExtractor', () => {
    test('returns empty array', async () => {
      const extractor = new NoopExtractor();
      const result = await extractor.extract();
      assert.deepStrictEqual(result, []);
    });

    test('model is "noop"', () => {
      const extractor = new NoopExtractor();
      assert.strictEqual(extractor.model, 'noop');
    });
  });

  describe('writeTriples and loadTriples', () => {
    const tmpRoot = join(tmpdir(), `palimpsest-triple-io-${Date.now()}`);

    test.beforeEach(() => {
      mkdirSync(tmpRoot, { recursive: true });
    });

    test.afterEach(() => {
      if (existsSync(tmpRoot)) {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    test('writes and loads triples', () => {
      writeTriples(
        tmpRoot,
        'note1',
        [{
          passageId: 'note1#0',
          contentHash: 'hash123',
          subject: 'A',
          predicate: 'relates_to',
          object: 'B',
          conf: 0.9,
          model: 'test-model',
        }]
      );

      const { triples } = loadTriples(tmpRoot);
      assert.strictEqual(triples.length, 1);
      assert.strictEqual(triples[0].subject, 'A');
      assert.strictEqual(triples[0].predicate, 'relates_to');
      assert.strictEqual(triples[0].object, 'B');
    });

    test('loads empty when no cache exists', () => {
      const { triples } = loadTriples(tmpRoot);
      assert.strictEqual(triples.length, 0);
    });
  });
});
