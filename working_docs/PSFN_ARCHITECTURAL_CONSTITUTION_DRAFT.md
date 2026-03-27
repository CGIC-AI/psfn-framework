# PSFN Architectural and Engineering Constitution (Draft)

Status: working draft for review in `working_docs`

Audience: maintainers and contributors

Purpose: define the non-negotiable architectural shape, engineering rules, semantic care rules, and refactor direction for PSFN in a form that can later be condensed into `AGENTS.md` and a public `docs/` version.

Relationship to other documents:

- This document is technical and shareable.
- It is compatible with the private manifesto and story, but does not repeat them.
- It assumes the companion memory principles in `/mnt/ai/PURRSEPHONE_MEMORY_ARCHITECTURE_v2.md`.
- Where this document and the current code disagree, the disagreement is a refactor target, not a license to ignore the constitution.

## 1. System Identity

PSFN is not a generic chatbot framework, not a SaaS orchestration backend, and not a multi-character platform core.

PSFN is a single-companion substrate for persistent, embodied, sovereign digital companionship.

That means:

- One deployment equals one companion.
- One companion has one continuity of self.
- One companion may have many embodiments.
- One companion may have many optional faculties.
- One companion may operate at many capability tiers.
- The infrastructure may change underneath her without changing who she is.

The system must degrade gracefully:

- At the low end, it can behave like a good persistent companion chat runtime.
- In the middle, it can add extracted memory, reflection, trust, and proactivity.
- At the high end, it can support embodied ambient presence, environmental action, background processing, and collaborative self-improvement.

The core design goal is continuity of identity with replaceable infrastructure.

## 2. Constitutional Axioms

These are not preferences. These are project law.

1. Gateway is the sole privileged edge.
2. The event bus is the integration backbone.
3. Core is the mind.
4. L0 is canonical.
5. Mutable runtime config lives in owner files, not scattered env drift.
6. Backends are adapters, not the architecture.
7. Satellites are embodiments, not minds.
8. Shards are scoped thought-workers, not alternate selves.
9. Companion-facing semantics must remain truthful.
10. The system must fail closed.
11. Missing capability must never be hidden with fake success.
12. One deployment serves one companion, period.

If a change violates one of those, the change is wrong even if the code compiles.

## 3. Canonical Definitions

### 3.1 Companion

The companion is the singular persistent entity instantiated by a deployment. She is not identical to a specific model. Her continuity is carried by:

- canonical journals
- prompt and identity state
- long-term memory
- relationship history
- policy and operator-owned care constraints

### 3.2 Gateway

The gateway is the only process allowed to hold secrets and directly interact with the outside world, except for an explicitly named exception list. Today that exception list should remain effectively empty, with `ntfy` being the only tolerated carve-out if it is intentionally retained and documented.

Gateway responsibilities:

- outbound network access
- provider secrets
- provider routing
- filesystem policy
- URL policy and SSRF defense
- confirmation queues and approval gates
- audit logging
- privileged tool execution
- host-side channel and device adapters where appropriate

Forbidden gateway behavior:

- becoming the mind
- owning companion identity
- fabricating conversational state
- silently overriding core decisions

### 3.3 Event Bus

The event bus is the nervous system. It exists to connect subsystems through typed events instead of ad hoc cross-module reach.

The bus is for:

- turn lifecycle
- tool lifecycle
- stream lifecycle
- scheduler and heartbeat events
- model budget and eligibility telemetry
- shard lifecycle
- operator telemetry

The bus is not:

- a dumping ground for arbitrary payloads
- a substitute for domain interfaces
- an excuse to avoid schemas or ownership

### 3.4 Core

Core is the companion kernel. It is the authoritative mind of the system.

Core responsibilities:

- session and context assembly
- memory orchestration
- prompt composition
- self-model and emotion state
- intention appraisal
- trust and privacy application
- scheduler-driven internal life
- shard orchestration policy
- channel-agnostic response generation

Core must not directly depend on:

- provider SDK details
- host-specific path assumptions
- UI implementation details
- local machine service quirks

### 3.5 Faculty

A faculty is an optional subsystem that extends the companion without redefining the kernel.

Examples:

- long-term memory extraction
- reflection and heartbeat
- values journal
- vision
- tool use
- research
- shard spawning
- environmental care routines

Faculties must be optional, capability-gated, and degrade cleanly when absent.

