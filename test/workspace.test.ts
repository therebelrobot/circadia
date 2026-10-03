// RFC-0004 workspaces. Temp workspaces built from scratch; never touches examples/vault/.
//
// Coverage (RFC-0004 test plan items 1–8):
//   1. registry validation (duplicate cell, bad id, defaults.index, missing dir)
//   2. lineage resolution for each binding shape
//   3. pinned isolation: a sibling vault is never read
//   4. federated recall: merge, labels, one budget, `layers` narrowing
//   5. access log per vault
//   6. write policy: default `self` only; per-agent override
//   7. request-selected mode: missing/unknown names error
//   8. no caller path: `../global`, absolute, NUL rejected before any fs call
//   9. lift: writes one episode with by:user/source:import/origin; source unchanged
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex, embedPassages, parseVault } from '../src/index/indexer.ts';
import { HttpEmbeddingsClient } from '../src/retrieval/embeddings.ts';
import { parseNote } from '../src/vault/parse.ts';
import { main } from '../src/cli/main.ts';
import { startMockEmbeddings } from './helpers/mock-embeddings.ts';
import {
  VAULT_ID_RE,
  cellKey,
  layerOf,
  loadWorkspace,
  resolveBinding,
  resolveLineage,
  targetVaultId,
  validateRegistry,
  writeTargetsFor,
  type WorkspaceRegistry,
} from '../src/workspace/registry.ts';
import { workspaceRecall } from '../src/workspace/recall.ts';
import { lift } from '../src/workspace/lift.ts';
import { handleToolsList, handleWorkspaceToolsCall, resolveActive, workspaceInitResult } from '../src/mcp/server.ts';

/** Write a minimal vault with one entity note and index it. */
function makeVault(dir: string, noteId: string, body: string): void {
  mkdirSync(join(dir, 'entities'), { recursive: true });
  writeFileSync(join(dir, 'circadia.config.json'), JSON.stringify({}) + '\n');
  writeFileSync(join(dir, 'entities', `${noteId}.md`), `---\ntype: entity\nkind: concept\n---\n# ${noteId}\n\n${body}\n`);
  buildIndex(dir, loadConfig(dir));
}

/** A workspace with global, work, work.coder and a per-agent write policy. */
function makeWorkspace(): { dir: string; registry: WorkspaceRegistry } {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-'));
  const registry: WorkspaceRegistry = {
    workspace: 1,
    vaults: {
      global: {},
      work: { project: 'work' },
      'work.coder': { project: 'work', agent: 'coder' },
      'work.architect': { project: 'work', agent: 'architect' },
    },
    writes: { default: ['self'], agents: { architect: ['self', 'project'] } },
  };
  writeFileSync(join(dir, 'circadia.workspace.json'), JSON.stringify(registry, null, 2) + '\n');
  makeVault(join(dir, 'global'), 'operator', 'The operator prefers tabs and dark mode.');
  makeVault(join(dir, 'work'), 'api-gateway', 'The api-gateway service uses postgres for storage.');
  makeVault(join(dir, 'work.coder'), 'redis-spike', 'A redis cache spike for the api-gateway.');
  makeVault(join(dir, 'work.architect'), 'arch-note', 'The architect decided the api-gateway uses postgres.');
  return { dir, registry };
}

test('registry: rejects a duplicate cell, a bad id, and defaults.index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-val-'));
  const reg: WorkspaceRegistry = {
    workspace: 1,
    vaults: {
      work: { project: 'work' },
      'work.dup': { project: 'work' },
      '../x': {},
      A: {},
    },
    defaults: { index: { path: 'nope.sqlite' } },
  };
  const problems = validateRegistry(reg, dir);
  const codes = problems.map((p) => p.code);
  assert.ok(codes.includes('workspace.duplicate-cell'), 'duplicate cell rejected');
  assert.ok(codes.includes('workspace.bad-id'), 'bad id rejected');
  assert.ok(codes.includes('workspace.defaults-index'), 'defaults.index rejected');
});

test('registry: a registered id with no directory warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-miss-'));
  const reg: WorkspaceRegistry = { workspace: 1, vaults: { ghost: {} } };
  const problems = validateRegistry(reg, dir);
  const warn = problems.find((p) => p.code === 'workspace.missing-dir');
  assert.ok(warn, 'missing dir warns');
  assert.equal(warn!.severity, 'warning');
});

