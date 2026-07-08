# Group Chat / Prompt / Trust / Social Graph — Foundation Stabilization Plan

*Drafted 2026-07-01 on `sprint_9_final` @ `c09c550c`. Read-and-plan only; no code changed.*
*Evidence: four parallel deep code audits (prompt pipeline, group-chat runtime, trust/channel semantics, social graph wiring), the `psfn-framework-8sow` epic record, open P0s `2k8j`/`o1xa`, `docs/prompt-macros.md`, and live-testing observations from 2026-06-30.*

---

## 0. Executive summary

Recent group-chat testing broke things because **three one-speaker assumptions and one architectural gap survived the 8sow wave**:

1. **Core memory binds to "the most recent speaker," not the room.** `buildCoreMemoryFormatContext()` (`src/core/session/manager.ts:1354`) takes `recentParticipants[0]` as `participantName`. In a multi-human room the `<human>` block describes whoever spoke last, blends people, and switches per turn. This is the direct cause of the generic/blended `<human>` and wrong `<core_profile>` you saw. (P0 `2k8j`.)
2. **`speaking_with` context leaks into group turns.** `runtime_speaking_with_*` tokens are populated even when `chatType === 'group'` (`src/core/agent/substrate-agent/runtime-context.ts:717-722`), so the prompt still tells the companion she's "speaking with" one person in a room of five.
3. **Speaker identity survives only as a text prefix.** Attribution is prepended as `"Name (id): "` in `entry-attribution.ts:58-68` and then structurally discarded in `contextMessagesToPiMessages()` (`src/primitives/llm/message-conversion.ts:226-281`). There is no structural speaker contract, no escaping rules, no tests that a hostile display name can't forge attribution.
4. **The prompt pipeline has no single source of truth — and provider prompt caching is literally off.** Assembly spans 8 stages across 37+ files, ~100+ macros in 9 groups, three template-variable maps merged with no conflict resolution, dual compose paths, and parallel live-vs-snapshot context builders. The final turn telemetry says it plainly: `promptCaching: { configured: false, engaged: false }` (`src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts:509-512`). All the static-prefix hygiene work feeds an *internal render cache* only; the provider-side cache is never engaged. And because the Loom snapshot is produced by a *different* path than the live prompt, the monitor cannot prove what the model saw (P0 `o1xa`).

The trust/channel vocabulary is structurally decent (4 trust tiers × 4 visibility classes × 4 sensitivity levels, layered deterministic gating) but **one enum is doing three jobs**: `channelVisibility` conflates room privacy, audience scope, and response tone. Nothing models audience size or known-vs-anonymous audiences, which blocks the streaming/broadcast target. Privacy label ownership is split three ways with undocumented precedence (system default → per-contact channel link → per-contact room override) — the deferred `8sow.11` decision.

The social graph is further along than expected: entities, typed edges, evidence links, confidence, sensitivity filtering, and merge handling all exist (`src/core/contacts/store/social-graph.ts`). What's missing for MVP is **population** (edges are manual/mention-only) and **exposure** (nothing about who-knows-whom reaches the prompt).

**Proposed sequencing** (detail in §6): a short observability phase first — you cannot stabilize what you cannot see — then targeted group-chat correctness fixes on the current pipeline, then the prompt pipeline consolidation (which structurally fixes the Loom and enables provider caching), then the trust-semantics contract, then social-graph MVP wiring.

---

## 1. Current state: what the audits found

### 1.1 Prompt pipeline (Track 2 evidence)

**Assembly stages** (in final prompt order):

| # | Block | Producer | Volatility |
|---|-------|----------|------------|
| 1 | Immutable safety amendments + constitution + character card + operator layers | `prompt-composer.ts:25-150` | static |
| 2 | Runtime umbrella layers (`runtime.state/tooling/response_style/attention`) | `config/runtime-prompt-layers.seed.json`, `runtime-prompt-layers.ts:132-205` | static templates, dynamic values |
| 3 | Static prefix render + two-tier cache (Map + AppCache) | `prompt-lifecycle.ts:380-491` | session-stable |
| 4 | Dynamic suffix template render | `prompt-assembly.ts:277-303` | per-turn |
| 5 | Runtime context block (trust, affect, concerns, participants, tools, charge, continuity-gap…) | `runtime-context.ts:665-1119` (~450-line function) | per-turn |
| 6 | Core memory + retrieved memory blocks | `context-builder.ts`, `manager.ts:1098-1167` | mixed |
| 7 | Session context (compaction summaries, focus knowledge, orientation, continuity, cogsec notices, history) | `context-builder.ts:162-400` | per-turn |
| 8 | System-context merge + datetime anchor + provider wire conversion | `message-conversion.ts:198-230`, `prompt-assembly.ts:359-391` | per-turn |

