// RFC-0004 §4: federated recall across a binding's lineage.
//
// `recall()` still takes one vault and is unchanged. This module runs it once per vault
// in the (possibly narrowed) lineage and merges the ranked lists with weighted reciprocal
// rank fusion. PageRank scores from different graphs are not comparable (each is
// normalized over its own graph), so the merge uses ranks — the same tool recall already
// uses to fuse seeds, one level up.
//
// One budget: `topK` and `tokenBudget` apply to the merged list, not per vault, so a
// four-layer lineage does not quadruple the context. There is no dedupe across vaults:
// `entities/api-gateway` in `work` and in `global` are two notes with two histories.

import { accessSync, constants } from 'node:fs';
import { loadConfig } from '../config.ts';
import { embedQuery } from '../retrieval/embeddings.ts';
import { recall, type RecallOptions } from '../retrieval/recall.ts';
import type { AsOfProse, GraphMode, QueryMode, RecallHit, RecallResult } from '../types.ts';
import { layerWeights, type Layer, type LineageEntry, type WorkspaceRegistry } from './registry.ts';

const RRF_K = 60;

/** Per-vault outcome, so a degraded layer is visible without failing the recall. */
export interface VaultRecallInfo {
  modeUsed: GraphMode | null;
  escalations: RecallResult['escalations'];
  seeds: RecallResult['seeds'];
  /** set when the vault could not be read; the layer is skipped, not fatal */
  error?: string;
}

export interface WorkspaceRecallResult {
  query: string;
  modeRequested: QueryMode;
  /** the bound cell's mode (the first lineage entry), per RFC-0004 §4 */
  modeUsed: GraphMode;
  asOf: number | null;
  hits: RecallHit[];
  byVault: Record<string, VaultRecallInfo>;
  keywordBackend: 'fts5' | 'bm25-js';
  asOfProse?: AsOfProse;
  expanded?: number;
}

export interface WorkspaceRecallOptions extends Omit<RecallOptions, 'dbPath' | 'graphCache' | 'readOnly'> {
  /** narrow the lineage to these layers; it can only narrow, never widen */
  layers?: Layer[];
  /** per-vault graph caches, keyed by vault id (long-running MCP server) */
  graphCaches?: Record<string, RecallOptions['graphCache']>;
}

/**
 * Is `dir` writable by this process? A read-only layer (a `:ro` mount, RFC-0004 §8) is
 * recalled with `logAccess: false` and its index opened immutable. Exported so the MCP
 * server opens the same layers read-only for its graph caches and read tools.
 */
export function isVaultWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run recall per vault and merge. A lineage vault that can't be read (missing directory,
 * unreadable, corrupt index) does not fail the recall: it is skipped, `byVault.<id>.error`
 * names the problem, and the caller can say that layer was unavailable.
 */
