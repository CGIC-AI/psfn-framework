# PSFN Eval Toolkit

Offline evaluation, validation, and experimentation tooling for PSFN.

This repository owns the eval harnesses, fixtures, model probes, calibration
tools, and report generators that do not need to ship with the live runtime.
The monorepo root keeps the runtime seams that evals hook into. Toolkit code may
import those seams through explicit monorepo-relative paths.

The toolkit standard is Node.js 24 LTS (24.19.0 or newer 24.x) with npm 11.17.0,
also recorded in `.node-version` and `package.json`.

## Common Commands

From the monorepo root, run the bounded offline gate:

```bash
npm run verify:evals
```

That command does not contact providers, download models, or spend inference
budget. Commands named `discover`, `qao:judge`, `llm-response`, and
`logprob:collect`, plus the local vLLM/llama.cpp launchers, are explicit
experiments and require their own reviewed inputs and provider/runtime setup.

```bash
npm test
npm run lint
npm run build
npm run eval:companion-shape:report -- --responses <captured-responses.json> --output /tmp/companion-shape-report.md
npm run eval:repeng:validate
```

The existing eval paths remain under `tools/evals/eval/` so historical fixtures,
scripts, and artifact references stay recognizable after the history-preserving
monorepo import.
