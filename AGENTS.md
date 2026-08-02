# Agent Instructions

This repository owns PSFN's offline eval, validation, and experimentation
tooling. The sibling `../psfn-framework` repository owns the live runtime.

Use `bd` for tracked work:

```bash
bd prime
bd ready --json
bd show <id> --json
bd update <id> --claim --json
bd close <id> --reason "Completed" --json
bd dolt commit --json
```

The active beads were migrated from `psfn-framework` on 2026-06-28. Some bead
IDs intentionally retain the old prefix for history.

Keep runtime integration narrow:

- Eval harnesses, fixtures, model probes, calibration tools, and reports belong
  here.
- Runtime seams, production settings, and live service wiring belong in
  `../psfn-framework`.
- If an eval needs framework code, import through an explicit local sibling
  seam or create a small shared contract; do not copy runtime state into this
  repo.

Validation:

```bash
npm run lint
npm run build
npm test
```

## The agent bus

When a task is worked by more than one agent, or across several substantial phases, all
participants share one append-only JSONL run file. Its codebook is `SCHEMA.md` in
`~/agentbus`. The bus tools (`bus-new`, `bus-append`, `bus-lint`, `bus-embed`, `bus-model`,
`bus-state`) are on `PATH` machine-wide; runs go to the shared cross-repo home
`~/agentbus-runs` (`AGENTBUS_DIR`), so findings are searchable across the PSFN repos.

**Opening a wave run.** `bus-wave-open <wave-name> <lane-a> <lane-b> [...]` creates the run
and prints a brief block per lane — paste each into that lane's brief. Single-lane work does
not get a bus.

**Lane duties.** Read the run before appending; append as you work. Findings carry `claim` +
`provenance` (`computed | fetched | recalled | testimony`); `computed` requires inspectable
`refs`. Nothing outbound rests on an unchecked `recalled` finding. Ranks are typed
(`dimension` + `value` + `basis`); disagreements are resolved by a rank with `resolves`,
never averaged or deleted. Corrections are appends (`corrects` / `supersedes` / `retracts`),
never rewrites. Check for an existing equivalent (`bus-embed near <run> "<claim>"`) before
adding a finding. Close substantial work with a `cost` line.

**Closing.** `bus-wave-close <run-file>` must exit 0 before the wave's work publishes. A
refused append or lint error is fixed by correcting the message, never by working around
the tool.
