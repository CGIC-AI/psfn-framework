# PSFN Eval Toolkit

Offline evaluation, validation, and experimentation tooling for PSFN.

This repository owns the eval harnesses, fixtures, model probes, calibration
tools, and report generators that do not need to ship with the live runtime.
The sibling `../psfn-framework` repository keeps the runtime seams that evals
can hook into.

## Common Commands

```bash
npm test
npm run lint
npm run build
npm run eval:companion-shape:report -- --responses <captured-responses.json> --output /tmp/companion-shape-report.md
npm run eval:repeng:validate
```

The existing eval paths are intentionally preserved under `eval/` in this first
split so historical fixtures, scripts, and artifact references remain stable.
