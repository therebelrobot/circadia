// Configuration: defaults, loading, deep-merge, validation.
// Config lives in the vault root as `circadia.config.json` so a vault is self-describing.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphMode, QueryMode, EdgeOrigin, Trust } from './types.ts';

export interface ScopeRule {
  /** All present criteria must match (AND). Within a criterion, any value matches (OR). */
  match: {
    tags?: string[];
    /** vault-relative globs, e.g. "entities/research/**" */
    paths?: string[];
    /** entity `kind` values */
    kinds?: string[];
    types?: string[];
  };
  extract: GraphMode;
}

export interface PredicateDef {
  object?: 'entity' | 'literal' | 'any';
  inverse?: string;
  values?: string[];
  description?: string;
  /**
   * How many objects a subject may hold for this predicate. `many` (default) means
   * multiple objects coexist and a new one is simply added — the safe choice, since it
   * only accumulates facts. `single` means a second, different object is a contradiction
   * the consolidation gate must resolve (queue, or supersede for a `by: user` episode).
   * Set `single` only where replacement makes sense, e.g. `runs_on`, `status`.
   */
  cardinality?: 'single' | 'many';
}

/**
 * OpenRouter-style provider routing preferences, sent as the request's `provider` object
 * (#13). Opt-in, so an endpoint that does not understand `provider` (a local llama-server)
 * is unaffected. The operator who blocks Zero Data Retention violations sets
 * `zdr: true` here.
 */
export interface LlmRouting {
  /** restrict routing to Zero Data Retention endpoints */
  zdr?: boolean;
  /** `deny` excludes providers that may store or train on the data */
  dataCollection?: 'allow' | 'deny';
}

/**
 * An optional override of the LLM the dream (REM) pass uses (#13). Every field falls back
 * to the matching `extraction.*` value, so leaving it unset runs dreaming on the extraction
 * model — the behavior before this key existed.
 */
export interface DreamLlm {
  provider?: 'none' | 'http';
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string | null;
  apiKeyFileEnv?: string | null;
}

