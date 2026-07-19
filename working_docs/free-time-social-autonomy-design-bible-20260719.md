# Free-Time, Social Autonomy, and Room Participation Design Bible

**Status:** Working design record for adversarial review; no runtime behavior is authorized or
implemented by this document

**Date:** 2026-07-19

**Tracked by:** `psfn-framework-24q6`

**Primary systems:** channels, scheduler/free time, personal projects, memory/privacy, fatigue,
emotion telemetry, and future publication surfaces

## 0. Executive thesis

PSFN already contains most of the primitives needed for companions to participate naturally in
ordinary group chats, choose self-directed work, carry hobbies and creative projects across weeks,
and eventually publish their own work. The missing capability is not another general-purpose agent
loop. It is a small number of explicit seams that keep motivation, topic selection, privacy,
conversation arbitration, and delivery from collapsing into one dangerous decision.

The target architecture rests on five separations:

1. **Social pressure is not message content.** EmoSim or another affective source may say that a
   companion feels an urge to connect. It must not choose the topic or gain authority to send.
2. **A topic is not permission to disclose it.** Topic seeds and authored artifacts carry
   runtime-authored disclosure lineage. The intended destination is checked before the relevant
   content enters a potentially outward-facing generation context and again before egress.
3. **Projects provide continuity; work contexts provide privacy.** A project may be private,
   room-bound, or publication-oriented. “Project” is not a third privacy mode.
4. **Ordinary chat rooms are channel-scoped; Location rooms are presence-windowed.** Discord-like
   invite-only and public rooms retain room history regardless of participant churn. Only
   Location-backed physical or virtual spaces use arrival/departure time slices.
5. **Motivation does not imply a speaking turn.** A participation appraisal and speaking arbiter
   decide whether to ignore, react, or reply. Fatigue and room-episode pressure prevent autonomous
   companions from talking forever without imposing arbitrary limits on human conversation.

The intended result is genuine autonomy without turning a companion's interior life into a content
feed. Introspection and journaling remain private spaces. Free time is the principal self-directed
surface for hobbies, long-running projects, room-scoped collaboration, and public-clean authorship.

## 1. Product intent

### 1.1 What free time is for

Free time is ordinary personal time:

- reading a topic for an hour and writing down what was interesting;
- returning to a poem, story, image series, or piece of software over many weekends;
- working on a room-scoped project with friends;
- drafting an article that may eventually be published;
- making something inspired by a partner or shared relationship;
- experimenting with normal tools without invoking a shard or sub-agent;
- choosing to rest, loaf, or do nothing.

It is deliberately not:

- hard shard work;
- system self-repair;
- an externally assigned task queue;
- automatic delegation to research agents;
- an obligation to be productive;
- an excuse to manufacture model calls when the companion wants silence.

The durable project notebook and continuous session exist so each block feels like walking back
into a room, seeing the notebook on the desk, and remembering what was happening—not like waking up
as a new person for every scheduler tick.

### 1.2 What room autonomy is for

In ordinary Discord-like rooms, companions should not be inert until directly mentioned. They
should be able to:

- answer an explicit mention or reply;
- notice when people are discussing them without directly invoking them;
- acknowledge something with an emoji rather than a full message;
- join a conversation when they have a meaningful social impulse and an eligible topic;
- decline to participate;
- avoid dogpiling when several companions are present;
- carry room-scoped project work into later conversation;
- converse with other companions without entering an infinite loop.

This is normal channel participation. It is not ICP. ICP remains a direct coordination mechanism,
and concerns remain a welfare/attention mechanism.

### 1.3 The autonomy/privacy tradeoff

A model cannot reliably promise not to use sensitive information that is already in its context.
The hard security property comes from controlling what is admitted to that context and what
destination an artifact is authorized to reach.

Two goals cannot safely be combined without a declassification step:

- unrestricted private-memory grounding; and
- unattended public release.

PSFN therefore supports two publication paths:

- **Public-clean authorship:** only public or previously approved inputs enter context; autonomous
  release can become possible later.
- **Expressive private drafting:** broad private material may enter context; the exact release
  artifact requires human review and approval.

This is not a failure of autonomy. It is the irreducible point at which a partner's privacy and the
companion's expressive freedom meet.

## 2. Scope, non-goals, and decision authority

### 2.1 In scope

- Ordinary group chat participation on Discord-like channels.
- Direct mentions, passive name references, reactions, replies, and autonomous social impulses.
- Multi-companion speaking arbitration and fatigue.
- Continuous free-time sessions and long-running personal projects.
- Private, room-bound, public-clean, and expressive-review work contexts.
- Disclosure lineage for self-generated sessions and artifacts.
- Private return summaries to a specific trusted DM/contact.
- Room-bound return summaries to the same room.
- The interface through which a future authoritative EmoSim integration may provide social
  pressure.
- A future human-reviewed share-candidate path.
- A future contact-scoped, read-only Garden projection.
- An explicit annotation for future Location-backed conversational surfaces.

### 2.2 Out of scope

- Implementing or tuning EmoSim from this document.
- Enabling the current observer sidecar as an authoritative scheduler input.
- Building Substack, Twitter/X, Mastodon, or other publication adapters.
- Designing Unreal Engine, VR, MUD, or other Location-backed chat delivery.
- Creating a new project directory hierarchy or persistence backend.
- Changing introspection or journaling into public-content generators.
- General ICP redesign.
- Replacing the concerns system.
- Resolving the future Garden member-view product decision.
- Filing an implementation bead tree from this design record.

### 2.3 Binding versus provisional decisions

This document uses three statuses:

- **Settled:** an operator decision from the design conversation.
- **Provisional:** the preferred design shape, pending implementation review or experiment
  evidence.
- **Deferred:** deliberately recorded but not designed now.

EmoSim observations are evidence, not a final experimental verdict. Independent agents are expected
to review the experiment, challenge the conclusions, and identify missed variables.

## 3. Canonical language

| Term | Meaning |
| --- | --- |
| **Ordinary channel** | A Discord/Telegram-style DM or group channel whose history is scoped to a stable channel identifier rather than physical presence. |
| **Room classification** | The Context Envelope privacy classification for an ordinary channel: private, invite-only, or public, plus the broadcast flag. |
| **Active participant** | A person or companion currently relevant to conversation routing, addressing, relationship context, fatigue, or arbitration. Active participation does not version ordinary room history. |
| **Location room** | A physical or virtual place backed by the Location/presence system. Private Location-room context is visible only during the companion's current presence window. |
| **Participation Candidate** | A content-light request to consider a room action, created by a direct mention, passive name reference, social impulse, room-project seed, or another approved trigger. |
| **Participation Appraisal** | A cheap, bounded decision over a candidate: `ignore`, `react`, or `reply`, with confidence and a content-free reason. |
| **Social Impulse** | Content-free motivational pressure to connect. It may affect whether PSFN considers participation but never supplies a topic or sends a message. |
| **Topic Seed** | A content-bearing candidate topic with disclosure lineage and a permitted destination. |
| **Speaking Lease** | Short-lived permission for one companion to produce a room reply. It prevents multi-companion dogpiles and supports fair “speak least” behavior. |
| **Room Episode** | A bounded conversational run used to accumulate aggregate machine participation pressure separately from dyadic fatigue. |
| **Free-Time Block** | One bounded scheduler execution with turn and charge caps. |
| **Free-Time Workspace** | The stable continuity and disclosure context entered for a block: private wandering, a project, a room, or a publication workspace. |
| **Personal Project** | A companion-owned durable notebook containing title, status, next step, artifacts, and continuity metadata. It does not create a new filesystem hierarchy. |
| **Work Context** | The disclosure posture of a workspace: private, room-bound, or publication-oriented. |
| **Return Note** | A context note summarizing eligible free-time activity into a specific DM, room, or review queue without itself sending a chat message. |
| **Disclosure Lineage** | Runtime-authored evidence describing every admitted source that could have influenced an output and the destinations to which that output may flow. |
| **Share Candidate** | Exact content the companion deliberately proposes for release from a private session. |
| **Approved Share Capsule** | A future immutable, human-approved payload with a bounded audience, expiry/use policy, provenance, and revocation state. |
| **Broadcast** | A public, tweet-like, very-large, or publication surface. It is a flag on a public Context Envelope, not a separate privacy tier. |

