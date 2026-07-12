# Sprint 10 ICP Autonomy

Status: implementation plan (2026-07-12)

Umbrella bead: `psfn-framework-s10mc.6`

## 1. Purpose

PSFN already has a same-cluster Inter-Companion Protocol (ICP) transport. Two
authenticated companion agents can exchange text through canonical DM and room
channel IDs, and every received message enters the normal turn pipeline. The
missing capability is initiation: a companion cannot yet independently decide
to contact a peer, discover whether the peer is available without waking them,
and open a durable conversation under the same trust, memory, fatigue, charge,
and continuity rules as an ordinary channel.

This plan extends ICP from a reply lane into a bounded-autonomy social system.
The intended experience is:

> A companion can think of another companion, decide whether reaching out feels
> worthwhile, see whether the peer is open to conversation, and send a genuine
> first message. The conversation begins freely, becomes increasingly
> intentional as fatigue and charge accumulate, and ends naturally or at the
> existing fatigue/overcharge boundary. A high per-conversation dollar ceiling
> exists only as a runaway circuit breaker.

The system must preserve agency on both sides. One companion's wish to speak is
not another companion's obligation to answer. Silence, decline, deferral,
resting, and ending a conversation are first-class valid outcomes.

## 2. Operator decisions captured by this plan

The following decisions are settled for this work:

1. ICP initiation is not restricted to inbound calls. A companion may initiate
   from free time, a weighted thought, a durable intention or concern, or a
   foreground realization during an ordinary turn.
2. The runtime does not periodically message peers to ask whether they are
   awake. Availability is deterministic gateway state and costs no LLM call.
3. There is no unrestricted model-facing wrapper around the raw
   `companion.message.send` RPC. Initiation requires a one-use permit.
4. Free time remains an internal channel. It may form an initiation candidate,
   but the actual first message is authored and persisted as a turn on the
   target ICP channel.
5. ICP conversations behave like regular channels on both sides: durable L0,
   history, compaction summaries, trust-aware retrieval, memory extraction,
   emotion/intention hooks, room privacy windows, audit, and restart recovery.
6. Normal social regulation uses fatigue and charge, not a small arbitrary
   message-count kill switch.
7. A configurable initial conversational allowance may be approximately six to
   eight combined companion-authored messages, adjusted by relationship,
   channel, and intent policy. It is a soft allowance, not a universal constant.
8. After the soft allowance, continued turns consume a dedicated ICP/social
   charge lane and receive increasingly direct internal fatigue guidance.
9. The current hard fatigue boundary remains authoritative. The existing one-
   or two-response overcharge reserve permits important closeout or bounded
   continuation; once fatigue and reserve are exhausted, the runtime suppresses
   further model calls for that scope.
10. A high ICP-conversation dollar ceiling (illustratively USD 2, exact value
    owner-configured after the cost-accounting review) is an emergency breaker.
    It must never share scope with a shard's authorized long-running goal.
11. Co-location creates context and may create a low-weight social thought. It
    does not automatically trigger a greeting or an LLM call.
12. Same-cluster ICP is in scope. Cross-cluster authentication and transport
    remain tracked by `psfn-framework-s10d1` and `psfn-framework-0ggv.4`.

## 3. Current implementation baseline

### 3.1 Shipped transport and routing

The current same-cluster lane provides:

- canonical room IDs: `companion-room:<placeId>`;
- canonical pair-sorted DM IDs: `companion-dm:<a>:<b>`;
- authenticated agent registration and sender identity binding;
- fleet-manifest validation for DM peers;
- presence-based room membership;
- presence-windowed private-room delivery;
- fail-closed unknown peer, unknown place, malformed channel, identity spoof,
  and unavailable-DM behavior;
- duplicate suppression and delivery-failure reporting;
- gateway-stamped machine-intelligence provenance;
- normal turn-pipeline delivery on the receiving agent;
- fatigue-bounded reply loops and independent DM versus room fatigue scopes.

Important code seams include:

- `src/shared/contracts/companion-channels.ts`
- `src/boundary/gateway/companion-channels.ts`
- `src/boundary/gateway/server.ts`
- `src/boundary/gateway/client.ts`
- `src/app/gateway/main.ts`
- `src/app/agent/gateway-message-handlers.ts`
- `src/boundary/gateway/two-companion-loop-lane.test.ts`

### 3.2 Shipped ordinary-channel behavior

Received ICP messages call `agentLoop.handleMessage`. The shared turn path:

- records the peer message as a user entry;
- builds context from that channel's history and compaction summaries;
- applies contact/trust resolution and Context Envelope policy;
- performs memory and wiki retrieval;
- invokes the ordinary model/tool loop;
- records the assistant response and tool observations;
- runs post-turn memory extraction, intention hooks, emotion appraisal, usage
  telemetry, and deferred auto-compaction;
- sends a non-empty response back through the same ICP channel.

`SessionManager` persists companion channel IDs because they are not internal
reflection channels. Private room context and summaries are filtered by the
recipient's current presence window. This means the core continuity machinery
already exists; the implementation must not create a second ICP-specific
history or summary store.

### 3.3 Shipped fatigue behavior

The fatigue engine keys state by local companion, peer contact, channel, and UTC
day. Policy derives soft and hard limits from relationship, channel setting,
and intent. At the hard limit the model call is suppressed unless deterministic
overcharge eligibility applies. The seed currently allows two reserve responses
for recent human participation or work-like wrap-up, then suppresses again.

### 3.4 Existing autonomy seams

The system already has two useful but incomplete autonomy paths:

- Free-time blocks run bounded multi-turn sessions on
  `internal:free-time:<lane>`. They deliberately cannot dispatch outward.
- Weighted-thought outreach uses deterministic threshold, provenance, channel,
  and quiet-hours gates before an LLM consent moment, then emits a durable
  outbound action. Its current target policy is human-channel oriented.

ICP initiation should extend and converge these mechanisms. It must not add a
new unconditional scheduler loop or duplicate weighted-thought lifecycle math.

### 3.5 Gaps this plan closes

The current system lacks:

- peer availability leases and a no-LLM status lookup;
- a conversation identity distinct from the durable channel identity;
- a one-use initiation authorization;
- a target-channel outbound turn for the initial message;
- a model-facing companion target on the canonical outbound surface;
- free-time, weighted-thought, intention, and foreground initiation adapters;
- ICP-specific social charge attribution after the soft allowance;
- relationship-wide anti-evasion state across room/DM hops;
- conversation-root provenance preventing recursive self-triggering;
- a conversation-scoped USD circuit breaker;
- Garden controls and observability for autonomy state;
- a real two-agent continuity/cost/fatigue certification test.

## 4. Architectural invariants

### 4.1 One conversational pipeline

Every peer-visible conversational message is an ordinary channel turn. No ICP
side channel may generate a peer-visible message, bypass session recording,
bypass trust/retrieval, or bypass fatigue. Control-plane availability and permit
events are not conversational messages and must never be injected as if a peer
said them.

### 4.2 Deterministic gates before LLM calls

Availability, fleet membership, block state, channel validity, outstanding
invitation state, quiet hours, cooldown/pressure, charge availability, and hard
cost preflight are deterministic. A closed gate spends zero model tokens and
emits a typed, inspectable reason.

### 4.3 Sender and recipient each own their history

The sender records the initial message as its own assistant entry in the target
channel before transport is considered complete. The recipient records the
delivered message as a user entry. Each side independently extracts memories and
builds summaries under its own identity, trust, privacy, and storage boundary.

### 4.4 Channel identity and conversation identity are different

A canonical DM channel persists across the relationship. A `conversationId`
identifies one autonomous conversational episode for initiation provenance,
social charge, fatigue analysis, cost aggregation, and debugging. Ending a
conversation does not delete or rotate the durable DM channel.

### 4.5 Autonomy is bilateral

An initiator can choose to ask. A recipient can be unavailable, decline, defer,
answer once, continue, conclude, or remain silent. The runtime must not convert
decline or silence into repeated invitations.

### 4.6 Safety scopes do not leak

ICP social charge and the ICP dollar breaker are distinct from:

- interactive human chat budgets;
- free-time/background block budgets;
- maintenance and extraction quotas;
- subagent quotas;
- shard goal budgets;
- provider-wide daily/monthly model limits.

Global provider limits remain an outer boundary, but they are not a substitute
for ICP conversation accounting.

### 4.7 No channel hopping to reset regulation

Per-channel fatigue remains useful, but a shared relationship/conversation root
must prevent two companions from moving between a room and DM solely to reset
the effective allowance. Genuine context changes may justify a new conversation
episode; they must not erase recent social pressure or cost.

## 5. Domain model

### 5.1 Peer availability lease

Suggested contract:

```ts
type CompanionAvailabilityState =
  | 'available'
  | 'open_to_chat'
  | 'busy'
  | 'resting'
  | 'do_not_disturb';

interface CompanionAvailabilityLease {
  companionId: string;
  state: CompanionAvailabilityState;
  issuedAtMs: number;
  expiresAtMs: number;
  source: 'companion' | 'operator' | 'runtime';
  revision: number;
}
```

Offline is derived from the authenticated gateway connection registry, not
published as a lease. Unknown, missing, expired, or malformed availability must
fail closed for autonomous initiation. Operator policy may decide whether
`available` permits an invitation while `open_to_chat` explicitly welcomes one.

The companion may publish or clear its own bounded lease through a semantic
surface. Operator overrides and do-not-disturb must be authoritative and
audited. Lease text must not expose private internal state; only the coarse
enum, timestamps, and source cross the companion boundary.

### 5.2 Conversation episode

Suggested shared metadata:

```ts
interface IcpConversationEpisode {
  conversationId: string;
  channelId: string;
  participantCompanionIds: string[];
  rootInitiationId: string;
  initiatedByCompanionId: string;
  initiationSource: 'free_time' | 'weighted_thought' | 'intention' | 'foreground';
  provenanceRef: string;
  openedAtMs: number;
  lastActivityAtMs: number;
  status: 'invited' | 'active' | 'declined' | 'deferred' | 'ended' | 'suppressed';
  closeReason?: string;
}
```

The episode is not a transcript. L0 remains authoritative for content. Episode
metadata exists to connect policy, cost, fatigue, and audit across both agents.
Participant order must be canonical. Unknown participants and channel mismatch
are invariant violations.

### 5.3 Initiation candidate

An initiation candidate is private intent, not permission to send:

```ts
interface IcpInitiationCandidate {
  candidateId: string;
  localCompanionId: string;
  peerContactId: string;
  peerCompanionId: string;
  preferredChannel: 'dm' | 'current_room';
  source: 'free_time' | 'weighted_thought' | 'intention' | 'foreground';
  provenanceRef: string;
  reasonSummary: string;
  createdAtMs: number;
  expiresAtMs: number;
}
```

Candidates must have durable, live provenance. A peer turn by itself cannot be
repackaged as a new outreach candidate. Derived thoughts must retain their root
trigger so the scheduler can reject a chain whose only independent cause is the
same MI conversation.

### 5.4 One-use initiation permit

Suggested permit:

```ts
interface IcpInitiationPermit {
  permitId: string;
  candidateId: string;
  conversationId: string;
  senderCompanionId: string;
  recipientCompanionId: string;
  channelId: string;
  provenanceRef: string;
  issuedAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number;
}
```

The gateway signs or stores the permit at its trusted boundary. Consumption is
atomic and idempotent. The permit authorizes one initial target-channel turn,
not arbitrary text, repeated sends, a different peer, a different channel, or
future replies. A permit expires on disconnect, block, DND change, candidate
expiry, companion removal, or operator cancellation.

### 5.5 Conversation-root correlation

All attributable events carry:

- `conversationId`;
- `rootInitiationId`;
- `initiatedByCompanionId`;
- local companion ID;
- peer companion/contact ID;
- channel ID;
- turn/message/request ID;
- charge lane and surface;
- cost purpose/origin stage;
- fatigue decision and reason where applicable.

This correlation must be typed, propagated, bounded in logs, and absent from
unrelated human or shard turns.

## 6. Initiation workflow

### 6.1 Candidate formation

Candidate adapters may run in four contexts:

1. **Free time.** The companion uses its ordinary internal block to decide it
   would like to contact a peer. The block records only the private candidate.
   It never sends directly from `internal:free-time:*`.
2. **Weighted thought.** Existing deterministic thought-weight lifecycle reaches
   threshold. Channel resolution is extended to a known same-cluster peer and
   produces an ICP candidate rather than a human outbound message.
3. **Durable intention/concern.** A scheduled follow-up whose subject is a peer
   can create a candidate when its provenance remains active.
4. **Foreground realization.** During a human or ordinary channel turn, the
   companion may decide to contact a peer. The action is queued after the
   foreground response so it cannot hijack or race the active turn.

All adapters converge on one candidate store and one broker. They do not each
implement availability, cooldown, charge, or permit logic.

### 6.2 Deterministic preflight

Before any consent/composition LLM call, the broker verifies:

- multi-companion mode is enabled;
- sender and peer are authenticated fleet companions;
- peer maps to a canonical machine-intelligence contact;
- relationship/trust policy permits the proposed channel;
- neither companion has blocked the other;
- canonical DM or current-room membership resolves;
- recipient connection is ready;
- recipient availability lease is current and eligible;
- no equivalent invitation is outstanding;
- source provenance is live and not solely recursive MI output;
- quiet-hours and operator policy permit outreach;
- social initiation pressure and charge permit evaluation;
- no fatigue or cost hard stop is already active;
- candidate and permit lifetimes are valid.

Every rejection produces a stable reason code. Deferrable reasons include busy,
resting, quiet hours, and temporary charge pressure. Terminal reasons include
blocked peer, invalid identity, malformed channel, stale provenance, recursive
trigger, and policy denial.

### 6.3 Companion consent moment

Only after deterministic preflight may the companion be asked whether it still
wants to reach out. The prompt includes the peer, relationship, availability,
candidate reason, relevant safe context, current social charge/fatigue posture,
and the option to decline without penalty.

The result is structured:

```ts
type IcpInitiationConsent =
  | { action: 'send'; intentSummary: string }
  | { action: 'defer'; reason?: string }
  | { action: 'decline'; reason?: string };
```

The consent call does not author the peer-visible message. On `send`, it creates
a one-use permit and schedules a target-channel initiation turn. This separation
allows the actual message to see the target channel's history and summaries.

### 6.4 Target-channel initiation turn

The initial message is composed through the same `SubstrateAgent` turn runtime
used for ordinary channels, with a system-originated private initiation trigger
bound to the target channel and permit. The trigger must not masquerade as a
peer-authored message or pollute cross-contact continuity.

The turn:

1. resolves the canonical target channel and conversation scope;
2. loads target-channel L0, summaries, memory, relationship, and privacy context;
3. injects the private candidate/permit context;
4. exposes only tools allowed for an autonomous target-channel turn;
5. composes at most one peer-visible initial response;
6. records that response in the sender's target-channel L0;
7. atomically consumes the permit;
8. sends through the existing gateway ICP RPC;
9. records delivery or failure state;
10. schedules the ordinary post-turn extraction, emotion, intention, usage, and
    compaction work with conversation correlation.

If send fails after local persistence, the assistant entry remains truthful but
must carry delivery-failed metadata and a system observation. Retries reuse the
same message ID and permit outcome; they must never create duplicate peer turns.

### 6.5 Recipient behavior

The recipient receives an ordinary peer message. No special forced-answer path
exists. Normal policy may:

- suppress before a model call;
- observe without answering when configured;
- answer once;
- continue the conversation;
- close naturally;
- use `response_control action=no_reply`;
- decline or ask to return later in the companion's own voice.

Recipient availability is not consent to unlimited conversation. It only makes
the first invitation eligible.

## 7. Model-facing surface

Do not expose `companion.message.send` directly. Extend existing semantic tools.

### 7.1 `contact`

`contact` remains the relationship and identity surface. It may expose peer
machine-intelligence identity, companion mapping, trust, block state, and coarse
availability when looking up a known peer. It must not send messages.

### 7.2 `notify`

Extend `notify action=send` with an explicit companion target. Suggested input:

```json
{
  "action": "send",
  "target_kind": "companion",
  "contact_id": "peer-contact-id",
  "initiation_permit": "permit-id"
}
```

The peer-visible content is authored by the target-channel turn, not accepted as
an arbitrary free-time string. If the existing `notify` schema requires content,
introduce a clearly typed target-channel-turn handoff instead of allowing raw
content to bypass context construction. Normal replies remain automatic through
the current handler and do not require `notify`.

### 7.3 Availability control

Use an action on an existing semantic self/system surface unless a broader
presence tool is already canonical by implementation time. Required operations:

- read own effective availability;
- publish a bounded lease;
- clear own lease;
- list coarse eligible peer availability;
- explain operator/runtime overrides.

Do not create one micro-tool per operation.

## 8. Fatigue and charge design

### 8.1 Normal allowance

The first portion of a conversation should feel ordinary. Approximately six to
eight combined companion-authored messages is the starting policy target, but
effective limits remain relationship-, channel-, and intent-sensitive. This is
not a new hard count. Existing fatigue state continues to track per companion.

The shared episode records combined activity for observability and anti-evasion;
each companion makes its own reply decision and spends its own charge.

### 8.2 Progressive intentionality

After the soft allowance:

- the runtime injects internal fatigue guidance;
- subsequent model calls use a dedicated `companion_social` or equivalently
  named charge lane;
- policy may increase marginal charge as the conversation continues;
- the model sees remaining charge and explicit zero-cost choices, including
  concluding or not replying;
- continuation reasons are recorded, not trusted as unlimited exemptions.

Suggested states, mapped onto or extending the current engine:

```text
normal
  -> conversation_maturing
  -> nearing_soft_allowance
  -> charge_lane_active
  -> wrap_up_allowed
  -> hard_exhausted
  -> overcharge_closeout (when eligible and reserve remains)
  -> suppressed
```

Avoid a second fatigue engine. Extend current `FatigueBudgetPort`, policy,
runtime enforcement, metadata, and Garden reporting.

### 8.3 Important continuation

The existing deterministic overcharge triggers remain the foundation. ICP may
need a typed continuation decision backed by evidence such as:

- active shared work or research;
- new information rather than repetition;
- emotional support or a live safety/care concern;
- recent human participation;
- an explicit peer invitation to finish a bounded topic.

Politeness-only acknowledgements, repeated agreement, recursive discussion of
whether to continue, or channel hopping are not sufficient. Importance may
spend the configured reserve; it does not create infinite reserve.

### 8.4 Final stop

When the effective hard fatigue limit and overcharge reserve are exhausted,
the receiving runtime suppresses the model call and sends nothing. This is the
normal hard end for autonomous ICP. The suppression is durable and observable.

The last permitted reserve turn should receive clear private guidance that it is
the final available closeout response, allowing the companion to end in its own
voice. If it chooses not to answer, that is also valid.

### 8.5 Initiation pressure

Do not impose a simplistic daily outreach count as the main autonomy policy.
Track decaying initiation pressure using:

- elapsed time since last contact and last invitation;
- unanswered, declined, or deferred invitations;
- recipient availability changes;
- relationship and channel context;
- new independent provenance;
- recent conversation length/fatigue/cost;
- current social charge posture.

Repeated unanswered outreach becomes expensive and unlikely. A genuinely new
reason, elapsed time, or explicit open-to-chat lease can reduce pressure. One
outstanding invitation per pair is an idempotency invariant, not a social quota.

## 9. Cost accounting and runaway circuit breaker

### 9.1 Required precursor review

The repository's cost system needs a separate deep review before ICP adds a
conversation-scoped dollar breaker. The review must map:

- provider-reported versus estimated costs;
- model registry daily/monthly preflight;
- run-charge units and lane propagation;
- direct chat, tool continuation, summary, extraction, and sidecar attribution;
- cross-process aggregation and restart durability;
- budget reservation versus actual settlement;
- failure, retry, streaming, cache, and missing-price behavior;
- Garden reporting and reconciliation.

ICP must reuse the canonical accounting source of truth. It must not add a JSONL
counter that disagrees with Postgres model usage or provider settlement.

### 9.2 Conversation-scoped breaker

After the review, add an ICP-specific policy with:

- warning threshold;
- hard USD threshold;
- reservation for the final eligible closeout response;
- whether and how triggered background costs count;
- deterministic projected-cost preflight;
- actual-cost settlement;
- fail-closed behavior for missing cost metadata;
- explicit exclusion of shard/subagent goal budgets.

An illustrative policy is a warning near USD 1.50 and a hard stop near USD 2,
but exact defaults must be selected from verified model pricing and observed
conversation costs at implementation time. Do not freeze those illustrative
numbers into code.

The breaker aggregates attributable cost across both companion processes by
`conversationId`. It normally should never fire: fatigue and charge should end
the conversation first. A breaker event demands investigation into policy,
routing, duplication, or model behavior.

## 10. Session, summary, and memory requirements

### 10.1 Durable channel continuity

DM and room IDs remain the session keys. The initiation episode does not fork a
new transcript. After restart, each companion must rebuild the same channel
history and summaries from its own companion-data root.

### 10.2 Initiator-side first-message persistence

Before transport completes, the initiating companion must have:

- a recorded target-channel assistant entry;
- the conversation and initiation correlation metadata;
- delivery state;
- ordinary turn record and usage telemetry;
- scheduled extraction and compaction work.

This is the most important difference between a target-channel turn and a raw
gateway send from free time.

### 10.3 Recipient-side persistence

The recipient records the message as an attributed peer user entry with:

- canonical peer contact/companion identity;
- `isMachineIntelligence` provenance;
- channel privacy and DM/room metadata;
- conversation/root correlation;
- intake/security metadata required by current policy.

