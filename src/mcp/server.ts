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

import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../config.ts';
import { openIndex } from '../index/db.ts';
import { createGraphCache, type GraphCache } from '../retrieval/graph-cache.ts';
import type { Layer, QueryMode, SourceKind } from '../types.ts';
import {
  LAYER_ORDER,
  loadWorkspace,
  resolveBinding,
  resolveLineage,
  targetVaultId,
  writeTargetsFor,
  type Cell,
  type LineageEntry,
  type WriteTarget,
  type WorkspaceRegistry,
} from '../workspace/registry.ts';
import { isVaultWritable, workspaceRecall } from '../workspace/recall.ts';

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

export async function handleToolsList(
  _vaultRoot: string,
  _cfg: Awaited<ReturnType<typeof loadConfig>>,
  id: string | number | null,
  targets?: WriteTarget[],
  workspace = false,
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
          session: { type: 'string' },
          // RFC-0004: narrow the lineage to these layers. It can only narrow. Advertised
          // only on a workspace server; the single-vault server ignores it, so advertising
          // it there would invite a call that silently does nothing.
          ...(workspace
            ? { layers: { type: 'array', items: { type: 'string', enum: ['agent', 'project', 'global-agent', 'global'] } } }
            : {}),
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
          // RFC-0004: the enum contains only the targets this binding's write policy
          // allows, so the model cannot name a forbidden layer. The server still checks.
          ...(targets ? { target: { type: 'string', enum: targets } } : {}),
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
          // RFC-0004 §4: run relate in the lineage vault occupying this layer. Workspace
          // only; the single-vault server has one vault and ignores it.
          ...(workspace
            ? { layer: { type: 'string', enum: ['agent', 'project', 'global-agent', 'global'] } }
            : {}),
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
    {
      name: 'wake',
      description: "Read the night's dream log once and forget it.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'endorse_dream',
      description: 'Endorse a dream candidate (state change only; writes nothing in the vault).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'dismiss_dream',
      description: 'Dismiss a dream candidate (state change only; writes nothing in the vault).',
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
  graphCache?: GraphCache,
): Promise<JSONRPCResponse> {
  try {
    if (method === 'recall' && params && 'query' in params && typeof params.query === 'string') {
      const recallModule = await import('../retrieval/recall.ts');
      const query = params.query;
      // An unparseable as_of must be a protocol error, not a silent NaN that filters
      // every hit away. JSON-RPC 2.0 reserves -32602 for invalid params.
      let asOf: number | null = null;
      if (params.as_of !== undefined) {
        if (typeof params.as_of !== 'string' || Number.isNaN(Date.parse(params.as_of))) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: as_of must be a parseable date string' },
          };
        }
        asOf = Date.parse(params.as_of);
      }
      const mode = params.mode as QueryMode | undefined;
      const topK = typeof params.top_k === 'number' ? params.top_k : undefined;
      const scope = typeof params.scope === 'string' ? params.scope : undefined;
      const session = typeof params.session === 'string' ? params.session : undefined;
      // Best-effort query embedding: a down endpoint must not fail the tool call. The
      // CLI already treats this as best-effort (it warns and continues text-only), so
      // the MCP path matches it. stdout is the MCP transport, so the warning goes to
      // stderr only — a stray stdout line would corrupt the JSON-RPC stream.
      let queryEmbedding: Float32Array | undefined;
      try {
        const { embedQuery } = await import('../retrieval/embeddings.ts');
        queryEmbedding = await embedQuery(cfg.embeddings, query);
      } catch (e) {
        process.stderr.write(`circadia: query embedding failed, continuing text-only: ${(e as Error).message}\n`);
      }
      // C16: log access by default (config `mcp.logAccess`). The log stores only the query
      // hash, so this is privacy-safe, and without it MCP use never feeds ACT-R.
      const r = await recallModule.recall(vaultRoot, cfg, query, {
        mode,
        asOf,
        topK,
        scope,
        session,
        logAccess: cfg.mcp.logAccess,
        queryEmbedding,
        // Phase 2 adjacency cache: reuse the per-mode graph across calls in this
        // long-running process. Undefined for one-shot callers (tests, CLI).
        graphCache,
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: recallModule.renderForContext(r) }],
          modeUsed: r.modeUsed,
          modeRequested: r.modeRequested,
          escalations: r.escalations,
          // Structured seed provenance (README: "structured metadata ... so clients can
          // show provenance"). `via` includes 'vector' when the dense path contributed.
          seeds: r.seeds,
          // RFC-0002: per-hit `via` marks fact-expansion insertions, and `expanded` is the
          // count. Both are absent when expansion is off, so a flag-off payload is
          // unchanged. Clients that ignore unknown fields are unaffected.
          hits: r.hits.map((h) => ({
            passageId: h.passageId,
            noteId: h.noteId,
            path: h.path,
            title: h.title,
            trust: h.trust,
            score: h.score,
            ...(h.via ? { via: h.via } : {}),
          })),
          ...(r.expanded !== undefined ? { expanded: r.expanded } : {}),
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
      // B3: the index is derived, so a freshly written episode is not retrievable until
      // it is reindexed. Reindex incrementally here (the same entrypoint the CLI uses)
      // so a remember followed by a recall in the same session sees the new content.
      // Errors propagate to the handler's catch, matching every other failure path.
      const indexerModule = await import('../index/indexer.ts');
      indexerModule.incrementalIndex(vaultRoot, cfg);
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

    if (method === 'wake') {
      const wakeModule = await import('../dreams/wake.ts');
      const r = wakeModule.wake(vaultRoot, cfg);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: wakeModule.renderWake(r) }],
          ...wakeModule.wakeJson(r),
        },
      };
    }

    if (method === 'endorse_dream' && params && 'id' in params && typeof params.id === 'string') {
      // RFC-0001 "Confirmation": the agent relays that the user liked a fragment. This
      // writes nothing in the vault; only the candidate's own state changes.
      const candModule = await import('../dreams/candidates.ts');
      const note = typeof params.note === 'string' ? params.note : undefined;
      const r = candModule.transitionCandidate(vaultRoot, params.id, 'endorse', {
        note,
        ttlNights: cfg.dreaming.candidateTtlNights,
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: r.message }],
          ok: r.ok,
          candidate: r.candidate ?? null,
          ...(r.ok ? {} : { isError: true }),
        },
      };
    }

    if (method === 'dismiss_dream' && params && 'id' in params && typeof params.id === 'string') {
      // Removing is always safe to delegate; this writes nothing in the vault.
      const candModule = await import('../dreams/candidates.ts');
      const r = candModule.transitionCandidate(vaultRoot, params.id, 'dismiss');
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: r.message }],
          ok: r.ok,
          candidate: r.candidate ?? null,
          ...(r.ok ? {} : { isError: true }),
        },
      };
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
  graphCache?: GraphCache,
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
    return handleToolsCall(vaultRoot, cfg, params?.name as string, params?.arguments as Record<string, unknown>, id, graphCache);
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