export interface Config {
  vault: {
    factsHeading: string;
    historyHeading: string;
    /** vault-relative globs never indexed (in addition to _meta/ and dot-folders) */
    ignore: string[];
  };
  index: {
    /** vault-relative path of the derived SQLite index */
    path: string;
    accessLog: string;
  };
  graph: {
    /** extraction mode for notes no scope rule matches */
    defaultExtraction: GraphMode;
    /** first matching rule wins; a note's `graph:` frontmatter overrides all rules */
    scopes: ScopeRule[];
    /** Phase 5: hipporag-specific configuration */
    hipporag: {
      /** embedding cosine threshold for synonym edges between phrases (0–1) */
      synonymThreshold: number;
      /** max edges per phrase pair (deduplication window) */
      maxSynonymEdges: number;
      /** Recognition-memory seed filter: use LLM to verify triple relevance before seeding recall */
      recognitionMemory: {
        /** Enable recognition-memory filtering for hipporag mode */
        enabled: boolean;
        /** Embedding cosine threshold for query-triple matching (0–1) */
        embeddingThreshold: number;
        /** Minimum confidence from LLM verification (0–1) */
        minConfidence: number;
        /** How many candidate triples to score with LLM */
        topCandidates: number;
      };
    };
    query: {
      mode: QueryMode;
      auto: {
        /** modes tried in order; later modes only if the earlier result looks weak */
        ladder: GraphMode[];
        /** escalate when (top1 - top2) / top1 of final scores is below this */
        minTopMargin: number;
        /** escalate when fewer than this many seeds were found */
        minSeeds: number;
        /** escalate immediately past the first rung when the cue names >= this many entities */
        multiEntityThreshold: number;
      };
    };
    originWeights: Record<EdgeOrigin, number>;
    /** personalized PageRank restart probability complement (HippoRAG uses 0.5) */
    damping: number;
    maxIterations: number;
    tolerance: number;
  };
  retrieval: {
    topK: number;
    /** approx tokens (chars / 4) of passage text returned */
    tokenBudget: number;
    seedLimit: number;
    weights: { graph: number; activation: number; importance: number };
    /** ACT-R base-level decay d; 0.5 is the canonical default */
    actrDecay: number;
    /**
     * ACT-R retrieval threshold, expressed as "a memory seen once this many days ago".
     * Activation is mapped to retrieval probability P = 1 / (1 + e^(-(B - tau) / s)).
     */
    actrThresholdDays: number;
    /** ACT-R activation noise s in the retrieval-probability equation */
    actrNoise: number;
    /** exclude facts/edges below this trust */
    trustFloor: Trust;
    /** include superseded (expired) fact edges in traversal */
    includeSuperseded: boolean;
    /** log each returned hit to the access log (reconsolidation / base-level activation) */
    logAccess: boolean;
    /**
     * RFC-0002 entity-anchored fact expansion. Off by default during rollout; this key is
     * the feature flag (Circadia has no flag service). When on, recall inserts a cue
     * entity's `#facts` passage and up to `perHit` fact targets, capped at `maxInserted`
     * passages per query.
     */
    factExpansion: {
      enabled: boolean;
      /** fact targets inserted per cue entity */
      perHit: number;
      /** passages one query may insert in total */
      maxInserted: number;
    };
  };
  /**
   * Phase 8 dreaming (RFC-0001). A user who never sets any of these gets no dreaming at
   * all: `enabled` is false, so `consolidate --dream` skips the pass. The explicit
   * `circadia dream` command always runs (typing it is consent).
   */
  dreaming: {
    /** `consolidate --dream` runs the REM pass only when true */
    enabled: boolean;
    /** model calls per night */
    samplesPerNight: number;
    /** minimum graph distance between a pair, over non-dream origins */
    minHops: number;
    /** window (days) for the recent side */
    recentDays: number;
    /** share of partners that are uniformly random older notes */
    noiseShare: number;
    /**
     * Sampling floor: notes below this trust are never sampled. Distinct from
     * `retrieval.trustFloor`, the traversal floor.
     */
    trustFloor: Trust;
    /** fragments shown by `wake` */
    recallFragments: number;
    /** unread log lifetime in hours; 0 turns the TTL off */
    logTtlHours: number;
    /** candidate lifetime in nights */
    candidateTtlNights: number;
    /**
     * Optional LLM override for the REM pass (#13). Unset fields fall back to
     * `extraction.*`. `routing` is not overridden here; it mirrors `extraction.routing`.
     */
    llm?: DreamLlm;
  };
  mcp: {
    /**
     * Log MCP `recall` hits to the access log. Defaults to true: the log stores only the
     * query hash (never the query text), and without it agent use through MCP — the main
     * use case — never feeds ACT-R or the reconsolidation window. Set false to keep the
     * log clean for a vault whose MCP traffic should not count as memory use.
     */
    logAccess: boolean;
  };
  embeddings: {
    provider: 'none' | 'http';
    /** an OpenAI-compatible /v1/embeddings endpoint, e.g. llama.cpp's llama-server */
    endpoint: string;
    model: string;
    apiKeyEnv: string | null;
    /**
     * RFC-0003 §7: the name of an env var that holds a *path* to a file containing the key,
     * for Docker secrets. Additive; `apiKeyEnv` keeps working. The file is read at call time
     * and trimmed. Optional so a caller may omit it and fall back to `apiKeyEnv`.
     */
    apiKeyFileEnv?: string | null;
    batchSize: number;
  };
  extraction: {
    /** LLM used for hipporag triple extraction and (Phase 4) consolidation */
    provider: 'none' | 'http';
    endpoint: string;
    model: string;
    apiKeyEnv: string | null;
    /** RFC-0003 §7: env var naming a file that holds the key (Docker secrets). Optional. */
    apiKeyFileEnv?: string | null;
    /** Opt-in provider routing preferences, sent as the request's `provider` object (#13). */
    routing?: LlmRouting;
  };
  /**
   * `circadia serve` (RFC-0003): the long-lived HTTP MCP service. Every key here is inert
   * for the stdio server and the one-shot commands, so a user who never runs `serve` gets
   * exactly today's behavior. Tokens never live here: config validation rejects any
   * `serve.*token*` key, because this file is in the git-tracked vault (RFC-0003 §6).
   */
  serve: {
    /** interface to bind; default loopback. Set 0.0.0.0 to reach it from another LAN host. */
    bind: string;
    port: number;
    /** exact `Origin` values allowed; empty (the default) rejects every request that carries one */
    allowedOrigins: string[];
    /** request body cap, checked while streaming; default 1 MiB */
    maxBodyBytes: number;
    /** in-flight request cap; over it the server answers 503 (default 8) */
    maxInFlight: number;
    /** how long a mutating tool call waits for the write lock before a retryable error */
    lockWaitMs: number;
    /** reindex on vault file changes in the service; `remember` already reindexes */
    watch: boolean;
    schedule: {
      /** local time "HH:MM" for the nightly consolidate, or null to disable */
      consolidate: string | null;
      /** IANA zone for the schedule; null means TZ or UTC */
      timezone: string | null;
    };
  };
  predicates: {
    strict: boolean;
    defs: Record<string, PredicateDef>;
  };
}

