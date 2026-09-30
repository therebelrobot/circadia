// Smoke test for the Mastra example.
//
// It copies examples/vault to a temp dir, indexes the copy, then drives `circadia mcp`
// through Mastra's MCPClient: list tools, call `recall`, call `remember`, and check the
// episode landed on disk. It then runs the Mastra Agent path against a mock
// OpenAI-compatible chat server on 127.0.0.1, so the model wiring is exercised without a
// live model. It never touches the tracked examples/vault.
//
// Run:  npm run smoke   (from examples/mastra)
//
// This is intentionally outside the root test suite (the root glob is test/**/*.test.ts).

import { MCPClient } from '@mastra/mcp';
import { cpSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const sourceVault = resolve(repoRoot, 'examples', 'vault');

const tmp = mkdtempSync(join(tmpdir(), 'circadia-mastra-smoke-'));
const vault = join(tmp, 'vault');
cpSync(sourceVault, vault, { recursive: true });
// Drop any derived index copied along, so the smoke test builds its own.
rmSync(join(vault, '.circadia', 'index.sqlite'), { force: true });

// Index the copy: the MCP server needs an index to answer `recall`.
const index = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--disable-warning=ExperimentalWarning',
    resolve(repoRoot, 'src', 'cli', 'main.ts'),
    'index',
    '--vault',
    vault,
  ],
  { encoding: 'utf8' },
);
assert.equal(index.status, 0, `index failed: ${index.stderr}`);

// A mock OpenAI-compatible chat server. It answers /v1/chat/completions with a canned
// assistant message, so the Agent path runs end to end with no live model.
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'qwen2.5-7b-instruct',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'The orchard sensors run on the pi cluster.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;

const mcp = new MCPClient({
  id: 'circadia-mastra-smoke',
  servers: {
    circadia: {
      command: process.execPath,
      args: [resolve(repoRoot, 'bin', 'circadia.mjs'), 'mcp', '--vault', vault],
    },
  },
});

try {
  const tools = await mcp.listTools();
  assert.ok(tools['circadia_recall'], 'recall tool is exposed');
  assert.ok(tools['circadia_remember'], 'remember tool is exposed');

  const recalled = await tools['circadia_recall'].execute(
    { query: 'orchard sensors', session: 'smoke' },
    { toolCallId: 'recall-1', messages: [] },
  );
  const recallText = textOf(recalled);
  assert.ok(recallText.length > 0, 'recall returns text');

  const before = countEpisodes(vault);
  const remembered = await tools['circadia_remember'].execute(
    { text: 'The orchard sensors moved to the pi cluster.', session: 'smoke' },
    { toolCallId: 'remember-1', messages: [] },
  );
  const after = countEpisodes(vault);
  assert.ok(after > before, `remember writes an episode (${before} -> ${after})`);
  assert.ok(textOf(remembered).includes('episode'), 'remember reports the episode it wrote');

  // --- Agent path, against the mock model -------------------------------------------
  const { Agent } = await import('@mastra/core/agent');
  const agent = new Agent({
    id: 'circadia-smoke-agent',
    name: 'Circadia smoke agent',
    instructions: 'Answer from memory using the recall tool.',
    model: { id: 'custom/qwen2.5-7b-instruct', url: mockUrl },
    tools,
  });
  const res = await agent.generate('What do I know about the orchard sensors?');
  assert.ok(
    res.text.includes('orchard sensors run on the pi cluster'),
    `agent returned the mock model's text, got: ${JSON.stringify(res.text)}`,
  );

  console.log(`smoke ok: recall returned ${recallText.length} chars; episodes ${before} -> ${after}`);
  console.log(`smoke ok: agent (mock model) → ${res.text}`);
} finally {
  await mcp.disconnect();
  mock.close();
  rmSync(tmp, { recursive: true, force: true });
}

function countEpisodes(v) {
  const dir = join(v, 'episodes');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.md')).length;
}

function textOf(result) {
  if (typeof result === 'string') return result;
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('\n');
  return JSON.stringify(result, null, 2);
}