test('lineage: each binding shape resolves in precedence order, skipping absent cells', () => {
  const { dir, registry } = makeWorkspace();
  const ids = (p: string | null, a: string | null) => resolveLineage(registry, dir, { project: p, agent: a }).map((e) => `${e.layer}:${e.id}`);

  assert.deepEqual(ids('work', 'coder'), ['agent:work.coder', 'project:work', 'global:global']);
  assert.deepEqual(ids('work', null), ['project:work', 'global:global']);
  assert.deepEqual(ids(null, 'coder'), ['global:global']);
  assert.deepEqual(ids(null, null), ['global:global']);
});

test('lineage: a binding naming an unregistered project or agent errors', () => {
  const { registry } = makeWorkspace();
  const bad = resolveBinding(registry, 'nope', 'coder');
  assert.ok(bad.problems.some((p) => p.code === 'workspace.unknown-project'));
  const badAgent = resolveBinding(registry, 'work', 'nope');
  assert.ok(badAgent.problems.some((p) => p.code === 'workspace.unknown-agent'));
});

test('write policy: default is self only; a per-agent override replaces it', () => {
  const { registry } = makeWorkspace();
  assert.deepEqual(writeTargetsFor(registry, 'coder'), ['self']);
  assert.deepEqual(writeTargetsFor(registry, 'architect'), ['self', 'project']);
  assert.deepEqual(writeTargetsFor(registry, null), ['self']);
});

test('no caller path: bad ids are rejected by the pattern before any fs call', () => {
  for (const bad of ['../global', '/etc/passwd', 'a/b', 'A', '', 'work\u0000x']) {
    assert.equal(VAULT_ID_RE.test(bad), false, `"${bad}" must not match the id pattern`);
  }
  assert.equal(VAULT_ID_RE.test('work.coder'), true);
  assert.equal(VAULT_ID_RE.test('global'), true);
});

test('federated recall: merges labeled hits from the lineage and narrows with layers', async () => {
  const { dir, registry } = makeWorkspace();
  const lineage = resolveLineage(registry, dir, { project: 'work', agent: 'coder' });
  const r = await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: false, topK: 10 });
  const vaults = new Set(r.hits.map((h) => h.vault));
  assert.ok(vaults.has('work'), 'project layer contributes');
  assert.ok(vaults.has('work.coder'), 'agent layer contributes');
  for (const h of r.hits) {
    assert.ok(h.layer, 'every hit is labeled with a layer');
    assert.ok(h.vault, 'every hit is labeled with a vault');
  }
  // `layers` can only narrow.
  const only = await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: false, layers: ['project'] });
  assert.ok(only.hits.length > 0);
  assert.ok(only.hits.every((h) => h.layer === 'project'), 'layers:["project"] returns only project hits');
});

test('federated recall: a sibling vault is never read', async () => {
  const { dir, registry } = makeWorkspace();
  // Plant a unique token in the sibling (work.architect) and bind (work, coder).
  writeFileSync(
    join(dir, 'work.architect', 'entities', 'secret.md'),
    '---\ntype: entity\nkind: concept\n---\n# secret\n\nzzyzx-sibling-token.\n',
  );
  buildIndex(join(dir, 'work.architect'), loadConfig(join(dir, 'work.architect')));
  const lineage = resolveLineage(registry, dir, { project: 'work', agent: 'coder' });
  const r = await workspaceRecall(registry, lineage, 'zzyzx-sibling-token', { logAccess: false, topK: 10 });
  assert.equal(r.hits.length, 0, 'a sibling vault is not in the lineage and is never read');
});

test('access log: each vault logs only its own hits', async () => {
  const { dir, registry } = makeWorkspace();
  const lineage = resolveLineage(registry, dir, { project: 'work', agent: 'coder' });
  await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: true, topK: 10 });
  const workLog = join(dir, 'work', '.circadia', 'access.jsonl');
  const coderLog = join(dir, 'work.coder', '.circadia', 'access.jsonl');
  assert.ok(existsSync(workLog), 'work logged its hits');
  assert.ok(existsSync(coderLog), 'work.coder logged its hits');
  // The log stores a query hash (`q`), never the query text. Node ids may contain the
  // note id, so check the `q` field specifically.
  for (const f of [workLog, coderLog]) {
    const first = JSON.parse(readFileSync(f, 'utf8').split('\n').filter(Boolean)[0]) as { q: string };
    assert.notEqual(first.q, 'api-gateway', 'query text is never logged');
    assert.match(first.q, /^[0-9a-f]+$/, 'q is a hash');
  }
});

