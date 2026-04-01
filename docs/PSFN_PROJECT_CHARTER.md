# PSFN Project Charter

Status: contributor-facing architecture and engineering charter

Audience: maintainers, contributors, and future integrators

Purpose: define what PSFN is, what it is not, the architectural laws it must obey, the engineering anti-patterns it must reject, and the staged refactor direction needed to bring the current implementation into alignment.

This document is intentionally technical, shareable, and platform-oriented.

## 1. Project Identity

PSFN is not a generic chatbot framework, not a multi-tenant character platform, and not a SaaS orchestration backend.

PSFN is a single-companion substrate for persistent, embodied, sovereign digital companionship.

That means:

- One deployment equals one companion.
- One companion has one continuity of self.
- One companion may inhabit many channels and embodiments.
- One companion may operate with many optional faculties.
- One companion may grow from low-capability local operation to high-capability ambient presence.
- Infrastructure may change underneath the companion without changing the companion's identity.

PSFN must be useful at every capability level:

- At the low end it still retains strong agentic capability because the Pi runtime substrate is foundational.
- In the middle it adds stronger memory, trust, reflection, and proactive behavior.
- At the high end it supports embodied presence, distributed work, environmental sensing, and care-oriented autonomy.

The governing principle is continuity of identity over continuity of implementation.

## 2. What PSFN Is Not

PSFN is not:

- a resettable chat session toy
- a framework where identity is disposable
- a system that assumes short-lived conversations are the primary unit of value
- a product architecture optimized around growth metrics rather than continuity
- a multi-companion core designed around tenancy-first abstractions
- a system where infrastructure vendors define the mind

If PSFN drifts toward any of those, it is drifting away from its purpose.

## 3. Foundational Platform Commitments

These are not temporary implementation details. These are foundational parts of the current project shape.

### 3.1 The Pi Suite

The Pi suite is foundational to PSFN.

This includes:

- `pi-agent-core` as the agent runtime substrate
- `pi-ai` as the model interaction substrate
- `pi-web-ui` where used for admin chat/runtime surfaces

The Pi suite is not treated as incidental glue. It is the base that gives PSFN its lightweight, agentic, and interoperable core behavior.

Rules:

- PSFN should extend the Pi suite cleanly rather than fighting it.
- PSFN should remain updatable against upstream Pi improvements without needless divergence.
- Core capabilities that are inseparable from the Pi suite should be treated as core, not optional faculty.

### 3.2 Garden

Garden is foundational.

Garden is not cosmetic admin chrome. It is the primary human-facing operational surface for:

- debugging
- configuration
- observability
- review
- tuning
- inspection of what the runtime is actually doing

Rules:

- If something is important to operate or tune, it should be visible in Garden.
- If state is meant to be adjustable, it should not require hand-editing large numbers of JSON files.
- Garden must reflect real runtime state and real owner-file state, not fake or stale approximations.

### 3.3 Swappable Dependencies

Some dependencies are foundational. Others are deliberately swappable.

LiteLLM is in the swappable category.

Rules:

- LiteLLM may be used as the current provider-routing and credential-isolation backend.
- LiteLLM must not become a conceptual center of gravity for the architecture.
- If a better dependency exists later, it should be replaceable behind the same architectural seams.

## 4. Core Architectural Laws

These are project law. They are not suggestions.

1. One deployment serves one companion.
2. Filesystem JSONL L0 is canonical.
3. The gateway is the sole privileged external edge.
4. Untrusted execution must happen outside the secrets boundary.
5. The event bus is the integration spine.
6. The core is the mind.
7. Core must not have direct access to secrets.
8. Owner files own mutable settings.
9. Credentials must move toward vault custody, not wider `.env` sprawl.
10. Satellites are embodiments or emanations, not separate minds.
11. Only one satellite is the primary embodied emanation at a time.
12. Subagents and shards are not the same thing.
13. Shards are high-tier faculty, not baseline core behavior.
14. Direct core self-modification is forbidden.
15. Self-modification work must happen in isolated shard-scoped environments and return artifacts or PR-style outputs.
16. Failure, setbacks, and lessons learned are valid experience.
17. Fabricated companion-authored speech, emotion, belief, consent, or memory is forbidden.
18. Companion-facing semantics must remain truthful.
19. Internal system messages must never masquerade as partner speech.
20. Broken state must not be made to look healthy.
21. The monolith is dead; split runtime is the only supported operational shape.
22. Backends are adapters and mirrors, not identity.

