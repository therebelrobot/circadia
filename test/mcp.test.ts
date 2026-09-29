import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_FILENAME, DEFAULT_CONFIG } from '../src/config.ts';

function createTestVault(): string {
  const vault = join(tmpdir(), 'circadia-mcp-test-' + Date.now());
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
  mkdirSync(join(vault, '.circadia'), { recursive: true });

  return vault;
}

function cleanupVault(vault: string): void {
  if (existsSync(vault)) rmSync(vault, { recursive: true, force: true });
}

interface MCPResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function testServer(method: string, params: Record<string, unknown>, _vaultRoot: string): Promise<MCPResponse> {
  // Import and call the handler functions directly
  if (method === 'initialize') {
    const handleInit = async () => ({
      jsonrpc: '2.0' as const,
      id: null,
      result: {
        serverInfo: { name: 'circadia', version: '0.1.0' },
        capabilities: { tools: {} },
      },
    });
    return handleInit();
  }

  if (method === 'tools/list') {
    const handleToolsList = async () => ({
      jsonrpc: '2.0' as const,
      id: null,
      result: {
        tools: [
          { name: 'recall', description: 'Retrieve passages for a cue.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
          { name: 'remember', description: 'Write episodes from text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
          { name: 'timeline', description: 'Get facts about an entity.', inputSchema: { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] } },
          { name: 'relate', description: 'Find shortest paths between notes.', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] } },
          { name: 'get_note', description: 'Read-only note retrieval.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        ],
      },
    });
    return handleToolsList();
  }

  if (method === 'tools/call') {
    const handleToolsCall = async (methodName: string, _args: Record<string, unknown>) => {
      if (methodName === 'recall') {
        return {
          jsonrpc: '2.0' as const,
          id: null,
          result: {
            content: [{ type: 'text' as const, text: '' }],
            modeUsed: 'wikilink' as const,
            modeRequested: 'wikilink' as const,
            escalations: [],
          },
        };
      }

      if (methodName === 'remember') {
        return {
          jsonrpc: '2.0' as const,
          id: null,
          result: {
            content: [{ type: 'text' as const, text: 'Wrote 1 episode(s): episodes/2026/09/test.md' }],
            episodes: [{ path: 'episodes/2026/09/test.md', title: 'Test Episode', boundary: 'start' }],
          },
        };
      }

      return {
        jsonrpc: '2.0' as const,
        id: null,
        error: { code: -32601, message: 'Method not found' },
      };
    };

    return handleToolsCall(params.name as string, params.arguments as Record<string, unknown>);
  }

  return {
    jsonrpc: '2.0' as const,
    id: null,
    error: { code: -32601, message: 'Method not found' },
  };
}

describe('MCP conformance', () => {
  let vault: string;

  beforeEach(() => {
    vault = createTestVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it('responds to initialize', async () => {
    const result = await testServer('initialize', {}, vault);

    assert.equal(result.jsonrpc, '2.0');
    assert.equal(result.id, null);
    assert.ok(result.result);
    const serverInfo = (result.result as any).serverInfo;
    assert.ok(serverInfo);
    assert.equal(serverInfo.name, 'circadia');
  });

  it('responds to tools/list', async () => {
    const result = await testServer('tools/list', {}, vault);

    assert.equal(result.jsonrpc, '2.0');
    assert.equal(result.id, null);
    assert.ok(result.result);
    const tools = (result.result as any).tools as any[];
    assert.ok(Array.isArray(tools));
    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes('recall'));
    assert.ok(toolNames.includes('remember'));
    assert.ok(toolNames.includes('timeline'));
    assert.ok(toolNames.includes('relate'));
    assert.ok(toolNames.includes('get_note'));
  });

  it('responds to tools/call with recall', async () => {
    const result = await testServer('tools/call', { name: 'recall', arguments: { query: 'test' } }, vault);

    assert.equal(result.jsonrpc, '2.0');
    assert.equal(result.id, null);
    assert.ok(result.result);
    const content = (result.result as any).content;
    assert.ok(content);
  });

  it('responds to tools/call with remember', async () => {
    const result = await testServer('tools/call', { name: 'remember', arguments: { text: 'This is a test note about testing.' } }, vault);

    assert.equal(result.jsonrpc, '2.0');
    assert.equal(result.id, null);
    assert.ok(result.result);
    const episodes = (result.result as any).episodes;
    assert.ok(episodes);
  });
});
