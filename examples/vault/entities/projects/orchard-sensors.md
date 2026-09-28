---
type: entity
kind: project
aliases: [Orchard, orchard project]
tags: [garden, iot]
created: 2026-06-01
updated: 2026-09-10
importance: 0.8
---
# Orchard sensors

A small network of soil sensors in the back orchard. Each node reports [[soil-moisture]]
over [[mqtt-broker|MQTT]] to a collector that decides when to open the drip lines.

## Design notes

Nodes are solar-powered and sleep between readings. The collector keeps a rolling
7-day window so a single bad reading can't trigger irrigation on its own. See
[[capacitive-sensing]] for why the probes are capacitive rather than resistive.

## Facts
- [runs_on:: [[pi-cluster]]] [valid:: 2026-08-11..] [at:: 2026-08-11] [by:: user] [src:: [[2026-08-11-migration]]] ^f-orch-host
- [depends_on:: [[mqtt-broker]]] [valid:: 2026-06..] [by:: user]
- [measures:: [[soil-moisture]]] [by:: user]
- [status:: active] [valid:: 2026-06-01..] [by:: user]
- [sample_interval:: 15m] [valid:: 2026-09-10..] [at:: 2026-09-10] [by:: user] — shortened for the dry spell
- [maintained_by:: [[sam]]] [by:: agent] [src:: [[2026-09-02-standup]]] [conf:: 0.7] — inferred from standup notes

## History
- ~~[runs_on:: [[old-laptop]]] [valid:: 2026-06-01..2026-08-11]~~ [at:: 2026-06-01] [superseded:: 2026-08-11] [by:: user] ^f-orch-host-old
- [sample_interval:: 1h] [valid:: 2026-06-01..2026-09-10] [at:: 2026-06-01] [by:: user]
