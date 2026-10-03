// RFC-0004 workspaces: the registry, the cell lattice, lineage resolution and the
// write policy. A workspace is a folder of ordinary vaults plus `circadia.workspace.json`,
// which places each vault on two axes (project, agent). This module is pure: it reads the
// registry file and resolves coordinates to vault ids. It never opens a vault's index and
// never joins a caller-supplied string into a path (SECURITY.md T3).
//
// The vault is still the source of truth. A workspace adds no storage format for memory;
// it adds a registry, a binding, federated recall and explicit routes into shared layers.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Layer, Problem } from '../types.ts';

export type { Layer };

export const WORKSPACE_FILENAME = 'circadia.workspace.json';

/**
 * A vault id is a directory name and a registry key. It is flat (never nested) and
 * matches this pattern; a path is only ever `join(workspace, id)` after the id has been
 * found in the registry and passed this test (RFC-0004 §2, T3).
 */
export const VAULT_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$/;

/** Layers in precedence order (RFC-0004 §1). */
export const LAYER_ORDER: readonly Layer[] = ['agent', 'project', 'global-agent', 'global'];

/** What `remember` may target. `self` is the binding's own cell. */
export type WriteTarget = 'self' | 'project' | 'global-agent' | 'global';

export const WRITE_TARGETS: readonly WriteTarget[] = ['self', 'project', 'global-agent', 'global'];

/** A cell coordinate. `null` means the wildcard `*` on that axis. */
export interface Cell {
  project: string | null;
  agent: string | null;
}

export interface VaultCoords {
  project?: string;
  agent?: string;
}

export interface WorkspaceRegistry {
  workspace: number;
  vaults: Record<string, VaultCoords>;
  writes?: {
    default?: WriteTarget[];
    agents?: Record<string, WriteTarget[]>;
  };
  recall?: {
    layerWeights?: Partial<Record<Layer, number>>;
  };
  /** deep-merged *under* each vault's own circadia.config.json */
  defaults?: Record<string, unknown>;
}

/** A resolved lineage entry: a vault id and the layer it occupies for a binding. */
export interface LineageEntry {
  id: string;
  layer: Layer;
  /** absolute path to the vault directory */
  path: string;
}

export interface LoadedWorkspace {
  dir: string;
  registry: WorkspaceRegistry;
  problems: Problem[];
}

/** The default layer weights (RFC-0004 §2). */
export const DEFAULT_LAYER_WEIGHTS: Record<Layer, number> = {
  agent: 1.0,
  project: 0.9,
  'global-agent': 0.8,
  global: 0.7,
};

function problem(severity: Problem['severity'], code: string, message: string, path = WORKSPACE_FILENAME): Problem {
  return { severity, path, code, message };
}

/** The registry key for a cell: `project|agent`, with `*` for a wildcard axis. */
export function cellKey(c: Cell): string {
  return `${c.project ?? '*'}|${c.agent ?? '*'}`;
}

/** The layer a cell occupies, or null if the cell is not a valid layer coordinate. */
export function layerOf(c: Cell): Layer | null {
  if (c.project !== null && c.agent !== null) return 'agent';
  if (c.project !== null) return 'project';
  if (c.agent !== null) return 'global-agent';
  return 'global';
}

/** Build a cell → vault id map from the registry. Later duplicates are ignored. */
export function cellIndex(reg: WorkspaceRegistry): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, coords] of Object.entries(reg.vaults)) {
    const key = cellKey({ project: coords.project ?? null, agent: coords.agent ?? null });
    if (!out.has(key)) out.set(key, id);
  }
  return out;
}

/**
 * Validate a registry. Returns stable-coded problems. `dir` is used to check that a
 * registered id has a directory; a missing directory is a warning here (it becomes an
 * error when a binding needs that vault — see `resolveLineage`).
 */