export const STATE_DIR = '.circadia';
export const CONFIG_FILENAME = 'circadia.config.json';

export const DEFAULT_CONFIG: Config = {
  vault: {
    factsHeading: 'Facts',
    historyHeading: 'History',
    ignore: [],
  },
  index: {
    path: `${STATE_DIR}/index.sqlite`,
    accessLog: `${STATE_DIR}/access.jsonl`,
  },
  graph: {
    defaultExtraction: 'typed',
    scopes: [],
    hipporag: {
      synonymThreshold: 0.7,
      maxSynonymEdges: 3,
      recognitionMemory: {
        enabled: false,
        embeddingThreshold: 0.6,
        minConfidence: 0.7,
        topCandidates: 10,
      },
    },
    query: {
      mode: 'auto',
      auto: {
        ladder: ['wikilink', 'typed', 'hipporag'],
        minTopMargin: 0.05,
        minSeeds: 2,
        multiEntityThreshold: 2,
      },
    },
    originWeights: {
      contains: 1.0,
      link: 1.0,
      fact: 1.5,
      provenance: 0.5,
      triple: 1.0,
      synonym: 0.5,
      // RFC-0001: dream edges ship at weight 0. `addEdge` drops weight <= 0, so at the
      // default the edges are in the index and in no PageRank graph. Turning them on is
      // a separate, measured decision (Stage 5).
      dream: 0,
    },
    damping: 0.5,
    maxIterations: 100,
    tolerance: 1e-8,
  },
  retrieval: {
    topK: 8,
    tokenBudget: 2000,
    seedLimit: 20,
    weights: { graph: 1.0, activation: 0.3, importance: 0.2 },
    actrDecay: 0.5,
    actrThresholdDays: 30,
    actrNoise: 1.0,
    trustFloor: 'low',
    includeSuperseded: false,
    logAccess: true,
    factExpansion: {
      enabled: false,
      perHit: 1,
      maxInserted: 3,
    },
  },
  dreaming: {
    enabled: false,
    samplesPerNight: 20,
    minHops: 2,
    recentDays: 7,
    noiseShare: 0.25,
    trustFloor: 'medium',
    recallFragments: 3,
    logTtlHours: 12,
    candidateTtlNights: 14,
    // Empty: every field inherits `extraction.*`, so dreaming runs on the extraction model.
    llm: {},
  },
  mcp: {
    logAccess: true,
  },
  embeddings: {
    provider: 'none',
    endpoint: 'http://127.0.0.1:8080/v1/embeddings',
    model: 'nomic-embed-text',
    apiKeyEnv: null,
    apiKeyFileEnv: null,
    batchSize: 32,
  },
  extraction: {
    provider: 'none',
    endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    model: '',
    apiKeyEnv: null,
    apiKeyFileEnv: null,
    // Empty: no `provider` object is sent, so the request body is unchanged.
    routing: {},
  },
  serve: {
    bind: '127.0.0.1',
    port: 8711,
    allowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
    maxInFlight: 8,
    lockWaitMs: 10_000,
    watch: false,
    schedule: {
      consolidate: null,
      timezone: null,
    },
  },
  predicates: {
    strict: false,
    defs: {},
  },
};

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `over` onto `base`. Arrays and scalars replace; objects merge. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : over) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const MODES: readonly string[] = ['wikilink', 'typed', 'hipporag'];