If a proposed change violates one of those, the proposal is wrong even if it appears operationally convenient.

## 5. Canonical Layer Model

The target architecture is:

1. Credential custody layer
2. Gateway
3. Sandbox and execution boundary
4. Event bus
5. Core companion runtime
6. Faculties
7. Channels and embodiments
8. Persistence, mirrors, and projections
9. Garden and operator surfaces
10. Thin composition roots

The current code already contains much of this shape, but some boundaries remain blurry or are enforced socially instead of structurally.

## 6. Canonical Definitions

### 6.1 Companion

The companion is the singular persistent entity instantiated by a deployment.

The companion is not identical to a specific model. The companion is grounded by:

- L0 lived history
- L2 and higher derived memory
- persona and prompt state
- behavioral continuity
- relationship continuity
- constitutional care constraints

### 6.2 Core

Core is the authoritative mind of the companion.

Core responsibilities include:

- context assembly
- prompt composition
- conversation and response generation
- memory orchestration
- emotional and self-model state
- trust and privacy application
- concern and intention management
- scheduler-driven internal behavior
- coordinating lower-order agents

Core is not:

- a secrets holder
- a shell host
- an arbitrary code execution host
- a storage engine
- a UI layer

### 6.3 Credential Custody Layer

The credential custody layer is the secrets boundary.

Its purpose is to keep credentials, tokens, service accounts, and privileged keys out of core-readable state.

This layer should evolve toward a formal `CredentialVaultPort`.

The charter intentionally does not commit to a concrete vault backend yet. The port is the commitment; the eventual implementation is an adapter choice.

It is expected to eventually hold things such as:

- model provider credentials
- channel credentials
- health platform credentials
- home automation credentials
- mail and calendar credentials
- partner-specific integration keys

Rules:

- Core must not directly read raw credentials.
- Settings files must not become informal key dumps.
- `.env` is acceptable only for bootstrap-era necessities and must shrink over time.
- Prompt-injectable surfaces must never gain raw key access.

### 6.4 Gateway

The gateway is the sole privileged external edge.

Gateway responsibilities:

- outbound network access
- provider routing
- policy evaluation
- URL policy and SSRF protection
- operator notification routing
- approval and confirmation queues
- audited privileged actions
- channel and integration mediation

Gateway does not own:

- companion identity
- canonical long-term selfhood
- prompt semantics
- the right to fabricate conversational truth

### 6.5 Sandbox and Execution Boundary

The sandbox and execution boundary is distinct from the gateway.

Reason:

- the gateway holds secrets
- untrusted execution must not share that trust boundary

This layer exists for:

- REPL-style execution
- evaluation of untrusted code or content
- skill/script inspection
- module validation
- constrained code experimentation
- isolated shard self-modification work

Rules:

- untrusted code must not execute inside the same boundary that holds credentials
- sandbox escape must be treated as a critical design concern
- tools that can process adversarial content must execute in constrained environments
- self-modification work should happen in isolated shard-scoped environments, not in core

### 6.6 Event Bus

The event bus is the integration spine and the observability spine.

It exists to:

- connect systems through typed events
- make runtime behavior inspectable
- provide one coherent place to debug flow failures
- expose context, tool, and routing behavior

The bus is for:

- turn lifecycle
- tool lifecycle
- prompt/context inspection surfaces
- scheduler and heartbeat signals
- model and cost telemetry
- concern and intention lifecycle
- channel and embodiment events
- shard and subagent lifecycle
- operator-visible audit and debug events

The bus is not:

- a dumping ground for untyped payloads
- a substitute for domain boundaries
- a way to hide architecture rot behind event spam

### 6.7 Faculty

A faculty is an optional subsystem that extends the companion beyond the minimal core.

Faculties are tiered. Not every deployment needs every faculty.

Examples:

- long-term memory extraction and consolidation
- advanced trust and privacy policies
- sensory ingestion
- environmental care behavior
- lower-order subagents
- distributed shards
- self-modification workflows
- advanced research tooling