test('read-only layer: a :ro vault is recalled immutable, with no access-log write', async () => {
  const { dir, registry } = makeWorkspace();
  const roDir = join(dir, 'work');
  const roCircadia = join(roDir, '.circadia');
  // Simulate a `:ro` bind mount: neither the vault dir nor its `.circadia/` can be
  // written, so SQLite cannot create its WAL `-shm` sidecar. Before the fix this threw
  // "unable to open database file" and the layer was skipped.
  chmodSync(roDir, 0o555);
  chmodSync(roCircadia, 0o555);
  try {
    const lineage = resolveLineage(registry, dir, { project: 'work', agent: 'coder' });
    const r = await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: true, topK: 10 });
    assert.ok(r.hits.some((h) => h.layer === 'project'), 'the read-only project layer answered');
    assert.equal(
      existsSync(join(roCircadia, 'access.jsonl')),
      false,
      'no access log is written to the :ro layer',
    );
    assert.ok(
      existsSync(join(dir, 'work.coder', '.circadia', 'access.jsonl')),
      'the writable layer still logs',
    );
  } finally {
    chmodSync(roCircadia, 0o755);
    chmodSync(roDir, 0o755);
  }
});

test('lift: writes one episode with by:user/source:import/origin; source unchanged', async () => {
  const { dir, registry } = makeWorkspace();
  // Give the source vault a fact to lift.
  const srcNote = join(dir, 'work.coder', 'entities', 'redis-spike.md');
  writeFileSync(
    srcNote,
    '---\ntype: entity\nkind: concept\n---\n# redis-spike\n\nBody.\n\n## Facts\n\n- [uses_cache:: [[redis]]] [by:: user]\n',
  );
  const notes = parseVault(join(dir, 'work.coder'), loadConfig(join(dir, 'work.coder')));
  const note = notes.find((n) => n.id === 'redis-spike')!;
  const fact = note.facts[0];
  assert.ok(fact, 'source fact parsed');

  const before = readFileSync(srcNote, 'utf8');
  const r = await lift(registry, dir, 'work.coder', 'work', `redis-spike^${fact.id}`);
  assert.equal(r.targetVault, 'work');
  assert.equal(r.origin, `work.coder:redis-spike^${fact.id}`);

  const ep = readFileSync(join(dir, 'work', r.episodePath), 'utf8');
  assert.ok(ep.includes('by: user'), 'lifted episode is by: user');
  assert.ok(ep.includes('source: import'), 'lifted episode is source: import');
  assert.ok(ep.includes(`origin: work.coder:redis-spike^${fact.id}`), 'origin records the source');
  assert.equal(readFileSync(srcNote, 'utf8'), before, 'the source vault is unchanged');
});

