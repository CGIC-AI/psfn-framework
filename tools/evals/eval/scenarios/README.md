# Emotion Calibration Scenarios

This directory contains a machine-readable scenario pack for emotion-calibration evaluation.

Files:
- `calibration.scenarios.json`: canonical scenario instances in Promptfoo-compatible external test format.
- `calibration.schema.json`: fail-closed schema for future harness validation.

Promptfoo usage:

```yaml
tests: file://eval/scenarios/calibration.scenarios.json
```

Promptfoo's current docs explicitly allow external test files in JSON format and support test cases made from `description`, `vars`, and `metadata` fields:
- https://www.promptfoo.dev/docs/configuration/test-cases/
- https://www.promptfoo.dev/docs/configuration/parameters/

Labeling methodology:
1. Primary and secondary emotion labels are restricted to the repository's current text-emotion taxonomy in `src/core/emotion/observer.ts` and `src/core/emotion/state.ts`: `anger`, `anticipation`, `confusion`, `disgust`, `fear`, `joy`, `love`, `neutral`, `optimism`, `pessimism`, `sadness`, `surprise`, and `trust`.
2. `ground_truth.vad` is a signed calibration target aligned to the repo's existing VAD framing rather than a new ontology.
3. The bead asked for ACAC coverage, but this repo does not define `ACAC` elsewhere. For this scenario pack, ACAC is operationalized as:
   - `arousal`: low / medium / high intensity
   - `control`: low / medium / high perceived agency, chosen to line up with the repo's dominance-style signals
   - `approach`: approach / balanced / avoid orientation
   - `certainty`: low / medium / high interpretive confidence, chosen to line up with `certaintyLevel` and uncertainty-style signals in `src/core/self-model/state.ts` and `src/core/self-model/metacognition.ts`
4. Confusable-pair scenarios intentionally place near-neighbor labels in similar contexts so future evaluators can measure calibration failures, not just obvious classification wins.

Coverage summary:
- 32 scenarios total
- 12 positive, 12 negative, 8 neutral
- 16 scenarios grouped into 8 confusable pairs
- all 13 current observer labels represented at least once

Future harness guidance:
- Use `vars.user_message` as the primary model input.
- Use `metadata.ground_truth` as the authoritative scoring target.
- Use `metadata.confusable_pair` to compute pairwise confusion metrics separately from overall accuracy.