export async function workspaceRecall(
  reg: WorkspaceRegistry,
  lineage: LineageEntry[],
  query: string,
  opts: WorkspaceRecallOptions = {},
): Promise<WorkspaceRecallResult> {
  const weights = layerWeights(reg);
  const narrowed = opts.layers && opts.layers.length > 0 ? lineage.filter((e) => opts.layers!.includes(e.layer)) : lineage;
  // The bound cell is the first lineage entry (RFC-0004 §4). Its config supplies the
  // default budget when the caller does not pass one, so a workspace recall honors the
  // bound vault's retrieval settings instead of a hardcoded 8/2000.
  const boundEntry = lineage[0];
  // The bound cell is always recalled so the top-level `modeUsed` can report its mode even
  // when `layers` excludes it (RFC-0004 §4). Its hits are merged only when it is in the
  // narrowed set, so `layers` still narrows the result.
  const mergeIds = new Set(narrowed.map((e) => e.id));
  const recallSet = boundEntry && !mergeIds.has(boundEntry.id) ? [boundEntry, ...narrowed] : narrowed;
  const boundCfg = boundEntry ? loadConfig(boundEntry.path, reg.defaults) : undefined;
  const topK = opts.topK ?? boundCfg?.retrieval.topK ?? 8;
  const tokenBudget = opts.tokenBudget ?? boundCfg?.retrieval.tokenBudget ?? 2000;

  // Best-effort query embedding, mirroring single-vault recall: a down endpoint must not
  // fail the recall. Computed once from the bound cell's config and passed to every
  // per-vault recall so vector seeds work in workspace mode.
  let queryEmbedding = opts.queryEmbedding;
  if (!queryEmbedding && boundCfg) {
    try {
      queryEmbedding = await embedQuery(boundCfg.embeddings, query);
    } catch (e) {
      console.error(`warning: embedding failed, continuing text-only: ${(e as Error).message}`);
    }
  }

  const byVault: Record<string, VaultRecallInfo> = {};
  // merged key is `${vault}:${passageId}` — no dedupe across vaults
  const merged = new Map<string, { hit: RecallHit; score: number; own: number; layer: Layer; vault: string }>();
  let modeRequested: QueryMode = 'auto';
  let keywordBackend: 'fts5' | 'bm25-js' = 'bm25-js';
  let asOfProse: AsOfProse | undefined;
  let expanded: number | undefined;

  for (const entry of recallSet) {
    try {
      const cfg = loadConfig(entry.path, reg.defaults);
      const writable = isVaultWritable(entry.path);
      const inMerge = mergeIds.has(entry.id);
      const r = await recall(entry.path, cfg, query, {
        ...opts,
        queryEmbedding,
        // A read-only layer is recalled with logAccess off (RFC-0004 §4.6): its index is
        // kept current by a host-side job, and the process may not write its access log.
        // A bound cell recalled only for its mode (excluded by `layers`) is not logged
        // either, since none of its hits are returned.
        logAccess: writable && inMerge ? opts.logAccess : false,
        // A `:ro` mount cannot host SQLite's WAL sidecar, so open it immutable (RFC-0004
        // open question 6; verified in scripts/container-smoke.sh).
        readOnly: !writable,
        graphCache: opts.graphCaches?.[entry.id],
      });
      modeRequested = r.modeRequested;
      keywordBackend = r.keywordBackend;
      if (r.asOfProse) asOfProse = r.asOfProse;
      if (r.expanded !== undefined) expanded = (expanded ?? 0) + r.expanded;
      byVault[entry.id] = { modeUsed: r.modeUsed, escalations: r.escalations, seeds: r.seeds };
      if (!inMerge) continue;
      const w = weights[entry.layer];
      r.hits.forEach((h, rank) => {
        const key = `${entry.id}:${h.passageId}`;
        const contribution = w / (RRF_K + rank + 1);
        const prev = merged.get(key);
        const labeled: RecallHit = { ...h, vault: entry.id, layer: entry.layer };
        if (prev) {
          prev.score += contribution;
        } else {
          merged.set(key, { hit: labeled, score: contribution, own: h.score, layer: entry.layer, vault: entry.id });
        }
      });
    } catch (e) {
      byVault[entry.id] = { modeUsed: null, escalations: [], seeds: [], error: (e as Error).message };
    }
  }

  // Ties break by layer precedence, then by the vault's own score (RFC-0004 §4.2).
  const precedence = (l: Layer): number => ['agent', 'project', 'global-agent', 'global'].indexOf(l);
  const ordered = [...merged.values()].sort(
    (a, b) => b.score - a.score || precedence(a.layer) - precedence(b.layer) || b.own - a.own,
  );

  // One budget for the merged list.
  const hits: RecallHit[] = [];
  let budget = tokenBudget;
  for (const m of ordered) {
    if (hits.length >= topK) break;
    const cost = Math.ceil(m.hit.text.length / 4);
    if (hits.length > 0 && cost > budget) continue;
    hits.push(m.hit);
    budget -= cost;
  }

  // The bound cell is the first entry of the full lineage; its mode is the top-level mode,
  // even when `layers` narrowed the result away from it (RFC-0004 §4).
  const bound = lineage[0];
  const modeUsed = (bound && byVault[bound.id]?.modeUsed) || 'typed';

  return {
    query,
    modeRequested,
    modeUsed,
    asOf: opts.asOf ?? null,
    hits,
    byVault,
    keywordBackend,
    ...(asOfProse ? { asOfProse } : {}),
    ...(expanded !== undefined ? { expanded } : {}),
  };
}
