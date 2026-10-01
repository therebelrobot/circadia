// Node helpers for scripts/container-smoke.sh.
//
// The MCP check needs the official SDK (a devDependency, ADR-0008), so this file is run
// with the repo's node_modules present. It is not part of the package and not shipped.
//
// Subcommands:
//   mcp <image> <vault>          connect to the container's MCP server over stdio and
//                                exercise initialize / tools/list / recall / remember
//   mock-model <portfile>        serve POST /v1/chat/completions with canned candidates;
//                                write the chosen port to <portfile>, then keep serving
//   set-endpoint <vault> <url>   point a temp vault's extraction config at <url>
//
// Every path it touches is a temp vault created by the smoke script; it never reads or
// writes examples/vault/.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Every .md file under <vault>/episodes, recursively. */
function episodeFiles(vault) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(join(vault, 'episodes'));
  return out;
}

async function mcp(image, vault) {
  // Same transport the spec names: docker run over stdio, read-only root, tmpfs /tmp,
  // no network. The vault is the only writable mount.
  const transport = new StdioClientTransport({
    command: 'docker',
    args: [
      'run', '-i', '--rm',
      '--read-only', '--tmpfs', '/tmp',
      '--network', 'none',
      '-v', `${vault}:/vault`,
      image,
    ],
  });
  const client = new Client({ name: 'circadia-container-smoke', version: '0.0.0' });
  try {
    // connect() performs the initialize handshake and validates the result.
    await client.connect(transport);

    const tools = await client.listTools();
    if (tools.tools.length !== 8) {
      throw new Error(`expected 8 tools, got ${tools.tools.length}`);
    }

    const recall = await client.callTool({ name: 'recall', arguments: { query: 'soil moisture' } });
    if (recall.isError) throw new Error('recall returned isError');

    const before = episodeFiles(vault);
    const remember = await client.callTool({
      name: 'remember',
      arguments: { text: 'The orchard sensors report soil moisture.' },
    });
    if (remember.isError) throw new Error('remember returned isError');

    const after = episodeFiles(vault);
    const created = after.filter((p) => !before.includes(p));
    if (created.length !== 1) {
      throw new Error(`expected 1 new episode, got ${created.length}`);
    }
    const body = readFileSync(created[0], 'utf8');
    if (!/^by: agent$/m.test(body)) {
      throw new Error(`new episode is not by: agent:\n${body}`);
    }

    // A business-logic refusal comes back as a tool result with isError: true.
    const refused = await client.callTool({ name: 'remember', arguments: { text: 'x', by: 'user' } });
    if (refused.isError !== true) {
      throw new Error('remember with by:user was not refused');
    }
  } finally {
    await client.close();
  }
}

function mockModel(portfile) {
  const content = JSON.stringify({
    candidates: [
      { subject: 'orchard-sensors', predicate: 'status', object: 'active', valid: true, confidence: 0.9 },
    ],
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  // Loopback only: Docker Desktop proxies host.docker.internal to the host's loopback.
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(portfile, String(server.address().port));
  });
}

function setEndpoint(vault, url) {
  const p = join(vault, 'circadia.config.json');
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.extraction = { provider: 'http', endpoint: url, model: 'smoke-model', apiKeyEnv: null };
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'mcp') await mcp(rest[0], rest[1]);
  else if (cmd === 'mock-model') mockModel(rest[0]);
  else if (cmd === 'set-endpoint') setEndpoint(rest[0], rest[1]);
  else {
    console.error(`unknown subcommand: ${cmd ?? '(none)'}`);
    process.exit(2);
  }
} catch (e) {
  console.error(`helper ${cmd} failed: ${e.message}`);
  process.exit(1);
}
