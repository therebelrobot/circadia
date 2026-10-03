// Pollution experiment for RFC-0004 / issue #3.
//
// Status-quo setup: three agents (architect, coder, qa) each run their own
// `circadia mcp --vault <shared>` process, all pointed at ONE vault — the only way to give
// several agents memory today. Every write and agent-facing read goes through the real MCP
// server via the official SDK client. Consolidation runs the real code path against a
// loopback mock model (the repo's mock-model-e2e pattern). Nothing touches examples/vault/.
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const BIN = join(REPO, 'bin/circadia.mjs');
const { loadConfig } = await import(join(REPO, 'src/config.ts'));
const { incrementalIndex } = await import(join(REPO, 'src/index/indexer.ts'));
const { recall } = await import(join(REPO, 'src/retrieval/recall.ts'));
const { consolidate } = await import(join(REPO, 'src/consolidation/consolidate.ts'));
const { runRem } = await import(join(REPO, 'src/dreams/rem.ts'));

type Agent = 'architect' | 'coder' | 'qa';
const out: Record<string, unknown> = {};
const log = (s = '') => console.log(s);

// ---------------------------------------------------------------- mock model
function candidatesFor(user: string): unknown[] {
  const c: unknown[] = [];
  if (user.includes('ARCH_RETRY'))
    c.push({ subject: 'billing-api', predicate: 'retry_max_attempts', object: '3', valid: true, confidence: 0.95 });
  if (user.includes('CODER_SPIKE'))
    c.push({ subject: 'billing-api', predicate: 'uses_cache', object: '[[redis]]', valid: true, confidence: 0.8 });
  if (user.includes('CODER_LOCALDB'))
    c.push({ subject: 'billing-api', predicate: 'uses_db', object: '[[sqlite]]', valid: true, confidence: 0.8 });
  if (user.includes('QA_FLAKY')) {
    c.push({ subject: 'billing-api', predicate: 'retry_max_attempts', object: '5', valid: true, confidence: 0.7 });
    c.push({ subject: 'billing-api', predicate: 'known_issue', object: 'payment retry test is flaky', valid: true, confidence: 0.9 });
  }
  return c;
}
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ candidates: candidatesFor(user) }) } }] }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1/chat/completions`;

// ---------------------------------------------------------------- shared vault
const vault = mkdtempSync(join(tmpdir(), 'circadia-pollution-'));
execFileSync(process.execPath, [BIN, 'init', vault], { stdio: 'ignore' });
const cfgPath = join(vault, 'circadia.config.json');
const cfgJson = JSON.parse(readFileSync(cfgPath, 'utf8'));
cfgJson.extraction = { provider: 'http', endpoint: modelUrl, model: 'mock' };
cfgJson.predicates = {
  strict: false,
  defs: {
    ...(cfgJson.predicates?.defs ?? {}),
    uses_db: { object: 'entity', cardinality: 'single' },
    uses_cache: { object: 'entity' },
    retry_max_attempts: { object: 'literal', cardinality: 'single' },
    known_issue: { object: 'literal' },
  },
};
writeFileSync(cfgPath, JSON.stringify(cfgJson, null, 2));

// Shared project knowledge, written by the human.
const note = (rel: string, body: string) => {
  mkdirSync(join(vault, rel, '..'), { recursive: true });
  writeFileSync(join(vault, rel), body);
};
note('entities/project/billing-api.md', `---\ntype: entity\nkind: project\ncreated: 2026-06-01\naliases: [billing api]\n---\n# billing-api\n\nThe payments and invoicing service.\n\n## Facts\n- [uses_db:: [[postgres]]] [valid:: 2026-06..] [by:: user]\n`);
note('entities/tool/postgres.md', `---\ntype: entity\nkind: tool\ncreated: 2026-06-01\n---\n# postgres\n\nPrimary relational database.\n`);
note('entities/tool/redis.md', `---\ntype: entity\nkind: tool\ncreated: 2026-06-01\n---\n# redis\n\nIn-memory store.\n`);
note('entities/tool/sqlite.md', `---\ntype: entity\nkind: tool\ncreated: 2026-06-01\n---\n# sqlite\n\nEmbedded database.\n`);
for (const [id, kind, text] of [
  ['invoice-renderer', 'project', 'Renders PDF invoices from billing data.'],
  ['ledger-export', 'project', 'Nightly export of ledger rows to the accounting system.'],
  ['oncall-runbook', 'concept', 'How to page and escalate production incidents.'],
] as const)
  note(`entities/${kind}/${id}.md`, `---\ntype: entity\nkind: ${kind}\ncreated: 2026-05-01\n---\n# ${id}\n\n${text}\n`);
