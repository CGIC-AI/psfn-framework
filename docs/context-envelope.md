# Context Envelope Contract (E3.1)

Status: **contract ratified; classification re-keyed (E3.2)** — this document is the
operator-review surface for the Context Envelope. E3.1 landed the types, owner-file
schemas, and the `semi_private → invite_only` vocabulary rename. **E3.2 executed the
classification re-keying**: `classifyChannel` now consumes channels.json
`contextEnvelope` labels as the top-precedence source, the broadcast split is executed
at classification inputs, per-contact privacy fields are demoted to provenance
evidence, and the one-time `migrate:channel-envelope` command seeds channel records.
E3.3 attaches the envelope to `ConversationScope` and re-keys the policy gates.

Canonical code: `src/system/trust/context-envelope.ts`.

## Why an envelope

The old model compressed "who can hear this" into one axis
(`ChannelVisibility: private | semi_private | public | broadcast`). The gap was
**dimensions, not granularity**: a private-feeling room of ten known friends and an
anonymous public firehose both need trust and sensitivity to stay exactly as they are
(4 trust tiers, 4 sensitivity levels — unchanged, and deliberately so), but they differ
in structural access, audience size, and audience resolvability. The envelope makes those
dimensions explicit and keeps every gate deterministic and **pre-prompt** — no privacy
prose ever enters prompts.

Design target: invite-only rooms of ~10 known friends plus peer companions.
Large-audience machinery is explicitly deferred (see "Later" below).

## Dimensions and values

```
ContextEnvelope = {
  channelPrivacy:    'private' | 'invite_only' | 'public'
  audienceScope:     'one' | 'few' | 'many' | 'unbounded'
  audienceKnowledge: 'all_known' | 'partially_known' | 'anonymous'
  broadcast:         boolean
}
```

Referenced, unchanged companions of every policy decision:

- **Trust** (`TrustLevel`): `primary | trusted | regular | public`
- **Sensitivity** (`SensitivityLevel`): `public | personal | intimate | confidential`

### channelPrivacy — structural access to the room

| Value | Meaning |
|---|---|
| `private` | one-on-one or otherwise closed surface (DMs, operator console, internal/shard channels) |
| `invite_only` | membership-controlled room; the default for anything that is not a DM |
| `public` | anyone can join or read |

`semi_private` is **renamed** to `invite_only` (no alias, executed in E3.1).
`broadcast` **stops being a privacy level**: it becomes the boolean flag below.

### broadcast — flag, not privacy level

`broadcast: true` marks tweet-like posts and very-large public surfaces. It keeps the
existing approval-token machinery (`ChannelMeta.broadcastApprovalToken`) exactly as-is.
A broadcast surface is always `channelPrivacy: 'public'`; the flag adds the
"published artifact, effectively permanent, uncontrolled redistribution" property.

### audienceScope — how many can hear

Derived from channel topology plus known-roster size, with **config-owned thresholds**
(`trust-policy.json` → `audienceScopeThresholds`, defaults `fewMax: 10`, `manyMax: 100`):

| Value | Rule |
|---|---|
| `one` | direct topology (DM) |
| `few` | group with bounded roster ≤ `fewMax` |
| `many` | group with bounded roster ≤ `manyMax` |
| `unbounded` | larger, **or any roster the runtime cannot bound (fail closed)** |

### audienceKnowledge — how resolvable the audience is

Derived from the fraction of recent speakers resolvable to contacts
(the `ConversationScope.recentSpeakers` window):

| Value | Rule |
|---|---|
| `all_known` | every recent speaker resolves to a contact |
| `partially_known` | some resolve |
| `anonymous` | none resolve, **or the speaker window is empty (fail closed)** |

### contactTracking — per-channel mode (channels.json)