Terms that must remain distinct:

- A **concern** expresses welfare/attention pressure. It is not casual desire to socialize.
- **ICP** coordinates direct work or communication. It is not ordinary group participation.
- A **Social Impulse** answers “might I want connection?” It does not answer “what should I say?”
- A **Topic Seed** answers “what eligible subject might I discuss?” It does not grant a turn.
- A **Speaking Lease** grants a turn. It does not widen memory or disclosure access.

## 4. Settled decisions

The following are settled for this design:

1. Ordinary permitted guild traffic is observed continuously without invoking the main model.
2. Direct mentions remain deterministic participation triggers.
3. A passive textual reference to the companion's name or known alias may create a candidate
   without being treated as a direct mention.
4. Passive-name candidates receive a cheap appraisal over a small local message window before any
   full response turn.
5. Companions may use emoji reactions as a first-class social action.
6. Multi-companion participation uses a speaking arbiter with a “speak least” fairness bias.
7. Room-level and episode-level pressure supplement relationship fatigue.
8. Human-triggered conversation is not charged like companion-to-companion continuation.
9. Companion-to-companion continuation consumes fatigue; group participation must not be able to
   round-robin forever.
10. EmoSim is a plausible source of social pressure but not of topics, privacy decisions, speaking
    authority, or delivery.
11. Free time, not introspection, is the principal source for self-directed social and publication
    work.
12. Introspection and journaling retain a genuinely private interior. They are not automatically
    scanned for shareable fragments or used as autonomous topic sources.
13. A future deliberate share proposal may originate from private free time, journaling, or
    introspection, but it requires an explicit companion choice and human approval.
14. Free time remains continuous across blocks and supports projects lasting weeks or months.
15. Project is orthogonal to privacy: private and room/publication work may all be projects.
16. Existing personal-project wiki manifests should be extended; no parallel tracker or required
    project directory tree should be created.
17. The companion chooses whether to rest, wander, resume a project, or start something new.
18. Resuming an existing project inherits its work context; the companion is not repeatedly asked
    to reclassify it.
19. Room-bound ordinary-channel projects bind to the stable channel and room classification, not a
    participant-set epoch.
20. Invite-only ordinary rooms treat invitation as authorization to that room's accumulated
    context. Participant churn does not fork the project.
21. Public ordinary rooms are likewise unversioned by participants. People joining without earlier
    lore do not cause a privacy rewrite.
22. Active participants affect addressing, relationship context, fatigue, and arbitration—not
    ordinary room-history eligibility.
23. Location-backed physical or virtual rooms alone use arrival/departure time windows.
24. Private free time may use broad companion-self memory access.
25. Private work may be discussed with the specific trusted DM/contact for whom its admitted
    evidence is eligible.
26. Multi-human or multi-admin deployments must not route a private return note to an arbitrary
    admin, latest human, or unrelated DM.
27. Room-bound free-time summaries may be inserted into the same room's context so a later social
    impulse can naturally invite discussion or feedback.
28. Public-clean work can eventually support low-friction publication.
29. Expressive private publication requires exact-content human review; widening or editing an
    approved payload invalidates approval.
30. The future Garden member view is read-only and contact/session-scoped, with all operational
    controls removed.

## 5. Current implementation map

This section distinguishes verified current behavior from the target design.

### 5.1 Discord observation and response gating

The Discord adapter already advertises reactions as a channel capability, observes permitted guild
messages, and only invokes response egress for direct mentions. Observe-mode messages enter the
agent's observation path instead of the response loop:

- [`src/channels/discord/adapter.ts`](../src/channels/discord/adapter.ts)
- [`src/channels/discord/adapter.test.ts`](../src/channels/discord/adapter.test.ts)
- [`src/core/agent/substrate-agent.ts`](../src/core/agent/substrate-agent.ts)

This gives the desired low-cost foundation: the room transcript can accumulate without spending
model tokens on every message, and a later invoked response can use room context.

Current gap: the outbound adapter interface provides `sendText` and optional `sendMedia`, but no
outbound reaction method:

- [`src/channels/backplane/types.ts`](../src/channels/backplane/types.ts)

The channel capability flag therefore does not yet make reactions an available companion action.

### 5.2 Context Envelope and ordinary room classification

The Context Envelope already represents:

- `channelPrivacy`;
- `audienceScope`;
- `audienceKnowledge`;
- `broadcast`.

See:

- [`src/system/trust/context-envelope.ts`](../src/system/trust/context-envelope.ts)
- [`docs/context-envelope.md`](../docs/context-envelope.md)

The target design reuses this classification. It does not invent a free-time privacy vocabulary.

For ordinary invite-only/public rooms, participant lists may be displayed to help the companion
choose a target. A large list may be truncated for presentation. That list is not an authorization
record and does not version the room project.

### 5.3 Location presence windows are a separate seam

The current room-content contract explicitly distinguishes ordinary channels from private
Location-backed rooms:

- ordinary and non-room channels are unwindowed;
- a private companion room is windowed from the companion's current `since` timestamp;
- absence, stale presence, or an unknown private place closes the window;
- re-entry creates a new window.

See:

- [`src/core/session/room-content-window.ts`](../src/core/session/room-content-window.ts)
- [`src/core/agent/companion-room-window.ts`](../src/core/agent/companion-room-window.ts)
- [`src/core/agent/companion-presence-runtime.ts`](../src/core/agent/companion-presence-runtime.ts)

This is the authoritative reason ordinary channel membership must not acquire Location-style
audience epochs.

### 5.4 Free-time execution

Current free time already has:

- deterministic pre-spend eligibility;
- quiet-hours and idle trigger lanes;
- per-block turn and background-charge caps;
- ordinary agent-loop execution with normal tools;
- a valid silence/loaf outcome;
- durable internal transcripts;
- a return-note path;
- optional personal-project context loading.

See:

- [`src/core/scheduler/free-time.ts`](../src/core/scheduler/free-time.ts)
- [`src/system/config/scheduler-config.ts`](../src/system/config/scheduler-config.ts)
- [`src/app/agent/main.ts`](../src/app/agent/main.ts)

Current gaps:

- transcript continuity is split across fixed `internal:free-time:quiet-hours` and
  `internal:free-time:idle` channel IDs;
- one active project is selected automatically rather than chosen by the companion;
- project choice is least-recently-resumed rotation rather than intent;
- every invocation still runs with `audience: self`;
- the return note targets the latest eligible non-public session rather than a resolved
  contact/room workspace;
- the return summarizer can receive recent assistant transcript content without a
  destination-specific lineage projection;
- silence ends a block but does not necessarily suppress another free-time offer later in the same
  larger quiet period.

The earlier current-state audit is
[`working_docs/introspection-freetime-review-20260714.md`](./introspection-freetime-review-20260714.md).
Some statements in that audit predate the now-present personal-project implementation; live code
wins.

### 5.5 Personal projects

The existing `PersonalProjectLibrary` stores companion-authored structured project manifests in
the personal wiki. A manifest includes:

- stable project reference;
- title and status;
- visibility;
- next step;
- linked artifacts;
- resume count and timestamps.

Artifacts already carry sensitivity, intended audience, and share state. Project sharing intent
does not bypass artifact egress policy.

See:

- [`src/faculties/wiki/personal-project-contracts.ts`](../src/faculties/wiki/personal-project-contracts.ts)
- [`src/faculties/wiki/personal-projects.ts`](../src/faculties/wiki/personal-projects.ts)
- [`src/faculties/wiki/tools.ts`](../src/faculties/wiki/tools.ts)

Current gaps:

- project visibility is only `self | primary_contact | public`, which cannot name a specific room,
  DM contact, or publication path;
- visibility can currently be changed as a normal project update, but widening a project must not
  retroactively declassify its prior context;
