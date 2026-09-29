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
  if (!(c.graph.damping > 0 && c.graph.damping < 1)) errs.push('graph.damping must be in (0, 1)');
  if (!['high', 'medium', 'low'].includes(c.retrieval.trustFloor)) {
    errs.push('retrieval.trustFloor must be high, medium, or low');
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
