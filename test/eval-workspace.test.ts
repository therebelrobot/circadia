// Workspace eval fixture and runner (RFC-0004 Stage 8). Generates into temp dirs
// only; never touches examples/vault/ or the tracked single-vault fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  generateWorkspaceFixture,
  WORKSPACE_VAULTS,
  WORKSPACE_SIBLING_TOKEN,
  WORKSPACE_BLOCKED_TOKEN,
} from '../eval/generate-fixture.ts';
import { loadWorkspace, resolveBinding, resolveLineage } from '../src/workspace/registry.ts';
import {
  buildWorkspaceIndexes,
  readWorkspaceQueries,
  runWorkspaceEval,
  sweepLayerWeights,
} from '../src/eval/workspace.ts';

const EVAL_DIR = resolve(import.meta.dirname, '..', 'eval');
const tmp = mkdtempSync(join(tmpdir(), 'circadia-eval-workspace-'));

/** Recursively hash every file's relative path + content. */
function treeHash(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) visit(abs);
      else if (ent.isFile()) {
        const rel = abs.slice(root.length + 1);
        out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'));
      }
    }
  };
  visit(root);
  return out;
}

test('workspace fixture generation is byte-identical across two runs', () => {
  const a = join(tmp, 'a');
  const b = join(tmp, 'b');
  generateWorkspaceFixture(a);
  generateWorkspaceFixture(b);
  const ha = treeHash(a);
  const hb = treeHash(b);
  assert.deepEqual([...ha.keys()].sort(), [...hb.keys()].sort(), 'same file set');
  for (const [rel, hash] of ha) assert.equal(hb.get(rel), hash, `content differs: ${rel}`);
});

test('workspace fixture has the expected vaults, registry and notes', () => {
  const dir = join(tmp, 'shape');
  generateWorkspaceFixture(dir);
  assert.ok(statSync(join(dir, 'circadia.workspace.json')).isFile(), 'registry exists');
  const reg = JSON.parse(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8')) as {
    vaults: Record<string, { project?: string; agent?: string }>;
  };
  for (const v of WORKSPACE_VAULTS) {
    assert.ok(statSync(join(dir, v.id)).isDirectory(), `vault ${v.id} exists`);
    assert.ok(statSync(join(dir, v.id, 'circadia.config.json')).isFile(), `${v.id} config exists`);
    assert.deepEqual(reg.vaults[v.id], {
      ...(v.project ? { project: v.project } : {}),
      ...(v.agent ? { agent: v.agent } : {}),
    });
  }
  // the sibling and blocked tokens are planted, so the negative cases are not vacuous
  const sibling = readFileSync(join(dir, 'work.architect', 'entities', 'concepts', 'architect-secret.md'), 'utf8');
  assert.match(sibling, new RegExp(WORKSPACE_SIBLING_TOKEN));
  const blocked = readFileSync(join(dir, 'work.coder', 'episodes', '2026', '09', '2026-09-10-blocked-clipping.md'), 'utf8');
  assert.match(blocked, new RegExp(WORKSPACE_BLOCKED_TOKEN));
  assert.match(blocked, /by: web/, 'the blocked note is low-trust');
});

test('workspace eval cases resolve to the right vault and layer', async () => {
  const dir = join(tmp, 'run');
  generateWorkspaceFixture(dir);
  buildWorkspaceIndexes(dir);
  const cases = readWorkspaceQueries(join(EVAL_DIR, 'workspace.queries.jsonl'));
  assert.ok(cases.length >= 8, `expected at least 8 workspace cases, found ${cases.length}`);
  const results = await runWorkspaceEval(dir, cases);
  for (const r of results) {
    assert.deepEqual(r.missing, [], `${r.id}: missing expected hits`);
    assert.deepEqual(r.mislabeled, [], `${r.id}: mislabeled hits`);
    assert.deepEqual(r.absentViolations, [], `${r.id}: absent violations`);
    assert.deepEqual(r.errors, {}, `${r.id}: layer errors`);
  }
});

test('the sibling vault is never in the coder lineage and never recalled', async () => {
  const dir = join(tmp, 'sibling');
  generateWorkspaceFixture(dir);
  buildWorkspaceIndexes(dir);
  const { registry } = loadWorkspace(dir);
  const { binding } = resolveBinding(registry, 'work', 'coder');
  const lineage = resolveLineage(registry, dir, binding);
  assert.deepEqual(
    lineage.map((e) => e.id),
    ['work.coder', 'work', 'coder', 'global'],
    'lineage is the coder row and column, in precedence order',
  );
  assert.ok(!lineage.some((e) => e.id === 'work.architect'), 'the sibling is not in the lineage');

  const cases = readWorkspaceQueries(join(EVAL_DIR, 'workspace.queries.jsonl'));
  const results = await runWorkspaceEval(dir, cases);
  const sibling = results.find((r) => r.id === 'q-ws-sibling-absent');
  assert.ok(sibling, 'the sibling case ran');
  assert.deepEqual(sibling.hits, [], 'no hit names the sibling vault');
  assert.deepEqual(sibling.absentViolations, [], 'the sibling token was not recalled');
});

test('a layer trust floor blocks its low-trust content', async () => {
  const dir = join(tmp, 'blocked');
  generateWorkspaceFixture(dir);
  buildWorkspaceIndexes(dir);
  const cases = readWorkspaceQueries(join(EVAL_DIR, 'workspace.queries.jsonl'));
  const results = await runWorkspaceEval(dir, cases);
  const blocked = results.find((r) => r.id === 'q-ws-blocked-trust');
  assert.ok(blocked, 'the blocked case ran');
  assert.deepEqual(blocked.hits, [], 'the low-trust clipping is filtered by the layer trust floor');
  assert.deepEqual(blocked.absentViolations, [], 'the blocked token was not recalled');
});

test('layerWeights sweep is report-only and deterministic', async () => {
  const dir = join(tmp, 'sweep');
  generateWorkspaceFixture(dir);
  buildWorkspaceIndexes(dir);
  const cases = readWorkspaceQueries(join(EVAL_DIR, 'workspace.queries.jsonl'));
  const registryBefore = readFileSync(join(dir, 'circadia.workspace.json'), 'utf8');
  const weightSets = [
    { agent: 1.0, project: 0.9, 'global-agent': 0.8, global: 0.7 },
    { agent: 0.5, project: 1.0, 'global-agent': 0.5, global: 0.5 },
  ];
  const a = await sweepLayerWeights(dir, cases, weightSets);
  const b = await sweepLayerWeights(dir, cases, weightSets);
  assert.equal(a.length, 2, 'one row per weight set');
  assert.deepEqual(a, b, 'the sweep is deterministic');
  for (const row of a) {
    assert.equal(row.total, cases.length);
    assert.ok(row.passed <= row.total);
  }
  assert.equal(readFileSync(join(dir, 'circadia.workspace.json'), 'utf8'), registryBefore, 'the registry is not written');
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
