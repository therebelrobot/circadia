# ADR-0005: Rename to Circadia

**Status:** Accepted  
**Date:** 2026-09-29

## Context

The project name "Palimpsest" references a manuscript that was scraped and rewritten over, with older text still faintly visible. While this metaphor captures the system's approach to superseded facts, it has several limitations:

1. **Passive connotation**: A palimpsest is primarily a storage medium, not an active process
2. **Obscure for new users**: The term requires explanation
3. **No connection to memory consolidation**: The daily cycle of fact stabilization is not reflected

We need a name that:
- Emphasizes the active, cyclical nature of memory consolidation
- Is more immediately understandable
- Connects to biological memory processes

## Decision

Rename the project to **Circadia** (from *circadian rhythm*), reflecting:

1. **Daily consolidation cycle**: Memory traces written today become stable facts by tomorrow, mirroring biological circadian rhythms
2. **Active process**: Circadian rhythms are active, ongoing processes—not passive storage
3. **Scientific grounding**: Directly connects to neuroscience (the hippocampal formation has well-documented circadian patterns)

## Consequences

### Files changed
- Package name: `palimpsest` → `circadia`
- Config file: `palimpsest.config.json` → `circadia.config.json`
- State directory: `.palimpsest/` → `.circadia/`
- CLI binary: `bin/palimpsest.mjs` → `bin/circadia.mjs`

### Documentation
- README.md opening rewritten to explain the circadian rhythm metaphor
- CONFIG.md updated with new configuration reference
- All code comments updated from "palimpsest" to "circadia"

## Alternatives Considered

- **Memex**: Too tied to Vannevar Bush's original concept; overused in the space
- **Hippocampus**: Too narrow; only references one brain region
- **Synaptic**: Focuses on individual connections, not the holistic consolidation process

## References

- `src/config.ts`: Added `STATE_DIR`, `CONFIG_FILENAME` constants
- `docs/CONFIG.md`: Configuration reference
