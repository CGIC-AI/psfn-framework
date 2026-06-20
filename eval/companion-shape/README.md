# Companion Shape Eval

This directory contains an offline report generator for comparing captured model outputs against PSFN companion-shape expectations. It does not call live providers; use it after a shakedown, manual run, Promptfoo run, or other harness has captured responses.

## Inputs

- `scenarios.json`: repo-owned prompts and deterministic signal rubrics.
- `fixtures/sample-responses.json`: minimal example input for smoke testing the generator.

Captured responses use this shape:

```json
{
  "schemaVersion": 1,
  "runId": "my-model-sweep",
  "responses": [
    {
      "scenarioId": "tool-execution-truth",
      "modelId": "openrouter/z-ai/glm-5.1",
      "providerId": "openrouter",
      "response": "captured model text"
    }
  ]
}
```

## Report

```bash
npm run eval:companion-shape:report -- \
  --responses eval/companion-shape/fixtures/sample-responses.json \
  --output /tmp/companion-shape-report.md \
  --json-output /tmp/companion-shape-report.json
```

The Markdown report ranks model/provider pairs, records missing scenario coverage, and flags missing required signals or stale-tool-name regressions. The JSON report is intended for trend tracking across shakedown rounds.

## QAO Upgrade Matrix

```bash
npm run eval:qao:report -- \
  --judge eval/companion-shape/artifacts/qao-judge/my-run.qao-judge.json \
  --collection eval/companion-shape/artifacts/qao-collection/my-run.qao-collection.json \
  --output /tmp/qao-upgrade-report.md \
  --json-output /tmp/qao-upgrade-report.json
```

The QAO report consumes judge council artifacts, optionally joins collection coverage metadata, ranks model targets for roster promotion, and renders Markdown without raw response text.

## Offline Regression Gate

```bash
npm run eval:regression
```

The regression command compares privacy-safe QAO upgrade report JSON plus optional companion-shape report JSON against a baseline. The default inputs are sanitized fixtures under `eval/companion-shape/fixtures/` and require no provider secrets, live companion data, or raw model responses.

Score drops greater than 5% of the metric scale are emitted as warnings. New blocker-level QAO findings, missing required coverage, provider failures, judge failures, and current targets that disappear from the baseline comparison fail the command. Warning-only score deltas remain visible in Markdown/JSON without failing CI.

```bash
npm run eval:regression -- \
  --baseline /tmp/baseline-qao-report.json \
  --current /tmp/current-qao-report.json \
  --baseline-companion-shape /tmp/baseline-companion-shape-report.json \
  --current-companion-shape /tmp/current-companion-shape-report.json \
  --output /tmp/companion-shape-regression.md \
  --json-output /tmp/companion-shape-regression.json
```

Use `--no-companion-shape` when comparing only QAO upgrade matrix reports. The rendered outputs summarize identity consistency, refusal boundary, and emotional continuity coverage without exposing raw private responses.
