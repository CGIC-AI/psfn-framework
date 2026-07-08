# Changelog

This is a synthesized, agent-facing changelog for the branch delta from the
latest `origin/main` tip to the latest `origin/foundation_e0_e2` tip.

Scope window: `origin/main..origin/foundation_e0_e2`, ending at
`foundation_e0_e2` commit
[`82b66467`](https://github.com/CGIC-AI/psfn-framework/commit/82b66467855dda25ee0602ae0198a8cc8a07d8be)
on 2026-07-07.

This document intentionally summarizes new capabilities and meaningful
refactors. It does not enumerate every bugfix, test repair, fixture sync, or
follow-up cleanup commit in the range.

Sections 1-8 cover the branch through
[`543571f8`](https://github.com/CGIC-AI/psfn-framework/commit/543571f8f6fdf74c7764eacf160b4b2e9bec5a2f)
(2026-07-02). The **2026-07-02 → 2026-07-07 addendum** below covers the 141
non-merge commits added since then (`543571f8..82b66467`).

## Version Timeline

No git tags or GitHub Releases were present in this checkout for this window.
`Kind` therefore identifies branch endpoints rather than published releases.

| Version | Kind | Date | Summary |
|---------|------|------|---------|
| [`origin/main` `b4e9840`](https://github.com/CGIC-AI/psfn-framework/commit/b4e98406483b3890e7fd97dc639fd73ffb70612c) | Branch endpoint | 2026-06-06 | Latest main commit used as the comparison baseline. |
| [`63f8190`](https://github.com/CGIC-AI/psfn-framework/commit/63f81900d1e99e810bc69438002cd0da58172090) | Merge base | 2026-03-27 | Common ancestor of `origin/main` and `origin/foundation_e0_e2`. |
| [`543571f`](https://github.com/CGIC-AI/psfn-framework/commit/543571f8f6fdf74c7764eacf160b4b2e9bec5a2f) | Section 1-8 endpoint | 2026-07-02 | Endpoint for the thematic sections 1-8 below. |
| [`foundation_e0_e2` `82b6646`](https://github.com/CGIC-AI/psfn-framework/commit/82b66467855dda25ee0602ae0198a8cc8a07d8be) | Branch endpoint | 2026-07-07 | Current foundation branch tip; adds the 2026-07-02 → 2026-07-07 addendum work (live-deploy pipeline, self-diagnosis, trust-drift, durable scheduled prompts, tool-call reliability). |

## 1) Deployment And Runtime Isolation

The branch adds production deployment surfaces around the existing gateway/agent
split: host-side gateway containers, Kubernetes manifests, a Helm chart, network
policies, model-service routes, Satellite Hub image paths, and WSS/mTLS transport
contracts for gateway and Garden RPC.

### Delivered capability

- Gateway and agent container surfaces can be built and deployed separately.
- Kubernetes base manifests and overlays cover PSFN, Postgres/pgvector,
  LightLLM, Text Embeddings Inference, LiteLLM routing, services, PVCs, and
  network policies.
- Helm chart contracts encode image sets, secrets, workloads, model prefetching,
  certificate wiring, validations, and deployment documentation.
- Gateway and Garden admin transports gained WSS and SPIFFE mTLS validation
  paths for non-local administration.

### Representative commits

- [`83cd89fd`](https://github.com/CGIC-AI/psfn-framework/commit/83cd89fdc5c7b0a49ba7330b98487e0a73376d80) added the gateway Dockerfile.
- [`5298731b`](https://github.com/CGIC-AI/psfn-framework/commit/5298731b209660846062224335b0a115588032d9) added the Kubernetes base infrastructure.
- [`223ca045`](https://github.com/CGIC-AI/psfn-framework/commit/223ca045619ab435f63727b5dbf47d62da59844d) added the Postgres StatefulSet with pgvector.
- [`522cecaa`](https://github.com/CGIC-AI/psfn-framework/commit/522cecaa82d3c4ea909515d0ffb738ab3cce1a96) documented the Kubernetes deployment path.
- [`2c8da5e7`](https://github.com/CGIC-AI/psfn-framework/commit/2c8da5e7c5ea39b9480fd183a5fd1d42ac8c528a) added Helm chart contracts.
- [`3dc64d8c`](https://github.com/CGIC-AI/psfn-framework/commit/3dc64d8c566c658ddbeac89ba38c2fb33479ca73) and [`f6ceebdc`](https://github.com/CGIC-AI/psfn-framework/commit/f6ceebdc4c05df8f7fc402d9f90ea24826299ce6) added WSS gateway and Garden admin transports.

## 2) Postgres-Only Runtime Persistence And Recoverability

The runtime moved from a SQLite-centered alpha shape to Postgres/pgvector as the
required persistence layer for memory, episodes, contacts, intentions, concerns,
internal state, scratchpad rows, projections, and model usage. SQLite remains
only for migration tooling and adapter tests.

### Delivered capability

- Runtime startup now fails closed without `POSTGRES_DATABASE_URL`.
- L0 transcript projections and L0.1 episodic stores are Postgres-backed.
- Memory evolution links, contacts, intentions, reflections, and internal state
  participate in migration or runtime Postgres stores.
- Scheduled backups now include Postgres dumps, restore-fidelity verification,
  companion/system/workspace trees, hash manifests, and encrypted backup sets.

### Representative commits

- [`6ce9549f`](https://github.com/CGIC-AI/psfn-framework/commit/6ce9549f2b6900e96dae20bc817df596910c8d2e) required Postgres runtime persistence.
- [`7ea185ff`](https://github.com/CGIC-AI/psfn-framework/commit/7ea185ff35ada42c2a77db9a1866bf17b5133cbb) and [`22c7c8bc`](https://github.com/CGIC-AI/psfn-framework/commit/22c7c8bcd47d1f766a2783d91cc39c5e5c691870) added and wired the Postgres episodic store.
- [`9c565fd6`](https://github.com/CGIC-AI/psfn-framework/commit/9c565fd664340f89bdac69b4458c8b81d7dbbf62) extended migration coverage to contacts, intentions, and reflections.
- [`dbd52a2b`](https://github.com/CGIC-AI/psfn-framework/commit/dbd52a2b41a4cf34499494dc0c78f019f9992151) added Postgres dump capture to scheduled backups.
- [`220cdd3a`](https://github.com/CGIC-AI/psfn-framework/commit/220cdd3ac96af697a2c67431f81e14caf670ed2f) added restore-fidelity verification.
- [`10117ba7`](https://github.com/CGIC-AI/psfn-framework/commit/10117ba7c5614c9d7cbb34691678863bc52c8187) encrypted scheduled backup sets.

## 3) Prompt Assembly, Tool Surface, And Provider Cache Refactor

Prompt construction was refactored around a single assembly path. The branch
introduces a `PromptPlan` artifact, a registered prompt-variable namespace,
macro volatility rules, cache-safe static prefix handling, Loom/provider-payload
visibility, and one semantic tool per domain.

### Delivered capability

- Prompt variables are registered in one manifest and written through one frozen
  namespace per turn.
- Static prompt layers reject turn-volatile macros before they can poison
  provider prompt caching.
- Loom and provider-wire views render the same `PromptPlan` artifact.
- Runtime context is decomposed into declared section producers.
- Model-facing tool names were canonicalized around action-bearing semantic
  tools plus `tool_search` and `toolset`.

### Representative commits

- [`53e97e1f`](https://github.com/CGIC-AI/psfn-framework/commit/53e97e1fd4e90f52d052105308c01f1ccb53faa3) introduced the single prompt-variable namespace.
- [`b10b68c6`](https://github.com/CGIC-AI/psfn-framework/commit/b10b68c6dcdaa64c6e2de89d6b0833c6ba72f8a2) added the `PromptPlan` artifact and single assembly path.
- [`634ec9ea`](https://github.com/CGIC-AI/psfn-framework/commit/634ec9ea5f228548752c7b1e26007a3f4ab5aa89) made Loom render the `PromptPlan`.
- [`e1a50234`](https://github.com/CGIC-AI/psfn-framework/commit/e1a502343f1dce08915626681ec3ae0aaf2f20b2) added model-agnostic provider cache engagement.
- [`c2c99796`](https://github.com/CGIC-AI/psfn-framework/commit/c2c997967c9ad594b19d4ec1edfdc6ce018f5193) consolidated macros under the purity rule.
- [`e81f1a32`](https://github.com/CGIC-AI/psfn-framework/commit/e81f1a3242edd3f8a3d599c6834937f7dd6777b2) decomposed runtime context into declared section producers.
- [`4e0dee77`](https://github.com/CGIC-AI/psfn-framework/commit/4e0dee770bf54cc1c40dcd2a09eb706779e74318) canonicalized the model-facing tool surface.

## 4) Context Envelope And Group-Scoped Privacy

The old single-axis channel visibility model was replaced by a Context Envelope:
channel privacy, audience size, audience knowledge, broadcast state, delivery
style, and contact-tracking mode are derived before prompt assembly and before
memory policy checks.

### Delivered capability

- `semi_private` is migrated to `invite_only`, while broadcast becomes a boolean
  flag instead of a privacy level.
- Channel labels move into `channels.json`; trust-policy values are migrated or
  rejected fail-closed.
- ConversationScope is threaded through turns, reflection, heartbeat, prompt
  binding, memory retrieval, and group-chat tests.
- `speaking_with` prompt context is DM-only; group turns use author and
  conversation-state macros instead.
- Garden memory bodies are sensitivity-gated with audited reveal/elevation
  routes.
- Contact approval mode lets invite-only rooms keep unapproved speakers
  transcript-attributed but untracked.

### Representative commits

- [`55965aca`](https://github.com/CGIC-AI/psfn-framework/commit/55965aca5d2a4c3307a9972186841683315d88d5) added the Context Envelope contract.
- [`4771f63f`](https://github.com/CGIC-AI/psfn-framework/commit/4771f63f6afdec52c22176b86ae51f99ce16662d) migrated channel-owned privacy labels.
- [`1af08484`](https://github.com/CGIC-AI/psfn-framework/commit/1af084845e953a8caa730c43d53625ae0a5058e8) wired envelope derivation and gates.
- [`d115aa32`](https://github.com/CGIC-AI/psfn-framework/commit/d115aa32a095a6ce16e6479176f8e2dd4dc86f4b) added the contact-tracking policy gate.
- [`51833417`](https://github.com/CGIC-AI/psfn-framework/commit/51833417dfa5f8df983d7d44fe47a8ad9f911667) sensitivity-gated the Garden memory API.
- [`c2ab9789`](https://github.com/CGIC-AI/psfn-framework/commit/c2ab97892426577ac8159e15ddad91084e97be5b) introduced ConversationScope at binding points.
- [`4031f09e`](https://github.com/CGIC-AI/psfn-framework/commit/4031f09e0047d4f43bfd764b1e746e8a081d4666) covered multi-companion observation correctness in shared rooms.

## 5) Memory System Maturation

The memory subsystem gained distinct lanes for foreground active context,
near-turn extraction, candidate episode synthesis, sleep consolidation, arc
weaving, group-room memory, social-graph proposals, and durable wiki knowledge.

### Delivered capability

- Foreground turns use cached active-memory context and do not block on legacy
  retrieval fallbacks.
- Episode synthesis has message-claim invariants, deterministic gates,
  optional topic segmentation, candidate/canonical lifecycle status, and
  nightly consolidation.
- Arc membership is mutable and audited, and consolidation re-points arc
  memberships away from superseded candidates.
- Group memory has JSON-owned classification, range planning, salience,
  structured attribution, write caps, backfill controls, diagnostics, and
  shared-background retrieval.
- The social-graph builder proposes operator-reviewed relationship edges from
  room evidence instead of writing live edges automatically.
- The wiki surface provides durable authored/imported reference knowledge with
  text search, pgvector semantic projection, sleeptime wiki update passes, and
  supplemental prompt RAG.

### Representative commits

- [`35324ca7`](https://github.com/CGIC-AI/psfn-framework/commit/35324ca77b656c5b44df78df7dec091f2a00470b) added episodic message claims.
- [`34767455`](https://github.com/CGIC-AI/psfn-framework/commit/347674559499aa3244654027da1c80b88c081015) retired blocking legacy retrieval fallback from the turn hot path.
- [`17c6333c`](https://github.com/CGIC-AI/psfn-framework/commit/17c6333cd38aa4d1e09deeafec50425b5562af8c) added deterministic episode-synthesis gating.
- [`a96963e7`](https://github.com/CGIC-AI/psfn-framework/commit/a96963e7f85bee30082f42402a7d7cafba50bab2) added the candidate-then-consolidate sleep pass.
- [`8ff8d34b`](https://github.com/CGIC-AI/psfn-framework/commit/8ff8d34b9ce6806459aa443a36143ac78b30bda1) added mutable, audited arc membership.
- [`764dc731`](https://github.com/CGIC-AI/psfn-framework/commit/764dc731ce8a74caa6345e8aa6006666f8dac134) started the group-memory settings contract.
- [`ff6d94f3`](https://github.com/CGIC-AI/psfn-framework/commit/ff6d94f3f69258de8fce9e3d7cc09a2e0f9c1599) exposed group-memory diagnostics.
- [`27cdc52f`](https://github.com/CGIC-AI/psfn-framework/commit/27cdc52fba36e9224b5ff6feb29597b9f599939d) added the social-graph builder worker.
- [`612c1e16`](https://github.com/CGIC-AI/psfn-framework/commit/612c1e16fc200f658a0b5e0277333ed982f4ba0a) added shared-background retrieval mode.
- [`3049180f`](https://github.com/CGIC-AI/psfn-framework/commit/3049180fd12f5925d7c2044def271f260e426c70) added the workspace-backed wiki knowledge base.
- [`68b60d64`](https://github.com/CGIC-AI/psfn-framework/commit/68b60d64fbaf5d3eb428afaeb7942839a61aa1c1) added supplemental wiki RAG in prompt assembly and subsystem health.

## 6) Autonomy, Temporal Presence, And Fatigue Budgets

The branch adds several bounded autonomy primitives: fatigue accounting,
deterministic pre-LLM gates, temporal wake-up notes, self-directed free-time
blocks, weighted thoughts, durable concern route handoffs, and guarded proactive
outreach.

### Delivered capability

- Fatigue budgets and overcharge reserves bound repeated companion-to-companion
  and background autonomy loops.
- Temporal wake-up lanes inject system-note time framing for morning and idle
  gaps; habit estimation can choose the effective wake window.
- Free-time lanes run bounded internal sessions without sending anything to a
  partner channel.
- Deterministic gates skip costly LLM passes when there is no evidence of
  change.
- Weighted thoughts, concern candidates, outreach outbox state, route handoffs,
  and delivery provenance make proactive behavior auditable.

### Representative commits

- [`015827d7`](https://github.com/CGIC-AI/psfn-framework/commit/015827d7c3d18cdfb48c022899f33f138b397a6e) added fatigue budget accounting.
- [`1c046df9`](https://github.com/CGIC-AI/psfn-framework/commit/1c046df9bfe22f8b0e6109eaaa1c480b1dc1c286) wired shared fatigue enforcement.
- [`8a7ef198`](https://github.com/CGIC-AI/psfn-framework/commit/8a7ef19820e363a8909f1662924ef81d25e47e53) added the deterministic pre-LLM gate primitive.
- [`28281669`](https://github.com/CGIC-AI/psfn-framework/commit/28281669d3598c9015487f5c063c7832eddf84ce) added temporal wake-up lanes.
- [`62ac98b8`](https://github.com/CGIC-AI/psfn-framework/commit/62ac98b8f071e96f2e5e018ad67688b742a180ff) added the habit wake-window estimator.
- [`f502c6ea`](https://github.com/CGIC-AI/psfn-framework/commit/f502c6ea27d8f431e7ee2edb4170e6dc6786d77c) added the free-time lane.
- [`e6d56228`](https://github.com/CGIC-AI/psfn-framework/commit/e6d562280e991ab9e357b226706ba86fc0bc59b1) added the weighted-thought lifecycle.
- [`ab87ae2f`](https://github.com/CGIC-AI/psfn-framework/commit/ab87ae2fd9b900ee653ddfab22b9ee31d5a92f9b) added internal-state-driven outreach initiation.
- [`f1942e71`](https://github.com/CGIC-AI/psfn-framework/commit/f1942e71fbddb9f5d1d54f39dfc3f230e919b6ef) added durable route handoff for concern outcomes.

## 7) Garden, Companion Client, And Operator Observability

Garden was split into route/service groups and expanded into a broader cockpit.
The branch also introduces a standalone mobile-first PWA client for the
Satellite Hub protocol and a separate observer-evaluation sidecar surface.

### Delivered capability

- Garden routes/services were decomposed and heavy pages were lazy-loaded.
- New Garden pages and APIs cover contact approvals, graph proposals, room
  rosters, wiki, session recovery, subsystem health, model usage, observer
  evaluation, and richer memory/session inspection.
- Admin auth became stricter on non-loopback hosts and browser token storage was
  hardened.
- `companion-ui/` provides a standalone Satellite Hub PWA with protocol framing,
  stream projection, activity drawer, settings drawer, composer, presence, and
  fail-closed approval/artifact placeholders.
- Observer-evaluation sidecar support spans turn capture, queueing, privacy
  boundary, EmoSim runtime, deployment settings, Postgres persistence, Garden
  API/UI, and health exposure.

### Representative commits

- [`c59edba1`](https://github.com/CGIC-AI/psfn-framework/commit/c59edba13d40afd575e62bbb205765013a795c46) split Garden route groups.
- [`fe894064`](https://github.com/CGIC-AI/psfn-framework/commit/fe894064dcf993a967dcfdbac1b9eb315049e3c6) lazy-loaded Garden pages.
- [`6d45653c`](https://github.com/CGIC-AI/psfn-framework/commit/6d45653c725b30d4ef7513a30c2ba275da621007) added the subsystem-health backend and admin route.
- [`b37affb1`](https://github.com/CGIC-AI/psfn-framework/commit/b37affb122ed8132b0fa8ed897a6c33a22095865) added the Garden subsystem-health page.
- [`27489933`](https://github.com/CGIC-AI/psfn-framework/commit/2748993320309dd6b00676ae8d9dd1a9b9370496) added mounted session recovery and CogSec bulk redaction.
- [`e8aed683`](https://github.com/CGIC-AI/psfn-framework/commit/e8aed6830269cb741744c3029fb06a1a5e661193) added the Satellite Hub protocol contract.
- [`303d93de`](https://github.com/CGIC-AI/psfn-framework/commit/303d93dee4dffb55625a67860d8dc00caea39919) scaffolded the companion mobile PWA.
- [`121bb716`](https://github.com/CGIC-AI/psfn-framework/commit/121bb716a67c6a2aeb9a0fd381c590b0c310ceb9) split the companion UI components.
- [`91e301b3`](https://github.com/CGIC-AI/psfn-framework/commit/91e301b31e65cd80a1bcde69b328e4b3f70f43af) added the observer-evaluation sidecar turn integration.
- [`ce6a6b4c`](https://github.com/CGIC-AI/psfn-framework/commit/ce6a6b4c02797f1bdb4b85b7e0d4b0e9bffe603f) added the observer sidecar Garden UI.

## 8) Model Routing, Media, Security, And Repository Refactors

The branch also moves several cross-cutting surfaces out of prototype form:
usage/cost capture, prompt-prefix caching, LLM circuit breakers, unreachable
route cooldowns, generated media metadata, Discord file quarantine/document
parsing, CogSec remediation, and eval tooling extraction.

### Delivered capability

- Model usage and provider cost telemetry are persisted and exposed through
  Garden transport.
- OpenRouter/LiteLLM cost capture moved to the gateway edge.
- Prompt prefix caching gained an app-cache backend.
- LLM transport gained circuit breakers and fast failover for unreachable routes.
- Generated image artifacts gained persistent gallery metadata and model catalog
  defaults.
- Discord uploads are quarantined, and DOCX attachments can be parsed through a
  guarded ingestion path.
- CogSec recovery gained tombstone, revocation, regeneration, notice, and
  session-recovery remediation modes.
- The old in-repo eval tree was extracted into a sibling toolkit, reducing this
  repo's product surface.

### Representative commits

- [`3e231951`](https://github.com/CGIC-AI/psfn-framework/commit/3e2319513765455c19f50e1c2ff3a787e9bff936) added durable model usage telemetry.
- [`b72203b5`](https://github.com/CGIC-AI/psfn-framework/commit/b72203b5684b2fd12c108fc18d5dd2294b801467) tracked OpenRouter provider usage costs.
- [`b88b2cd7`](https://github.com/CGIC-AI/psfn-framework/commit/b88b2cd7c7448df40a84337ddb9108518a4a3a7a) added the app-cache prompt-prefix backend.
- [`9719d714`](https://github.com/CGIC-AI/psfn-framework/commit/9719d71496d526de11dc09fce8aae7957958fc6a) added gateway circuit breakers.
- [`543571f8`](https://github.com/CGIC-AI/psfn-framework/commit/543571f8f6fdf74c7764eacf160b4b2e9bec5a2f) extended unreachable LLM cooldown.
- [`c655dedd`](https://github.com/CGIC-AI/psfn-framework/commit/c655dedd25114aa86862bbd008dcccd616f2923f) implemented persistent image gallery metadata.
- [`38f79141`](https://github.com/CGIC-AI/psfn-framework/commit/38f79141c6c10e992af0401168289317e41b951e) quarantined Discord file uploads.
- [`35f16c5a`](https://github.com/CGIC-AI/psfn-framework/commit/35f16c5aa8c3b8a806c5ce9812cb8fb0b3563013) parsed DOCX attachments.
- [`d7f96815`](https://github.com/CGIC-AI/psfn-framework/commit/d7f9681552b0c994b24de25a11bdde88fd1b5e56) started CogSec tombstone remediation.
- [`fbd3eace`](https://github.com/CGIC-AI/psfn-framework/commit/fbd3eace8aac37c9df10c31ccfc0c75da754c7e9) extracted the eval toolkit.

# Addendum: 2026-07-02 → 2026-07-07 (`543571f8..82b66467`)

The work after the section 1-8 endpoint concentrates on getting the substrate
onto a live Kubernetes shard and keeping it healthy there: a component-selective
ship pipeline, companion self-diagnosis, tool-call reliability under real
providers, durable scheduled prompts that survive frequent agent restarts, a
deliberate contact-trust ratchet, and a broad security/correctness hardening
sweep (`mlwk` P1 findings). It also lands an internal consolidation pass that
removes retired SQLite bridges and dedupes byte-identical helpers.

## A) Live Deploy Pipeline And Ship Lane

Deployment moved from static manifests to an operable ship lane targeting the
live shard: component-selective kube ships with a contract-skew guard, a
topology-aware pre-ship gate, in-image tool pinning, and two-way companion beads
sync so the running companion's issue graph round-trips with the operator.

### Delivered capability

- `ship:kube` supports multiple targets with architecture probing, a remote
  staging dir, and beads-sync host forwarding.
- Ships are component-selective and guarded by a contract-skew check; a values
  overlay rides the same upgrade so config enablements deploy atomically.
- The runtime image pins `bd` and `ripgrep`, mounts a repo checkout, copies
  `patches/` into build stages, and uses a `Recreate` strategy for hostPort
  deployments; EmoSim is a selectable ship component.
- Ships refresh the companion's source checkout and round-trip beads two ways
  over the ship lane.
- A post-rollout validation gate script runs operator-side after each ship.

### Representative commits

- [`bd11b80c`](https://github.com/CGIC-AI/psfn-framework/commit/bd11b80c8bd9b04e9c8fc7dac855d552927506ad) added multi-target `ship:kube`.
- [`51084736`](https://github.com/CGIC-AI/psfn-framework/commit/51084736a4f77de88670d4265ead9bc7c0af1bc4) made kube ships component-selective with a contract-skew guard.
- [`9480fd5e`](https://github.com/CGIC-AI/psfn-framework/commit/9480fd5ee72a65de0294a9fac9b1e0232b523a68) added the topology-aware garden/gateway pre-ship gate.
- [`540c25b0`](https://github.com/CGIC-AI/psfn-framework/commit/540c25b00632b1e606890855792d84f73a236582) pinned in-image tools, added the repo-checkout mount and `Recreate` strategy.
- [`6de4f5ed`](https://github.com/CGIC-AI/psfn-framework/commit/6de4f5ed093f6107e4cd5b70df9e2afd14281e62) and [`1b767ad5`](https://github.com/CGIC-AI/psfn-framework/commit/1b767ad5bf3d1197509324594f28b22bdf3e24e4) added two-way companion beads sync and source-checkout refresh over the ship lane.
- [`a491dc65`](https://github.com/CGIC-AI/psfn-framework/commit/a491dc65042e5000bfc12648adfdbaf6a92b7299) made EmoSim a selectable ship component.
- [`e4a2bd5c`](https://github.com/CGIC-AI/psfn-framework/commit/e4a2bd5c0e0986262b1394b2f24dbeaa1ce3e76e) added the operator-side post-rollout validation gate.

## B) Companion Self-Diagnosis And Runtime Diagnostics

The companion gained a self-diagnosis surface and the runtime gained a bounded,
redacted diagnostics service reachable through the agent admin transport, plus a
conformance harness that checks the live tool surface against its writer
contract.

### Delivered capability

- `self_status` exposes a companion self-diagnosis surface.
- A bounded, redacted runtime diagnostics surface is threaded through the agent
  admin transport server.
- A live tool-surface conformance smoke harness and a conformance validator
  keep the exposed tool set aligned with the writer contract.
- `response_control` rejects malformed args; the census probe carries explicit
  scope.

### Representative commits

- [`fd499268`](https://github.com/CGIC-AI/psfn-framework/commit/fd499268b4d764288af4a640d433f95aae58e61e) added the companion self-diagnosis surface to `self_status`.
- [`3a96066d`](https://github.com/CGIC-AI/psfn-framework/commit/3a96066d75ba2bbf94b8c890badc19da74ec9eac) added the bounded, redacted runtime diagnostics surface.
- [`52c2ef55`](https://github.com/CGIC-AI/psfn-framework/commit/52c2ef559b38711b41e85f87c45995795505dea4) threaded diagnostics through the agent admin transport server.
- [`c28109ca`](https://github.com/CGIC-AI/psfn-framework/commit/c28109ca5b5ad1ce327651b5a96fe776ce5183ad) added the live tool-surface conformance smoke harness.

## C) EmoSim As A Long-Lived Service And Projection v2

The observer-evaluation EmoSim moved from an in-turn computation to a long-lived
service with a server-backed sidecar adapter, and the internal-state projection
advanced to v2 (attachment/safety/agency_other derived from per-turn evidence)
with shadow trigger levers.

### Representative commits

- [`55de558a`](https://github.com/CGIC-AI/psfn-framework/commit/55de558a10cbb31f8773db6477762c47aec17e4a) made EmoSim a long-lived service with a server-backed sidecar adapter.
- [`124ce89c`](https://github.com/CGIC-AI/psfn-framework/commit/124ce89c04b4c68e8941903016cfe9a1b4078831) derived attachment/safety/agency_other from per-turn evidence (projection v2).
- [`bc5ee967`](https://github.com/CGIC-AI/psfn-framework/commit/bc5ee9670d56f1d594940e25d934dfc6f8c6b763) added shadow trigger levers over observer-eval EmoSim state.

## D) Contact Trust Ratchet And Social-Graph Evidence

Relationship trust became a deliberate, auditable ratchet: a nightly trust-drift
review lane derives behavior signals, trusted-tier promotions require
human-in-the-loop approval, and the social-graph pipeline now persists memory
provenance so edges are backed by evidence.

### Delivered capability

- A deliberate interlocutor relationship ratchet and a nightly contact
  trust-drift review lane derive behavior signals.
- Trusted-tier promotion proposals require human-in-the-loop approval.
- Production relationship scores are wired into Garden contacts.
- The social-graph evidence pipeline persists memory provenance, carries it on
  legacy routing, and backfills the journal; mention-only extraction matches
  display name and nickname, not just preferred name.

### Representative commits

- [`57a55839`](https://github.com/CGIC-AI/psfn-framework/commit/57a558391a51a92d13b37c36bfe192af12c8ca63) added the deliberate interlocutor relationship ratchet.
- [`52cf9999`](https://github.com/CGIC-AI/psfn-framework/commit/52cf9999ac1b1520b4d81722af24bcf8ed01f0f9) added the nightly contact trust-drift review lane.
- [`a3c3e715`](https://github.com/CGIC-AI/psfn-framework/commit/a3c3e71542c4098a3952be87a58b59d17f66cefa) added human-in-the-loop trusted-tier promotion proposals.
- [`35feed86`](https://github.com/CGIC-AI/psfn-framework/commit/35feed8645a35a2a8e0869ad45b0b6dfcabf6bd8) wired the production relationship score reader into Garden contacts.
- [`f8ae97fd`](https://github.com/CGIC-AI/psfn-framework/commit/f8ae97fdea777ce22ecf419075644cebf42d7e57) persisted memory provenance through the social-graph evidence pipeline.
- [`8aff2efe`](https://github.com/CGIC-AI/psfn-framework/commit/8aff2efee8b582e8fc578a5ea3059ab66aa6f224) matched mention-only contact extraction on display name and nickname.

## E) Durable Scheduled Prompts And Reflection Cadence

One-shot and recurring scheduled prompts now survive the frequent agent
restarts that used to make the in-memory scheduler forget them, and reflection
cadences gained novelty gating plus a rewrite of scheduled self-eval prompts.

### Delivered capability

- Scheduled prompts persist in Postgres (`scheduler_scheduled_prompts`,
  CHECK-constrained, partial pending-due index) and rehydrate at startup;
  completion is recorded only after successful delivery, so a failed delivery
  re-fires after the next restart.
- A weekly wall-clock reflection cadence was added and the Garden
  heartbeat-policy path divergence fixed; `/values` renders read-only
  metacognition/daily/journal reflection endpoints.
- Cadence-fired reflection templates gate on a novelty watermark.
- Scheduled self-eval prompts were audited and rewritten per the workspace-paper
  rules R1-R7.

### Representative commits

- [`79494c11`](https://github.com/CGIC-AI/psfn-framework/commit/79494c11510e8322c0000782e8a5690702ecbb6e) made scheduled prompts durable across restarts and added `/values` reflection journals.
- [`0b87b000`](https://github.com/CGIC-AI/psfn-framework/commit/0b87b000346f91d2e5e53e3ebf3d46d9df520240) fixed the Garden heartbeat-policy path divergence and added the weekly reflection cadence.
- [`2f8ba5e8`](https://github.com/CGIC-AI/psfn-framework/commit/2f8ba5e843f104d09db651306239a2476762afe5) added a novelty watermark gate for cadence-fired reflection templates.
- [`98655a40`](https://github.com/CGIC-AI/psfn-framework/commit/98655a40949862d0d4c067f9442518922680633b) audited and rewrote scheduled self-eval prompts.

## F) Tool-Call Reliability And Model Routing

Tool-call handling was hardened against real-provider failure modes: corrupt
empty tool-call args now trigger a fail-closed retry, streamed tool-call args
are no longer lost when reasoning interleaves, and GLM-5.2 routes through the
OpenRouter `:exacto` variant. A per-provider tool-call eval harness backs the
work, and ad hoc retry/fallback loops were consolidated onto shared primitives.

### Representative commits

- [`a186538c`](https://github.com/CGIC-AI/psfn-framework/commit/a186538c360f1ca1ffcf1b4b2d2e48d79a1634b2) added fail-closed completion retry on corrupt-empty tool-call args.
- [`27e64df4`](https://github.com/CGIC-AI/psfn-framework/commit/27e64df49154b25ff4db811adca9a5480c5597f4) fixed streamed tool-call args lost on interleaved reasoning.
- [`dc2a26f5`](https://github.com/CGIC-AI/psfn-framework/commit/dc2a26f522bf0414b1b1ced1c8d8a930f509b6b0) routed GLM-5.2 via the OpenRouter `:exacto` variant.
- [`f277dae0`](https://github.com/CGIC-AI/psfn-framework/commit/f277dae009be915842e8234fab155e1933ff4a28) added the OpenRouter per-provider tool-call eval harness.
- [`9f4867a1`](https://github.com/CGIC-AI/psfn-framework/commit/9f4867a11491e72057393211438bb15049d7c837) consolidated ad hoc LLM retry/fallback loops onto shared primitives.

## G) Tool Surface And SQLite Retirement

The direct tool surface was tuned and dead SQLite paths were removed: `journal`
was promoted to the always-available core tier (with `notify` demoted behind
`load_tools`), retired per-action tool factories collapsed into plain action
functions, and SQLite-only maintenance/importer commands were retired.

### Representative commits

- [`7fc6d1b4`](https://github.com/CGIC-AI/psfn-framework/commit/7fc6d1b48cf5bcd4e6ce1283e005acb09cfd08a8) promoted `journal` to the core tool tier and demoted `notify` to extended.
- [`6d1bb011`](https://github.com/CGIC-AI/psfn-framework/commit/6d1bb011121ca631975012fad377ca1751bdbcb5) widened the model-facing drift guard to concerns, `north_star`, and lifecycle aliases.
- [`23df9e7c`](https://github.com/CGIC-AI/psfn-framework/commit/23df9e7c053516945dbcc290401a87bf7ccc2ac7) retired SQLite-only maintenance and importer commands.
- [`7955e534`](https://github.com/CGIC-AI/psfn-framework/commit/7955e5347795ecb85367f279620e18d4b440dacf) extracted shared surfaces and severed dead SQLite bridges.

## H) Turn Correctness And Continuation Fixes

Several continuation and post-turn bugs that produced double replies, clobbered
authored replies, or double-counted the last exchange were fixed, and paid
attachments can no longer be silently dropped.

### Representative commits

- [`0ecaa08d`](https://github.com/CGIC-AI/psfn-framework/commit/0ecaa08d0fd4e4bc6dc3099301c0d48d7f0ab64a) stopped continuation `no_reply` from clobbering the authored user reply.
- [`65707a68`](https://github.com/CGIC-AI/psfn-framework/commit/65707a6808d19bede46915a25849a53ab7d930d9) stopped deferred-tool-handoff continuation double-replies.
- [`0f2835db`](https://github.com/CGIC-AI/psfn-framework/commit/0f2835db65d4b87ecdc615ea18f582d80decf9fc) stopped post-turn appraisal from seeing the last exchange twice.
- [`3e5b8588`](https://github.com/CGIC-AI/psfn-framework/commit/3e5b858810207c6a1367b48506b6c60fe6a34cd0) blocked silent no-reply drop of paid attachments.
- [`e22c1653`](https://github.com/CGIC-AI/psfn-framework/commit/e22c1653e55de192ce880e7cca8c3aec23699983) stopped persisting `CompletionHandoff` into session transcripts.
- [`50175b3f`](https://github.com/CGIC-AI/psfn-framework/commit/50175b3f546a24a9bb857244ea502c0974e557dc) added a temporal-window continuity floor with handoff exclusion.

## I) Security And Correctness Hardening (`mlwk` P1 Sweep)

A broad P1 review pass (~40 commits under the `mlwk` bead family) hardened
backups, memory patches, archive/ZIP handling, the sandbox, and the
social-graph reader. Representative examples:

- [`643352bf`](https://github.com/CGIC-AI/psfn-framework/commit/643352bf40ccb7bcd27fd83cd64d67d69d4bcd4b) implemented real Postgres transactions for memory patch flows.
- [`18f0824f`](https://github.com/CGIC-AI/psfn-framework/commit/18f0824f7c4c05fca27b01f4f17a4f6a3eb88fa6) kept Postgres backup credentials out of `pg_dump` argv.
- [`8b47caba`](https://github.com/CGIC-AI/psfn-framework/commit/8b47caba2dc135a68b66fd2c83c167017331ee0f) rejected negative tar entry sizes in archive scanning.
- [`d3a25fb2`](https://github.com/CGIC-AI/psfn-framework/commit/d3a25fb2ca7a27c3162200d72da7ca050440166d) bounded ZIP inflate output during decompression.
- [`430a5c97`](https://github.com/CGIC-AI/psfn-framework/commit/430a5c974513aed832be62c7d11b726b364ceeff) reserved `PATH` and loader-injection env vars from sandbox passthrough.

## J) Consolidation, Charge, And Dependencies

Byte-identical helpers were deduped onto shared utilities, static config was made
fail-loud in the image, and a dependency swap was ultimately reverted.

- [`d61795f4`](https://github.com/CGIC-AI/psfn-framework/commit/d61795f48e7c2ce59af5a498d698eb126207151b) consolidated `clampUnit`/`clampSigned`/`clamp` into shared numeric utils.
- [`dfd4e4fa`](https://github.com/CGIC-AI/psfn-framework/commit/dfd4e4fa1bb544935f2cb8c6aeec1fc35d9a24b7) and [`b59e7233`](https://github.com/CGIC-AI/psfn-framework/commit/b59e7233789efc100dc48e2af7878e71536a7132) deduped small helpers and consolidated XML/HTML escaping.
- [`6c6c4941`](https://github.com/CGIC-AI/psfn-framework/commit/6c6c4941258d47c1d9e4053938318da8befdf9e9) failed closed on owner-file seeding and surfaced charge quotas.
- [`29fec8b0`](https://github.com/CGIC-AI/psfn-framework/commit/29fec8b090106744a122fe662dc581f3db9358a7) shipped `concern-softening.json` in the runtime image and fails loud on missing static config.
- [`f1d23c32`](https://github.com/CGIC-AI/psfn-framework/commit/f1d23c32a3ce9623884736da0033e00f1faded9f) removed the prefetch dotenv dependency; the pi-ai 0.73.1 swap at the tip was [`82b66467`](https://github.com/CGIC-AI/psfn-framework/commit/82b66467855dda25ee0602ae0198a8cc8a07d8be) **reverted**, so the branch tip keeps the prior pi-ai pin.

## Notes For Agents

- Start with the version timeline for exact endpoints.
- Use the thematic sections for orientation; this file is not a substitute for
  `git log` when debugging a specific regression.
- The highest-signal source documents for this window are `README.md`,
  `docs/memory.md`, `docs/context-envelope.md`, `docs/prompt-macros.md`,
  `docs/operations.md`, `docs/chat-turn-lifecycle.md`, `docs/tool-surface.md`,
  `docs/self-eval-prompt-audit.md`, `companion-ui/README.md`, and the
  representative commits linked above. For the addendum window, the ship lane and
  live-shard operations are additionally documented in the `psfn-live-ops` skill.
- Issue-tracker intent is mostly visible through bead IDs embedded in commit
  subjects; the authoritative local tracker remains `bd`.

## Evidence Sources Used

- `git fetch --all --prune`
- `git log --reverse --date=short --format='%h %ad %s' --no-merges origin/main..origin/foundation_e0_e2`
- `git diff --stat origin/main..origin/foundation_e0_e2`
- `git diff --name-status origin/main..origin/foundation_e0_e2`
- `git for-each-ref refs/tags --sort=creatordate`
- `gh release list --limit 100`
- Existing docs and source anchors under `README.md`, `docs/`, `src/`,
  `admin-ui/`, and `companion-ui/`
- Addendum window: `git log --no-merges 543571f8..82b66467` (141 non-merge
  commits) with per-commit `git show --stat` spot-checks against `src/`
