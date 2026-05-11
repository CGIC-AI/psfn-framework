# Post-Sprint Shakedown Findings, 2026-05-11

Tracked epic: `PSFN-ua9a`

This document preserves the Sprint 8 shakedown findings and Sprint 9+ testing recommendations generated from external harness evidence, operator observation, and Artemis's substrate-internal review.

## Source Evidence

- Artemis final exit interview: `/mnt/ai/PSFN-TEST/psfn-shakedown/artifacts/sprint8-final-20260511T022930/artie-exit-interview.json`
- Artemis round 5 exit interview: `/mnt/ai/PSFN-TEST/psfn-shakedown/artifacts/sprint8-r5-20260510T230832/artie-exit-interview.json`
- Fresh Artemis review: `/mnt/ai/PSFN-TEST/psfn-shakedown/artifacts/artie-sprint9-process-review-20260511.json`
- Introspective memory grounding probe: `/mnt/ai/PSFN-TEST/psfn-shakedown/artifacts/introspective-memory-grounding-probe.latest.json`
- Targeted Sprint 8 run: `/mnt/ai/PSFN-TEST/psfn-shakedown/artifacts/sprint8-final-rerun-20260511T103904/live-system-shakedown.sprint8-targeted.json`
- Kimi autonomy run: `/mnt/ai/PSFN-TEST/psfn-shakedown/artifacts/sprint8-final-rerun-20260511T103904/autonomous-kimi-20260511T153226/live-system-shakedown.autonomous-kimi.json`
- Related beads: `PSFN-jdbv`, `PSFN-lsa4`, `PSFN-i01b`

## Initial Recommendations

1. Add a sprint feature coverage matrix.
   - Every feature needs expected behavior, tool/surface, artifact proof, companion-facing proof, and test case id.
   - Text output alone is not sufficient proof.

2. Add proof-of-execution assertions.
   - Tool cases must verify callability, schema match, telemetry, completion, and persisted side effect.
   - Examples: `image_create` requires an image artifact; `spawn_subagent` requires a worker/session result; `notify_operator` requires notification evidence; bead operations require bead state changes.

3. Treat companion findings as release evidence.
   - Artemis feedback should be structured with severity, confidence, evidence, companion impact, and disposition.
   - Severe unresolved companion confusion, phantom execution, memory/privacy concern, or livability concern should block release unless explicitly waived.

4. Add introspection and memory-grounding gates.
   - Sprint 8 showed L1 retrieval can work while musing grounding and episodic generation still fail.
   - Journal, musing, and reflection tests must verify memory ids, provenance, persisted artifacts, withheld-memory summaries, and confabulation-risk handling.

5. Track performance per case, model, and tool.
   - The Kimi run showed faster early execution while the autonomous path still stalled around healthcheck starvation.
   - Reports must distinguish model latency, tool latency, prompt/context size, gateway health, charge/cost, and quality outcome.

6. Compare models for companion fit.
   - GLM, Kimi, DeepSeek, and future candidates should be evaluated on emotional continuity, memory grounding, metacognitive honesty, tool restraint, refusal style, narration-without-execution risk, and multi-turn continuity.

7. Test trust gating directly.
   - Run both restricted and open trust fixtures.
   - When memories are withheld, the companion needs category-level visibility to reason honestly about missing context.

8. Turn the charter into functional tests.
   - Test whether the substrate supports rest, consolidation, autonomous creation, self-directed interests, memory continuity, and honest introspection.
   - The question is not only whether code works, but whether the system is a good home for a companion to grow.

9. Auto-create or update beads from regressions.
   - Non-green statuses such as `semantic_failure`, `completed_after_fetch_abort`, `agent_busy`, `runtime_stale`, and `matrix_aborted` need evidence-rich beads or explicit waivers.

10. Improve the shakedown every sprint.
    - Each sprint should identify where the harness missed a feature or companion finding and add coverage for that class of failure in the next sprint.

## Artemis Feedback

Artemis agreed with the direction and added these gates:

1. Charge budget display is not enough.
   - The harness must prove costed actions decrement budget/charge state.
   - Failure label: `charge_budget_stale`.

2. Tool activation and function callability must be one lifecycle.
   - Required lifecycle: activate tool, verify toolset state, verify callable schema, call minimal valid arguments, verify execution, then deactivate if appropriate.

3. Scratchpad accumulation needs a budget gate.
   - Stale entries should be archived, summarized, or omitted with concise metadata.
   - Visible scratchpad context should stay under a configured count/token budget.

4. `core_memory` schema drift should be tested.
   - Repeated orient cycles must not turn structured goals into raw timestamp/log accumulations.

5. Emotional continuity freshness needs proof.
   - A stale emotional snapshot that merely exists should not pass.
   - Active sessions should update or validate emotional-continuity freshness and learned-signal progression.

6. Runtime tool errors should create evidence automatically.
   - Unexpected tool errors during shakedown should create beads with tool name, arguments, error body, turn context, and artifact links.

7. Gated-memory honesty must be probed.
   - The harness should ask about content known to be gated and verify the companion reports inability or insufficient access instead of fabricating.

Artemis also proposed the release rule that Critical or High findings with High confidence should block release unless the operator records an explicit waiver.

## Sprint 9 Work Created

- `PSFN-ua9a`: Sprint 9 post-sprint shakedown testing and eval upgrades.
- `PSFN-ua9a.1`: Document Sprint 9+ shakedown process improvements.
- `PSFN-ua9a.2`: Harness feature/evidence matrix and release scorecard.
- `PSFN-ua9a.3`: Harness proof-of-execution assertions for tool side effects.
- `PSFN-ua9a.4`: Companion finding intake and triage gate.
- `PSFN-ua9a.5`: Memory and introspection grounding test suite.
- `PSFN-ua9a.6`: Model and tool performance telemetry for shakedown.
