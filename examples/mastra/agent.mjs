// Minimal Mastra agent that talks to `circadia mcp` over stdio.
//
// It connects Mastra's MCPClient to the circadia MCP server (spawned as a subprocess),
// lists the tools, and calls `recall` and `remember`. The same tools are wired into a
// Mastra Agent below, which is what a real application would use.
//
// Run:
//   npm start                                  # uses examples/vault
//   CIRCADIA_VAULT=/path/to/vault npm start    # any vault
//
// The vault must be indexed first:
//   node ../../bin/circadia.mjs index --vault <vault>
//
// The direct tool calls need no model. The Agent path needs one; see "Model" below.
// No OpenAI or xAI models, and avoid Meta models (AGENTS.md §3.4).

import { MCPClient } from '@mastra/mcp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const vault = process.env.CIRCADIA_VAULT ?? resolve(repoRoot, 'examples', 'vault');
const session = process.env.CIRCADIA_SESSION ?? 'mastra-example';

// The MCP server is a stdio subprocess. `process.execPath` is the current Node binary, so
// the example does not depend on `circadia` being on PATH.
const mcp = new MCPClient({
  id: 'circadia-mastra-example',
  servers: {
    circadia: {
      command: process.execPath,
      args: [resolve(repoRoot, 'bin', 'circadia.mjs'), 'mcp', '--vault', vault],
    },
  },
});

try {
  const tools = await mcp.listTools();
  console.log('connected. tools:', Object.keys(tools).join(', '));

  // Mastra namespaces MCP tools as `<server>_<tool>`.
  const recall = tools['circadia_recall'];
  const remember = tools['circadia_remember'];
  if (!recall || !remember) throw new Error('circadia_recall / circadia_remember not found');

  const recalled = await recall.execute(
    { query: 'orchard sensors', session },
    { toolCallId: 'recall-1', messages: [] },
  );
  console.log('\nrecall →');
  console.log(textOf(recalled));

  const remembered = await remember.execute(
    { text: 'The orchard sensors moved to the pi cluster.', session },
    { toolCallId: 'remember-1', messages: [] },
  );
  console.log('\nremember →');
  console.log(textOf(remembered));

  // --- Agent wiring -----------------------------------------------------------------
  // A real application hands the same tools to a Mastra Agent. This needs a model.
  //
  // Model: a local OpenAI-compatible server (llama.cpp's `llama-server`, LM Studio, vLLM)
  // is configured with `{ id, url }`, where `url` is the BASE url, not the chat endpoint:
  //
  //   CIRCADIA_MODEL=custom/qwen2.5-7b-instruct \
  //   CIRCADIA_MODEL_URL=http://127.0.0.1:8080/v1 npm start
  //
  // A hosted model is a model-router id string (no url). Use a non-OpenAI, non-xAI model;
  // a Qwen or Mistral model through OpenRouter, for example:
  //
  //   CIRCADIA_MODEL=openrouter/qwen/qwen3-235b-a22b npm start
  if (process.env.CIRCADIA_MODEL) {
    const { Agent } = await import('@mastra/core/agent');
    const model = process.env.CIRCADIA_MODEL_URL
      ? { id: process.env.CIRCADIA_MODEL, url: process.env.CIRCADIA_MODEL_URL }
      : process.env.CIRCADIA_MODEL;
    const agent = new Agent({
      id: 'circadia-agent',
      name: 'Circadia agent',
      instructions:
        'You answer from the user\'s memory. Use the recall tool to find passages and ' +
        'the remember tool to record new episodes. Cite the source path of anything you use.',
      model,
      tools,
    });
    const res = await agent.generate('What do I know about the orchard sensors?');
    console.log('\nagent →');
    console.log(res.text);
  } else {
    console.log('\n(set CIRCADIA_MODEL to also run the Mastra Agent over these tools)');
  }
} finally {
  await mcp.disconnect();
}

/** Pull the text out of an MCP tool result, whatever shape Mastra returns. */
function textOf(result) {
  if (typeof result === 'string') return result;
  const content = result?.content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('\n');
  return JSON.stringify(result, null, 2);
}
