// Deterministic eval fixture generator (Phase 7, Step 2).
//
// Produces a ~300-note vault with the shapes the eval set needs: three scoped
// projects, bi-temporal facts whose world time and system time diverge, a
// low-trust web clipping, `prefers::` facts (one superseded), and two tiers of
// remote-association pairs. Deterministic (pinned LCG seed, mirroring
// benchmarks/generate-vault.ts) so two runs are byte-identical.
//
// Usage: node --experimental-strip-types eval/generate-fixture.ts <outDir>

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { parseNote } from '../src/vault/parse.ts';
import { passageHash, writeTriples } from '../src/extract/triples.ts';

const HERE = import.meta.dirname;

/** Small deterministic PRNG (LCG) so generated vaults are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface Note {
  path: string;
  content: string;
}

/** The hand-written core: every shape the eval set queries. */
function coreNotes(): Note[] {
  return [
    {
      path: 'entities/tools/pi-cluster.md',
      content: `---
type: entity
kind: tool
created: 2026-01-02
---
# Pi Cluster

The pi-cluster is a four-node Raspberry Pi cluster used for local compute and sensor aggregation.

## Facts
- [status:: active] [by:: user]
`,
    },
    {
      path: 'entities/tools/old-laptop.md',
      content: `---
type: entity
kind: tool
created: 2026-01-02
---
# Old Laptop

The old-laptop is a retired ThinkPad used as a backup host for batch jobs.

## Facts
- [status:: archived] [by:: user]
`,
    },
    {
      path: 'entities/tools/greenhouse-controller.md',
      content: `---
type: entity
kind: tool
created: 2026-02-01
---
# Greenhouse Controller

The greenhouse-controller is a small PLC that drives irrigation valves and ventilation fans.

## Facts
- [status:: active] [by:: user]
`,
    },
    {
      path: 'entities/people/sam.md',
      content: `---
type: entity
kind: person
created: 2026-01-02
---
# Sam

Sam maintains the orchard sensors and keeps the calibration log.

## Facts
- [prefers:: [[tea]]] [by:: user]

## History
- ~~[prefers:: [[coffee]]]~~ [superseded:: 2026-05-01] [by:: user]
`,
    },
    {
      path: 'entities/concepts/tea.md',
      content: `---
type: entity
kind: concept
created: 2026-01-02
---
# Tea

Tea is a hot drink brewed from steeped leaves.
`,
    },
    {
      path: 'entities/concepts/coffee.md',
      content: `---
type: entity
kind: concept
created: 2026-01-02
---
# Coffee

Coffee is a hot drink brewed from roasted beans.
`,
    },
    {
      path: 'entities/concepts/soil-moisture.md',
      content: `---
type: entity
kind: concept
created: 2026-01-03
tags: [deep]
---
# Soil Moisture

Soil moisture is measured by a capacitive sensor buried at root depth. The sensor reports volumetric water content.
`,
    },
    {
      path: 'entities/concepts/alpha-topic.md',
      content: `---
type: entity
kind: concept
created: 2026-01-04
---
# Alpha Topic

The alpha topic concerns capacitive soil sensing and its calibration drift.

See [[shared-hub]] for the shared research index.
`,
    },
    {
      path: 'entities/concepts/beta-topic.md',
      content: `---
type: entity
kind: concept
created: 2026-01-04
---
# Beta Topic

The beta topic concerns irrigation scheduling and water budgeting.

See [[shared-hub]] for the shared research index.
`,
    },
    {
      path: 'entities/concepts/shared-hub.md',
      content: `---
type: entity
kind: concept
created: 2026-01-04
---
# Shared Hub

The shared hub connects sensing research and scheduling research.
`,
    },
    {
      path: 'entities/concepts/gamma-topic.md',
      content: `---
type: entity
kind: concept
created: 2026-01-05
---
# Gamma Topic

The gamma topic concerns gateway firmware and radio duty cycles.

See [[hop-one]] for the next step in the chain.
`,
    },
    {
      path: 'entities/concepts/hop-one.md',
      content: `---
type: entity
kind: concept
created: 2026-01-05
---
# Hop One

Hop one is an intermediate note in the association chain.

See [[hop-two]] for the next step.
`,
    },
    {
      path: 'entities/concepts/hop-two.md',
      content: `---
type: entity
kind: concept
created: 2026-01-05
---
# Hop Two

Hop two is an intermediate note in the association chain.

See [[delta-topic]] for the final step.
`,
    },
    {
      path: 'entities/concepts/delta-topic.md',
      content: `---
type: entity
kind: concept
created: 2026-01-05
---
# Delta Topic

The delta topic concerns long-range telemetry and its failure modes.
`,
    },
    {
      path: 'projects/alpha/alpha-overview.md',
      content: `---
type: entity
kind: project
created: 2026-01-01
tags: [project]
---
# Alpha Project

Alpha is the orchard sensor project. It tracks soil moisture across the north orchard.

## Facts
- [runs_on:: [[pi-cluster]]] [valid:: 2026-01..2026-06] [at:: 2026-01-05] [by:: user]
- [runs_on:: [[old-laptop]]] [valid:: 2026-06..] [at:: 2026-06-10] [by:: user]
- [maintained_by:: [[sam]]] [by:: user]
`,
    },
    {
      path: 'projects/beta/beta-overview.md',
      content: `---
type: entity
kind: project
created: 2026-02-01
tags: [project]
---
# Beta Project

Beta is the greenhouse automation project. It controls irrigation and ventilation.

## Facts
- [runs_on:: [[greenhouse-controller]]] [valid:: 2026-02..] [at:: 2026-09-01] [by:: user]
`,
    },
    {
      path: 'projects/gamma/gamma-overview.md',
      content: `---
type: entity
kind: project
created: 2026-03-01
tags: [project]
---
# Gamma Project

Gamma is the telemetry project. It collects long-range radio readings from remote masts.
`,
    },
    {
      path: 'episodes/2026/09/2026-09-10-web-clipping.md',
      content: `---
type: episode
started: 2026-09-10T09:00:00Z
source: import
by: web
---
# Web Clipping: Drip Irrigation

Drip irrigation timing: water deeply twice a week, early in the morning, to reduce evaporation.
`,
    },
  ];
}

