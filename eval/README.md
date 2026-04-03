# PSFN Eval Scaffold

This directory is the shared scaffold for PSFN emotion-eval work. It intentionally stops at contracts and local tooling setup:

- `src/` exports the shared TypeScript types, JSON-schema objects, and lightweight validators for scenario, result, and calibration data.
- `promptfooconfig.base.json` is the base Promptfoo config for eval work. It uses Promptfoo's `echo` provider so the scaffold can be exercised without probing external model APIs.
- `prompts/` holds reusable prompt templates.
- `fixtures/` holds local scaffold-only Promptfoo test data.

## Contracts

The current scaffold defines three primary record types:

- `EvalScenario`: source prompt plus ground-truth emotion labels and VAD range
- `EvalResult`: model/provider output plus scored metrics
- `EvalCalibrationEntry`: model/provider-specific calibration hints such as label aliasing and VAD offsets

Catalog wrappers are also included so datasets can be versioned with `schema_version: 1`.

## Validation

Type-check the eval-local TypeScript surface:

```bash
npx tsc -p eval/tsconfig.json --noEmit
```

The base Promptfoo config is JSON and can be loaded with:

```bash
promptfoo eval -c eval/promptfooconfig.base.json
```

Before running real evals, replace the scaffold fixture in `fixtures/promptfoo.scaffold-tests.json` and swap `providers: ["echo"]` for the actual providers under test.
