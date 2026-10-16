// RFC-0003 §6: bearer-token loading, validation, and comparison.
// No network and no vault; every path is a temp file.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_TOKEN_BYTES, TokenError, authorize, loadTokens, tokenMatches } from '../src/serve/tokens.ts';

const dirs: string[] = [];
function tmpFile(name: string, content: string): string {
  const d = mkdtempSync(join(tmpdir(), 'circadia-token-'));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, content);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

const W = 'w'.repeat(40);
const R = 'r'.repeat(40);

test('loadTokens: refuses to start without a write token', () => {
  assert.throws(() => loadTokens({}), TokenError);
  assert.throws(() => loadTokens({}), /refuses to start without a write token/);
});

test('loadTokens: refuses a token shorter than 32 bytes', () => {
  assert.throws(() => loadTokens({ CIRCADIA_WRITE_TOKEN: 'short' }), /at least 32 bytes/);
  assert.equal(MIN_TOKEN_BYTES, 32);
});

test('loadTokens: refuses a read token equal to the write token', () => {
  assert.throws(() => loadTokens({ CIRCADIA_WRITE_TOKEN: W, CIRCADIA_READ_TOKEN: W }), /read token must differ/);
});

test('loadTokens: reads the write token from a file and trims it; read is optional', () => {
  const file = tmpFile('write', `  ${W}\n`);
  const { tokens, warnings } = loadTokens({ CIRCADIA_WRITE_TOKEN_FILE: file });
  assert.equal(tokens.write, W);
  assert.equal(tokens.read, null);
  assert.deepEqual(warnings, [], 'a file-based token does not warn');
});

test('loadTokens: a bare *_TOKEN env var is accepted with a dev warning', () => {
  const { tokens, warnings } = loadTokens({ CIRCADIA_WRITE_TOKEN: W, CIRCADIA_READ_TOKEN: R });
  assert.equal(tokens.write, W);
  assert.equal(tokens.read, R);
  assert.equal(warnings.length, 2);
});

test('loadTokens: a missing token file fails loudly', () => {
  assert.throws(() => loadTokens({ CIRCADIA_WRITE_TOKEN_FILE: '/nope/does-not-exist' }), /could not read CIRCADIA_WRITE_TOKEN_FILE/);
});

test('tokenMatches: true only for the equal token', () => {
  assert.equal(tokenMatches(W, W), true);
  assert.equal(tokenMatches(W, R), false);
  // Length is not leaked: a prefix is still false.
  assert.equal(tokenMatches(W.slice(0, 10), W), false);
});

test('authorize: classifies a write token, an optional read token, and nothing else', () => {
  const tokens = { write: W, read: R };
  assert.equal(authorize(`Bearer ${W}`, tokens), 'write');
  assert.equal(authorize(`Bearer ${R}`, tokens), 'read');
  assert.equal(authorize('Bearer nope', tokens), null);
  assert.equal(authorize(undefined, tokens), null);
  assert.equal(authorize('Basic abc', tokens), null);
  // With no read token, the write token is the only key.
  assert.equal(authorize(`Bearer ${R}`, { write: W, read: null }), null);
});