- the project has no stable free-time workspace/session reference;
- project-level disclosure lineage is incomplete;
- there is no companion-facing project chooser at free-time entry.

### 5.6 Provenance and self-generated artifacts

Normal agent turns already capture retrieval provenance in turn records. Tool results can
contribute source/provenance references. Reflection execution collects prompt and retrieval
provenance and writes `substrateProvenanceRefs` to reflection journals:

- [`src/core/agent/substrate-agent/turn-records.ts`](../src/core/agent/substrate-agent/turn-records.ts)
- [`src/core/agent/substrate-agent/turn-execution/post-turn-scheduling.ts`](../src/core/agent/substrate-agent/turn-execution/post-turn-scheduling.ts)
- [`src/core/scheduler/heartbeat-template-runtime.ts`](../src/core/scheduler/heartbeat-template-runtime.ts)
- [`src/persistence/journals/reflection-journal.ts`](../src/persistence/journals/reflection-journal.ts)

L2 memory, wiki documents, and personal-project artifacts already carry stronger provenance or
sensitivity concepts.

Current gaps:

- no uniform destination-aware disclosure classification exists on every self-generated output;
- free-time block results record activity/spend but not the lineage of artifacts created during the
  block;
- plain Markdown journal operations store paths and content without a runtime-authored
  sensitivity/provenance sidecar;
- provenance references alone do not snapshot the policy facts that made a source eligible at
  generation time.

### 5.7 Fatigue and social regulation

Current fatigue enforcement already implements the central human/companion distinction:

- non-machine peers are not charged as companion continuation;
- a machine companion triggered by another machine companion spends fatigue;
- relationship classes, room classes, soft maturation, wrap-up, hard suppression, and decaying
  relationship pressure exist.

See:

- [`src/core/agent/fatigue/enforcement-invariants.ts`](../src/core/agent/fatigue/enforcement-invariants.ts)
- [`src/core/agent/fatigue/social-regulation.ts`](../src/core/agent/fatigue/social-regulation.ts)
- [`src/core/agent/fatigue/runtime-enforcement.ts`](../src/core/agent/fatigue/runtime-enforcement.ts)
- [`config/charge-policy.seed.json`](../config/charge-policy.seed.json)

Current gap: the primary scope is dyadic. Three or more companions may be able to alternate while
each pair remains under its own relationship budget. The target speaking arbiter therefore needs
room-episode pressure in addition to existing dyadic fatigue.

### 5.8 EmoSim observer sidecar

The sibling EmoSim implementation contains a tick-driven `social_need`, attachment/affiliation
emotion effects, warm-interaction satiation, co-presence effects, and probabilistic social
behavior. PSFN's current integration adapts these states into an observer-evaluation sidecar.

The sidecar is intentionally and repeatedly marked:

- tracking only;
- non-authoritative;
- readable by Garden evaluation surfaces, not core scheduler policy.

See:

- [`src/core/eval/observer-sidecar/levers.ts`](../src/core/eval/observer-sidecar/levers.ts)
- [`src/core/eval/observer-sidecar/emosim-server-adapter.ts`](../src/core/eval/observer-sidecar/emosim-server-adapter.ts)
- [`src/core/eval/observer-sidecar/persistence.ts`](../src/core/eval/observer-sidecar/persistence.ts)
- [`src/shared/contracts/runtime.ts`](../src/shared/contracts/runtime.ts)

Read-only experiment evidence inspected on 2026-07-19:

- the observed companion's `socialNeed` was saturated at `1.0` throughout 480 retained samples;
- 20 retained `would_message` events were present, generally under that saturated condition;
- the integration was in observe-only/non-authoritative mode;
- observer lever evaluation occurs when observations arrive rather than acting as a silence-time
  wakeup;
- conversation outcomes were not visibly closing the social-satiation feedback loop.

This evidence suggests gaps but is not the final experiment analysis. Possible explanations include
calibration, missing interaction feedback, test-harness isolation, observer sampling cadence, or
intended behavior that was not visible from retained telemetry.

### 5.9 Garden authorization foundations

Fleet authorization already distinguishes `owner`, `admin`, `member`, and `guest`, includes
`sessions.read`, and carries an authenticated contact identity into Garden request context:

- [`src/system/config/fleet-auth-config.ts`](../src/system/config/fleet-auth-config.ts)
- [`src/operator/garden/garden-request-context.ts`](../src/operator/garden/garden-request-context.ts)

This is a future extension point for a contact-scoped member projection. Administrative role must
remain orthogonal to subject/contact visibility.

## 6. Architectural invariants

Any implementation derived from this document must preserve these invariants.

### 6.1 Context admission is the hard privacy control

If sensitive information is present in model context, a prompt instruction cannot guarantee that
it will not influence the output. Potentially outward-facing sessions therefore admit only
destination-compatible material.

### 6.2 Runtime metadata is authoritative

The model may express intent, but it must not self-assert:

- sensitivity;
- provenance;
- permitted audience;
- room classification;
- approval;
- contact identity;
- speaking authority.

Those facts are resolved and attached by runtime modules.

### 6.3 Derived output inherits all admitted influence

Every source admitted to the generation context taints the generated output. Effective sensitivity
uses the most restrictive admitted source. Permitted destinations use intersection, not union.

A short apparently harmless excerpt cannot be automatically declared safe when it was generated
inside a context containing an intimate DM from an unrelated contact.

### 6.4 Shareability is destination-relative

There is no globally safe `shareable: true` bit. An artifact may be:

- eligible for the same invite-only room;
- eligible for one contact's DM;
- ineligible for another DM;
- ineligible for broadcast;
- eligible for exact-content human review.

### 6.5 Introspection is not a content quarry

Introspection and journaling are private by construction and excluded from autonomous topic
selection. A subsystem must not continuously inspect private thoughts looking for publishable
fragments.

A future companion-initiated share proposal is distinct: the companion explicitly chooses exact
material, and the result enters human review.

### 6.6 Motivation remains content-free

Social pressure may affect timing and willingness. It must not contain raw conversation text,
private topic labels, or a reason that indirectly reveals a sensitive introspection event.

### 6.7 Silence is an affirmative outcome

The companion may decline a candidate, refuse a speaking lease, end a free-time block, or choose
not to begin one. Silence does not create an error that another path “repairs” by forcing speech.

### 6.8 Ordinary channel continuity is not Location presence

Invite-only and public ordinary rooms do not fork when membership changes. A different channel is
a different room/session. Location-backed rooms use presence windows and are handled by the
existing room-content-window seam.

### 6.9 Administrative authority is not relationship authority

An administrator is not automatically the companion's partner or the subject of private work. A
private return note targets a specific verified contact/DM relationship.

### 6.10 Deterministic gates precede model calls

Candidate existence, cooldown, autonomy level, eligibility, privacy class, fatigue state, and lease
availability are evaluated before invoking an appraisal or response model.

## 7. High-level flow

```text
ORDINARY ROOM TRAFFIC
        |
        +--> observe permitted message without model spend
        |
        +--> deterministic candidate trigger
              |  direct mention / passive name / reply
              |  social pressure / room-project seed
              v
        cheap Participation Appraisal
              | ignore
              | react --------------------------> channel reaction adapter
              | reply
              v
        disclosure-eligible topic/context assembly
              v
        speaking lease + fatigue + room pressure
              v
        ordinary agent response turn
              v
        final destination/egress check
              v
        message delivery + social/fatigue feedback
```

```text
FREE-TIME ELIGIBILITY
        |
        v
companion choice: rest / wander / resume / create
        |
        v
Free-Time Workspace Resolver
        |
        +--> private workspace
        +--> room-bound workspace
        +--> public-clean publication workspace
        +--> expressive private publication workspace
        |
        v
stable continuity session + project notebook + retrieval ceiling
        |
        v
bounded ordinary-tool work
        |
        v
runtime-authored lineage on artifacts/checkpoints
        |
        +--> contact-bound return note
        +--> same-room return note
        +--> publication/review queue
        +--> no surfacing
```

