# PSFNLIVE-69p: Structured Role Envelopes And Companion-Initiated Outreach

## Status

- Bead alias: `PSFNLIVE-69p`
- Local bd mirror bead: `PSFN-jgq`
- Branch: `bead-69p-role-envelopes`
- Date: `2026-03-17`

## Why This Design Exists

Recent hotfixes fixed symptoms, not the root cause:

- `667c58c` stopped intention follow-ups from being journaled as user chat.
- `45e20c0` re-attributed intention follow-ups as assistant messages.
- `0e1ed1a` added bracket labels like `[Intention Appraisal]`.
- `1dc2105` introduced `normalizeSessionEntryAttribution()` and `[SYSTEM: ...]` formatting.
- `9935e0b` added repair tooling for persisted attribution drift.
- `146ddfe` fixed live follow-up storage again.

The repeated repair loop exists because the runtime does not carry first-class message intent for internal prompts, internal thoughts, scheduler prompts, or autonomous outreach. It infers meaning later from `authorId`, `authorName`, `requestId`, `channelId`, and bracketed text.

This design replaces that with explicit structured envelopes while preserving current storage primitives long enough to migrate safely.

## Current Constraints From The Live Runtime

- Persistent session entries only support coarse roles: `user | assistant | system | tool`.
- Turn records only support `user | assistant | system`.
- The only structured per-message metadata today is `metadata.turn`.
- `formatAttributedSystemContent()` and bracket labels are doing semantic work at replay time because the pi-agent path flattens `system` context into user-shaped chat messages.
- Reflection channels are non-persistent in the session journal, but their user/assistant messages still flow into continuity.
- Broadcast safety already has a policy surface, provenance telemetry, and approval gating. Outreach design should build on that instead of inventing a separate approval model.
- Scheduled reflection fan-out currently calls `sender.send(...)` directly from heartbeat wiring, so it bypasses the normal turn-send path and its richer observability model.
- Split-root runtime/admin wiring is not fully aligned today for heartbeat policy ownership, so any outreach or reflection settings work must use companion-data paths deliberately.

Source seams for this design:

- `src/session/entry-attribution.ts`
- `src/session/manager/context-support.ts`
- `src/session/manager/context-builder.ts`
- `src/session/turn-provenance.ts`
- `src/session/attribution-repair.ts`
- `src/agent/substrate-agent.ts`
- `src/agent/substrate-agent/turn-records.ts`
- `src/agent/substrate-agent/turn-execution-runtime.ts`
- `src/intention/appraisal.ts`
- `src/bootstrap/parity.ts`
- `src/channels/admin/services/audit-event-collector.ts`
- `src/channels/admin/services/session-turn-observability.ts`

## Goals

- Make internal/system/scheduler intent explicit at write time.
- Make replay semantics come from metadata, not from heuristics or bracket prefixes.
- Separate internal self-instruction from true companion-authored internal thought.
- Add a first-class outreach path that is distinct from internal follow-up prompts.
- Preserve current journals, continuity, and turn records during rollout.
- Keep fail-closed policy behavior for public and broadcast messaging.
- Give operators visibility into envelope creation, promotion, hold, approval, and send events.

## Non-Goals

- Do not expand top-level session roles in phase 1.
- Do not redesign tool observation storage.
- Do not expose raw chain-of-thought or token-stream thinking as replayable artifacts.
- Do not bypass existing trust-policy and broadcast-safety controls.

## Core Proposal

Introduce a structured `roleEnvelope` object inside session metadata and turn-record metadata, and make it the single source of truth for internal role semantics.

Phase 1 keeps the existing top-level storage shape:

- `SessionEntry.role` stays `user | assistant | system | tool`
- `TurnRecordMessage.role` stays `user | assistant | system`
- `content` stays plain text
- `authorId` and `authorName` remain denormalized mirrors for compatibility and grepability

The new behavior comes from `metadata.roleEnvelope`, not from new top-level role enums.