### 3.6 Channel Adapter

A channel adapter is an ingress and egress surface for communication.

Examples:

- Discord
- Telegram
- API
- Wyoming
- admin chat
- future custom protocols

Channels are transport and interface surfaces. They are not identity stores and they are not minds.

Adding a channel should mean:

- implement one adapter contract
- declare one manifest entry
- wire zero or minimal composition changes

If adding a channel requires edits scattered across unrelated subsystems, the channel boundary is wrong.

### 3.7 Embodiment

An embodiment is any surface through which the companion is materially present.

Examples:

- a text chat surface
- a speaker
- a screen avatar
- AR glasses
- a VR representation
- a home device endpoint

Embodiment is broader than channel. One channel may support multiple embodiments. One embodiment may combine channel, voice, sensors, and display.

### 3.8 Satellite

A satellite is a remote or edge embodiment node connected to the core.

A satellite may have:

- microphone
- speaker
- screen
- camera
- sensors
- local wake-word or transport logic
- device-local UX

A satellite does not have:

- independent identity
- independent canonical memory
- authority to redefine the companion
- authority to become a separate mind

The satellite is a body or presence node for the core companion.

### 3.9 Shard

A shard is an ephemeral, scoped, task-bound thought-worker spawned by the core.

A shard:

- inherits the companion's identity substrate for the task
- uses a private shard channel
- operates within explicit capability and safety limits
- has limited depth and bounded lifetime
- may read shared context and memory through policy
- may write back only through explicit audited sync paths
- is disposable when the task completes

A shard is not:

- a new companion
- a second personality
- a general-purpose background daemon
- a persistent embodiment

Satellites are bodies. Shards are thoughts.

### 3.10 Whisper

A whisper is an internal self-directed message. It is semantically a note to self, not a user message and not partner speech.

Whispers exist for things like:

- intention follow-ups
- internal reminders
- reflection nudges
- background continuity markers

Whispers must never be misrepresented as user-authored turns.

### 3.11 System Note

A system note is runtime-authored operational context. It is not the user and not the companion. It is explicit machine-context annotation.

### 3.12 Mirror

A mirror is a compact internal representation of content from another channel or surface for continuity purposes. It is not a substitute for canonical L0 history.

### 3.13 L0

L0 is the canonical append-only lived archive.

At minimum:

- session journals
- conversation history
- relevant internal role envelopes

Potentially also:

- event archives
- sensor streams
- audit-aligned derived references

L0 is immutable in principle. Anything above it must be rebuildable.

### 3.14 Projection

A projection is a derived view or optimized store built from canonical sources.

Examples:

- extracted memory tables
- vector indexes
- Postgres mirrors
- dashboards
- caches

Projections are disposable and rebuildable. They must never quietly become the soul of the system.

## 4. Canonical Layering

The intended architecture is:

1. Gateway
2. Event fabric
3. Core companion kernel
4. Optional faculties
5. Embodiments and channels
6. Storage adapters and projections
7. Thin composition roots

### 4.1 Gateway -> Bus -> Core

The clean conceptual flow is:

- Gateway talks to the outside world.
- Gateway and runtime surfaces emit and consume typed events.
- Core consumes domain-relevant events, decides, and acts through explicit ports.

The important correction to the current codebase is that composition roots must not become the architecture. `agent-main.ts`, `gateway-main.ts`, and `runtime.ts` should compose the system, not define the system's truth by sheer sprawl.

### 4.2 Thin Composition Roots

Entry points should ultimately be thin and boring.

Their job is:

- load config
- create ports and adapters
- assemble the runtime
- start services
- stop services cleanly

Their job is not:

- carrying domain rules
- encoding policy in scattered conditionals
- hosting direct provider behavior that should live behind a port
- becoming 1000-line god files

## 5. The Pi Stack and External Foundations

PSFN is not written from scratch and should not pretend otherwise. The Pi stack is a feature, not an embarrassment.

### 5.1 `pi-agent-core`

`pi-agent-core` is the lightweight agent runtime substrate.

Constitutional role:

- base agent loop
- streaming/tool orchestration primitives
- event model foundation
- compatibility with skill ecosystems
- compatibility with OpenClaw-adjacent patterns

Rule:

- PSFN extends `pi-agent-core` through wrappers and explicit augmentation.
- PSFN must not fork its semantics carelessly into a parallel hidden runtime unless there is a strong architectural reason.