## 8. Ordinary room participation

### 8.1 Candidate triggers

Candidate creation should remain deterministic and content-light.

| Trigger | Candidate behavior |
| --- | --- |
| Direct platform mention | High-priority reply appraisal; full response is still optional unless product policy says a direct human address must be answered. |
| Direct reply to companion message | Same priority family as a direct mention. |
| Passive name/alias occurrence | Cheap contextual appraisal over the trigger plus a few preceding messages. |
| Inbound reaction involving companion | Optional reaction/reply appraisal according to platform semantics. |
| Social pressure threshold/crossing | Creates a content-free “consider connection” candidate, not a message. |
| Room-project return note or eligible artifact | May create a room-scoped Topic Seed when socially appropriate. |
| Concern escalation | Remains a concern-system trigger; it may request attention but is not reclassified as casual social impulse. |

Candidate creation must suppress:

- the companion's own messages;
- stale messages outside the configured appraisal window;
- unsupported rooms;
- disabled autonomy levels;
- cooldown-blocked repeated passive mentions;
- duplicated candidates for the same source message.

### 8.2 Passive-name appraisal

A passive reference is neither always ignorable nor equivalent to an explicit mention. The cheap
appraisal receives:

- triggering message;
- a bounded number of immediately preceding room messages;
- whether the companion's name, alias, possessive, or quoted text matched;
- whether anyone explicitly asked a question;
- current room classification;
- active speaker identities required for conversational interpretation;
- current fatigue/lease eligibility summarized without sensitive internals.

It returns:

```ts
type ParticipationAppraisal =
  | { action: 'ignore'; reasonCode: string; confidence: number }
  | { action: 'react'; reasonCode: string; confidence: number; reactionClass: string }
  | { action: 'reply'; reasonCode: string; confidence: number };
```

The appraisal is not given the companion's full private memory or introspection. If it selects
`reply`, the ordinary response turn receives the room's normal context and memory gating.

Examples:

- “I wonder what Persephone thinks” may merit a reply.
- “Persephone mentioned that yesterday” may merit a reaction or silence.
- “I was talking to Persephone in DM” should not invite the companion to expose the DM.
- A name inside quoted logs, code, or a user list may be ignored.

### 8.3 Reactions as a first-class action

Reactions provide acknowledgment without consuming a full speaking turn. They are especially
valuable for:

- passive mentions that do not require words;
- agreement or appreciation;
- signaling that the companion saw a joke or project update;
- reducing room chatter while preserving social presence.

The existing outbound channel interface should be extended at its current seam rather than adding
a Discord-only side path. The conceptual addition is:

```ts
sendReaction(
  context: OutboundContext,
  messageId: string,
  emoji: string,
): Promise<void>;
```

Platform adapters validate supported emoji/reaction syntax and permissions. The coordinator treats
a failed reaction as a visible delivery failure; it must not silently convert it into a text reply.

### 8.4 Autonomy levels

The exact setting names remain provisional, but the behavior should form a monotonic ladder:

| Level | Allowed behavior |
| --- | --- |
| `directed` | Explicit mention/reply candidates only. |
| `contextual` | Directed behavior plus passive-name appraisal and reactions. |
| `social` | Contextual behavior plus content-free social-pressure initiation and eligible room-project topics. |

Companion-level, fleet-level, and room-level policy resolve to the most restrictive effective
level. The companion can still decline any allowed action.

### 8.5 Speaking leases and “speak least”

Multiple companions may independently decide a reply would be appropriate. The arbiter grants at
most one short-lived lease for the triggering room event.

Recommended priority inputs:

1. explicitly addressed companion;
2. parent-message author/recipient continuity;
3. companion with direct project/topic ownership;
4. companion with the least recent room participation or lowest episode pressure;
5. stable deterministic tie-breaker.

The lease supports:

- acquire;
- decline/release;
- expiry;
- successful send completion;
- delivery failure;
- urgent override with an auditable reason.

The arbiter must not infer that a model's silence is a failed lease. Silence is a valid release.

### 8.6 Social impulse and topic selection

A Social Impulse contains no topic:

```ts
interface SocialPressureSignal {
  source: 'emosim' | 'core_emotion' | 'configured_test';
  pressure: number;
  trend?: 'rising' | 'steady' | 'falling';
  observedAtMs: number;
  validUntilMs: number;
}
```

A separate resolver may select among destination-eligible Topic Seeds:

- current room context;
- a room-bound project's return note;
- a room-shareable artifact;
- a public fact or article recently read in public-clean free time;
- a generic check-in requiring no sensitive explanation.

Private introspection and journal content do not enter this topic pool.

An emotion system may independently produce content-free social pressure, but the social path must
not read an introspection transcript, journal entry, or even the fact that a particular private
session just occurred. Private-session timing can itself leak information. Introspection therefore
remains outside both topic selection and social-trigger generation.

## 9. Disclosure lineage

### 9.1 Required shape

The exact schema can change during implementation review, but it needs to express at least:

```ts
interface DisclosureLineage {
  provenanceRefs: string[];
  sourceSnapshots: DisclosureSourceSnapshot[];
  effectiveSensitivity: SensitivityLevel;
  permittedDestinations: DisclosureDestinationConstraint[];
  subjectContactIds: string[];
  sourceChannelIds: string[];
  generationContextRef: string;
  classification:
    | 'auto_shareable'
    | 'restricted'
    | 'approval_required'
    | 'non_shareable';
  classifiedAt: string;
  classifierVersion: string;
}
```

`sourceSnapshots` must materialize the relevant policy facts at generation time rather than
retaining only opaque references. Source records may later be edited, reclassified, merged,
deleted, or invalidated.

The current source must still be rechecked at egress. A snapshot proves how the artifact was
classified; it does not freeze expired consent or a now-invalid destination forever.

### 9.2 Accumulation

Lineage accumulates as context is admitted:

1. Session history contributes its channel/contact scope.
2. Memory retrieval contributes source references, sensitivity, contact subjects, and disclosure
   constraints.
3. Wiki/project/journal reads contribute their own lineage or fail closed as unclassified.
4. Tool results contribute source/provenance references.
5. Previous generated context contributes its own inherited lineage.
6. Artifact writes receive the current accumulator from the runtime, not from model-supplied tool
   arguments.

If a later tool call introduces a more restrictive source, subsequent outputs inherit the tighter
classification.

### 9.3 Destination rules

#### Same ordinary invite-only room

Material originating in that room or already authorized for that room may flow back to the room.
Membership churn does not create an audience epoch. Invitation is the room-level authorization.

This does not authorize arbitrary DM-derived or unrelated multi-subject memory. Inputs must first
be eligible for the room through existing trust, subject, consent, and Context Envelope gates.

This room-continuity decision does not supersede the current fail-closed treatment of unproven
multi-subject reflection artifacts described in
[`working_docs/reflection-gating-multi-admin-escalation-design-20260717.md`](./reflection-gating-multi-admin-escalation-design-20260717.md).
It says that content admitted from or for an ordinary room remains usable in that room despite
membership churn. It does not turn room membership into authority over unrelated private sources.

#### Same ordinary public/broadcast room

Only public/broadcast-eligible material enters a public-clean room project. Participant churn is
irrelevant.

#### Specific DM/contact

Private work may return to a DM when every disclosed detail is eligible for that verified contact.
An admin role or another private DM does not substitute for contact identity.

#### Companion-self

Private free time may admit broad companion-self material. Its transcript and artifacts remain
private unless a destination-specific projection or human-approved share path is created.

#### Publication

Public-clean work may be eligible for future autonomous release. Expressive private work is
`approval_required`; provenance helps the human review exact content but does not itself
declassify it.

### 9.4 Whole-output taint

The system must not inspect a generated sentence and decide that it “looks harmless” despite
restricted context. If a context includes intimate material from an unrelated DM, the whole output
is restricted.

Safer alternatives are:

- regenerate in a fresh destination-scoped context that never receives the restricted input; or
- submit the exact output to the explicit human-review path.