test('mcp pinned: tools/list target enum is the write policy; remember refuses a forbidden target', async () => {
  const { dir, registry } = makeWorkspace();
  const { active } = resolveActive(registry, dir, null, { project: 'work', agent: 'coder' });
  assert.ok(active, 'pinned binding resolves');

  const list = await handleToolsList(dir, loadConfig(join(dir, 'work.coder')), 1, active!.writeTargets);
  const tools = (list.result as { tools: { name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[] }).tools;
  const remember = tools.find((t) => t.name === 'remember')!;
  assert.deepEqual(remember.inputSchema.properties.target.enum, ['self'], 'default policy exposes only self');

  const refused = await handleWorkspaceToolsCall(registry, dir, active!, 'remember', { text: 'x', target: 'project' }, 2, {});
  assert.equal((refused.result as { isError?: boolean }).isError, true, 'a forbidden target is a tool error');
  assert.ok(!existsSync(join(dir, 'work', 'episodes')), 'nothing is written on refusal');
});

test('mcp pinned: an allowed target writes to the shared vault with agent frontmatter', async () => {
  const { dir, registry } = makeWorkspace();
  const { active } = resolveActive(registry, dir, null, { project: 'work', agent: 'architect' });
  assert.ok(active);
  const ok = await handleWorkspaceToolsCall(registry, dir, active!, 'remember', { text: 'The api-gateway uses postgres.', target: 'project' }, 3, {});
  assert.ok(!(ok.result as { isError?: boolean }).isError, 'allowed target succeeds');
  const episodesDir = join(dir, 'work', 'episodes');
  assert.ok(existsSync(episodesDir), 'episode landed in the shared vault');
  const files = readdirSync(episodesDir, { recursive: true }) as string[];
  const ep = files.find((f) => f.endsWith('.md'))!;
  const text = readFileSync(join(episodesDir, ep), 'utf8');
  assert.ok(text.includes('by: agent'), 'by: agent');
  assert.ok(text.includes('agent: architect'), 'agent frontmatter records the author');
});

test('mcp request-selected: a call with no project/agent errors; an unknown name errors', () => {
  const { dir, registry } = makeWorkspace();
  const none = resolveActive(registry, dir, null, {});
  assert.ok(none.error, 'no project/agent is an error');
  const unknown = resolveActive(registry, dir, null, { project: 'nope' });
  assert.ok(unknown.error, 'an unknown name is an error');
  const ok = resolveActive(registry, dir, null, { project: 'work', agent: 'coder' });
  assert.ok(ok.active, 'a known name resolves');
});

test('mcp initialize: states the binding, lineage and write targets', () => {
  const { dir, registry } = makeWorkspace();
  const { active } = resolveActive(registry, dir, null, { project: 'work', agent: 'coder' });
  const res = workspaceInitResult(1, active!, { workspaceDir: dir, project: 'work', agent: 'coder', selectPerRequest: false });
  const info = (res.result as { serverInfo: { binding: { lineage: { id: string }[]; writeTargets: string[] } } }).serverInfo;
  assert.deepEqual(info.binding.lineage.map((l) => l.id), ['work.coder', 'work', 'global']);
  assert.deepEqual(info.binding.writeTargets, ['self']);
});

test('registry: loadWorkspace throws on an invalid registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-bad-'));
  writeFileSync(join(dir, 'circadia.workspace.json'), JSON.stringify({ workspace: 1, vaults: { '../x': {} } }));
  assert.throws(() => loadWorkspace(dir), /Invalid circadia\.workspace\.json/);
});

test('helpers: cellKey, layerOf and targetVaultId agree with the lattice', () => {
  const { registry } = makeWorkspace();
  assert.equal(cellKey({ project: 'work', agent: 'coder' }), 'work|coder');
  assert.equal(cellKey({ project: null, agent: null }), '*|*');
  assert.equal(layerOf({ project: 'work', agent: 'coder' }), 'agent');
  assert.equal(layerOf({ project: 'work', agent: null }), 'project');
  assert.equal(layerOf({ project: null, agent: 'coder' }), 'global-agent');
  assert.equal(layerOf({ project: null, agent: null }), 'global');
  assert.equal(targetVaultId(registry, { project: 'work', agent: 'coder' }, 'self'), 'work.coder');
  assert.equal(targetVaultId(registry, { project: 'work', agent: 'coder' }, 'project'), 'work');
  assert.equal(targetVaultId(registry, { project: 'work', agent: 'coder' }, 'global'), 'global');
  assert.equal(targetVaultId(registry, { project: 'work', agent: 'coder' }, 'global-agent'), null);
});

test('schema: episode agent must be a slug; origin must be a string', () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), 'circadia-ws-schema-')));
  const base = '---\ntype: episode\nstarted: 2026-10-01\nsource: chat\nby: agent\n';
  const bad = parseNote('episodes/x.md', `${base}agent: Bad Name\n---\n\nBody.\n`, 0, cfg);
  assert.ok(bad.problems.some((p) => p.code === 'note.bad-agent'), 'a non-slug agent is an error');
  const good = parseNote('episodes/x.md', `${base}agent: coder\norigin: work.coder:a^f1\n---\n\nBody.\n`, 0, cfg);
  assert.ok(!good.problems.some((p) => p.code === 'note.bad-agent'), 'a slug agent is accepted');
  assert.ok(!good.problems.some((p) => p.code === 'note.bad-origin'), 'a string origin is accepted');
});