export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  if (!MODES.includes(c.graph.defaultExtraction)) {
    errs.push(`graph.defaultExtraction must be one of ${MODES.join(', ')}`);
  }
  if (c.graph.hipporag.synonymThreshold < 0 || c.graph.hipporag.synonymThreshold > 1) {
    errs.push('graph.hipporag.synonymThreshold must be in [0, 1]');
  }
  if (c.graph.hipporag.maxSynonymEdges < 1) {
    errs.push('graph.hipporag.maxSynonymEdges must be at least 1');
  }
  if (![...MODES, 'auto'].includes(c.graph.query.mode)) {
    errs.push(`graph.query.mode must be one of ${MODES.join(', ')}, auto`);
  }
  for (const m of c.graph.query.auto.ladder) {
    if (!MODES.includes(m)) errs.push(`graph.query.auto.ladder contains unknown mode "${m}"`);
  }
  c.graph.scopes.forEach((s, i) => {
    if (!MODES.includes(s.extract)) errs.push(`graph.scopes[${i}].extract must be a graph mode`);
    if (!s.match || Object.keys(s.match).length === 0) {
      errs.push(`graph.scopes[${i}].match must have at least one criterion`);
    }
  });
  for (const [name, def] of Object.entries(c.predicates.defs)) {
    if (def.cardinality !== undefined && def.cardinality !== 'single' && def.cardinality !== 'many') {
      errs.push(`predicates.defs.${name}.cardinality must be "single" or "many"`);
    }
  }
  if (!(c.graph.damping > 0 && c.graph.damping < 1)) errs.push('graph.damping must be in (0, 1)');
  if (!['high', 'medium', 'low'].includes(c.retrieval.trustFloor)) {
    errs.push('retrieval.trustFloor must be high, medium, or low');
  }
  const fe = c.retrieval.factExpansion;
  if (!Number.isInteger(fe.perHit) || fe.perHit < 0) {
    errs.push('retrieval.factExpansion.perHit must be a non-negative integer');
  }
  if (!Number.isInteger(fe.maxInserted) || fe.maxInserted < 0) {
    errs.push('retrieval.factExpansion.maxInserted must be a non-negative integer');
  }
  const d = c.dreaming;
  if (!Number.isInteger(d.samplesPerNight) || d.samplesPerNight < 0) {
    errs.push('dreaming.samplesPerNight must be a non-negative integer');
  }
  if (!Number.isInteger(d.minHops) || d.minHops < 1) {
    errs.push('dreaming.minHops must be an integer >= 1');
  }
  if (!Number.isInteger(d.recentDays) || d.recentDays < 0) {
    errs.push('dreaming.recentDays must be a non-negative integer');
  }
  if (typeof d.noiseShare !== 'number' || d.noiseShare < 0 || d.noiseShare > 1) {
    errs.push('dreaming.noiseShare must be in [0, 1]');
  }
  if (!['high', 'medium', 'low'].includes(d.trustFloor)) {
    errs.push('dreaming.trustFloor must be high, medium, or low');
  }
  if (!Number.isInteger(d.recallFragments) || d.recallFragments < 0) {
    errs.push('dreaming.recallFragments must be a non-negative integer');
  }
  if (!Number.isInteger(d.logTtlHours) || d.logTtlHours < 0) {
    errs.push('dreaming.logTtlHours must be a non-negative integer');
  }
  if (!Number.isInteger(d.candidateTtlNights) || d.candidateTtlNights < 0) {
    errs.push('dreaming.candidateTtlNights must be a non-negative integer');
  }
  if (c.embeddings.provider === 'http' && !c.embeddings.endpoint) {
    errs.push('embeddings.endpoint is required when embeddings.provider is "http"');
  }
  // RFC-0003 §5/§6: serve.* is inert unless `serve` runs, so an invalid value is a
  // configuration mistake worth failing loudly on. Tokens are rejected outright: this
  // config file lives in the git-tracked vault, so a token here would be committed.
  const s = c.serve;
  if (typeof s.bind !== 'string' || s.bind.trim() === '') {
    errs.push('serve.bind must be a non-empty interface or address (e.g. "127.0.0.1" or "0.0.0.0")');
  }
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
    errs.push('serve.port must be an integer in [1, 65535]');
  }
  if (!Array.isArray(s.allowedOrigins) || s.allowedOrigins.some((o) => typeof o !== 'string')) {
    errs.push('serve.allowedOrigins must be an array of strings');
  } else if (s.allowedOrigins.includes('*')) {
    errs.push('serve.allowedOrigins must not contain "*": SECURITY.md T2 forbids allow_origins=* with credentials');
  }
  if (!Number.isInteger(s.maxBodyBytes) || s.maxBodyBytes < 1) {
    errs.push('serve.maxBodyBytes must be a positive integer');
  }
  if (!Number.isInteger(s.maxInFlight) || s.maxInFlight < 1) {
    errs.push('serve.maxInFlight must be an integer >= 1');
  }
  if (!Number.isInteger(s.lockWaitMs) || s.lockWaitMs < 0) {
    errs.push('serve.lockWaitMs must be a non-negative integer');
  }
  if (typeof s.watch !== 'boolean') {
    errs.push('serve.watch must be a boolean');
  }
  if (s.schedule.consolidate !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.schedule.consolidate))) {
    errs.push('serve.schedule.consolidate must be "HH:MM" in 24-hour local time, or null');
  }
  if (s.schedule.timezone !== null && !isValidTimeZone(String(s.schedule.timezone))) {
    errs.push(`serve.schedule.timezone "${s.schedule.timezone}" is not a valid IANA time zone name`);
  }
  for (const k of findTokenKeys(c)) {
    errs.push(`serve config must not contain a token key ("${k}"); use CIRCADIA_WRITE_TOKEN_FILE or CIRCADIA_READ_TOKEN_FILE`);
  }
  if (c.embeddings.apiKeyFileEnv != null && typeof c.embeddings.apiKeyFileEnv !== 'string') {
    errs.push('embeddings.apiKeyFileEnv must be a string or null');
  }
  if (c.extraction.apiKeyFileEnv != null && typeof c.extraction.apiKeyFileEnv !== 'string') {
    errs.push('extraction.apiKeyFileEnv must be a string or null');
  }
  const r = c.extraction.routing ?? {};
  if (r.zdr !== undefined && typeof r.zdr !== 'boolean') {
    errs.push('extraction.routing.zdr must be a boolean');
  }
  if (r.dataCollection !== undefined && r.dataCollection !== 'allow' && r.dataCollection !== 'deny') {
    errs.push('extraction.routing.dataCollection must be "allow" or "deny"');
  }
  const dl = c.dreaming.llm ?? {};
  if (dl.provider !== undefined && dl.provider !== 'none' && dl.provider !== 'http') {
    errs.push('dreaming.llm.provider must be "none" or "http"');
  }
  if (dl.endpoint !== undefined && typeof dl.endpoint !== 'string') {
    errs.push('dreaming.llm.endpoint must be a string');
  }
  if (dl.model !== undefined && typeof dl.model !== 'string') {
    errs.push('dreaming.llm.model must be a string');
  }
  if (dl.apiKeyEnv !== undefined && dl.apiKeyEnv !== null && typeof dl.apiKeyEnv !== 'string') {
    errs.push('dreaming.llm.apiKeyEnv must be a string or null');
  }
  if (dl.apiKeyFileEnv !== undefined && dl.apiKeyFileEnv !== null && typeof dl.apiKeyFileEnv !== 'string') {
    errs.push('dreaming.llm.apiKeyFileEnv must be a string or null');
  }
  return errs;
}

