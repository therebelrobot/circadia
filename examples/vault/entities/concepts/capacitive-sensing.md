---
type: entity
kind: concept
aliases: [capacitive probes]
tags: [iot, deep]
created: 2026-07-15
importance: 0.6
---
# Capacitive sensing

Capacitive probes measure the dielectric permittivity of the soil around them. Water has
a much higher permittivity than dry soil or air, so wetter soil raises the probe's
capacitance and lowers the oscillator frequency the microcontroller reads.

## Why not resistive probes

Resistive probes pass DC current through the soil, which electrolyses and corrodes the
electrodes within weeks. Capacitive probes are insulated, so they last seasons, at the
cost of needing per-probe calibration against [[soil-moisture]] readings.

## Temperature effects

Permittivity of water falls as temperature rises, so an uncompensated probe reads
slightly drier on hot afternoons than at dawn.