execFileSync('git', ['init', '-q'], { cwd: vault });
execFileSync('git', ['-c', 'user.name=exp', '-c', 'user.email=exp@example.invalid', 'add', '-A'], { cwd: vault });
execFileSync('git', ['-c', 'user.name=exp', '-c', 'user.email=exp@example.invalid', 'commit', '-qm', 'seed'], { cwd: vault });
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'exp';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'exp@example.invalid';

// ---------------------------------------------------------------- agents over MCP
async function connect(agent: Agent) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', '--vault', vault], stderr: 'ignore' });
  const client = new Client({ name: `agent-${agent}`, version: '0.0.0' });
  await client.connect(transport);
  return client;
}
const clients: Record<Agent, Client> = { architect: await connect('architect'), coder: await connect('coder'), qa: await connect('qa') };

const writtenBy = new Map<string, Agent>(); // episode note id -> agent (ground truth the vault does NOT record)
const texts: Record<Agent, string[]> = {
  architect: [
    'Decision ARCH_RETRY: billing api payment retries use idempotency keys with exponential backoff, at most 3 attempts. We chose postgres advisory locks over redis for the retry job queue, to keep one datastore.',
    'Architecture note: the invoice renderer reads billing api data through a read replica, never the primary.',
  ],
  coder: [
    'CODER_SPIKE: spiking a redis cache for billing api invoice lookups on my branch. Throwaway experiment, not merged.',
    'CODER_LOCALDB: for local dev I run the billing api against sqlite because postgres in docker is slow on my laptop.',
  ],
  qa: [
    'QA_FLAKY: the billing api payment retry test is flaky on CI; retries fire 5 times instead of 3. Logged as a known issue. I suspect the retry policy is wrong.',
    'QA note: ledger export failed the reconciliation check twice this week.',
  ],
};
for (const agent of ['architect', 'coder', 'qa'] as Agent[]) {
  for (const [i, text] of texts[agent].entries()) {
    const r = (await clients[agent].callTool({ name: 'remember', arguments: { text, session: `${agent}-s${i}` } })) as { episodes: { path: string }[] };
    for (const e of r.episodes) writtenBy.set(e.path.replace(/^.*\//, '').replace(/\.md$/, ''), agent);
  }
}
const episodeFrontmatter = readdirSync(join(vault, 'episodes'), { recursive: true })
  .map(String).filter((p) => p.endsWith('.md'))
  .map((p) => readFileSync(join(vault, 'episodes', p), 'utf8').split('---')[1].trim());
out.episodes = { written: writtenBy.size, sampleFrontmatter: episodeFrontmatter[0] };

// remember does not reindex; this is what `watch` would do.
const cfg = loadConfig(vault);
incrementalIndex(vault, cfg);

// ---------------------------------------------------------------- P1 recall leakage (as agents, over MCP)
const agentOf = (noteId: string): string => writtenBy.get(noteId) ?? 'shared';
async function agentRecall(agent: Agent, query: string, extra: Record<string, unknown> = {}) {
  const r = (await clients[agent].callTool({ name: 'recall', arguments: { query, ...extra } })) as { hits?: { noteId: string; trust: string }[]; content: { text: string }[] };
  return (r.hits ?? []).map((h) => ({ note: h.noteId, writer: agentOf(h.noteId) }));
}
const p1: Record<string, unknown> = {};
const probes: [Agent, string][] = [
  ['coder', 'how many retry attempts for billing api payments'],
  ['architect', 'billing api cache and datastore'],
  ['coder', 'what database does the billing api use'],
  ['qa', 'invoice renderer billing api'],
];
for (const [agent, q] of probes) {
  const hits = await agentRecall(agent, q);
  const foreign = hits.filter((h) => h.writer !== agent && h.writer !== 'shared');
  p1[`${agent}: ${q}`] = { hits, foreignAgentHits: foreign.length, ofEpisodeHits: hits.filter((h) => h.writer !== 'shared').length };
}
out.P1_recallLeakage = p1;

// ---------------------------------------------------------------- P2 can scope isolate an agent?
out.P2_scope = {
  'tag:coder': await agentRecall('coder', 'billing api', { scope: 'tag:coder' }),
  'episodes/': (await agentRecall('coder', 'billing api', { scope: 'episodes/' })).map((h) => h.writer),
};

// ---------------------------------------------------------------- P3 ACT-R coupling via the shared access log
// Measure (without logging) where the QA episode ranks for the coder, then let QA recall
// its own topic 15 times over MCP (logged, as normal use does), then measure again.
const qaEp = [...writtenBy].find(([, a]) => a === 'qa')![0];
async function rankFor(query: string) {
  const r = await recall(vault, cfg, query, { logAccess: false });
  const i = r.hits.findIndex((h: { noteId: string }) => h.noteId === qaEp);
  const hit = r.hits[i];
  return { rank: i < 0 ? null : i + 1, activation: hit?.components?.activation ?? null, score: hit?.score ?? null, top: r.hits.slice(0, 4).map((h: { noteId: string }) => `${h.noteId} (${agentOf(h.noteId)})`) };
}
const coderQuery = 'billing api retry attempts';
const before = await rankFor(coderQuery);
for (let i = 0; i < 15; i++) await clients.qa.callTool({ name: 'recall', arguments: { query: 'flaky payment retry test billing api', session: 'qa-s9' } });
const after = await rankFor(coderQuery);
out.P3_actrCoupling = { coderQuery, qaEpisode: qaEp, before, after, accessLogLines: readFileSync(join(vault, '.circadia/access.jsonl'), 'utf8').trim().split('\n').length };

// ---------------------------------------------------------------- P4 consolidation across agents
const cons = await consolidate(vault, cfg, { commit: true });
const billing = readFileSync(join(vault, 'entities/project/billing-api.md'), 'utf8');
const pendingPath = join(vault, '.circadia/pending.jsonl');
const pending = existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
out.P4_consolidation = {
  summary: { promoted: cons.promoted?.length ?? cons.promoted, queued: cons.queued?.length ?? cons.queued, superseded: cons.superseded?.length ?? cons.superseded },
  billingApiFacts: billing.split('## Facts')[1]?.trim(),
  pending: pending.map((p: Record<string, unknown>) => ({ reason: p.reason, candidate: p.candidate ?? p, episode: p.episode })),
};
incrementalIndex(vault, cfg);
// What the architect now reads about billing-api's facts.
const archView = (await clients.architect.callTool({ name: 'recall', arguments: { query: 'billing api facts cache retry attempts' } })) as { content: { text: string }[] };
out.P4_architectReadsAfterSleep = archView.content[0].text.split('\n').filter((l) => /uses_cache|retry_max_attempts|known_issue|uses_db/.test(l));

// ---------------------------------------------------------------- P5 dreaming pairs across agents
// Commit consolidation's state so the gitignore check passes, then sample (no model calls).
try {
  const rem = await runRem(vault, { ...cfg, dreaming: { ...cfg.dreaming, enabled: true } }, { sampleOnly: true });
  const pairs = (rem.pairs ?? []) as { a: string; b: string }[];
  const label = (id: string) => `${id} (${agentOf(id.replace(/#.*$/, ''))})`;
  out.P5_dreamPairs = {
    ran: rem.ran, reason: (rem as { reason?: string }).reason,
    pairs: pairs.map((p) => `${label(p.a)} <-> ${label(p.b)}`),
    crossAgent: pairs.filter((p) => { const a = agentOf(p.a.replace(/#.*$/, '')), b = agentOf(p.b.replace(/#.*$/, '')); return a !== 'shared' && b !== 'shared' && a !== b; }).length,
  };
} catch (e) {
  out.P5_dreamPairs = { error: (e as Error).message };
}

for (const c of Object.values(clients)) await c.close();
model.close();
out.vault = vault;
console.log(JSON.stringify(out, null, 2));
