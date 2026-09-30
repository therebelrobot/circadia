// Deterministic eval fixture generator (Phase 7, Step 2).
//
// Produces a ~300-note vault with the shapes the eval set needs: four scoped
// projects, bi-temporal facts whose world time and system time diverge, a
// low-trust web clipping, `prefers::` facts (one superseded), two tiers of
// non-lexical remote-association pairs, and a hipporag cluster whose only
// connecting paths run through triple/synonym edges. Deterministic (pinned LCG
// seed, mirroring benchmarks/generate-vault.ts) so two runs are byte-identical.
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

function titleOf(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function entity(id: string, kind: string, body: string, extra: { tags?: string[]; created?: string; facts?: string[] } = {}): Note {
  const tags = extra.tags ? `tags: [${extra.tags.join(', ')}]\n` : '';
  const facts = extra.facts && extra.facts.length > 0 ? `\n## Facts\n${extra.facts.map((f) => `- ${f}`).join('\n')}\n` : '';
  return {
    path: `entities/${kind}s/${id}.md`,
    content: `---
type: entity
kind: ${kind}
created: ${extra.created ?? '2026-01-01'}
${tags}---
# ${titleOf(id)}

${body}
${facts}`,
  };
}

// ---- remote-association concepts (non-lexical: each note uses only its own words) ----

const CONCEPTS = [
  // 2-hop seeds (0-7)
  'electrode-drift', 'water-budgeting', 'radio-duty', 'firmware-branch',
  'telemetry-failure', 'long-range-telemetry', 'canopy-shade', 'orchard-canopy',
  // 2-hop targets (8-15)
  'aquifer-salinity', 'turbine-gearbox', 'pipeline-corrosion', 'beacon-ranging',
  'compost-nitrogen', 'orchard-pruning', 'greenhouse-ventilation', 'reservoir-sediment',
  // 2-hop hubs (16-23)
  'loam-porosity', 'mulch-erosion', 'trellis-pollination', 'hive-foraging',
  'silo-aeration', 'grain-moisture', 'tractor-hydraulics', 'implement-tillage',
  // 3-hop seeds (24-31)
  'weathervane-anemometer', 'barometer-hygrometer', 'thermistor-photodiode', 'actuator-solenoid',
  'manifold-gasket', 'bearing-coupling', 'flywheel-governor', 'throttle-carburetor',
  // 3-hop a (32-39)
  'sprocket-ratchet', 'pulley-tension', 'clutch-friction', 'brake-caliper',
  'axle-differential', 'suspension-damper', 'chassis-welding', 'fender-rust',
  // 3-hop b (40-47)
  'windlass-anchor', 'rudder-keel', 'mast-rigging', 'sail-batten',
  'hull-caulking', 'ballast-trim', 'compass-bearing', 'sextant-azimuth',
  // 3-hop targets (48-55)
  'lighthouse-foghorn', 'buoy-mooring', 'harbor-dredging', 'pier-pilings',
  'ferry-schedule', 'tide-almanac', 'current-rip', 'shoal-sounding',
];

/** 2-hop pair i: seed CONCEPTS[i] and target CONCEPTS[8+i] share hub CONCEPTS[16+i]. */
export function remote2hop(i: number): { seed: string; target: string; hub: string } {
  return { seed: CONCEPTS[i], target: CONCEPTS[8 + i], hub: CONCEPTS[16 + i] };
}

/** 3-hop chain i: seed CONCEPTS[24+i] -> a -> b -> target CONCEPTS[48+i]. */
export function remote3hop(i: number): { seed: string; a: string; b: string; target: string } {
  return { seed: CONCEPTS[24 + i], a: CONCEPTS[32 + i], b: CONCEPTS[40 + i], target: CONCEPTS[48 + i] };
}

function conceptNote(id: string, links: string[]): Note {
  const linkLine = links.length > 0 ? `\nSee ${links.map((l) => `[[${l}]]`).join(' and ')}.\n` : '';
  return entity(id, 'concept', `${titleOf(id)} is a concept tracked in the field log.${linkLine}`, { created: '2026-01-06' });
}

function conceptNotes(): Note[] {
  const out: Note[] = [];
  for (let i = 0; i < 8; i++) {
    const { seed, target, hub } = remote2hop(i);
    out.push(conceptNote(seed, [hub]));
    out.push(conceptNote(target, [hub]));
    out.push(conceptNote(hub, []));
  }
  for (let i = 0; i < 8; i++) {
    const { seed, a, b, target } = remote3hop(i);
    out.push(conceptNote(seed, [a]));
    out.push(conceptNote(a, [b]));
    out.push(conceptNote(b, [target]));
    out.push(conceptNote(target, []));
  }
  return out;
}

// ---- preferences ----

const PERSONS = ['sam', 'ada', 'bo', 'cy', 'dee', 'eli', 'fay', 'gus', 'hal'];
const THINGS = ['tea', 'coffee', 'kettle', 'lantern', 'compass', 'abacus', 'harmonica', 'telescope', 'kayak', 'sundial', 'astrolabe'];

/** person -> preferred thing. `sam` also has a superseded preference for coffee. */
export const PREFERENCE: Record<string, string> = {
  sam: 'tea',
  ada: 'kettle',
  bo: 'lantern',
  cy: 'compass',
  dee: 'abacus',
  eli: 'harmonica',
  fay: 'telescope',
  gus: 'kayak',
  hal: 'astrolabe',
};

/** tea and coffee are lexical twins so the preference query can surface both. */
const THING_BODIES: Record<string, string> = {
  tea: 'Tea is a hot drink brewed from steeped leaves.',
  coffee: 'Coffee is a hot drink brewed from roasted beans.',
};

/** extra tags so a preference query can be scoped to one person's cluster. */
const THING_TAGS: Record<string, string[]> = { coffee: ['pref-sam'] };

function preferenceNotes(): Note[] {
  const out: Note[] = [];
  for (const thing of THINGS) {
    const owner = Object.entries(PREFERENCE).find(([, t]) => t === thing)?.[0];
    const tags = owner ? [`pref-${owner}`] : (THING_TAGS[thing] ?? []);
    out.push(
      entity(thing, 'concept', THING_BODIES[thing] ?? `A ${thing} is a simple object kept in the workshop.`, {
        created: '2026-01-02',
        tags,
      }),
    );
  }
  for (const person of PERSONS) {
    const thing = PREFERENCE[person];
    const history =
      person === 'sam'
        ? `\n## History\n- ~~[prefers:: [[coffee]]]~~ [superseded:: 2026-05-01] [by:: user]\n`
        : '';
    out.push({
      path: `entities/people/${person}.md`,
      content: `---
type: entity
kind: person
created: 2026-01-02
tags: [pref-${person}]
---
# ${titleOf(person)}

${titleOf(person)} keeps a small workshop.

## Facts
- [prefers:: [[${thing}]]] [by:: user]
${history}`,
    });
  }
  return out;
}

// ---- hipporag cluster: 8 deep notes whose only connecting paths are triples ----

export const DEEP_TRIPLES: Record<string, { subject: string; predicate: string; object: string }[]> = {
  'sensor-calibration': [{ subject: 'sensor calibration', predicate: 'affects', object: 'probe aging' }],
  'probe-aging': [{ subject: 'probe aging', predicate: 'causes', object: 'reading drift' }],
  'gateway-firmware': [{ subject: 'gateway firmware', predicate: 'sets', object: 'duty cycle' }],
  'duty-cycle': [{ subject: 'duty cycle', predicate: 'limits', object: 'battery life' }],
  'soil-chemistry': [{ subject: 'soil chemistry', predicate: 'drives', object: 'nutrient runoff' }],
  'nutrient-runoff': [{ subject: 'nutrient runoff', predicate: 'pollutes', object: 'downstream water' }],
  'canopy-light': [{ subject: 'canopy light', predicate: 'regulates', object: 'leaf wetness' }],
  'leaf-wetness': [{ subject: 'leaf wetness', predicate: 'predicts', object: 'fungal risk' }],
};

const DEEP_BODIES: Record<string, string> = {
  'sensor-calibration': 'Sensor calibration corrects a probe baseline before each season.',
  'probe-aging': 'Probe aging shifts a buried electrode response over time.',
  'gateway-firmware': 'Gateway firmware pins the radio stack for field units.',
  'duty-cycle': 'Duty cycle trades latency for battery life on remote masts.',
  'soil-chemistry': 'Soil chemistry governs how nutrients move through the root zone.',
  'nutrient-runoff': 'Nutrient runoff carries dissolved nitrogen into ditches.',
  'canopy-light': 'Canopy light shapes how much sun reaches the lower leaves.',
  'leaf-wetness': 'Leaf wetness predicts fungal risk after a damp night.',
};

function deepNotes(): Note[] {
  return Object.keys(DEEP_TRIPLES).map((id) =>
    entity(id, 'concept', DEEP_BODIES[id], { tags: ['deep'], created: '2026-01-03' }),
  );
}

// ---- hand-written core ----

function coreNotes(): Note[] {
  return [
    entity('pi-cluster', 'tool', 'The pi-cluster is a four-node Raspberry Pi cluster used for local compute and sensor aggregation.', {
      tags: ['alpha'],
      created: '2026-01-02',
      facts: ['[status:: active] [by:: user]'],
    }),
    entity('old-laptop', 'tool', 'The old-laptop is a retired ThinkPad used as a backup host for batch jobs.', {
      tags: ['alpha'],
      created: '2026-01-02',
      facts: ['[status:: archived] [by:: user]'],
    }),
    entity('greenhouse-controller', 'tool', 'The greenhouse-controller is a small PLC that drives irrigation valves and ventilation fans.', {
      tags: ['beta'],
      created: '2026-02-01',
      facts: ['[status:: active] [by:: user]'],
    }),
    entity('field-gateway', 'tool', 'The field-gateway relays radio packets from remote masts to the barn.', {
      tags: ['gamma'],
      created: '2026-03-01',
      facts: ['[status:: active] [by:: user]'],
    }),
    entity('relay-tower', 'tool', 'The relay-tower extends radio coverage across the far paddock.', {
      tags: ['gamma'],
      created: '2026-03-01',
      facts: ['[status:: active] [by:: user]'],
    }),
    entity('solar-inverter', 'tool', 'The solar-inverter converts panel output for the pump house.', {
      tags: ['delta'],
      created: '2026-04-01',
      facts: ['[status:: active] [by:: user]'],
    }),
    {
      path: 'projects/alpha/alpha-overview.md',
      content: `---
type: entity
kind: project
created: 2026-01-01
tags: [project, alpha]
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
tags: [project, beta]
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
tags: [project, gamma]
---
# Gamma Project

Gamma is the telemetry project. It collects long-range radio readings from remote masts.

## Facts
- [runs_on:: [[field-gateway]]] [valid:: 2026-03..2026-07] [at:: 2026-03-05] [by:: user]
- [runs_on:: [[relay-tower]]] [valid:: 2026-07..] [at:: 2026-07-10] [by:: user]
- [maintained_by:: [[hal]]] [by:: user]
`,
    },
    {
      path: 'projects/delta/delta-overview.md',
      content: `---
type: entity
kind: project
created: 2026-04-01
tags: [project, delta]
---
# Delta Project

Delta is the pump house project. It manages solar power for the irrigation pumps.

## Facts
- [runs_on:: [[solar-inverter]]] [valid:: 2026-04..] [at:: 2026-10-01] [by:: user]
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

// ---- filler (with ~10% distractors linking to core entities) ----

const SUBJECTS = [
  'sensor array', 'irrigation loop', 'ventilation fan', 'soil probe',
  'gateway node', 'power rail', 'camera rig', 'weather mast',
];
const VERBS = ['tracks', 'reports', 'regulates', 'monitors', 'calibrates', 'buffers', 'streams', 'aggregates'];
const OBJECTS = [
  'volumetric water content', 'ambient humidity', 'canopy temperature', 'battery voltage',
  'packet loss', 'wind speed', 'solar yield', 'leaf wetness',
];
const CONNECTORS = [
  'In practice,', 'During the trial,', 'On most days,', 'After calibration,',
  'In the greenhouse,', 'At night,', 'Under load,', 'Between runs,',
];

/** Core entities a filler note may link to. Deep notes are excluded so the
 *  triple-only path test cannot be short-circuited by a filler bridge. */
const DISTRACTOR_TARGETS = [
  'pi-cluster', 'old-laptop', 'greenhouse-controller', 'field-gateway', 'relay-tower', 'solar-inverter',
  'tea', 'coffee', 'kettle', 'lantern', 'compass', 'abacus', 'harmonica', 'telescope', 'kayak', 'sundial', 'astrolabe',
];

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

function fillerNotes(perProject: number): Note[] {
  const rng = makeRng(1337);
  const projects = ['alpha', 'beta', 'gamma'];
  const out: Note[] = [];
  let globalIndex = 0;
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
      // ~10% of filler notes link to a core entity, so traversal has competing paths
      if (globalIndex % 10 === 0) links.push(`[[${pick(rng, DISTRACTOR_TARGETS)}]]`);
      globalIndex++;
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

  const notes = [...coreNotes(), ...deepNotes(), ...conceptNotes(), ...preferenceNotes(), ...fillerNotes(68)];
  for (const n of notes) write(n.path, n.content);

  // access log: pinned timestamps, copied from the committed fixture
  write('.circadia/access.jsonl', readFileSync(join(HERE, 'access.fixture.jsonl'), 'utf8'));

  // hipporag triple cache for the deep notes. The content hash must match the
  // passage text exactly, so parse each note the same way the indexer does.
  const cfg = loadConfig(outDir);
  for (const id of Object.keys(DEEP_TRIPLES)) {
    const rel = `entities/concepts/${id}.md`;
    const parsed = parseNote(rel, readFileSync(join(outDir, rel), 'utf8'), 0, cfg);
    const p0 = parsed.passages.find((p) => p.id === `${id}#0`);
    if (!p0) throw new Error(`fixture: ${id}#0 passage not found`);
    writeTriples(
      outDir,
      id,
      DEEP_TRIPLES[id].map((t) => ({
        passageId: p0.id,
        contentHash: passageHash(p0.text),
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        conf: 0.9,
        model: 'fixture',
        extractedAt: '2026-09-01',
      })),
    );
  }
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
