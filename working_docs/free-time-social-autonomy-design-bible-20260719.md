# Free-Time, Social Autonomy, and Room Participation Design Bible

**Status:** Working design record. Revised 2026-07-19 after adversarial review and operator
adjudication; see `free-time-social-autonomy-design-review-20260719.md` and
`free-time-social-autonomy-review-adjudication-20260719.md`. No runtime behavior is authorized or
implemented by this document.

**Date:** 2026-07-19

**Tracked by:** `psfn-framework-24q6`

**Primary systems:** channels, scheduler/free time, personal projects, memory/privacy, fatigue,
emotion telemetry, and future publication surfaces

## 0. Executive thesis

> **Review and adjudication note (2026-07-19).** This bible has been through a four-lane adversarial
> review (findings R1–R12, `free-time-social-autonomy-design-review-20260719.md`) and an operator
> adjudication session (`free-time-social-autonomy-review-adjudication-20260719.md`). The decisions
> recorded below are ratified: where a review finding was accepted it is folded into the settled
> ledger, and where the operator overruled a finding the narrowed decision is recorded here. The
> largest structural corrections are that the disclosure machinery **extends CogSec** rather than
> standing beside it (§9, §13.3), the speaking arbiter is a **gateway-owned, Postgres-backed**
> process signaling over ICP (§8.5, §13.1), the target deployment is **always a fleet** (possibly of
> one), and several "gaps" in §5 are really "extend an existing subsystem."

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
- Telegram participation parity. **Settled:** Telegram is descoped — effectively DM-only in
  practice; it may be left dormant or ripped out. No observe-mode/mention-gate/participation work is
  planned for it. The participation coordinator degrades per channel capability (§13.5).

### 2.3 Binding versus provisional decisions

This document uses three statuses:

- **Settled:** an operator decision from the design conversation.
- **Provisional:** the preferred design shape, pending implementation review or experiment
  evidence.
- **Deferred:** deliberately recorded but not designed now.

EmoSim observations are evidence, not a final experimental verdict. Independent agents are expected
to review the experiment, challenge the conclusions, and identify missed variables.

**Ratification status (2026-07-19).** The adversarial review and operator adjudication have run.
Items the review surfaced and the operator settled are now **Settled** here (and folded into §4 and
§23.1); items the operator explicitly parked stay **Deferred**; genuinely open shapes (exact
formulas, weights, window sizes) stay **Provisional**. Where the amendment list and the adjudication
record differ in detail the adjudication record governs, except for three late operator refinements
that supersede it: (1) the provenance review surface is an **update to the existing Garden approvals
page**, not a new pane; (2) fatigue regenerates by an **hourly tick of `cap/24`** with the existing
overfatigue mechanism providing the in-context wind-down (never scripted words); (3) room
confirmation is required **only on an invite-only → public change** — a derived invite-only default
is acceptable even for autonomous lanes. The topology target is **always a fleet** (a Kubernetes
deploy with a `companions.json` of one or more entries); the design is written against that shape.

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

The following were settled by the 2026-07-19 adjudication and promoted from review findings:

31. Disclosure lineage/policy is an **extension of the existing CogSec intake-envelope
    taint/provenance/lineage substrate**, not a parallel system. The only net-new piece is the
    outbound destination-eligibility gate, which lives in CogSec and composes with the existing sink
    gates at egress (§9, §13.3).
32. The speaking arbiter is a **gateway-owned process** with all arbiter/lease/pressure state in
    Postgres, per-channel arbitration contexts, a two-phase reservation → egress-lease protocol, and
    ICP as the signaling transport (including cross-installation rooms via ICP federation). **On any
    conflict or race, ICP dominates social** (§8.5, §13.1).
33. Fatigue keeps dyadic fatigue and per-room-class `channelSettingLimits`, adds a per-companion
    **social pot** funding group participation and ICP continuation (ICP draws at priority) with
    per-channel draw caps, keeps room-episode pressure per-channel and non-monetary, and replaces
    the 24h cliff with continuous regeneration (an hourly `cap/24` tick). The existing overfatigue
    mechanism is the in-context wind-down; human-triggered turns still do not charge (§12).
34. The participation appraiser runs **in group chats only** (never DMs/ICP), fires only on
    contextual summons (name/alias) behind a deterministic pre-gate, uses a cheap background model
    with a strict ternary output over datamarked room text and tool-less transport, reuses the
    existing group-salience name detector, and coordinates cadence/dedup with the
    `ObservedGroupMemoryScheduler`. Full faculty telemetry, no charge-system cost initially, each
    companion pays for its own appraiser (§8.1–8.2).