const SUBJECTS = [
  'sensor array',
  'irrigation loop',
  'ventilation fan',
  'soil probe',
  'gateway node',
  'power rail',
  'camera rig',
  'weather mast',
];
const VERBS = ['tracks', 'reports', 'regulates', 'monitors', 'calibrates', 'buffers', 'streams', 'aggregates'];
const OBJECTS = [
  'volumetric water content',
  'ambient humidity',
  'canopy temperature',
  'battery voltage',
  'packet loss',
  'wind speed',
  'solar yield',
  'leaf wetness',
];
const CONNECTORS = [
  'In practice,',
  'During the trial,',
  'On most days,',
  'After calibration,',
  'In the greenhouse,',
  'At night,',
  'Under load,',
  'Between runs,',
];

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

/** Filler notes: varied sentence structure, links only among filler notes. */
function fillerNotes(perProject: number): Note[] {
  const rng = makeRng(1337);
  const projects = ['alpha', 'beta', 'gamma'];
  const out: Note[] = [];
  for (const project of projects) {
    const ids = Array.from({ length: perProject }, (_, n) => `filler-${project}-${String(n).padStart(3, '0')}`);
    for (let n = 0; n < perProject; n++) {
      const id = ids[n];
      const subj = pick(rng, SUBJECTS);
      const verb = pick(rng, VERBS);
      const obj = pick(rng, OBJECTS);
      const conn = pick(rng, CONNECTORS);
      const variant = Math.floor(rng() * 4);
      const linkCount = 1 + Math.floor(rng() * 2);
      const links: string[] = [];
      for (let l = 0; l < linkCount; l++) {
        let t = Math.floor(rng() * perProject);
        if (t === n) t = (t + 1) % perProject;
        links.push(`[[${ids[t]}]]`);
      }
      const sentences = [
        `${conn} the ${subj} ${verb} ${obj} and logs it to the ${project} dashboard.`,
        `A ${subj} ${verb} ${obj}; the ${project} team reviews the trend weekly.`,
        `When the ${subj} ${verb} ${obj}, the ${project} pipeline raises a flag.`,
        `The ${project} ${subj} ${verb} ${obj} continuously.`,
      ];
      const day = String(1 + (n % 28)).padStart(2, '0');
      const month = String(1 + (n % 9)).padStart(2, '0');
      out.push({
        path: `projects/${project}/filler/${id}.md`,
        content: `---
type: entity
kind: concept
created: 2026-${month}-${day}
tags: [filler]
---
# ${id}

${sentences[variant]} ${links.join(' ')}
`,
      });
    }
  }
  return out;
}

export function generateFixture(outDir: string): void {
  const write = (rel: string, content: string): void => {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  // config: copied verbatim from the committed fixture config so the two cannot drift
  write('circadia.config.json', readFileSync(join(HERE, 'fixture.config.json'), 'utf8'));

  const notes = [...coreNotes(), ...fillerNotes(94)];
  for (const n of notes) write(n.path, n.content);

  // access log: pinned timestamps, copied from the committed fixture
  write('.circadia/access.jsonl', readFileSync(join(HERE, 'access.fixture.jsonl'), 'utf8'));

  // hipporag triple cache for the one `deep`-tagged note. The content hash must
  // match the passage text exactly, so parse the note the same way the indexer does.
  const cfg = loadConfig(outDir);
  const rel = 'entities/concepts/soil-moisture.md';
  const parsed = parseNote(rel, readFileSync(join(outDir, rel), 'utf8'), 0, cfg);
  const p0 = parsed.passages.find((p) => p.id === 'soil-moisture#0');
  if (!p0) throw new Error('fixture: soil-moisture#0 passage not found');
  writeTriples(outDir, 'soil-moisture', [
    {
      passageId: p0.id,
      contentHash: passageHash(p0.text),
      subject: 'soil moisture',
      predicate: 'measured_by',
      object: 'capacitive sensor',
      conf: 0.9,
      model: 'fixture',
      extractedAt: '2026-09-01',
    },
    {
      passageId: p0.id,
      contentHash: passageHash(p0.text),
      subject: 'capacitive sensor',
      predicate: 'reports',
      object: 'volumetric water content',
      conf: 0.8,
      model: 'fixture',
      extractedAt: '2026-09-01',
    },
  ]);
}

if (process.argv[1] && process.argv[1].endsWith('generate-fixture.ts')) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: generate-fixture.ts <outDir>');
    process.exit(1);
  }
  generateFixture(outDir);
  console.log(`generated eval fixture at ${outDir}`);
}
