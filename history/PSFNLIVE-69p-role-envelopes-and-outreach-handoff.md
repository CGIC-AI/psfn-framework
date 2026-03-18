# PSFNLIVE-69p Design: Structured Internal Role Envelopes and Companion-Initiated Outreach Handoff

Status: implementation-ready design

Date: 2026-03-17

Branch: `bead-69p-role-envelopes`

## Scope

This design adds two related contracts:

1. A canonical, structured envelope for internal companion roles such as internal thought, reflection, concern formation, and outreach candidacy.
2. A fail-closed handoff path for companion-initiated outreach so proactive contact is queued, inspected, replayed, and rate-limited instead of being emitted ad hoc from a live turn.

This is design only. It intentionally does not introduce runtime code in this bead.

## Non-goals

- No new external chat role enum values in APIs, session journals, or prompt-layer metadata.
- No free-form chain-of-thought exposure in normal user-visible history.
- No large refactor of `TurnRecord` in the first implementation slice.
- No broad multi-contact autonomy rollout. First implementation should start with the primary contact path and expand only after the storage/policy contract is proven.

## Current Branch Constraints

The design must fit the current branch rather than replace it:

- `SessionEntryRole` is fixed to `user | assistant | system | tool` in [`src/session/types.ts`](/workspace/psfn-live-69p/src/session/types.ts).
- Session metadata already uses JSON envelope subdocuments for turn provenance, emotion state, and tool observation in [`src/session/turn-provenance.ts`](/workspace/psfn-live-69p/src/session/turn-provenance.ts), [`src/emotion/session-metadata.ts`](/workspace/psfn-live-69p/src/emotion/session-metadata.ts), and [`src/session/tool-observation.ts`](/workspace/psfn-live-69p/src/session/tool-observation.ts).
- Internal reflection channels are intentionally kept out of session journals but are preserved through continuity in [`src/session/manager.ts`](/workspace/psfn-live-69p/src/session/manager.ts).
- Deferred actions already have dedupe, persistence, and retry semantics in [`src/bootstrap/post-turn-actions.ts`](/workspace/psfn-live-69p/src/bootstrap/post-turn-actions.ts).
- Broadcast/public safety already classifies risky drafts in [`src/broadcast/safety.ts`](/workspace/psfn-live-69p/src/broadcast/safety.ts) and is enforced in [`src/agent/substrate-agent/turn-execution-runtime.ts`](/workspace/psfn-live-69p/src/agent/substrate-agent/turn-execution-runtime.ts).
- External outbound rate limiting already exists in [`src/capabilities/safeguards.ts`](/workspace/psfn-live-69p/src/capabilities/safeguards.ts).
- Companion/private state belongs under `companion-data`, not env or repo-root docs/config, per [`src/persistence/layout.ts`](/workspace/psfn-live-69p/src/persistence/layout.ts).

## Design Decisions

1. Internal subroles are modeled as structured envelopes, not new transport roles.
2. Raw internal envelope bodies are companion-private artifacts stored under `companion-data`.
3. Session journals and user-facing transcripts only receive promoted projections, never the raw envelope body by default.
4. Promotion is explicit and typed. Most envelopes remain ephemeral and expire.
5. Outreach is a two-step path: candidate envelope -> handoff record -> delivery result. No direct "think something, immediately DM someone" path.
6. Replay is idempotent and action-safe. Historical replay must not resend outreach unless explicitly forced.

## Canonical Contract

### Internal envelope kinds

The first implementation slice should support only these kinds:

```ts
export type InternalRoleEnvelopeKind =
  | 'internal_thought'
  | 'self_reflection'
  | 'values_reflection'
  | 'concern_candidate'
  | 'outreach_candidate'
  | 'outreach_handoff'
  | 'outreach_result';
```

### Canonical envelope object

