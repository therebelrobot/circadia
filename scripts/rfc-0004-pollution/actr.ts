// P3 rerun: does one agent's recall history move another agent's ranking? Episodes are
// aged 120 days so ACT-R base-level activation is not saturated (threshold is 30 days).
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const { loadConfig } = await import(join(REPO, 'src/config.ts'));
const { buildIndex } = await import(join(REPO, 'src/index/indexer.ts'));
const { recall } = await import(join(REPO, 'src/retrieval/recall.ts'));

const vault = mkdtempSync(join(tmpdir(), 'circadia-actr-'));
execFileSync(process.execPath, [join(REPO, 'bin/circadia.mjs'), 'init', vault], { stdio: 'ignore' });
const ep = (id: string, session: string, text: string) => {
  const dir = join(vault, 'episodes/2026/06');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\ntype: episode\nstarted: 2026-06-04T10:00:00-04:00\ncreated: 2026-06-04\nsource: chat\nby: agent\nsession: ${session}\n---\n# ${id}\n\n${text}\n`);
};
ep('2026-06-04-coder-retry-wrapper', 'coder-s1', 'Wrote the billing api retry wrapper: payment retries back off exponentially, three attempts, idempotency key per request.');
ep('2026-06-04-qa-retry-flake', 'qa-s1', 'Billing api payment retry test flaked on CI: retries fired five attempts instead of three. Suspect retry wrapper misconfigured.');
const cfg = loadConfig(vault);
buildIndex(vault, cfg);

const now = Date.parse('2026-10-02T12:00:00-04:00');
const coderQuery = 'billing api payment retry attempts';
async function measure() {
  const r = await recall(vault, cfg, coderQuery, { logAccess: false, now });
  return r.hits
    .filter((h: { noteId: string }) => h.noteId.startsWith('2026-06-04'))
    .map((h: { noteId: string; score: number; components: { activation: number } }, i: number) => ({
      rank: i + 1, note: h.noteId, score: +h.score.toFixed(4), activation: +h.components.activation.toFixed(4),
    }));
}
const before = await measure();
// QA uses its own memory heavily over the following weeks (15 recalls, logged, as MCP does by default).
for (let i = 0; i < 15; i++)
  await recall(vault, cfg, 'flaky payment retry test on CI', { logAccess: true, session: 'qa-s2', now: now - (15 - i) * 86_400_000 });
const after = await measure();
console.log(JSON.stringify({ coderQuery, before, after, accessLogLines: readFileSync(join(vault, '.circadia/access.jsonl'), 'utf8').trim().split('\n').length }, null, 2));
