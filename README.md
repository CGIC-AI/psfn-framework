# PSFN Eval Toolkit

Offline evaluation, validation, and experimentation tooling for PSFN.

This repository owns the eval harnesses, fixtures, model probes, calibration
tools, and report generators that do not need to ship with the live runtime.
The sibling `../psfn-framework` repository keeps the runtime seams that evals
can hook into.

The toolkit standard is Node.js 24 LTS (24.19.0 or newer 24.x) with npm 11.17.0,
also recorded in `.node-version` and `package.json`.

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