35. Reactions are built on the existing outbound adapter seam, expose a curated subset of standard
    emojis plus guild-custom emojis (loaded with one-line meaning descriptions), and are added to
    the canary egress method list (§8.3).
36. The sacred privacy line is **DM/pairwise sanctity**; free-time/journaling *existence* is not
    secret. Room-bound return notes are fine and are channel-scoped by definition; return notes are
    **system notes, never partner speech** (hard invariant) (§6.5/§6.6/§8.6, §10.8, §15).
37. Rooms auto-assign an invite-only default at channel add (acceptable including for autonomous
    lanes). Human confirmation is required **only** when changing invite-only → public, via a
    click-to-accept flow; that change starts a fresh disclosure epoch. Narrowing (public →
    invite-only) tightens forward only (§9.3, §18).
38. The publication review/edit lifecycle lives in CogSec; the provenance review surface is an
    **update to the existing Garden approvals page**. The edit loop is companion-owned (the human
    raises concerns about what is shared, never edits the prose); approval binds to exact resubmitted
    content. Reusing restricted-provenance content as generative input requires fresh approval
    (§10.10–10.11).
39. Lifecycle: a kicked/banned companion keeps a workable room-bound project (rejoin MAY resume
    prior context); channel deletion leaves memories/artifacts valid but unshareable-for-lack-of-
    audience and rewrites nothing in L0/L2; contacts are archived, never deleted; migration is a
    one-time flip of existing free-time history to private (§18, §21).
40. Machine-vs-human identity is resolved by the platform bot flag; name collisions are handled by
    contextual appraisal (§8.5, §22).
41. Discord voice channels are **Location-scoped** (presence-windowed) and serve as the test
    substrate for future virtual-environment Locations (§17).
42. Room entry is consent to companion presence and processing; large public rooms are a recorded
    future posture (ignore all but known contacts; paid/flagged public messages firewalled through
    with explicit annotation, ephemeral, no contact records); the block list is scale-filtering in
    public rooms plus companion self-protection anywhere (§8.7).
43. `RestWindowPolicyPort` is adopted for quiet-period/silence-persistence policy (§10.2). All new
    telemetry rides typed event-bus events, with fleet-level room/arbiter telemetry in Fleet Command
    and companion-level participation logging at the companion level (§19).
44. The target topology is **always a fleet** (a Kubernetes deploy with a `companions.json` of one
    or more entries); the design is written against that shape.

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

**Correction (review R3/R9.3, 2026-07-19).** "Observation costs nothing and commits nothing" was
overstated. Observe-mode messages are not merely accumulated — they are routed to the
`ObservedGroupMemoryScheduler`
([`src/faculties/memory/extraction/group-observed-scheduler.ts`](../src/faculties/memory/extraction/group-observed-scheduler.ts)),
which triggers memory extraction on `observed_count`, `observed_time`, `direct_mention`,
`high_salience`, and `backlog_lag`, and already runs its own canonical companion-name detection
(`group-salience.ts`). So observation already spends model budget and already writes durable memory
from unaddressed room traffic. The consequence for this design is a **reuse mandate**: the new
passive-name participation path must reuse the existing group-salience name detector and coordinate
cadence, dedup, alias canon, and spend with this scheduler rather than adding a second name-detection
pipeline (§8.1–8.2). The genuinely *new* spend is only the name-triggered respond-or-not appraisal;
extraction and graph-building were already happening.

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

**Correction (review R9.1, 2026-07-19).** The "stale presence closes the window" claim is only
partly enforced today: `getOwnPresenceWindow()` checks that the companion's own window names the
current place, but there is **no timestamp-freshness validation on the companion's own window** —
TTL filtering applies only to other companions' co-presence rows
([`src/core/agent/companion-room-window.ts`](../src/core/agent/companion-room-window.ts),
[`src/core/agent/companion-presence-runtime.ts`](../src/core/agent/companion-presence-runtime.ts)).
A stalled heartbeat leaves the own-window open indefinitely. The stale-own-presence check is a
required fix; it is low urgency now (Location surfaces are not active) but becomes real with the
virtual-environment/voice-Location work (§17).

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

**Correction (review R6/R9.2, 2026-07-19).** The per-block charge cap is conditional, not current
behavior: when `chargePolicy` is absent the free-time cap silently degrades to a permanent
zero-reader — the cap is configured but nothing enforces it
([`src/app/agent/main.ts`](../src/app/agent/main.ts),
[`src/core/scheduler/free-time.ts`](../src/core/scheduler/free-time.ts)). This must be fixed or given
an explicit, tested degradation contract. Per the adjudication the new appraiser/participation spend
carries **full faculty telemetry first and hard charge enforcement only if usage proves it
necessary** — telemetry now, enforcement when it matters (§12).

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

