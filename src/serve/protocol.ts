// JSON-RPC 2.0 dispatch for `circadia serve` (RFC-0003 §3).
//
// The tool handlers are the same functions the stdio server uses (`handleInit`,
// `handleToolsList`, `handleToolsCall`, and the workspace trio). This module adds only what
// the HTTP transport needs: routing a single message, and putting mutating tool calls
// behind the write gate.

import { DEFAULT_CONFIG, type Config } from '../config.ts';
import {
  handleInit,
  handleToolsCall,
  handleToolsList,
  handleWorkspaceToolsCall,
  resolveActive,
  workspaceInitResult,
  ensureGraphCache,
  type ActiveBinding,
  type WorkspaceServerOptions,
} from '../mcp/server.ts';
import { join } from 'node:path';
import type { GraphCache } from '../retrieval/graph-cache.ts';
import type { WorkspaceRegistry } from '../workspace/registry.ts';
import { LockHeldError } from '../util/lockfile.ts';
import { LockWaitError, type WriteGate } from './gate.ts';
import type { Scope } from './tokens.ts';

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Tools that mutate the vault or the index; everything else is read-only (RFC-0003 §4). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['remember', 'wake', 'endorse_dream', 'dismiss_dream']);

export interface VaultDispatch {
  kind: 'vault';
  vaultRoot: string;
  cfg: Config;
  graphCache?: GraphCache;
  gate: WriteGate;
}

export interface WorkspaceDispatch {
  kind: 'workspace';
  workspaceDir: string;
  registry: WorkspaceRegistry;
  opts: WorkspaceServerOptions;
  pinned: ActiveBinding | null;
  graphCaches: Record<string, GraphCache>;
  openDbs: { close: () => void }[];
  boundCfg: Config;
  gate: WriteGate;
}

export type Dispatch = VaultDispatch | WorkspaceDispatch;

/** A retryable error response with the running job named (RFC-0003 §4). */
function retryable(id: string | number | null, e: LockWaitError | LockHeldError): RpcResponse {
  const job = e instanceof LockWaitError ? e.job : e.info.command;
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32001, message: e.message, data: { retryable: true, job } },
  };
}

/** A read token presented to a write tool: JSON-RPC error, tool not run (RFC-0003 §6). */
function readScopeRefusal(id: string | number | null, name: string): RpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32003, message: `tool "${name}" requires a write token`, data: { scope: 'read' } },
  };
}

async function runGated<T>(
  gate: WriteGate,
  vault: string,
  command: string,
  waitMs: number,
  id: string | number | null,
  fn: () => Promise<T>,
): Promise<T | RpcResponse> {
  try {
    return await gate.run(vault, command, waitMs, fn);
  } catch (e) {
    if (e instanceof LockWaitError || e instanceof LockHeldError) return retryable(id, e);
    throw e;
  }
}

export async function handleRpcMessage(req: RpcRequest, d: Dispatch, scope: Scope = 'write'): Promise<RpcResponse> {
  const id = req.id ?? null;
  if (d.kind === 'vault') {
    switch (req.method) {
      case 'initialize':
        return handleInit(id, req.params);
      case 'tools/list':
        return handleToolsList(d.vaultRoot, d.cfg, id);
      case 'tools/call': {
        const name = req.params?.name as string;
        const args = req.params?.arguments as Record<string, unknown> | undefined;
        // A read token covers only reads; a write tool with a read token errors and the
        // tool does not run (RFC-0003 §6). `wake` counts as a write: it deletes the log.
        if (WRITE_TOOLS.has(name) && scope === 'read') return readScopeRefusal(id, name);
        const run = (): ReturnType<typeof handleToolsCall> => handleToolsCall(d.vaultRoot, d.cfg, name, args, id, d.graphCache);
        return WRITE_TOOLS.has(name) ? runGated(d.gate, d.vaultRoot, name, d.cfg.serve.lockWaitMs, id, run) : run();
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + req.method } };
    }
  }

  // Workspace (RFC-0004 §3): pinned or request-selected. The destination vault is resolved
  // by the server from the registry, never from request content.
  if (req.method === 'initialize') return workspaceInitResult(id, d.pinned, d.opts);
  if (req.method === 'tools/list') {
    return handleToolsList(
      d.workspaceDir,
      d.pinned ? d.boundCfg : DEFAULT_CONFIG,
      id,
      d.pinned?.writeTargets,
      true,
    );
  }
  if (req.method === 'tools/call') {
    const name = req.params?.name as string;
    const args = req.params?.arguments as Record<string, unknown> | undefined;
    if (WRITE_TOOLS.has(name) && scope === 'read') return readScopeRefusal(id, name);
    const { active, error } = resolveActive(d.registry, d.workspaceDir, d.pinned, args);
    if (!active) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error ?? 'no binding' }], isError: true } };
    }
    for (const e of active.lineage) ensureGraphCache(e, d.registry.defaults, d.graphCaches, d.openDbs);
    const boundVault = join(d.workspaceDir, active.lineage[0].id);
    const run = (): ReturnType<typeof handleWorkspaceToolsCall> =>
      handleWorkspaceToolsCall(d.registry, d.workspaceDir, active, name, args, id, d.graphCaches);
    return WRITE_TOOLS.has(name) ? runGated(d.gate, boundVault, name, d.boundCfg.serve.lockWaitMs, id, run) : run();
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + req.method } };
}