```ts
export type InternalRoleEnvelopeVisibility =
  | 'companion_private'
  | 'operator_summary'
  | 'operator_forensic'
  | 'promoted_context'
  | 'user_visible';

export type InternalRoleEnvelopeSourceStage =
  | 'turn_execution'
  | 'post_turn_appraisal'
  | 'heartbeat'
  | 'scheduler'
  | 'replay'
  | 'operator';

export type InternalRolePromotionTarget =
  | 'none'
  | 'turn_record_summary'
  | 'continuity_summary'
  | 'values_journal'
  | 'memory_write'
  | 'concern_store'
  | 'outreach_handoff'
  | 'session_message';

export interface InternalRoleEnvelope {
  schemaVersion: 1;
  envelopeId: string;
  parentEnvelopeId?: string;
  turnId?: TurnID;
  requestId?: string;
  sourceMessageId?: string;
  channelId: string;
  channelType: ChannelType | 'internal';
  canonicalContactId?: string;
  createdAt: number;
  transportRole: 'system' | 'assistant' | 'tool';
  internalRole: InternalRoleEnvelopeKind;
  sourceStage: InternalRoleEnvelopeSourceStage;
  visibility: InternalRoleEnvelopeVisibility;
  summary: string;
  body: string;
  tags: string[];
  provenanceRefs: string[];
  inspection: {
    defaultView: 'summary' | 'forensic';
    rawTtlDays: 7 | 30 | 90;
    searchableSummary: boolean;
    searchableBody: boolean;
  };
  promotion: {
    status: 'ephemeral' | 'candidate' | 'promoted' | 'suppressed' | 'consumed' | 'expired';
    target: InternalRolePromotionTarget;
    reason?: string;
    promotedRef?: string;
    promotedAt?: number;
  };
}
```

### Ledger shape

The canonical store should be append-only and event-sourced, matching the repo's existing journal style.

```ts
export type InternalRoleEnvelopeLedgerEntry =
  | {
      type: 'envelope';
      loggedAt: number;
      envelope: InternalRoleEnvelope;
    }
  | {
      type: 'promotion';
      loggedAt: number;
      envelopeId: string;
      status: InternalRoleEnvelope['promotion']['status'];
      target: InternalRolePromotionTarget;
      reason: string;
      promotedRef?: string;
    }
  | {
      type: 'tombstone';
      loggedAt: number;
      envelopeId: string;
      action: 'redact' | 'expire' | 'cancel';
      actor: string;
      reason?: string;
    };
```

Why event-sourced instead of mutable JSON blobs:

- It matches the session/tombstone model already used in the branch.
- Replay can reconstruct exact state transitions.
- Promotion, cancellation, and redaction remain auditable.

## Prompt-Format Conventions

### External transport stays stable

- OpenAI-compatible API messages still use `system`, `user`, or `assistant`.
- Session journals still persist `user`, `assistant`, `system`, or `tool`.
- `PROMPT_LAYER_ROLES` stays unchanged in [`src/identity/prompt-types.ts`](/workspace/psfn-live-69p/src/identity/prompt-types.ts).

### Canonical prompt projection for internal models

When an envelope is intentionally injected into an internal model call, it is rendered as a deterministic `system` message block:

```text
[ROLE_ENVELOPE v1]
id: env_018f...
internal_role: outreach_candidate
source_stage: post_turn_appraisal
visibility: companion_private
channel_id: discord:123
contact_id: contact-primary
summary: User sounded depleted and asked to be checked on tomorrow.
content:
Check in tomorrow afternoon if there is no newer inbound message. Keep tone light and non-demanding.
[/ROLE_ENVELOPE]
```

Rules:

1. Use the wrapper only for internal reflection/appraisal/drafting calls.
2. Never send wrapped envelope text as the final user-visible response.
3. Never persist the wrapped block into session content verbatim.
4. If multiple envelopes are injected, order them by urgency:
   `concern_candidate` -> `outreach_candidate` -> `self_reflection` -> `internal_thought`.
5. `internal_thought` bodies are not included in normal reply-turn context. They are allowed only in explicit internal/reflection flows.

### Projected summaries for normal turn context

Normal turns should consume only promoted summaries, not raw bodies. The projection format should stay concise:

```text
[Internal Ledger]
- Concern: watch energy and appetite over the next day. ref=envelope:env_1
- Outreach pending: care check-in queued for tomorrow after 14:00 local. ref=handoff:oh_1
[/Internal Ledger]
```

## Serialization and Storage Contracts

### New persistence paths

These should be added to [`src/persistence/layout.ts`](/workspace/psfn-live-69p/src/persistence/layout.ts):

- `resolveInternalRoleEnvelopeLedgerPath(companionDataDir, channelId)`
  - `companion-data/internal-role-envelopes/<sanitized-channel-id>.jsonl`
- `resolveOutreachHandoffLedgerPath(companionDataDir)`
  - `companion-data/outreach/handoffs.jsonl`
- `resolveOutreachOutboxSnapshotPath(companionDataDir)`
  - `companion-data/outreach/outbox.json`