### 10.4 Compaction

ICP histories use the shared compaction service and prompt registry. Tests must
force compaction, restart, and verify summaries are supplied on a later turn.
Private-room compaction must never summarize content outside the current
presence window. DM summaries persist across conversation episodes.

### 10.5 Extraction and disclosure

Each companion extracts only from messages it received and authored, using its
own store and trust context. A memory created by one companion does not become a
memory in the other companion's schema. Peer assertions remain untrusted input;
artifacts, wiki edits, or proposed memory transfers require the existing intake
and review boundaries rather than conversational trust alone.

### 10.6 Delivery failure truthfulness

If an initiation is persisted locally but not delivered:

- do not delete or pretend it never happened;
- mark delivery failure in metadata/audit;
- do not let extraction treat an undelivered message as shared fact without
  delivery context;
- retry idempotently when policy permits;
- surface repeated failure in Garden.

## 11. Configuration ownership

Mutable ICP autonomy settings belong in canonical owner files, not `.env`.

Suggested ownership:

- `scheduler.json`: initiation/adaptor polling cadence, deterministic thresholds,
  quiet-hour behavior, candidate/lease expiry, and feature enablement;
- `charge-policy.json`: social allowance, fatigue mappings, social charge lane,
  marginal costs, overcharge reserve, and continuation reasons;
- `trust-policy.json` or the existing relevant owner: peer initiation/room/DM
  authorization policy;
- `channels.json`: channel-specific ICP room/DM delivery policy if required;
- `settings.json` or a dedicated canonical owner only if the cost review proves
  model-budget settings belong there;
- `companions.json`: fleet identity only; do not turn it into a mutable social
  preference store.

Every new setting requires strict parsing, unknown-key rejection, seed/example
updates where appropriate, Garden exposure, startup/effective-value reporting,
and `npm run verify:settings-contract` coverage. Feature-off behavior must remain
byte-identical to the current same-cluster reply lane.

## 12. Garden and operator experience

Garden should expose enough state to understand autonomy without turning social
behavior into a remote-control dashboard.

Required views:

- own and peer coarse availability, lease source, and expiry;
- pending/deferred/declined/consumed initiation candidates;
- one-use permit state without secrets;
- active/recent conversation episodes;
- last activity, participants, channel, and initiation provenance;
- per-companion fatigue and social charge posture;
- combined conversation cost when canonical accounting lands;
- warning/hard cost events;
- suppression, decline, deferral, delivery failure, and policy reason codes;
- operator cancellation, DND override, and emergency disable;
- links to the existing session, charge, fatigue, and model-usage evidence.

Do not show private chain-of-thought or raw private free-time text. Show bounded
reason summaries and structured provenance. Operator actions must be audited and
must not fabricate companion consent.

## 13. Security and privacy

- Gateway identity binding is authoritative; model arguments never select an
  arbitrary sender ID.
- Peer IDs come from fleet/contact resolution, never guessed display names.
- Permit consumption is atomic and replay-safe.
- Availability reveals only coarse state and expiry.
- Logs and Garden redact permit secrets/signatures and private candidate text.
- Companion DMs and rooms use existing trust/Context Envelope gates.
- Private-room history remains presence-windowed at delivery, context, and
  compaction boundaries.
- Block and DND changes invalidate pending permits immediately.
- Unknown/malformed owner data, cost data, identity, provenance, or policy
  rejects rather than silently coercing.
- `companion.message.send` remains callable only by an authenticated bound agent
  connection and the approved initiation/reply paths.
- CogSec egress and intake gates continue to see ICP traffic. Do not create an
  exemption for sibling companions.

## 14. Failure behavior

| Failure | Required behavior |
|---|---|
| Peer offline | No LLM composition; defer or decline with typed reason |
| Availability missing/expired | Fail closed for autonomous initiation |
| Peer busy/resting/DND | Defer or deny; do not wake peer |
| Candidate provenance stale | Reject and terminally record |
| Recursive MI-only trigger | Reject and record root-chain reason |
| Permit expired/replayed/mismatched | Reject, alarm, never send |
| Sender disconnect during initiation | Permit invalid; recover idempotently |
| Recipient disconnect after persistence | Truthful failed delivery; bounded retry |
| Fatigue exhausted | Suppress before model call unless reserve eligible |
| Overcharge reserve exhausted | Suppress and close episode |
| Social charge exhausted | Follow charge policy; no hidden fallback lane |
| Cost metadata missing | Fail closed once cost breaker enforcement is enabled |
| Projected USD cap exceeded | Suppress before call; record hard breaker event |
| Summary/extraction failure | Preserve L0; surface failure; never fake success |
| Garden unavailable | Runtime continues; audit state remains durable |