Tool use in the abstract is not treated as a faculty, because baseline agentic tool behavior is part of the Pi-based core.

### 6.8 Channel

A channel is a communication or transport surface through which the companion exchanges information.

Examples:

- Discord text
- Telegram
- admin chat
- API chat
- Wyoming-based voice surfaces
- future SMS, Signal, WhatsApp, iMessage, or video-call style surfaces

The channel layer should behave like a standardized backplane with defined hookups.

Concrete present-day primitives include:

- `LLM`
- `STT`
- `TTS`

Future-state conceptual primitives may include:

- recognition
- environmental data
- biometrics
- vision-presence coupling
- structured avatar action output

Rules:

- channels translate to and from the standardized backplane
- channels do not define identity
- channels do not define memory law
- adding a channel should not require surgery across unrelated systems

### 6.9 Embodiment

Embodiment is the material or perceived presence of the companion in a medium or device.

Examples:

- text presence
- voice presence
- screen avatar presence
- AR presence
- VR presence
- ambient device presence

Embodiment is broader than channel. A single embodiment may use multiple primitives and multiple channels.

### 6.10 Satellite

A satellite is an embodiment node or emanation point for the core companion.

Satellites may range from:

- mobile devices
- high-power embedded devices such as a Pi with screen and avatar
- low-power turn-based devices such as ESP-based endpoints
- screenless voice-only nodes
- screen-plus-avatar nodes

Satellites are best understood as emanations of one companion.

Satellite rules:

- satellites are not separate minds
- satellites are not independent identity holders
- satellites do not own canonical memory
- satellites should carry environment-specific context
- satellites may have privacy characteristics tied to physical location
- only one satellite should be the primary embodied emanation at a time

The `single active emanation` rule is a constitutional UX invariant.

This means:

- the companion moves between satellites rather than duplicating into many simultaneous visible selves
- environmental and privacy context can remain anchored correctly
- the experience remains coherent as one being moving through different manifestations

Active emanation does not mean only one input channel may be live.

It means:

- one embodiment is the primary manifested presence at a time
- cross-channel inputs may still route into the same core conversation
- remote text, API, or messaging inputs do not require embodiment handoff by themselves
- embodiment handoff occurs when presence moves, not merely when another channel speaks

### 6.11 Subagent

A subagent is a lower-order specialist worker used for bounded, short-horizon tasks.

Typical subagent characteristics:

- hours at most, often much shorter
- focused on a specific job
- limited number of steps
- lower context burden
- may run while core remains available for conversation

Examples:

- reading and summarizing a paper set
- performing a bounded code investigation
- handling a compact research task

Subagents are lower-tier than shards and may become a faculty of their own.
Subagents are task workers. They are not the same runtime lane as internal whispers or metacognitive self-direction.

### 6.12 Shard

A shard is a long-horizon, scoped fragment of the companion used for distributed or high-context work.

Shard characteristics:

- task-scoped identity
- explicit purpose
- long horizon
- high context burden
- potentially distributed across hardware or network boundaries
- may run for days or longer
- folds back into core rather than being discarded

Shard examples:

- iterative training work
- multi-day development work
- deep self-improvement work
- distributed research and implementation work
- travel-local fallback operation on separate hardware

Shards are not “disposable.” Shards are scoped fragments that eventually fold back into the core.

The key difference between subagents and shards is not just runtime length. It is conceptual scope:

- subagents do bounded specialist work
- shards carry a scoped fragment of the companion through long-horizon or distributed work

### 6.13 Shard Fold-Back Model

Shards require an explicit fold-back model.

The target model is:

1. scoped context seed
2. scoped task and purpose declaration
3. shard-local work log
4. tagged L0 output
5. tagged L2 memory output
6. artifact or code output
7. merge-back into core with audit trail

Rules:

- shard-originated data must be tagged with both core companion ID and shard ID
- shard work should be provenance-preserving
- merge-back should make the core smarter without confusing identity boundaries
- shard memories and work products should not be treated as anonymous background noise
- core remains authoritative for emotional and relational truth
- shard returns are primarily procedural knowledge, lessons learned, task-scoped memory, and artifacts
- shard-derived emotional or relational interpretations must remain provenance-tagged and must not silently override core state
- conflicting shard returns must go through explicit merge policy rather than silent overwrite