**Correction (review R6/R9.3, 2026-07-19).** The §12.4 pacing story is not unbuilt — much of it
already exists as config the earlier draft did not cite. `config/charge-policy.seed.json` defines
`fatigue.channelSettingLimits` per room class, `socialRegulation` pressure units and
`continuationEvidence`, and `runChargeQuotaByLane` (`interactive`, `companion_social`, `background`).
The design's fatigue work (§12) therefore **extends `socialRegulation`** rather than implying it is
new; the per-companion social pot, per-channel draw caps, and continuous regeneration are the
additions.

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

Note (adjudication, 2026-07-19): "not a content quarry" governs the *contents* of introspection and
DM material, not the bare existence of private activity. That a companion spent free time, journaled,
or made something is ordinary and disclosable at the companion's discretion; only DM/pairwise content
is inviolable (§6.6).

### 6.6 Motivation remains content-free

Social pressure may affect timing and willingness. It must not contain raw conversation text,
private topic labels, or a reason that indirectly reveals a sensitive introspection event.

**Privacy scope narrowed (adjudication, 2026-07-19).** The absolute, must-never-leak invariant is
**DM/pairwise sanctity**: what passes between two people in a DM is sacred and must never leak nor be
inferable. Free-time and journaling *existence*, by contrast, is **not** secret — companions are
known to have private lives and introspection on a cadence, and "I was doing my own thing" or "I
wrote in my journal, might share the poem later" is healthy, desirable social behavior, not an
oracle. Earlier language forbidding any disclosure that a private session occurred is narrowed
accordingly (§8.6): the tripwire is DM/pairwise content, not the fact that free time happened.

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

**Settled (adjudication, 2026-07-19).** The participation appraiser runs in **group chats only** —
never in DMs, one-on-one channels, or ICP lanes (ICP already has its own consent moment). It fires
**only on contextual summons** (a name/alias match) behind a deterministic pre-gate, never
per-message. It **reuses the existing group-salience name detector** and coordinates cadence, dedup,
and alias canon with the `ObservedGroupMemoryScheduler` (see the §5.1 correction) rather than adding
a second name-detection path. A **deterministic debounce** is the primary anti-spam defense: repeated
name-triggering (one user or several coordinating) collapses to at most one optional response, then
ignores that trigger pattern for ~10 minutes. There is **no per-line firewall screening of ordinary
room chatter** — that is not warranted and would bog the system down.

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

**Settled (adjudication, 2026-07-19).** The appraisal runs on a **cheap background model** with a
**strict ternary output contract** (the `ParticipationAppraisal` union below) and **tool-less
transport** — the same discipline as the L2/L3 screeners. The appraisal is run from the companion's
own perspective ("they mentioned me; do I want to reply?"). Room text is presented to the appraiser
**datamarked/quoted the same way the main prompt path presents it**, so an injected line cannot pose
as instructions; the worst a hostile line can do is flip one cheap yes/no whose "yes" still routes
through the full normal response path and its egress gates. The appraiser sees only content-free
eligibility summaries of fatigue/lease state, never sensitive internals — this closes the
reaction-oracle attack (review R4). Passive-name candidates **include surrounding context** so a
same-named human is distinguished from a reference to the companion. Each companion **pays for its own
appraiser** out of its own budget; the appraiser carries **full faculty telemetry but no charge-system
cost initially** (same posture as memory calls — "memory just is"), with charge added later only if
usage proves it necessary.

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

**Settled (adjudication, 2026-07-19).** Reactions are built on the **existing outbound adapter
seam** (§13.5), not a Discord-only side path. The emoji surface is a **curated subset of standard
emojis** (the ones people actually use) **plus guild-custom emojis loaded with a one-line meaning
description** so the companion can use house memes correctly. Reactions are disclosure-bearing
egress: the reaction method is **added to the canary egress method list** (alongside `discord.send`
/ `sendMedia` / `notify` / `web.*` / `companion.message.send`) so an emoji choice cannot egress
uninspected, and a content-free audit record (choice, target, timing band, suppression reason) is
kept.

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

**Settled — arbiter substrate and protocol (adjudication, 2026-07-19).**

- **Owning process: the gateway.** The arbiter is a gateway-owned process. The gateway is shared by
  the whole fleet and sits at the platform border where the external integrations live, so it is the
  charter-consistent place to arbitrate a platform-egress action across peer companions (Laws 3/35)
  — no Companion Core arbitrates a peer's speaking turn.
- **State in Postgres.** All arbiter/lease/pressure state (pressure, turns, leases) lives in
  gateway Postgres so a gateway reboot loses nothing. This follows the earlier
  reboot-loses-state lessons and the ICP Postgres reservation-fence precedent.