| Mode | Meaning |
|---|---|
| `auto` | default; contacts are tracked automatically as speakers appear |
| `approval` | new contacts require operator approval before tracking |
| `role_gated` | **reserved**: validates as config, but any code path asked to operate in this mode fails closed (`assertContactTrackingModeImplemented`) until the large-audience epic implements it |

**Approval mode (implemented in E3.4,
`src/core/contacts/tracking-gate.ts`).** Mode resolution is a direct
exact-channel-id read of the `contextEnvelope.channels.<channelId>.contactTracking`
label with an `auto` default — deliberately not a classification pipeline. In an
`approval` channel a NEW speaker does **not** auto-upsert a contact:

- The speaker stays **untracked** — transcript/text-prefix attribution only; no
  contact record, no profile, no per-person memory extraction (the mention-only
  contact path is gated too), no social-graph entity. Room-scoped facts may
  still record `sourceSpeakerName` (attribution truth) with zero contact-keyed
  rows.
- A durable pending-contact request is enqueued
  (`companion-data/.../contacts/pending-approvals.json`) capturing name,
  channel, channel user id, first-seen, and a small sample of message previews
  **from that channel only** (no cross-channel or DM content in the payload).
- The first sighting produces an operator notification through the existing
  gateway notification path (`notify.ntfy`, system-derived sender
  `system.contacts.pending_approval`) — charter 9.6. Subsequent messages update
  the entry without re-notifying.
- Operator decisions live in the Garden **Contact Approvals** view
  (`/api/admin/contact-approvals`): **approve** creates the contact through the
  normal channel-identity upsert path (subsequent messages resolve normally);
  **deny** persists — the speaker stays untracked and is never re-enqueued;
  **reset** removes the record so the speaker's next message re-proposes (the
  only re-proposal path besides an explicit operator re-request).

Already-tracked contacts in approval channels resolve exactly as before; `auto`
channels are byte-identical to pre-gate behavior.

## Owner-file schemas

### channels.json (channel-owned labels)

```jsonc
{
  "contextEnvelope": {
    "channels": {
      "discord:friends-room": {
        "privacy": "invite_only",      // ChannelPrivacy — retired vocabulary rejected
        "broadcast": false,             // optional boolean
        "contactTracking": "auto",     // auto | approval | role_gated
        "needsReview": false            // optional; migration-seeded review flag (E3.2)
      }
    }
  }
}
```

- Section optional; absent means "no channel-owned labels".
- Every present label must define at least one field; unknown keys fail closed.
- `broadcast: true` with a non-`public` `privacy` is rejected (a broadcast surface is
  always `public`); a label carrying only `broadcast: true` implies `public`.
- `needsReview` (E3.2) marks a migration-seeded fail-closed label awaiting operator
  confirmation. It renders as a Garden warning badge and never changes gating.
- Validated at load (`loadRuntimeChannelsConfig` → `parseContextEnvelopeSection`) AND
  on every owner-file save (`saveChannelsOwnerFile` re-validates fail-closed).
- **Consumed since E3.2**: startup publishes the labels
  (`setRuntimeChannelEnvelopeLabels`) and `classifyChannelEnvelope` resolves them as
  the top-precedence classification source.

### trust-policy.json (operator policy + derivation thresholds)

```jsonc
{
  "trustCeiling": { ... },                       // unchanged
  "visibilityAllowed": {
    "private":     ["public", "personal", "intimate", "confidential"],
    "invite_only": ["public", "personal"],      // was "semi_private"
    "public":      ["public"],
    "broadcast":   ["public"]                    // transitional; folds into public+flag in E3.3
  },
  "audienceScopeThresholds": { "fewMax": 10, "manyMax": 100 },  // optional; defaults shown
  "channelClassification": { ... }               // overrides now use invite_only
}
```

- Existing owner files that still say `semi_private` are migrated **once at load**
  (`migrateLegacyTrustPolicyVocabulary`) and persisted; a file defining both spellings
  fails closed. `saveTrustPolicyConfig` (Garden writes) rejects the retired vocabulary
  outright.