export async function runServer(vaultRoot: string): Promise<void> {
  const cfg = loadConfig(vaultRoot);
  // Phase 2 adjacency cache: open the index once and keep the per-mode graph in memory
  // across recall calls. The cache self-invalidates when the index's `built_at` changes,
  // so a reindex is picked up without restarting the server.
  const { db } = openIndex(join(vaultRoot, cfg.index.path));
  const graphCache = createGraphCache(db);
  try {
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
      const res = await dispatch(req, vaultRoot, cfg, graphCache);
      if (!isNotification) writeStdout(res);
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// RFC-0004 §3: workspace MCP server.
//
// Pinned (default): the server resolves the lineage once, at startup, and opens only
// those vaults. A sibling vault's files are never opened, so no bug in recall can leak
// them. Request-selected (opt-in): every tool call carries `project` and/or `agent`, and
// the server resolves the cell from the registry. In both modes the destination vault is
// resolved by the server from the registry plus the binding — no argument, frontmatter
// field or archive content can choose a vault directly (Hindsight finding 2).
// ---------------------------------------------------------------------------

export interface WorkspaceServerOptions {
  workspaceDir: string;
  project: string | null;
  agent: string | null;
  selectPerRequest: boolean;
}

interface ActiveBinding {
  binding: Cell;
  lineage: LineageEntry[];
  writeTargets: WriteTarget[];
}

/** Resolve the active binding for a call. Pinned uses the startup binding; request mode
 *  reads `project`/`agent` from the call and errors when neither is present. */
export function resolveActive(
  registry: WorkspaceRegistry,
  dir: string,
  pinned: ActiveBinding | null,
  params: Record<string, unknown> | undefined,
): { active?: ActiveBinding; error?: string } {
  if (pinned) return { active: pinned };
  const project = typeof params?.project === 'string' ? params.project : null;
  const agent = typeof params?.agent === 'string' ? params.agent : null;
  if (project === null && agent === null) {
    return { error: 'request-selected mode: every call must carry project and/or agent' };
  }
  const { binding, problems } = resolveBinding(registry, project, agent);
  const errs = problems.filter((p) => p.severity === 'error');
  if (errs.length) return { error: errs.map((p) => p.message).join('; ') };
  let lineage: LineageEntry[];
  try {
    lineage = resolveLineage(registry, dir, binding);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (lineage.length === 0) return { error: `binding (${project ?? '*'}, ${agent ?? '*'}) has no vaults` };
  return { active: { binding, lineage, writeTargets: writeTargetsFor(registry, agent) } };
}

export function workspaceInitResult(id: string | number | null, active: ActiveBinding | null, opts: WorkspaceServerOptions): JSONRPCResponse {
  const binding = active
    ? { project: active.binding.project, agent: active.binding.agent, lineage: active.lineage.map((e) => ({ id: e.id, layer: e.layer })), writeTargets: active.writeTargets }
    : { mode: 'request-selected', note: 'each call must carry project and/or agent' };
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      serverInfo: { name: 'circadia', version: '0.1.0', workspace: opts.workspaceDir, binding },
      capabilities: { tools: {} },
      instructions: active
        ? `Bound to (${active.binding.project ?? '*'}, ${active.binding.agent ?? '*'}). Lineage: ${active.lineage.map((e) => `${e.layer}=${e.id}`).join(', ')}. Write targets: ${active.writeTargets.join(', ')}.`
        : 'Request-selected workspace server: every tool call must carry project and/or agent.',
    },
  };
}

export async function handleWorkspaceToolsCall(
  registry: WorkspaceRegistry,
  dir: string,
  active: ActiveBinding,
  method: string,
  params: Record<string, unknown> | undefined,
  id: string | number | null,
  graphCaches: Record<string, GraphCache>,
): Promise<JSONRPCResponse> {
  const bound = active.lineage[0];
  const boundCfg = loadConfig(bound.path, registry.defaults);

  if (method === 'recall' && params && typeof params.query === 'string') {
    // RFC-0004 §4.7: `layers` can only narrow the lineage. An unknown value is an invalid
    // param, matching the CLI's validation, not a silent narrowing to nothing.
    let layers: Layer[] | undefined;
    if (params.layers !== undefined) {
      if (!Array.isArray(params.layers) || params.layers.some((l) => !LAYER_ORDER.includes(l as Layer))) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Invalid params: layers must be an array of agent, project, global-agent, or global' },
        };
      }
      layers = params.layers as Layer[];
    }
    // An unparseable as_of is a protocol error, matching the single-vault server, not a
    // silent null that filters every hit away.
    let asOf: number | null = null;
    if (params.as_of !== undefined) {
      if (typeof params.as_of !== 'string' || Number.isNaN(Date.parse(params.as_of))) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Invalid params: as_of must be a parseable date string' },
        };
      }
      asOf = Date.parse(params.as_of);
    }
    const r = await workspaceRecall(registry, active.lineage, params.query, {
      mode: params.mode as QueryMode | undefined,
      asOf,
      topK: typeof params.top_k === 'number' ? params.top_k : undefined,
      scope: typeof params.scope === 'string' ? params.scope : undefined,
      session: typeof params.session === 'string' ? params.session : undefined,
      logAccess: boundCfg.mcp.logAccess,
      layers,
      graphCaches,
    });
    const recallModule = await import('../retrieval/recall.ts');
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: recallModule.renderForContext(r as unknown as Parameters<typeof recallModule.renderForContext>[0]) }],
        modeUsed: r.modeUsed,
        modeRequested: r.modeRequested,
        byVault: r.byVault,
        hits: r.hits.map((h) => ({
          passageId: h.passageId,
          noteId: h.noteId,
          path: h.path,
          title: h.title,
          trust: h.trust,
          score: h.score,
          vault: h.vault,
          layer: h.layer,
          ...(h.via ? { via: h.via } : {}),
        })),
      },
    };
  }

  if (method === 'remember' && params && typeof params.text === 'string') {
    if (params.by === 'user') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'remember: by "user" is not allowed over MCP; use "agent", "tool", or "web"' }], isError: true },
      };
    }
    const target = (typeof params.target === 'string' ? params.target : 'self') as WriteTarget;
    if (!active.writeTargets.includes(target)) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `remember: target "${target}" is not allowed for this binding (allowed: ${active.writeTargets.join(', ')})` }], isError: true },
      };
    }
    const targetId = targetVaultId(registry, active.binding, target);
    if (targetId === null) {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `remember: target "${target}" has no vault in this workspace` }], isError: true },
      };
    }
    const targetPath = join(dir, targetId);
    const targetCfg = loadConfig(targetPath, registry.defaults);
    const by = (params.by as SourceKind | undefined) ?? 'agent';
    const segModule = await import('../episodes/segment.ts');
    const epModule = await import('../episodes/episode.ts');
    const segs = segModule.segmentText(params.text, { by, source: params.source as SourceKind | undefined });
    const result = await epModule.writeEpisodes(targetPath, targetCfg, segs, {
      session: params.session as string | undefined,
      by,
      source: params.source as SourceKind | undefined,
      // The server sets `agent` from the binding, never from free text.
      agent: active.binding.agent ?? undefined,
    });
    // B3: reindex the target vault so the new episode is retrievable immediately.
    const indexerModule = await import('../index/indexer.ts');
    indexerModule.incrementalIndex(targetPath, targetCfg);
    const text = `Wrote ${result.episodes.length} episode(s) to ${targetId}: ${result.episodes.map((e: { path: string }) => e.path).join(', ')}`;
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], vault: targetId, episodes: result.episodes.map((e: { path: string; title: string; boundary: string }) => ({ path: e.path, title: e.title, boundary: e.boundary })) },
    };
  }

  if (method === 'get_note' && params && typeof params.id === 'string') {
    const raw = params.id;
    const colon = raw.indexOf(':');
    let candidates = active.lineage;
    let bare = raw;
    if (colon > 0) {
      const prefix = raw.slice(0, colon);
      const entry = active.lineage.find((e) => e.id === prefix);
      if (entry) {
        candidates = [entry];
        bare = raw.slice(colon + 1);
      }
    }
    const indexerModule = await import('../index/indexer.ts');
    const fsModule = await import('node:fs');
    for (const entry of candidates) {
      const cfg = loadConfig(entry.path, registry.defaults);
      const notes = indexerModule.parseVault(entry.path, cfg);
      const note = notes.find((n) => n.id === bare || n.path === bare);
      if (note) {
        const text = fsModule.readFileSync(join(entry.path, note.path), 'utf8');
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], note: { id: note.id, path: note.path, title: note.title, vault: entry.id, layer: entry.layer } } };
      }
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Note not found: ' + raw }], isError: true } };
  }

  if (method === 'timeline' && params && typeof params.entity === 'string') {
    const timelineModule = await import('../retrieval/timeline.ts');
    const dbModule = await import('../index/db.ts');
    const sections: { vault: string; layer: Layer; entries: unknown[] }[] = [];
    for (const entry of active.lineage) {
      try {
        const cfg = loadConfig(entry.path, registry.defaults);
        const { db } = dbModule.openIndex(join(entry.path, cfg.index.path), { readOnly: !isVaultWritable(entry.path) });
        try {
          const entries = timelineModule.timeline(db, params.entity, cfg);
          if (entries.length > 0) sections.push({ vault: entry.id, layer: entry.layer, entries });
        } finally {
          db.close();
        }
      } catch {
        // a lineage vault that can't be read is skipped, not fatal
      }
    }
    const text = sections
      .map((s) => `## ${s.layer}: ${s.vault}\n` + (s.entries as { valid_from: number | null; predicate: string; object: string }[]).map((e) => `${e.valid_from ? new Date(e.valid_from).toISOString().slice(0, 10) : '…'} ${e.predicate} ${e.object}`).join('\n'))
      .join('\n\n');
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text || `no facts about ${params.entity}` }], sections } };
  }

  if (method === 'relate' && params && typeof params.a === 'string' && typeof params.b === 'string') {
    const relateModule = await import('../retrieval/relate.ts');
    const dbModule = await import('../index/db.ts');
    // RFC-0004 §4: relate runs in the first lineage vault that has both endpoints, or the
    // vault named by an optional `layer`. An unknown layer name is an invalid param; a
    // valid layer absent from the lineage is a tool error.
    let candidates = active.lineage;
    if (params.layer !== undefined) {
      if (typeof params.layer !== 'string' || !LAYER_ORDER.includes(params.layer as Layer)) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Invalid params: layer must be agent, project, global-agent, or global' },
        };
      }
      const entry = active.lineage.find((e) => e.layer === params.layer);
      if (!entry) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `relate: layer "${params.layer}" is not in this binding's lineage` }], isError: true },
        };
      }
      candidates = [entry];
    }
    for (const entry of candidates) {
      try {
        const cfg = loadConfig(entry.path, registry.defaults);
        const { db } = dbModule.openIndex(join(entry.path, cfg.index.path), { readOnly: !isVaultWritable(entry.path) });
        try {
          const r = relateModule.relate(db, params.a, params.b, cfg, { maxDepth: typeof params.max_hops === 'number' ? params.max_hops : undefined });
          if (r.found) {
            const text = r.paths.map((p) => p.nodes.join(' → ')).join('\n');
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], vault: entry.id, layer: entry.layer, paths: r.paths.map((p) => ({ nodes: p.nodes, edges: p.edges })), found: true } };
          }
        } finally {
          db.close();
        }
      } catch {
        // skip an unreadable vault
      }
    }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'No path found' }], found: false } };
  }

  // wake / endorse_dream / dismiss_dream and any other tool act on the bound cell only.
  return handleToolsCall(bound.path, boundCfg, method, params, id, graphCaches[bound.id]);
}