test('cli: workspace init/add/list round-trips through the registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-cli-'));
  assert.equal(await main(['workspace', 'init', dir]), 0);
  assert.ok(existsSync(join(dir, 'circadia.workspace.json')), 'registry written');
  assert.ok(existsSync(join(dir, 'global', 'circadia.config.json')), 'global vault scaffolded');
  assert.equal(await main(['workspace', 'add', '--workspace', dir, '--project', 'work']), 0);
  assert.ok(existsSync(join(dir, 'work', 'circadia.config.json')), 'work vault scaffolded');
  const reg = JSON.parse(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8')) as WorkspaceRegistry;
  assert.deepEqual(reg.vaults.work, { project: 'work' });
  assert.equal(await main(['workspace', 'list', '--workspace', dir, '--json']), 0);
});

test('cli: --vault and --workspace are mutually exclusive', async () => {
  await assert.rejects(() => main(['recall', 'x', '--vault', '.', '--workspace', '.']), /mutually exclusive/);
});

test('cli: workspace add/adopt reject path-traversal ids and create nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-trav-'));
  assert.equal(await main(['workspace', 'init', dir]), 0);

  // add: --project '../evil' must be rejected before any join/init
  await assert.rejects(
    () => main(['workspace', 'add', '--workspace', dir, '--project', '../evil']),
    /must match/,
  );
  assert.ok(!existsSync(join(dir, '..', 'evil')), 'no vault created outside the workspace root');
  let reg = JSON.parse(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8')) as WorkspaceRegistry;
  assert.deepEqual(Object.keys(reg.vaults), ['global'], 'registry unchanged after a rejected add');

  // adopt: a traversal id must be rejected before any join/existsSync/registry write
  await assert.rejects(
    () => main(['workspace', 'adopt', '--workspace', dir, '../../etc']),
    /must match/,
  );
  reg = JSON.parse(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8')) as WorkspaceRegistry;
  assert.deepEqual(Object.keys(reg.vaults), ['global'], 'registry unchanged after a rejected adopt');

  // adopt must not use the positional id as the workspace root
  await assert.rejects(() => main(['workspace', 'adopt', 'myid']), /--workspace/);
});

test('federated recall: the bound cell config supplies the default topK', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-cfg-'));
  const registry: WorkspaceRegistry = { workspace: 1, vaults: { global: {}, work: { project: 'work' } } };
  writeFileSync(join(dir, 'circadia.workspace.json'), JSON.stringify(registry, null, 2) + '\n');
  // global: default config, three matching notes
  mkdirSync(join(dir, 'global', 'entities'), { recursive: true });
  writeFileSync(join(dir, 'global', 'circadia.config.json'), '{}\n');
  for (const n of ['g1', 'g2', 'g3']) {
    writeFileSync(join(dir, 'global', 'entities', `${n}.md`), `---\ntype: entity\nkind: concept\n---\n# ${n}\n\napi-gateway note ${n}.\n`);
  }
  buildIndex(join(dir, 'global'), loadConfig(join(dir, 'global')));
  // work: the bound cell, topK 1, one matching note
  mkdirSync(join(dir, 'work', 'entities'), { recursive: true });
  writeFileSync(join(dir, 'work', 'circadia.config.json'), JSON.stringify({ retrieval: { topK: 1 } }) + '\n');
  writeFileSync(join(dir, 'work', 'entities', 'w1.md'), '---\ntype: entity\nkind: concept\n---\n# w1\n\napi-gateway note w1.\n');
  buildIndex(join(dir, 'work'), loadConfig(join(dir, 'work')));

  const lineage = resolveLineage(registry, dir, { project: 'work', agent: null });
  assert.equal(lineage[0].id, 'work', 'the bound cell is the first lineage entry');

  const r = await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: false });
  assert.equal(r.hits.length, 1, 'the bound cell topK=1 caps the merged list');

  const r2 = await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: false, topK: 5 });
  assert.ok(r2.hits.length > 1, 'an explicit topK overrides the bound config');
});