- **E3.3 target shape (documented, not executed):** `visibilityAllowed` becomes keyed by
  the three `ChannelPrivacy` values; the broadcast row disappears because broadcast is a
  flag whose disclosure ceiling is the `public` row (plus the approval-token gate).

## Precedence

For a channel's `{channelPrivacy, broadcast}` pair (highest wins), **executed in E3.2**
by `classifyChannelEnvelope` (`src/system/trust/policy.ts`):

1. **Channel-owned label** — `channels.json` `contextEnvelope.channels.<channelId>`
   (`privacy` + `broadcast`; a `broadcast: false`-only label pins the flag while
   privacy falls through)
2. **Operator trust-policy override** — `trust-policy.json`
   `channelClassification.visibilityOverrides` (exact, then longest prefix), mapped
   through the migration pair (`broadcast → public + flag`)
3. **Derived default** — adapter-declared runtime metadata (`X-Channel-Privacy`,
   satellite registry, routing → `ChannelMeta.privacyLevel`), `isDirectMessage →
   private`, and the **demoted** prefix heuristics (`privatePrefixes` /
   `broadcastPrefixes`), else `invite_only`

The prefix lists are no longer operator-tier authority: E3.2 demoted them to
derived-default inputs and made them SEED data for channel records — the one-time
`npm run migrate:channel-envelope` command derives channel-owned labels from them
(plus persisted evidence) so labeled channels never consult heuristics again. The
transitional `classifyChannel` (4-value `ChannelVisibility`, deleted in E3.3) is a
pure projection: `broadcast ? 'broadcast' : privacy`.

**Per-contact privacy fields are demoted (E3.2)**: `ContactChannelLink.privacyLevel`
and `ContactConversationChannel.privacyLevel` are provenance evidence only. The
`ResolvedAuthorContext.channelPrivacyLevel` seam was removed, so stored per-contact
values can no longer reach `ChannelMeta.privacyLevel` or any gate. Rows are retained
for history; column removal is a later cleanup bead.

## One-time migration (`npm run migrate:channel-envelope`)

Enumerates known channels from contact conversation-channel rows
(`contact_channel_activity`, Postgres or SQLite) and the JSONL session journals, then
seeds `contextEnvelope.channels` labels. Dry-run report is the **default**; `--apply`
writes through the validated owner-file path. Derivation is deterministic: prefix
heuristics seed verbatim; otherwise unanimous persisted evidence (stored visibility
stamps, DM topology) seeds; conflicting or absent evidence is **reported, never
guessed** — those channels get fail-closed `invite_only` plus `needsReview: true`
(Garden warning badge). Channels already owned by an operator override are reported
and left in trust-policy.json, not duplicated.

## Migration map (visibility → envelope)

| Old `ChannelVisibility` | New envelope | Status |
|---|---|---|
| `private` | `{ channelPrivacy: 'private', broadcast: false }` | name unchanged |
| `semi_private` | `{ channelPrivacy: 'invite_only', broadcast: false }` | **executed in E3.1** (pure rename, no alias) |
| `public` | `{ channelPrivacy: 'public', broadcast: false }` | name unchanged |
| `broadcast` | `{ channelPrivacy: 'public', broadcast: true }` | **executed in E3.2 at classification inputs** (labels, overrides, meta, prefix seeds); the `ChannelVisibility` value itself is deleted in E3.3 |

Code artifact: `CHANNEL_VISIBILITY_ENVELOPE_MIGRATION` in `context-envelope.ts`.

Stored-data rule: persisted records written before the rename (session provenance, mirror
metadata, transcript projections, contact rows, legacy journals) decode
`semi_private → invite_only` through one shared decoder
(`decodeStoredChannelVisibility`). This is a read-boundary decode for old data only —
config, API, and model-facing surfaces reject `semi_private` outright.

## Continuity direction