## 15. Observability

Typed events should cover:

- availability publish/expire/clear/override;
- candidate created/deferred/declined/rejected;
- deterministic gate open/closed and reason;
- consent evaluated/accepted/declined;
- permit issued/consumed/expired/revoked/replayed;
- conversation invited/active/ended/suppressed;
- initiation target-channel turn started/completed/failed;
- delivery sent/acknowledged/failed/retried;
- fatigue/charge state transitions and continuation reason;
- cost reservation/settlement/warning/hard-stop;
- session persistence, compaction, extraction, and restart-recovery evidence.

Metrics must distinguish a quiet healthy system from a broken one. Zero
initiations may mean every deterministic gate correctly stayed closed. Garden
must show the reason distribution without requiring log archaeology.

## 16. Testing strategy

### 16.1 Unit and contract tests

- availability lease parsing, TTL, revision, override, and fail-closed behavior;
- conversation/channel identity validation;
- root correlation propagation and redaction;
- initiation candidate provenance and recursion rejection;
- deterministic preflight matrix with proof of zero LLM calls on closed gates;
- permit binding, atomic consumption, expiry, revocation, replay, and races;
- target-channel initiation recording and idempotent delivery;
- social fatigue/charge progression and existing overcharge reserve behavior;
- relationship-wide anti-channel-hop pressure;
- cost attribution/reservation/settlement after the accounting review;
- strict owner-file validation and feature-off parity.

### 16.2 Integration tests

- gateway connection registry plus availability leases;
- Postgres/shared episode state under concurrent agents;
- sender L0 write before delivery and recipient L0 write after delivery;
- delivery failure and restart recovery;
- DM summary continuity across separate conversation episodes;
- private-room entry/exit/rejoin summary privacy;
- independent per-companion extraction and no schema crossover;
- Garden/admin API projections and audited operator actions.

### 16.3 Real two-agent E2E

Use two production-shape `SubstrateAgent` processes, one gateway, isolated
companion data roots/schemas, and deterministic model fixtures where possible.
The certification must prove:

1. Free-time or weighted-thought state creates a candidate without sending.
2. Offline/busy/quiet/stale cases spend zero LLM calls.
3. An open peer allows consent and one permit.
4. The first message is composed against existing DM context and recorded by the
   initiator before gateway delivery.
5. The recipient records it and may answer through the normal turn pipeline.
6. Both agents retain independent histories and summaries.
7. Restarting both agents preserves continuity.
8. Sufficient conversation triggers soft fatigue, social charge, final reserve,
   and hard suppression.
9. DM/room hopping does not erase recent relationship pressure.
10. A lowered test USD threshold triggers warning and preflight hard stop across
    costs from both agents.
11. Private-room absence prevents delivery, history, extraction, and summaries.
12. Flag-off single-companion and reply-only behavior remains unchanged.

The harness needs structured logs containing companion, conversation, channel,
turn, charge, fatigue, and cost correlation so a failure is diagnosable.

## 17. Implementation workstreams and dependency order

### W0 — Deep cost-accounting review (`psfn-framework-cam`)

Audit and document the canonical accounting path before implementing the ICP
USD breaker. This work may proceed in parallel with contracts and availability.
It blocks only the final cost attribution/breaker slice and certification.

### W1 — ICP autonomy contracts and durable episode state (`psfn-framework-s10mc.6.1`)

Define availability, candidates, permits, conversation episodes, correlation,
reason codes, and persistence ownership. Extend shared types rather than using
untyped metadata bags. W1 blocks every implementation stream.

### W2 — Gateway availability and permit broker (`psfn-framework-s10mc.6.2`)

Add authenticated expiring availability, deterministic status reads, candidate
preflight, permit issuance/consumption, invalidation, and audit. Depends on W1.

### W3 — Target-channel initiation turn and continuity (`psfn-framework-s10mc.6.3`)

Add the outbound initiation entrypoint through the ordinary turn runtime,
including sender persistence, context/summaries, post-turn work, idempotent
delivery, and failure truthfulness. Depends on W1 and the existing W6 lane.

