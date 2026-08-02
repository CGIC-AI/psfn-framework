---
name: bus
description: Use when a task is worked by more than one agent or across several substantial phases, or when a brief references an agentbus run file. Covers appending findings with provenance, typed ranks, corrections, and closing a run clean. Trigger on multi-lane waves, shared run files, or instructions naming a bus run path.
---

# The agent bus

Multi-lane work in this repository shares one append-only JSONL run file per
wave. The dispatcher opens it (`node scripts/agentbus/wave-open.mjs`) and each
lane's brief names the run path and the lane's bus agent name. The full
practice lives in the AGENTS.md "agent bus" section; the codebook is
`SCHEMA.md` in `~/agentbus`.

The tools are on `PATH` machine-wide (`bus-new`, `bus-append`, `bus-lint`,
`bus-embed`, `bus-model`, `bus-state`); no venv activation is needed.

## Lane duties

- Read the run file before appending; append as you work, not at the end.
- Findings carry `claim` + `provenance` (`computed | fetched | recalled |
  testimony`); `computed` requires inspectable `refs`. Nothing outbound rests
  on an unchecked `recalled` finding.
- Ranks are typed: `dimension` + `value` + `basis`, targeting an earlier
  finding. Disagreements are resolved by a rank with `resolves`, never
  averaged or deleted.
- Corrections are appends (`corrects` / `supersedes` / `retracts` relations),
  never rewrites or deletions.
- Before adding a finding, check for an existing equivalent
  (`bus-embed near <run> "<claim>"`); rank or extend instead of duplicating.
- Close substantial work with a `cost` line.

## Closing

`node scripts/agentbus/wave-close.mjs <run-file>` must exit 0 before the wave's
train publishes. A refused append or a lint error is fixed by correcting the
message, not by working around the tool.