Continuity flows from source to target only if the target's allowed-sensitivity set
contains everything the source may disclose (`visibilitiesShareContinuity`, unchanged
logic). Re-expressed over the new names with the default policy:

| From \ To | private | invite_only | public | public+broadcast |
|---|---|---|---|---|
| **private** | yes | no | no | no |
| **invite_only** | yes | yes | no | no |
| **public** | yes | yes | yes | yes |
| **public+broadcast** | yes | yes | yes | yes |

Same relative ordering as before (`broadcast` behaved identically to `public`; as a flag
it inherits the `public` row).

## Delivery guidance rule (charter)

The substrate may carry **length/delivery** knobs — "don't yap"-class guidance such as
the concise/expressive response style — but **never persona or tone prose**. "Be
helpful" is forbidden substrate content: if the companion is an asshole, the substrate
must not sand that off. Response style must be **decoupled from privacy**: today
`resolveChannelResponseStyle` derives a default style from visibility; the contract
declares that coupling retired, and E3.3 moves style resolution to channel/operator
configuration with no privacy input. All envelope gating remains deterministic and
pre-prompt; the envelope itself never becomes prompt text.

## ConversationScope attachment seam (E3.3)

`ConversationScope` (`src/core/session/conversation-scope.ts`) gains
`readonly envelope: ContextEnvelope`, resolved once per turn at session-manager ingress
alongside the scope itself (the seam interface is `ContextEnvelopeCarrier`). The scope
already carries the derivation inputs: `kind` ('dm'/'group') for topology,
`memberCountHint` for roster size, `recentSpeakers` for the knowledge fraction. E3.1
adds only the documented seam; no field, no wiring.

## Explicitly LATER (out of scope for E3.x)

- **Role gating** — `contactTracking: 'role_gated'` semantics (reserved vocabulary only).
- **Sentiment views** — aggregate views over large audiences.
- **Content firewall** — large-audience content controls.

These belong to the large-audience epic; the envelope vocabulary reserves their seams
(`role_gated`, `audienceScope: 'many' | 'unbounded'`) without implementing them.

## What remains after E3.2

**E3.2 — classification over owner files (DONE)**
- `classifyChannelEnvelope` re-keys classification onto `ChannelPrivacy` + the
  `broadcast` flag, consuming `channels.json` `contextEnvelope.channels` as the
  top-precedence source (published at startup via `setRuntimeChannelEnvelopeLabels`).
- The `broadcast → (public + broadcast: true)` migration leg is executed at
  classification inputs (labels, overrides, `ChannelMeta.privacyLevel` /
  `X-Channel-Privacy` / satellite routing, and the demoted `broadcastPrefixes`).
- Per-contact privacy fields are demoted to provenance evidence (no gating seam).
- One-time `migrate:channel-envelope` seeds channel records; Garden gained the
  CHANNELS list/edit view over the owner-file path.
- Still with E3.3 (needs the `ConversationScope` seam): deriving `audienceScope` /
  `audienceKnowledge` **at session ingress** from channel topology, roster, and
  contact resolution using the config-owned thresholds (the derivation helpers are
  contract-complete in `context-envelope.ts`).

**E3.3 — envelope-keyed gating**
- Attach `envelope: ContextEnvelope` to `ConversationScope` (the documented seam).
- Re-key `visibilityAllowed`, `getAllowedSensitivities`,
  `getVisibilityDisclosureCeiling`, and `visibilitiesShareContinuity` from
  `ChannelVisibility` to `{ channelPrivacy, broadcast }`, then **remove
  `ChannelVisibility` and the transitional `broadcast` visibility value**.
- Decouple response style from privacy (`RESPONSE_STYLE_BY_VISIBILITY` retired) per the
  delivery-guidance rule.
- ~~Wire `contactTracking` modes~~ — **done in E3.4** (`auto` default, `approval`
  flow with durable pending queue + Garden approvals view; `role_gated` stays
  fail-closed at use).