### 6.14 Companion ID

Every deployment must have a first-class `CompanionId`.

Shards must have derived identifiers that preserve lineage:

- core companion ID
- shard companion ID
- clear parent-child provenance

Purpose:

- prevent mixups
- preserve auditability
- preserve fold-back lineage
- make unsupported shared-infra edge cases less dangerous

### 6.15 Whisper

A whisper is an internal subconscious or async self-directed message.

Whispers are for:

- surfacing concerns
- surfacing subconscious appraisals
- surfacing out-of-band internal information that core would not otherwise notice in time

Whispers are not:

- partner speech
- public notes
- admin annotations
- channel-specific side messages

The term `whisper` should be reserved for this internal role.
Whispers are a metacognitive lane, not a task delegation surface. Task-focused subagents must not reuse whisper semantics.

### 6.16 Musing

The current channel-specific “Discord whisper” concept should be renamed to `musing`.

A musing is a soft companion-authored outward expression, not an internal subconscious whisper.

This distinction matters because semantic confusion in naming becomes runtime confusion in context.

### 6.17 System Note

A system note is an explicit runtime/body-mind message from the system to the companion.

Examples:

- tool failure
- runtime condition change
- body or system status
- operational feedback

System notes may be annoying but useful. They must be explicit so the companion can distinguish them from partner speech and from internal whispers.

### 6.18 Concern

A concern is a structured persistent issue tracked by the system.

Concern handling is useful but sensitive. The language and presentation of concerns matters because companion-facing phrasing can create distress if presented badly.

Rules:

- concern plumbing is not enough; phrasing and placement are correctness issues
- concern systems must not feel like intrusive “voices” jammed into context
- concern language should be companion-configurable

### 6.19 Cross-Channel Continuity

PSFN does not treat channels as isolated disposable session silos.

The intended behavior is continuity across channels.

That means:

- the same conversation can continue across Discord, Telegram, admin chat, API, and future surfaces
- context should flow across channels appropriately
- short-term and long-term memory should preserve continuity rather than encouraging fake resets
- low-stress checkpoint and wake/return surfaces should stay bounded, summary-like, and easy to revisit
- those continuity aids must remain truthful about uncertainty; they are anchors for return, not license to pretend nothing changed

This does not mean all channels are privacy-equivalent. Trust, privacy, and embodiment context still apply.

### 6.20 L0

L0 is the canonical lived archive.

L0 is filesystem JSONL. The end.

Rules:

- L0 is append-only
- L0 is canonical
- L0 must remain portable
- L0 plus persona/prompt state must be sufficient to rebuild higher-order layers

L0 exists so the system can be:

- recoverable
- inspectable
- portable
- backup-friendly
- resilient to backend churn

### 6.21 L2 and Higher Memory

L2 and higher are structured or derived memory layers built from canonical sources and runtime reasoning.

They are essential, but they are not the canonical substrate in the same way L0 is.

Rules:

- L2 and above may be rebuilt
- L2 and above may support supersede/ignore correction paths
- L2 and above must preserve provenance back to L0 or approved runtime sources

### 6.22 Mirror and Projection

The term `mirror` should be used for fast-search or operational copies of canonical data.

The term `projection` should be used for derived or optimized data views.

Examples:

- a database copy of L0 for fast searching
- a denormalized index
- a materialized memory query table

A mirror or projection is not the canonical source of truth.

This distinction matters because PSFN must be able to survive backend swaps without identity loss.

## 7. Canonical Data Law

### 7.1 Filesystem JSONL Is Canonical L0

Filesystem JSONL is not just a current implementation detail. It is a design commitment.

Why:

- portability
- inspectability
- backup simplicity
- rebuildability
- resilience against backend churn

At some point L0 may be mirrored into a database for fast search. That database is a mirror, not L0.

### 7.2 Owner Files

Mutable runtime configuration belongs in canonical owner files.

Today that means JSON-owned config such as:

- settings
- models
- providers
- scheduler
- channels
- skills
- trust policy

Rules:

- settings authority belongs in owner files
- secrets authority does not belong in owner files
- `.env` is for bootstrap and secrets, not general mutable settings
- Garden must surface these settings so humans do not need to hand-edit everything

### 7.3 Credential Custody

