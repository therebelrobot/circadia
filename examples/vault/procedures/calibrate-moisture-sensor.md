---
type: procedure
tags: [garden, iot]
created: 2026-07-20
importance: 0.6
---
# Calibrate a moisture sensor

## When to use
New probe, moved probe, or readings that disagree with a hand check.

## Steps
1. Read the probe in dry air and record the value as 0% VWC.
2. Read it submerged in water and record the value as 100%.
3. Store both endpoints for that node in the collector config.

## Pitfalls
Calibrate at mid-day soil temperature; see [[capacitive-sensing]] on temperature drift.