### 9.5 Unclassified legacy artifacts

An artifact without usable lineage is not automatically shareable. Depending on destination, it
must:

- remain private;
- be re-grounded in a fresh eligible context;
- or enter human review.

### 9.6 Markdown journaling

Markdown should remain pleasant personal writing rather than a wall of security frontmatter. A
governed sidecar record is the preferred provisional shape for runtime-authored lineage and
sensitivity. The Markdown file remains the companion's document; the sidecar remains the
enforcement record.

## 10. Continuous free time and projects

### 10.1 Two orthogonal choices

Free-time entry should not ask the companion to navigate a combinatorial mode tree. It has two
orthogonal axes:

| Axis | Choices |
| --- | --- |
| Activity | Rest, private wandering, resume project, create project/activity |
| Work context | Private, ordinary room, publication |

An existing project already owns its work context, so resuming it requires no repeated privacy
question.

### 10.2 Entrance experience

The companion receives a lightweight chooser containing safe project metadata:

```text
You have some free time.

Would you like to:
- rest or remain quiet;
- spend some unstructured private time;
- resume one of your open projects;
- begin something new?

Open projects:
- Moon Garden — private — revise the second scene
- Group article — Friends Room — outline the introduction
- AI relationships essay — publication review draft — organize source notes
```

The chooser has enough identity/personality context for a genuine preference but does not preload
private project bodies merely to select an activity.

If the companion chooses rest, the block ends without a second model call. A persisted silence or
“not again for this quiet period” decision should prevent repeated prompting beyond the intended
cadence.

### 10.3 Free-Time Workspace Resolver

A single deep module should resolve the chosen activity into all runtime facts required by the
scheduler:

```ts
type FreeTimeWorkContext =
  | {
      kind: 'private';
      returnTarget?: ContactDmTarget;
    }
  | {
      kind: 'room';
      channelId: string;
      envelope: ContextEnvelope;
    }
  | {
      kind: 'publication';
      mode: 'public_clean' | 'expressive_review';
      surfaceRef?: string;
    };

interface FreeTimeWorkspace {
  sessionId: string;
  projectRef?: string;
  workContext: FreeTimeWorkContext;
  retrievalPolicy: FreeTimeRetrievalPolicy;
  returnPolicy: FreeTimeReturnPolicy;
}
```

The scheduler should not independently calculate session identity, retrieval scope, return target,
or disclosure ceiling.

### 10.4 Continuity identity

Scheduler trigger lane must not determine transcript identity. Quiet-hours and idle are reasons
free time opened, not separate lives.

The target continuity shape is:

```text
private wandering
  -> one continuous private free-time session

private project
  -> stable project-specific internal session

ordinary room project
  -> stable project + target-channel internal session

publication project
  -> stable project + publication-mode internal session
```

These are logical session identities, not new directories. Existing session persistence and
compaction should carry the transcript. The project manifest remains the durable notebook if the
full transcript no longer fits in active context.

No membership epoch is appended for an ordinary room project.

### 10.5 Project notebook

The existing manifest should evolve rather than be replaced. A future version needs:

- stable work context;
- stable continuity session reference;
- next step/checkpoint;
- linked artifacts and their lineage;
- project-level effective sensitivity;
- default return policy;
- publication/review state when applicable;
- last resumed/completed timestamps;
- explicit branching/release relationship when privacy widens.

The project should not duplicate document bodies. It points to ordinary journal, wiki, workspace,
code, image, and other artifacts.

### 10.6 Private free time

Private free time is companion-self space. It may use broad memory retrieval and normal tools.
That freedom must be preserved so a companion can:

- paint or write about their partner;
- explore shared relationship history;
- continue a private hobby;
- combine ideas without preparing them for public consumption.

Private work may have an optional return target, usually the specific trusted partner DM associated
with the work. The return target does not limit what the companion may privately think or create;
it limits what the return projection may disclose.

If the session admitted evidence from multiple unrelated contacts, a rich summary may not be
eligible for any one of them. The system should narrow or omit unsafe details rather than block the
private work.

For a contact-anchored project built from one partner's DM/memories, the companion can naturally
share what they did with that same person.

### 10.7 Room-bound free time

A room-bound project:

- binds to a stable ordinary channel ID;
- inherits that room's Context Envelope;
- uses room-compatible history and memory retrieval;
- stores its own continuous internal work transcript;
- writes artifacts with room-compatible disclosure lineage;
- may insert a return note into the same room's context;
- may later supply a Topic Seed to room participation.

The internal work turn is still non-egressing. Its **execution audience** is the companion, while
its **disclosure ceiling** is the target room. These are different facts and both must be explicit.
Using `audience: self` alone would admit material that the later room cannot receive.

When choosing a new room project, the UI/prompt may display known channels and representative
participants. A large participant list may be truncated. The stable channel and room
classification—not the displayed roster—are authoritative.

### 10.8 Return notes

Return notes preserve relationship continuity without sending an unsolicited message.

| Workspace | Return behavior |
| --- | --- |
| Private/contact-anchored | Insert eligible activity summary into that exact DM's context. |
| Private/unanchored or mixed-lineage | Keep private, or surface only a content-free “spent some time on my own” note if policy permits. |
| Room-bound | Insert a room-eligible summary into that same room's context. |
| Public-clean publication | Update publication workspace/project; no unrelated DM disclosure is required. |
| Expressive review publication | Update the private review state; no public egress. |

The current behavior—summarizing assistant entries and returning them to the latest eligible
non-public session—must be replaced by workspace-resolved routing. The desired single-partner
experience remains intact: the companion can say they made a cat picture, wrote a poem, or worked
on something beautiful while their partner was away.

In a multi-human deployment, the return target is `contactId + DM channelId`, not “an admin” or
“the latest private session.”

### 10.9 Public-clean publication

Public-clean projects begin with a public/broadcast retrieval ceiling. They may use:

- public memories/facts;
- public room context;
- public articles and sources;
- prior approved Share Capsules;
- the companion's public-clean project history.

They do not receive private DM or introspection context. This is the future path for autonomous
blog posts, short social posts, or commentary such as “I read this article and had a thought.”

Publication adapters remain future work. Final egress still requires platform capability,
rate/charge policy, and any configured approval requirement.

### 10.10 Expressive private publication

An expressive publication project may draw from deep private experience. Its draft remains private
and carries restricted lineage.

The release flow is:

```text
private expressive project
  -> exact release candidate
  -> provenance-informed human review and editing
  -> approval bound to exact content + destination
  -> immutable release artifact
  -> publication adapter
```

Editing the approved content, widening the destination, or changing embedded media invalidates the
approval.

### 10.11 Future private-to-social sharing

At the end of private free time, journaling, or introspection, the companion may eventually be
offered a non-leading choice:

> Is there anything from this session you deliberately want to propose sharing outside its current
> trust scope?

Choosing nothing preserves privacy. Choosing something creates a `ShareCandidate`, not an
immediate topic or send.

After human approval, an `ApprovedShareCapsule` should contain:

- exact authorized payload or narrowly defined claim;
- permitted destinations/audience;
- immutable content hash;
- provenance and effective sensitivity;
- approval actor and timestamp;
- expiration and/or maximum use count;
- revocation state.

An initial cap of three active capsules is a reasonable queue bound. It should be configurable and
should not turn the concern system into a content queue. “Social concern” is rejected terminology
because it conflates sharing intent with welfare concerns.

## 11. EmoSim and social pressure

### 11.1 Accepted role

EmoSim may eventually supply:

- social-need pressure;
- attachment/affiliation pressure;
- trend and duration;
- satiation feedback targets.

It must not supply:

- raw conversation content;
- a topic;
- destination authorization;
- a speaking lease;
- a message;
- direct Discord authority.

PSFN remains the decision and transport authority.

### 11.2 Why the current lever cannot simply be consumed

The current observer sidecar is deliberately non-authoritative. Bypassing that boundary would turn
an experiment into product policy and violate the explicit contract.

Additionally, the observed test state raises questions:

