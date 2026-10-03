// `circadia` CLI. Zero dependencies; hand-rolled argument parsing.

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, DEFAULT_CONFIG, STATE_DIR, deepMerge, loadConfig } from '../config.ts';
import { buildIndex, incrementalIndex, parseVault, buildResolver, embedPassages } from '../index/indexer.ts';
import { recall, renderForContext } from '../retrieval/recall.ts';
import { embedQuery } from '../retrieval/embeddings.ts';
import { relate } from '../retrieval/relate.ts';
import { timeline } from '../retrieval/timeline.ts';
import { parseInstant } from '../vault/time.ts';
import { resolveCommit, isGitRepo } from '../vault/git.ts';
import type { GraphMode, Layer, Problem, QueryMode, RecallHit } from '../types.ts';
import {
  VAULT_ID_RE,
  WORKSPACE_FILENAME,
  cellIndex,
  cellKey,
  layerOf,
  loadWorkspace,
  resolveBinding,
  resolveLineage,
  selfVaultId,
  validateRegistry,
  type Cell,
  type LineageEntry,
  type WorkspaceRegistry,
} from '../workspace/registry.ts';
import { workspaceRecall } from '../workspace/recall.ts';
import { lift } from '../workspace/lift.ts';
import type { EvalAggregate, EvalQuery, EvalReport } from '../eval/types.ts';
import type { BaselineDelta } from '../eval/baseline.ts';
import { getMeta, openIndex } from '../index/db.ts';
import { watchVault } from './watch.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const HELP = `circadia — markdown-vault memory with a derived graph index

usage: circadia <command> [options]

commands
  init <dir>            scaffold a new vault (folders, config, templates, _meta docs)
  index                 index the vault (incremental; --full for a full rebuild)
  watch                 watch the vault and reindex on change (Ctrl-C to stop)
  lint                  check the vault against docs/SCHEMA.md (exit 1 on errors)
  recall <query…>       retrieve passages for a cue
  relate <a> <b>        shortest paths between two notes (default mode: typed)
  timeline <entity>     every fact about an entity, ordered by world time
  extract               extract hipporag triples from episodes
  consolidate           replay episodes to consolidate facts into entity notes
  dream                 run the REM pass (--dry-run | --sample-only)
  wake                  read the night's dream log once and forget it (--json)
  review                interactive review of pending consolidation candidates
  stats                 show index statistics
  history <id>          show all versions of a note across commits
  access-log compact    compact access log into per-node summaries for ACT-R learning
  eval                  run the retrieval eval set (recall@k, MRR, ablations, tuning)
  workspace <sub>       init | add | adopt | list — manage a workspace of vaults
  lift                  move one fact from one vault to a shared layer (CLI-only)
options
  --vault <dir>         vault root (default: current directory)
  --workspace <dir>     workspace root (mutually exclusive with --vault)
                        index/consolidate/dream/lint with no --project/--agent run every vault
  --project <name>      (workspace) bind to a project axis
  --agent <name>        (workspace) bind to an agent axis
  --select-per-request  (mcp) resolve the cell from each tool call instead of pinning
  --from <id>           (lift) source vault id
  --to <id>             (lift) target vault id
  --layers <a,b>        (recall) narrow the lineage to these layers
  --full                (index) force a full rebuild instead of incremental
  --poll                (watch) poll for changes every 2 s instead of fs.watch
  --mode <m>            recall mode: wikilink | typed | hipporag | auto
                        (relate) graph mode: wikilink | typed | hipporag
                        (extract) extraction mode: hipporag
  --as-of <date|ref>    recall as of YYYY[-MM[-DD]] (ISO datetime), or git ref (e.g., HEAD~3)
  --scope <prefix|tag:name>  recall only within a path prefix or a tag (docs/RETRIEVAL.md §11)
  --stale-only          (extract) only extract triples from passages that have stale cache
  --note <id>           (extract) extract triples from a specific note
  --top <n>             max hits (default from config)
  --budget <tokens>     token budget for returned passages
  --context             print hits rendered for an LLM context window
  --json                machine-readable output
  --no-log              don't append this recall to the access log
  --warnings            (lint/index) also print warnings
  --dry-run             (consolidate) print changes without committing
                        (dream) build the log and candidates in memory; write nothing
  --sample-only         (dream) print the sampled pairs; make no model calls
  --dream               (consolidate) run the REM pass after the commit
  --no-commit           (consolidate) skip git commit even if it would normally run
  --fixture <dir>       (eval) fixture vault (default: eval/.fixture)
  --queries <path>      (eval) query set (default: eval/queries.jsonl)
  --baseline <path>     (eval) baseline to diff against (default: eval/baseline.json)
  --update-baseline     (eval) write the run to the baseline path
  --split <dev|holdout> (eval) run only one split
  --ablate              (eval) also run the edge-origin ablations
  --tune                (eval) grid-search thresholds on the dev split (report only)
  --dream-sweep         (eval) sweep graph.originWeights.dream (report only)
  --adapter <name>      (eval) read an external set: longmemeval | locomo
  --report <path>       (eval) write the full JSON report to a file
  --aggregate-only      (eval) omit per-query hits and query text from output
  --allow-missing       (eval) don't fail when a gold id is not in the index
  --check               (eval) exit non-zero on any baseline delta
  -h, --help            this help