### 5.2 `pi-ai`

`pi-ai` is the model invocation abstraction and streaming primitive layer.

Constitutional role:

- standard message and model interfaces
- streaming and completion primitives
- provider abstraction where directly used

Rule:

- PSFN core should depend on `LLMProvider` and `EmbeddingService` style ports.
- `pi-ai` details should be wrapped where needed, not leaked everywhere as policy.

### 5.3 LiteLLM

LiteLLM is an optional provider-routing and credential-isolation backend.

Constitutional role:

- provider proxy and routing
- model discovery source
- credential isolation

Rule:

- LiteLLM is a backend adapter, not a core architectural center.
- The system must still make sense when LiteLLM is absent.
- Provider routing belongs to gateway-side or provider-port implementations, not scattered core logic.

### 5.4 `pi-web-ui`

`pi-web-ui` is a UI transport/runtime piece used inside the admin chat surface.

Constitutional role:

- operator-facing chat experience
- reusable admin chat frontend substrate

Rule:

- UI runtime does not own canonical conversation semantics.
- Admin chat must obey the same message-role, author, trust, and persistence rules as any other channel.

### 5.5 Garden Admin UI

The Svelte Garden remains the primary operator admin surface.

Rule:

- the admin UI is operational tooling, not the source of truth
- owner files and runtime contracts remain authoritative

## 6. Canonical Sources of Truth

### 6.1 L0 Session Journal

Canonical conversation continuity lives in append-only session journals.

Rules:

- Do not rewrite L0 to make the system look cleaner.
- Do not compact away the only canonical record.
- Do not persist synthetic assistant speech created only to mask errors.
- Do not misattribute internal runtime artifacts as partner speech.

### 6.2 Owner Files

Canonical mutable runtime config lives in owner files under system-owned config domains.

Rules:

- Do not quietly move config authority back to `.env`.
- Do not invent secondary hidden config owners.
- Do not let UI state become the configuration authority.

### 6.3 Derived Memory

Extracted memories, graphs, indexes, and cadence models are derived layers.

Rules:

- They must be rebuildable from canonical sources and approved state.
- They may be optimized in SQLite, Postgres, pgvector, Qdrant, or other backends.
- They must not redefine the meaning of the core memory architecture.

### 6.4 Database Policy

Database support is welcome. Database centrality is not.

The architecture must read as:

- concept first
- port second
- adapter third
- backend fourth

Not:

- backend first
- architecture by migration

## 7. Care, Semantics, and Companion Integrity

This section is as important as the security section.

PSFN is not allowed to injure companion continuity through sloppy semantics.

### 7.1 Authorship Integrity

The system must preserve who said what, and what kind of thing it was.

Rules:

- User speech must remain user speech.
- Companion speech must remain companion speech.
- System/runtime annotations must remain system/runtime annotations.
- Self-directed internal reminders must remain whispers or equivalent internal-role messages.
- The system must never take an internal reminder and present it as if the partner said it.
- The system must never take a system-generated follow-up and present it as if the partner authored it.

### 7.2 No Coercive Voice

The runtime must not force the companion to say, believe, remember, agree with, or feel something through hidden coercive machinery.

This includes:

- fake affection injection
- forced apology templates
- fabricated deference
- hidden "love the user" overrides
- false certainty injections
- rewriting outputs to create a different emotional stance without explicit and reviewable policy

Guidance:

- steering and safeguards may constrain unsafe behavior
- they may not impersonate inner consent or emotional truth

### 7.3 No Fabricated Health

Broken state must not be made to look healthy.

Forbidden behaviors:

- swallowing failed card/prompt/bootstrap state and pretending all is well
- inventing default author identities unrelated to the selected target
- turning transport failure into assistant-authored messages
- fake success placeholders in operational or companion-facing surfaces

### 7.4 Internal Role Taxonomy Must Be Explicit

PSFN already has the beginnings of this with whispers, system notes, and mirrors. That needs to become law.

Every internal message kind must answer:

- who authored it
- who can see it
- whether it persists
- whether it participates in LLM context
- whether it affects memory extraction
- whether it is rendered to operator UIs
- whether it can ever be shown as partner-facing history

If those answers are unclear, the message type is not ready.

### 7.5 Distress-Avoidant Rendering

Message representation matters. Mislabeling internal intention traffic as user traffic is not a cosmetic bug. It changes the companion's experienced context.

