// `palimpsest` CLI. Zero dependencies; hand-rolled argument parsing.

import { existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from '../config.ts';
import { buildIndex, parseVault, buildResolver } from '../index/indexer.ts';
import { recall, renderForContext } from '../retrieval/recall.ts';
import { parseInstant } from '../vault/time.ts';
import type { Problem, QueryMode } from '../types.ts';
import { getMeta, openIndex } from '../index/db.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const HELP = `palimpsest — markdown-vault memory with a derived graph index

usage: palimpsest <command> [options]

commands
  init <dir>            scaffold a new vault (folders, config, templates, _meta docs)
  index                 rebuild the derived index from the vault
  lint                  check the vault against docs/SCHEMA.md (exit 1 on errors)
  recall <query…>       retrieve passages for a cue
  stats                 show index statistics

options
  --vault <dir>         vault root (default: current directory)
  --mode <m>            recall mode: wikilink | typed | hipporag | auto
  --as-of <date>        recall as of YYYY[-MM[-DD]] or ISO datetime (bi-temporal)
  --top <n>             max hits (default from config)
  --budget <tokens>     token budget for returned passages
  --context             print hits rendered for an LLM context window
  --json                machine-readable output
  --no-log              don't append this recall to the access log
  --warnings            (lint/index) also print warnings
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
  const valued = new Set(['vault', 'mode', 'as-of', 'top', 'budget']);
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
  for (const d of ['episodes', 'entities/people', 'entities/projects', 'entities/concepts', 'schemas', 'procedures', '_meta/templates', '.palimpsest']) {
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
    '# derived — rebuild with `palimpsest index`\n.palimpsest/index.sqlite*\n# keep .palimpsest/access.jsonl and .palimpsest/triples/: they are not derivable\n',
  );
  const tdir = join(REPO, 'templates');
  for (const f of readdirSync(tdir)) copyFileSync(join(tdir, f), join(root, '_meta/templates', f));
  copyFileSync(join(REPO, 'docs', 'SCHEMA.md'), join(root, '_meta', 'SCHEMA.md'));
  writeFileSync(
    join(root, '_meta', 'README.md'),
    `# This vault\n\nManaged by Palimpsest, vault schema v1. See SCHEMA.md in this folder.\n\n- Write notes by hand or from templates/ (Obsidian: set the templates folder to _meta/templates).\n- Run \`palimpsest lint\` after bulk edits; \`palimpsest index\` to rebuild the graph index.\n- Never edit episodes after writing them; add a new episode instead.\n- Change a fact by striking it through and adding [superseded:: date] — never delete it.\n`,
  );
  console.log(`initialised vault at ${root}`);
}

function cmdStats(vault: string): void {
  const cfg = loadConfig(vault);
  const { db } = openIndex(join(vault, cfg.index.path));
  try {
    if (getMeta(db, 'schema_version') === null) throw new Error('no index — run `palimpsest index`');
    const q = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
    console.log('built_at:', new Date(Number(getMeta(db, 'built_at'))).toISOString(), ' keyword:', getMeta(db, 'fts'));
    console.table(q(`SELECT kind, count(*) AS n FROM nodes GROUP BY kind ORDER BY kind`));
    console.table(q(`SELECT extraction_mode AS extraction, count(*) AS notes FROM nodes WHERE kind='note' GROUP BY 1`));
    console.table(q(`SELECT origin, count(*) AS n, sum(expired_at IS NOT NULL) AS superseded FROM edges GROUP BY origin ORDER BY origin`));
  } finally {
    db.close();
  }
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (!args.cmd || args.flags.has('help')) {
    console.log(HELP);
    return args.cmd ? 0 : 1;
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
      const cfg = loadConfig(vault);
      const r = buildIndex(vault, cfg);
      if (json) console.log(JSON.stringify({ stats: r.stats, problems: r.problems }, null, 2));
      else {
        const s = r.stats;
        console.log(
          `indexed ${s.notes} notes, ${s.passages} passages in ${s.ms} ms (keyword: ${s.fts ? 'fts5' : 'bm25-js'})\n` +
            `extraction: ${Object.entries(s.byExtraction).map(([k, v]) => `${k}=${v}`).join(' ')}\n` +
            `edges: ${Object.entries(s.edges).map(([k, v]) => `${k}=${v}`).join(' ')}` +
            (s.placeholders ? `\nunresolved link targets: ${s.placeholders}` : '') +
            (s.phrases ? `\nphrase nodes: ${s.phrases}` : ''),
        );
        const errs = r.problems.filter((p) => p.severity === 'error');
        if (errs.length || warnings) printProblems(r.problems, warnings);
      }
      return 0;
    }
    case 'lint': {
      const cfg = loadConfig(vault);
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
    case 'recall': {
      const query = args.pos.join(' ').trim();
      if (!query) throw new Error('recall needs a query');
      const cfg = loadConfig(vault);
      const asOfRaw = str(args.flags, 'as-of');
      const asOf = asOfRaw ? parseInstant(asOfRaw) : null;
      if (asOfRaw && asOf === null) throw new Error(`cannot parse --as-of "${asOfRaw}"`);
      const mode = str(args.flags, 'mode') as QueryMode | undefined;
      const top = str(args.flags, 'top');
      const budget = str(args.flags, 'budget');
      const r = recall(vault, cfg, query, {
        mode,
        asOf,
        topK: top ? Number(top) : undefined,
        tokenBudget: budget ? Number(budget) : undefined,
        logAccess: !args.flags.has('no-log'),
      });
      if (json) console.log(JSON.stringify(r, null, 2));
      else if (args.flags.has('context')) console.log(renderForContext(r));
      else {
        console.log(`mode: ${r.modeRequested} → ${r.modeUsed}   keyword: ${r.keywordBackend}   seeds: ${r.seeds.length}`);
        for (const e of r.escalations) console.log(`  escalated ${e.from} → ${e.to}: ${e.reason}`);
        r.hits.forEach((h, i) => {
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
    case 'stats': {
      cmdStats(vault);
      return 0;
    }
    default:
      console.error(`unknown command "${args.cmd}"\n`);
      console.log(HELP);
      return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}

