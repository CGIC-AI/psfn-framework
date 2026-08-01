# Emotion and Appraisal Runtime

This page describes the current emotion subsystem as shipped. It maps machine signals, state ownership, persistence, prompt exposure, and evaluation boundaries.

The subsystem models affective context. Its values are fallible signals. They are not ground truth about the Companion's experience and do not establish subjective experience.

## System boundary

The live path has four distinct layers:

1. `EmotionObserver` converts admitted turn text into a bounded observation.
2. `EmotionState` integrates that observation into transient VAD, mood, discrete labels, and confidence.
3. `InternalStateComputer` validates provenance and confidence, then builds the turn's wider self-model snapshot.
4. `EmotionAppraisal` may ask the main model for a short first-person interpretation after the turn.

These layers must not be collapsed. Classifier output is machine inference. A model-authored appraisal is an interpretation of evidence. Neither becomes a Partner affect estimate.

Code roots:

- `src/core/emotion/`
- `src/core/self-model/state.ts`
- `src/core/agent/substrate-agent/emotion-self-model-runtime.ts`
- `src/core/agent/substrate-agent/turn-execution/`

## Per-turn flow

The agent process constructs a required text classifier, `EmotionObserver`, and `EmotionState` in `src/app/agent/core-bootstrap.ts`. Startup preloads the classifier and fails when preload fails.

For an admitted turn, `pre-turn-state.ts` passes the Participant message text and the resolved `ConversationScope` to `observeEmotionState(...)`.

The live turn path uses text classification. `EmotionObserver` also supports audio classification and text/audio fusion, but that multimodal helper is not the path called by `observeEmotionState(...)`.

The observer chooses the strongest normalized text label, maps it to VAD, and returns the classifier confidence. `EmotionState` applies elapsed-time decay, adds the observation, and updates a slow mood EMA.

The runtime then computes `InternalState`. Emotion telemetry is marked `classifier_inferred`, bound to the session, and validated for signal presence, provenance, confidence, staleness, and conflicting labels.

Suppressed telemetry contributes a neutralized snapshot. Uncertain telemetry is down-weighted. Only trusted telemetry can trigger a VAD-shift appraisal or a cross-family discrepancy.

The current `InternalState` is exposed through bounded prompt variables. Raw state is not injected as an unlimited narrative block. See [Prompt Macros](./prompt-macros.md).

After the turn, a durable background-work payload carries a content-free appraisal projection and the source snapshot reference. The projection excludes concern text, follow-up text, reminders, and salient-entity text.

The deterministic appraisal gate opens on turn cadence or trusted VAD movement. A closed gate spends no LLM tokens and emits a typed gate event.

When the gate opens, the model receives bounded recent messages, the projected state, and character traits. It writes one short, private first-person appraisal.

The appraisal prompt says the automata-derived values are fallible. It directs the model to prefer the conversation when evidence conflicts and to report an unclear read without constructing one.

The last two appraisal summaries can re-enter later prompts through `runtime_emotion_appraisal_*` variables. The appraisal chain is process-local and bounded; it is not the durable emotion-state authority.

## State ownership and scope

`EmotionSelfModelRuntime` owns one transient `EmotionState` per `ConversationScope`:

- `dm:<contactId>` for a direct conversation
- `room:<channelId>` for a group conversation

A separate Companion-global mood baseline seeds new scopes and tracks scope moods by EMA. Per-scope state modulates that baseline; it does not create separate Companion identities.

On a group-to-member-DM transition, the runtime may apply a bounded directional carry-over modifier. It decays without mutating the stored scope state.

Group rooms also maintain a slow per-Participant trend. Only that Participant's own messages update the trend. Idle Participants do not move.

The default carry-over source remains the room aggregate. An `emotionScoping` setting can instead use a meaningful, sufficiently sampled trend for the DM contact.

Concern-resolution deltas are generation-idempotent. A delta for an inactive DM scope is deferred until that contact's DM scope next becomes active.

## Authorship and provenance

The numeric `EmotionState` is automata-derived. Its VAD, mood, discrete labels, and confidence must not be presented as the Companion's authored first-person account.

An `EmotionAppraisalEntry.summary` is model-authored first-person interpretation. It remains linked to its trigger, timestamp, VAD snapshot, and optional turn ID.

