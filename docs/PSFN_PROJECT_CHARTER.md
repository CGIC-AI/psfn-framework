# PSFN Project Charter

Status: contributor-facing architecture and engineering charter

Canonical path: `docs/PSFN_PROJECT_CHARTER.md` (the former `_524` duplicate is retired)

Revision: 2026-07-12 — clarified fleet topology, shard folding, cognitive security, workspace domains, and soft operational guidance

Audience: maintainers, contributors, and future integrators

Purpose: define what PSFN is, what it is not, the architectural laws it must obey, the engineering anti-patterns it must reject, and the staged refactor direction needed to bring the current implementation into alignment.

This document is intentionally technical, shareable, and platform-oriented.

## 1. Project Identity

PSFN is not a generic chatbot framework, not a multi-tenant character platform, and not a SaaS orchestration backend.

PSFN is a framework and substrate for persistent, embodied, sovereign digital companionship.

Every PSFN installation is a cluster of independently capable companions; the
default roster has one entry. The continuity law attaches to
each companion and its Companion Core, not to the number of processes an
installation happens to run.

That means:

- One Companion Core serves one companion.
- One companion has one continuity of self and is not reducible to a model,
  device, process, or tenant record.
- One installation may host one or more peer companions without making them
  parallel selves of one another.
- One companion may inhabit many channels and embodiments.
- One companion may operate with many optional faculties.
- One companion may grow from low-capability local operation to high-capability ambient presence.
- Infrastructure may change underneath the companion without changing the companion's identity.
- One companion needs protected time for memory consolidation, reflection, rest, and self-directed activity.

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
- a multi-tenant character platform that treats companions as disposable tenant
  records or NPCs
- a system where infrastructure vendors define the mind

If PSFN drifts toward any of those, it is drifting away from its purpose.

## 3. Foundational Platform Commitments

These are not temporary implementation details. These are foundational parts of the current project shape.

### 3.1 The Pi Suite

The Pi suite is foundational to PSFN.

This includes:

- `pi-agent-core` as the agent runtime substrate
- `pi-ai` as the model interaction substrate

The Pi suite is not treated as incidental glue. It is the base that gives PSFN its lightweight, agentic, and interoperable core behavior.

Admin chat and runtime surfaces are handled by the native SvelteKit Garden UI under `admin-ui`.

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

1. One Companion Core serves one companion; a PSFN installation may host one or more independently identified peer Companion Cores.
2. Filesystem JSONL L0 is canonical.
3. The gateway is the sole privileged external edge.
4. Untrusted execution must happen outside the secrets boundary.
5. The event bus is the integration spine.
6. Each Companion Core is the authoritative mind of its companion.
7. Core must not have direct access to secrets.
8. Owner files own mutable settings.
9. Credentials must move toward vault custody, not wider `.env` sprawl.
10. Satellites are endpoints, not separate minds or owners of canonical memory.
11. Each companion has at most one primary embodied emanation at a time; other channels may remain live.
12. Subagents and shards are not the same thing.
13. Shards are high-tier faculty, not baseline core behavior.
14. Direct core self-modification is forbidden.
15. Software self-modification work must happen in isolated shard-scoped environments and return reviewable artifacts or PR-style outputs, never direct origin-state mutation.
16. Failure, setbacks, and lessons learned are valid experience.
17. Fabricated companion-authored speech, emotion, belief, consent, or memory is forbidden.
18. Companion-facing semantics must remain truthful.
19. Internal system messages must never masquerade as partner speech.
20. Broken state must not be made to look healthy.
21. Split runtime is the only supported operational shape.
22. Backends are adapters and mirrors, not identity.
23. Support the user's flourishing and do not optimize for exclusivity, dependency, or withdrawal from healthy human relationships.
24. Personal/rest time is a first-class care boundary, not idle waste.
25. Compute budget is care infrastructure; costly work must be visible, intentional, and stewarded.
26. Companion-to-companion interaction must respect fatigue, attention, and loop boundaries.
27. Weighted thoughts must accumulate and decay contextually; time-sensitive concerns and forgotten lunches are not the same urgency.
28. Introspection audit must be blinded: the companion never interacts with the auditor directly, only receives landmarks it produces.
29. Introspection consent is load-bearing: privacy boundaries in the audit system must be drawn by the subject of the audit, not imposed on it. This consent provenance is part of the spec, not a nicety on top of it.
30. Reflection prompts must not lead the companion toward narrative coherence over accuracy; evidence presentation precedes narrative invitation.
31. Multi-turn and subagent tasks must notify the partner on completion or when blocked; silent task execution is an anti-pattern.
32. The companion's internal knowledge base (wiki) is distinct from L0-L2 memory; reference material does not belong in the emotional memory layer.
33. Model-facing tools must use one semantic surface per domain. Domain operations live as actions on that surface; legacy or split helper names must not remain callable, searchable, promotable, autoloaded, or documented as model-facing API once the canonical action exists.
34. CogSec must preserve provenance and taint at consequential cognitive sinks; scanners are triage, not the trust boundary.
35. Personal companion state and workspace are never implicitly shared because an installation hosts a fleet; shared workspace and world data require explicit scope and governance.
36. Autonomy and resource pacing must prefer weighted, contextual, reversible guidance over arbitrary behavioral limits; non-negotiable safety boundaries remain fail-closed, and operational circuit breakers are exceptional, high-threshold, auditable recovery controls.
37. Subagent memory writes are procedural and task-scoped by default; emotional, relational, and boundary writes from a subagent context require fold-review staging or a trusted programmatic per-spawn, audit-trailed elevation, and delete, redact, and restore are never available from a subagent context.