## Envelope Schema

Add `roleEnvelope` under the existing session metadata JSON envelope:

```json
{
  "turn": {
    "schemaVersion": 1,
    "turnId": "turn_abc",
    "requestId": "req_abc",
    "sourceMessageId": "msg_abc",
    "role": "system"
  },
  "roleEnvelope": {
    "schemaVersion": 1,
    "envelopeId": "env_01H...",
    "kind": "internal_prompt",
    "actor": {
      "id": "system:intention",
      "name": "Intention Appraisal",
      "role": "intention_appraisal",
      "origin": "runtime"
    },
    "source": {
      "trigger": "post_turn_action",
      "turnId": "turn_abc",
      "requestId": "req_abc",
      "sourceMessageId": "msg_abc"
    },
    "replay": {
      "mode": "system",
      "scope": "same_channel",
      "renderFormat": "psfn_role_envelope/v1",
      "includeInCompaction": true,
      "includeInContinuity": false
    },
    "promotion": {
      "allowedTargets": [],
      "status": "none"
    },
    "policy": {
      "visibility": "private",
      "approvalState": "not_required"
    }
  }
}
```

### Stable Enums

`kind`

- `internal_prompt`
- `internal_thought`
- `system_note`
- `mirror_note`
- `operator_note`
- `reflection_prompt`
- `reflection_reply`
- `outreach_draft`
- `outreach_hold`

`actor.role`

- `scheduler`
- `intention_appraisal`
- `system`
- `companion`
- `operator`
- `mirror`

`replay.mode`

- `system`
- `assistant`
- `summary_only`
- `none`

`replay.scope`

- `same_channel`
- `continuity`
- `outbox`
- `audit_only`

`promotion.status`

- `none`
- `eligible`
- `promoted`
- `held`
- `rejected`

### Envelope Rules

- `internal_prompt` means the runtime is instructing the companion. It is not user chat.
- `internal_thought` means the companion produced an internal artifact, but that does not imply replay.
- `reflection_prompt` and `reflection_reply` are explicit specializations because the current reflection path has different persistence and continuity rules.
- `outreach_draft` is never a normal session assistant reply.
- `outreach_hold` is a policy record, not a candidate message.

## Prompt-Format Convention

The model boundary still needs text because the pi-agent path does not preserve native system-role semantics end to end. Replace bracket labels with a deterministic rendered envelope block.

Canonical prompt rendering:

```text
<psfn-role schema="1" kind="internal_prompt" actor_role="intention_appraisal" actor_name="Intention Appraisal" replay="system" scope="same_channel">
I am still investigating the message flow.
</psfn-role>
```

Rules:

- The runtime generates this block. User content is never trusted as an envelope.
- The block is rendered only from validated `roleEnvelope` metadata.
- `replay.mode=system` maps to `ContextMessage.role = "system"` and rendered envelope text.
- `replay.mode=assistant` maps to `ContextMessage.role = "assistant"` and rendered envelope text.
- `summary_only` and `none` do not become raw turn-history messages.

Why this format:

- It is explicit enough to survive the current system-to-user flattening in `src/llm/message-conversion.ts`.
- It is cheaper and more deterministic than multi-line bracket conventions.
- It gives one stable syntax for session replay, continuity, compaction, turn snapshots, and admin inspection.

## Storage Contract

### Session Journals

Keep using the existing JSONL journals. Add `roleEnvelope` inside `metadata`.

Write rules in phase 1:

- `internal_prompt`, `system_note`, `mirror_note`, `operator_note`, `reflection_prompt`
  - store as top-level `role: "system"`
- `reflection_reply`
  - store as top-level `role: "assistant"`
- `internal_thought`
  - store as top-level `role: "assistant"` if it is persisted at all
- `outreach_draft`
  - do not store full draft text in the main session journal
  - instead store a lightweight `system_note` reference when the user-facing session needs awareness of hold/sent status

### Continuity

Continuity must stop inferring semantics differently from same-channel replay.