`;

interface Args {
  cmd: string | null;
  pos: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  const valued = new Set(['vault', 'workspace', 'project', 'agent', 'from', 'to', 'layers', 'mode', 'as-of', 'top', 'budget', 'scope', 'queries', 'baseline', 'split', 'fixture', 'adapter', 'report']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') flags.set('help', true);
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags.set(key, a.slice(eq + 1));
      else if (valued.has(key)) flags.set(key, argv[++i] ?? '');
      else flags.set(key, true);
    } else pos.push(a);
  }
  return { cmd: pos.shift() ?? null, pos, flags };
}

function str(flags: Args['flags'], k: string): string | undefined {
  const v = flags.get(k);
  return typeof v === 'string' ? v : undefined;
}

/** Read a JSONL query set. Blank lines are skipped; a malformed line throws. */
function readQueriesFile(path: string): EvalQuery[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalQuery);
}

/**
 * Is `p` inside the repo, following symlinks? `resolve()` alone is not enough:
 * a symlinked parent (or a symlinked file) can point into the repo while the
 * literal path looks external. Realpath the file when it exists, else the
 * nearest existing ancestor plus the basename.
 */
function isInsideRepo(p: string): boolean {
  let realRepo: string;
  try {
    realRepo = realpathSync(REPO);
  } catch {
    realRepo = REPO;
  }
  let real: string;
  if (existsSync(p)) {
    try {
      real = realpathSync(p);
    } catch {
      real = resolve(p);
    }
  } else {
    let dir = dirname(p);
    while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
    try {
      real = join(realpathSync(dir), basename(p));
    } catch {
      real = resolve(p);
    }
  }
  return real === realRepo || real.startsWith(realRepo + sep);
}

/** Drop per-query hits and query text for aggregate-only output (Tier B). */
function stripReport(report: EvalReport): unknown {
  return {
    ...report,
    results: report.results.map((r) => {
      const copy: Record<string, unknown> = { ...r };
      delete copy.query;
      delete copy.hits;
      return copy;
    }),
  };
}

function printProblems(problems: Problem[], showWarnings: boolean): void {
  const shown = problems.filter((p) => p.severity === 'error' || showWarnings);
  for (const p of shown.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))) {
    const loc = p.line ? `${p.path}:${p.line}` : p.path;
    console.log(`${p.severity === 'error' ? 'ERROR' : 'warn '} ${loc}  [${p.code}] ${p.message}`);
  }
  const e = problems.filter((p) => p.severity === 'error').length;
  const w = problems.length - e;
  console.log(`\n${e} error(s), ${w} warning(s)${!showWarnings && w ? ' (use --warnings to show)' : ''}`);
}

function cmdInit(dir: string): void {
  const root = resolve(dir);
  if (existsSync(join(root, CONFIG_FILENAME))) throw new Error(`${root} already has ${CONFIG_FILENAME}`);
  for (const d of ['episodes', 'entities/people', 'entities/projects', 'entities/concepts', 'schemas', 'procedures', '_meta/templates', STATE_DIR]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  const cfg = {
    $schemaVersion: 1,
    graph: {
      defaultExtraction: DEFAULT_CONFIG.graph.defaultExtraction,
      scopes: [{ match: { tags: ['deep'] }, extract: 'hipporag' }],
      query: { mode: 'auto' },
    },
    predicates: {
      strict: false,
      defs: {
        related_to: { object: 'entity', description: 'generic association; prefer a specific predicate' },
        part_of: { object: 'entity', inverse: 'has_part' },
        depends_on: { object: 'entity', inverse: 'dependency_of' },
        status: { object: 'literal', values: ['active', 'paused', 'done', 'archived'] },
      },
    },
  };
  writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify(cfg, null, 2) + '\n');
  writeFileSync(
    join(root, '.gitignore'),
    `# derived — rebuild with \`circadia index\`\n${STATE_DIR}/index.sqlite*\n# keep ${STATE_DIR}/access.jsonl and ${STATE_DIR}/triples/: they are not derivable\n# dream state is disposable and never committed (ADR-0011)\n${STATE_DIR}/dreams/\n`,
  );
  const tdir = join(REPO, 'templates');
  for (const f of readdirSync(tdir)) copyFileSync(join(tdir, f), join(root, '_meta/templates', f));
  copyFileSync(join(REPO, 'docs', 'SCHEMA.md'), join(root, '_meta', 'SCHEMA.md'));
  writeFileSync(
    join(root, '_meta', 'README.md'),
    `# This vault\n\nManaged by Circadia, vault schema v1. See SCHEMA.md in this folder.\n\n- Write notes by hand or from templates/ (Obsidian: set the templates folder to _meta/templates).\n- Run \`circadia lint\` after bulk edits; \`circadia index\` to rebuild the graph index.\n- Never edit episodes after writing them; add a new episode instead.\n- Change a fact by striking it through and adding [superseded:: date] — never delete it.\n`,
  );
  console.log(`initialised vault at ${root}`);
}

interface WorkspaceContext {
  dir: string;
  registry: WorkspaceRegistry;
  binding: Cell;
  lineage: LineageEntry[];
}

/** Resolve a workspace binding and its lineage, or throw with the registry's problems. */
function workspaceContext(dir: string, project: string | null, agent: string | null): WorkspaceContext {
  const { registry } = loadWorkspace(dir);
  const { binding, problems } = resolveBinding(registry, project, agent);
  const errs = problems.filter((p) => p.severity === 'error');
  if (errs.length) throw new Error(errs.map((p) => p.message).join('; '));
  const lineage = resolveLineage(registry, dir, binding);
  if (lineage.length === 0) {
    throw new Error(`binding (${project ?? '*'}, ${agent ?? '*'}) has no vaults in its lineage`);
  }
  return { dir, registry, binding, lineage };
}

/**
 * RFC-0004 §8: a write command with `--workspace` and a binding acts on the bound cell
 * only, never the lineage. Resolve the binding and return its vault id.
 */
function boundVaultId(registry: WorkspaceRegistry, project: string | null, agent: string | null): string {
  const { binding, problems } = resolveBinding(registry, project, agent);
  const errs = problems.filter((p) => p.severity === 'error');
  if (errs.length) throw new Error(errs.map((p) => p.message).join('; '));
  const id = selfVaultId(registry, binding);
  if (id === null) throw new Error(`binding (${project ?? '*'}, ${agent ?? '*'}) has no vault`);
  return id;
}

/** A per-vault runner for a workspace-wide write command. */
type VaultRunner = (vaultPath: string, defaults?: Record<string, unknown>) => Promise<number> | number;

/**
 * RFC-0004 §8: with `--workspace` and no binding, `index`, `consolidate`, `dream` and
 * `lint` iterate every registered vault in id order. Each vault is processed with its own
 * index, lock and commit; a failure in one does not stop the rest. The command exits
 * non-zero if any vault failed and prints a per-vault summary.
 */
async function runWorkspaceWide(
  wsDir: string,
  registry: WorkspaceRegistry,
  run: VaultRunner,
): Promise<number> {
  const ids = Object.keys(registry.vaults).sort();
  const results: { id: string; code: number; error?: string }[] = [];
  for (const id of ids) {
    // T3: the id is a registry key; validate it before it is joined into a path.
    if (!VAULT_ID_RE.test(id)) {
      results.push({ id, code: 1, error: 'invalid vault id' });
      continue;
    }
    console.log(`\n=== vault ${id} ===`);
    try {
      const code = await run(join(wsDir, id), registry.defaults);
      results.push({ id, code });
    } catch (e) {
      const message = (e as Error).message;
      console.error(`error: vault ${id}: ${message}`);
      results.push({ id, code: 1, error: message });
    }
  }
  const failed = results.filter((r) => r.code !== 0);
  console.log(`\nworkspace summary: ${results.length - failed.length}/${results.length} vault(s) ok`);
  for (const r of results) {
    console.log(`  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.id}${r.error ? `  (${r.error})` : ''}`);
  }
  return failed.length > 0 ? 1 : 0;
}

/**
 * Dispatch a write command: `--vault` (or cwd) runs one vault; `--workspace` with a
 * binding runs the bound cell; `--workspace` with no binding iterates every vault.
 */
async function dispatchWrite(args: Args, vault: string, run: VaultRunner): Promise<number> {
  const wsDir = str(args.flags, 'workspace');
  if (!wsDir) return run(vault);
  const root = resolve(wsDir);
  const project = str(args.flags, 'project') ?? null;
  const agent = str(args.flags, 'agent') ?? null;
  const { registry } = loadWorkspace(root);
  if (project === null && agent === null) return runWorkspaceWide(root, registry, run);
  return run(join(root, boundVaultId(registry, project, agent)), registry.defaults);
}

/**
 * Resolve the single vault a per-vault command (`review`, `wake`) acts on. With
 * `--workspace` and no binding these commands refuse: they are interactive or read-once
 * and have no workspace-wide meaning (RFC-0004 §8).
 */