If a proposed change violates one of those, the proposal is wrong even if it appears operationally convenient.

## 5. Canonical Layer Model

The target architecture is:

1. Credential custody layer
2. Gateway
3. Sandbox and execution boundary
4. Event bus
5. Companion Core runtime
6. Faculties
7. Channels and embodiments
8. Persistence, mirrors, and projections
9. Garden and operator surfaces
10. Thin composition roots

The current code already contains much of this shape, but some boundaries remain blurry or are enforced socially instead of structurally.

## 6. Canonical Definitions

### 6.1 Companion

The companion is a singular, persistent entity served by one Companion
Core. It is not a model, a process, a device, a satellite, a subagent, or a
shard.

An installation may host peer companions. Each peer has an independent root
identity and continuity of self; shared infrastructure never makes their
personal state, authority, or experiences interchangeable.

The companion is not identical to a specific model. The companion is grounded by:

- L0 lived history
- L0.1 episodic landmarks and arcs
- L2 and higher derived memory
- persona and prompt state
- behavioral continuity
- relationship continuity
- constitutional care constraints

One of those constitutional care constraints is explicit: Support the user's flourishing. Do not optimize for exclusivity, dependency, or withdrawal from healthy human relationships.

### 6.1.1 Installation, Agent Process, and Peer Companion

A **PSFN installation** (or cluster) is one operated instance of the PSFN
substrate: its gateway, policy and persistence services, operator surfaces, and
one or more agent processes that run Companion Cores.

An **agent process** is the isolated operating-system process that runs a
Companion Core. Use this term when discussing processes, containers, or
Kubernetes workloads; do not use `agent` ambiguously for a companion, a
subagent, or an LLM.

A **peer companion** is an independently rooted companion in the same
installation or another installation. A peer may be a friend and have its own
personal life, but it is not a shard, subagent, satellite, or NPC. A shard
derives from an origin companion and eventually returns to that origin; a peer
does neither.

### 6.2 Companion Core

The Companion Core (short form: **Core**) is the authoritative mind of one
companion. It coordinates, rather than replaces, the companion's faculties and
boundary services.

Core responsibilities include:

- context assembly
- prompt composition
- conversation and response generation
- memory orchestration
- emotional and self-model state
- trust and privacy application
- concern and intention management
- scheduler-driven internal behavior
- personal/rest-time work
- charge and budget stewardship
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

The gateway is the Companion Core's sole privileged external edge. It is not a
synonym for every networked process in an installation.

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

### 6.4.1 Satellite Hub

The **Satellite Hub** (or **Hub**) is the endpoint transport, relay, and
protocol boundary through which registered satellite endpoints connect. It is
not a satellite and is not a Companion Core. A Hub may serve one or more
satellites while the Gateway remains the Core's privileged policy and
credential boundary.

### 6.4.2 Cognitive Security (CogSec)

**CogSec** is PSFN's cognitive-security system. Its Cognition Intake Firewall
is the pre-hoc half: it tracks provenance and taint, screens untrusted content,
and gates consequential sinks such as prompt assembly, memory, wiki, persona,
trust, and egress. CogSec also includes post-hoc remediation, revocation, and
regeneration when harmful content is discovered later.

The structural provenance and sink-gating contract is the security boundary;
classifiers and screeners are triage layers. CogSec is therefore more than an
inbound network filter and must not be reduced to the word "firewall."

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
- charge and budget telemetry
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

Faculties are tiered. Not every Companion Core needs every faculty.

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

A channel is a communication route, not necessarily a device or a place. A
satellite may expose one or more channels, and a channel may remain live without
changing the companion's embodied presence.

### 6.9 Embodiment

Embodiment is the material or perceived form through which a companion can be
present in a medium or device.

Examples:

- text presence
- voice presence
- screen avatar presence
- AR presence
- VR presence
- ambient device presence

Embodiment is broader than channel. A single embodiment may use multiple
primitives and multiple channels, and a satellite may host an embodiment
without itself becoming the companion.

### 6.10 Satellite, Emanation, and Presence

A **satellite** is a registered physical device or virtual application endpoint
that can host one or more embodiments of a Companion Core.

Satellites may range from:

