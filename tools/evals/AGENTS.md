# Eval Toolkit Agent Notes

The repository-wide [`../../AGENTS.md`](../../AGENTS.md) is authoritative for
workflow, Beads, validation, and delivery. This directory owns PSFN's offline
evaluation, validation, fixtures, model probes, calibration tools, and reports.

- Runtime behavior, production settings, and live service wiring stay in the
  monorepo's framework modules.
- Evals may import explicit framework seams through monorepo-relative paths.
  Do not require a separate checkout or copy runtime state into the toolkit.
- Provider-spending, model-download, and live-runtime evals remain explicit;
  `npm run verify:evals` only runs bounded offline checks.

Validation from the repository root is `npm run verify:evals`.