export async function runWorkspaceServer(opts: WorkspaceServerOptions): Promise<void> {
  const dir = opts.workspaceDir;
  const { registry } = loadWorkspace(dir);
  let pinned: ActiveBinding | null = null;
  if (!opts.selectPerRequest) {
    const { binding, problems } = resolveBinding(registry, opts.project, opts.agent);
    const errs = problems.filter((p) => p.severity === 'error');
    if (errs.length) throw new Error(errs.map((p) => p.message).join('; '));
    const lineage = resolveLineage(registry, dir, binding);
    if (lineage.length === 0) throw new Error(`binding (${opts.project ?? '*'}, ${opts.agent ?? '*'}) has no vaults`);
    pinned = { binding, lineage, writeTargets: writeTargetsFor(registry, binding.agent) };
  }

  // One graph cache per lineage vault, opened lazily and kept for the process lifetime.
  const graphCaches: Record<string, GraphCache> = {};
  const openDbs: { close: () => void }[] = [];
  const openCache = (entry: LineageEntry): GraphCache => {
    if (!graphCaches[entry.id]) {
      const cfg = loadConfig(entry.path, registry.defaults);
      // A `:ro` layer cannot host SQLite's WAL sidecar, so open it immutable (RFC-0004 §8).
      const { db } = openIndex(join(entry.path, cfg.index.path), { readOnly: !isVaultWritable(entry.path) });
      openDbs.push(db);
      graphCaches[entry.id] = createGraphCache(db);
    }
    return graphCaches[entry.id];
  };
  if (pinned) for (const e of pinned.lineage) openCache(e);

  try {
    for await (const line of readLines()) {
      if (line.trim().length === 0) continue;
      let req: JSONRPCRequest;
      try {
        req = JSON.parse(line);
      } catch {
        writeStdout({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      const isNotification = !Object.prototype.hasOwnProperty.call(req, 'id');
      const id = req.id ?? null;
      let res: JSONRPCResponse;
      if (req.method === 'initialize') {
        res = workspaceInitResult(id, pinned, opts);
      } else if (req.method === 'tools/list') {
        // handleToolsList ignores the config; pass the bound vault's when pinned, else
        // the built-in defaults (a request-selected workspace root is not a vault).
        res = await handleToolsList(dir, pinned ? loadConfig(pinned.lineage[0].path, registry.defaults) : DEFAULT_CONFIG, id, pinned?.writeTargets, true);
      } else if (req.method === 'tools/call') {
        const params = req.params?.arguments as Record<string, unknown> | undefined;
        const { active, error } = resolveActive(registry, dir, pinned, params);
        if (!active) {
          res = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error ?? 'no binding' }], isError: true } };
        } else {
          for (const e of active.lineage) openCache(e);
          res = await handleWorkspaceToolsCall(registry, dir, active, req.params?.name as string, params, id, graphCaches);
        }
      } else {
        res = { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + req.method } };
      }
      if (!isNotification) writeStdout(res);
    }
  } finally {
    for (const db of openDbs) db.close();
  }
}
