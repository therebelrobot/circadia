# RFC-0004 pollution experiments

Evidence for [RFC-0004 discovery](../../docs/rfcs/RFC-0004-discovery.md), phase 2. Each
script builds its own vault in the OS temp directory and never touches `examples/vault/`.
Not part of the test suite, the typecheck, or the npm package.

Run from the repo root after `npm install` (the MCP SDK is a dev dependency):

```bash
node scripts/rfc-0004-pollution/pollution.ts > pollution.out.json   # P1, P2, P4, P5 (and a saturated P3)
node scripts/rfc-0004-pollution/actr.ts                             # P3 with 120-day-old episodes
node scripts/rfc-0004-pollution/long-slug.ts                        # B4: ENAMETOOLONG from remember
```

| file | what it shows |
|---|---|
| `pollution.ts` | Three agents, three `circadia mcp` processes, one shared vault, driven through the official MCP SDK. Recall leakage, what `scope` can and can't isolate, one consolidation run against a loopback mock model, and REM pair sampling |
| `actr.ts` | One agent's recalls raising another agent's episode activation through the shared access log |
| `long-slug.ts` | A 314-character first sentence makes `remember` fail |
| `*.out.json`, `*.out.txt`, `pollution.stderr.txt` | Output of the run cited in the discovery doc, 2026-10-02 at `ef39638`. The stderr file holds B2's "refusing to commit" warning |

Determinism: recall and consolidation results are deterministic for a given commit. REM
pairs are seeded by the night (RFC-0001), so `P5` lists different pairs on a different
date; the counts may move, the cross-vault argument doesn't. `actr.ts` pins its clock.
