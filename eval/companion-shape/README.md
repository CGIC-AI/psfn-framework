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