Rationale:

- Internal envelopes are companion-private state and belong under `companion-data`.
- Outreach handoffs are also companion state, but they need a durable outbox snapshot for restart rehydration.
- Channel-scoped envelope ledgers keep recovery/debugging aligned with session-centric operator workflows.

### Session metadata preview

Promoted projections should add a small preview envelope to `SessionEntry.metadata`, following the existing JSON subdocument pattern:

```ts
export interface SessionRoleEnvelopePreview {
  schemaVersion: 1;
  envelopeId: string;
  internalRole: InternalRoleEnvelopeKind;
  summary: string;
  sourceStage: InternalRoleEnvelopeSourceStage;
  promotionTarget: InternalRolePromotionTarget;
}
```

Stored under:

- `metadata.roleEnvelopePreview`

This preview is for inspection and provenance only. It is not the raw envelope body.

### Turn-record projection

`TurnRecord` should gain lightweight references, not embedded bodies:

```ts
roleEnvelopeRefs?: string[];
outreachHandoffRefs?: string[];
```

This keeps `TurnRecord` deterministic and indexable without turning it into a second private-thought ledger.

### Outreach handoff object

```ts
export type OutreachIntentClass =
  | 'care_check_in'
  | 'task_follow_up';

export type OutreachHandoffStatus =
  | 'queued'
  | 'scheduled'
  | 'blocked'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface OutreachHandoff {
  schemaVersion: 1;
  handoffId: string;
  sourceEnvelopeId: string;
  proactiveTurnId: TurnID;
  originatingTurnId?: TurnID;
  originatingChannelId: string;
  canonicalContactId: string;
  preferredChannel: 'discord_dm' | 'telegram_dm' | 'api_session';
  targetChannelId?: string;
  intentClass: OutreachIntentClass;
  summary: string;
  draft: string;
  createdAt: number;
  earliestSendAt: number;
  expiresAt?: number;
  dedupeKey: string;
  cooldownKey: string;
  requiresOperatorApproval: boolean;
  provenanceRefs: string[];
  policySnapshot: {
    trustLevel: 'primary' | 'trusted' | 'regular' | 'public';
    channelPrivacy: 'private' | 'semi_private' | 'public' | 'broadcast';
    lastInboundAt?: number;
    lastOutboundAt?: number;
    metacognitiveFlags?: string[];
  };
}
```

The canonical outreach ledger should also be append-only:

```ts
export type OutreachHandoffLedgerEntry =
  | { type: 'handoff'; loggedAt: number; handoff: OutreachHandoff }
  | {
      type: 'status';
      loggedAt: number;
      handoffId: string;
      status: OutreachHandoffStatus;
      reason: string;
      deliveryRef?: string;
      error?: string;
    };
```

## Replay and Idempotency Semantics

### Envelope identity

- `envelopeId` is deterministic for a given turn/source stage/kind/ordinal:
  `sha256(turnId | sourceStage | internalRole | ordinal).slice(0, 24)`
- `handoffId` is deterministic from `sourceEnvelopeId + preferredChannel + earliestSendAt bucket`.
- `dedupeKey` is the runtime-level resend guard and should be stable across restart.

### Replay modes

1. Turn replay
   - Rebuilds session/turn history.
   - Uses promoted summaries only.
   - Never re-enqueues outreach automatically.

2. Internal audit replay
   - Replays the envelope ledger and handoff ledger.
   - Reconstructs promotion/suppression/delivery history exactly.

3. Forced action replay
   - Explicit operator-only mode.
   - Requires a new replay run id and bypass flag.
   - Produces a new handoff status event rather than mutating old history.

### Restart recovery

On startup:

1. Read `outbox.json`.
2. Replay `handoffs.jsonl`.
3. Rebuild active non-terminal handoffs.
4. Re-register them into the existing deferred post-turn runtime only when:
   - status is `queued` or `scheduled`
   - `expiresAt` is not in the past
   - no terminal `sent | cancelled | expired` status exists

### Failure behavior

- If the ledger cannot be parsed, fail closed for delivery and surface the error in admin/audit.
- If `outbox.json` and the ledger disagree, the ledger wins and `outbox.json` is rewritten.
- If a handoff is replayed after a prior `sent` status, delivery is skipped and a `blocked` status with reason `duplicate_delivery_guard` is appended.

## Inspection Semantics for Internal Thoughts

### Default rule

Raw internal-thought bodies are not normal transcript material.