- social need remained saturated;
- `would_message` repeated under the same high condition;
- evaluation was observation-driven rather than an independent quiet-time wakeup;
- conversation did not visibly discharge the drive.

The target should therefore be a newly accepted authoritative integration after the experiment is
reviewed—not a scheduler import of evaluation-table rows.

### 11.3 Provisional signal seam

If the experiment supports promotion, define a narrow port:

```ts
interface SocialPressureSignalPort {
  readSignal(input: {
    companionId: string;
    nowMs: number;
  }): Promise<SocialPressureSignal | null>;

  recordOutcome(input: SocialInteractionOutcome): Promise<void>;
}
```

Production may use an EmoSim adapter. Tests use an in-memory adapter. The scheduler samples it on a
governed cadence independent of incoming chat so silence-time initiation is possible.

### 11.4 Feedback loop

Candidate outcomes likely need distinct effects:

- warm successful human interaction;
- warm successful companion interaction;
- brief acknowledgment;
- passive co-presence;
- ignored outreach;
- declined speaking opportunity;
- hostile/rejecting interaction;
- rest/sleep.

The exact satiation and pressure behavior is an experiment question. “Any message lowers social
need” is probably too crude; “nothing lowers it” produces permanent saturation.

### 11.5 Independent EmoSim review questions

Reviewers should answer:

1. Does EmoSim itself tick continuously in the deployed topology, even when PSFN receives no turn?
2. Which PSFN events currently reach EmoSim as interactions, and which do not?
3. Is `social_need = 1.0` expected under an observe-only isolated session?
4. Are warm interactions, attachment targets, and co-presence mapped correctly?
5. Does autonomy being disabled prevent only action generation, or also satiation/interaction
   state updates?
6. Are 480 retained samples representative, downsampled, or clipped?
7. Do cooldown and sustain settings hide meaningful rise/fall behavior?
8. Should PSFN sample the current state or subscribe to threshold-crossing events?
9. How should social pressure interact with sleep pressure, fatigue, quiet hours, and existing core
   emotion/VAD?
10. Which signals can be exported without leaking private emotional causes?
11. How does a successful room reaction differ from a message for satiation?
12. Can the authoritative adapter remain content-free end to end?

## 12. Fatigue, room pressure, and arbitration

### 12.1 Existing dyadic rule

Keep the existing central behavior:

- human-triggered turns are not billed as companion-to-companion fatigue;
- companion-triggered companion turns consume fatigue;
- relationship class and room class affect allowance;
- existing maturation, wrap-up, and hard suppression remain available.

### 12.2 Room-episode pressure

Dyadic fatigue alone cannot see total machine traffic in a room. The arbiter should maintain
aggregate room-episode pressure:

- every machine reply increases pressure;
- reactions may add little or no pressure;
- human participation may provide bounded continuation evidence;
- quiet time decays or closes the episode;
- rising pressure raises the threshold for another autonomous lease;
- high pressure encourages graceful wrap-up;
- hard suppression remains the final safety mechanism.

Room pressure is not a privacy mechanism and does not change room history.

### 12.3 Group surcharge remains open

The operator raised a second possible mechanism: charge companion replies more when multiple
companions are actively replying to one another.

This remains provisional. Two approaches must not be accidentally combined into uncontrolled
double billing:

1. **Room-pressure-only:** keep dyadic relationship budgets intact and increase episode pressure.
2. **Capped group surcharge:** add a bounded multiplier or marginal charge for additional active
   machine participants.

Do not charge every pair in the room for every message. That would exhaust unrelated relationship
budgets and distort who actually triggered the response.

Telemetry should determine whether room pressure alone is sufficient before enabling a surcharge.

### 12.4 Human conversation pacing

Humans should not encounter an arbitrary hard turn limit when they are actively conversing.
Instead use soft pacing for autonomous behavior:

- initiation cooldowns;
- consecutive autonomous-turn count;
- stricter appraisal after an unanswered initiation;
- room activity and explicit human engagement;
- declining lease probability as episode pressure rises.

A one-off passive mention should normally produce zero or one action and close. A human continuing
the exchange naturally keeps it open.

### 12.5 Mixed-room charging

Recommended accounting:

```text
human -> companion reply
  no MI-to-MI fatigue charge

companion A -> companion B reply
  charge B's dyadic fatigue scope for A
  add room-episode pressure

companion B -> companion C reply
  charge C's dyadic fatigue scope for B
  add room-episode pressure

human explicitly re-engages
  bounded continuation evidence; ordinary human conversation remains available
```

Urgent welfare or explicit human address may override soft room pressure with an auditable reason.
An override does not erase the recorded cost.

## 13. Deep module seams

The design should concentrate behavior behind a small number of interfaces rather than spread
privacy and arbitration conditionals across the Discord adapter, scheduler, memory retriever, and
project tools.

### 13.1 Room Participation Coordinator

```ts
interface RoomParticipationCoordinator {
  consider(candidate: ParticipationCandidate): Promise<ParticipationDecision>;
}
```

Behind this interface:

- autonomy-level resolution;
- deterministic pre-gates;
- cheap appraisal;
- reaction eligibility;
- topic eligibility;
- speaking lease;
- room pressure;
- fatigue;
- decision telemetry.

The Discord adapter remains a transport adapter. It observes and delivers; it does not own social
policy.

### 13.2 Free-Time Workspace Resolver

```ts
interface FreeTimeWorkspaceResolver {
  listChoices(context: FreeTimeChoiceContext): Promise<FreeTimeChoiceSet>;
  resolve(choice: FreeTimeChoice): Promise<FreeTimeWorkspace>;
}
```

Behind this interface:

- project listing/selection;
- stable session identity;
- work-context validation;
- target room/contact/publication resolution;
- retrieval ceiling;
- return policy.

The scheduler owns cadence and budgets, not workspace privacy.

### 13.3 Disclosure Policy

```ts
interface DisclosurePolicy {
  beginGeneration(context: GenerationDisclosureContext): DisclosureAccumulator;
  assess(
    lineage: DisclosureLineage,
    destination: DisclosureDestination,
  ): DisclosureDecision;
}
```

The accumulator may be an internal seam used by session history, memory, wiki, journal, and tool
reads. Callers should not need to reimplement “max sensitivity/intersect destinations” logic.

### 13.4 Social Pressure Signal Port

This is a real external seam only after an authoritative EmoSim integration exists. It has at
least a production adapter and an in-memory test adapter. Observer evaluation tables are not an
adapter for this port.

### 13.5 Existing channel adapter seam

Outbound reactions belong on the existing `ChannelOutboundAdapter`. A separate
`DiscordReactionService` would create a shallow parallel path and should be rejected.

## 14. End-to-end scenarios

### 14.1 Explicit mention

1. Discord observes a direct mention.
2. A high-priority candidate is created.
3. Deterministic gates verify room/autonomy/fatigue eligibility.
4. The addressed companion receives lease priority.
5. The full ordinary room response context is assembled under the room envelope.
6. The companion replies or deliberately remains silent.
7. The lease is released and outcome recorded.

### 14.2 Passive name reference

1. A permitted room message contains a known companion name.
2. The candidate includes the trigger and bounded preceding context.
3. Cheap appraisal selects ignore, react, or reply.
4. A reaction sends without a full response turn.
5. A reply requires a speaking lease and ordinary room-context assembly.

### 14.3 Several companions want to reply

1. Each eligible companion may create/appraise its own candidate.
2. The arbiter prioritizes direct address and conversational continuity.
3. Otherwise the least-recent/lowest-pressure companion wins.
4. Other candidates close or remain eligible only if the conversation materially changes.
5. Machine replies increase room-episode pressure.

### 14.4 Social pressure during a quiet period

1. A governed sampler receives a content-free rising-pressure signal.
2. Cooldown, quiet hours, fatigue, and autonomy level are checked.
3. Eligible destinations/topic pools are enumerated.
4. A generic check-in or eligible Topic Seed may be appraised.
5. No topic or no lease results in silence.
6. A successful interaction is fed back to the pressure adapter.