function requireBoundVault(args: Args, vault: string, cmd: string): { path: string; defaults?: Record<string, unknown> } {
  const wsDir = str(args.flags, 'workspace');
  if (!wsDir) return { path: vault };
  const root = resolve(wsDir);
  const project = str(args.flags, 'project') ?? null;
  const agent = str(args.flags, 'agent') ?? null;
  if (project === null && agent === null) {
    throw new Error(`${cmd} needs a binding: pass --project and/or --agent with --workspace (it is a per-vault command, not workspace-wide)`);
  }
  const { registry } = loadWorkspace(root);
  return { path: join(root, boundVaultId(registry, project, agent)), defaults: registry.defaults };
}

/** The vault id a `workspace add`/`adopt` would use for a coordinate. */
function idForCoords(project: string | null, agent: string | null): string {
  // RFC-0004 T3: a vault id is a flat directory name. Validate each axis before it is
  // joined into a path, so `--project '../evil'` can never escape the workspace root.
  if (project !== null && !VAULT_ID_RE.test(project)) {
    throw new Error(`--project "${project}" must match ${VAULT_ID_RE.source}`);
  }
  if (agent !== null && !VAULT_ID_RE.test(agent)) {
    throw new Error(`--agent "${agent}" must match ${VAULT_ID_RE.source}`);
  }
  if (project && agent) return `${project}.${agent}`;
  if (project) return project;
  if (agent) return agent;
  throw new Error('workspace add/adopt needs --project and/or --agent');
}

function writeRegistry(dir: string, registry: WorkspaceRegistry): void {
  writeFileSync(join(dir, WORKSPACE_FILENAME), JSON.stringify(registry, null, 2) + '\n');
}

/**
 * RFC-0004 §7: one git repo per vault, so `--as-of` prose works (`git show <hash>:<path>`
 * resolves from the repo root). `circadia init` does not run git init; the workspace
 * commands do, because the workspace's as-of guarantee depends on it.
 */
function gitInitVault(dir: string): void {
  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  } catch (e) {
    throw new Error(`git init failed in ${dir}: ${(e as Error).message}`);
  }
}

/**
 * Reject a coordinate whose cell is already occupied by a different vault id, matching
 * `validateRegistry`'s `workspace.duplicate-cell` rule before anything is written.
 */
function assertCellFree(registry: WorkspaceRegistry, id: string, project: string | null, agent: string | null): void {
  const key = cellKey({ project, agent });
  const existing = cellIndex(registry).get(key);
  if (existing !== undefined && existing !== id) {
    throw new Error(`cell (${project ?? '*'}, ${agent ?? '*'}) is already occupied by vault "${existing}"`);
  }
}

function cmdWorkspaceInit(dir: string): void {
  const root = resolve(dir);
  if (existsSync(join(root, WORKSPACE_FILENAME))) throw new Error(`${root} already has ${WORKSPACE_FILENAME}`);
  mkdirSync(root, { recursive: true });
  const registry: WorkspaceRegistry = { workspace: 1, vaults: { global: {} } };
  writeRegistry(root, registry);
  cmdInit(join(root, 'global'));
  gitInitVault(join(root, 'global'));
  console.log(`initialised workspace at ${root} with vault "global"`);
}

function cmdWorkspaceAdd(dir: string, project: string | null, agent: string | null): void {
  const root = resolve(dir);
  const { registry } = loadWorkspace(root);
  const id = idForCoords(project, agent);
  if (registry.vaults[id]) throw new Error(`vault "${id}" is already registered`);
  assertCellFree(registry, id, project, agent);
  cmdInit(join(root, id));
  gitInitVault(join(root, id));
  registry.vaults[id] = { ...(project ? { project } : {}), ...(agent ? { agent } : {}) };
  writeRegistry(root, registry);
  console.log(`added vault "${id}" (${project ?? '*'}, ${agent ?? '*'})`);
}

function cmdWorkspaceAdopt(dir: string, id: string, project: string | null, agent: string | null): void {
  // RFC-0004 T3: the positional id is a directory name. Reject anything that is not a
  // flat vault id before it reaches join()/existsSync()/the registry.
  if (!VAULT_ID_RE.test(id)) throw new Error(`vault id "${id}" must match ${VAULT_ID_RE.source}`);
  const root = resolve(dir);
  const { registry } = loadWorkspace(root);
  if (registry.vaults[id]) throw new Error(`vault "${id}" is already registered`);
  assertCellFree(registry, id, project, agent);
  if (!existsSync(join(root, id, CONFIG_FILENAME))) {
    throw new Error(`${join(root, id)} is not a vault (no ${CONFIG_FILENAME})`);
  }
  registry.vaults[id] = { ...(project ? { project } : {}), ...(agent ? { agent } : {}) };
  writeRegistry(root, registry);
  console.log(`adopted vault "${id}" (${project ?? '*'}, ${agent ?? '*'})`);
}

function cmdWorkspaceList(dir: string, json: boolean): number {
  const root = resolve(dir);
  const file = join(root, WORKSPACE_FILENAME);
  if (!existsSync(file)) throw new Error(`no ${WORKSPACE_FILENAME} in ${root}`);
  const registry = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceRegistry;
  const problems = validateRegistry(registry, root);
  const errors = problems.filter((p) => p.severity === 'error');
  if (json) {
    console.log(JSON.stringify({ registry, problems }, null, 2));
    return errors.length ? 1 : 0;
  }
  console.log(`workspace ${root}`);
  console.log('vaults:');
  for (const [id, coords] of Object.entries(registry.vaults)) {
    const layer = layerOf({ project: coords.project ?? null, agent: coords.agent ?? null });
    console.log(`  ${id.padEnd(20)} project=${coords.project ?? '*'} agent=${coords.agent ?? '*'}  (${layer})`);
  }
  console.log('write policy:');
  console.log(`  default: ${(registry.writes?.default ?? ['self']).join(', ')}`);
  for (const [name, targets] of Object.entries(registry.writes?.agents ?? {})) {
    console.log(`  ${name}: ${targets.join(', ')}`);
  }
  if (problems.length) {
    console.log('problems:');
    for (const p of problems) console.log(`  ${p.severity === 'error' ? 'ERROR' : 'warn '} [${p.code}] ${p.message}`);
  }
  return errors.length ? 1 : 0;
}

function cmdStats(vault: string): void {
  const cfg = loadConfig(vault);
  const { db } = openIndex(join(vault, cfg.index.path));
  try {
    if (getMeta(db, 'schema_version') === null) throw new Error('no index — run `circadia index`');
    const q = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    console.log('built_at:', new Date(Number(getMeta(db, 'built_at'))).toISOString(), ' keyword:', getMeta(db, 'fts'));
    console.table(q(`SELECT kind, count(*) AS n FROM nodes GROUP BY kind ORDER BY kind`));
    console.table(q(`SELECT extraction_mode AS extraction, count(*) AS notes FROM nodes WHERE kind='note' GROUP BY 1`));
    console.table(q(`SELECT origin, count(*) AS n, sum(expired_at IS NOT NULL) AS superseded FROM edges GROUP BY origin ORDER BY origin`));
  } finally {
    db.close();
  }
}