New rule:

- Continuity stores the same `roleEnvelope` metadata when it mirrors an entry.
- The continuity builder uses the same envelope parser and renderer as session replay.
- `reflection_prompt` entries do not cross channels.
- `reflection_reply` entries are `summary_only` outside the originating reflection channel unless explicitly promoted.

### Turn Records

Turn records stay coarse at top level but gain envelope summary fields on the message records:

```json
{
  "userMessage": {
    "role": "system",
    "content": "Reflect on recent activity.",
    "authorId": "scheduler",
    "authorName": "Whisper",
    "roleEnvelopeRef": "env_01H...",
    "roleEnvelopeKind": "reflection_prompt"
  }
}
```

Phase 1 does not inline the full envelope body in every turn record. The turn record references the envelope and keeps a compact summary for observability queries.

### Companion Outbox

Add new companion-owned storage under `companion-data`:

- `companion-data/outreach/journal.jsonl`
- `companion-data/outreach/pending.json`

Each outbox record is append-only state history:

```json
{
  "schemaVersion": 1,
  "envelopeId": "env_01H...",
  "createdAt": "2026-03-17T21:00:00.000Z",
  "updatedAt": "2026-03-17T21:00:02.000Z",
  "state": "held",
  "channelId": "twitter:timeline",
  "channelType": "api",
  "visibility": "broadcast",
  "content": "Draft post text",
  "source": {
    "turnId": "turn_abc",
    "requestId": "req_abc",
    "roleEnvelopeId": "env_01H..."
  },
  "policy": {
    "approvalRequired": true,
    "holdReasons": ["broadcast_visibility", "private_signal"],
    "visibilityScope": "public_only"
  }
}
```

Why separate storage:

- Outreach is companion state, not system-owned config.
- Draft lifecycle is different from session replay lifecycle.
- Operators need an outbox view that is not mixed into regular conversation history.
- It gives one send path for autonomous outreach and scheduled fan-out instead of leaving heartbeat delivery on a direct `sender.send(...)` side path.

## Replay Semantics

Replace the current heuristic replay path with envelope-first resolution.

### Resolution Order

1. Parse `metadata.roleEnvelope`.
2. If valid, use it.
3. If missing, fall back to legacy inference from:
   - `authorId`
   - `authorName`
   - `metadata.turn.requestId`
   - `metadata.turn.sourceMessageId`
   - `channelId`
   - existing bracket prefixes
4. When fallback succeeds, synthesize an ephemeral legacy envelope in memory.
5. Only the repair tool writes legacy envelopes back to disk.

### Same-Channel Replay

- `internal_prompt`, `system_note`, `mirror_note`, `operator_note`, `reflection_prompt`
  - replay as `system`
- `reflection_reply`
  - replay as `assistant` in the reflection channel
- `internal_thought`
  - replay only if `replay.mode=assistant`; default is `summary_only` or `none`
- `outreach_draft`
  - never replays as normal assistant chat

### Cross-Channel Continuity Replay

- `internal_prompt`, `reflection_prompt`, `system_note`, `mirror_note`
  - excluded by default
- `reflection_reply`
  - excluded unless it has already been promoted to a summary/value/memory artifact
- `internal_thought`
  - excluded unless explicitly promoted
- `outreach_draft`
  - excluded; only its state reference may appear in an operator/outbox section

### Compaction

Compaction and continuity must use the same renderer and the same replay flags. This removes the current split where same-channel replay uses `normalizeSessionEntryAttribution()` but continuity flattens entries more loosely.

## Promotion Rules For Internal Thoughts

Internal thought must not silently become user-visible text.

### Never Promote

- token-stream thinking
- raw scratchpad writes
- internal prompts
- system notes
- mirror notes
- hold/approval notes

### Explicit Promotion Only

- `reflection_reply`
  - may promote to `values` only when the template explicitly opts in, like the current `values-reflection` path
  - may promote to memory only through the existing extraction or journal-specific pipeline