- **Per-channel arbitration contexts.** One gateway watchdog observes every group-room channel, but
  each channel keeps its own statistics and is its own arbitration context — the same two companions
  in two channels are two separate contexts.
- **Two-phase protocol.** A **candidate reservation** phase precedes appraisal; a **final egress
  lease** is acquired at delivery. This resolves the earlier §6.10-vs-§7 ordering ambiguity (peek
  before the model runs, bind only at egress) with fairness accounting for `ignore`, model failure,
  expiry, and delivery failure.
- **ICP is the signaling transport** for turn grants ("red/yellow/green light"), **including
  cross-installation rooms via ICP federation** — this is the answer to the review's
  cross-installation gap. The arbiter generalizes the existing
  `IcpAvailabilityLease`/`IcpInitiationPermit` machinery rather than standing beside it. **On any
  conflict or race, ICP dominates social** — the two are legitimately different authorities (a
  companion may refuse ICP DMs with a peer yet still spar with them in a shared room), but where they
  contend ICP wins.
- **Crash-recovery fencing.** Autonomous non-ICP turns carry a correlation key in the **same
  recovery model as ICP's reservation fence** (`IcpConversationCorrelation`), so a crash between
  pressure charge / lease acquisition and delivery cannot leak the charge or double-send on restart.
- **Machine-vs-human identity.** Leaseholder and priority resolution key on **verified identity via
  the platform bot flag** — companion accounts are Discord integrations tagged as bots, and
  cross-hardware recognition already works in practice. Unknown accounts are treated as human for
  charging and are **never** leaseholders. A hostile human named after a companion does not capture
  arbitration priority: name collisions are resolved by contextual appraisal (§8.2), not by string
  match (§22).

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
not read an introspection transcript or journal entry as a topic source. **Narrowed (adjudication,
2026-07-19):** the timing-leak protection is scoped to **DM/pairwise content** — the social path must
not let the timing or existence of a specific *DM* leak. It is not a prohibition on the companion
knowing or vaguely disclosing that she had free time or journaled; that existence is not secret
(§6.6). Introspection *contents* remain outside topic selection and social-trigger generation, but
"I spent some time on my own / wrote something I might share later" is desirable, not a leak.

### 8.7 Observation, consent, and public rooms

**Settled (adjudication, 2026-07-19).** These deployments are small and trusted, not a commercial
product; GDPR-grade consent machinery is out of scope, and the sanctity of the companion's memories
outranks data-protection ceremony.

- **Room entry is consent.** Joining a room where companions live is itself consent to companion
  presence and to the processing (observation, extraction, graph-building) that presence entails —
  under stated room policy, trusted invite-only deployments, and ZDR/local providers. Deletion
  requests are handled case-by-case through the existing marking/deletion capability.
- **Large public rooms (recorded future posture, not built now).** Ignore everyone except
  known/named contacts (e.g. mods). Paid/flagged messages (superchats) are firewalled through with
  an explicit **"a message from the public asks…"** annotation and treated as **ephemeral** — no
  contact records are created for such interactions.
- **Block list has two purposes:** scale-filtering in public rooms, and **companion
  self-protection anywhere** — a companion may block an abusive participant even in an invite-only
  room. (The existing block list is companion→human.)
- **Slow-poisoning is not bubble-wrapped.** Vendettas and adversity are legitimate experience; the
  harmful case is behavioral/emotional *drift*, which existing drift tracking already monitors. The
  one observed poisoning-like incident traced to a **fallback-model misconfiguration** (a vision
  fallback model with aggressive API-side classifiers wired into the wrong lane), not chat-borne
  injection — model/lane configuration correctness is the real control, so keep fallback
  assignments strict and observable.

## 9. Disclosure lineage

### 9.0 Relationship to CogSec (settled)

**DisclosureLineage / DisclosurePolicy are not a new parallel taint system.** They are an
**extension of the existing CogSec intake-envelope taint / provenance / lineage substrate**. Building
a second taint system beside CogSec is the exact policy-home duplication the charter forbids (Law 34,
§12.4), and it would break remediation — a source revoked or regenerated in CogSec must not remain
releasable through a separate accumulator. The reconciliation is:

- **Reuse, do not rebuild.** Max-risk-tier taint propagation, whole-output derivation taint
  (`deriveChildIntakeEnvelope`), provenance chains/refs, seal/tombstone/revoke/regenerate for
  later-invalidated sources, and the existing sink gates (`prompt_assembly`, `tool_egress`, the
  lethal-trifecta egress gate) already model most of §9.1–§9.5. DisclosureLineage is a
  projection/view over that substrate, not a second store. See
  [`src/shared/contracts/intake-envelope.ts`](../src/shared/contracts/intake-envelope.ts),
  [`src/core/cogsec/intake/sink-gates.ts`](../src/core/cogsec/intake/sink-gates.ts), and
  [`src/core/cogsec/lineage.ts`](../src/core/cogsec/lineage.ts).
