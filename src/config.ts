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
    batchSize: number;
  };
  extraction: {
    /** LLM used for hipporag triple extraction and (Phase 4) consolidation */
    provider: 'none' | 'http';
    endpoint: string;
    model: string;
    apiKeyEnv: string | null;
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
  },
  mcp: {
    logAccess: true,
  },
  embeddings: {
    provider: 'none',
    endpoint: 'http://127.0.0.1:8080/v1/embeddings',
    model: 'nomic-embed-text',
    apiKeyEnv: null,
    batchSize: 32,
  },
  extraction: {
    provider: 'none',
    endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    model: '',
    apiKeyEnv: null,
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
  return errs;
}

export function loadConfig(vaultRoot: string): Config {
  let file = join(vaultRoot, CONFIG_FILENAME);
  let cfg = DEFAULT_CONFIG;
  if (existsSync(file)) {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    cfg = deepMerge(DEFAULT_CONFIG, raw);
  }
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error(`Invalid ${CONFIG_FILENAME}:\n  - ${errs.join('\n  - ')}`);
  return cfg;
}
