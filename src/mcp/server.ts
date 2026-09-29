// MCP server over stdio (Phase 3). JSON-RPC 2.0 framing with zero dependencies.
// Per ADR-0004: no runtime dependencies. Per docs/SECURITY.md T2: stdio-only.

import { loadConfig } from '../config.ts';
import type { QueryMode, SourceKind } from '../types.ts';

async function readStdinLine(): Promise<string | null> {
  return new Promise((resolve) => {
    const chunk = process.stdin.read();
    if (chunk) {
      const line = chunk.toString('utf8').trim();
      resolve(line.length > 0 ? line : null);
    } else {
      process.stdin.once('data', (data) => {
        const line = data.toString('utf8').trim();
        resolve(line.length > 0 ? line : null);
      });
    }
  });
}

function writeStdout(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function handleInit(): Promise<JSONRPCResponse> {
  return {
    jsonrpc: '2.0',
    id: null,
    result: {
      serverInfo: { name: 'circadia', version: '0.1.0' },
      capabilities: { tools: {} },
    },
  };
}

async function handleToolsList(_vaultRoot: string, _cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<JSONRPCResponse> {
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
          by: { type: 'string', enum: ['user', 'agent', 'tool', 'web'] },
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
  return { jsonrpc: '2.0', id: null, result: { tools } };
}

async function handleToolsCall(
  vaultRoot: string,
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  method: string,
  params?: Record<string, unknown>,
): Promise<JSONRPCResponse> {
  try {
    if (method === 'recall' && params && 'query' in params && typeof params.query === 'string') {
      const recallModule = await import('../retrieval/recall.ts');
      const query = params.query;
      const asOf = params.as_of ? Date.parse(params.as_of as string) : null;
      const mode = params.mode as QueryMode | undefined;
      const topK = typeof params.top_k === 'number' ? params.top_k : undefined;
      const r = recallModule.recall(vaultRoot, cfg, query, { mode, asOf, topK, logAccess: false });
      return {
        jsonrpc: '2.0',
        id: null,
        result: {
          content: [{ type: 'text', text: recallModule.renderForContext(r) }],
          modeUsed: r.modeUsed,
          modeRequested: r.modeRequested,
          escalations: r.escalations,
        },
      };
    }

    if (method === 'remember' && params && 'text' in params && typeof params.text === 'string') {
      const segModule = await import('../episodes/segment.ts');
      const epModule = await import('../episodes/episode.ts');
      const segs = segModule.segmentText(params.text, {
        by: params.by as SourceKind | undefined,
        source: params.source as SourceKind | undefined,
      });
      const result = await epModule.writeEpisodes(vaultRoot, cfg, segs, {
        session: params.session as string | undefined,
        by: params.by as SourceKind | undefined,
        source: params.source as SourceKind | undefined,
      });
      const text = 'Wrote ' + result.episodes.length + ' episode(s): ' + result.episodes.map((e: { path: string; title: string; boundary: string }) => e.path).join(', ');
      return {
        jsonrpc: '2.0',
        id: null,
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
        return { jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text }], entries } };
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
        return { jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text }], paths: r.paths.map((p) => ({ nodes: p.nodes, edges: p.edges })), found: r.found } };
      } finally { db.close(); }
    }

    if (method === 'get_note' && params && 'id' in params && typeof params.id === 'string') {
      const indexerModule = await import('../index/indexer.ts');
      const pathModule = await import('node:path');
      const fsModule = await import('node:fs');
      const notes = indexerModule.parseVault(vaultRoot, cfg);
      const note = notes.find((n) => n.id === params.id || n.path === params.id);
      if (!note) {
        return { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Note not found: ' + params.id } };
      }
      const filePath = pathModule.join(vaultRoot, note.path);
      const text = fsModule.readFileSync(filePath, 'utf8');
      return { jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text }], note: { id: note.id, path: note.path, title: note.title } } };
    }

    return { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found: ' + method } };
  } catch (e) {
    return { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error: ' + (e as Error).message } };
  }
}

export async function runServer(vaultRoot: string): Promise<void> {
  const cfg = loadConfig(vaultRoot);
  while (true) {
    const line = await readStdinLine();
    if (!line) break;
    let req: JSONRPCRequest;
    try {
      req = JSON.parse(line);
    } catch {
      writeStdout({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const { method, params } = req;
    let res: JSONRPCResponse;
    if (method === 'initialize') {
      res = await handleInit();
    } else if (method === 'tools/list') {
      res = await handleToolsList(vaultRoot, cfg);
    } else if (method === 'tools/call') {
      res = await handleToolsCall(vaultRoot, cfg, params?.name as string, params?.arguments as Record<string, unknown>);
    } else {
      res = { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: 'Method not found: ' + method } };
    }
    writeStdout(res);
  }
}
