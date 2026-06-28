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