test('federated recall: a configured provider computes and passes a query embedding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-emb-'));
  const mock = await startMockEmbeddings(() => [1, 0, 0, 0]);
  try {
    const registry: WorkspaceRegistry = { workspace: 1, vaults: { global: {}, work: { project: 'work' } } };
    writeFileSync(join(dir, 'circadia.workspace.json'), JSON.stringify(registry, null, 2) + '\n');
    makeVault(join(dir, 'global'), 'operator', 'The operator prefers tabs.');
    // bound vault with an http embeddings provider pointed at the mock
    mkdirSync(join(dir, 'work', 'entities'), { recursive: true });
    writeFileSync(
      join(dir, 'work', 'circadia.config.json'),
      JSON.stringify({ embeddings: { provider: 'http', endpoint: mock.url, model: 'test-model' } }) + '\n',
    );
    writeFileSync(join(dir, 'work', 'entities', 'alpha.md'), '---\ntype: entity\nkind: concept\n---\n# alpha\n\nThe collector aggregates soil readings.\n');
    const cfg = loadConfig(join(dir, 'work'));
    const dbPath = join(dir, 'work', '.circadia', 'index.sqlite');
    buildIndex(join(dir, 'work'), cfg, { dbPath });
    const client = new HttpEmbeddingsClient({ ...cfg.embeddings, endpoint: mock.url });
    await embedPassages(dbPath, cfg, client);
    const before = mock.requests.length;

    const lineage = resolveLineage(registry, dir, { project: 'work', agent: null });
    const r = await workspaceRecall(registry, lineage, 'soil readings', { logAccess: false });
    assert.ok(mock.requests.length > before, 'the query was embedded through the configured provider');
    assert.ok(
      r.byVault.work.seeds.some((s) => s.via.includes('vector')),
      'the query embedding reached recall as a vector seed',
    );
  } finally {
    await mock.close();
  }
});

test('federated recall: top-level modeUsed is the bound cell mode even when layers excludes it', async () => {
  const { dir, registry } = makeWorkspace();
  // Force distinct modes so the assertion can tell the bound cell from the narrowed first
  // entry: the bound cell (work.coder) is `typed`, the project vault (work) is `wikilink`.
  writeFileSync(join(dir, 'work.coder', 'circadia.config.json'), JSON.stringify({ graph: { query: { mode: 'typed' } } }) + '\n');
  writeFileSync(join(dir, 'work', 'circadia.config.json'), JSON.stringify({ graph: { query: { mode: 'wikilink' } } }) + '\n');
  const lineage = resolveLineage(registry, dir, { project: 'work', agent: 'coder' });

  const full = await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: false, topK: 10 });
  assert.equal(full.byVault['work.coder'].modeUsed, 'typed', 'the bound cell ran in typed mode');
  assert.equal(full.byVault['work'].modeUsed, 'wikilink', 'the project vault ran in wikilink mode');

  // `layers: ["project"]` excludes the bound cell from the hits, but the top-level
  // `modeUsed` must still report the bound cell's mode, not the narrowed first entry's.
  const narrowed = await workspaceRecall(registry, lineage, 'api-gateway', { logAccess: false, layers: ['project'] });
  assert.equal(narrowed.modeUsed, 'typed', 'modeUsed reports the bound cell, not the narrowed first entry');
  assert.ok(narrowed.hits.length > 0, 'the project layer still contributes hits');
  assert.ok(narrowed.hits.every((h) => h.layer === 'project'), 'layers still narrows the hits');
});

test('mcp workspace: relate runs in the layer named by `layer`', async () => {
  const { dir, registry } = makeWorkspace();
  // Both the agent cell and the project cell have both endpoints, so the default (first
  // lineage vault) and an explicit `layer` can be told apart.
  const addPair = (vault: string) => {
    mkdirSync(join(dir, vault, 'entities'), { recursive: true });
    writeFileSync(join(dir, vault, 'entities', 'alpha.md'), '---\ntype: entity\nkind: concept\n---\n# alpha\n\nSee [[beta]].\n');
    writeFileSync(join(dir, vault, 'entities', 'beta.md'), '---\ntype: entity\nkind: concept\n---\n# beta\n\nBody.\n');
    buildIndex(join(dir, vault), loadConfig(join(dir, vault)));
  };
  addPair('work.coder');
  addPair('work');

  const { active } = resolveActive(registry, dir, null, { project: 'work', agent: 'coder' });
  assert.ok(active);

  const first = await handleWorkspaceToolsCall(registry, dir, active!, 'relate', { a: 'alpha', b: 'beta' }, 1, {});
  assert.equal((first.result as { vault?: string }).vault, 'work.coder', 'default runs in the first lineage vault with both endpoints');

  const project = await handleWorkspaceToolsCall(registry, dir, active!, 'relate', { a: 'alpha', b: 'beta', layer: 'project' }, 2, {});
  assert.equal((project.result as { vault?: string }).vault, 'work', 'layer:project runs in the project vault');

  const bad = await handleWorkspaceToolsCall(registry, dir, active!, 'relate', { a: 'alpha', b: 'beta', layer: 'bogus' }, 3, {});
  assert.equal((bad.error as { code: number }).code, -32602, 'an unknown layer name is an invalid param');

  // `global-agent` is a valid layer name but this binding has no `coder` vault, so it is
  // absent from the lineage.
  const absent = await handleWorkspaceToolsCall(registry, dir, active!, 'relate', { a: 'alpha', b: 'beta', layer: 'global-agent' }, 4, {});
  assert.equal((absent.result as { isError?: boolean }).isError, true, 'a valid layer absent from the lineage is a tool error');
});