/** `index` for one vault. Extracted so a workspace-wide run can call it per vault. */
async function runIndex(
  vault: string,
  defaults: Record<string, unknown> | undefined,
  args: Args,
  json: boolean,
  warnings: boolean,
): Promise<number> {
  const cfg = loadConfig(vault, defaults);
  const r = args.flags.has('full') ? buildIndex(vault, cfg) : incrementalIndex(vault, cfg);
  // best-effort embeddings: a down server must not fail the index
  let embedded: number | null = null;
  if (cfg.embeddings.provider === 'http') {
    try {
      const res = await embedPassages(join(vault, cfg.index.path), cfg);
      embedded = res.embedded;
    } catch (e) {
      console.error(`warning: embedding failed, continuing text-only: ${(e as Error).message}`);
    }
  }
  // embedPassages emits synonym edges, so r.stats.edges is stale after it
  // runs. Re-read the counts so the summary reflects what is on disk.
  let edges = r.stats.edges;
  if (embedded !== null) {
    const { db } = openIndex(join(vault, cfg.index.path));
    try {
      const counts: Record<string, number> = {};
      for (const row of db.prepare(`SELECT origin, count(*) AS n FROM edges GROUP BY origin`).all() as { origin: string; n: number }[]) {
        counts[row.origin] = row.n;
      }
      edges = counts;
    } finally {
      db.close();
    }
  }
  if (json) console.log(JSON.stringify({ stats: { ...r.stats, edges }, problems: r.problems, embedded }, null, 2));
  else {
    const s = r.stats;
    console.log(
      `indexed ${s.notes} notes, ${s.passages} passages in ${s.ms} ms (keyword: ${s.fts ? 'fts5' : 'bm25-js'})` +
      (embedded !== null ? `, embedded ${embedded} node(s)` : '') + '\n' +
      `extraction: ${Object.entries(s.byExtraction).map(([k, v]) => `${k}=${v}`).join(' ')}\n` +
      `edges: ${Object.entries(edges).map(([k, v]) => `${k}=${v}`).join(' ')}` +
      (s.placeholders ? `\nunresolved link targets: ${s.placeholders}` : '') +
      (s.phrases ? `\nphrase nodes: ${s.phrases}` : ''),
    );
    const errs = r.problems.filter((p) => p.severity === 'error');
    if (errs.length || warnings) printProblems(r.problems, warnings);
  }
  return 0;
}

/** `lint` for one vault. Returns 1 when the vault has errors. */
function runLint(vault: string, defaults: Record<string, unknown> | undefined, json: boolean, warnings: boolean): number {
  const cfg = loadConfig(vault, defaults);
  const notes = parseVault(vault, cfg);
  const problems = [...notes.flatMap((n) => n.problems), ...buildResolver(notes).problems];
  // resolution + predicate checks live in the indexer; run it against a scratch db
  const r = buildIndex(vault, cfg, { dbPath: ':memory:' });
  const seen = new Set(problems.map((p) => `${p.path}:${p.line}:${p.code}:${p.message}`));
  for (const p of r.problems) if (!seen.has(`${p.path}:${p.line}:${p.code}:${p.message}`)) problems.push(p);
  if (json) console.log(JSON.stringify(problems, null, 2));
  else printProblems(problems, warnings);
  return problems.some((p) => p.severity === 'error') ? 1 : 0;
}

/** `consolidate` for one vault. */
async function runConsolidate(vault: string, defaults: Record<string, unknown> | undefined, args: Args): Promise<number> {
  const cfg = loadConfig(vault, defaults);
  const dryRun = args.flags.has('dry-run');
  const commit = !args.flags.has('no-commit');
  const { consolidate } = await import('../consolidation/consolidate.ts');
  const result = await consolidate(vault, cfg, { dryRun, commit, dream: args.flags.has('dream') });

  console.log(`consolidated: ${result.promoted} promoted, ${result.queued} queued, ${result.superseded} superseded`);
  console.log(`processed episodes: ${result.processedEpisodes.length}`);
  console.log(`pending queue: ${result.pendingPath}`);

  if (dryRun) {
    // C7: the diff is computed in-process from the change set; git is never invoked,
    // so a dry run cannot stage or alter the working tree.
    console.log('\n--- would-be changes (unified diff) ---');
    console.log(result.diff && result.diff.length > 0 ? result.diff : '(no changes)');
  }
  return 0;
}