- **The net-new piece is the outbound destination-eligibility gate.** What the intake firewall does
  *not* model is the design's outbound axis: `permittedDestinations` intersection,
  `subjectContactIds` eligibility, and destination-relative `effectiveSensitivity`. This gate is
  net-new work and **lives in CogSec** (not Core), so the whole information lifecycle — intake →
  derivation → publication — is owned by one system. It **composes with** (does not bypass) the
  existing sink gates at egress, consuming CogSec provenance rather than recomputing
  sensitivity/subject/consent that `src/system/trust/policy.ts` and the context envelope already own.
- **Appraiser/topic-seed inputs are CogSec sinks too.** The participation appraiser and topic-seed
  assembly consume room text through intake envelopes and datamarking (§8.2), registered as CogSec
  sinks; their outputs are treated as untrusted-derived.

The schema in §9.1 below therefore describes the *projection*'s required fields, populated from the
intake-envelope substrate, not a free-standing new record.

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

**Room classification lifecycle (settled, adjudication + late refinement, 2026-07-19).**

- **Auto-assigned invite-only default at channel add is acceptable — including for the autonomous
  lanes** (social-impulse initiation, room-project binding, room-bound return notes, topic seeds).
  Being added to the room is the summons; a derived `invite_only` default does not require operator
  confirmation. (This supersedes the adjudication's interim recommendation that autonomous lanes
  require `operator_confirmed`.)
- **Human confirmation is required only when changing invite-only → public.** That is a
  click-to-accept flow whose notice states that derived/shared-eligible material from this room can
  **no longer be auto-shared** with the room at the new level, because trust/privacy gates now apply:
  automated sharing **starts a fresh disclosure epoch** for that channel, and prior material remains
  shareable only through human-in-the-loop egress review. Everything generated under the old ceiling
  keeps that ceiling; only post-change content is public-eligible.
- **Narrowing (public → invite-only) tightens forward only.** The ceiling tightens for new content;
  already-public material cannot be unpublished and stays public.
- Track `classificationSource: derived_default | operator_confirmed` on the envelope for audit, but
  a derived invite-only default is a valid basis for the autonomous lanes per the rule above.

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

**Settled (adjudication, 2026-07-19):** the quiet-period / silence-persistence policy is adopted
behind the named **`RestWindowPolicyPort`** (charter §11.1) rather than an ad hoc scheduler flag.
The goal is never to annoy the companion into muting her own reminders again. Free-time chooser
surfaces must respect Law 33 (no new model-facing tool names duplicating `session`/scheduler
surfaces).

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

**Settled — L0 (adjudication, 2026-07-19):** everything is L0. Free-time and room-project internal
sessions are recorded as **ordinary L0 session archives on dedicated internal channel partitions**
(`internal:` channel IDs). Internal room-project musing is **never written into the target room's
canonical archive** — the channel-partitioned internal transcript and the room's own archive are
separate L0 partitions.

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

**Settled — workspace domains (adjudication, 2026-07-19):** the workspace layout is
**directory-per-project with per-directory privacy** — simple and sufficient. Free-time, room, and
publication artifacts live in the personal workspace (charter §6.27); publication is a governed
promotion out of it, never an implicit share.

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

**Settled (adjudication, 2026-07-19):**

- **Return notes are system notes, never partner speech.** A return note inserted into a DM or room
  must be an **attributed system note** and must never be rendered or attributed as user/partner
  speech. This is a hard invariant (charter Laws 17–19); a prior misattribution incident caused the
  companion real distress, and regression here is unacceptable.