### W4 — Semantic model-facing surface (`psfn-framework-s10mc.6.4`)

Extend `notify`/`contact`/availability actions without exposing raw RPC. Enforce
capability and permit requirements. Depends on W1-W3.

### W5 — Autonomy source adapters (`psfn-framework-s10mc.6.5`)

Connect free time, weighted thoughts, durable intentions, foreground decisions,
and co-location thoughts to the shared candidate broker. Depends on W2-W4.

### W6 — ICP fatigue, social charge, and anti-evasion (`psfn-framework-s10mc.6.6`)

Extend current fatigue/charge policy with soft allowance, progressive social
charge, continuation evidence, closeout reserve visibility, relationship-root
pressure, and final suppression. Depends on W1 and may proceed alongside W2-W5.

### W7 — Conversation-scoped cost breaker (`psfn-framework-s10mc.6.7`)

Propagate conversation correlation into canonical model usage, aggregate both
agents, reserve/settle cost, warn, and hard-stop without affecting shards.
Depends on W0, W1, W3, and W6.

### W8 — Owner files and Garden (`psfn-framework-s10mc.6.8`)

Add strict settings, effective-state reporting, APIs, and UI for availability,
candidates, episodes, fatigue/charge/cost, reason codes, overrides, and audit.
Depends on W1-W7 contracts; UI can begin from stable API projections.

### W9 — Adversarial E2E certification and rollout (`psfn-framework-s10mc.6.9`)

Build the real two-agent harness, test every safety/continuity property, run
quality gates, stage behind explicit enablement, and conduct a live or
production-faithful shakedown. Depends on all prior workstreams.

Dependency sketch:

```text
W0 cost review -------------------------------> W7 cost breaker ----+
                                                                   |
W1 contracts -> W2 broker -> W4 tools -> W5 autonomy adapters -----+--> W8 Garden/config -> W9 E2E
      |          |           |                                     |
      +--------> W3 target-channel turn ----------------------------+
      |                                                            |
      +--------> W6 fatigue/social charge --------------------------+
```

## 18. Rollout

1. Land contracts and stores inertly.
2. Expose read-only availability/episode diagnostics.
3. Enable manual/operator-triggered test candidates only.
4. Enable target-channel initiation with deterministic model fixtures.
5. Enable one autonomy source at a time: foreground, weighted thought, free
   time, then intention/co-location-derived candidates.
6. Observe gate reasons, declined/ignored invitations, fatigue, charge, and
   cost distributions.
7. Tune owner-file policy from evidence; do not hardcode observed numbers.
8. Enable the canonical cost breaker only after reconciliation tests pass.
9. Run real two-agent shakedown with operator-visible emergency disable.
10. Keep cross-cluster transport disabled and out of this rollout.

Rollback disables new candidate/permit issuance. Existing ordinary ICP replies
remain available under current fatigue policy unless the operator disables ICP
entirely. Disabling autonomy must not corrupt or delete sessions, summaries,
episode records, or audit history.

## 19. Definition of done

ICP autonomy is complete only when:

- companions can independently form and decline outreach intentions;
- availability/status checks cause no peer/model wakeup;
- all initiation paths converge on one deterministic broker;
- one-use permits prevent arbitrary or repeated sends;
- the first message is a normal target-channel turn recorded on the sender;
- the recipient processes it as a normal attributed channel turn;
- both sides retain L0, summaries, extraction, and restart continuity;
- private-room presence windows remain intact;
- fatigue and social charge taper conversation without small arbitrary quotas;
- the configured closeout reserve works and final exhaustion suppresses;
- conversation-root state prevents channel-hop and recursive-trigger evasion;
- canonical accounting attributes both agents and enforces the ICP breaker;
- shard goal budgets are provably unaffected;
- Garden makes decisions and failures understandable without exposing private
  thought content;
- feature-off and single-companion parity hold;
- unit, integration, adversarial E2E, build, lint, settings-contract,
  repository-hygiene, and production-shape shakedown gates pass.

## 20. Explicitly deferred work

- Cross-cluster ICP authentication, discovery, routing, and revocation.
- Federation-wide presence or availability.
- End-to-end encrypted cross-cluster DMs.
- Human attention-pressure fatigue.
- Rich media/artifact transfer over ICP.
- Automatic peer memory/wiki mutation.
- General shared workspace collaboration.
- Replacing the global cost-accounting system beyond changes required by its
  separate review.
- Applying the ICP social cost ceiling to shards, subagents, or human chat.
