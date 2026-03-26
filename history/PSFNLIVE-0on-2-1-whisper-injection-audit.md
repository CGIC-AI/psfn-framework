# PSFNLIVE-0on.2.1 Whisper Injection Audit

Scope: trace where intention whispers and follow-up concerns are created, stored, surfaced, re-injected, and where they can still take over foreground chat.

## Control Points

`ActiveConcernStore` is the durable store for intention concerns. It persists `resolved_at` and `resolution_outcome`, but `getActiveConcerns()` deliberately filters those rows out before the appraisal/runtime layers see them: [src/intention/concerns.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/concerns.ts:391) [src/intention/concerns.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/concerns.ts:457).

`IntentionAppraisal` normalizes either the explicit `activeConcerns` input or the current `InternalState.attention.activeConcerns`, then uses only that active set to decide whether to fire on emotion shift, due-soon concerns, or cadence. Its prompt payload contains the active concerns, recent messages, and internal state, but no resolved-concern history: [src/intention/appraisal.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/appraisal.ts:490) [src/intention/appraisal.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/appraisal.ts:1238) [src/intention/appraisal.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/appraisal.ts:1272).

The runtime context block surfaces `InternalState` attention/relational signals and then appends the active concern block if one exists. That means active concerns are intentionally promoted into the live prompt, while resolved concerns are not present to act as a brake against re-creation: [src/agent/substrate-agent/runtime-context.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/substrate-agent/runtime-context.ts:250) [src/agent/substrate-agent/runtime-context.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/substrate-agent/runtime-context.ts:322).

Intention follow-ups are injected as internal `whisper` messages and are explicitly not persisted into the external session journal. The conversion path labels them as note-to-self content before LLM conversion, so they become internal thought rather than user-visible history: [src/agent/substrate-agent.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/substrate-agent.ts:599) [src/agent/messages.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/messages.ts:115).

## Takeover Paths

The main foreground takeover path is concern surfacing. A concern can be created by appraisal, injected into active concern context on the next turn, and then re-trigger appraisal again when it is due soon or when cadence fires: [src/intention/runtime-wiring.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/runtime-wiring.ts:121) [src/intention/appraisal.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/appraisal.ts:532).

The second takeover path is whisper conversion. Once a follow-up is classified as an internal whisper, it is queued as a `whisper` message and can still occupy prompt space on later turns even though it never enters the session journal: [src/agent/substrate-agent.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/substrate-agent.ts:603) [src/agent/messages.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/messages.ts:142).

The third path is post-turn background delivery. Deferred continuations are tracked separately from intention concerns, but they still emit explicit background completion and post-turn delivery events that can follow the foreground turn boundary: [src/agent/substrate-agent/background-continuation-runtime.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/substrate-agent/background-continuation-runtime.ts:139).

## Test Coverage

The current tests already pin the important boundaries:

`src/intention/concerns.test.ts` proves resolved and expired concerns are excluded from the active list, and that concern resolution persists `resolvedAt` and `resolutionOutcome`: [src/intention/concerns.test.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/concerns.test.ts:97).

`src/intention/runtime-wiring.test.ts` proves appraisal hooks expose active concerns and persist concern decisions back into the store: [src/intention/runtime-wiring.test.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/runtime-wiring.test.ts:81).

`src/intention/appraisal.test.ts` proves active concerns are serialized into prompt payloads with prompt-friendly timestamps, and that appraisal fails closed on malformed output: [src/intention/appraisal.test.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/intention/appraisal.test.ts:220).

`src/session/manager.test.ts` proves internal reflection channels are not persisted to the session journal: [src/session/manager.test.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/session/manager.test.ts:430).

`src/agent/substrate-agent.test.ts` proves intention appraisal follow-ups are routed as internal whispers instead of persisted chat messages, and that background continuation delivery stays distinct from ordinary chat turns: [src/agent/substrate-agent.test.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/substrate-agent.test.ts:1176) [src/agent/substrate-agent.test.ts](/mnt/samesung/ai/psfn-live-mi-0on21/src/agent/substrate-agent.test.ts:4954).

## Gap

The current store and appraisal wiring retain resolved concern metadata, but the live evaluation path discards it before concern generation. That makes it easy for heartbeat or appraisal to recreate near-identical cleanup concerns after a resolution unless a future layer explicitly checks recent resolutions or similarity to recently closed items.