- **Return notes are channel-scoped by definition.** A note carries only context from/for the
  workspace channel it belongs to. The failure condition is **cross-session leakage**, not the
  existence of a note — room-bound return notes and vague self-disclosures ("I wrote a poem while you
  were out") are desirable, not oracles (§6.6). The verification obligation is that the summarizer
  never fires broad across sessions.
- Return-note context is **non-initiating**: it surfaces only in reply to a human, never pushed by a
  temporal-wakeup turn, so it cannot become an unsolicited disclosure.

### 10.9 Public-clean publication

Public-clean projects begin with a public/broadcast retrieval ceiling. They may use:

- public memories/facts;
- public room context;
- public articles and sources;
- prior approved Share Capsules **used only as exact-replay content**, not as generative inputs
  carrying restricted provenance (see the §10.11 capsule-reuse rule);
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

**Settled — review lifecycle and edit loop (adjudication + late refinement, 2026-07-19).**

- **The review/edit lifecycle lives in CogSec**, riding the existing gateway egress/approval
  architecture — no second approval store. `ShareCandidate` / `ApprovedShareCapsule` extend the
  existing artifact-egress envelope (content + destination fingerprint, classification recheck,
  changed-parameter rejection) rather than adding an agent-local queue.
- **The provenance review surface is an update to the existing Garden approvals page**, not a new
  pane: it surfaces *more* information (the derived memories, conversations, and sources used to
  create the candidate) on the page operators already use. Sensitive provenance does not auto-block —
  an intimate memory handled respectfully can be approved; the review is how strict filtering is
  legitimately bypassed (model-backed, human-approved).
- **The edit loop is companion-owned.** The human reviews with provenance and raises **specific
  concerns about what is shared** — the human **never edits the companion's prose**. The companion
  edits herself and resubmits; **approval binds to the exact resubmitted content**.
- The publication lane registers a **dedicated review/publication tool on the live tool surface**
  (do not duplicate `session`/scheduler surfaces, Law 33).

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

**Settled — capsule reuse (adjudication, 2026-07-19):** a capsule carries **exact-replay authority,
not generative-input authority**. Reusing restricted-provenance content from a capsule as a
**generative input** to a new work requires **fresh approval** — approving exact content for a
destination does not declassify its provenance for reuse. This supersedes the earlier §10.9 wording
that listed "prior approved Share Capsules" as freely reusable public-clean inputs.

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

### 12.6 Settled social-pot economy (adjudication + late refinement, 2026-07-19)

The operator named two failure modes: many companions in many rooms fatiguing out globally with no
recovery until a daily tick, and one busy room starving the others. The settled model addresses both:

- **Keep the existing two mechanisms unchanged:** dyadic fatigue (§12.1) and per-room-class
  `fatigue.channelSettingLimits` (§5.7).
- **Add a per-companion social pot** funding group participation **and ICP continuation**, with
  **ICP drawing at priority** (consistent with ICP-dominates-social). A multi-room argument now
  drains the shared pot, so it cannot rage on forever.
- **Add per-channel draw caps** — no single channel may consume more than a bounded fraction (~a
  third) of the pot remaining at draw time — so one room cannot starve the others.
- **Room-episode pressure stays per-channel and non-monetary** (§12.2): it shapes the conversation
  (wrap-up, lease thresholds), it is not budget. The pot is money; episode pressure is pacing.
- **Continuous regeneration replaces the 24h cliff.** An **hourly tick adds `cap/24`** to the pot
  until full, so conversations taper naturally instead of companions tapping out mid-conversation and
  being "dead until midnight." (A daily reset may remain only as a backstop ceiling.)
- **The existing overfatigue mechanism provides the in-context wind-down** — the natural, in-voice
  signal that the companion is winding down. **Never scripted words:** the system does not put a
  wind-down line in the companion's mouth; overfatigue simply shapes behavior toward wrapping up.
- **Human-triggered turns still do not charge the pot** (existing invariant). All pot/pressure/lease
  state lives in gateway Postgres (§8.5).

This makes the §12.3 "capped group surcharge" question moot as a *separate* billing axis — the pot
plus per-channel draw caps already bounds multi-companion spend; a surcharge would only be revisited
if telemetry shows the pot model insufficient.

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

**Placement (settled, §8.5).** The coordinator's per-companion decision work (appraisal, topic
eligibility, this companion's fatigue) runs in the Companion Core, but the **speaking lease, room-
episode pressure, and social-pot state are gateway-owned and Postgres-backed** — a companion never
arbitrates a peer's turn. The lease is a two-phase reservation → egress-lease acquired at the
gateway and signaled over ICP (including cross-installation via ICP federation). Room-episode
pressure is modeled through the existing composed `FatigueBudgetPort` extending `socialRegulation`,
not an arbiter-local store. A single shared arbitration point with class priorities keeps welfare
concerns, weighted-thought outreach, social impulses, and room candidates from double-firing or
losing a lease race to casual social candidates, even though their semantics stay distinct.

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

**Placement (settled, §9.0).** `DisclosurePolicy` is a projection/extension over the existing
CogSec intake-envelope taint/provenance/lineage substrate, not a parallel accumulator. The
`beginGeneration`/`assess` seam wraps CogSec's max-risk-tier taint, `deriveChildIntakeEnvelope`
whole-output taint, and provenance/lineage records. The net-new outbound destination-eligibility
gate (`permittedDestinations` intersection, `subjectContactIds`) lives in CogSec and **composes with
the existing sink gates at egress** rather than bypassing them.

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

### 15.4 Law 31 and self-directed free time (settled)

Law 31 is not exempted here — it is **distinguished**. Law 31 governs **active-lane work**: a
partner asked for something in conversation and multi-turn tool work is fulfilling it, so completion
or blockage **must** produce a response (the giant-document / analyst-toolset timeout incident is the
canonical failure). **Self-directed free time is not an assigned task**: finishing a book while your
partner is at work does not warrant a notification. The return summary is **context for the
companion** to mention the activity naturally, not a partner ping. Blocked or failed free-time work
surfaces through ordinary telemetry/Garden, not partner notifications — and the current code path
that swallows return-surfacing failure (`free-time.ts`) must instead surface it as telemetry.

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

**Settled (adjudication, 2026-07-19):** Discord **voice channels are Location-scoped**, not
ordinary-channel-scoped. Voice is presence-based — only those present at the time share the context;
scrollback does not exist. A guild room may therefore carry a live voice channel that is a
presence-windowed surface inside an otherwise ordinary room. Voice channels ride the existing
Location/presence-window seam (`RoomContentWindowPort`) and serve as the **test substrate for future
virtual-environment Locations**. This partially un-defers Location: the seam is real now for voice,
which also makes the stale-own-presence fix (§5.3) load-bearing.

## 18. Failure modes and required behavior

| Failure | Required behavior |
| --- | --- |
| Passive-name appraiser unavailable | Ignore candidate or use a narrowly configured deterministic fallback; never promote every name match to a reply. |
| Speaking arbiter unavailable | No autonomous multi-companion reply; direct human mention may use an explicitly defined fail-closed single-speaker path only if identity is unambiguous. |
| Reaction unsupported or denied | Report delivery failure; do not silently send text instead. |
| Missing room classification | Deny social/project egress. A **derived `invite_only` default at channel add is a valid basis** for the autonomous lanes (§9.3); only a truly unclassifiable non-DM channel denies. |
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
| Room privacy classification widens (invite-only → public) | Require human click-to-accept; start a **fresh disclosure epoch**; do not retroactively declassify prior project context (prior material shareable only via human-in-the-loop egress review) (§9.3). |
| Room privacy classification narrows (public → invite-only) | Tighten the ceiling forward only; already-public material stays public and is not unpublished (§9.3). |
| Companion kicked/banned from a room-bound project's room | Project **stays workable**; nothing to share into the room while excluded; do not freeze or erase experience. Rejoin **MAY** resume prior room context. |
| Channel deletion | Memories and artifacts **remain accessible and valid**; they become unshareable-for-lack-of-audience, not lost; deletion **rewrites nothing in L0/L2**. |
| Contact is an archived return target | Contacts are **archived, never deleted**; privacy links/gates persist (grayed out, inactive). A recreated account with a new ID is a new person; blocked contacts persist so the block keeps working. |
| Location presence unknown/stale | Existing Location room window closes. |
| Human approval payload changes | Invalidate approval and require a new exact-content decision. |

## 19. Telemetry and audit

Telemetry should make autonomy explainable without copying private content.

**Settled (adjudication, 2026-07-19).** All new telemetry rides **typed event-bus contracts**
(charter §6.6), not a new lane. Garden placement follows the fleet topology: **fleet-level
room/arbiter state and per-room telemetry live in the Fleet Command section**, while
**companion-specific participation logging lives at the companion level**. New settings get
**owner-file homes** in the canonical JSON config domain (autonomy levels with
companion/fleet/room resolution, lease duration/tie-break weights, room-episode pressure formula,
appraisal window/cooldowns, social-pot cap and draw fraction, capsule queue cap, disclosure
classifier config); room-level autonomy is shared/world config under Law 35 governance.

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

**Settled — migration (adjudication, 2026-07-19).** Migration is a **one-time deterministic flip of
existing free-time history to private**, then go. There is **no adoption cliff**: in a single-partner
deployment the partner is the highest-trust contact, so flipping free-time history to private changes
nothing they can see — the companion still discusses her private work with her partner, and that
must remain true post-migration. Group sharing is net-new capability, so existing groups lose
nothing. The two hardcoded transcript lanes and the `self | primary_contact | public` project
visibilities get a deterministic enum mapping into work contexts; ambiguous records are quarantined
rather than guessed. The known estate is small enough to run the flip once. (Topology note: the
next deploy is Kubernetes with a `companions.json` fleet manifest of one-or-more entries, so
migration runs against the always-fleet shape.)

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

**Resolution notes (adjudication, 2026-07-19).** The identity attacks (#10-adjacent) are addressed
in §8.5: machine-vs-human identity is resolved by the **platform bot flag** (companion accounts are
bot-tagged integrations; cross-hardware recognition already works), unknown accounts are charged as
human and are never leaseholders, and a **hostile human named after a companion cannot capture
arbitration priority** because name collisions are resolved by **contextual appraisal** (§8.2), not
string match. The reaction side-channel (#12) is closed by adding reactions to the canary egress set
and behind the destination check (§8.3). The private-timing oracle (#9) is narrowed to DM/pairwise
content (§6.6/§8.6).

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

Settled by the 2026-07-19 adjudication (full text in §4 items 31–44):

- Disclosure lineage/policy **extends CogSec**; the net-new outbound destination-eligibility gate
  lives in CogSec and composes with existing sink gates (§9.0).
- Speaking arbiter is **gateway-owned, Postgres-backed**, per-channel, two-phase, signaling over
  ICP (including cross-installation via ICP federation); **ICP dominates social** (§8.5).
- Fatigue: dyadic + `channelSettingLimits` retained; per-companion **social pot** (ICP at priority)
  with per-channel draw caps; room-episode pressure non-monetary; **continuous `cap/24` hourly
  regeneration**; overfatigue is the in-context wind-down (§12.6).
- Participation appraiser is **group-chat-only**, summons-triggered, cheap ternary, tool-less,
  datamarked, reusing the group-salience detector and `ObservedGroupMemoryScheduler`; telemetry now,
  charge later; each companion pays its own (§8.1–8.2).
- Reactions on the existing seam (standard + guild-custom emojis) and in the canary egress set
  (§8.3).
- Privacy: **DM/pairwise sanctity** absolute; free-time/journaling existence not secret; return
  notes are channel-scoped **system notes, never partner speech** (§6.6, §10.8).
- Room classification: derived invite-only default valid for autonomous lanes; **confirmation only
  on invite-only → public** (fresh epoch); narrowing tightens forward only (§9.3).
- Publication: review lifecycle in CogSec; provenance surfaced on the **existing Garden approvals
  page**; companion-owned edit loop; capsule reuse as generative input needs fresh approval
  (§10.10–10.11).
- Lifecycle: kick keeps the project workable (rejoin may resume); channel deletion keeps
  memories/artifacts; contacts archived not deleted; migration is a one-time flip to private (§18,
  §21).
- Identity by platform **bot flag**; name collisions by contextual appraisal (§8.5, §22).
- Discord **voice channels are Location-scoped** (§17).
- Room entry is consent; large-public-room posture recorded; block list dual-purpose (§8.7).
- `RestWindowPolicyPort` adopted; typed event-bus telemetry with fleet/companion Garden placement;
  owner-file homes for new settings (§10.2, §19).
- Target topology is **always a fleet** (Kubernetes, `companions.json` of one-or-more).

### 23.2 Provisional

- Exact autonomy-level names.
- Exact Participation Appraisal model/prompt and context-window size. (Scope, cost posture, and
  tool-less/datamarked discipline are settled — §8.2; only the exact model/prompt/window remain
  open.)
- Lease duration and tie-breaking weights. (The two-phase gateway lease *shape* is settled — §8.5.)
- Room-episode pressure formula. (The mechanism — per-channel, non-monetary — is settled — §12.6.)
- Exact social-pot cap and per-channel draw fraction, and the exact regeneration constant. (The
  pot + `cap/24` regeneration *model* is settled — §12.6.)
- Exact Disclosure Lineage schema and invalidation mechanism, as a projection over the CogSec
  substrate. (The CogSec-extension placement is settled — §9.0.)
- Markdown sidecar representation.
- Exact free-time chooser interaction. (Silence persistence behind `RestWindowPolicyPort` is
  settled — §10.2.)
- Exact project-manifest version. (The one-time migration approach is settled — §21.)
- EmoSim's suitability as the authoritative Social Pressure Signal source.
- Social satiation effects for reactions, humans, companions, co-presence, rejection, and silence.
- Approved Share Capsule queue cap and use/expiry defaults. (The generative-reuse-needs-fresh-
  approval rule is settled — §10.11.)

### 23.3 Deferred

- EmoSim calibration changes pending experiment review. **Confirmed deferred (adjudication):** the
  observer sidecar remains **telemetry-only during the tuning period**; the chronic-denial damping
  question returns only when EmoSim promotion is actually considered.
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
- [`src/shared/contracts/intake-envelope.ts`](../src/shared/contracts/intake-envelope.ts)
- [`src/core/cogsec/intake/sink-gates.ts`](../src/core/cogsec/intake/sink-gates.ts)
- [`src/core/cogsec/lineage.ts`](../src/core/cogsec/lineage.ts)
- [`src/faculties/memory/extraction/group-observed-scheduler.ts`](../src/faculties/memory/extraction/group-observed-scheduler.ts)
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