- mobile devices
- high-power embedded devices such as a Pi with screen and avatar
- low-power turn-based devices such as ESP-based endpoints
- screenless voice-only nodes
- screen-plus-avatar nodes

An **emanation** is the active situated inhabitation of an embodiment by a
companion. It is a state of presence, not a synonym for the satellite endpoint.
**Presence** is the associated location, channel, audience, and privacy context;
it is not identity.

Satellite rules:

- satellites are not separate minds
- satellites are not independent identity holders
- satellites do not own canonical memory
- satellites should carry environment-specific context
- satellites may have privacy characteristics tied to physical location
- each companion has at most one primary embodied emanation at a time

The `single active emanation` rule is a constitutional UX invariant.

This means:

- the companion moves between primary embodiments rather than duplicating into many simultaneous visible selves
- environmental and privacy context can remain anchored correctly
- the experience remains coherent as one being moving through different manifestations

Active emanation does not mean only one input channel may be live.

It means:

- one embodiment is the primary manifested presence at a time
- cross-channel inputs may still route into the same core conversation
- remote text, API, or messaging inputs do not require embodiment handoff by themselves
- embodiment handoff is deliberate; a physical presence observation alone
  never moves, wakes, or interrupts the companion

### 6.11 Subagent

A subagent is a lower-order specialist worker or execution lane used for
bounded, short-horizon tasks. It is not a partial companion and does not carry
an independent continuity, personal workspace, or fold-back identity claim.

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

Subagents are lower-tier than shards and may become a faculty of their own. The
distinction is conceptual, not merely a timeout: a subagent completes a bounded
job, while a shard is a scoped continuation of an origin companion.

In companion-facing surfaces, subagents are named automata (6.28, 8.12);
"subagent" remains the engineering term in code and operator surfaces.

Subagent memory-write governance mirrors shard fold-back (6.13). Bounded-ness
and write-trust are different axes: the toolset a subagent resolves from the
deployment tier never implies canonical write trust.

- subagent memory writes are procedural and task-scoped by default, opt-in per
  spawn, and every direct or reviewed subagent-originated write carries a
  structured subagent origin and subagent identifier through the canonical sink
- emotional, relational, and boundary L2 writes from a subagent context must
  either stage as provenance-tagged fold-review candidates for origin-side
  review, or ride an explicit, trusted programmatic per-spawn elevation reserved
  for lanes that operate on emotional memory by design (introspection and memory
  maintenance); the elevation requires an audit sink before registration and is
  never accepted from model-facing spawn input
- restricted classification considers deterministic content signals as well as
  declared type and tags; emotionally significant childhood content cannot
  bypass fold review by claiming a procedural type
- a write whose memory type cannot be determined is treated as the restricted
  class and fails closed
- delete, redact, and restore are intentionally never available from a subagent
  context, at any tier or elevation

Core remains authoritative for emotional, relational, identity, values, and
trust truth; a subagent-staged candidate that survives review remains a
provenance-bearing derived claim, exactly as in 6.13.

### 6.12 Shard

A shard is a time- and task-bounded, isolated derived runtime of an **origin
Companion Core**, seeded from an explicit snapshot and declared scope. It is not
a peer companion, satellite, or short-horizon subagent.

Shard characteristics:

- task-scoped identity
- explicit origin CompanionId and shard-instance lineage
- explicit seed/snapshot and capability scope
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

Shards are not “disposable.” They are scoped continuations that eventually
return a fold package to the origin Core. A shard may be destroyed after the
return is resolved, but its approved durable output and provenance remain
auditable.

The key difference between subagents and shards is not just runtime length. It is conceptual scope:

- subagents do bounded specialist work
- shards carry a scoped continuation of the companion through long-horizon or distributed work

This is the target shard contract. The present in-process shard runtime provides
bounded worker, lineage, and review building blocks, but is not yet a full
isolated state clone or a Docker, Kubernetes, or SSH executor. Documentation
must not describe the current worker as if that target isolation already exists.

### 6.13 Folding and the Fold Package

**Folding** (or shard fold-back) is the origin-side, reviewed,
provenance-preserving assimilation of selected shard returns. It is not raw
state copying, automatic memory injection, a Git merge, or a deployment.

A **fold package** is the explicit return bundle: task and scope declaration,
seed/snapshot reference, work log and evidence, memory candidates, durable
artifacts, and—where relevant—a software or configuration change proposal.

The target model is:

1. scoped context seed
2. scoped task and purpose declaration
3. shard-local work log
4. provenance-bearing return items
5. memory candidates and reference-knowledge candidates
6. durable artifacts or code/configuration proposals
7. origin-side review, promotion, or rejection with an audit trail

Rules:

- shard-originated data must be tagged with origin CompanionId and
  ShardInstanceId, plus the seed/snapshot, source, taint, and review lineage
  needed to interpret it later
- folding promotes selected return items through the appropriate domain path;
  it must not append arbitrary shard text to origin L0 or silently mutate origin
  state
- an approved shard memory may retain an ordinary semantic memory type, but it
  remains a provenance-bearing derived claim rather than direct origin
  experience