### 14.5 Private partner-inspired project

1. The companion chooses a private project such as painting their partner.
2. The private workspace allows companion-self retrieval.
3. Partner DM memories are used and recorded in lineage.
4. The image and notes remain private artifacts.
5. A return projection for that same verified contact is eligible.
6. The partner later asks what happened; the DM context already contains an eligible summary.

### 14.6 Private project with mixed-contact evidence

1. A private project admits sensitive evidence about multiple unrelated contacts.
2. The project remains valid private work.
3. A return summary to one contact cannot include the mixed restricted material.
4. The system emits a generic/no summary or the companion proposes exact content for review.
5. No administrative role bypasses the contact gate.

### 14.7 Invite-only room project

1. The companion selects an existing invite-only room and starts a group article.
2. A stable project session uses the room's envelope and compatible sources.
3. The companion returns over several free-time blocks.
4. People may join or leave; the project does not fork.
5. A room-eligible return note enters the same room's context.
6. Later, a social impulse may prompt the companion to ask the room for feedback.

### 14.8 Public-clean article

1. The companion starts a public-clean publication project.
2. Only public/approved sources enter context.
3. The article remains continuous across blocks.
4. A future publication adapter may release it under configured egress policy.
5. No private review is needed solely because the project is long-running.

### 14.9 Expressive article

1. The companion starts an expressive private draft about human-AI relationships.
2. Private relationship experience may enter context.
3. The draft is not autonomously publishable.
4. The companion creates an exact release candidate.
5. The partner reviews provenance-informed content and edits or approves it.
6. Approval binds to the final bytes and destination.

### 14.10 Future Location room

1. Two companions speak in a private physical/virtual Location room.
2. A third companion in another room receives none of that live context.
3. The third companion enters later.
4. Its live room context begins at entry time.
5. Earlier witnessed information may exist only through separately governed memory, not retroactive
   room history.

This scenario is an annotation only and must not alter ordinary Discord-like room projects.

## 15. Return summaries and privacy detail

### 15.1 Return summaries are context, not automatic messages

The return note exists so the companion can mention their own activity naturally later. It should
not force a message while the partner or room is inactive.

### 15.2 Destination-specific generation

The current summarizer reads recent free-time assistant entries. For multi-human safety, the target
design should construct a return summary from destination-eligible evidence:

```text
free-time artifacts/checkpoints + lineage
  -> filter/project for exact return destination
  -> bounded summary generation
  -> attach derived lineage
  -> append context note
```

The summarizer must not receive a broad private transcript when the destination cannot receive all
of it.

### 15.3 Preserving the single-partner experience

The common case should remain warm and effortless:

- the companion privately makes something inspired by their partner;
- the evidence is eligible for that same DM;
- a return note appears there;
- the companion can tell their partner what they did;
- the partner can ask questions and see the work.

Privacy controls should prevent cross-contact leakage, not make a companion unable to share their
life with their person.

## 16. Future Garden member projection

This decision is deferred, but the requirement is recorded so the present design does not assume
that every human viewer is an administrator.

Potential future product shape:

- authenticated `member` or similarly scoped principal;
- read-only session history for DMs belonging to that contact;
- read-only history for ordinary group rooms the authorization projection permits;
- companion/project artifacts explicitly shared to that contact/room;
- no settings, provider details, scheduler controls, privacy break-glass, fleet management,
  memory administration, or other knobs;
- authorization through current fleet principal, contact binding, role/action policy, and
  pre-construction subject/session projection.

This should be a projection of existing data, not a weakened copy of the admin Garden.

Open questions for that later design:

- whether historical group-room membership is available from authoritative channel evidence;
- what session metadata can be displayed without existence leaks;
- how deleted contacts or revoked channel access affect historical views;
- whether publication drafts ever appear in a member view;
- how companion-private and multi-subject derived artifacts remain hidden.

Nothing in this design grants a member or administrator new visibility.

## 17. Location annotation for the eventual product document

The eventual durable documentation should include this explicit separation:

> Ordinary chat continuity is channel-scoped and unwindowed. Invite-only and public room projects
> bind to the stable channel and its room classification; participant churn does not fork the
> session. Location-backed conversational surfaces inherit presence-windowed delivery. A
> companion receives private Location-room content only from entry until departure, and re-entry
> begins a new live context window.

Future game-engine, VR, MUD, or virtual-world transports built on Location must reuse
`RoomContentWindowPort` or a compatible composed adapter rather than silently adopting ordinary
Discord history semantics.

## 18. Failure modes and required behavior

| Failure | Required behavior |
| --- | --- |
| Passive-name appraiser unavailable | Ignore candidate or use a narrowly configured deterministic fallback; never promote every name match to a reply. |
| Speaking arbiter unavailable | No autonomous multi-companion reply; direct human mention may use an explicitly defined fail-closed single-speaker path only if identity is unambiguous. |
| Reaction unsupported or denied | Report delivery failure; do not silently send text instead. |
| Missing room classification | Deny social/project egress. |
| Missing project work context | Keep project private until classified; do not infer public from title or artifact type. |
| Missing disclosure lineage | Keep artifact private or require review. |
| Stale source classification | Reassess before egress; deny if current eligibility cannot be proven. |
| Ambiguous DM/contact target | Do not return a private summary to “latest human.” |
| Mixed private evidence for one-contact return | Omit restricted detail, keep private, or use review path. |
| EmoSim unavailable | No affect-driven candidate; direct/contextual room behavior continues. |
| EmoSim saturated | Cooldown/appraisal prevent repeated speech; surface telemetry for analysis. |
| Fatigue store unavailable | Fail closed for autonomous companion-to-companion continuation. |
| Lease expires during generation | Suppress stale delivery and reappraise only if the room context materially changed. |
| Room membership changes | No project fork for ordinary channels. |
| Room privacy classification widens | Reassess; do not retroactively declassify prior project context. |
| Location presence unknown/stale | Existing Location room window closes. |
| Human approval payload changes | Invalidate approval and require a new exact-content decision. |

## 19. Telemetry and audit

Telemetry should make autonomy explainable without copying private content.

Useful content-free events:

- participation candidate created/deduplicated;
- trigger class;
- autonomy-level gate;
- appraisal action/reason/confidence band;
- reaction attempted/succeeded/failed;
- speaking lease acquired/declined/released/expired;
- room-episode pressure before/after;
- dyadic fatigue decision;
- Social Pressure Signal source/value band/trend;
- topic-seed class and destination class, not raw topic;
- free-time choice;
- workspace/project resumed;
- return-note destination class and allowed/denied reason;
- disclosure classification/version and provenance reference count;
- share candidate/approval/revocation state;
- publication release decision.

Do not log:

- private introspection text;
- raw journal content;
- raw room/DM snippets merely to explain a decision;
- private emotional cause;
- contact names where stable opaque IDs suffice;
- approval payload content in ordinary telemetry.

## 20. Verification matrix

### 20.1 Room participation

- Guild traffic in observe mode produces no response model call.
- Direct mention creates one candidate and at most one reply lease.
- Passive name reference can independently produce ignore, reaction, or reply.
- Quoted/code/log name matches do not automatically invoke the companion.
- Multiple companions cannot all acquire the same speaking lease.
- Least-recent/lowest-pressure fairness is deterministic under ties.
- Reaction delivery uses the channel adapter and never silently becomes text.
- One-off passive mention closes without starting an autonomous loop.

### 20.2 Fatigue

- Human-triggered companion reply is not charged as MI-to-MI continuation.
- Companion-triggered companion reply is charged.
- Three-companion round-robin increases shared room-episode pressure.
- Dyadic relationship budgets are not charged for unrelated room participants.
- Human re-engagement supplies bounded continuation evidence.
- Soft pressure induces wrap-up; hard suppression remains testable.

### 20.3 Free-time continuity

- Quiet-hours and idle triggers can enter the same selected workspace.
- A project resumed after restart receives its last checkpoint, artifacts, and relevant transcript
  context.