test('mcp workspace: unknown layers and unparseable as_of are protocol errors', async () => {
  const { dir, registry } = makeWorkspace();
  const { active } = resolveActive(registry, dir, null, { project: 'work', agent: 'coder' });
  assert.ok(active);

  const badLayers = await handleWorkspaceToolsCall(registry, dir, active!, 'recall', { query: 'api-gateway', layers: ['bogus'] }, 1, {});
  assert.equal((badLayers.error as { code: number }).code, -32602, 'an unknown layer is an invalid param');

  const badAsOf = await handleWorkspaceToolsCall(registry, dir, active!, 'recall', { query: 'api-gateway', as_of: 'not-a-date' }, 2, {});
  assert.equal((badAsOf.error as { code: number }).code, -32602, 'an unparseable as_of is an invalid param');

  const ok = await handleWorkspaceToolsCall(registry, dir, active!, 'recall', { query: 'api-gateway', layers: ['project'] }, 3, {});
  assert.ok(!(ok as { error?: unknown }).error, 'a valid layers array is accepted');
});

test('mcp tools/list: layers and relate layer are advertised only on a workspace server', async () => {
  const { dir } = makeWorkspace();
  const props = (res: { result?: unknown }, tool: string) =>
    (res.result as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools.find((t) => t.name === tool)!.inputSchema.properties;

  const single = await handleToolsList(dir, loadConfig(join(dir, 'work.coder')), 1);
  assert.ok(!('layers' in props(single, 'recall')), 'single-vault recall omits layers');
  assert.ok(!('layer' in props(single, 'relate')), 'single-vault relate omits layer');

  const ws = await handleToolsList(dir, loadConfig(join(dir, 'work.coder')), 2, ['self'], true);
  assert.ok('layers' in props(ws, 'recall'), 'workspace recall advertises layers');
  assert.ok('layer' in props(ws, 'relate'), 'workspace relate advertises layer');
});

test('cli: workspace add/adopt reject a duplicate cell before writing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-dup-'));
  assert.equal(await main(['workspace', 'init', dir]), 0);

  // Adopt an existing vault under a non-canonical id on the (work, *) cell.
  mkdirSync(join(dir, 'mywork', 'entities'), { recursive: true });
  writeFileSync(join(dir, 'mywork', 'circadia.config.json'), '{}\n');
  assert.equal(await main(['workspace', 'adopt', '--workspace', dir, 'mywork', '--project', 'work']), 0);

  // `add --project work` derives the canonical id `work`, a different id on the same cell.
  await assert.rejects(
    () => main(['workspace', 'add', '--workspace', dir, '--project', 'work']),
    /already occupied/,
  );
  assert.ok(!existsSync(join(dir, 'work')), 'no vault is created for a rejected add');

  // Adopting another existing vault onto the same cell is rejected too.
  mkdirSync(join(dir, 'other', 'entities'), { recursive: true });
  writeFileSync(join(dir, 'other', 'circadia.config.json'), '{}\n');
  await assert.rejects(
    () => main(['workspace', 'adopt', '--workspace', dir, 'other', '--project', 'work']),
    /already occupied/,
  );

  const reg = JSON.parse(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8')) as WorkspaceRegistry;
  assert.deepEqual(Object.keys(reg.vaults).sort(), ['global', 'mywork'], 'registry unchanged after rejected writes');
});