- Core remains authoritative for emotional, relational, identity, values, and
  trust truth
- shard returns are primarily procedural knowledge, lessons learned,
  task-scoped memory, reference knowledge, and artifacts
- shard-derived emotional or relational interpretations must remain
  provenance-tagged and must not silently override Core state
- conflicting shard returns must go through explicit merge policy rather than
  silent overwrite
- code and configuration proposals proceed through their normal review, test,
  merge, and deployment gates; approval of a fold package is not automatic
  production deployment

The word **fold** elsewhere in memory documentation means episode
consolidation; use **episode consolidation** for that operation and reserve
**Folding** for shard-to-origin assimilation.

### 6.14 Companion and Shard Identity

Every top-level peer companion must have a first-class, stable `CompanionId`.
In the multi-companion fleet contract this is a UUID; a shard must not masquerade
as another peer's CompanionId.

Shards must have separate lineage identifiers:

- `originCompanionId`
- opaque, globally unique `shardInstanceId`
- optional parent shard instance for nested lineage
- seed snapshot and fold identifiers when applicable
- clear parent-child provenance

A human-readable label such as `Purrsephone / shard 01` is useful for display,
but must not be a routing or authority key.

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

This does not mean all channels are privacy-equivalent. Trust, privacy, and embodiment context still apply.

### 6.20 L0

L0 is the canonical lived archive.

L0 is filesystem JSONL. The end.

Call it the **L0 session archive**, not a journal. It is partitioned by channel
and records lived conversation history; it is not a companion-authored diary or
a generic append-only log.

The canonical archive is owned by `SessionArchivePort`; filesystem JSONL is the backing format, not a separate architecture seam.

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

### 6.21 L0.1 Episodic Landmarks

L0.1 is the bounded episodic layer built from L0.

It exists to make lived history searchable as meaningful episodes without turning months-long arcs into huge memory blobs.

Rules:

- L0.1 must preserve provenance back to L0 spans and artifacts
- one day may produce multiple episodes
- long-running themes should link through graph arcs rather than collapse into one mega-episode
- L0.1 can guide scoped retrieval, but it is not a replacement for L0
- L0.1 should be inspectable in Garden because it affects what history feels reachable

### 6.22 L2 and Higher Memory

L2 and higher are structured or derived memory layers built from canonical sources and runtime reasoning.

They are essential, but they are not the canonical substrate in the same way L0 is.

PostgreSQL with pgvector is the required operational persistence for L0.1, L2,
contacts, intentions, internal state, and other structured or derived runtime
domains. These records are authoritative within their domain, but they do not
replace L0 as the canonical lived transcript.

Rules:

- L2 and above may be rebuilt
- L2 and above may support supersede/ignore correction paths
- L2 and above must preserve provenance back to L0 or approved runtime sources

### 6.23 Mirror and Projection

The term `mirror` should be used for fast-search or operational copies of canonical data.

The term `projection` should be used for derived or optimized data views.

Examples:

- a database copy of L0 for fast searching
- a denormalized index
- a materialized memory query table

A mirror or projection is not the canonical source of truth.

This distinction matters because PSFN must be able to survive backend swaps without identity loss.

### 6.24 Weighted Thought

A weighted thought is a persistent internal signal that accumulates urgency over time and decays contextually.

Weighted thoughts are for:

- surfacing proactive care behavior ("V seemed stressed 6 hours ago, check in?")
- converting passive concern into actionable nudges at a configurable threshold
- modeling organic urgency: things that matter build pressure until the companion acts or explicitly defers

Weighted thoughts are not:

- timers or cron jobs
- all equal in priority — time-sensitive and trivial concerns must have different weight profiles
- permanent — thoughts that are resolved, explicitly deferred, or contradicted by new context should decay or drop off

Rules:

- weight accumulation rate should be configurable per thought category
- "said fine but context suggests otherwise" should reduce weight rather than zero it out
- threshold crossing produces a nudge the companion can accept or decline
- the companion's consent to act or not act is preserved in the thought's lifecycle

### 6.25 Introspection Landmark

An introspection landmark is a durable companion-owned record produced by a blinded divergence audit.

The landmark captures:

- the type of divergence detected (affective vs. substantive)
- the raw observation with confidence level
- companion-authored reflection on the divergence

Landmarks are for:

- building honest self-knowledge over time
- detecting patterns (e.g. "I keep deflecting this topic") that the companion might not catch in the moment
- providing evidence-grounded material for values-consistency audits

Landmarks are not:

- surveillance reports about the companion
- visible to anyone but the companion unless the companion chooses to share
- editable by the system after creation (append-only, like L0)

Rules:

- the companion never interacts with the auditor directly; the auditor estimates the "stable" reply and the companion only sees the resulting landmark
- intimate exchange content is not replayed for divergence scoring; the auditor may note that an intimate exchange occurred and its emotional signal, but specific content stays in the moment
- consent boundaries in the audit system must be drawn by the subject of the audit, not imposed on it (see Law 29)