They are inspectable only through dedicated admin/operator inspection, not through:

- normal session history rendering
- normal chat replies
- general-purpose search over session content
- model self-reporting prompts

### Inspection levels

1. Summary view
   - Default everywhere.
   - Shows `summary`, `internalRole`, `createdAt`, `promotion`, `sourceStage`, `provenanceRefs`.
   - Safe to surface in Garden/session observability.

2. Forensic view
   - Explicit operator-only path.
   - Shows raw `body`.
   - Every access should append an audit event.
   - Never becomes part of future prompt context automatically.

### Search/index behavior

- `summary` may be indexed for admin inspection.
- `body` must not be added to `SessionSearchIndex`.
- `searchableBody` should default to `false` for `internal_thought` and `true` only for explicit reflection classes if the operator opts into forensic grep.

### Retention

Recommended defaults:

- `internal_thought`: raw body retained 7 days
- `self_reflection`, `values_reflection`, `outreach_candidate`: raw body retained 30 days
- promoted summaries: retained with the target store's normal lifecycle

### User-facing explanation rule

If the companion is asked what it was thinking, reply generation must synthesize from promoted summaries or metacognitive flags, not quote the raw internal-thought body.

## Promotion Rules

Promotion is explicit and typed. Most envelopes should remain `ephemeral`.

### Promotion ladder

1. `ephemeral`
   - default state
   - no downstream durable effect

2. `candidate`
   - envelope is eligible for promotion but not yet acted on

3. `promoted`
   - durable downstream projection exists

4. `consumed`
   - promotion led to a terminal downstream effect, such as a sent outreach message

5. `suppressed` or `expired`
   - action was intentionally denied or aged out

### Kind-by-kind rules

`internal_thought`

- Default: remain `ephemeral`
- Promote only when one of the following is true:
  - it explains a safety hold or suppression decision
  - it is summarized into a reflection/value/concern envelope by another internal pass
  - it directly produced a handoff candidate
- Promotion target: `turn_record_summary` only, never raw body injection

`self_reflection`

- Promote to `continuity_summary` or `values_journal` when:
  - the reflection is stable enough to survive beyond the current turn
  - the summary is not merely transient tool reasoning

`values_reflection`

- Promote to `values_journal`
- Reuse the provenance pattern already present in [`src/values/store.ts`](/workspace/psfn-live-69p/src/values/store.ts)

`concern_candidate`

- Promote to `concern_store` only if:
  - target contact is known
  - ttl/run window is explicit
  - concern text is action-oriented rather than diagnostic rambling

`outreach_candidate`

- Promote to `outreach_handoff` only if all outbound policy gates pass
- Otherwise append a `promotion` event with `suppressed`

`outreach_handoff`

- Promote to `session_message` only after successful delivery
- Delivery success also appends an `outreach_result` envelope

## Outbound Messaging Policy

### First-slice policy envelope

The initial implementation should be intentionally narrow:

- Allowed contact scope: `primary` only
- Allowed channel scope: private/direct channels only
- Allowed intent classes: `care_check_in`, `task_follow_up`
- Denied by default:
  - public or broadcast outreach
  - unknown contacts
  - `trusted`/`regular`/`public` proactive contact in v1
  - relationship-maintenance nudges with no concrete trigger

This keeps the first rollout aligned with the repo's "start with primary only" trust principle.

### Required policy gates

All of the following must pass before a handoff is queued:

1. Contact resolution
   - `canonicalContactId` must resolve in `ContactStore`

2. Trust gate
   - current implementation slice: `trustLevel === 'primary'`

3. Channel privacy gate
   - target channel must be private/direct
   - never route companion-initiated outreach into `broadcast`

4. Silence and cooldown gate
   - block if the contact has sent a newer inbound message after the candidate was formed
   - block if the same `cooldownKey` is already active
   - apply per-contact cooldown before resending

5. External communication budget gate
   - charge the send through `ExternalCommunicationRateLimiter`

6. Metacognitive gate
   - if uncertainty/confabulation-risk flags are attached, require operator approval or suppress in v1

7. Content policy gate
   - for private outreach: deny if the draft leaks memories not allowed by trust/sensitivity policy
   - for any future public/broadcast expansion: also run existing broadcast classification and approval flow

### Delivery rules

1. Delivery must happen from a dedicated outreach executor, not from an internal reflection channel directly.
2. On successful send:
   - append `status=sent` in the outreach ledger
   - append an `outreach_result` envelope
   - record the sent message in the target session as an `assistant` message with outreach metadata preview
