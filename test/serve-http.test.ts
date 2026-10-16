// RFC-0003 §3: HTTP transport controls (auth, browser defenses, limits).
// Drives `createServeHttp` directly with a fake handler: no vault, no model calls.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServeHttp, type ServeHttpOptions } from '../src/serve/http.ts';
import type { RpcRequest, RpcResponse } from '../src/serve/protocol.ts';
import type { Scope } from '../src/serve/tokens.ts';

const W = 'w'.repeat(40);
const R = 'r'.repeat(40);
const TOKENS = { write: W, read: R };

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function startFake(
  over: Partial<ServeHttpOptions> & { handler?: (req: RpcRequest, scope: Scope) => Promise<RpcResponse> } = {},
): Promise<{ url: string; base: string }> {
  const { handler, ...rest } = over;
  const http = createServeHttp({
    bind: '127.0.0.1',
    port: 0,
    tokens: TOKENS,
    allowedOrigins: [],
    maxBodyBytes: 1024,
    maxInFlight: 8,
    log: () => {},
    handleMessage: handler ?? (async (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { ok: true, method: req.method } })),
    ...rest,
  });
  const { port } = await http.listen();
  servers.push(http);
  return { url: `http://127.0.0.1:${port}/mcp`, base: `http://127.0.0.1:${port}` };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('auth: 401 without a token, with a wrong token, on /mcp and on an unknown path', async () => {
  const { url, base } = await startFake();
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  for (const target of [url, `${base}/other`]) {
    const noTok = await post(target, init);
    assert.equal(noTok.status, 401, `${target} without a token`);
    assert.match(noTok.headers.get('www-authenticate') ?? '', /Bearer/);
    const bad = await post(target, init, { authorization: 'Bearer wrongwrongwrongwrongwrongwrongwrongwrong' });
    assert.equal(bad.status, 401, `${target} with a wrong token`);
  }
});

test('auth: a valid token reaches the handler; initialize sets Mcp-Session-Id', async () => {
  const { url } = await startFake({
    handler: async (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { protocolVersion: '2025-06-18' } }),
  });
  const res = await post(url, { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }, { authorization: `Bearer ${W}` });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('mcp-session-id'), 'initialize must assign a session id');
  const body = (await res.json()) as { id: number; result: { protocolVersion: string } };
  assert.equal(body.id, 7);
  assert.equal(body.result.protocolVersion, '2025-06-18');
});

test('auth: an unknown Mcp-Session-Id is a 404', async () => {
  const { url } = await startFake();
  const res = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${W}`, 'mcp-session-id': 'made-up' });
  assert.equal(res.status, 404);
});

test('auth: the handler sees the scope (read on a read token, write on a write token)', async () => {
  const seen: Scope[] = [];
  const { url } = await startFake({
    handler: async (req, scope) => {
      seen.push(scope);
      return { jsonrpc: '2.0', id: req.id ?? null, result: {} };
    },
  });
  await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${R}` });
  await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${W}` });
  assert.deepEqual(seen, ['read', 'write']);
});

test('browser defense: a non-allowlisted Origin is rejected; an allowlisted one passes', async () => {
  const { url } = await startFake({ allowedOrigins: ['https://ok.example.com'] });
  const bad = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${W}`, origin: 'https://evil.example.com' });
  assert.equal(bad.status, 403);
  const good = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${W}`, origin: 'https://ok.example.com' });
  assert.equal(good.status, 200);
});

test('browser defense: no Access-Control-* headers are ever sent', async () => {
  const { url } = await startFake({ allowedOrigins: ['https://ok.example.com'] });
  const res = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${W}`, origin: 'https://ok.example.com' });
  for (const [k] of res.headers) assert.ok(!k.toLowerCase().startsWith('access-control-'), `unexpected header ${k}`);
});

test('browser defense: OPTIONS is not answered as a preflight', async () => {
  const { url } = await startFake();
  const res = await fetch(url, { method: 'OPTIONS', headers: { authorization: `Bearer ${W}`, origin: 'https://evil.example.com', 'access-control-request-method': 'POST' } });
  assert.ok(res.status === 403 || res.status === 404, `preflight must not be approved (got ${res.status})`);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('routing: GET /mcp and any other path 404 after auth', async () => {
  const { url, base } = await startFake();
  const get = await fetch(url, { headers: { authorization: `Bearer ${W}` } });
  assert.equal(get.status, 404);
  const other = await post(`${base}/other`, {}, { authorization: `Bearer ${W}` });
  assert.equal(other.status, 404);
});

test('limits: a body over maxBodyBytes is 413', async () => {
  const { url } = await startFake({ maxBodyBytes: 100 });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${W}` },
    body: 'x'.repeat(5000),
  });
  assert.equal(res.status, 413);
  // Below the cap it is handled normally.
  const ok = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${W}` });
  assert.equal(ok.status, 200);
});

test('limits: over the in-flight cap is 503 with Retry-After', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const { url } = await startFake({
    maxInFlight: 1,
    handler: async (req) => {
      await blocked;
      return { jsonrpc: '2.0', id: req.id ?? null, result: {} };
    },
  });
  const first = post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${W}` });
  // Let the first request reach the in-flight counter.
  await new Promise((r) => setTimeout(r, 50));
  const second = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${W}` });
  assert.equal(second.status, 503);
  assert.ok(second.headers.get('retry-after'));
  release();
  assert.equal((await first).status, 200);
});

test('protocol: a notification (no id) gets 202 with no body', async () => {
  const { url } = await startFake();
  const res = await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${W}` });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});

test('protocol: a malformed JSON body is a -32700 parse error', async () => {
  const { url } = await startFake();
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${W}` }, body: '{not json' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { error: { code: number } };
  assert.equal(body.error.code, -32700);
});