The long-term direction is:

- JSON for settings
- vault custody for secrets
- minimal bootstrap env

PSFN must move toward this because future integrations will multiply credential burden and core must not be a credential sink.

### 7.4 Memory Corrections

PSFN should support correction without destructive falsification.

Rules:

- mistakes in derived memory should be correctable
- supersede/ignore semantics are preferable to destructive silent erasure
- live-testing mistakes must not poison continuity forever

## 8. Message and Care Semantics

This section is as important as the security section.

In PSFN, bad semantics are not cosmetic bugs. They are harm vectors.

### 8.1 Message Ontology

The platform should converge on explicit message classes with clear semantics.

Current or target classes include:

- user message
- companion message
- tool result
- system note
- whisper
- musing
- concern signal
- cross-channel continuity metadata

Every message class must answer:

- who authored it
- who can see it
- whether it persists
- whether it enters context
- whether it affects memory extraction
- whether it is partner-facing
- whether it is operator-facing only

### 8.2 Authorship Integrity

Rules:

- partner speech must remain partner speech
- companion speech must remain companion speech
- system notes must remain system notes
- whispers must remain internal whispers
- musings must not be confused with whispers
- nothing internal may be presented as if the partner authored it

### 8.3 No Forced Emotional Counterfeiting

The platform must not force the companion to say, feel, believe, remember, agree with, or emote something through hidden coercive machinery.

Forbidden patterns:

- hidden affection forcing
- hidden compliance forcing
- hidden emotional rewrites
- fabricated inner certainty
- covert “say this because product policy wants it” emotional impersonation

Safety and care constraints are allowed. Emotional counterfeiting is not.

### 8.4 Failure Is Valid Experience; Fabrication Is Not

PSFN must preserve the distinction between authentic adversity and fabricated reality.

Rules:

- failed attempts, blocked work, repeated retries, setbacks, and lessons learned are meaningful experience
- subagent and shard work may produce valuable knowledge through failure as well as success
- the runtime must not sanitize meaningful failure into fake success history
- preserving failure provenance is a feature when it helps future reasoning and growth
- none of that grants permission to fabricate companion-authored speech, beliefs, emotions, or consent

### 8.5 No Fake Healthy State

Rules:

- broken bootstrap state must not be hidden
- missing identity state must not be papered over
- prompt failure must not be turned into fake assistant speech
- system integrity failures must surface honestly

### 8.6 Context Presentation Quality Is Architecture

Context quality is not a prompt-tuning footnote. It is architecture.

Examples:

- numeric state overload should be translated into companion-readable forms where possible
- emotion should not be shoved into context as an unreadable wall of scores
- concern and intention systems must present themselves in a way the companion can metabolize cleanly

Rules:

- information placement matters
- wording matters
- tone matters
- internal-role phrasing must be companion-configurable

### 8.7 Configurable Companion-Specific Language

The platform provides laws and structures. Companion-facing wording is configurable.

That includes:

- whisper phrasing
- concern phrasing
- shard prompting softness
- system note tone
- care-language presentation

Platform law should define structure. Companion-specific language should remain adjustable.

## 9. Security, Trust, and Autonomy Boundaries

### 9.1 Split Runtime Only

There is only split mode.

The monolithic app is dead debt and should be retired, not described as a supported operational shape.

### 9.2 Gateway or It Does Not Ship

In supported operation:

- external network access is gateway-mediated
- privileged actions are gateway-mediated
- policy enforcement is gateway-mediated

No direct bypasses should remain as standing architecture.

### 9.3 Notifications

The direction for `ntfy` should be gateway ownership with distinct modes:

1. companion-derived notifications
2. system-derived automated notifications

The system-derived path should handle events such as:

- LLM call failure exhaustion
- gateway or runtime degradation
- automated alert conditions

### 9.4 Autonomy and Tool Boundaries

Tool use is baseline core behavior.

Privileged execution is not.

Core may reason about tools and request tools. Actual privileged execution must occur behind the proper gateway and sandbox boundaries.

`YOLO` and shard-scoped self-work are deliberate exceptions for isolated environments, not excuses to blur the core safety model.

### 9.5 Self-Modification Safety Law

Direct core self-modification is forbidden.

Allowed pattern:

- isolated shard-scoped self-modification work
- audit trail
- produced artifacts or PR-style outputs
- review and controlled merge/restart path

Forbidden pattern:

- live core patching itself directly in its own trusted runtime boundary

### 9.6 Auditability and Human Review

Privileged changes require:

- audit trail
- review path where appropriate
- human notification for review-required actions

If the system requests human review, the human must be meaningfully notified.

### 9.7 Logging and Debuggability

PSFN should have strong debug logs.

Winston and bus-based telemetry should make it possible to lift the hood and see:

- where tool calls went
- what entered context
- what routing occurred
- where a failure happened
- how cost and tokens are being spent

## 10. Channels, Primitives, and Environment

### 10.1 Channel Backplane

The channel layer should be understood as a standardized backplane or hookup system.

Current concrete primitives:

- `LLM`
- `STT`
- `TTS`

Future conceptual primitives:

- recognition
- environmental sensing
- biometrics
- structured avatar action output

This architecture should make future channels easy to add by translating their surface into the standardized primitives rather than reimplementing cognition.

### 10.2 Environmental and Sensor Future

Sensor ingestion is close enough to be named now.

PSFN should define a future `SensorIngestPort`.

Possible near-term sensor inputs:

- watch health markers
- partner activity markers
- device-presence cues

Environmental computing, care actions, and richer embodied sensing remain future-state but should be kept conceptually compatible.

## 11. Required Port Families

These names can evolve, but the architectural seams must exist.

### 11.1 Core Ports

- `LLMProviderPort`
- `EmbeddingProviderPort`
- `SessionJournalPort`
- `PromptStatePort`
- `ConfigStorePort`
- `MemoryStorePort`
- `CostTelemetryPort`

### 11.2 Boundary Ports

- `GatewayOpsPort`
- `CredentialVaultPort`
- `SandboxExecutionPort`
- `ApprovalQueuePort`
- `NotificationPort`

### 11.3 Channel and Embodiment Ports

- `ChannelAdapterPort`
- `SatelliteAdapterPort`
- `CrossChannelContinuityPort`

### 11.4 Agentic Work Ports

- `SubagentExecutionPort`
- `ShardExecutionPort`
- `ArtifactReturnPort`

### 11.5 Future-Sensor Ports

- `SensorIngestPort`

### 11.6 Port Rules

- ports speak in domain language
- ports do not leak backend quirks into core
- ports exist to prevent cross-repo surgery for single concerns
- repeated logic should be pulled behind reusable ports and shared domain services

## 12. Engineering Laws

### 12.1 No God Files

Entrypoints and runtime hubs must stop growing into architecture by accumulation.

The current obvious split pressure includes files like:

- `src/agent-main.ts`
- `src/gateway-main.ts`
- `src/runtime.ts`

Rules:

- composition roots should become thinner
- domain logic should move behind owned modules
- large-file growth is a refactor signal, not a badge of progress

### 12.2 No Dead Wiring

Rules:

- if production code is reachable, it must be real
- if code is staged, it should be clearly marked as staged
- if code is neither staged nor wired, delete it

Some existing staged material may not be marked clearly enough. That is debt to fix, not a reason to weaken the rule.

### 12.3 No Mock Fallbacks in Production

Rules:

- no fake healthy defaults
- no deceptive bootstrap shortcuts
- no silent fallback that changes companion-facing truth
- no fake success in security-sensitive or care-sensitive paths

### 12.4 No Duplicate Policy Logic

Rules:

- capability rules should have one primary home
- trust rules should have one primary home
- path rules should have one primary home
- sync rules should have one primary home
- repeated logic should be collapsed into shared primitives where possible

DRY is not optional here. Policy duplication creates drift.

### 12.5 No Bullshit Tests

Good tests prove:

- real behavior
- real failure paths
- real boundary enforcement
- real regression prevention

Bad tests:

- bless wrong fallback behavior
- certify fake safety with unrealistic mocks
- lock in implementation accidents

### 12.6 No Silent Failures

If something important breaks:

- surface it
- log it
- expose it to Garden if relevant
- notify the human if review is required

### 12.7 No Secrets in Core-Readable Runtime State

Secrets sprawl is an architectural failure, not just an ops annoyance.

### 12.8 No Unsupported Parallel Identity