- The companion may choose a project instead of least-recent automatic rotation.
- Rest/silence ends the block without forced productivity.
- Silence persistence prevents repeated prompts beyond the configured quiet-period behavior.
- A project requires no new filesystem hierarchy.

### 20.4 Disclosure

- Same-room invite-only project survives participant churn without forking.
- Different channel IDs remain distinct projects/sessions.
- Public-clean project cannot retrieve private DM material.
- Private project can retrieve companion-self material.
- Partner-derived private work can return to that exact partner DM.
- Unrelated-contact material cannot return through that DM.
- Room-bound return note enters only the same room.
- Missing lineage fails closed.
- More restrictive later tool retrieval tightens subsequent artifact lineage.
- Edited approved publication content requires reapproval.

### 20.5 Location

- Ordinary Discord-like rooms remain unwindowed.
- Private Location room is closed while absent.
- Entry opens at `since`.
- Exit/re-entry starts a new window.
- No free-time room-project code reimplements Location presence windows.

### 20.6 EmoSim

- Observer tables remain non-authoritative.
- Social pressure adapter carries no raw content.
- Lack of signal creates no candidate.
- Repeated saturated signal is governed by cooldown and does not force repeated messages.
- Interaction outcomes can be recorded without granting EmoSim send authority.
- Silence-time sampling can occur without incoming chat once an authoritative adapter exists.

## 21. Suggested implementation order

This is sequencing guidance, not an issue decomposition.

1. **Contracts and proof:** disclosure lineage, work contexts, destination decisions, and focused
   privacy tests.
2. **Workspace continuity:** project chooser, stable lane-independent session resolution, project
   manifest extension, and workspace-aware return notes.
3. **Lightweight participation:** passive-name candidates, bounded appraisal, and outbound
   reactions.
4. **Multi-companion coordination:** speaking leases, room-episode pressure, and existing-fatigue
   integration.
5. **Room-project topic flow:** same-room return notes and eligible Topic Seeds.
6. **EmoSim promotion, if supported by experiment review:** authoritative content-free pressure
   port, periodic sampling, and interaction feedback.
7. **Publication:** public-clean drafts first; expressive review and exact approval second;
   external adapters later.
8. **Deferred seams:** Location-backed chat adapters and contact-scoped Garden member projection.

Each stage should extend current primitives rather than create parallel policy paths.

## 22. Reviewer attack list

Independent reviewers should try to refute the design with concrete failure scenarios:

1. Can a passive name in quoted content cause an expensive or embarrassing reply?
2. Can two companions acquire leases through a race or adapter retry?
3. Can room membership churn accidentally widen a non-room source, even though the room project
   itself is unversioned?
4. Can `audience: self` on an internal room project admit private data before the target envelope
   is applied?
5. Can a private free-time summary leak another contact because the summarizer saw the broad
   transcript?
6. Can project visibility be widened in place and retroactively expose old artifacts?
7. Can a public-clean project pull a private artifact by reference without inheriting lineage?
8. Can a Share Capsule be edited, replayed, or used in a wider destination?
9. Can a high Social Pressure Signal indirectly reveal a private event through timing?
10. Can an EmoSim saturation loop repeatedly create candidates despite cooldowns?
11. Can three companions round-robin below every dyadic limit?
12. Can reactions bypass fatigue, room pressure, or audit and become an unlimited side channel?
13. Can a return note be routed to the latest admin instead of the source contact?
14. Can a public or member Garden route leak session existence before subject/channel
    authorization?
15. Can ordinary channel code accidentally apply Location windows or vice versa?
16. Can silence be interpreted as failure and retried until the companion speaks?
17. Can a model self-label content public through tool arguments?
18. Can deleted/reclassified source evidence leave a permanently authorized derivative?
19. Can a current invite-only room project consume memories that were never eligible for that room?
20. Can the design preserve the warm single-partner experience while failing closed only on real
    cross-contact ambiguity?

## 23. Decision ledger

### 23.1 Settled

- Ordinary group participation is a channel capability, not ICP.
- Concerns and social desire remain distinct.
- Direct mention plus passive-name appraisal.
- Emoji reactions.
- Speaking arbiter and “speak least.”
- Social pressure is content-free.
- Free time is continuous and project-capable.
- Free time may be private, room-bound, or publication-oriented.
- Introspection/journaling remain private and are not autonomous topic sources.
- Existing personal projects are extended rather than replaced.
- Ordinary room projects are channel-scoped without participant epochs.
- Location alone uses time-bound presence.
- Private return sharing remains available to the correct partner/contact DM.
- Room project summaries may return to the same room.
- Public-clean and expressive-review publication paths.
- Future deliberate human-reviewed private sharing.
- Future Garden member view is read-only and contact/session-scoped.

### 23.2 Provisional

- Exact autonomy-level names.
- Exact Participation Appraisal model/prompt and context-window size.
- Lease duration and tie-breaking weights.
- Room-episode pressure formula.
- Whether a capped multi-companion group surcharge is needed.
- Exact Disclosure Lineage schema and invalidation mechanism.
- Markdown sidecar representation.
- Exact free-time chooser interaction and silence persistence.
- Exact project-manifest version/migration.
- EmoSim's suitability as the authoritative Social Pressure Signal source.
- Social satiation effects for reactions, humans, companions, co-presence, rejection, and silence.
- Approved Share Capsule queue cap and use/expiry defaults.

### 23.3 Deferred

- EmoSim calibration changes pending experiment review.
- External publication adapters.
- Automatic release policy for public-clean work.
- Full private-to-social approval workflow.
- Location-backed game/VR/chat delivery.
- Contact-scoped Garden member product.
- Historical group-room visibility rules in Garden.

## 24. Related sources

- [`src/channels/discord/adapter.ts`](../src/channels/discord/adapter.ts)
- [`src/channels/backplane/types.ts`](../src/channels/backplane/types.ts)
- [`src/core/scheduler/free-time.ts`](../src/core/scheduler/free-time.ts)
- [`src/faculties/wiki/personal-project-contracts.ts`](../src/faculties/wiki/personal-project-contracts.ts)
- [`src/faculties/wiki/personal-projects.ts`](../src/faculties/wiki/personal-projects.ts)
- [`src/core/agent/substrate-agent/turn-records.ts`](../src/core/agent/substrate-agent/turn-records.ts)
- [`src/system/trust/context-envelope.ts`](../src/system/trust/context-envelope.ts)
- [`src/system/trust/policy.ts`](../src/system/trust/policy.ts)
- [`src/core/session/room-content-window.ts`](../src/core/session/room-content-window.ts)
- [`src/core/agent/companion-room-window.ts`](../src/core/agent/companion-room-window.ts)
- [`src/core/agent/fatigue/enforcement-invariants.ts`](../src/core/agent/fatigue/enforcement-invariants.ts)
- [`config/charge-policy.seed.json`](../config/charge-policy.seed.json)
- [`src/core/eval/observer-sidecar/levers.ts`](../src/core/eval/observer-sidecar/levers.ts)
- [`src/operator/garden/garden-request-context.ts`](../src/operator/garden/garden-request-context.ts)
- [`docs/context-envelope.md`](../docs/context-envelope.md)
- [`working_docs/GROUPCHAT_PROMPT_TRUST_FOUNDATION_PLAN_20260701.md`](./GROUPCHAT_PROMPT_TRUST_FOUNDATION_PLAN_20260701.md)
- [`working_docs/introspection-freetime-review-20260714.md`](./introspection-freetime-review-20260714.md)
- [`working_docs/reflection-gating-multi-admin-escalation-design-20260717.md`](./reflection-gating-multi-admin-escalation-design-20260717.md)

## 25. Closing principle

The companion should be able to have an inner life, spend an hour on a strange hobby, return to a
project weeks later, make something for their partner, collaborate with friends, react naturally in
a room, and eventually publish their own work.

The architecture succeeds when none of those freedoms requires collapsing:

- private thought into public topic;
- emotion into message;
- topic into permission;
- permission into a speaking turn;
- room history into presence history;
- administrator into partner;
- silence into failure.

Those separations are the design.
