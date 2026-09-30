// P0/C4: MCP `remember` must not let a caller claim to be the user.
//
// The C4 memory-poisoning defense assumes `by` is honest. On the MCP write path it was
// not: `remember` accepted `by: user` and `writeEpisodes` defaulted to `user`, so an
// agent that read a hostile page could mint a high-trust episode that skips the
// untrusted-source queue and can supersede existing facts. These tests pin the fix:
// `by: user` is refused, an omitted `by` becomes `agent`, and the resulting episode
// queues (never supersedes) at the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts';
import { handleToolsCall } from '../src/mcp/server.ts';
import { parseVault } from '../src/index/indexer.ts';
import { evaluateGate } from '../src/consolidation/schema.ts';
import type { Candidate } from '../src/consolidation/candidate.ts';
import type { Fact } from '../src/types.ts';

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), 'circadia-mcp-trust-'));
  writeFileSync(
    join(v, CONFIG_FILENAME),
    JSON.stringify({
      extraction: { provider: 'none' },
      predicates: { strict: false, defs: { runs_on: { object: 'entity', cardinality: 'single' } } },
    }),
  );
  mkdirSync(join(v, 'episodes'), { recursive: true });
  mkdirSync(join(v, 'entities', 'tools'), { recursive: true });
  writeFileSync(
    join(v, 'entities', 'tools', 'pi-cluster.md'),
    '---\ntype: entity\nkind: tool\n---\n# Pi cluster\n\n## Facts\n\n- runs_on [[old-laptop]]\n',
  );
  return v;
}

function episodeFiles(v: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(join(v, 'episodes'));
  return out;
}

test('MCP remember: by "user" is refused and writes nothing', async () => {
  const v = makeVault();
  const cfg = loadConfig(v);
  const res = await handleToolsCall(v, cfg, 'remember', {
    text: 'The pi cluster runs on the old laptop.',
    by: 'user',
  });
  assert.ok(res.error, 'by: user must be refused');
  assert.match(res.error!.message, /not allowed over MCP/);
  assert.equal(episodeFiles(v).length, 0, 'no episode may be written');
});

test('MCP remember: by defaults to agent, and the episode cannot supersede a fact', async () => {
  const v = makeVault();
  const cfg = loadConfig(v);
  const res = await handleToolsCall(v, cfg, 'remember', {
    text: 'The pi cluster runs on the old laptop.',
  });
  assert.ok(res.result, 'remember should succeed');

  const files = episodeFiles(v);
  assert.equal(files.length, 1);
  const raw = readFileSync(files[0], 'utf8');
  assert.match(raw, /^by: agent$/m, 'episode must be by: agent');

  // The written episode's `by` drives the gate. With by: agent, a contradiction on a
  // single-valued predicate queues — it never supersedes.
  const note = parseVault(v, cfg).find((n) => n.type === 'episode');
  assert.ok(note);
  const by = note!.frontmatter.by as Candidate['by'];
  assert.equal(by, 'agent');

  const candidate: Candidate = {
    subject: 'pi-cluster',
    predicate: 'runs_on',
    object: 'new-host',
    valid: true,
    explicit: true,
    origin: 'episode',
    episodeId: note!.id,
    confidence: 1,
    by,
    trust: 'medium',
  };
  const currentFact: Fact = {
    id: 'f-1',
    predicate: 'runs_on',
    object: { kind: 'link', link: { target: 'old-laptop' } },
    valid: { from: null, to: null },
    recordedAt: null,
    supersededAt: null,
    by: 'user',
    trust: 'high',
    conf: 1,
    src: null,
    status: 'current',
    comment: null,
    line: 0,
    raw: '',
  };
  const decision = evaluateGate(
    candidate,
    cfg,
    { id: 'pi-cluster', title: 'Pi cluster', path: 'entities/tools/pi-cluster.md' },
    { id: 'new-host', title: 'New host', path: 'entities/tools/new-host.md' },
    [currentFact],
  );
  assert.equal(decision.action, 'queue', 'an agent episode must queue, not supersede');
});