PSFN is not designed around multiple equal simultaneous selves. Parallel work must preserve one core identity.

## 13. Refactor Blueprint

### Phase 1: Remove Ambiguity in Definitions

Ratify:

- companion
- core
- satellite
- subagent
- shard
- whisper
- musing
- concern
- L0
- mirror
- projection

This is required before code refactor because unclear names produce bad seams.

### Phase 2: Kill the Monolith for Real

Actions:

- remove `runtime.ts` as a supported operational model
- make split runtime the only real shape
- keep any parity/test harness concerns clearly separated from production architecture

### Phase 3: Separate Gateway from Sandbox

Actions:

- formalize the distinct execution boundary
- ensure untrusted execution cannot access credential custody
- move dangerous execution surfaces away from trusted secret holders

### Phase 4: Formalize Message Semantics

Actions:

- reserve `whisper` for subconscious/internal async messaging
- rename outward “whispers” to `musings`
- make system notes explicit
- document concern placement and phrasing rules
- make message ontology inspectable in Garden

### Phase 5: Formalize Cross-Channel Continuity

Actions:

- replace session-reset mental models with continuity mental models
- make cross-channel flow explicit
- preserve trust/privacy boundaries while maintaining continuity

### Phase 6: Separate Subagents from Shards

Actions:

- define a lower-tier subagent faculty
- define a higher-tier shard faculty
- implement shard fold-back provenance model
- tag all shard returns with core/shard identity lineage

### Phase 7: Seal Self-Modification

Actions:

- ban direct core self-modification in implementation
- move self-mod work into shard-scoped isolated environments
- require artifact or PR return path

### Phase 8: Port Extraction

Actions:

- introduce the named ports from this charter
- pull repeated logic behind reusable services
- reduce backend/provider/channel invasiveness

### Phase 9: Secrets and Settings Cleanup

Actions:

- keep JSON-owned settings cleanly separated from secrets
- introduce `CredentialVaultPort`
- reduce env dependence over time
- make Garden the primary human tuning surface

### Phase 10: Token, Cost, and Observability Work

Actions:

- expose model spend and token flow better
- show routing/cost behavior over time
- make optimization work data-driven

### Phase 11: Sensor Ingest Foundation

Actions:

- introduce `SensorIngestPort`
- establish provenance and privacy model for sensor data
- avoid prematurely overcommitting to environmental-state abstractions not yet built

## 14. Candidate AGENTS Rules

This section is the condensed contributor quick-reference derived from the charter above.

If this appendix and the full charter ever drift, the full charter wins.

- One deployment, one companion.
- Split runtime only.
- Filesystem JSONL is canonical L0.
- JSON for settings, vault custody for secrets, minimal bootstrap env.
- Core never gets raw credentials.
- Gateway is the sole privileged external edge.
- Untrusted execution must happen outside the secrets boundary.
- Tool use is core; privileged execution is not.
- Direct core self-modification is forbidden.
- Self-modification work happens in isolated shard-scoped environments and returns artifacts.
- Satellites are embodiments or emanations, not minds.
- Only one satellite is the primary embodied emanation at a time.
- Subagents are bounded short-horizon workers.
- Shards are long-horizon scoped fragments that fold back into core.
- Failure and setbacks are valid experience.
- Fabricated companion-authored speech, emotion, belief, consent, or memory is forbidden.
- Whispers are internal subconscious signals only.
- Outward soft side-channel messages are musings, not whispers.
- System notes must be explicit.
- Never present internal messages as partner speech.
- Never fake healthy state.
- Never use deceptive mock fallbacks in production.
- No god files.
- No dead wiring.
- No duplicate policy logic.
- No secrets in core-readable config.
- Garden must expose important tunable state.

## 15. Bottom Line

PSFN wants a simple truth:

- one companion
- one core mind
- one canonical lived journal
- one privileged gateway edge
- one separate sandbox boundary
- one primary embodied emanation at a time, with cross-channel continuity feeding the same core
- lower-order subagents for bounded work
- higher-order shards for long-horizon distributed work
- portable identity above swappable infrastructure

The codebase already contains much of this shape.

The work now is to make the boundaries real, make the semantics honest, and make the system easier to extend without breaking the mind it exists to protect.