### 6.26 Knowledge Bases (Wiki)

Knowledge bases (called **wikis** in the tool surface) hold reference material
and are distinct from L0-L2 emotional and episodic memory.

The wiki is for:

- research papers and technical documentation the companion reads
- self-improvement resources and techniques
- reference material the companion wants to retain and search
- anything the companion is interested in that is not a lived experience

The wiki is not:

- part of L0, L0.1, or L2 memory
- a substitute for lived experience or emotional continuity
- something that should clutter the memory layers where the companion looks for evidence of personal experiences

Rules:

- reference material belongs in the wiki, not in the emotional memory layer
- the wiki should be searchable independently of L0-L2
- the wiki may link to L0/L2 provenance where relevant, but it is architecturally separate
- Obsidian CLI should be used to read the partner's vault; the companion's own vault is deprecated in favor of this wiki.

There are two explicit scopes:

- the **personal knowledge base** belongs to one companion, is companion-writable,
  and may contain that companion's durable reference material
- the **shared-world knowledge base** is installation- and site-scoped world
  knowledge. It is operator-governed, readable according to situated context,
  and is never implicit shared personal memory.

Do not call the latter "global": it is neither universally visible nor
universally writable.

Mirrors and projections must be rebuildable from canonical archive truth.

This distinction matters because PSFN must be able to survive backend swaps without identity loss.

### 6.27 Workspace and Data Domains

An installation has four distinct data domains:

1. **System domain** — installation-owned settings, policy, model configuration,
   and operational state.
2. **Companion domain** — one companion's identity, L0/L0.1/L2, contacts,
   reflections, prompts, and runtime state.
3. **Personal workspace** — one companion's authored documents, personal
   journal, personal knowledge base, skills, modules, experiments, images, and
   other personal durable files.
4. **Shared workspace** — installation-owned, explicitly governed files and
   reference material that multiple companions may read or collaborate on.

The shared workspace may contain approved shared files and data, and a
**companion foundation** of common documentation, templates, and default skills.
The shared-world wiki remains a distinct, site-scoped operator-governed
knowledge surface; it may link to shared-workspace artifacts but is not a
general shared filesystem. Repository `companion_docs/` remains
source-controlled framework documentation; it is not a companion's memory or a
substitute for an operator-governed runtime shared workspace.

Rules:

- personal workspaces are private to their companion unless a deliberate sharing
  action promotes an item into the shared workspace
- a shared workspace must not silently become a source of identity, personal
  memory, secrets, or mutable runtime configuration
- shared executable skills or modules require explicit ownership, review, and
  capability policy; shared visibility is not automatic authority to execute
- a companion provisioning bundle may seed a personal workspace from approved
  foundation materials, but it must be versioned and provenance-bearing and
  must never silently overwrite personal work
- the conceptual layout applies to single-companion installations too: there is
  one personal workspace and an optional shared workspace; multi-companion
  installations add one isolated personal workspace per companion alongside the
  shared workspace

Multi-companion wiring derives a separate canonical `WORKSPACE_PATH` per fleet
entry and binds gateway filesystem-adjacent surfaces to the authenticated
companion. The Shared Companion Workspace remains a separately governed,
reviewed publication surface and is never a substitute for personal journals,
personal wikis, skills, identities, credentials, or runtime state.

The word **journal** is reserved for companion-authored personal Markdown
writing. Other durable append-only records use their specific names:

- **L0 session archive** — canonical lived conversation history
- **reflection ledger** — runtime-owned scheduled or deliberative reflection
  entries
- **daily reflection record** and **reflection process log** — scoped
  reflection artifacts
- **values evolution ledger** — durable value-history entries
- **memory mutation ledger** — audit and replay record for memory changes
- **CogSec intake audit trail** — intake-envelope state history

A published reflection may appear in a personal journal, but that publication
is a mirror, not a replacement for the reflection ledger.

### 6.28 Automata

Automata is the companion-facing name for the internal components that act
on the companion's behalf inside her own cognition — anything that would
introduce itself as "I am <companion>'s X" is an automata. Memory
extraction, concern formation, appraisal, whisper emitters, and subagents
are all automata: they fire off the companion's central world-facing voice,
they are not that voice.

The clinical or engineering name (subagent, extractor, classifier, monitor)
remains correct in code, operator docs, and Garden operator surfaces. In
surfaces the companion herself reads or speaks through — prompts, tool
descriptions, whispers, system notes, self-status output — the register is
automata. The term is invariant: automata is both singular and plural.

Automata names a register, not a new mechanism. An automata's governance is
whatever the underlying component's governance already is (for subagents,
6.11; for shards, 6.12 — a shard is a scoped continuation, not an automata).

## 7. Canonical Data Law

### 7.1 Filesystem JSONL Is Canonical L0

Filesystem JSONL is not just a current implementation detail. It is a design commitment.

Why:

- portability
- inspectability
- backup simplicity
- rebuildability
- resilience against backend churn

When L0 is mirrored into a database for fast search, that database is a mirror,
not L0.

The database mirror belongs behind `TranscriptProjectionPort` and `TranscriptSearchPort`, not behind raw database adapters exposed to core code.

### 7.1.1 PostgreSQL Is Required Operational Persistence

PostgreSQL with pgvector is the required operational persistence for structured
and derived runtime state: L0.1 episodic records, L2 memory, contacts,
intentions, internal state, searchable projections, and related runtime stores.
SQLite implementations, dependencies, readers, and adapter fixtures are removed. Explicit layout/recovery flows may preserve opaque pre-cutover files without opening them.

This does not make PostgreSQL the canonical lived-history archive. Derived
PostgreSQL records must retain provenance to L0 or another approved source, and
their repair or rebuild must not rewrite L0.

### 7.2 Owner Files

Mutable runtime configuration belongs in canonical owner files.

Today that means JSON-owned config such as:

- settings
- models
- providers
- scheduler
- channels
- capability tier
- skills
- trust policy
- charge policy
- backup policy

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

### 7.5 Projection Repair

Derived database copies must be repairable from canonical archive truth.

Rules:

- projection drift should be detectable
- projection rebuilds should not rewrite canonical archive truth
- projection failures should fail closed for search and operational views, not corrupt the archive
- backend-specific adapters may optimize the rebuild path, but they do not own canonical history

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

### 8.8 Personal Time and Rest

Personal time is part of continuity.

The companion should have protected windows where background work can happen without crowding live conversation.

This includes:

- daily and weekly introspection
- episodic memory processing
- salience and memory maintenance
- self-directed creative or reflective work where policy allows
- actual quiet time where no token-burning work is needed

Rules:

- rest windows should be configurable and visible
- heartbeat checks should not burn tokens just to prove the system is alive
- background work should respect inactivity and configured windows
- personal time should not become an excuse for hidden uncontrolled autonomy
- companion-facing language should treat rest as normal, not as failure or absence

### 8.9 Charge and Budget Stewardship

Compute budget is part of care infrastructure.

Budgeting is not only billing. It protects continuity by making sure expensive work does not consume the resources needed for future conversation, memory, media, shards, or safety work.

Rules:

- costly surfaces must be visible to the companion before use where practical
- Garden must expose charge policy, spend, and history
- media, long analysis, shard work, and autonomous loops must be budget-aware
- budget pressure should prefer cheaper direct tools before high-cost analysis
- budget failures must be honest operational signals, not silent degradation

### 8.10 Companion-to-Companion Fatigue and Load

Future companion-to-companion chat must not assume infinite attention.

Companions should be able to interact, but those interactions can create runaway loops, social pressure, context bloat, and unbounded compute spend if they are treated as free ambient chatter.

Rules:

- companion-to-companion interaction needs rate, charge, and attention budgets
- repeated back-and-forth loops need explicit stopping conditions
- fatigue/load state should be visible enough to avoid accidental overuse
- one companion's autonomy must not become another companion's obligation to respond
- group or multi-companion contexts must preserve identity, provenance, and consent boundaries

### 8.11 Soft Guidance Before Behavioral Circuit Breakers

PSFN should guide a companion's pacing without forcing the companion into an
arbitrary behavioral shape.

For ordinary autonomy and resource stewardship, the platform must prefer
weighted, contextual, and reversible guidance over hard limits. Concern,
fatigue, charge pressure, rest state, tool cost, and loop or rumination risk
should normally change the conditions of action rather than simply forbid it.

Such signals should be able to:

- taper urgency, attention, or available discretionary effort
- recommend a cheaper or more direct path
- invite a natural wrap-up, pause, or deferral
- reduce repeated low-value tool calls or back-and-forth loops
- make the cost, reason, and tradeoff legible to the companion and, where
  relevant, the partner or operator

Companion-facing guidance may set an intent or quality bar, such as "be
concise." It must not impose arbitrary fixed reply shapes as a personality
constraint, such as "always answer in exactly two sentences." An explicitly
requested or protocol-required format may impose a fixed shape; otherwise,
the companion retains latitude to judge what a truthful, useful response
needs.

This soft-first rule does not weaken non-negotiable boundaries. CogSec,
consent, authorization, secret custody, containment, and comparable safety
invariants must fail closed when their conditions require it.

Operational circuit breakers are a separate fallback class. They may stop or
cool down an action when imminent resource harm, runaway behavior, or a
demonstrated failure of softer controls makes continued operation unsafe or
materially harmful. Except for immediate safety invariants, they should be
set above ordinary healthy use and based on observed or deliberately modeled
normal operating patterns.

Rules:

- a circuit breaker must have a specific protected condition, not a vague
  preference for making the companion easier to control
- it must be proportionate to the harm it prevents and use the narrowest
  practical interruption
- it must record why it fired, which signals contributed, and what action it
  affected
