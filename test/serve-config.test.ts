// RFC-0003 config: serve.* keys, apiKeyFileEnv, and the token-key rejection.
// Temp vaults only; never touches examples/vault/.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { resolveApiKey } from '../src/llm/api-key.ts';

const dirs: string[] = [];

function vaultWith(config: unknown): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-serve-config-'));
  dirs.push(v);
  mkdirSync(v, { recursive: true });
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify(config, null, 2) + '\n');
  return v;
}

function bareVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-serve-config-'));
  dirs.push(v);
  mkdirSync(v, { recursive: true });
  return v;
}

afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

test('serve defaults: loopback, port 8711, no schedule, watch off', () => {
  assert.deepEqual(DEFAULT_CONFIG.serve, {
    bind: '127.0.0.1',
    port: 8711,
    allowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
    maxInFlight: 8,
    lockWaitMs: 10_000,
    watch: false,
    schedule: { consolidate: null, timezone: null },
  });
  const cfg = loadConfig(bareVault());
  assert.equal(cfg.serve.bind, '127.0.0.1');
  assert.equal(cfg.serve.port, 8711);
});

test('serve keys deep-merge over the defaults; untouched keys keep theirs', () => {
  const v = vaultWith({ serve: { bind: '0.0.0.0', port: 9000, schedule: { consolidate: '03:30' } } });
  const cfg = loadConfig(v);
  assert.equal(cfg.serve.bind, '0.0.0.0');
  assert.equal(cfg.serve.port, 9000);
  assert.equal(cfg.serve.schedule.consolidate, '03:30');
  assert.equal(cfg.serve.schedule.timezone, null, 'untouched schedule key keeps its default');
  assert.equal(cfg.serve.maxInFlight, 8, 'untouched serve key keeps its default');
});

test('serve: an invalid port fails loudly', () => {
  assert.throws(() => loadConfig(vaultWith({ serve: { port: 70000 } })), /serve\.port must be an integer in \[1, 65535\]/);
  assert.throws(() => loadConfig(vaultWith({ serve: { port: 1.5 } })), /serve\.port must be an integer in \[1, 65535\]/);
});

test('serve: an invalid schedule time fails loudly', () => {
  assert.throws(() => loadConfig(vaultWith({ serve: { schedule: { consolidate: '25:00' } } })), /serve\.schedule\.consolidate must be "HH:MM"/);
  assert.throws(() => loadConfig(vaultWith({ serve: { schedule: { consolidate: '3pm' } } })), /serve\.schedule\.consolidate must be "HH:MM"/);
});

test('serve: a valid "HH:MM" schedule and IANA zone are accepted; a bad zone fails', () => {
  const cfg = loadConfig(vaultWith({ serve: { schedule: { consolidate: '00:00', timezone: 'America/New_York' } } }));
  assert.equal(cfg.serve.schedule.consolidate, '00:00');
  assert.equal(cfg.serve.schedule.timezone, 'America/New_York');
  assert.throws(() => loadConfig(vaultWith({ serve: { schedule: { timezone: 'Mars/Olympus' } } })), /not a valid IANA time zone/);
});

test('serve: allowedOrigins rejects "*" (SECURITY.md T2)', () => {
  assert.throws(() => loadConfig(vaultWith({ serve: { allowedOrigins: ['*'] } })), /must not contain "\*"/);
  const cfg = loadConfig(vaultWith({ serve: { allowedOrigins: ['https://example.com'] } }));
  assert.deepEqual(cfg.serve.allowedOrigins, ['https://example.com']);
});

test('serve: a token key anywhere under serve is rejected', () => {
  assert.throws(() => loadConfig(vaultWith({ serve: { writeToken: 'x'.repeat(40) } })), /must not contain a token key/);
  assert.throws(() => loadConfig(vaultWith({ serve: { auth: { readTokenFile: '/run/secret' } } })), /must not contain a token key/);
});

test('apiKeyFileEnv: defaults to null and deep-merges', () => {
  const cfg = loadConfig(bareVault());
  assert.equal(cfg.embeddings.apiKeyFileEnv, null);
  assert.equal(cfg.extraction.apiKeyFileEnv, null);
  const v = vaultWith({ extraction: { apiKeyFileEnv: 'OPENROUTER_KEY_FILE' }, embeddings: { apiKeyFileEnv: 'EMBED_KEY_FILE' } });
  const cfg2 = loadConfig(v);
  assert.equal(cfg2.extraction.apiKeyFileEnv, 'OPENROUTER_KEY_FILE');
  assert.equal(cfg2.embeddings.apiKeyFileEnv, 'EMBED_KEY_FILE');
});

test('resolveApiKey: the file variant wins; falls back to the env var; null when neither', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-apikey-'));
  dirs.push(dir);
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, '  filesecret\n');
  process.env.TEST_KEY_ENV = 'envsecret';
  process.env.TEST_KEY_FILE_ENV = keyFile;
  try {
    assert.equal(resolveApiKey('TEST_KEY_ENV', 'TEST_KEY_FILE_ENV'), 'filesecret');
    assert.equal(resolveApiKey('TEST_KEY_ENV', null), 'envsecret');
    assert.equal(resolveApiKey(null, null), null);
    // A named file env that points nowhere falls back to the token env.
    process.env.TEST_KEY_FILE_ENV = join(dir, 'missing');
    assert.equal(resolveApiKey('TEST_KEY_ENV', 'TEST_KEY_FILE_ENV'), 'envsecret');
    // An empty file does not produce an empty token.
    writeFileSync(keyFile, '   \n');
    process.env.TEST_KEY_FILE_ENV = keyFile;
    assert.equal(resolveApiKey('TEST_KEY_ENV', 'TEST_KEY_FILE_ENV'), 'envsecret');
    assert.equal(resolveApiKey(null, 'TEST_KEY_FILE_ENV'), null);
  } finally {
    delete process.env.TEST_KEY_ENV;
    delete process.env.TEST_KEY_FILE_ENV;
  }
});
