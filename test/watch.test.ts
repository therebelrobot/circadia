// `circadia watch` (Phase 2, item 2). Uses a temp vault and temp index path;
// never touches examples/vault/. Generous timeouts to avoid flakiness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildIndex } from '../src/index/indexer.ts';
import { openIndex } from '../src/index/db.ts';
import { watchVault } from '../src/cli/watch.ts';

const tmp = mkdtempSync(join(tmpdir(), 'circadia-watch-'));

const CONFIG = {
  graph: { defaultExtraction: 'typed' },
  predicates: { strict: false, defs: { related_to: { object: 'entity' } } },
};

function makeVault(dir: string): string {
  const v = join(dir, 'vault');
  mkdirSync(join(v, 'entities', 'people'), { recursive: true });
  writeFileSync(join(v, 'circadia.config.json'), JSON.stringify(CONFIG));
  writeFileSync(join(v, 'entities', 'people', 'ann.md'), '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn v1.\n');
  return v;
}

const dbFor = (v: string) => join(v, '.circadia', 'index.sqlite');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('watch: fs.watch picks up a change after the debounce', async () => {
  const v = makeVault(join(tmp, 'w1'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  const log = console.log;
  console.log = () => { };
  let indexed = 0;
  try {
    const handle = watchVault(v, cfg, { dbPath, debounceMs: 100, onIndex: () => { indexed++; } });
    // give the watcher a moment to attach
    await sleep(150);

    // modify a note
    writeFileSync(join(v, 'entities', 'people', 'ann.md'), '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn v2.\n');

    // wait past the debounce for the reindex to land
    const deadline = Date.now() + 5000;
    while (indexed === 0 && Date.now() < deadline) await sleep(50);
    handle.abort();
  } finally {
    console.log = log;
  }

  assert.ok(indexed >= 1, 'watch triggered at least one reindex');
  const { db } = openIndex(dbPath);
  const p = db.prepare(`SELECT text FROM nodes WHERE id = 'ann#0'`).get() as { text: string };
  assert.match(p.text, /Ann v2/, 'the index picked up the change');
  db.close();
});

test('watch: --poll fallback picks up a change', async () => {
  const v = makeVault(join(tmp, 'w2'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  const log = console.log;
  console.log = () => { };
  let indexed = 0;
  try {
    const handle = watchVault(v, cfg, { dbPath, poll: true, pollIntervalMs: 100, onIndex: () => { indexed++; } });
    await sleep(150);

    writeFileSync(join(v, 'entities', 'people', 'ann.md'), '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn polled.\n');

    const deadline = Date.now() + 5000;
    while (indexed === 0 && Date.now() < deadline) await sleep(50);
    handle.abort();
  } finally {
    console.log = log;
  }

  assert.ok(indexed >= 1, 'polling triggered at least one reindex');
  const { db } = openIndex(dbPath);
  const p = db.prepare(`SELECT text FROM nodes WHERE id = 'ann#0'`).get() as { text: string };
  assert.match(p.text, /Ann polled/);
  db.close();
});

test('watch: --poll retries a change whose reindex failed', async () => {
  const v = makeVault(join(tmp, 'w3'));
  const cfg = loadConfig(v);
  const dbPath = dbFor(v);
  buildIndex(v, cfg, { dbPath });

  const log = console.log;
  const err = console.error;
  console.log = () => { };
  console.error = () => { };
  let indexed = 0;
  try {
    const handle = watchVault(v, cfg, { dbPath, poll: true, pollIntervalMs: 100, onIndex: () => { indexed++; } });
    await sleep(150);

    // 1. normal change -> reindex succeeds
    writeFileSync(join(v, 'entities', 'people', 'ann.md'), '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn v2.\n');
    const d1 = Date.now() + 5000;
    while (indexed < 1 && Date.now() < d1) await sleep(50);
    assert.equal(indexed, 1, 'first change indexed');

    // 2. break the index (a directory at the db path makes openIndex throw),
    //    then change a note: the reindex fails and must not consume the change
    rmSync(dbPath, { recursive: true, force: true });
    mkdirSync(dbPath);
    writeFileSync(join(v, 'entities', 'people', 'ann.md'), '---\ntype: entity\nkind: person\n---\n# Ann\n\nAnn v3.\n');
    await sleep(400); // let several poll cycles fail
    assert.equal(indexed, 1, 'failed reindex does not count as indexed');

    // 3. repair the index; the pending change must be picked up with no new edit
    rmSync(dbPath, { recursive: true, force: true });
    const d2 = Date.now() + 5000;
    while (indexed < 2 && Date.now() < d2) await sleep(50);
    handle.abort();
  } finally {
    console.log = log;
    console.error = err;
  }

  assert.ok(indexed >= 2, 'the change skipped by the failed reindex was retried');
  const { db } = openIndex(dbPath);
  const p = db.prepare(`SELECT text FROM nodes WHERE id = 'ann#0'`).get() as { text: string };
  assert.match(p.text, /Ann v3/, 'the retried reindex picked up the pending change');
  db.close();
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