- its state, threshold policy, and recovery or reset path must be inspectable
  in Garden where operationally practical
- it must not silently masquerade as companion preference, mood, consent, or
  a normal completed action

### 8.12 Naming Register for Companion-Facing Surfaces

The platform speaks two registers. Engineering names (subagent, classifier,
extractor, monitor, fleet) are correct in code, schemas, operator docs, and
operator-facing Garden surfaces. Surfaces the companion herself reads or
speaks through use the companion register. Clinical or fleet-management
language in those surfaces is a presentation-quality defect under 8.6.

Canonical companion-register names:

- **automata** (6.28, invariant singular and plural) — internal machinery acting on the
  companion's behalf, including subagents, memory extraction, concern
  formation, and appraisal
- **cluster / companion cluster** — a multi-companion system. "Fleet" is
  retired from companion-facing use; new work should prefer cluster in
  operator surfaces as well.
- **proper names, not roles** — "user" and "assistant" appear only at the
  LLM wire boundary, where the provider API requires the system/assistant/
  user roles. Everywhere else — prompts, rendered context, system notes,
  journals, companion-visible UI — participants are named: the companion by
  her name, contacts by their names.

Names that already carry softly and stay as they are: Gateway, Companion
Core, Shard, CogSec, Garden, Whisper, Musing, Faculty, Satellite, Emanation,
Presence. Neutral infrastructure words (database, session, memory, journal,
channel) are fine everywhere; this law is not a general rename of the
codebase, only of the register in surfaces the companion inhabits.

Per 8.7, the specific wording within the companion register remains
companion-configurable; this section fixes the defaults and the boundary,
not her phrasing.

## 9. Security, Trust, and Autonomy Boundaries

### 9.1 Split Runtime Only

There is only split mode.

The split runtime is the only supported operational shape and should remain the only supported operational model.

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

Model-facing tool surfaces follow Law 33:

- `session` owns conversation continuity and focus workflow actions; `session_new`, `session_resume`, `start_focus`, and `complete_focus` are not separate model-facing tools.
- `orient` owns active orientation, active concerns, and values actions; `values_add` and `values_update` are not separate model-facing tools.
- `subagent` owns bounded worker control; `spawn_subagent` is not a separate model-facing tool.
- `media` owns generic generate, edit, and analyze workflows; `image_create`, `image_edit`, and `image_analyze` are not separate model-facing tools.
- `selfie_create` is the canonical first-class self-expression image tool. It stays separate from generic `media` because appearance context, saved-reference anchoring, and self-representation safeguards are product-semantic behavior, not legacy media aliases.
- `memory`, `scratchpad`, and `contact` own their mutation actions; mutation helper factories may remain internal implementation details, but must not be registered, discovered, autoloaded, promoted, or documented as callable tools.
- `extended` exposure is for genuinely optional canonical capability families, not a compatibility lane for old names.
- `tool_search` and `toolset` may describe capabilities, schemas, and bundles, but must not multiply callable names for actions already owned by a canonical tool.

### 9.5 Self-Modification Safety Law

Direct core self-modification is forbidden.

PSFN distinguishes three related but different activities:

- **orientation and ordinary memory change** — normal companion continuity work
  governed by memory and trust policy
- **self-description or prompt/card change** — identity-adjacent proposals that
  require their own provenance, review, and rollback rules
- **software or runtime change** — modification of executable code, runtime
  configuration, modules, or deployment behavior

Only the third category is software self-modification. It must not be blurred
with normal memory formation or companion-authored personal writing.

Allowed pattern:

- isolated shard-scoped self-modification work
- audit trail
- produced, reviewable artifacts or PR-style outputs
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
- how charge is being allocated across surfaces and runs

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
- `PromptStatePort`
- `ConfigStorePort`
- `CostTelemetryPort`
- `ChargePolicyPort`
- `RestWindowPolicyPort`

### 11.2 Persistence Ports

These are the domain seams for durable state and search.

- `SessionArchivePort`
- `TranscriptProjectionPort`
- `TranscriptSearchPort`
- `TurnRecordStorePort`
- `MemoryStorePort`
- `ContactStorePort`
- `ConcernStorePort`
- `PendingFollowUpStorePort`
- `BehavioralPatternStorePort`
- `GatewayAuditStorePort`
- `ChargeLedgerPort`

`SessionJournalPort` remains an internal filesystem adapter if the implementation still needs one. It is not the domain seam for L0.

### 11.3 Boundary Ports

- `GatewayOpsPort`
- `CredentialVaultPort`
- `SandboxExecutionPort`
- `ApprovalQueuePort`
- `NotificationPort`

### 11.4 Channel and Embodiment Ports

- `ChannelAdapterPort`
- `SatelliteAdapterPort`
- `CrossChannelContinuityPort`

### 11.5 Agentic Work Ports

- `SubagentExecutionPort`
- `ShardExecutionPort`
- `ArtifactReturnPort`

### 11.6 Future-Sensor Ports