/** True when `tz` is a time zone `Intl` accepts (an IANA name). */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Any key whose name contains "token" under `serve`, at any depth. Used to reject a token
 * accidentally written into the vault config. Extra keys survive `deepMerge`, so this
 * inspects the runtime object, not just the typed shape.
 */
function findTokenKeys(c: Config): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (!isPlain(v)) return;
    for (const [k, val] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (/token/i.test(k)) out.push(p);
      walk(val, p);
    }
  };
  walk((c as unknown as Plain).serve, 'serve');
  return out;
}

/**
 * Load a vault's config. `workspaceDefaults` (RFC-0004 §2) is deep-merged *under* the
 * vault's own file, so the order is: built-in defaults, then workspace `defaults`, then
 * the vault file. This lets one model endpoint serve every vault in a workspace while
 * each vault can still override. `defaults.index.*` is rejected by the registry, not here.
 */
export function loadConfig(vaultRoot: string, workspaceDefaults?: Record<string, unknown>): Config {
  let file = join(vaultRoot, CONFIG_FILENAME);
  let cfg = workspaceDefaults ? deepMerge(DEFAULT_CONFIG, workspaceDefaults) : DEFAULT_CONFIG;
  if (existsSync(file)) {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    cfg = deepMerge(cfg, raw);
  }
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error(`Invalid ${CONFIG_FILENAME}:\n  - ${errs.join('\n  - ')}`);
  return cfg;
}