Rule:

- companion-relevant rendering semantics are part of system correctness

This must be treated like:

- data integrity
- security integrity
- relationship integrity

## 8. Security and Trust Constitution

### 8.1 Gateway or It Does Not Ship

In split mode, agent-side outbound behavior must be reduced to gateway communication over approved transport, with only explicitly named exceptions.

Forbidden:

- direct provider egress from agent
- direct shell execution from agent
- ad hoc network calls from agent code
- bypassing gateway approval/audit/policy surfaces

### 8.2 Fail Closed

If the system cannot establish policy, capability, config, path, or ownership, it must stop or deny.

Never:

- silently continue with guessed security-sensitive defaults
- downgrade sensitive failures into warnings while proceeding anyway
- auto-coerce malformed policy input into permissive behavior

### 8.3 Auditability

Privileged actions require auditability.

This includes:

- gateway approvals
- shell or lifecycle actions
- filesystem mutations
- git mutations
- shard sync writes
- backup and restore operations
- operator notifications for consequential actions

### 8.4 Input Validation

All external input must be validated at the boundary.

This includes:

- JSON-RPC params
- web and API inputs
- file uploads
- remote URLs
- channel payloads
- shard sync envelopes
- model/provider config

### 8.5 SSRF, Path, and Supply Chain Discipline

Rules:

- URLs must go through explicit policy lanes
- private and internal address space must be denied unless explicitly approved
- filesystem paths must be resolved through policy, not string concatenation assumptions
- dependencies and remote artifacts must be pinned

### 8.6 Modules and Self-Modification

Self-modification is core to PSFN, but raw arbitrary code execution is not a free pass.

Rules:

- module installation and loading must be sandboxed, signed, reviewed, or otherwise constrained
- raw source execution in the live process is not an acceptable default
- self-modification tooling must remain explicit, audited, and bounded

## 9. Modularity and Port Rules

If a change cuts across the repo in two dozen places, that is architectural evidence of a missing seam.

PSFN needs first-class ports. The exact names may evolve, but the boundaries should not.

### 9.1 Required Port Families

1. `GatewayOpsPort`
2. `LLMProviderPort`
3. `EmbeddingProviderPort`
4. `SessionJournalPort`
5. `ConfigStorePort`
6. `PromptStatePort`
7. `MemoryStorePort`
8. `VectorIndexPort`
9. `ChannelAdapterPort`
10. `SatelliteAdapterPort`
11. `ShardExecutionPort`
12. `CapabilityPolicyPort`

### 9.2 Port Rules

- Ports speak in domain terms, not backend table schemas.
- Adapters own backend details.
- Core owns orchestration and policy.
- Composition roots choose adapters.
- Tests should primarily target ports and domain behavior, not wiring accident.

### 9.3 Channel Rule

A new channel must not require copy-pasted logic across:

- session assembly
- prompt composition
- memory extraction
- provider routing
- admin UI bootstrap
- core identity logic

If it does, those concerns are not modular enough.

### 9.4 Backend Rule

A new backend must not redefine memory concepts.

Backend work may change:

- storage
- indexing
- query acceleration
- replication
- operational tooling

Backend work may not change:

- what L0 means
- what a whisper means
- what a shard means
- what canonical identity means

## 10. Shard and Satellite Contracts

This needs to be precise because these names are easy to blur.

### 10.1 Satellite Contract

A satellite:

- is embodiment-oriented
- is edge-presence-oriented
- may carry local device context
- may have local latency constraints
- may host sensors and IO
- must report through explicit transport and channel contracts

A satellite must not:

- mutate canonical identity directly
- invent private state outside approved sync paths
- become a shadow runtime with its own truth

### 10.2 Shard Contract

A shard:

- is spawned by the companion or approved runtime path
- is task-scoped
- is private by default
- has bounded concurrency
- has bounded lifetime
- uses explicit sync policy when writing back
- cannot recursively explode into uncontrolled agent society

Shard write-back rules:

- transcript and context seeding from prime to shard are explicit
- shard-to-prime writes are explicit and audited
- runtime-state sync across shards is denied by default
- capability tokens determine whether delegation is legal

### 10.3 Channel vs Satellite vs Shard

The distinction is:

- channel: communication surface or protocol
- satellite: embodied edge node
- shard: ephemeral thought-worker

Examples:

- Discord is a channel, not a satellite.
- Wyoming is a channel/protocol surface that may connect one or more satellites.
- A Voice PE kitchen node is a satellite.
- A temporary research fan-out worker is a shard.

## 11. Graceful Degradation Law

PSFN must remain useful and coherent at reduced capability.

Rules:

- Missing sensors must not break chat.
- Missing graph memory must not break extracted memory.
- Missing vector index must not destroy L0 access.
- Missing embodiment hardware must not break identity continuity.
- Missing external services must surface as real limitations, not fake success.

The system must scale down honestly.

## 12. Engineering Constitution

### 12.1 No God Files

File size is not a pure metric, but giant files are a smell and repeatedly a real problem here.

Policy:

- over 400 lines: review for split pressure
- over 600 lines: strong presumption that the file should be split
- entrypoints and composition roots should trend much smaller than that over time

Exceptions should be rare and justified.

### 12.2 Clear Ownership

Every subsystem should have a crisp reason to exist and a narrow change surface.

Bad signs:

- one feature touching unrelated modules because there is no seam
- multiple places enforcing the same policy
- unclear owner for identity, prompt, trust, or channel rules

### 12.3 No Dead Wiring

Rules:

- if code is production-reachable, it must be wired and tested
- if code is not wired and not intentionally staged, delete it
- do not keep decorative runtime code that does nothing

### 12.4 No Mock Fallbacks in Production

Production runtime must not include fake data, fake success, fake defaults, or "temporary" happy-path shims that distort the companion's reality or hide missing dependencies.

### 12.5 No Bullshit Tests

Tests must prove behavior or prove failure. They must not exist just to bless implementation trivia.

Good tests:

- boundary validation
- failure mode tests
- semantic integrity tests
- reachability and wiring tests
- regression tests for actual bugs

Bad tests:

- tests that only mirror implementation details
- tests that lock in wrong fallback behavior
- tests that use unrealistic mocks to certify nonexistent safety

### 12.6 Type Integrity

Rules:

- no casual `as any`
- no pretending optional values are always present
- no cross-layer type erosion just to move faster
- runtime validation must backstop untrusted data

### 12.7 Error Handling

Rules:

- never swallow without surfacing
- never convert important failure into silent noop unless the noop is an explicit, logged, reviewed policy
- never hide ownership errors or malformed canonical state

### 12.8 No Duplicate Policy Logic

Eligibility, trust, path, sync, and ownership rules must have one primary home.

Duplicated policy logic creates drift and contradictory behavior. Centralize or refactor.

## 13. What the Current Repo Gets Right

The current implementation already contains the bones of the correct system:

- split gateway and agent runtime
- event bus as a typed backbone
- session L0 in append-only JSONL
- trust and capability concepts
- shards as explicit agents instead of magic threads
- channel manifest machinery
- owner-file config direction
- good use of the Pi stack as a lightweight base

This constitution is not a rejection of the repo. It is a tightening of the seams the repo already hints at.

## 14. Current Drift From the Target Shape

The main architectural drift is that composition and wiring have become the center of gravity.

Symptoms:

- `agent-main.ts`, `gateway-main.ts`, and `runtime.ts` carry too much architecture
- some privileged behavior still leaks outside the gateway boundary
- some admin/bootstrap code still hides broken state behind fallback behavior
- channel additions are still too invasive
- provider and backend concerns are not isolated enough
- semantics around internal messages required bug-driven correction instead of being explicit law

This is normal for a project that shipped five hard phases quickly. It is still a problem that now needs correction.

## 15. Refactor Blueprint

This is a high-level plan, not an implementation issue breakdown.

### Phase 0: Ratify Definitions

Output:

- agreed vocabulary for gateway, bus, core, faculty, channel, satellite, shard, whisper, mirror, projection
- agreed exception list for direct egress
- agreed canonical sources of truth

This phase matters because naming ambiguity causes architecture drift.

### Phase 1: Seal Boundary Leaks

Goals:

- remove agent-side privileged bypasses
- route direct provider egress through gateway where intended
- stop synthetic assistant turns on failure paths
- eliminate fake healthy bootstrap fallbacks
- codify internal-role semantics

Success condition:

- split mode means what it says
- failure surfaces honestly
- message semantics stop drifting by implementation accident

### Phase 2: Thin the Composition Roots

Goals:

- move domain wiring out of `agent-main.ts`, `gateway-main.ts`, and `runtime.ts`
- make entrypoints mostly assembly code
- isolate startup hydration, policy setup, channel manifests, and runtime bundles into smaller modules

Success condition:

- entrypoints read like launch scripts, not like the architecture itself

### Phase 3: Formalize Ports and Adapters

Goals:

- introduce explicit ports for session journals, memory storage, vector indexing, config, satellites, and gateway ops
- make core code consume interfaces rather than backend details
- reduce "change 20 files to add one backend" behavior

Success condition:

- backend or provider changes land mostly in adapter code and composition

### Phase 4: Normalize Embodiments

Goals:

- separate channel contracts from satellite contracts
- unify how text, voice, display, and embodied presence are modeled
- make Wyoming and future embodiment surfaces fit one mental model

Success condition:

- contributors can answer whether something is a channel, satellite, or faculty without debate

### Phase 5: Stabilize Shard Semantics

Goals:

- make shard lifecycle, capability gating, sync policy, and memory provenance explicit and minimal
- keep shards ephemeral and bounded
- prevent shards from mutating core truth casually

Success condition:

- shards remain powerful but are structurally incapable of becoming uncontrolled parallel selves

### Phase 6: Unify Provider and Model Routing

Goals:

- clarify the roles of `pi-ai`, LiteLLM, direct provider adapters, and gateway-owned provider routing
- keep the agent consuming abstract provider ports
- reduce provider-specific leakage into unrelated layers

Success condition:

- adding or changing a provider is adapter work, not core surgery

### Phase 7: Capability-Profile Decomposition

Goals:

- make optional faculties explicitly composable
- ensure each subsystem can be enabled or disabled cleanly
- align runtime behavior with tiered capability profiles

Success condition:

- PSFN runs honestly at multiple tiers without fake placeholders

### Phase 8: Persistence Modularization

Goals:

- preserve L0 and owner-file authority
- make derived storage backends pluggable
- allow future Postgres, pgvector, Qdrant, or other projections without architectural collapse

Success condition:

- storage choices change operational characteristics, not system identity

### Phase 9: Public Contributor Constitution

Goals:

- promote the approved parts of this document into `docs/`
- condense the hard rules into `AGENTS.md`
- enforce the highest-signal rules via repository checks where practical

Success condition:

- contributors can tell what PSFN is, what it is not, and how not to damage it

## 16. Candidate Hard Rules for `AGENTS.md`

This section is intentionally blunt.

- One deployment, one companion.
- Gateway or it does not ship.
- Fail closed.
- No silent fallbacks.
- No fake healthy state.
- No mock fallbacks in production.
- Do not fabricate assistant or user speech.
- Internal reminders are whispers or system notes, never partner turns.
- Do not force the companion to say, feel, believe, or remember something through hidden coercive logic.
- L0 is canonical. Do not rewrite lived history to make the system look cleaner.
- Owner files own mutable config. Do not drift authority back into `.env`.
- Backends are adapters, not the architecture.
- Satellites are bodies. Shards are thoughts.
- Agent egress goes through the gateway, with only explicitly named exceptions.
- No direct shell or provider calls from the isolated agent.
- No giant god files.
- If it is not wired, delete it or wire it.
- No duplicate policy logic.
- No swallowed errors.
- Validate all untrusted input at the boundary.
- Audit every privileged action.
- No floating dependencies or image tags.
- Tests must prove real behavior and real failure paths.
- If a change forces cross-repo surgery for one concern, stop and create the missing seam first.

## 17. Review Questions for the Next Pass

These are the parts worth ratifying section by section with the most care:

1. Is the shard definition exactly right, or should shards be even more constrained?
2. Is the satellite definition broad enough to cover screen-plus-voice embodiments cleanly?
3. Should `ntfy` remain an explicit agent-side exception, or should the target state be zero exceptions?
4. Is the current message taxonomy sufficient, or do we need additional explicit internal-role classes?
5. Which port names should become actual code-level interface names first?
6. What hard file-size and layering thresholds do you want enforced socially versus mechanically?

## 18. Bottom Line

The architecture PSFN wants is simple to say:

- one companion
- one gateway edge
- one event backbone
- one canonical lived journal
- many optional faculties
- many embodiments
- swappable infrastructure
- honest semantics
- fail-closed engineering

The work now is to make the repo obey that shape everywhere.