export function validateRegistry(reg: WorkspaceRegistry, dir: string): Problem[] {
  const problems: Problem[] = [];
  if (reg.workspace !== 1) {
    problems.push(problem('error', 'workspace.bad-version', `workspace must be 1 (got ${String(reg.workspace)})`));
  }
  if (typeof reg.vaults !== 'object' || reg.vaults === null || Array.isArray(reg.vaults)) {
    problems.push(problem('error', 'workspace.bad-vaults', 'vaults must be an object of id → coordinates'));
    return problems;
  }
  const seenCells = new Map<string, string>();
  for (const [id, coords] of Object.entries(reg.vaults)) {
    if (!VAULT_ID_RE.test(id)) {
      problems.push(problem('error', 'workspace.bad-id', `vault id "${id}" must match ${VAULT_ID_RE.source}`));
    }
    if (typeof coords !== 'object' || coords === null || Array.isArray(coords)) {
      problems.push(problem('error', 'workspace.bad-coords', `vault "${id}" coordinates must be an object`));
      continue;
    }
    for (const axis of ['project', 'agent'] as const) {
      const v = coords[axis];
      if (v !== undefined && (typeof v !== 'string' || !VAULT_ID_RE.test(v))) {
        problems.push(problem('error', 'workspace.bad-coord', `vault "${id}" ${axis} "${String(v)}" must match ${VAULT_ID_RE.source}`));
      }
    }
    const key = cellKey({ project: coords.project ?? null, agent: coords.agent ?? null });
    const prev = seenCells.get(key);
    if (prev !== undefined) {
      problems.push(problem('error', 'workspace.duplicate-cell', `vaults "${prev}" and "${id}" occupy the same cell (${key})`));
    } else {
      seenCells.set(key, id);
    }
    // A registered id with no directory warns here; a binding that needs it errors.
    if (VAULT_ID_RE.test(id) && !existsSync(join(dir, id))) {
      problems.push(problem('warning', 'workspace.missing-dir', `vault "${id}" is registered but ${join(dir, id)} does not exist`));
    }
  }
  // defaults.index.* is rejected: index paths are per vault by definition (RFC-0004 §2).
  if (reg.defaults !== undefined) {
    if (typeof reg.defaults !== 'object' || reg.defaults === null || Array.isArray(reg.defaults)) {
      problems.push(problem('error', 'workspace.bad-defaults', 'defaults must be an object'));
    } else if ('index' in reg.defaults) {
      problems.push(problem('error', 'workspace.defaults-index', 'defaults.index is not allowed; index paths are per vault'));
    }
  }
  // writes: every target must be a known layer name.
  if (reg.writes !== undefined) {
    const check = (targets: unknown, where: string) => {
      if (!Array.isArray(targets)) {
        problems.push(problem('error', 'workspace.bad-writes', `${where} must be an array of write targets`));
        return;
      }
      for (const t of targets) {
        if (!WRITE_TARGETS.includes(t as WriteTarget)) {
          problems.push(problem('error', 'workspace.bad-write-target', `${where} has unknown target "${String(t)}"`));
        }
      }
    };
    if (reg.writes.default !== undefined) check(reg.writes.default, 'writes.default');
    if (reg.writes.agents !== undefined) {
      if (typeof reg.writes.agents !== 'object' || reg.writes.agents === null || Array.isArray(reg.writes.agents)) {
        problems.push(problem('error', 'workspace.bad-writes', 'writes.agents must be an object of agent → targets'));
      } else {
        for (const [name, targets] of Object.entries(reg.writes.agents)) check(targets, `writes.agents.${name}`);
      }
    }
  }
  // recall.layerWeights: numbers in [0, 1].
  if (reg.recall?.layerWeights !== undefined) {
    for (const [layer, w] of Object.entries(reg.recall.layerWeights)) {
      if (!LAYER_ORDER.includes(layer as Layer)) {
        problems.push(problem('error', 'workspace.bad-layer', `recall.layerWeights has unknown layer "${layer}"`));
      } else if (typeof w !== 'number' || w < 0 || w > 1) {
        problems.push(problem('error', 'workspace.bad-layer-weight', `recall.layerWeights.${layer} must be in [0, 1]`));
      }
    }
  }
  return problems;
}

/** Read and validate `circadia.workspace.json` from `dir`. Throws if the file is absent. */
export function loadWorkspace(dir: string): LoadedWorkspace {
  const file = join(dir, WORKSPACE_FILENAME);
  if (!existsSync(file)) throw new Error(`no ${WORKSPACE_FILENAME} in ${dir}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`invalid ${WORKSPACE_FILENAME}: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`invalid ${WORKSPACE_FILENAME}: must be a JSON object`);
  }
  const registry = raw as WorkspaceRegistry;
  const problems = validateRegistry(registry, dir);
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length) {
    throw new Error(`Invalid ${WORKSPACE_FILENAME}:\n  - ${errors.map((p) => p.message).join('\n  - ')}`);
  }
  return { dir, registry, problems };
}

/** The layer weights for a registry, with defaults filled in. */
export function layerWeights(reg: WorkspaceRegistry): Record<Layer, number> {
  return { ...DEFAULT_LAYER_WEIGHTS, ...(reg.recall?.layerWeights ?? {}) };
}