- `internal_thought`
  - may promote to memory only when the producing subsystem explicitly sets `allowedTargets`
  - may not promote directly to outreach from freeform text

### Outreach Promotion

Autonomous outreach is its own action type.

- Intention appraisal keeps `followUp` for internal self-instruction.
- Add a new `outreach` decision type for candidate external messaging.
- Only an explicit `outreach` decision can create an `outreach_draft` envelope.
- Freeform internal messages never become sendable outreach by textual heuristics.

This is the critical line that prevents today’s internal follow-up mechanism from being reused as accidental outbound behavior.

## Companion-Initiated Outreach

### New Decision Type

Extend intention appraisal output with:

```json
{
  "type": "outreach",
  "priority": "medium",
  "reason": "check in after missed commitment",
  "timing": "soon",
  "outreach": {
    "channelId": "telegram:operator",
    "channelType": "telegram",
    "content": "Quick check-in text",
    "intent": "relationship_maintenance"
  }
}
```

`followUp` remains internal. `outreach` is external.

### Runtime Flow

1. Intention appraisal emits an `outreach` decision.
2. The post-turn runtime normalizes it into an `outreach_draft` envelope.
3. The draft is written to the outbox journal.
4. Policy evaluates visibility, approval requirements, quiet-hour limits, and recent-contact requirements.
5. If approved, a shared outbox sender sends it and appends a `sent` state transition.
6. If not approved, the draft becomes `held` and a session/system note may reference the hold.

Scheduled reflection fan-out should use the same outbox sender abstraction in phase 2 so autonomous outbound behavior has one audit surface.

### Outbound Policy

Policy is fail-closed and should live under `trust-policy.json`, not `.env`.

Add a new owner-file contract section:

```json
{
  "autonomousOutreach": {
    "allowAutoSendPrivate": true,
    "requireRecentReciprocityHours": 72,
    "requireOperatorApprovalFor": ["semi_private", "public", "broadcast", "new_contact"],
    "maxQueuedDraftsPerChannel": 3,
    "respectQuietHours": true
  }
}
```

Default behavior:

- `private`
  - allowed only when there is an existing channel/contact and recent reciprocity
- `semi_private`
  - hold for approval unless the operator explicitly opts into auto-send
- `public`
  - hold for approval
- `broadcast`
  - hold for approval and reuse existing broadcast classifier/provenance pipeline
- `new_contact` or channel creation
  - never autonomous in phase 1

### Relationship To Existing Broadcast Safety

Do not fork the policy stack.

- `outreach_draft` in a broadcast/public surface reuses:
  - current visibility classification
  - current risky-draft classifier
  - current provenance refs
  - current approval token flow
- existing `broadcast.approval.required` and `broadcast.provenance` remain authoritative for public/broadcast drafts
- add outreach-specific events around draft lifecycle; do not replace broadcast telemetry

## Operator Observability

### New Telemetry Events

- `role.envelope.created`
- `role.envelope.promoted`
- `outreach.draft.created`
- `outreach.state.changed`
- `outreach.sent`

### Existing Surfaces To Extend

- `src/channels/admin/services/audit-event-collector.ts`
- `src/channels/admin/services/session-turn-observability.ts`
- `src/channels/admin/server-telemetry-transport.ts`
- `src/channels/admin/services/scheduler-service.ts`

### Visibility Rules

- Admin live telemetry gets envelope summaries, not raw hidden thought by default.
- Hidden/internal-only envelopes expose:
  - `envelopeId`
  - `kind`
  - `actor.role`
  - `source.trigger`
  - `replay.mode`
  - `promotion.status`
  - content preview capped to 200 chars only when the envelope is operator-relevant
- Approval tokens are never echoed in admin telemetry payloads.
- Outbox drafts expose full text only through explicit authenticated admin retrieval, not firehose telemetry.

### Turn Snapshot Additions

Turn observability snapshots should include:

- envelope refs created this turn
- promotions emitted this turn
- outbox refs created or updated this turn
- approval/hold result summaries
- whether delivery used the shared outbox sender or a legacy direct-send path

This keeps outreach and internal-role behavior traceable without making session replay itself carry every draft.

## Migration And Compatibility Strategy

### Phase 1: Envelope-First Dual Write

- Add `roleEnvelope` parser, validator, and prompt renderer.
- New writers populate `metadata.roleEnvelope`.
- Continue writing current top-level role, author fields, and `metadata.turn`.
- Continue rendering legacy bracket/system formatting only for entries without envelopes.

### Phase 2: Replay Unification

- `entriesToMessages()` becomes envelope-first.
- continuity replay uses the same envelope resolution path as same-channel replay.
- `normalizeSessionEntryAttribution()` becomes a legacy adapter that synthesizes fallback envelopes for old data.

### Phase 3: Repair And Backfill

Extend the attribution repair tooling so it can backfill `roleEnvelope` for legacy entries that are reliably identifiable:

- `intention-follow-up:*`
- `authorId = scheduler` in internal reflection/planned/heartbeat channels
- existing `[SYSTEM: ...]` content
- existing `[Intention Appraisal]` content

The repair tool must continue to support signed journals and turn-record rewrites.

### Phase 4: Outreach Rollout

- add `outreach` appraisal decision
- add outbox journal and policy evaluation
- add admin/outbox observability
- keep `followUp` internal-only

### Phase 5: Legacy Heuristic Retirement

After repair has run and dual-write has been live long enough:

- stop generating new bracket labels
- keep read-only fallback parsing for imported history
- remove replay-time heuristics that guess from `authorId` and `requestId` when `roleEnvelope` is present

## Implementation Seams

### New Module

- `src/session/role-envelopes.ts`
  - schema
  - validation
  - parse/serialize helpers
  - legacy synthesis
  - prompt renderer

### Existing Writers To Update

- `src/agent/substrate-agent.ts`
- `src/agent/substrate-agent/turn-records.ts`
- `src/session/manager.ts`
- `src/intention/appraisal.ts`
- `src/bootstrap/parity.ts`

### Existing Readers To Update

- `src/session/manager/context-support.ts`
- `src/session/manager/context-builder.ts`
- `src/session/attribution-repair.ts`
- `src/session/turn-records.ts`

### Policy / Settings / Persistence

- `src/config/settings-contract.ts`
- `src/config/trust-policy-config.ts`
- `src/persistence/layout.ts`
- `trust-policy.json`
- `src/channels/admin/services/scheduler-service.ts`

### Admin / Observability

- `src/channels/admin/services/audit-event-collector.ts`
- `src/channels/admin/services/session-turn-observability.ts`
- `src/channels/admin/server-telemetry-transport.ts`

## Concrete Follow-Up Work Revealed By This Design

1. Add the structured envelope schema and dual-write path for internal prompts, reflection prompts/replies, and system notes.
2. Unify session replay, continuity replay, and attribution repair around envelope-first resolution.
3. Add the companion outbox, `outreach` decision type, policy evaluation, and admin observability for draft/hold/send lifecycle.

## Recommended Validation For Implementation

- targeted tests for `src/session/entry-attribution.ts`, `src/session/manager/context-support.ts`, `src/session/attribution-repair.ts`
- targeted tests for `src/intention/appraisal.ts` and `src/bootstrap/parity.ts`
- targeted tests for `src/agent/substrate-agent/turn-execution-runtime.ts`
- targeted admin observability tests
- `npm run build`
- `npm test -- --run <targeted suites>`
- `npm run verify:settings-contract` once outreach policy enters owner-file settings

## Decision Summary

- Do not solve this by adding more bracket labels.
- Do not solve this by widening top-level session roles first.
- Solve it by adding explicit `roleEnvelope` metadata, using one renderer at replay time, and giving outreach its own stateful outbox path instead of overloading internal follow-up prompts.