/** `dream` for one vault. */
async function runDream(vault: string, defaults: Record<string, unknown> | undefined, args: Args, json: boolean): Promise<number> {
  const cfg = loadConfig(vault, defaults);
  const dryRun = args.flags.has('dry-run');
  const sampleOnly = args.flags.has('sample-only');
  const { runRem } = await import('../dreams/rem.ts');
  const result = await runRem(vault, cfg, { dryRun, sampleOnly });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.skipped) {
    console.log(`dream: skipped (${result.skipped})`);
    return 0;
  }
  if (sampleOnly) {
    console.log(`dream: sampled ${result.pairs.length} pair(s) (no model calls)`);
    for (const p of result.pairs) console.log(`  ${p.a} × ${p.b}`);
    return 0;
  }
  console.log(`dream: ${result.samples} sample(s), ${result.kept} kept, ${result.pruned} pruned`);
  if (Object.keys(result.errors).length > 0) {
    console.log(`errors: ${Object.entries(result.errors).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (result.samples > 0 && result.kept === 0 && result.pruned === result.samples) {
    console.log('every sample failed or was pruned; see the error classes above');
  }
  if (dryRun) {
    console.log('\n--- would-be log (dry run; nothing written) ---');
    console.log(JSON.stringify(result.log, null, 2));
    console.log('\n--- would-be candidates ---');
    console.log(result.candidates.length > 0 ? result.candidates.map((c) => JSON.stringify(c)).join('\n') : '(none)');
  } else {
    console.log(`log: ${STATE_DIR}/dreams/log/${result.night}.json`);
    console.log(`candidates appended: ${result.candidates.length}`);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.cmd || args.flags.has('help')) {
    console.log(HELP);
    return args.cmd ? 0 : 1;
  }
  if (args.flags.has('workspace') && args.flags.has('vault')) {
    throw new Error('--vault and --workspace are mutually exclusive');
  }
  const vault = resolve(str(args.flags, 'vault') ?? process.cwd());
  const json = args.flags.has('json');
  const warnings = args.flags.has('warnings');

  switch (args.cmd) {
    case 'init': {
      cmdInit(args.pos[0] ?? vault);
      return 0;
    }
    case 'index': {
      return dispatchWrite(args, vault, (v, d) => runIndex(v, d, args, json, warnings));
    }
    case 'watch': {
      const cfg = loadConfig(vault);
      console.log(`watching ${vault} (Ctrl-C to stop)`);
      const handle = watchVault(vault, cfg, { poll: args.flags.has('poll') });
      process.on('SIGINT', () => {
        console.log('\nwatch: stopping');
        handle.abort();
        process.exit(0);
      });
      return 0;
    }
    case 'lint': {
      return dispatchWrite(args, vault, (v, d) => runLint(v, d, json, warnings));
    }
    case 'recall': {
      const query = args.pos.join(' ').trim();
      if (!query) throw new Error('recall needs a query');
      const wsDir = str(args.flags, 'workspace');
      if (wsDir) {
        const ctx = workspaceContext(resolve(wsDir), str(args.flags, 'project') ?? null, str(args.flags, 'agent') ?? null);
        const layersRaw = str(args.flags, 'layers');
        let layers: Layer[] | undefined;
        if (layersRaw) {
          layers = layersRaw.split(',').map((s) => s.trim()).filter(Boolean) as Layer[];
          for (const l of layers) {
            if (!['agent', 'project', 'global-agent', 'global'].includes(l)) {
              throw new Error(`--layers must be agent, project, global-agent, or global (got "${l}")`);
            }
          }
        }
        const asOfRaw = str(args.flags, 'as-of');
        let asOf: number | null = null;
        if (asOfRaw) {
          asOf = parseInstant(asOfRaw);
          if (asOf === null) throw new Error(`cannot parse --as-of "${asOfRaw}"`);
        }
        const top = str(args.flags, 'top');
        const budget = str(args.flags, 'budget');
        const r = await workspaceRecall(ctx.registry, ctx.lineage, query, {
          mode: str(args.flags, 'mode') as QueryMode | undefined,
          asOf,
          topK: top ? Number(top) : undefined,
          tokenBudget: budget ? Number(budget) : undefined,
          logAccess: !args.flags.has('no-log'),
          scope: str(args.flags, 'scope'),
          layers,
        });
        if (json) console.log(JSON.stringify(r, null, 2));
        else if (args.flags.has('context')) console.log(renderForContext(r as unknown as Parameters<typeof renderForContext>[0]));
        else {
          console.log(`mode: ${r.modeRequested} → ${r.modeUsed}   keyword: ${r.keywordBackend}   vaults: ${Object.keys(r.byVault).length}`);
          for (const [id, info] of Object.entries(r.byVault)) {
            if (info.error) console.log(`  ${id}: unavailable (${info.error})`);
            else console.log(`  ${id}: ${info.modeUsed}  seeds ${info.seeds.length}`);
          }
          r.hits.forEach((h: RecallHit, i: number) => {
            const c = h.components;
            console.log(
              `\n${i + 1}. ${h.title}${h.heading && h.heading !== h.title ? ' › ' + h.heading : ''}  [${h.layer}: ${h.vault}]  [${h.path}]  trust=${h.trust}\n` +
              `   score ${h.score.toFixed(3)} (graph ${c.graph.toFixed(2)} · activation ${c.activation.toFixed(2)} · importance ${c.importance.toFixed(2)})\n` +
              h.text.split('\n').slice(0, 4).map((l) => `   │ ${l}`).join('\n'),
            );
          });
          if (r.hits.length === 0) console.log('\n(no hits)');
        }
        return 0;
      }
      const cfg = loadConfig(vault);
      const asOfRaw = str(args.flags, 'as-of');
      let asOf: number | null = null;
      if (asOfRaw) {
        // First try parsing as a date/time
        asOf = parseInstant(asOfRaw);
        // If that fails and we have a git repo, try resolving as a git ref
        if (asOf === null && isGitRepo(vault)) {
          const commit = resolveCommit(vault, asOfRaw);
          if (commit) {
            asOf = commit.timestamp;
          }
        }
        if (asOf === null) throw new Error(`cannot parse --as-of "${asOfRaw}" (not a valid date or git ref)`);
      }
      const mode = str(args.flags, 'mode') as QueryMode | undefined;
      const top = str(args.flags, 'top');
      const budget = str(args.flags, 'budget');
      // best-effort query embedding: a down server must not fail the recall
      let queryEmbedding: Float32Array | undefined;
      try {
        queryEmbedding = await embedQuery(cfg.embeddings, query);
      } catch (e) {
        console.error(`warning: embedding failed, continuing text-only: ${(e as Error).message}`);
      }
      const r = await recall(vault, cfg, query, {
        mode,
        asOf,
        topK: top ? Number(top) : undefined,
        tokenBudget: budget ? Number(budget) : undefined,
        logAccess: !args.flags.has('no-log'),
        scope: str(args.flags, 'scope'),
        queryEmbedding,
      });
      if (json) console.log(JSON.stringify(r, null, 2));
      else if (args.flags.has('context')) console.log(renderForContext(r));
      else {
        console.log(`mode: ${r.modeRequested} → ${r.modeUsed}   keyword: ${r.keywordBackend}   seeds: ${r.seeds.length}`);
        // C17: say whether as-of prose came from git history or fell back to current text.
        if (r.asOfProse) console.log(`as-of prose: ${r.asOfProse.reason}`);
        for (const e of r.escalations) console.log(`  escalated ${e.from} → ${e.to}: ${e.reason}`);
        r.hits.forEach((h: RecallHit, i: number) => {
          const c = h.components;
          console.log(
            `\n${i + 1}. ${h.title}${h.heading && h.heading !== h.title ? ' › ' + h.heading : ''}  [${h.path}]  trust=${h.trust}\n` +
            `   score ${h.score.toFixed(3)} (graph ${c.graph.toFixed(2)} · activation ${c.activation.toFixed(2)} · importance ${c.importance.toFixed(2)})\n` +
            h.text
              .split('\n')
              .slice(0, 4)
              .map((l) => `   │ ${l}`)
              .join('\n'),
          );
        });
        if (r.hits.length === 0) console.log('\n(no hits)');
      }
      return 0;
    }
    case 'relate': {
      const a = args.pos[0];
      const b = args.pos[1];
      if (!a || !b) throw new Error('relate needs two note names');
      const cfg = loadConfig(vault);
      const modeRaw = str(args.flags, 'mode');
      if (modeRaw && !['wikilink', 'typed', 'hipporag'].includes(modeRaw)) {
        throw new Error(`--mode must be wikilink, typed, or hipporag (got "${modeRaw}")`);
      }
      const { db } = openIndex(join(vault, cfg.index.path));
      try {
        if (getMeta(db, 'schema_version') === null) throw new Error('no index — run `circadia index`');
        const r = relate(db, a, b, cfg, { mode: modeRaw as GraphMode | undefined });
        if (json) {
          console.log(JSON.stringify(r, null, 2));
        } else if (!r.found) {
          console.log(`no path from ${r.from} to ${r.to} within the depth limit`);
        } else {
          for (const p of r.paths) {
            console.log(p.nodes.join(' → '));
            for (const e of p.edges) {
              console.log(`   ${e.src} —[${e.origin}:${e.type}]→ ${e.dst}${e.provenance ? `  src: ${e.provenance}` : ''}${e.fact_id ? `  ^${e.fact_id}` : ''}`);
            }
          }
        }
        return 0;
      } finally {
        db.close();
      }
    }
    case 'timeline': {
      const entity = args.pos[0];
      if (!entity) throw new Error('timeline needs an entity name');
      const cfg = loadConfig(vault);
      const { db } = openIndex(join(vault, cfg.index.path));
      try {
        if (getMeta(db, 'schema_version') === null) throw new Error('no index — run `circadia index`');
        const rows = timeline(db, entity, cfg);
        if (json) {
          console.log(JSON.stringify(rows, null, 2));
        } else if (rows.length === 0) {
          console.log(`no facts about ${entity}`);
        } else {
          for (const t of rows) {
            const when = t.valid_from !== null ? new Date(t.valid_from).toISOString().slice(0, 10) : '…';
            const end = t.valid_to !== null ? `..${new Date(t.valid_to).toISOString().slice(0, 10)}` : '..';
            const mark = t.status === 'superseded' ? ' ~~' : t.status === 'historical' ? ' (ended)' : '';
            console.log(`${when} ${end}  ${t.predicate} ${t.object}${mark}  [${t.status}]`);
            console.log(`   in ${t.noteTitle ?? t.subject}${t.inverse ? ' (inverse)' : ''}${t.provenance ? `  src: ${t.provenance}` : ''}${t.fact_id ? `  ^${t.fact_id}` : ''}`);
          }
        }
        return 0;
      } finally {
        db.close();
      }
    }
    case 'extract': {
      const triplesModule = await import('../extract/triples.ts');
      const { parseVault } = await import('../index/indexer.ts');
      const { passageHash } = await import('../extract/triples.ts');
      const cfg = loadConfig(vault);
      const staleOnly = args.flags.has('stale-only');
      const noteId = str(args.flags, 'note');

      // Initialize extractor
      const extractor = cfg.extraction.provider === 'http'
        ? new triplesModule.HttpTripleExtractor(cfg.extraction.endpoint, cfg.extraction.model, cfg.extraction.apiKeyEnv)
        : new triplesModule.NoopExtractor();

      const notes = parseVault(vault, cfg);
      const allPassages: Array<{ noteId: string; passageId: string; text: string; title: string; heading: string | null }> = [];

      for (const note of notes) {
        if (noteId && note.id !== noteId) continue;

        for (const passage of note.passages) {
          if (passage.id.endsWith('#facts')) continue;
          allPassages.push({
            noteId: note.id,
            passageId: passage.id,
            text: passage.text,
            title: note.title,
            heading: passage.heading,
          });
        }
      }

      const extractedTotal = { count: 0, bytes: 0 };
      const skippedTotal = { count: 0 };

      for (const { noteId, passageId, text, title, heading } of allPassages) {
        const contentHash = passageHash(text);

        if (staleOnly && !triplesModule.isStale(vault, noteId, passageId, contentHash, extractor.model)) {
          skippedTotal.count++;
          continue;
        }

        try {
          const triples = await extractor.extract({ id: passageId, title, heading, text });

          if (triples.length > 0) {
            const cached = triples.map((t) => ({
              passageId,
              contentHash,
              subject: t.subject,
              predicate: t.predicate,
              object: t.object,
              conf: t.conf,
              model: extractor.model,
              extractedAt: new Date().toISOString(),
            }));

            // Load existing triples and remove outdated ones for this passage
            const { triples: existing } = triplesModule.loadTriples(vault);
            const filteredExisting = existing.filter((t) => t.passageId !== passageId);

            // Combine and write
            const allForNote = [...filteredExisting, ...cached];
            triplesModule.writeTriples(vault, noteId, allForNote);
            extractedTotal.count++;
            extractedTotal.bytes += JSON.stringify(cached).length;
          }
        } catch (e) {
          console.error(`error extracting from ${passageId}: ${(e as Error).message}`);
        }
      }

      if (json) {
        console.log(JSON.stringify({
          extracted: extractedTotal,
          skipped: skippedTotal,
        }, null, 2));
      } else {
        console.log(`extracted: ${extractedTotal.count} passage(s) → ${extractedTotal.bytes} bytes`);
        if (staleOnly) {
          console.log(`skipped: ${skippedTotal.count} passage(s) with fresh cache`);
        }
      }
      return 0;
    }
    case 'consolidate': {
      return dispatchWrite(args, vault, (v, d) => runConsolidate(v, d, args));
    }
    case 'dream': {
      return dispatchWrite(args, vault, (v, d) => runDream(v, d, args, json));
    }
    case 'wake': {
      // RFC-0004 §8: `wake` is read-once and per-vault; it refuses the unbound form.
      const { path: wakeVault, defaults } = requireBoundVault(args, vault, 'wake');
      const cfg = loadConfig(wakeVault, defaults);
      const { wake, renderWake, wakeJson } = await import('../dreams/wake.ts');
      const result = wake(wakeVault, cfg);
      if (json) console.log(JSON.stringify(wakeJson(result), null, 2));
      else console.log(renderWake(result));
      return 0;
    }
    case 'review': {
      // RFC-0004 §8: `review` is interactive and per-vault; it refuses the unbound form.
      const { path: reviewVault } = requireBoundVault(args, vault, 'review');
      const { review } = await import('./review.ts');
      const result = await review(reviewVault);
      console.log(`review complete: ${result.promoted} promoted, ${result.rejected} rejected, ${result.edited} edited`);
      if (result.dreamAccepted > 0 || result.dreamRejected > 0) {
        console.log(`dreams: ${result.dreamAccepted} accepted, ${result.dreamRejected} rejected`);
      }
      return 0;
    }
    case 'stats': {
      cmdStats(vault);
      return 0;
    }
    case 'history': {
      const id = args.pos[0];
      if (!id) throw new Error('history needs a note id or path');

      const cfg = loadConfig(vault);
      const { db } = openIndex(join(vault, cfg.index.path));
      try {
        if (getMeta(db, 'schema_version') === null) throw new Error('no index — run `circadia index`');

        // Find the note in the index
        const row = db.prepare('SELECT id, path FROM nodes WHERE kind = \'note\' AND (id = ? OR path = ?)').get(id, id) as { id: string; path: string } | undefined;
        if (!row) throw new Error(`note "${id}" not found`);

        // Get all commits for this note
        const { getNoteCommits } = await import('../vault/git.ts');
        const commits = getNoteCommits(vault, row.path);

        if (commits.length === 0) {
          console.log(`no commit history for ${row.path}`);
          return 0;
        }

        if (json) {
          console.log(JSON.stringify({ note: row.path, commits }, null, 2));
        } else {
          console.log(`history for ${row.path} (${commits.length} commits):`);
          for (const c of commits) {
            console.log(`  ${c.hash.slice(0, 7)} ${new Date(c.timestamp).toISOString()}  ${c.message}`);
          }
        }
        return 0;
      } finally {
        db.close();
      }
    }
    case 'access-log': {
      const subcmd = args.pos[0];
      if (subcmd === 'compact') {
        const cfg = loadConfig(vault);
        const accessFile = join(vault, cfg.index.accessLog);
        const { compactAccessLog, writeAccessSummaries } = await import('../retrieval/log-compact.ts');
        const { readAccessLogWithOffset } = await import('../retrieval/activation.ts');

        const { events, offset } = readAccessLogWithOffset(accessFile);
        const summaries = compactAccessLog(events, offset);
        const summaryFile = join(vault, cfg.index.path.replace(/\.sqlite$/, '-access-summaries.jsonl'));
        writeAccessSummaries(summaryFile, summaries);

        console.log(`compacted ${events.length} events into ${summaries.nodes.size} node summaries`);
        console.log(`watermark ${new Date(summaries.watermark).toISOString()}, offset ${summaries.offset} bytes (raw log retained; see ADR-0009)`);
        console.log(`summaries written to ${summaryFile}`);
        return 0;
      } else {
        console.error('unknown access-log command; supported: compact');
        return 1;
      }
    }
    case 'mcp': {
      const mcpModule = await import('../mcp/server.ts');
      // stdout is the JSON-RPC channel for the MCP transport; a banner there is a
      // malformed first message to the client. Log to stderr instead.
      const wsDir = str(args.flags, 'workspace');
      if (wsDir) {
        const selectPerRequest = args.flags.has('select-per-request');
        console.error(`starting MCP workspace server at ${resolve(wsDir)}${selectPerRequest ? ' (request-selected)' : ''}`);
        await mcpModule.runWorkspaceServer({
          workspaceDir: resolve(wsDir),
          project: str(args.flags, 'project') ?? null,
          agent: str(args.flags, 'agent') ?? null,
          selectPerRequest,
        });
        return 0;
      }
      console.error(`starting MCP server for vault at ${vault}`);
      await mcpModule.runServer(vault);
      return 0;
    }
    case 'eval': {
      const { runEval, buildReport } = await import('../eval/run.ts');
      const { readBaseline, diffBaseline, toBaseline } = await import('../eval/baseline.ts');
      const { aggregate } = await import('../eval/metrics.ts');
      const { buildAblations } = await import('../eval/ablate.ts');
      const { tuneThresholds } = await import('../eval/tune.ts');

      const FIXTURE_DIR = join(REPO, 'eval', '.fixture');
      const fixtureDir = str(args.flags, 'fixture') ?? (args.flags.has('vault') ? vault : FIXTURE_DIR);
      // Only the generated fixture has a default baseline. A personal vault must
      // name an explicit path outside the repo, so private note ids never land in
      // the tracked baseline (Tier B is aggregate-only and kept outside the repo).
      const isFixture = resolve(fixtureDir) === resolve(FIXTURE_DIR);
      const queriesPath = str(args.flags, 'queries') ?? join(REPO, 'eval', 'queries.jsonl');
      const splitRaw = str(args.flags, 'split');
      if (splitRaw && splitRaw !== 'dev' && splitRaw !== 'holdout') {
        throw new Error(`--split must be dev or holdout (got "${splitRaw}")`);
      }
      const split = splitRaw as 'dev' | 'holdout' | undefined;

      const explicitBaseline = str(args.flags, 'baseline');
      let baselinePath: string | null;
      if (explicitBaseline) {
        baselinePath = resolve(explicitBaseline);
        if (!isFixture && isInsideRepo(baselinePath)) {
          console.error(`error: --baseline must be outside the repo for a non-fixture target (got ${baselinePath})`);
          return 1;
        }
      } else if (isFixture) {
        baselinePath = join(REPO, 'eval', 'baseline.json');
      } else {
        baselinePath = null;
      }
      if (args.flags.has('update-baseline') && !baselinePath) {
        console.error('error: --update-baseline needs an explicit --baseline <path> when the target is not the generated fixture');
        return 1;
      }
      if (args.flags.has('check') && !baselinePath) {
        console.error('error: --check needs a baseline; pass --baseline <path> for a non-fixture target');
        return 1;
      }

      // Aggregate-only omits per-query hits and query text. It is the default for
      // a non-fixture target, so a personal vault's note ids never leave it.
      const aggregateOnly = args.flags.has('aggregate-only') || !isFixture;

      // Adapters are off by default; an external set is read only when named.
      const adapter = str(args.flags, 'adapter');
      let queries: EvalQuery[];
      let adapterSkipped = 0;
      if (adapter === 'longmemeval') {
        const { parseLongMemEval } = await import('../eval/adapters/longmemeval.ts');
        const parsed = parseLongMemEval(queriesPath);
        queries = parsed.queries;
        adapterSkipped = parsed.skippedAbs;
      } else if (adapter === 'locomo') {
        const { parseLoCoMo } = await import('../eval/adapters/locomo.ts');
        queries = parseLoCoMo(queriesPath);
      } else if (adapter) {
        throw new Error(`unknown --adapter "${adapter}" (longmemeval | locomo)`);
      } else {
        queries = readQueriesFile(queriesPath);
      }

      const cfg = loadConfig(fixtureDir);

      // Tuning is report-only: it returns a suggested config and never writes
      // DEFAULT_CONFIG or src/config.ts (ADR-0010).
      if (args.flags.has('tune')) {
        const tune = await tuneThresholds(fixtureDir, queries);
        if (json) console.log(JSON.stringify(tune, null, 2));
        else {
          console.log(`tuned on ${tune.devCount} dev query(ies); holdout read once after selection`);
          console.log(`baseline recall@5 ${tune.baseline.recallAt5.toFixed(3)}  mrr ${tune.baseline.mrr.toFixed(3)}`);
          console.log(`best     recall@5 ${tune.best.recallAt5.toFixed(3)}  mrr ${tune.best.mrr.toFixed(3)}`);
          console.log(
            `holdout  baseline recall@5 ${tune.holdout.baseline.recallAt5.toFixed(3)} mrr ${tune.holdout.baseline.mrr.toFixed(3)}` +
            `  best recall@5 ${tune.holdout.best.recallAt5.toFixed(3)} mrr ${tune.holdout.best.mrr.toFixed(3)}`,
          );
          console.log('suggested config (report only; defaults are never written):');
          console.log(JSON.stringify(tune.best.config, null, 2));
        }
        return 0;
      }

      // The dream sweep is report-only: it never changes the default
      // graph.originWeights.dream and never writes the baseline (RFC-0001 Stage 5).
      if (args.flags.has('dream-sweep')) {
        const { runDreamSweep } = await import('../eval/dreams.ts');
        const sweep = await runDreamSweep(fixtureDir, queries);
        if (json) {
          console.log(JSON.stringify(sweep, null, 2));
        } else {
          console.log(`dream sweep: report only; graph.originWeights.dream stays ${DEFAULT_CONFIG.graph.originWeights.dream}`);
          console.log(`weights: ${sweep.weights.join(', ')}   modes: ${sweep.modes.join(', ')}`);
          for (const cfgName of ['true+decoys', 'decoys-only'] as const) {
            console.log(`\n${cfgName}`);
            for (const cell of sweep.cells.filter((c) => c.config === cfgName)) {
              const c = cell.counts;
              const counts = `trust=${c.trust} absent=${c.absent} order=${c.order} vacuous=${c.vacuous} missing=${c.missing}`;
              if (cfgName === 'true+decoys') {
                console.log(
                  `  ${cell.mode.padEnd(9)} w=${String(cell.weight).padEnd(5)} remote@5 dev=${cell.remoteRecall5.dev.toFixed(3)} holdout=${cell.remoteRecall5.holdout.toFixed(3)}  ${counts}`,
                );
              } else {
                const kinds = Object.entries(cell.perKind)
                  .map(([k, v]) => `${k}=${v.dev === null ? '-' : v.dev.toFixed(3)}/${v.holdout === null ? '-' : v.holdout.toFixed(3)}`)
                  .join(' ');
                console.log(`  ${cell.mode.padEnd(9)} w=${String(cell.weight).padEnd(5)} ${kinds}  ${counts}`);
              }
            }
          }
          console.log('\ngate (report only):');
          for (const g of sweep.gate) {
            console.log(
              `  ${g.mode.padEnd(9)} w=${String(g.weight).padEnd(5)} remoteRises=${g.remoteRises} noKindRegression=${g.noKindRegression} trustZero=${g.trustZero} pass=${g.pass}`,
            );
          }
          console.log(`\nrecommendation: ${sweep.recommendation.turnOn ? 'turn on' : 'stay at weight 0'} — ${sweep.recommendation.reason}`);
        }
        return 0;
      }

      const tmpDir = mkdtempSync(join(tmpdir(), 'circadia-eval-cli-'));
      const dbPath = join(tmpDir, 'index.sqlite');
      try {
        const results = await runEval(fixtureDir, queries, { config: cfg, split, dbPath });
        const report = buildReport(fixtureDir, cfg, results);

        // Forced-mode aggregates, reusing the one index build.
        const modes: Record<string, EvalAggregate[]> = {};
        for (const mode of ['wikilink', 'typed', 'hipporag'] as const) {
          const modeCfg = deepMerge(cfg, { graph: { query: { mode } } });
          const rs = await runEval(fixtureDir, queries, { config: modeCfg, split, dbPath, reuseIndex: true });
          modes[mode] = [...aggregate(rs, 'kind'), ...aggregate(rs, 'kind-split')];
        }

        let ablations: { name: string; aggregates: EvalAggregate[] }[] | undefined;
        if (args.flags.has('ablate')) {
          ablations = [];
          for (const spec of buildAblations(cfg)) {
            const rs = await runEval(fixtureDir, queries, { config: spec.config, split, dbPath, reuseIndex: true });
            ablations.push({ name: spec.name, aggregates: aggregate(rs, 'kind') });
          }
        }

        const outReport = aggregateOnly ? stripReport(report) : report;
        const baseline = toBaseline(report, modes);
        if (aggregateOnly) baseline.queries = [];

        let deltas: BaselineDelta[] | undefined;
        if (baselinePath && existsSync(baselinePath)) deltas = diffBaseline(readBaseline(baselinePath), baseline);

        if (args.flags.has('update-baseline') && baselinePath) {
          mkdirSync(dirname(baselinePath), { recursive: true });
          writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
        }

        const reportPath = str(args.flags, 'report');
        if (reportPath) {
          writeFileSync(reportPath, JSON.stringify({ report: outReport, modes, ablations, deltas }, null, 2) + '\n');
        }

        if (json) {
          console.log(
            JSON.stringify(
              {
                report: outReport,
                modes,
                ablations,
                deltas,
                baselinePath,
                aggregateOnly,
                adapterSkipped,
                missingIds: report.missingIds,
                updated: args.flags.has('update-baseline'),
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`eval: ${report.results.length} query(ies)${split ? ` (split: ${split})` : ''}  fixture: ${fixtureDir}`);
          if (aggregateOnly) console.log('aggregate-only: per-query hits and query text omitted');
          if (adapterSkipped > 0) console.log(`adapter: skipped ${adapterSkipped} abstention (_abs) question(s)`);
          console.log(
            `trust violations: ${report.trustViolations}  absent: ${report.absentViolations}  order: ${report.orderViolations}  vacuous: ${report.vacuousAbsences}  missing: ${report.missingIds.length}`,
          );
          if (report.missingIds.length > 0) console.log(`missing gold ids: ${report.missingIds.join(', ')}`);
          for (const a of report.aggregates.filter((x) => x.group.includes(':'))) {
            // RFC-0002: show the per-kind expansion share only when expansion ran,
            // so flag-off output is byte-identical to the pre-expansion report.
            const share = a.expansionShare === undefined ? '' : `  expand=${a.expansionShare.toFixed(3)}`;
            console.log(
              `  ${a.group.padEnd(28)} n=${String(a.count).padStart(3)}  recall@5=${(a.recallAtK['5'] ?? 0).toFixed(3)}  mrr=${a.mrr.toFixed(3)}${share}`,
            );
          }
          // RFC-0002 §Observability: a standalone per-kind line so the expansion
          // share sits next to recall for each kind, not only on the kind:split
          // lines above. Emitted only when expansion ran, so flag-off output is
          // unchanged. Kind groups are the aggregates whose group is a result
          // kind (mode/split/escalation groups never collide with a kind name).
          const kinds = new Set<string>(report.results.map((r) => r.kind));
          for (const a of report.aggregates) {
            if (!kinds.has(a.group) || a.expansionShare === undefined) continue;
            console.log(
              `  ${a.group.padEnd(28)} n=${String(a.count).padStart(3)}  recall@5=${(a.recallAtK['5'] ?? 0).toFixed(3)}  mrr=${a.mrr.toFixed(3)}  expand=${a.expansionShare.toFixed(3)}`,
            );
          }
          if (deltas) console.log(`baseline: ${deltas.length} delta(s) vs ${baselinePath}`);
          if (args.flags.has('update-baseline')) console.log(`baseline written to ${baselinePath}`);
        }

        // Hard gates: a trust violation, a missing gold id (unless allowed), or a
        // baseline delta under --check all exit non-zero.
        let code = 0;
        if (report.failed) code = 1;
        if (report.missingIds.length > 0 && !args.flags.has('allow-missing')) code = 1;
        if (args.flags.has('check') && deltas && deltas.length > 0) code = 1;
        return code;
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    case 'workspace': {
      const sub = args.pos[0];
      const wsFlag = str(args.flags, 'workspace');
      const project = str(args.flags, 'project') ?? null;
      const agent = str(args.flags, 'agent') ?? null;
      switch (sub) {
        case 'init':
          cmdWorkspaceInit(wsFlag ?? args.pos[1] ?? process.cwd());
          return 0;
        case 'add':
          cmdWorkspaceAdd(wsFlag ?? args.pos[1] ?? process.cwd(), project, agent);
          return 0;
        case 'adopt': {
          const id = args.pos[1];
          if (!id) throw new Error('workspace adopt needs a vault id');
          // `adopt` takes the id positionally, so the positional fallback would use the
          // id as the workspace root. Require --workspace explicitly (RFC-0004 T3).
          if (!wsFlag) throw new Error('workspace adopt needs --workspace <dir>');
          cmdWorkspaceAdopt(wsFlag, id, project, agent);
          return 0;
        }
        case 'list':
          return cmdWorkspaceList(wsFlag ?? args.pos[1] ?? process.cwd(), json);
        default:
          console.error('workspace needs a subcommand: init | add | adopt | list');
          return 1;
      }
    }
    case 'lift': {
      const wsDir = str(args.flags, 'workspace');
      if (!wsDir) throw new Error('lift needs --workspace <dir>');
      const fromId = str(args.flags, 'from');
      const toId = str(args.flags, 'to');
      const ref = args.pos[0];
      if (!fromId || !toId || !ref) throw new Error('lift needs --from <id> --to <id> <note>^<fact>');
      const { registry } = loadWorkspace(resolve(wsDir));
      const r = await lift(registry, resolve(wsDir), fromId, toId, ref);
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.log(`lifted ${r.claim}\n  → ${r.targetVault}/${r.episodePath}  (origin: ${r.origin})`);
      return 0;
    }
    default:
      console.error(`unknown command "${args.cmd}"\n`);
      console.log(HELP);
      return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = 2;
    });
}