/**
 * The write targets allowed for an agent. `writes.agents.<name>` replaces `writes.default`
 * for that agent; the default is `["self"]`, so a user who never sets this gets complete
 * isolation and no agent ever writes shared memory (RFC-0004 §2).
 */
export function writeTargetsFor(reg: WorkspaceRegistry, agent: string | null): WriteTarget[] {
  if (agent !== null && reg.writes?.agents?.[agent] !== undefined) {
    return [...reg.writes.agents[agent]];
  }
  return [...(reg.writes?.default ?? ['self'])];
}

/**
 * Resolve the lineage of a binding, in precedence order, skipping absent cells.
 *
 *   (p, a) → agent (p,a), project (p,*), global-agent (*,a), global (*,*)
 *   (p, *) → project (p,*), global (*,*)
 *   (*, a) → global-agent (*,a), global (*,*)
 *   (*, *) → global (*,*)
 *
 * A cell with no vault is simply absent. A registered id whose directory is missing is
 * an error here (a binding needs it), unlike `validateRegistry`'s warning.
 */
export function resolveLineage(reg: WorkspaceRegistry, dir: string, binding: Cell): LineageEntry[] {
  const index = cellIndex(reg);
  const candidates: Cell[] = [];
  if (binding.project !== null && binding.agent !== null) {
    candidates.push({ project: binding.project, agent: binding.agent });
    candidates.push({ project: binding.project, agent: null });
    candidates.push({ project: null, agent: binding.agent });
    candidates.push({ project: null, agent: null });
  } else if (binding.project !== null) {
    candidates.push({ project: binding.project, agent: null });
    candidates.push({ project: null, agent: null });
  } else if (binding.agent !== null) {
    candidates.push({ project: null, agent: binding.agent });
    candidates.push({ project: null, agent: null });
  } else {
    candidates.push({ project: null, agent: null });
  }

  const out: LineageEntry[] = [];
  for (const c of candidates) {
    const id = index.get(cellKey(c));
    if (id === undefined) continue;
    const layer = layerOf(c);
    if (layer === null) continue;
    const path = join(dir, id);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`vault "${id}" (${layer}) is registered but ${path} is not a directory`);
    }
    out.push({ id, layer, path });
  }
  return out;
}

/**
 * Resolve a binding from `--project`/`--agent`. A name that is not registered is an
 * error that lists the registered names (RFC-0004 §3). `null` on an axis is the wildcard.
 */
export function resolveBinding(
  reg: WorkspaceRegistry,
  project: string | null,
  agent: string | null,
): { binding: Cell; problems: Problem[] } {
  const problems: Problem[] = [];
  const projects = new Set<string>();
  const agents = new Set<string>();
  for (const coords of Object.values(reg.vaults)) {
    if (coords.project) projects.add(coords.project);
    if (coords.agent) agents.add(coords.agent);
  }
  if (project !== null && !projects.has(project)) {
    problems.push(problem('error', 'workspace.unknown-project', `unknown project "${project}"; registered: ${[...projects].sort().join(', ') || '(none)'}`));
  }
  if (agent !== null && !agents.has(agent)) {
    problems.push(problem('error', 'workspace.unknown-agent', `unknown agent "${agent}"; registered: ${[...agents].sort().join(', ') || '(none)'}`));
  }
  return { binding: { project, agent }, problems };
}

/**
 * The vault id for a write target, or null when the target cell has no vault. `self` is
 * the binding's own cell; the others are the wildcard cells on the binding's axes.
 */
export function targetVaultId(reg: WorkspaceRegistry, binding: Cell, target: WriteTarget): string | null {
  const index = cellIndex(reg);
  let cell: Cell;
  switch (target) {
    case 'self':
      cell = binding;
      break;
    case 'project':
      cell = { project: binding.project, agent: null };
      break;
    case 'global-agent':
      cell = { project: null, agent: binding.agent };
      break;
    case 'global':
      cell = { project: null, agent: null };
      break;
  }
  return index.get(cellKey(cell)) ?? null;
}

/** The vault id for the binding's own cell, or null if it is absent. */
export function selfVaultId(reg: WorkspaceRegistry, binding: Cell): string | null {
  return cellIndex(reg).get(cellKey(binding)) ?? null;
}

/** A human-readable label for a layer, e.g. `project: work`. */
export function layerLabel(layer: Layer, id: string): string {
  return `${layer}: ${id}`;
}
