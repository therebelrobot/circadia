// Streamable-HTTP MCP transport for `circadia serve` (RFC-0003 §3).
//
// Zero dependencies: `node:http` only (ADR-0014). One route, `POST /mcp`, answering with
// `application/json`. Every Circadia tool returns a single result, so v1 has no SSE and no
// `GET /mcp` stream. Every other method or path gets 404 *after* the auth check, so there
// are no unauthenticated routes.
//
// Security controls, in order (docs/SECURITY.md T2):
//   - auth runs first: a missing or bad bearer token is 401 with `WWW-Authenticate: Bearer`;
//   - a request carrying an `Origin` header is rejected unless the origin is allowlisted;
//   - no CORS headers are ever sent, and OPTIONS is not answered;
//   - the request body is capped while streaming (buffering stops at the cap);
//   - a cap on in-flight requests answers 503 + `Retry-After` over the cap;
//   - a per-request timeout.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { authorize, type Scope, type ServeTokens } from './tokens.ts';
import type { RpcRequest, RpcResponse } from './protocol.ts';

export const MCP_PATH = '/mcp';

export interface ServeHttpOptions {
  bind: string;
  port: number;
  tokens: ServeTokens;
  allowedOrigins: string[];
  maxBodyBytes: number;
  maxInFlight: number;
  /** per-request timeout in ms; a slow handler is answered 504 */
  requestTimeoutMs?: number;
  handleMessage: (req: RpcRequest, scope: Scope) => Promise<RpcResponse>;
  log: (event: Record<string, unknown>) => void;
}

export interface ServeHttp {
  server: Server;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  /** current in-flight request count (tests) */
  inFlight(): number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ body: string } | { tooLarge: true }> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Drain without buffering so the socket is left cleanly; do not allocate the body.
      resolve({ tooLarge: true });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Stop buffering at the cap; the caller answers 413. Keep draining so the client's
        // upload can finish without a reset.
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? { tooLarge: true } : { body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (e) => reject(e));
  });
}

export function createServeHttp(opts: ServeHttpOptions): ServeHttp {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const allowed = new Set(opts.allowedOrigins);
  const sessions = new Set<string>();
  let inFlight = 0;
  let authFailures = 0;

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Keep-alive: the client may send several requests on one socket.
    req.socket.setNoDelay(true);

    // 1. Auth, before anything else. Unknown paths 404 only after this.
    const scope = authorize(req.headers.authorization, opts.tokens);
    if (!scope) {
      authFailures++;
      // Log the first few failures in full, then only a rolling counter: no token material.
      opts.log({
        event: 'auth.failure',
        path: req.url,
        failures: authFailures,
        ...(authFailures <= 5 ? { remote: req.socket.remoteAddress } : {}),
      });
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    // 2. Browser defense: reject any Origin that is not allowlisted. No CORS headers, ever.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !allowed.has(origin)) {
      opts.log({ event: 'origin.rejected', origin });
      sendJson(res, 403, { error: 'origin not allowed' });
      return;
    }

    // 3. Route: one method, one path.
    const method = req.method ?? 'GET';
    const path = (req.url ?? '').split('?')[0];
    if (method !== 'POST' || path !== MCP_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // 4. In-flight cap.
    if (inFlight >= opts.maxInFlight) {
      opts.log({ event: 'limit.in-flight', cap: opts.maxInFlight });
      sendJson(res, 503, { error: 'too many in-flight requests' }, { 'Retry-After': '1' });
      return;
    }
    inFlight++;

    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      inFlight--;
      clearTimeout(timer);
      if (typeof timer.unref === 'function') timer.unref();
    };

    const timer = setTimeout(() => {
      if (!res.headersSent) {
        opts.log({ event: 'request.timeout' });
        sendJson(res, 504, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'request timed out' } });
      } else {
        res.destroy();
      }
      done();
    }, timeoutMs);

    res.on('close', done);
    res.on('finish', done);

    // 5. Protocol session header: an unknown supplied id is a 404 (spec); a valid one passes.
    const incoming = req.headers['mcp-session-id'];
    let sessionId = typeof incoming === 'string' ? incoming : '';
    if (sessionId !== '' && !sessions.has(sessionId)) {
      sendJson(res, 404, { error: 'unknown session' });
      return;
    }

    let body: string;
    try {
      const read = await readBody(req, opts.maxBodyBytes);
      if ('tooLarge' in read) {
        sendJson(res, 413, { error: 'request body too large' });
        return;
      }
      body = read.body;
    } catch {
      sendJson(res, 400, { error: 'could not read request body' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const messages: RpcRequest[] = Array.isArray(parsed) ? (parsed as RpcRequest[]) : [parsed as RpcRequest];
    if (messages.length === 0 || messages.some((m) => typeof m !== 'object' || m === null || typeof m.method !== 'string')) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }

    const responses: RpcResponse[] = [];
    let sawInitialize = false;
    for (const msg of messages) {
      if (msg.method === 'initialize') sawInitialize = true;
      responses.push(await opts.handleMessage(msg, scope));
    }

    // A notification has no `id` member; the spec answers 202 with no body.
    const hasRequest = messages.some((m) => Object.prototype.hasOwnProperty.call(m, 'id'));
    const headers: Record<string, string> = {};
    if (sawInitialize) {
      if (sessionId === '') {
        sessionId = randomUUID();
        sessions.add(sessionId);
        // Bound the set so a long-lived server does not grow without limit.
        if (sessions.size > 1024) {
          const first = sessions.values().next().value;
          if (first !== undefined) sessions.delete(first);
        }
      }
      headers['Mcp-Session-Id'] = sessionId;
    }

    if (!hasRequest) {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    const payload = Array.isArray(parsed) ? responses : responses[0];
    sendJson(res, 200, payload, headers);
  }

  return {
    server,
    inFlight: () => inFlight,
    listen(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.bind, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
          resolve({ port });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
