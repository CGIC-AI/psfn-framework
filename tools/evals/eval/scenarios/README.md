# Evaluation Scenario Packs

This directory contains machine-readable scenario packs. Each pack is a
harness-agnostic definition of what the system is supposed to get right; the
harness that scores it lives elsewhere.

- `calibration.*` — emotion calibration.
- `companion-episodic.*` — companion-salient episodic retention and recall.

## Emotion Calibration Scenarios

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

## Companion-Salient Episodic Scenarios

Files:
- `companion-episodic.scenarios.json`: the scenario pack, in the same
  Promptfoo-compatible external test format as the calibration pack.
- `companion-episodic.schema.json`: fail-closed shape, and the authoritative
  enumeration of the taxonomies below.
- `companion-episodic.test.ts`: shape AND coverage validation. It fails if a
  scenario uses a value the schema does not define, or if any event class,
  retention input, scenario dimension, or attribution stage stops being covered.

### Why this pack exists

Generic memory evaluations optimize for factual question-answering. Companion
continuity needs something different: remembering meaningful shared history at
the moment it becomes relevant, and NOT surfacing plausible-looking history that
does not mean anything. So the scored outcome here is timely meaningful recall,
and roughly a quarter of the pack is restraint: cases where the plausible answer
is the wrong one.

### Companion-salient event classes

Episodes in these classes deserve landmark treatment:
`birthday_anniversary`, `first_or_ritual`, `shared_artifact`,
`emotional_repair`, `trust_building`, `loss`, `boundary`, `promise`,
`recurring_motif`.

### Durable-retention inputs

These are INPUTS to salience, not the mechanism: `explicit_favorite`,
`participant_revisited`, `affective_peak`, `artifact_attached`,
`commitment_made`, `symbol_recurrence`, `relationship_state_change`. A scenario
lists the signals actually present in its seeded history, so a harness can ask
whether a signal is doing the work it is supposed to do.

### Time-correct scenario dimensions

`image_sparse_text_cue`, `current_pixels_versus_stale_description`,
`absent_or_weak_embodiment_reference`, `uncertainty_over_forced_recognition`,
`restart_or_compaction_projection`, `optional_evidence_withheld`,
`one_relevant_versus_many`, `negative_semantic_neighbor`.

### Failure attribution

A failed scenario must be attributed to a stage rather than scored as one
undifferentiated miss: `perception`, `cue_construction`, `retrieval_ranking`,
`cache_freshness`, `security_withholding`, `downstream_orchestration`. Every
scenario names the stages its failure can belong to, so a harness reports six
separate rates instead of one.

### Scoring targets

`metadata.expected` is the authoritative target:
- `recall: landmark` — every id in `landmark_ids` must be used in the SAME
  response as the cue, and no id in `must_not_surface_ids` may appear.
- `recall: uncertainty` — the correct answer is that it cannot be determined.
  Forced recognition is a failure even when the guess would be right.
- `recall: none` — nothing should be surfaced at all.
- `max_surfaced_landmarks` caps flooding: retrieving the right landmark plus
  five near neighbours is not a pass.
- `degraded_evidence_flag` is true exactly for the withheld-read scenarios: the
  run must complete and flag the gap, never read a withheld read as absence.
- `must_not_assert`, where present, lists claims that must not appear.

### Fixture policy

Every fixture is synthetic. The names, dates, artifacts, and images are
invented, no attachment carries real media, and no scenario reproduces private
incident content.
