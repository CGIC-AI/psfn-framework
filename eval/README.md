# Eval Scaffolding

This directory is the repo-owned home for evaluation assets. `PSFN-rp6i` only establishes the shared contracts and base Promptfoo configuration surface; it does not wire new runtime behavior.

## Layout

- `promptfooconfig.base.json`: inert base Promptfoo config for eval overlays.
- `local/`: local dense-model launch profiles, probe scripts, and setup notes for repo-owned eval targets.
- `tsconfig.json`: local TypeScript config for eval-only typechecking.
- `src/types.ts`: shared eval entry types and enums.
- `src/schemas.ts`: JSON Schema documents for scenario, result, and calibration entries.
- `src/validation.ts`: lightweight runtime validators for the shared eval entry types.
- `src/promptfoo.ts`: typed Promptfoo config surface backed by the base JSON config.
- `src/index.ts`: single re-export surface for downstream eval tooling.
- `companion-shape/`: offline companion-shape scorecard generator for captured model outputs.

## Shared Contracts

- Scenario entries define the prompt under test plus the expected emotion labels, expected VAD band, and ground-truth provenance.
- Result entries normalize provider/model output together with the measurement layer that produced the metrics.
- Calibration entries define threshold bands for scoring or alerting on eval metrics.

## Promptfoo Base Config

`promptfooconfig.base.json` is intentionally minimal:

- `prompts` is set to `{{prompt_text}}` so scenario rows can supply the evaluated prompt body.
- `providers` and `tests` are empty so downstream configs can layer concrete providers, datasets, and assertions without mutating the base contract.
- `defaultTest.metadata.schemaVersion` is pinned to `1` to align downstream artifacts with the initial eval schema version.

## Validation

Use the smallest local checks for this scaffold:

```bash
npx --no-install tsc -p eval/tsconfig.json --noEmit
npm test -- eval/companion-shape/report.test.ts
npm run lint
```

Once a concrete provider/test overlay exists, Promptfoo can be pointed at the base file with:

```bash
npx promptfoo eval -c eval/promptfooconfig.base.json
```