test('cli: workspace init/add create a git repo per vault; as-of falls back with no commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'circadia-ws-git-'));
  assert.equal(await main(['workspace', 'init', dir]), 0);
  assert.ok(existsSync(join(dir, 'global', '.git')), 'the global vault is a git repo');
  assert.equal(await main(['workspace', 'add', '--workspace', dir, '--project', 'work']), 0);
  assert.ok(existsSync(join(dir, 'work', '.git')), 'an added vault is a git repo');

  // A vault with no commit <= T still falls back gracefully to current prose.
  mkdirSync(join(dir, 'work', 'entities'), { recursive: true });
  writeFileSync(join(dir, 'work', 'entities', 'alpha.md'), '---\ntype: entity\nkind: concept\n---\n# alpha\n\nThe collector aggregates soil readings.\n');
  buildIndex(join(dir, 'work'), loadConfig(join(dir, 'work')));
  const registry = JSON.parse(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8')) as WorkspaceRegistry;
  const lineage = resolveLineage(registry, dir, { project: 'work', agent: null });
  const r = await workspaceRecall(registry, lineage, 'soil readings', { logAccess: false, asOf: Date.parse('2026-01-01') });
  assert.ok(r.hits.length > 0, 'the note is recalled');
  assert.equal(r.asOfProse?.fromGit, false, 'no commit <= as-of falls back to current prose');
});

// --- RFC-0004 Stage 6: workspace-wide write commands -------------------------------

/** Run `main` with console.log/error captured, so a test can read the per-vault output. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map((x) => String(x)).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map((x) => String(x)).join(' ')); };
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** The vault ids a workspace-wide run visited, in the order it printed them. */
function visited(out: string[]): string[] {
  return out.filter((l) => l.includes('=== vault ')).map((l) => /=== vault (.+?) ===/.exec(l)![1]);
}

test('cli: index --workspace with no binding iterates every vault in id order', async () => {
  const { dir } = makeWorkspace();
  const { code, out } = await capture(() => main(['index', '--workspace', dir]));
  assert.equal(code, 0, 'all vaults indexed');
  assert.deepEqual(
    visited(out),
    ['global', 'work', 'work.architect', 'work.coder'],
    'vaults are processed in id order',
  );
  assert.ok(out.some((l) => l.includes('workspace summary: 4/4 vault(s) ok')), 'a per-vault summary is printed');
  for (const id of ['global', 'work', 'work.architect', 'work.coder']) {
    assert.ok(existsSync(join(dir, id, '.circadia', 'index.sqlite')), `${id} was indexed`);
  }
});

test('cli: a failing vault does not stop the rest; exit is non-zero with a summary', async () => {
  const { dir } = makeWorkspace();
  // Register a vault whose config is malformed, so loadConfig throws for it. It sorts
  // first, so the vaults after it prove the loop continued past the failure.
  mkdirSync(join(dir, 'broken'), { recursive: true });
  writeFileSync(join(dir, 'broken', 'circadia.config.json'), '{ not valid json');
  const reg = JSON.parse(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8')) as WorkspaceRegistry;
  reg.vaults.broken = { project: 'broken' };
  writeFileSync(join(dir, 'circadia.workspace.json'), JSON.stringify(reg, null, 2) + '\n');

  const { code, out, err } = await capture(() => main(['index', '--workspace', dir]));
  assert.equal(code, 1, 'a failed vault makes the command exit non-zero');
  assert.deepEqual(
    visited(out),
    ['broken', 'global', 'work', 'work.architect', 'work.coder'],
    'iteration continues past the failure',
  );
  assert.ok(out.some((l) => l.includes('workspace summary: 4/5 vault(s) ok')), 'the summary counts the failure');
  assert.ok(out.some((l) => l.includes('FAIL broken')), 'the failing vault is listed in the summary');
  assert.ok(err.some((l) => l.includes('vault broken')), 'the failure is reported to stderr');
});

test('cli: index --workspace with a binding acts on the bound cell only', async () => {
  const { dir } = makeWorkspace();
  // Remove the bound vault's index so a rebuild is observable.
  rmSync(join(dir, 'work', '.circadia', 'index.sqlite'), { force: true });
  const { code, out } = await capture(() => main(['index', '--workspace', dir, '--project', 'work']));
  assert.equal(code, 0);
  assert.ok(existsSync(join(dir, 'work', '.circadia', 'index.sqlite')), 'the bound cell was indexed');
  assert.deepEqual(visited(out), [], 'a bound run does not iterate the workspace');
});

test('cli: review and wake refuse the unbound workspace form', async () => {
  const { dir } = makeWorkspace();
  await assert.rejects(() => main(['review', '--workspace', dir]), /needs a binding/);
  await assert.rejects(() => main(['wake', '--workspace', dir]), /needs a binding/);
});