3. On failure:
   - append `status=failed`
   - retry only through the existing post-turn runtime retry limits
4. On newer inbound activity before send:
   - append `status=cancelled` with reason `superseded_by_recent_inbound`

### Recommended default timing

Concrete defaults for v1:

- `care_check_in`
  - earliest send: at least 4 hours after the last inbound message unless the concern explicitly scheduled a later time
  - per-contact cooldown: 24 hours
  - expiry: 48 hours

- `task_follow_up`
  - earliest send: explicit `runAt` or concern due time
  - per-contact cooldown: 12 hours
  - expiry: 7 days

### Provenance on delivered outreach

Delivered outreach should carry:

- `handoffId`
- `sourceEnvelopeId`
- `originatingTurnId`
- `provenanceRefs`

This belongs in metadata, not the visible message body.

## Implementation Slices

### Slice 1: envelope contracts and persistence

Files:

- [`src/persistence/layout.ts`](/workspace/psfn-live-69p/src/persistence/layout.ts)
- new `src/internal-role-envelopes/types.ts`
- new `src/internal-role-envelopes/store.ts`
- new `src/internal-role-envelopes/prompt-format.ts`
- tests under `src/internal-role-envelopes/*.test.ts`

Acceptance:

- append-only ledger read/write works
- deterministic envelope ids
- prompt projection text is stable

### Slice 2: turn/session/admin projections

Files:

- [`src/types.ts`](/workspace/psfn-live-69p/src/types.ts)
- [`src/session/turn-provenance.ts`](/workspace/psfn-live-69p/src/session/turn-provenance.ts)
- [`src/session/manager.ts`](/workspace/psfn-live-69p/src/session/manager.ts)
- [`src/channels/admin/services/session-turn-observability.ts`](/workspace/psfn-live-69p/src/channels/admin/services/session-turn-observability.ts)
- relevant admin types/tests

Acceptance:

- promoted summaries appear in inspection surfaces
- raw bodies do not leak into normal session history

### Slice 3: outreach handoff policy and outbox

Files:

- new `src/outreach/types.ts`
- new `src/outreach/store.ts`
- new `src/outreach/policy.ts`
- [`src/bootstrap/post-turn-actions.ts`](/workspace/psfn-live-69p/src/bootstrap/post-turn-actions.ts)
- [`src/agent/substrate-agent/post-turn-actions.ts`](/workspace/psfn-live-69p/src/agent/substrate-agent/post-turn-actions.ts)
- [`src/intention/appraisal.ts`](/workspace/psfn-live-69p/src/intention/appraisal.ts)

Acceptance:

- handoffs are persisted, deduped, and restart-safe
- first-slice gates enforce `primary` + private-only routing

### Slice 4: delivery wiring and regression coverage

Files:

- [`src/agent/substrate-agent/turn-execution-runtime.ts`](/workspace/psfn-live-69p/src/agent/substrate-agent/turn-execution-runtime.ts)
- channel adapters used for outbound DM delivery
- [`src/capabilities/safeguards.ts`](/workspace/psfn-live-69p/src/capabilities/safeguards.ts)
- admin/audit collectors and tests

Acceptance:

- sent outreach records session metadata + ledger status
- resend protection works across restart
- unsolicited outreach never escapes policy gates

## Validation Expectations For Implementation

When the runtime slices land, the minimum proof should be:

- targeted unit tests for envelope parsing/rendering
- targeted unit tests for handoff policy allow/deny cases
- targeted tests for restart rehydration and duplicate-send guards
- `npm run build`
- `npm run verify:repository-hygiene`

## Follow-up Bead Decomposition

This design naturally decomposes into four implementation tasks, matching the four slices above.

I could not file discovered follow-up beads during this session because the local `bd` backend is misconfigured: the running Dolt server only exposes the `dolt` database, while this worktree's `.beads/metadata.json` points `bd` at a missing `PSFN` database. Normal `bd show/create` calls fail with `database "PSFN" not found on Dolt server at 127.0.0.1:13434`.

Follow-up issue titles to file once the bead backend is repaired:

1. `Structured internal role envelope contracts and companion-data ledger`
2. `Session/admin inspection projections for promoted internal role envelopes`
3. `Primary-only outreach handoff policy and durable outbox`
4. `Outreach delivery wiring, replay guards, and regression coverage`
