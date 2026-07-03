# Changelog

This is a synthesized, agent-facing changelog for the branch delta from the
latest `origin/main` tip to the latest `origin/foundation_e0_e2` tip.

Scope window: `origin/main..origin/foundation_e0_e2`, ending at
`foundation_e0_e2` commit
[`543571f8`](https://github.com/CGIC-AI/psfn-framework/commit/543571f8f6fdf74c7764eacf160b4b2e9bec5a2f)
on 2026-07-02.

This document intentionally summarizes new capabilities and meaningful
refactors. It does not enumerate every bugfix, test repair, fixture sync, or
follow-up cleanup commit in the 455 non-merge commits in the range.

## Version Timeline

No git tags or GitHub Releases were present in this checkout for this window.
`Kind` therefore identifies branch endpoints rather than published releases.

| Version | Kind | Date | Summary |
|---------|------|------|---------|
| [`origin/main` `b4e9840`](https://github.com/CGIC-AI/psfn-framework/commit/b4e98406483b3890e7fd97dc639fd73ffb70612c) | Branch endpoint | 2026-06-06 | Latest main commit used as the comparison baseline. |
| [`63f8190`](https://github.com/CGIC-AI/psfn-framework/commit/63f81900d1e99e810bc69438002cd0da58172090) | Merge base | 2026-03-27 | Common ancestor of `origin/main` and `origin/foundation_e0_e2`. |
| [`foundation_e0_e2` `543571f`](https://github.com/CGIC-AI/psfn-framework/commit/543571f8f6fdf74c7764eacf160b4b2e9bec5a2f) | Branch endpoint | 2026-07-02 | Foundation branch tip with the E0-E2/E3-E8 substrate work integrated. |

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

## Notes For Agents

- Start with the version timeline for exact endpoints.
- Use the thematic sections for orientation; this file is not a substitute for
  `git log` when debugging a specific regression.
- The highest-signal source documents for this window are `README.md`,
  `docs/memory.md`, `docs/context-envelope.md`, `docs/prompt-macros.md`,
  `docs/operations.md`, `companion-ui/README.md`, and the representative commits
  linked above.
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
