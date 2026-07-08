# CogSec And Critical Path True-Up

Date: 2026-07-01

Tracked by: `psfn-framework-yjvl`

Purpose: compare the proposed cognition-intake firewall and near-term companion roadmap against the current repository. This is a source-truth planning artifact, not an implementation patch.

## Executive Summary

The proposal is directionally right: the missing safety primitive is a cognition intake firewall, not a generic "ask approval before acting" layer. Current PSFN already has strong pieces of that architecture: split gateway/agent authority, strict config ownership, capability-gated tools, trust-gated memory retrieval, CogSec remediation primitives, wiki/reference storage, group-memory scheduling, prompt snapshots, and recovery/cutout mechanics.

The gap is that those pieces are not yet one membrane. Raw or semi-raw inbound content can still reach prompt-visible text before a shared source/risk/quarantine contract exists. The clearest example is Discord document ingest: risky files are quarantined, but accepted parsed text is appended into `<parsed_attachment_text>` blocks ([src/channels/discord/file-ingest.ts:266](../src/channels/discord/file-ingest.ts#L266), [src/channels/discord/file-ingest.ts:482](../src/channels/discord/file-ingest.ts#L482)). Web fetched text is better wrapped as untrusted ([src/boundary/gateway/sanitize.ts:86](../src/boundary/gateway/sanitize.ts#L86)), and compaction summaries are escaped before prompt use ([src/core/identity/prompt-composer.ts:147](../src/core/identity/prompt-composer.ts#L147)), but public context wrappers and tool observations do not share that same hardened contract ([src/core/session/manager-primitives.ts:982](../src/core/session/manager-primitives.ts#L982), [src/core/session/tool-observation.ts:222](../src/core/session/tool-observation.ts#L222)).

The critical path should therefore split into two tracks:

1. **Parallel P1 CogSec intake firewall MVP:** typed intake envelope, cross-surface classifier/quarantine, safe prompt representation, and gates that consume risk labels.
2. **Main companion substrate trunk:** group/prompt/trust/social stabilization, recovery hygiene, shared-world wiki semantics, group memory and episodic cleanup, companion app, observability/tools/evals, then companion DMs/project mode.

## Shareable Rewritten Proposal

This is the updated proposal after checking the code. It is meant to be readable as: **we are here, we need to go there, and the first half is now tracked by concrete phase epics.**

### Where We Are

PSFN is not starting from scratch. The runtime split, deterministic capability gates, trust-gated memory retrieval, CogSec recovery records, wiki/reference store, group-memory scheduler, and Prompt Monitor substrate all exist. The companion already has a real safety/governance spine: the gateway owns privileged side effects, the agent process is separate, memory retrieval is filtered before prompt assembly, identity edits are capability/cooling-off gated, and CogSec can record sealed incidents and revoke/regenerate tainted artifacts.

The live gap is integration. The current system has several good membranes, but not one consistent cognition membrane. Inbound content still reaches different downstream surfaces through different local conventions: Discord documents, web fetches, tool observations, public context wrappers, memory extraction, wiki writes, prompt assembly, and shard/subagent foldback are not all represented by one typed source/risk/quarantine object.

Group chat is in a similar state. The repo has attribution, trust gates, channel-scoped retrieval, group observation, and social graph storage, but important one-speaker assumptions remain at binding points. The earlier [GROUPCHAT_PROMPT_TRUST_FOUNDATION_PLAN_20260701.md](./GROUPCHAT_PROMPT_TRUST_FOUNDATION_PLAN_20260701.md) captures the detailed group/prompt/trust diagnosis and gives the more surgical plan: fix Loom fidelity first, then ConversationScope, PromptPlan, Context Envelope, and social graph population.

### Where We Go

The target is not a generic agent approval system. It is a companion cognition substrate with two explicit envelopes:

1. **Cognition Intake Envelope:** every inbound item gets source, provenance, risk, quarantine/release state, safe summary, and allowed downstream gates before it can influence prompt, memory, wiki, persona, trust state, or tools.
2. **Context Envelope:** every turn gets channel privacy, audience scope, audience knowledge, broadcast flag, relationship/trust context, and delivery constraints before memory retrieval or prompt assembly decide what is visible.

The model should not be asked to defend itself from arbitrary content already injected into cognition. Untrusted content should usually arrive as a safe labeled object: metadata, provenance, risk labels, and summary. Raw content stays sealed or quarantined until a deterministic policy or operator review releases it.

The prompt system should converge on one `PromptPlan` artifact: the same structured object feeds provider wire payloads, Prompt Monitor/Loom, prompt cache planning, tool visibility, and regression goldens. That closes the gap where the monitor can show a re-derived view rather than the exact thing sent to the model.

### Phase Spine Now Covering The First Half

These phase epics now cover the first half of the remediation trunk. They are referenced here only; this document update does not modify them.

| Phase | Epic | Purpose |
| --- | --- | --- |
| E0 Loom fidelity + regression harness | `psfn-framework-u9jo` children `.1-.4` | P0 tool visibility, prompt/wire truncation honesty, exact-payload confidence, and regression harness. This is first because every later fix needs a trustworthy monitor. |
| E1 Group-chat stabilization | `psfn-framework-k4rf` children `.1-.8` | `ConversationScope`, core-memory binding, `speaking_with` gating, attribution hardening, emotion scoping, sleeptime cadence, reflections, and multi-companion observation correctness. |
| E2 PromptPlan consolidation | `psfn-framework-e0ey` children `.1-.7` | Prompt manifest, single plan artifact, Loom reads the plan, provider/cache stability, macro diet, section decomposition, and prompt goldens. |
| E3 Context Envelope | `psfn-framework-76rn` children `.1-.6` | Context contract, channel-owned privacy, deterministic gating, contact-tracking gate, admin/API exposure, and leak tests. |
| E4 Social graph MVP | `psfn-framework-cy82` children `.1-.5` | Room roster, graph worker/population, edge hygiene, prompt exposure, and shared-background retrieval. |

The CogSec intake firewall runs beside this phase spine:

- `psfn-framework-htm9`: cognition intake firewall epic.
- `psfn-framework-htm9.1`: typed intake envelope and source/risk contract.
- `psfn-framework-htm9.2`: classifier/quarantine across current inbound surfaces.
- `psfn-framework-htm9.3`: prompt, memory, wiki, trust/persona, and tool gates consume intake labels.
- `psfn-framework-i5s2`: shared-world wiki semantics, ACLs, and review gates.

In short: **E0-E4 stabilize what the companion sees and how group context is represented. `htm9.*` stabilizes what content is allowed to become cognition at all. `i5s2` prevents the wiki from becoming a durable shared-world contamination path.**

### Updated Execution Order

1. **E0: Make the Loom truthful.**
   The operator must be able to inspect exact prompt, provider payload, tool definitions, tool calls/results, truncation, and context provenance. Without this, every later change is harder to verify.

2. **E1: Fix group-chat binding points.**
   Introduce `ConversationScope`, stop group turns from binding to one "speaking_with" person, make core memory room-aware, harden attribution, scope emotion/reflection/sleeptime correctly, and verify multi-companion participants are observed without becoming human subjects.

3. **E2: Consolidate prompt construction into `PromptPlan`.**
   One artifact should produce provider wire payload, Loom display, cache plan, prompt sections, and goldens. This is the structural answer to prompt sprawl and monitor mistrust.

4. **E3: Land Context Envelope and deterministic channel/trust semantics.**
   Separate room privacy, audience size, audience knowledge, broadcast status, trust, and sensitivity. Move channel privacy ownership to the channel/config layer, and add contact-tracking gates so large/public rooms do not automatically create durable people.

5. **Parallel: Land CogSec intake MVP.**
   Add the typed intake envelope, wire current sources into classification/quarantine, escape or summarize prompt-visible untrusted content, and make downstream gates consume risk/release state.

6. **E4: Populate and expose the social graph.**
   Build room roster and graph-worker MVP, then expose only compact, sensitivity-clear shared-background facts to prompt context.

7. **Define shared-world wiki semantics before treating wiki as trunk substrate.**
   The current wiki is useful reference storage. Before shared environments, companion DMs, or project worlds lean on it, `i5s2` should define scopes, ACLs, review states, provenance, prompt inclusion, and rollback expectations.

8. **Then continue the broader trunk.**
   Group memory provenance, episodic consolidation/arcs, companion app MVP, tool audit/splits, small evals, companion DMs, and project mode come after the first-half substrate is stable.

### What This Buys Us

The combined plan gives a defensible story:

- The companion can participate in multi-human rooms without treating the last speaker as "the human."
- The operator can see what the model actually saw.
- Prompt construction becomes a legible artifact instead of a pile of macros and re-derived snapshots.
- Channel privacy and trust semantics stop doing too many jobs in one enum.
- Public/external/tool/subagent content cannot silently become raw cognition just because it entered through a different adapter.
- Shared-world knowledge gets review and attribution before it becomes durable substrate for multiple companions or rooms.

## What Changed From The Proposal

Some proposed gaps are already substantially built:

- Runtime split is real. The old monolith exits fail-closed ([src/app/startup/index.ts:6](../src/app/startup/index.ts#L6)); gateway and agent entrypoints own separate responsibilities ([src/app/gateway/main.ts:66](../src/app/gateway/main.ts#L66), [src/app/agent/main.ts:78](../src/app/agent/main.ts#L78)).
- Memory gates are not just aspirational. Trust, channel visibility, consent, room-source visibility, high-intimacy contact scope, and withheld summaries are wired into retrieval ([src/system/trust/policy.ts:209](../src/system/trust/policy.ts#L209), [src/faculties/memory/retrieval/access.ts:141](../src/faculties/memory/retrieval/access.ts#L141)).
- Core memory is more scoped than older notes implied. It renders DM and group-specific context instead of one global human blob ([src/faculties/core-memory/store.ts:364](../src/faculties/core-memory/store.ts#L364), [src/faculties/core-memory/store.ts:680](../src/faculties/core-memory/store.ts#L680)).
- Wiki MVP exists, but as durable lexical/reference storage, not yet a shared-world substrate ([docs/memory.md:76](../docs/memory.md#L76), [src/faculties/wiki/tools.ts:97](../src/faculties/wiki/tools.ts#L97)).
- CogSec recovery mechanics exist: event records, sealed forensic artifacts, lineage, revocation, regeneration, safe notices, and a smoke script ([src/core/cogsec/events.ts:72](../src/core/cogsec/events.ts#L72), [src/core/cogsec/revocation.ts:159](../src/core/cogsec/revocation.ts#L159), [scripts/cogsec-remediation-smoke.ts:12](../scripts/cogsec-remediation-smoke.ts#L12)).

The proposal remains accurate where it says public/broadcast/external content should not become raw cognition by default. That is not consistently enforced today.

## Status Legend

- **Implemented:** production code path exists and is wired to runtime.
- **Partial:** useful primitives exist, but the claimed end-to-end behavior is incomplete.
- **Missing:** no meaningful production path found.

## CogSec Intake Firewall True-Up

| Surface | Current status | Source-truth notes | Main gap |
| --- | --- | --- | --- |
| Source/channel/trust labels | Partial | Trust and channel visibility exist (`TrustLevel`, `ChannelVisibility`, ceilings) ([src/system/trust/types.ts:5](../src/system/trust/types.ts#L5)). `SubstrateMessage` carries author/channel/attachments/routing, but no source class, risk, quarantine, raw-ref, or safe-summary envelope ([src/shared/contracts/runtime.ts:216](../src/shared/contracts/runtime.ts#L216)). | No universal intake envelope. |
| Raw quarantine | Partial | Discord documents classify/quarantine risky attachments and record hash/reasons ([src/channels/discord/file-ingest.ts:266](../src/channels/discord/file-ingest.ts#L266), [src/channels/discord/file-ingest.ts:508](../src/channels/discord/file-ingest.ts#L508)). CogSec forensic archive can seal payloads ([src/core/cogsec/forensic-archive.ts:205](../src/core/cogsec/forensic-archive.ts#L205)). | Quarantine is per-surface, not applied to all inbound text/docs/tool outputs. |
| Safe prompt representation | Partial | Web text is sanitized and wrapped as data-only ([src/boundary/gateway/sanitize.ts:62](../src/boundary/gateway/sanitize.ts#L62)). Compaction summaries are escaped and wrapped ([src/core/identity/prompt-composer.ts:123](../src/core/identity/prompt-composer.ts#L123)). | Clean parsed docs and public-context wrappers can still expose raw text without shared escaping/release semantics. |
| Prompt gate | Partial | Prompt assembly is centralized in `assembleTurnPrompt` ([src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts:153](../src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts#L153)); current turn content becomes provider user content in agent invocation ([src/core/agent/substrate-agent/turn-execution/agent-invocation.ts:142](../src/core/agent/substrate-agent/turn-execution/agent-invocation.ts#L142)). | Prompt assembly does not decide from a shared risk/quarantine label whether raw content may enter. |
| Memory gate | Implemented for retrieval, partial for intake | Retrieval gates use trust, visibility, room source, contact scope, consent, and withheld summaries ([src/faculties/memory/retrieval/access.ts:141](../src/faculties/memory/retrieval/access.ts#L141)). Memory write candidacy rejects obfuscation, executable payloads, policy writes, and persona mutation pressure ([src/core/cogsec/memory-candidacy.ts:122](../src/core/cogsec/memory-candidacy.ts#L122)). | Memory write/retrieval gates do not consume one upstream intake envelope; old rows with weak provenance are harder to gate. |
| Wiki gate | Partial | Wiki storage requires metadata/provenance for imported/generated/external source classes ([src/faculties/wiki/store.ts:45](../src/faculties/wiki/store.ts#L45), [src/faculties/wiki/store.ts:176](../src/faculties/wiki/store.ts#L176)). Tool requires identity-write capability for writes/imports ([src/faculties/wiki/tools.ts:81](../src/faculties/wiki/tools.ts#L81)). | No shared-world ACL/review model; no intake-risk gate for public/external content becoming durable world facts. |
| Persona/self-summary gate | Partial | Identity writes are capability-gated and base-layer edits use cooling-off/audit mechanisms ([src/system/capabilities/requirements.ts:62](../src/system/capabilities/requirements.ts#L62), [src/system/capabilities/safeguards.ts:194](../src/system/capabilities/safeguards.ts#L194)). Persona conformance checks exist for CogSec cleanup ([src/core/cogsec/persona-conformance.ts:1](../src/core/cogsec/persona-conformance.ts#L1)). | No intake-risk-aware persona mutation policy. Reflection-driven persona diff proposals are tracked but open (`psfn-framework-75f.2`). |
| Trust/relationship gate | Partial | Trust and relationship are separate fields and runtime exposes both ([src/core/contacts/types.ts:3](../src/core/contacts/types.ts#L3), [src/core/agent/substrate-agent/runtime-context.ts:1611](../src/core/agent/substrate-agent/runtime-context.ts#L1611)). | Dynamic relationship review/policy is open (`psfn-framework-4caj`, especially `.1`, `.3`, `.6`, `.7`, `.8`, `.14`). Intake risk is not a relationship/trust input yet. |
| Tool gate | Partial | Tool capability dispatch is deterministic ([src/system/capabilities/gate.ts:64](../src/system/capabilities/gate.ts#L64)); gateway approval queues side-effecting actions when policy requires it ([src/boundary/gateway/approval-boundary.ts:79](../src/boundary/gateway/approval-boundary.ts#L79)). | Tool gates do not consume content risk labels; pre-tool hook interception is tracked separately (`psfn-framework-7ym.3`). |
| Shard/subagent foldback | Partial | Shards have provenance/fold-review tests; subagents have lifecycle audit. | Needs intake-risk model for shard output before fold/writeback; long-horizon shard tool work remains open (`psfn-framework-98xm.5`). |
| Audit/proof packets | Partial | Gateway audit and CogSec event records exist ([src/boundary/gateway/audit.ts:41](../src/boundary/gateway/audit.ts#L41), [src/core/cogsec/events.ts:102](../src/core/cogsec/events.ts#L102)). | No standard "inbound content classified/quarantined/released" event across all surfaces. |
| Slow poisoning/drift detector | Partial | CogSec persona conformance and recovery mechanisms exist ([src/core/cogsec/persona-conformance.ts:26](../src/core/cogsec/persona-conformance.ts#L26)). | No rolling suspicion accumulator for repeated identity/trust/policy/self-mod pressure. |

### New Beads Filed

These were missing from the backlog and were created during this true-up:

- `psfn-framework-htm9`: Epic: Cognition intake firewall for untrusted inbound content.
- `psfn-framework-htm9.1`: Define typed intake envelope and source/risk contract.
- `psfn-framework-htm9.2`: Wire intake classifier and quarantine across inbound surfaces.
- `psfn-framework-htm9.3`: Make prompt, memory, wiki, and tool gates consume intake risk labels.
- `psfn-framework-i5s2`: Define shared-world wiki MVP semantics, ACLs, and review gates.

## Critical Path True-Up

| Track from proposal | Current status | Source-truth notes | Remediation |
| --- | --- | --- | --- |
| Group-chat stabilization | Partial | Discord DMs and mentions can route to agent, passive guild observations feed group memory scheduling, and group prompt attribution exists. Group turns are still single-author messages; room membership is inferred from recent entries, not explicit presence ([src/core/agent/substrate-agent/runtime-context.ts:612](../src/core/agent/substrate-agent/runtime-context.ts#L612), [src/core/session/types.ts:6](../src/core/session/types.ts#L6)). | Make room membership and multi-speaker state explicit; preserve speaker/entity attribution into prompt, memory, and social graph. Existing work: `psfn-framework-4caj.14`, `psfn-framework-4caj.9`. |
| Prompt-building cleanup | Partial, improving | Prompt assembly is centralized ([src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts:153](../src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts#L153)); prompt layers and runtime composer exist ([src/app/startup/composition/parity.ts:95](../src/app/startup/composition/parity.ts#L95)). Snapshots are rich, but live `promptContext` does not fill all cacheability/provider-tool fields. | Finish prompt monitor P0 and cacheability/tool visibility. Existing work: `psfn-framework-o1xa`, `psfn-framework-8sow.10`, `psfn-framework-vvf.1`. |
| Channel/relationship/trust semantics | Partial | Trust, relationship, and channel visibility are distinct in type and policy ([src/system/trust/types.ts:5](../src/system/trust/types.ts#L5), [src/core/contacts/types.ts:243](../src/core/contacts/types.ts#L243)). Channel classification exists but some extraction flows classify by channel id without `ChannelMeta`. | Close the policy contract first, then relationship review. Existing work: `psfn-framework-4caj.1`, `.3`, `.4`, `.5`, `.6`, `.7`, `.8`, `.12`. |
| Social graph minimum viable wiring | Partial | Store/query/backfill and trust-gated edge visibility exist ([src/core/contacts/store/social-graph.ts:155](../src/core/contacts/store/social-graph.ts#L155), [src/core/contacts/store/social-graph.ts:354](../src/core/contacts/store/social-graph.ts#L354)); retrieval can consume graph signals. | Automatic edge extraction from group interactions is missing. Existing work: `psfn-framework-4caj.9`. |
| CogSec recovery/session hygiene | Implemented mechanics, partial product loop | Crash recovery, journal quarantine sidecars, HMAC unverified context, tombstone cutouts, route reset, CogSec lineage/revoke/regenerate all exist ([src/persistence/sessions/store/crash-recovery.ts:74](../src/persistence/sessions/store/crash-recovery.ts#L74), [src/persistence/journals/journal/file-io.ts:216](../src/persistence/journals/journal/file-io.ts#L216), [src/core/cogsec/regeneration.ts:306](../src/core/cogsec/regeneration.ts#L306)). | Add operator-facing incident workflow and rolling drift detection; keep `npm run smoke:cogsec` as a regression gate for this area. |
| Shared world wiki MVP | Partial | Wiki exists as workspace-backed durable reference docs with provenance/sensitivity and Garden read API ([src/faculties/wiki/store.ts:235](../src/faculties/wiki/store.ts#L235), [src/operator/garden/services/wiki-service.ts:7](../src/operator/garden/services/wiki-service.ts#L7)). | Define shared-world semantics, ACLs, review gates, prompt inclusion, and implementation path. New work: `psfn-framework-i5s2`. |
| Group memory behavior | Partial | Observed group scheduler, speaker routing, group write caps, and room-scoped memory exist ([src/faculties/memory/extraction/group-observed-scheduler.ts:102](../src/faculties/memory/extraction/group-observed-scheduler.ts#L102), [src/faculties/memory/extraction/speaker-routing.ts:193](../src/faculties/memory/extraction/speaker-routing.ts#L193)). | Persist richer source-speaker routing metadata and feed relationship/social graph evidence. Existing work: `psfn-framework-4caj.14`, `psfn-framework-4caj.3`. |
| Episodic memory cleanup | Partial | L0.1 episodic store, candidates, canonical/merged/superseded hiding, arcs, and diagnostics exist. Cleanup is canonicalization/hiding, not full retention/prune, and rich `recall_expand` is future. | Consolidate overlapping near-real-time candidates and link arcs. Existing work: `psfn-framework-m58.1`, `psfn-framework-m58.2`, `psfn-framework-z6z`. |
| Companion app MVP | Open | Companion PWA epic exists and is scoped around event protocol, presence, approvals, artifacts, and safe redacted streams (`psfn-framework-w9hj`). | Keep after group/prompt/trust basics, but do not wait for every memory/relation feature. It is the controlled surface that reduces Discord-only constraints. |
| Observability/audit surfaces | Partial | Turn snapshots and PromptLoom services expose prompt/provider/memory/tool context ([src/core/turns/snapshot.ts:57](../src/core/turns/snapshot.ts#L57), [src/operator/garden/services/session-turn-observability.ts:144](../src/operator/garden/services/session-turn-observability.ts#L144)). | Prompt monitor tool visibility is P0 (`psfn-framework-o1xa`); Garden functional tests remain open (`psfn-framework-1z6.7`). |
| Tooling audit | Partial | Canonical tool surface and capability gating are real; session tool is overloaded; tool confusion work remains open. | Split session/chat history/focus work (`psfn-framework-jhqb`), then do tool audit and hints (`psfn-framework-vvf`, `psfn-framework-6l1`). |
| Small regression evals | Partial | Privacy red-team, context leak audit, CogSec tests, observer sidecar pieces exist ([src/system/trust/privacy-regression.test.ts:219](../src/system/trust/privacy-regression.test.ts#L219), [src/core/session/context-leak-audit.test.ts:40](../src/core/session/context-leak-audit.test.ts#L40)). | Add cross-surface intake-firewall tests and performance/Garden functional tests (`psfn-framework-htm9.*`, `psfn-framework-1z6.6`, `psfn-framework-1z6.7`). |
| Companion DMs | Missing as first-class route | Machine-intelligence flags and shard routing exist, but no recipient/contact DM abstraction was found; Discord egress replies to a channel id. | Defer until shared wiki, social graph, room semantics, and gate model are stable. |
| Project mode/project storage | Partial/future | Focus knowledge and project-ish surfaces exist, but tool surface is overloaded and project storage is not the current trunk. | Defer until shared-world wiki and app MVP provide controlled surfaces. Existing related work: `psfn-framework-jhqb`, `psfn-framework-7ym.1`. |

## Recommended Roadmap

### Track A: P1 CogSec Intake Firewall MVP

This can run in parallel with the trunk, but it should land before public/broadcast surfaces expand.

1. **Define the intake envelope (`psfn-framework-htm9.1`).**
   Add typed source/provenance/risk/quarantine/release metadata that can travel with `SubstrateMessage`, `Attachment`, tool observations, web outputs, docs, and model/subagent/shard outputs.

2. **Wire classification/quarantine across surfaces (`psfn-framework-htm9.2`).**
   Start with current real surfaces: Discord parsed docs, API/Telegram attachments, web text/binary, tool observations, public/broadcast context wrappers, and shard/subagent foldback candidates.

3. **Route gates through the envelope (`psfn-framework-htm9.3`).**
   Prompt, memory, wiki, persona/trust, and tool gates should receive the same risk state and produce auditable allow/summary-only/review/quarantine/block decisions.

4. **Add cross-surface evals.**
   Test that the same hostile text cannot enter raw prompt, memory, wiki, persona, trust, or tool parameters just because it arrived through a different adapter.

### Track B: Companion Substrate Trunk

1. **Make group chat coherent.**
   Close the attribution and room-state gaps: explicit participants, durable speaker/routing metadata, and social graph extraction (`psfn-framework-4caj.14`, `psfn-framework-4caj.9`).

2. **Make prompt assembly and observability legible.**
   Finish `psfn-framework-o1xa` before deeper prompt refactors. The operator needs to see exactly what the model saw, which tools were loaded, and whether truncation/cache/provider transformations are real.

3. **Lock channel/relationship/trust semantics.**
   Close `psfn-framework-4caj.1` before mutation logic. The invariant should be explicit: relationship warmth never grants memory access; trust is security/access; channel visibility constrains context.

4. **Stabilize recovery hygiene as an operator workflow.**
   Mechanics are there. Add the missing "detect, review, revoke/regenerate, verify clean" product loop and keep CogSec smoke tests in the gate.

5. **Define then build shared-world wiki MVP.**
   Do `psfn-framework-i5s2` first. The current wiki is useful reference storage; the roadmap needs shared-world semantics and review gates before companion DMs/project worlds start using it as substrate.

6. **Clean up group memory and episodic noise.**
   Persist richer speaker provenance, consolidate overlapping episodes, then add arcs/recursive recall (`psfn-framework-m58.1`, `psfn-framework-m58.2`, `psfn-framework-z6z`).

7. **Ship companion app MVP.**
   Use `psfn-framework-w9hj` as the app trunk once prompt/group/trust are not actively misleading. This replaces Discord as the only controlled high-context surface.

8. **Audit tools and add small evals.**
   Split `session` into obvious surfaces (`psfn-framework-jhqb`), add tool hints/telemetry, and add regression tests for privacy, tool choice, context assembly, and Garden flows.

9. **Then companion DMs and project mode.**
   These should depend on shared wiki, social graph, intake gates, and controlled app surfaces. Otherwise they become unreviewed side channels for world state and coordination.

## Defer For Now

- Full Twitch/public firehose system. The intake envelope should support it, but the product path should not be built until firewall MVP exists.
- Satellites/sensors. They multiply privacy and source-trust complexity.
- Shards as long-horizon autonomous actors. Keep shard/foldback work gated until project storage, budget, and intake-risk review are stronger.
- Beam/Elixir/distributed rewrite. No current critical-path finding requires it.
- Full metacognitive/introspection research. Keep small evals and recovery tooling first.

## Validation Notes

This was a read-only true-up plus documentation/bead creation. No code was changed. No test suite was run because the only tracked artifact here is this planning document and the bead backlog updates.

Subagent passes covered:

- Prompt/runtime/prompt monitor/untrusted ingress.
- Memory/recovery/wiki.
- Group chat/trust/relationship/social graph.
- Tool gates/quarantine/attachments/audit/evals.

The findings above use those passes plus local source reads. Where a proposal claim conflicted with code, code won.
