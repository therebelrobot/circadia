// MCP server over stdio (Phase 3). JSON-RPC 2.0 framing with zero dependencies.
// Per ADR-0004: no runtime dependencies. Per docs/SECURITY.md T2: stdio-only.
//
// Transport rules this file must uphold (JSON-RPC 2.0 + MCP):
//   - stdout is the protocol channel: it carries JSON-RPC messages and nothing else.
//     Every log/banner goes to stderr.
//   - Messages are newline-delimited. stdin is buffered and split on `\n`; a chunk may
//     hold several messages or half of one. `\r\n` and a final line without a trailing
//     newline are both handled.
//   - Every response echoes the request's `id`. Clients match responses to requests by
//     id; a `null` id makes them hang.
//   - A message without an `id` is a notification: process it, send nothing back.

import { loadConfig } from '../config.ts';
import type { QueryMode, SourceKind } from '../types.ts';

/**
 * Yield newline-delimited lines from stdin, buffering across chunk boundaries.
 *
 * Why not read one chunk per message: a single `data` event can carry two messages
 * (they parse as one malformed blob) or half of one (it fails to parse). Splitting on
 * `\n` and keeping the remainder is the only framing that survives both.
 */
async function* readLines(): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
    }
  }
  // A final line with no trailing newline is still a complete message.
  if (buffer.length > 0) {
    let line = buffer;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    yield line;
  }
}

function writeStdout(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Protocol versions this server understands, newest first. Mirrors the official SDK's
// SUPPORTED_PROTOCOL_VERSIONS. The initialize result MUST carry `protocolVersion`; the
// MCP TypeScript SDK rejects a handshake without it (`invalid_type at "protocolVersion"`).
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

async function handleInit(id: string | number | null, params?: Record<string, unknown>): Promise<JSONRPCResponse> {
  // Echo the client's requested version when we support it; otherwise advertise the
  // newest we do support and let the client decide whether to continue.
  const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
  const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion,
      serverInfo: { name: 'circadia', version: '0.1.0' },
      capabilities: { tools: {} },
    },
  };
}