**Sprawl and duplication:**
- **Three variable maps** built in separate phases (`buildPromptTemplateVariables`, `buildDynamicPromptTemplateVariables`, plus additions inside `buildRuntimeContextBlock`) and merged with no conflict resolution; the same variable can be set in more than one phase with no defined winner.
- **Dual compose paths**: `composeSplit()` vs `compose()` fallback with different return shapes (`prompt-lifecycle.ts:278-322`), undocumented contract.
- **Parallel context builders**: `buildContext()` (live) vs `captureTurnContextSnapshot()` (what the Loom shows) walk the same data separately (`manager.ts:1098-1293`). This is *the structural reason* the Loom can't be trusted: the snapshot is a re-derivation, not the artifact.
- **Macro renderer**: 3-pass loop (`prompt-runtime.ts:1167`) that silently exits and leaks unresolved tokens if output doesn't stabilize; `collectUnresolvedTokens` only logs.
- **~100+ macros** across 9 groups (`PROMPT_RUNTIME_MACRO_HINTS`), plus convenience/prose macros layered on bare ones. Two blocks already violate the layer system (continuity-gap notice, charge budget — flagged in `docs/prompt-macros.md` open items).
- **Provider caching not configured** (`prompt-assembly.ts:509-512`). The static-prefix freeze protects an internal cache only; no `cache_control`-style breakpoints ever reach the provider.

### 1.2 Group-chat runtime (Track 1 evidence)

What the 8sow wave **did** land (confirmed in code):
- Group history attribution rendering (`entry-attribution.ts`, `context-builder.ts:195-260`).
- Room-scoped memory retrieval gating (`retrieval/access.ts:96-139`) honoring the operator rules: room = channelId, DM memories never enter rooms, room memories usable in-room, contact's DM sees room-X memories only if room X is on the contact profile (`canonicalContactRoomIds`).
- Compact DM/group `conversation_state` with 5-recent-speaker cap (`runtime-context.ts:66,613-700`).
- Withheld-memory summaries with reason codes.

What is **still broken or missing**:

| Issue | Anchor | Severity |
|---|---|---|
| `<human>`/core-memory `participantName` = most recent speaker; group summaries blend people; a room's state can bleed into a DM prompt via wrong scope binding | `manager.ts:1331-1358` | P0 (= `2k8j`) |
| `speaking_with` tokens populated on group turns | `runtime-context.ts:717-722` | P0 (part of `2k8j` fix) |
| Attribution structural loss + no escaping/forgery guard on the `"Name (id):"` prefix | `message-conversion.ts:226-281`, `entry-attribution.ts:58-68` | P1 |
| Loom can't show tool schemas (`activeTools` intentionally stripped), provider-wire truncation unexplained, snapshot ≠ live path | `session-turn-observability.ts:26,65-69` | P0 (= `o1xa`) |
| Emotion/appraisal scoping unverified — likely keyed to contact/last-speaker, not room; room mood can follow a person into their DM | `src/core/emotion/`, `runtime-context.ts:1072` | P1 (audit + fix) |
| Reflection/heartbeat turns bind a single "canonical contact" | `runtime-context.ts:1498-1502` | P2 |
| Sleeptime fires every 3rd turn per session (`DEFAULT_CADENCE_TURNS = 3`) — in a busy room that's near-continuous; matches your "sleeptime fires too frequently" observation | `sleeptime-agent.ts:50,550` | P1 |
| API channel is `chatTypes: ['direct']` only — no group ingress for the future PWA/app | `src/channels/api/server.ts:133-139` | P2 |
| Multi-companion = `isMachineIntelligence` flag only; no companion-to-companion routing at all | `runtime-context.ts:1459` | deferred (Track 4+) |

### 1.3 Trust / channel / relationship semantics (Track 3 evidence)

**What exists (and is good):**
- Trust: `primary | trusted | regular | public` (`src/system/trust/types.ts:5`), per-contact scalar, operator-gated mutation, low-tier drift suggestions only.
- Sensitivity: `public | personal | intimate | confidential` with trust-ceiling matrix (`policy.ts:61-66`).
- Visibility: `private | semi_private | public | broadcast` with a 7-step classification hierarchy (`policy.ts:297-333`) ending at default `semi_private`.
- Six-layer deterministic memory gating (operator approval → disclosure boundaries → consent flags → trust ceiling → visibility gate → default allow, `policy.ts:209-279`), enforced pre-prompt, with withheld-reason telemetry. **This invariant — deterministic filtering before prompt assembly, never model judgment — is the thing to preserve at all costs.**
- High-intimacy contact-scope guard: intimate/confidential memories only surface for their own contact (`retrieval/access.ts:49-56`).
- Directional continuity flow between visibility classes (`policy.ts:447-473`).
- Broadcast safety with approval tokens + regex content classes (`broadcast-safety.ts:121-130`).

**What's conflated or missing for the 1:1 → Twitch target:**