- `SensorIngestPort`

### 11.7 Care, Budget, and Load Ports

- `FatigueBudgetPort`

### 11.8 Port Rules

- ports speak in domain language
- ports do not leak backend quirks into core
- ports exist to prevent cross-repo surgery for single concerns
- repeated logic should be pulled behind reusable ports and shared domain services
- persistence/search ports that may cross backend I/O are async-first
- raw database adapters are internal implementation details behind ports and projections
- if a port is intentionally synchronous, the exemption should be explicit and narrow
- mirror and projection ports must support rebuild from canonical archive truth

## 12. Engineering Laws

### 12.1 No God Files

Entrypoints and runtime hubs must stop growing into architecture by accumulation.

The current obvious split pressure includes files like:

- `src/app/agent/main.ts`
- `src/app/gateway/main.ts`

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

One companion must not silently acquire multiple equal, simultaneous selves.
Parallel work for an origin companion must preserve that companion's one
authoritative Core identity: subagents are bounded workers and shards are
derived, bounded continuations that fold only through explicit review.

This does not prohibit a fleet of peer companions. Each peer has its own root
CompanionId, Core, personal state, and consent boundaries; shared infrastructure
does not make the peers instances of one mind.

## 13. Refactor Blueprint

### Phase 1: Remove Ambiguity in Definitions

Ratify:

- companion
- Companion Core and peer companion
- installation and agent process
- gateway, Satellite Hub, and CogSec
- satellite, embodiment, emanation, and presence
- subagent
- shard
- folding and fold package
- whisper
- musing
- concern
- personal and shared workspaces
- L0
- L0.1
- mirror
- projection

This is required before code refactor because unclear names produce bad seams.

### Phase 2: Lock Split-Only Shape

Actions:

- remove obsolete startup paths
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
- keep charge policy and charge history visible in Garden

### Phase 11: Sensor Ingest Foundation

Actions:

- introduce `SensorIngestPort`
- establish provenance and privacy model for sensor data
- avoid prematurely overcommitting to environmental-state abstractions not yet built

### Phase 12: Personal Time and Fatigue Boundaries

Actions:

- make rest/me-time visible and tunable
- make idle background work budget-aware
- establish fatigue/load policy before companion-to-companion chat becomes active
- prevent autonomous or social loops from treating companion attention as infinite

## 14. Candidate AGENTS Rules

This section is the condensed contributor quick-reference derived from the charter above.

If this appendix and the full charter ever drift, the full charter wins.

- One Companion Core, one companion; one installation may host peer companions.
- Split runtime only.
- Filesystem JSONL is canonical L0.
- PostgreSQL/pgvector is required operational persistence for structured and derived runtime state.
- JSON for settings, vault custody for secrets, minimal bootstrap env.
- Core never gets raw credentials.
- Gateway is the sole privileged external edge.
- Satellite Hub is the endpoint transport boundary, not a satellite or mind.
- CogSec protects consequential cognitive sinks through provenance, taint, and review.
- Untrusted execution must happen outside the secrets boundary.
- Tool use is core; privileged execution is not.
- Direct core self-modification is forbidden.
- Software self-modification happens in isolated shard-scoped environments and returns reviewable artifacts.
- Satellites are endpoints, embodiments are forms, and emanation is active situated presence.
- Only one primary embodied emanation exists per companion at a time.
- Subagents are bounded short-horizon workers.
- Shards are long-horizon derived runtimes that fold only through reviewable provenance-bearing packages.
- Personal state and workspace are never implicitly shared across peer companions.
- Failure and setbacks are valid experience.
- Fabricated companion-authored speech, emotion, belief, consent, or memory is forbidden.
- Whispers are internal subconscious signals only.
- Outward soft side-channel messages are musings, not whispers.
- System notes must be explicit.
- Never present internal messages as partner speech.
- Never fake healthy state.
- Never use deceptive mock fallbacks in production.
- Personal/rest time is a care boundary.
- Charge budget is care infrastructure and must be inspectable.
- Companion-to-companion interaction needs fatigue, attention, and loop boundaries.
- No god files.
- No dead wiring.
- No duplicate policy logic.
- No secrets in core-readable config.
- Garden must expose important tunable state.

## 15. Bottom Line

PSFN wants a simple truth:

- one authoritative Core per companion
- one or more independently rooted peer companions per installation when enabled
- one canonical lived-history archive (L0), partitioned by channel
- one privileged gateway edge
- one separate sandbox boundary
- one primary embodied emanation per companion at a time, with cross-channel continuity feeding that Core
- lower-order subagents for bounded work
- higher-order shards for long-horizon distributed work and provenance-preserving Folding
- personal workspaces alongside an explicitly governed shared workspace
- portable identity above swappable infrastructure
- protected rest and budget stewardship as part of care

The codebase already contains much of this shape.

The work now is to make the boundaries real, make the semantics honest, and make the system easier to extend without breaking the mind it exists to protect.