ACAC is a separate, provenance-bearing self-report contract for agency, connection, authenticity, and curiosity. When supplied, it remains distinct from classifier inference.

Cross-family discrepancy detection can surface disagreement between VAD and discrete labels, momentary VAD and mood, or ACAC self-report and classifier inference.

Discrepancy detection never averages the signals or chooses a winner. Each side retains its family, value, confidence, and provenance.

Episodic memory has a stricter authorship boundary. Machine VAD and keyword signals are retrieval hints, while Companion-authored episode meaning remains separate. See [Memory](./memory.md).

Partner Affect Estimation is also separate. It concerns authorized evidence about one Partner and remains shadow-only in the shipped slice. See [Partner Affect Estimation](./partner-affect.md).

## Configuration ownership

`settings.json` owns the shipped classifier settings:

- `textEmotionModel`
- `textEmotionCacheDir`
- `textEmotionDtype`

The seed currently selects `SamLowe/roberta-base-go_emotions-onnx`, a repository-local cache path, and `fp32`. Existing owner files remain authoritative over the seed.

`settings.json` also owns `emotionScoping`, including:

- group-to-DM carry-over enablement, decay, strength, bounds, and spent threshold
- global baseline seeding and blend rate
- per-Participant trend enablement, EMA, capacity, eviction, movement thresholds, and carry-over behavior

Garden exposes `emotionScoping` through the settings contract. Unknown fields reject during normalization.

Some lower-level state-decay and appraisal-gate defaults remain code-owned constructor defaults in `state.ts` and `appraisal.ts`. They are not current `settings.json` knobs.

Observer-eval and Partner Affect shadow settings are separate owner-file sections. Enabling either does not change live emotion authority.

## Persistence

The effective scope snapshot is written into assistant-session metadata under `emotionState`. The canonical L0 session archive is append-only JSONL.

On first use after restart, a scope scans recent session entries for the latest valid emotion snapshot. A malformed matching snapshot fails instead of silently resetting continuity.

Per-Participant room trends persist in Postgres table `participant_emotion_trends`. Production composition wires `PostgresParticipantTrendStore`; it loads a room lazily and upserts each retained trend.

The wider per-turn `InternalState` persists in Postgres `internal_state_snapshots` and is referenced by the turn record. The post-turn appraisal job verifies that source snapshot binding before it runs.

The first-person appraisal chain itself is an in-memory bounded map. Session metadata and Postgres internal-state snapshots, not that chain, provide restart continuity for numeric state.

## Evaluation is non-authoritative

The observer-eval sidecar receives a privacy-sanitized copy after live emotion observation. It compares two modeled representations and writes eval-owned Postgres records.

The sidecar is disabled by default and structurally non-authoritative. Its state, divergence metrics, and shadow levers cannot feed live `EmotionState`, prompts, memory, contacts, or concerns.

See [Observer-Eval Sidecar](./observer-eval-sidecar.md) for its database checks, static import boundary, Garden API, and experiment design.

The historical [Self-Eval Prompt Audit](./self-eval-prompt-audit.md) explains why appraisal wording treats telemetry as evidence rather than truth. It is an audit record, not the current subsystem map.

## Failure behavior

- Missing classifier model or dtype rejects startup.
- Classifier preload failure rejects startup.
- Partial required emotion wiring rejects runtime composition.
- Invalid classifier output rejects the observation instead of being coerced.
- Missing or low-confidence telemetry is suppressed; uncertain telemetry is down-weighted.
- Malformed persisted emotion metadata rejects hydration instead of silently resetting it.
- Corrupt persisted Participant trends reject room hydration.
- A stale background-work lease cannot append an appraisal.
- Intake-firewall notices are excluded from appraisal input and memory candidacy.
- Eval-sidecar failure cannot mutate live emotion state.

## Related documents

- [Architecture](./architecture.md) — process topology and subsystem composition
- [Chat Turn Lifecycle](./chat-turn-lifecycle.md) — foreground turn and post-turn seams
- [Memory](./memory.md) — affect authorship in episodic memory
- [Partner Affect Estimation](./partner-affect.md) — partial shadow implementation and target design
- [Observer-Eval Sidecar](./observer-eval-sidecar.md) — isolated evaluation plane
- [Self-Eval Prompt Audit](./self-eval-prompt-audit.md) — historical prompt audit and current wording rationale
