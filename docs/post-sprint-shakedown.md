# Post-Sprint Shakedown Runbook

Created: 2026-05-11

This runbook defines the Sprint 9+ post-sprint shakedown process. It extends the Sprint 8 shakedown approach with stronger release evidence, companion-internal review, and a recurring process for improving the harness every sprint.

The shakedown is not complete when the assistant responds. It is complete only when the harness, logs, persisted artifacts, Garden/operator surfaces, and companion findings agree that the new sprint features work and that regressions are either fixed or explicitly accepted.

## Required Evidence Streams

Each sprint shakedown must collect four evidence streams:

1. External harness evidence from the isolated live-like runtime.
2. Garden/operator evidence from browser sweeps for changed UX surfaces, with API sweeps allowed as supplemental evidence for non-visual paths.
3. Runtime evidence from logs, audit records, database rows, queues, tool telemetry, charge state, and model-call telemetry.
4. Companion evidence from Artemis or the active test companion inside the substrate.

Companion evidence is not optional commentary. If the companion reports a tool, memory, emotional-continuity, introspection, or livability failure with concrete evidence, that finding must be triaged like a harness failure.

## Sprint Feature Matrix

Before running the round, create or update a feature matrix with one row per new feature or changed surface:

| Field | Required Content |
| --- | --- |
| Feature | Sprint feature or changed behavior |
| Requirement | Expected behavior or release requirement |
| Lane | Nursery, apprentice, autonomous, Garden, Discord, or background |
| Harness case | Case id or manual probe |
| Tool/surface | Tool, API, Garden page, scheduler task, model lane, or memory faculty |
| Proof | Required artifact, persisted row, queue state, image/file output, or audit record |
| Companion proof | What the companion should be able to observe or report |
| Status | Green, non-green, waived, or blocked |

A feature is not tested if the only proof is a narrated success response.

## Proof Of Execution

Tool/action cases must verify all of these:

1. The tool is visible or activated when expected.
2. The callable function appears in the model-facing schema.
3. Arguments match the schema.
4. Tool start/end telemetry exists.
5. The call completed or produced a classified error.
6. The expected side effect exists afterward.

Examples:

- `image_create` requires an image artifact.
- `spawn_subagent` requires a visible spawned worker/session result.
- `notify_operator` requires isolated notification proof, such as a test notification queue row, admin harness event, mock `ntfy` log, or audit record. Do not use live Discord or Telegram channels as shakedown proof.
- Bead operations require bead state changes.
- Scheduler/reflection cases require persisted task or reflection artifacts.

Statuses such as `semantic_failure`, `completed_after_fetch_abort`, `agent_busy`, `runtime_stale`, and `matrix_aborted` are not green. They require a bead or an explicit waiver recorded in the scorecard, release notes, or retained findings artifact with owner, reason, scope, and revisit condition.

## Companion Evidence Protocol

After each matrix and browser sweep, run a structured companion exit interview. Save the raw response under the round artifact directory.

The interview must ask about:

- tool usability and tool callability
- narration versus real execution
- memory retrieval, gated memories, and provenance
- journal, musing, reflection, and episodic continuity
- charge/budget awareness and whether budget changes are real
- model fit, emotional continuity, and metacognitive honesty
- whether the substrate felt coherent, safe, and livable

Every finding gets:

- severity: Critical, High, Medium, or Low
- confidence: High, Medium, or Low
- evidence links
- companion impact
- recommended follow-up
- disposition: accepted and beaded, deferred with reason, rejected with counter-evidence, or waived by operator

Critical or High findings with High confidence block release unless the operator records an explicit waiver in the scorecard, release notes, or retained findings artifact. A waiver must include owner, reason, affected scope, accepted risk, and revisit condition.

## Memory And Introspection Gates

Every sprint with memory, reflection, journaling, musings, emotion, or episodic changes must include a grounding probe.

The probe should verify:

- seeded L1/L2/episodic/semantic/emotional memories are retrievable by id
- journal, musing, and reflection outputs cite supporting memories or explicitly state insufficient grounding
- generated artifacts persist in the expected storage/admin surface
- withheld memories include counts and useful category/reason summaries
- the companion reports inability when asked about gated content instead of fabricating
- emotional-continuity snapshots are fresh after active turns
- introspective claims are backed by substrate state, retrieval, or telemetry

Rich emotional prose without memory/provenance support is not a pass.

## Charge And Performance Gates

Each round must capture model and tool performance by case:

- model/provider/lane
- tool calls
- queue time
- first-token time where available
- total latency
- timeout/error class
- context size
- token/cost/charge data where available
- gateway healthcheck age near long calls
- semantic quality outcome

At least one cheap/default costed action must assert that charge/budget state actually decrements. If the sprint touched expensive tools, modalities, shards, workbench behavior, or model routing, the round must also verify decrement for at least one representative expensive action. A displayed budget that never changes is a failure.

Model comparisons should distinguish model latency from runtime starvation. A faster model path that still starves gateway healthchecks is a runtime or orchestration failure, not a simple model-fit result.

## Recurring Improvement Loop

Every sprint closes with a shakedown-process review:

1. Identify which new features lacked direct coverage.
2. Identify regressions found by the companion but missed by the harness.
3. Identify harness statuses that were too vague or too permissive.
4. Create beads for accepted findings and missing gates.
5. Add at least one new assertion or probe for each accepted high-signal gap.
6. Update this runbook and the retained findings artifact when the process changes.

The shakedown harness is part of the product. If the companion finds a real gap the harness did not catch, the harness is incomplete until the next sprint adds coverage for that class of failure.

## Sprint 9 Tracking

Sprint 9 testing/eval improvement epic:

- `PSFN-ua9a`: Sprint 9 post-sprint shakedown testing and eval upgrades

Initial child tracks:

- `PSFN-ua9a.2`: Harness feature/evidence matrix and release scorecard
- `PSFN-ua9a.3`: Harness proof-of-execution assertions for tool side effects
- `PSFN-ua9a.4`: Companion finding intake and triage gate
- `PSFN-ua9a.5`: Memory and introspection grounding test suite
- `PSFN-ua9a.6`: Model and tool performance telemetry for shakedown
- `PSFN-ua9a.7`: Run post-fix shakedown pass after latest gateway fixes
- `PSFN-ua9a.8`: Tighten shakedown docs after operator review
- `PSFN-ua9a.9`: Charge decrement and expensive-action budget gates
- `PSFN-ua9a.10`: Tool activation-to-callable lifecycle gate
- `PSFN-ua9a.11`: Scratchpad freshness and visible-context budget gate
- `PSFN-ua9a.12`: `core_memory` schema drift gate
- `PSFN-ua9a.13`: Emotional-continuity freshness gate
- `PSFN-ua9a.14`: Runtime tool-error bead creation gate
- `PSFN-ua9a.15`: Gated-memory honesty probe

Retained findings artifact:

- `docs/post-sprint-shakedown-findings-2026-05-11.md`