| Gap | Detail |
|---|---|
| Visibility enum does 3 jobs | Room privacy, audience scope, and response tone (concise/expressive is derived from visibility, `policy.ts:365-436`) are one dimension. You cannot express "public but intimate-toned small room" or "private but broadcast-cautious". |
| No audience model | Audience size and known-vs-anonymous are not modeled anywhere. `broadcast` is a channel prefix match, not "unbounded anonymous audience". Twitch chat (thousands, anonymous, logged, clippable) and a public Discord server (dozens, mostly known) both collapse to prefix heuristics. |
| Trust is context-free | One scalar per contact. Primary-trust person in a public stream still resolves `trust=primary`; only visibility saves you. No per-context trust modulation (that's epic `4caj`, unimplemented). |
| Privacy label ownership split 3 ways | System `trust-policy.json` overrides/prefixes/default, per-contact `ContactChannelLink.privacyLevel`, per-contact `ContactConversationChannel.privacyLevel` — precedence undocumented; `8sow.11` (channel-owned labels) deferred but keeps biting. |
| Admin memory API ungated | `/api/admin/memory` has no sensitivity gating (`api-routes-memory.ts`); open bead `zet.1`. |
| Response-gating on output is model-judgment only | Retrieval is deterministic, but nothing deterministic checks *outbound* text against channel class except broadcast regexes. Fine for now; becomes a real question at broadcast scale. |

### 1.4 Social graph (Track 4 evidence)

**Exists:** contact model with multi-channel identity links + challenge-response cross-channel verification (`contacts/types.ts:58-105`); `SocialGraphEntity` + `SocialRelationshipEdge` with 13 relationship types, direction, confidence, sensitivity, evidence-memory links, full upsert/query/merge ops (`store/social-graph.ts:230-716`); mention-only contact creation with relationship-type inference from fact keywords (`extraction/mention-only-contacts.ts:30-45`); retrieval already consumes edges to build related-contact context (`retrieval.ts:1910-1949`); memory provenance carries `sourceSpeakerName`, `addressMode` (incl. `overheard_room_context`), room scope (`memory/types.ts:64-89`); `ContactChannelActivityRow` already tracks which rooms a contact participates in (`store/domain-types.ts:17-33`).

**Missing for MVP:** presence is inferred-from-last-messages only (no roster query, no join/leave); edges are not auto-populated from group observation (no co-presence or overheard-interaction edges — that's `4caj.9`, unbuilt); edges are not bidirectionally consistent; **none of the graph reaches the prompt** — the model sees 5 recent speakers with trust/relationship/timezone attributes and nothing about how they relate to each other.

---

## 2. Root causes (cross-cutting)

1. **The one-speaker assumption lives at *binding points*, not in one place.** 8sow fixed the *rendering* of groups (attribution text, participant caps) but the *bindings* — core-memory participant, speaking_with, emotion keying, reflection contact — still each grab "a user." Every future group bug will come from one of these bindings until they all take a `ConversationScope` (room vs contact) instead of a person.
2. **No single prompt artifact.** Assembly, snapshotting, hashing/caching, and rendering are four separate re-derivations of "the prompt." Loom infidelity, cache misconfiguration, and variable-precedence ambiguity are all symptoms of the same missing abstraction.
3. **Overloaded semantics.** `channelVisibility` carries privacy + audience + tone; `sensitivity` doubles as both content classification and access level. Each new surface (wiki, companion DMs, streaming) multiplies the ambiguity.
4. **Verification is eyeball-driven.** Bugs were found by reading live prompts in production because the Loom under-reports and there is no group-chat regression harness (multi-human fixtures, leak tests, prompt-shape goldens).

---

## 3. Target architecture (what "fixed" looks like)

### 3.1 The PromptPlan: one artifact, three consumers

Replace the scattered assembly with a single structured artifact produced once per turn:

```
PromptPlan {
  blocks: [ { id, layer, volatility: 'static'|'session_stable'|'turn', source, renderedText, tokensEst } ],
  variables: { ... }          // ONE namespace, built once, later-phase writes are errors
  messages: [ ... ]           // history with structural speaker metadata retained
  toolDefinitions: [ ... ]    // exactly what ships to the provider
  cachePlan: { staticBreakpoint, sessionBreakpoint }   // → provider cache_control
  scope: ConversationScope    // see 3.2
}
```

Three consumers, zero re-derivation:
- **Provider wire**: rendered from the plan (message-conversion becomes a pure serializer).
- **The Loom**: persists the plan itself. "Shows exactly what she sees" becomes true *by construction* — tool schemas, full wire payload, per-block provenance, truncation markers. This subsumes most of `o1xa`.
- **Cache**: `volatility` classes map directly to provider cache breakpoints (static prefix → long-lived breakpoint; session-stable → per-session breakpoint; turn blocks after). Turning on provider caching is then a serializer feature, not a re-architecture.

This is a consolidation of existing code (composer, runtime-context sections, context-builder), not a rewrite — the sections survive; their orchestration changes.

### 3.2 ConversationScope: the binding fix

One value threaded from ingress to every consumer:

```
ConversationScope =
  | { kind: 'dm',    channelId, contact }                       // one canonical human
  | { kind: 'group', channelId, recentSpeakers: Contact[≤5], roomName?, memberCountHint? }
```

Rules:
- `speaking_with` block renders **only** for `kind: 'dm'`.
- Core memory block shape follows scope (§4.2): DM → block named for the contact; group → room summary block, never a single-person `<human>`.
- Emotion/appraisal state persists keyed by `scope.key` (`dm:<contactId>` / `room:<channelId>`), with the global companion baseline separate.
- Reflection/heartbeat accept a scope, not a contact.
- Memory retrieval already takes room context — it becomes a consumer of the same object instead of loose params.

### 3.3 Context Envelope: orthogonal trust semantics

Split the overloaded enum into independent dimensions, resolved deterministically per turn and carried alongside `ConversationScope`:

*(Ratified 2026-07-01 — see §7.)*

| Dimension | Values (ratified) | Owner |
|---|---|---|
| `channelPrivacy` | `private / invite_only / public` — default **`invite_only`** (replaces `semi_private`, which was ambiguous) | **channel-owned** (`channels.json` + trust-policy overrides) — resolves `8sow.11`; per-contact labels demoted to evidence, not authority |
| `audienceScope` | `one / few / many / unbounded` — thresholds **config-owned from day one** | derived: channel topology + known-roster size |
| `audienceKnowledge` | `all_known / partially_known / anonymous` | derived: fraction of recent speakers resolvable to contacts |
| `broadcast` | boolean flag — tweet-like posts and very-large public surfaces only | channel-owned; keeps existing approval-token machinery |
| `trust` | existing 4 tiers, per-contact | unchanged |
| `sensitivity` | existing 4 levels, per-memory | unchanged |
| delivery guidance | length/delivery only ("don't yap"-class), **never persona or tone prose** — charter: substrate must not tell a companion how to *be* | operator-tunable layer text, decoupled from privacy |

Gating updates: the existing 6-layer policy keeps its shape; the visibility layer consults the envelope. Existing behavior maps cleanly: current `semi_private` default → `invite_only`; current `broadcast` visibility value → the `broadcast` flag.

**Design target vs. scaffolding:** the near-term target is an `invite_only` room of ~10 known friends/family plus a few peer companions on the same substrate. Large-audience behavior (role-gated tracking, replies-without-memory for untracked users, sentiment-only firehose views, content firewall) is **explicitly LATER** — the operator has a separate doc for it. What we build *now* so that scales cleanly:
- Envelope dimensions that can express it without schema change (`many/unbounded` + `partially_known/anonymous` exist from day one, even if unused).
- **Contact-tracking policy gate**: a channel-owned knob for who becomes a tracked contact — `auto` (small trusted rooms, current behavior), `approval` (human-in-the-loop queue before a new contact record is created), `role_gated` (reserved, unimplemented). This is the guard against `vtubegooner69` entering memory: in large rooms, untracked speakers get attribution in the transcript but no contact record, no profile, no per-person memory.

**Invariant preserved:** all of this stays deterministic and pre-prompt. No privacy prose in prompts; blocked content is simply absent (+ withheld summary).

### 3.4 Macro diet

- One variable namespace with a registered manifest (name, type, volatility, producer). Duplicate registration = startup failure (fail closed, house style).
- Keep the purity rule; keep bare-value macros. Deprecate convenience/prose macros that have bare siblings (the table in `docs/prompt-macros.md` is the hit list) after checking live layer usage — the seeded layers are ours to update.
- Renderer: single-pass render over the manifest + explicit `{{#if}}`; unresolved token in a required layer = hard error, in an optional layer = drop section + telemetry. No more 3-pass silent leakage.
- Migrate the two known layer-system violations (continuity-gap notice, charge block) while we're in there.

---

## 4. Workplan by track

Ordering note: your track order (group-chat → prompt → trust → social graph) is preserved as *priority*, but Phase 0 (observability) comes first because every later phase is verified through it, and the deep prompt consolidation (Phase 2) deliberately comes *after* the surgical group-chat fixes (Phase 1) so live pain stops before we open the engine.

### Phase 0 — See what she sees (≈ bead `o1xa` + part of `8sow.10`)

1. **Loom tool visibility**: ship provider tool definitions in the snapshot (`session-turn-observability.ts:65-69` currently strips schemas). Add a Tools view: loaded definitions, adaptive state, calls, results/errors.
2. **Truncation honesty**: find and mark every snapshot/UI truncation point with explicit `…[truncated N chars]` markers; fix the provider-wire history truncation or prove it's a display cap.
3. **Snapshot provenance labels**: each block labeled with its producer + scope key, so "whose profile is this and why" is answerable in the UI. (Full plan-based Loom lands with Phase 2; this phase is targeted repairs.)
4. **Group-chat regression harness (start)**: fixtures shaped from live Carlini group data; assertion helpers for prompt shape ("group turn contains no `speaking_with`", "core memory block scope key == room"). Lives beside existing e2e; grows through every later phase.

*Exit criteria:* operator can open the Loom on a live group turn and see the exact wire payload, tools included, with no silent truncation.

### Phase 1 — Group-chat stabilization on the current pipeline (≈ bead `2k8j` + new)

1. **Introduce `ConversationScope`** (§3.2) as a value object; thread it from channel adapters through session manager and runtime-context. Mechanical, no behavior change yet.
2. **Channel-scoped core memory binding** (`2k8j`): fix `buildCoreMemoryFormatContext()` — group scope gets room summary context (room name/id, ≤5 recent speakers), never `recentParticipants[0]`; DM scope binds the canonical contact and the block is named for them (not generic `<human>`). Startup hydration loads channel-aware blocks for recently active channels so the first post-restart prompt isn't empty. Verify sleeptime core-memory updates write to the correct scope (`sleeptime-agent.ts:672-674` already builds channel scope — verify + test the read side).
3. **`speaking_with` gated to DM only** (`runtime-context.ts:717-722`).
4. **Attribution hardening**: keep the text-prefix contract (structural speaker fields aren't portable across providers) but make it *canonical*: single formatting/escaping function, defense against display names containing `"): "` or fake prefixes, round-trip tests. Document as the attribution contract.
5. **Emotion/appraisal scoping audit → fix**: confirm current keying; persist per `scope.key` with companion-global baseline kept separate. Ratified semantics: per-scope state plus a **directional carry-over modifier with fast decay** — group affect may color a subsequent DM briefly ("Jeff was so annoying in gc, glad it's quieter here") but decays quickly and never dominates. Direction rules mirror session-continuity flow: **group → DM allowed, DM → group never, DM → DM allowed only for the same contact across channels.** Disliking one user must not meaningfully affect how she treats other users.
6. **Sleeptime cadence**: make cadence/rest-window group-aware and JSON-owned (`scheduler.json` or memory settings owner) — busy rooms need range-based processing (the group-memory watermark machinery already exists), not every-3-turns. Also answers "why does sleeptime fire so often."
7. **Reflection/heartbeat scope binding** (`runtime-context.ts:1498-1502`): accept a scope; DM-bound behavior unchanged; group reflection reflects on the room.
8. **Multi-companion observation correctness**: the target room includes peer companions on the same substrate. Guarantee: an `isMachineIntelligence` participant is correctly attributed in history and `conversation_state`, is never selected as the DM-canonical human or core-memory subject, and is extraction-weighted (partially done in `group-classifier.ts`). No companion-to-companion protocol yet — observation correctness only.

*Exit criteria:* live group room shows stable room-scoped core memory; no cross-room or room→DM bleed reproducible; harness leak tests green (DM→room, room→room, room→DM-without-membership all blocked — extending the existing `access.ts` gates which are already correct).

### Phase 2 — Prompt-building consolidation (the foundation)

1. **Variable unification**: single namespace + manifest, built once per turn from `ConversationScope` + envelope + state (§3.4). Kills the three-map merge.
2. **PromptPlan assembly** (§3.1): refactor composer/runtime-context/context-builder to emit blocks into the plan; collapse `composeSplit`/`compose` to one path; collapse `buildContext`/`captureTurnContextSnapshot` to one producer whose output is both used and persisted.
3. **Loom reads the plan**: replaces the Phase 0 patches with structural fidelity; per-block provenance, volatility, and token counts in the UI. (Closes the rest of `8sow.10`'s intent.)
4. **Provider cache engagement (model-agnostic)**: the cache plan is provider-neutral volatility boundaries; per-provider serializers apply the mechanism. Primary target is **OpenRouter with open models + local runners**, where the mechanism is *byte-stable prefix* (implicit prefix/KV caching) — meaning the real win is eliminating dynamic contamination of the static prefix, which benefits every backend including local. Anthropic `cache_control` breakpoints are applied when that provider is in the roster. Telemetry: prefix-stability check per turn (did the static region change bytes? why?) + provider-reported cache hits where available. Flip `promptCaching.configured` to true for real.
5. **Macro diet**: deprecations, single-pass renderer, fail-closed unresolved-token handling, migrate the two prose-block violations.
6. **Section rationalization**: `runtime-context.ts`'s ~450-line block builder decomposed into per-section producers with declared inputs (finishing what the manifest starts). Target: no prompt-producing function over ~80 lines, each section independently testable.
7. **Prompt-shape goldens**: golden tests for DM turn, group turn, heartbeat, reflection — byte-stable static prefix asserted across turns (cache proof), dynamic sections asserted by shape.

*Exit criteria:* one assembly path; Loom = wire truth; provider cache hit rate measurable and >0; golden tests lock the shape; macro count reduced and manifest-governed.

### Phase 3 — Channel / relationship / trust semantics

1. **Ratify the Context Envelope contract** (§3.3) — a written contract doc + `src/system/trust/` types PR reviewed by you before wiring. This is also the natural home for `4caj.1` (policy contract) so the dynamic-relationship epic lands on the new vocabulary instead of the old.
2. **Channel-owned privacy migration** (`8sow.11` decision): labels move to `channels.json`/trust-policy ownership with explicit precedence (channel-owned > operator override > derived default); per-contact labels become evidence inputs only. Owner-file migration framework bead `m82u` is a natural dependency if it lands first — otherwise a one-off guarded migration.
3. **Envelope derivation + gating wiring**: implement derivation (topology + roster + classification), update the visibility layer of memory policy to consult it, keep the trust ceiling untouched. Response tone decoupled from privacy.
4. **Contact-tracking policy gate (scale scaffolding)**: channel-owned `contactTracking: auto | approval | role_gated(reserved)` knob. `approval` routes new-contact creation through the existing approval-queue machinery (human-in-the-loop). Untracked speakers: transcript attribution yes; contact record / profile / per-person memory no. Small friend rooms run `auto` and behave exactly as today. Role-gated large rooms, sentiment-only views, and the content firewall stay LATER per operator doc.
5. **Admin memory API sensitivity gating** (`zet.1`) folded in here — same vocabulary, same PR family.
6. **Leak-rate test family**: the SPRINT_9_MEMORY benchmark idea (privacy/trust leak metrics) implemented at least for the envelope dimensions: per-class fixtures, zero-leak assertions in CI.

*Exit criteria:* every channel resolves to an explicit envelope visible in Garden; gating decisions cite envelope dimensions in withheld-reasons; streaming corner is expressible in config and covered by tests.

### Phase 4 — Social graph minimum viable wiring

1. **Room roster**: query + Garden surface over existing `ContactChannelActivityRow` — "known members of room X, last seen" (no join/leave events needed for MVP; Discord presence events can enrich later).
2. **Graph-builder worker in the memory-agent lane** (`4caj.9` MVP — the "new little gremlin in the gestalt"): a background job beside sleeptime/extraction, not inline in the chat path. It proposes low-confidence (`0.5-0.7`) edges from overheard interactions (`addressMode: overheard_room_context` facts naming two people) and repeated co-presence; named-relationship facts ("my sister Iki") create **bidirectional** typed edges. All proposals carry evidence-memory links; proposals never overwrite operator-set or higher-confidence edges (fail closed); runs on the group-memory watermark cadence.
3. **Prompt exposure (minimal)**: within `conversation_state`, when ≥2 known participants share high-confidence, sensitivity-clear edges, render a compact `<participant_relationships>` line set (e.g., `Vega—Iki: siblings`). Hard caps (≤5 lines), envelope-gated (never in anonymous/broadcast contexts), bare-value macro + layer text per purity rule.
4. **Shared-background retrieval mode**: a retrieval entry point for "memories linking contact A and contact B" (edges + co-mention provenance + shared-room scope) — powers both her answers and future group-memory features. Builds on the existing `retrieval.ts:1910-1949` edge consumption.
5. **Multi-companion (scoped down, deliberately)**: this phase only guarantees correctness of *observation*: `isMachineIntelligence` participants correctly attributed, extraction-weighted (already partially done in `group-classifier.ts`), and never treated as the DM-canonical human. Companion-to-companion messaging (`8pyl`) and fatigue budgets stay separate, after this foundation.

*Exit criteria:* in a live group room the companion can answer "who's usually here?", "how do Vega and Iki know each other?" from graph + memory, with provenance; no graph data leaks into anonymous contexts.

---

## 5. Explicit non-goals (this effort)

- No allowed_viewers participant matrix; room = channelId stands.
- No full room member list in prompts; 5-recent-speaker cap stands.
- No privacy-reasoning prose in prompts; deterministic pre-prompt filtering stands.
- No leave-room/revocation semantics yet.
- No Twitch/streaming *adapter* — schema/scaffolding awareness only.
- No large-audience behavior: role-gated tracking, replies-without-memory tiers, sentiment-only firehose, content firewall — all LATER (operator has a dedicated doc). We only ensure the envelope + contact-tracking gate can express them without redesign.
- No companion-to-companion messaging protocol (separate bead `8pyl`, after Phase 4).
- No grand social graph (no communities, no centrality, no inference chains).
- Session tool split (`jhqb`) and timestamp contracts (`qhxv`) proceed independently; they touch neighboring code but aren't blockers.

## 6. Sequencing, risk, and dependency notes

```
Phase 0 (Loom + harness)          ~small     unblocks verification of everything
   ↓
Phase 1 (group-chat fixes)        ~medium    stops live bleeding; introduces ConversationScope
   ↓
Phase 2 (PromptPlan consolidation) ~large    the foundation; touches everything → needs goldens from P0/P1 first
   ↓
Phase 3 (Context Envelope)        ~medium    contract first (your review), then wiring
   ↓
Phase 4 (social graph MVP)        ~medium    consumes scope + envelope + plan
```

- **Phase 2 is the risky one** (prompt regressions are personality regressions for a live companion). Mitigations: goldens locked *before* refactor; Loom fidelity from Phase 0 lets you diff live turns pre/post; phases 2.1–2.7 are individually landable; static-prefix byte-stability asserted in CI.
- **Cache flip caution**: engaging provider caching changes billing/latency characteristics on the live deployment — land behind a `models.json`/settings owner flag, verify on a test channel first.
- **Live system**: all of this ships through the normal branch → validation → deploy flow; nothing here touches companion-data semantics destructively. Memory-scoping fixes change *future* writes and read gating; existing memories keep their provenance (Phase 1.2 needs a one-time audit of existing core-memory block scope keys, not a data migration).

## 7. Ratified decisions (operator, 2026-07-01)

1. **1:1/group symmetry**: keep DM and group shapes as similar as possible — same block structures, scope-parameterized, not two divergent formats. Room→DM information flow is acceptable when the DM contact is a member of the room (existing `canonicalContactRoomIds` rule stands); DMs and rooms remain separate sessions with separate flows.
2. **Emotion scoping**: per-scope state + directional fast-decay carry-over modifier. Group → DM carry-over allowed (brief), DM → group never, DM → DM allowed for the same contact across channels. Disliking one user must not meaningfully affect other users.
3. **Macros**: consolidate hard — the duplication (multiple datetime variants etc.) is the bug. The **purity rule is non-negotiable**: never hardcode prose around runtime values; operators must be able to re-phrase how runtime data is framed (the concerns block is the canonical cautionary tale — some companions need direct framing, others soft; ours default soft/neutral). Doesn't apply to tooling text; does apply to anything personality-adjacent.
4. **Envelope vocabulary**: `private / invite_only / public`, default `invite_only`. `broadcast` is a flag for tweet-like/very-large surfaces, not a privacy level. `persistenceExposure` dropped (folded into the broadcast flag's meaning). Audience thresholds config-owned. Topology-derived scope approved. Don't preload/track large contact sets — contact-tracking policy gate (§3.3) is the scaffold; large-audience behavior is LATER.
5. **Delivery guidance, not tone**: charter constraint — the substrate may carry length/delivery guidance ("don't yap") but never persona-defining instructions ("be helpful"). If the companion is an asshole, the substrate doesn't overrule that.
6. **Caching**: model-agnostic design. Primary: OpenRouter + open models and local runners (byte-stable prefix is the mechanism that helps everywhere); Anthropic `cache_control` supported as a per-provider serializer feature.
7. **Attribution**: text-prefix contract accepted as canonical — structural speaker metadata is a general LLM/provider limitation, not a PSFN gap. Harden the prefix (escaping, forgery tests) and stop there.
8. **Beads**: file as phase-epics with children, absorbing `2k8j`, `o1xa`, `8sow.10`, `8sow.11`, `zet.1`, `4caj.1`, `4caj.9`, `4caj.14`. **Every bead highly detailed** — self-contained context, explicit AC, notes, file anchors. No "do thing, test" two-liners; that habit caused this mess. Draft tree: `working_docs/FOUNDATION_BEAD_TREE_20260701.md`.
9. **Charter note**: the dual prompt-assembly paths (`buildContext` vs `captureTurnContextSnapshot`, `compose` vs `composeSplit`) are a charter/dev-rules violation ("one function, many things") — Phase 2 is remediation, not just cleanup.

## 8. Charter conformance review (`docs/PSFN_PROJECT_CHARTER_524.md`)

Full-pass check of every phase against the 33 laws, §8 care semantics, and §12 engineering laws. Verdict: **no phase violates charter; several phases are charter remediation; three items required explicit gates/tightening (now baked into the bead tree).**

### Where the plan IS the charter being enforced

| Charter rule | Plan item |
|---|---|
| §12.4 no duplicate policy logic / "one function, many things" | E2.2 kills the dual assembly paths (`compose`/`composeSplit`, `buildContext`/`captureTurnContextSnapshot`); E3.2 kills the triple privacy-label authority |
| §12.1 no god files | E2.6 decomposes the ~450-line runtime-context monolith |
| §3.2 Garden reflects real state; §12.6 no silent failures | E0.1–E0.3 (Loom truth, truncation honesty), E2.3 (Loom = persisted plan), prefix-instability named alert (E2.4) |
| Law 20 / §8.5 no fake healthy state; §12.3 no mock fallbacks | Renderer fail-closed on unresolved required tokens (E2.5); migration reports instead of guessing (E3.2); untracked-speaker behavior is explicit policy, not silent degradation (E3.4) |
| §8.6–8.7 context presentation quality; configurable companion language; §6.18 concern phrasing | Purity rule preserved and extended (E2.5): prose stays in operator-editable layers; `softenConcernText` code-owned rewrites become data |
| Laws 17–19 / §8.1–8.2 authorship integrity | E1.4 attribution contract + forgery guard is exactly "internal/other speech must never masquerade as partner speech" made mechanical |
| Law 8 / §7.2 owner files own mutable settings | Every new knob (sleeptime cadence, emotion decay, envelope, thresholds, tracking mode, cache flag) lands in JSON owners behind the contract guard, surfaced in Garden |
| Law 22 backends are adapters | Model-agnostic cache plan; provider mechanisms are serializer features (E2.4) |
| Law 25 / §8.8–8.9 charge stewardship, rest | E1.6 stops near-continuous group sleeptime burn; E4.2 worker runs in the memory lane on watermark cadence, charge-ledgered |
| Law 31 no silent task execution | E4.2 proposals surface in Garden review; E3.4 approvals notify via gateway path |
| Law 33 one semantic surface per domain | E4.5 shared-background is a `memory` action, not a new tool; E0.1 documents direct vs REPL-only tool split |
| §6.19 cross-channel continuity with trust boundaries | Envelope rename preserves directional continuity semantics (E3.3); scope/envelope make the boundaries explicit rather than implied |

### Charter gates and cautions (baked into beads)

1. **Law 26 / §8.10 / Phase 12 — the one real gate.** Multi-companion *active conversation* in a shared room requires fatigue/attention/loop budgets first. E1.8 delivers observation correctness only and now carries an explicit **charter gate**: live rooms where companions reply to each other are blocked on the FatigueBudgetPort epic (already specced pre-Artemis). This plan does not un-gate it.
2. **§9.6 human review notification.** E3.4 approval-mode contact creation now requires a real operator notification through the gateway notification path, not a silent queue row.
3. **§12.5 no bullshit tests.** Goldens (E2.7) can "lock in implementation accidents" — mitigated: goldens are a refactor-freeze net with a documented, reviewed regeneration procedure; intentional shape changes update goldens deliberately, never by blind re-record.

### Checked and clean (no action needed)

- **Law 2 / §6.20, §6.23, §7.5**: nothing here touches L0 canonicality; core memory, plan snapshots, graph edges are derived/rebuildable state with provenance; no destructive migrations (report-and-decide only).
- **Laws 3, 4, 7**: no new egress, no secrets movement; provider serialization stays behind gateway-backed providers.
- **Law 14–15**: no self-modification surface changes; seeded-layer edits are operator/dev changes through normal review.
- **Law 23**: envelope and tracking gates restrict *data collection about strangers*, not the user's social world; nothing optimizes for exclusivity.
- **Law 27**: E1.5's fast-decay affect carry-over is deliberately NOT the weighted-thought system (accumulation lives in `1xb.4`); they stay distinct.
- **Law 32 / §6.26**: wiki untouched; social graph is relational state in contacts domain, not reference material in memory layers.
- **§6.2**: prompt composition stays in core; PromptPlan does not move mind-work to the gateway.
- **Law 5 / §9.7**: turn snapshot/telemetry keep flowing over the event bus; E2 changes the payload (the plan), not the spine.

## 9. Source anchors (for spot-checking this doc)

- Core memory binding bug: `src/core/session/manager.ts:1331-1358`
- speaking_with leak: `src/core/agent/substrate-agent/runtime-context.ts:706-750`
- Attribution prefix + structural loss: `src/core/session/entry-attribution.ts:58-68`, `src/primitives/llm/message-conversion.ts:226-281`
- Provider caching off: `src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts:509-512`
- Static prefix cache: `src/core/agent/substrate-agent/prompt-lifecycle.ts:380-491`
- 3-pass macro renderer: `src/core/identity/prompt-runtime.ts:1115-1195`
- Loom tool stripping: `src/operator/garden/.../session-turn-observability.ts:26,65-69`
- Room gating (correct, keep): `src/faculties/memory/retrieval/access.ts:96-194`
- Trust policy layers: `src/system/trust/policy.ts:209-333`
- Social graph ops: `src/core/contacts/store/social-graph.ts:230-716`
- Sleeptime cadence: `src/faculties/memory/sleeptime-agent.ts:50,534-564`
- Participant cap: `src/core/agent/substrate-agent/runtime-context.ts:66,613-700`