async function handleToolsList(
  _vaultRoot: string,
  _cfg: Awaited<ReturnType<typeof loadConfig>>,
  id: string | number | null,
): Promise<JSONRPCResponse> {
  const tools = [
    {
      name: 'recall',
      description: 'Retrieve passages for a cue.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string', enum: ['wikilink', 'typed', 'hipporag', 'auto'] },
          as_of: { type: 'string' },
          top_k: { type: 'number' },
          scope: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      name: 'remember',
      description: 'Write episodes from text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          session: { type: 'string' },
          by: { type: 'string', enum: ['agent', 'tool', 'web'] },
          source: { type: 'string', enum: ['chat', 'tool', 'import'] },
        },
        required: ['text'],
      },
    },
    {
      name: 'timeline',
      description: 'Get facts about an entity.',
      inputSchema: {
        type: 'object',
        properties: { entity: { type: 'string' } },
        required: ['entity'],
      },
    },
    {
      name: 'relate',
      description: 'Find shortest paths between notes.',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
          max_hops: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
    {
      name: 'get_note',
      description: 'Read-only note retrieval.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  ];
  return { jsonrpc: '2.0', id, result: { tools } };
}

export async function handleToolsCall(
  vaultRoot: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  method: string,
  params?: Record<string, unknown>,
  id: string | number | null = null,
): Promise<JSONRPCResponse> {
  try {
    if (method === 'recall' && params && 'query' in params && typeof params.query === 'string') {
      const recallModule = await import('../retrieval/recall.ts');
      const query = params.query;
      const asOf = params.as_of ? Date.parse(params.as_of as string) : null;
      const mode = params.mode as QueryMode | undefined;
      const topK = typeof params.top_k === 'number' ? params.top_k : undefined;
      const r = await recallModule.recall(vaultRoot, cfg, query, { mode, asOf, topK, logAccess: false });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: recallModule.renderForContext(r) }],
          modeUsed: r.modeUsed,
          modeRequested: r.modeRequested,
          escalations: r.escalations,
        },
      };
    }

    if (method === 'remember' && params && 'text' in params && typeof params.text === 'string') {
      // C4/P0: an MCP caller may not claim to be the user. An agent that read a hostile
      // page must not be able to mint a `by: user` episode — that would skip the
      // untrusted-source queue and could supersede existing facts. Default to `agent`;
      // refuse `user` outright. Human-authored episodes come from editing the vault or
      // the CLI, never from this tool.
      if (params.by === 'user') {
        // Per the MCP spec, a business-logic failure is a TOOL EXECUTION error: report it
        // inside the result with `isError: true` so the client can show it to the model,
        // rather than as a protocol-level JSON-RPC error. (Unknown tools and server
        // errors stay protocol errors.)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'remember: by "user" is not allowed over MCP; use "agent", "tool", or "web"' }],
            isError: true,
          },
        };
      }
      const by = (params.by as SourceKind | undefined) ?? 'agent';
      const segModule = await import('../episodes/segment.ts');
      const epModule = await import('../episodes/episode.ts');
      const segs = segModule.segmentText(params.text, {
        by,
        source: params.source as SourceKind | undefined,
      });
      const result = await epModule.writeEpisodes(vaultRoot, cfg, segs, {
        session: params.session as string | undefined,
        by,
        source: params.source as SourceKind | undefined,
      });
      const text = 'Wrote ' + result.episodes.length + ' episode(s): ' + result.episodes.map((e: { path: string; title: string; boundary: string }) => e.path).join(', ');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          episodes: result.episodes.map((e: { path: string; title: string; boundary: string }) => ({ path: e.path, title: e.title, boundary: e.boundary })),
        },
      };
    }

    if (method === 'timeline' && params && 'entity' in params && typeof params.entity === 'string') {
      const timelineModule = await import('../retrieval/timeline.ts');
      const dbModule = await import('../index/db.ts');
      const pathModule = await import('node:path');
      const { db } = dbModule.openIndex(pathModule.join(vaultRoot, cfg.index.path));
      try {
        const entries = timelineModule.timeline(db, params.entity, cfg);
        const text = entries.map((e) => {
          const when = e.valid_from ? new Date(e.valid_from).toISOString().slice(0, 10) : '…';
          return when + ' ' + e.predicate + ' ' + e.object;
        }).join('\n');
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], entries } };
      } finally { db.close(); }
    }

    if (method === 'relate' && params && 'a' in params && 'b' in params && typeof params.a === 'string' && typeof params.b === 'string') {
      const relateModule = await import('../retrieval/relate.ts');
      const dbModule = await import('../index/db.ts');
      const pathModule = await import('node:path');
      const { db } = dbModule.openIndex(pathModule.join(vaultRoot, cfg.index.path));
      try {
        const r = relateModule.relate(db, params.a, params.b, cfg, { maxDepth: typeof params.max_hops === 'number' ? params.max_hops : undefined });
        const text = r.paths.length > 0 ? r.paths.map((p) => p.nodes.join(' → ')).join('\n') : 'No path found';
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], paths: r.paths.map((p) => ({ nodes: p.nodes, edges: p.edges })), found: r.found } };
      } finally { db.close(); }
    }

    if (method === 'get_note' && params && 'id' in params && typeof params.id === 'string') {
      const indexerModule = await import('../index/indexer.ts');
      const pathModule = await import('node:path');
      const fsModule = await import('node:fs');
      const notes = indexerModule.parseVault(vaultRoot, cfg);
      const note = notes.find((n) => n.id === params.id || n.path === params.id);
      if (!note) {
        // Business-logic failure: a tool execution error, not a protocol error.
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'Note not found: ' + params.id }], isError: true },
        };
      }
      const filePath = pathModule.join(vaultRoot, note.path);
      const text = fsModule.readFileSync(filePath, 'utf8');
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], note: { id: note.id, path: note.path, title: note.title } } };
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error: ' + (e as Error).message } };
  }
}

/** Dispatch one parsed message to a response. `id` is echoed on every path. */
async function dispatch(
  req: JSONRPCRequest,
  vaultRoot: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): Promise<JSONRPCResponse> {
  const id = req.id ?? null;
  const { method, params } = req;
  if (method === 'initialize') {
    return handleInit(id, params);
  }
  if (method === 'tools/list') {
    return handleToolsList(vaultRoot, cfg, id);
  }
  if (method === 'tools/call') {
    return handleToolsCall(vaultRoot, cfg, params?.name as string, params?.arguments as Record<string, unknown>, id);
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

export async function runServer(vaultRoot: string): Promise<void> {
  const cfg = loadConfig(vaultRoot);
  for await (const line of readLines()) {
    if (line.trim().length === 0) continue;
    let req: JSONRPCRequest;
    try {
      req = JSON.parse(line);
    } catch {
      // A parse error has no request id to echo; JSON-RPC 2.0 mandates `id: null`.
      writeStdout({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // A message with no `id` member is a notification: process it, reply to nothing.
    const isNotification = !Object.prototype.hasOwnProperty.call(req, 'id');
    const res = await dispatch(req, vaultRoot, cfg);
    if (!isNotification) writeStdout(res);
  }
}
