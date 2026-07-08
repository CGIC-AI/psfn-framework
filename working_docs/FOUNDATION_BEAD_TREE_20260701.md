# Foundation Bead Tree — Draft for Review (2026-07-01)

*Companion to `GROUPCHAT_PROMPT_TRUST_FOUNDATION_PLAN_20260701.md`. Five phase-epics, 29 children. IDs are placeholders (`E0`–`E4`, `.n`); bd assigns real IDs at filing. Each bead is written to be self-contained per operator direction: summary, context, scope, non-goals, acceptance criteria, anchors. Absorbed existing beads are noted; on filing, absorbed beads get closed-as-duplicate with a pointer or re-parented, per your call.*

**Dependency spine:** E0 → E1 → E2 → E3 → E4. Within an epic, children are ordered; cross-epic dependencies are called out per bead.

**Operator decisions binding on all beads** (from plan §7): room = channelId; no participant matrix; ≤5 recent speakers in prompts; deterministic pre-prompt filtering, no privacy prose; DM/group shapes symmetric; emotion carry-over group→DM only with fast decay; macro purity rule non-negotiable; delivery guidance never persona prose; model-agnostic caching; text-prefix attribution canonical; contact-tracking gate for scale; large-audience behavior LATER.

---

## E0 — Epic: Loom fidelity and group-chat regression harness

**Type:** epic · **Priority:** P0 · **Absorbs:** `psfn-framework-o1xa`, the observability half of `psfn-framework-8sow.10`

**Summary.** The prompt monitor (The Loom) must show exactly what the model saw for a turn — tools included, untruncated or honestly marked. Every later phase is verified through this surface, so it lands first. Also seeds the group-chat regression harness that later phases extend.

**Context.** Live evidence 2026-06-30: tool schemas invisible (snapshot intentionally strips `activeTools` input schemas), provider-wire history looked truncated with no marker, core-profile blocks switched per user with no provenance shown. Root structural cause (snapshot is a re-derivation, not the artifact) is fixed in E2; this epic is targeted repair so verification works *now*.

**Epic AC.** Operator can open the Loom on a live group turn and see: full provider payload (system + messages + tool definitions), every truncation explicitly marked with original size, and per-block provenance (producer + scope key). A group-chat fixture harness exists and runs in CI.

### E0.1 — Ship provider tool definitions in the turn snapshot and render a Tools view

**Type:** bug · **Priority:** P0 · **Absorbs:** core of `o1xa`

**Context.** `session-turn-observability.ts` clones `activeTools` but intentionally omits input schemas (line ~65-69, comment suggests size concern). The Loom therefore shows tool counts, not what the model could actually call. Prior tool visibility was better per operator report.

**Scope.**
- Snapshot carries, per turn: loaded tool definitions exactly as serialized to the provider (name, description, input schema), adaptive-tool state (core/promoted/extended/deferred, skipped/withheld + reason), tool calls issued, tool results/errors returned.
- If size is a genuine concern, compress or store schemas by content-hash with a lookup — never silently omit.
- Admin UI: a Tools tab in `PromptMonitorSelectedTurnTabs.svelte` rendering the above, clearly separated from prompt/memory views.
- Distinguish "direct tool" vs "REPL-only (analysis_workbench)" per CLAUDE.md tool-surface split.

**Non-goals.** No tool runtime/scheduling changes. No full Loom IA redesign.

**AC.**
- [ ] For a live turn, the Loom Tools view shows every tool definition byte-equal to the provider payload `tools` array (verified by comparing against gateway-side provider request log for one real turn).
- [ ] Skipped/withheld tools appear with reason codes.
- [ ] Tool calls + results/errors for the turn are visible in sequence.
- [ ] A fixture test asserts snapshot tool definitions match the assembled provider payload for DM and group turns.

**Anchors.** `src/operator/garden/**/session-turn-observability.ts:26,65-69`; `admin-ui/src/lib/components/prompt-monitor/PromptMonitorSelectedTurnTabs.svelte`; `admin-ui/src/lib/events/prompt-monitor.ts`; adaptive tool state via `runtime.getAdaptiveToolRuntimeState()` (`src/core/agent/substrate-agent/runtime-context.ts`).

### E0.2 — Truncation honesty across snapshot and Loom views

**Type:** bug · **Priority:** P0 · **Absorbs:** provider-wire-truncation finding of `o1xa`

**Context.** Provider Wire view showed chat history that "looked truncated"; unknown whether the cause is UI display cap, backend snapshot cap, JSON serialization limit, or real prompt truncation. Silent truncation makes the Loom worse than useless — it manufactures false confidence.

**Scope.**
- Audit every point between assembled prompt and rendered Loom view where content can shrink: snapshot capture, event-bus payload limits, persistence, admin API serialization, Svelte rendering caps.
- Classify each as (a) display cap, (b) storage cap, (c) real prompt behavior. Fix (b) where feasible; mark (a) with explicit `…[truncated, N of M chars — view full]` affordance; if (c), that's a prompt bug — file it with evidence.
- Buffer limits (`DEFAULT_STAGE_BUFFER_LIMIT=16`, `DEFAULT_RETRIEVAL_BUFFER_LIMIT=8`) surfaced in the UI ("showing last N").

**AC.**
- [ ] Written inventory (in the bead notes on close) of every truncation point with classification.
- [ ] No Loom view can display shortened content without a visible marker including original length.
- [ ] The 2026-06-30 provider-wire truncation is reproduced against live-shaped fixture data and its cause documented + fixed or filed.

**Anchors.** `session-turn-observability.ts:23-24,144-198`; `src/core/agent/substrate-agent/turn-execution/observability.ts`; `prompt-assembly.ts:533-552` (`emitTurnSnapshotInBackground`).

### E0.3 — Per-block provenance and scope labels in the snapshot

**Type:** feature · **Priority:** P1

**Context.** When `<core_profile>` showed only Iki, the operator couldn't tell *why* — which producer emitted it, keyed to what scope. Answering "whose profile is this and why is it here" must not require reading source.

**Scope.**
- Extend snapshot block records with: producer module, scope key (`dm:<contactId>` / `room:<channelId>` / global), volatility class, source data hint (e.g., core-memory scope key, memory IDs for retrieval blocks).
- Loom renders these as an inspectable header per block.
- Interim implementation on the current snapshot shape; E2.3 replaces the plumbing but keeps the UI.

**AC.**
- [ ] Every prompt block in the Loom shows producer + scope key.
- [ ] A group-turn fixture demonstrates a core-memory block labeled with the room scope key, and a DM fixture with the contact scope key.

**Anchors.** `session-turn-observability.ts:144-198` (AdminPromptLoomData assembly); `runtime-context.ts:665-1119` (section producers); `src/faculties/core-memory/store.ts:28-38` (scope descriptor already carries what we need).

### E0.4 — Group-chat regression harness: fixtures and prompt-shape assertions

**Type:** feature · **Priority:** P0 (blocks E1 verification)

**Context.** Every group bug so far was found by eyeballing live prompts. We need fixtures shaped from live data (multi-human room, DM, mixed companion/human) and assertion helpers, so E1/E2 changes are provable. Complements the memory benchmark direction in `working_docs/SPRINT_9_MEMORY.md` (§Memory Benchmarks) but targets prompt shape, not retrieval quality.

**Scope.**
- Fixture builder producing session/contact/memory state from anonymized live-shaped data: ≥3 humans + 1 peer companion in one room; same humans in DMs; one human NOT in the room (leak probe).
- Assertion helpers: `expectNoBlock(prompt, 'speaking_with')`, `expectBlockScope(prompt, 'core_memory', 'room:...')`, `expectAttributedHistory(...)`, `expectNoMemoryFrom(scope)`.
- Wire into `npm test` as a targeted suite (`npm run test:group-harness` or similar); document in the validation commands list.

**AC.**
- [ ] Harness runs green on current `main` behavior for whatever currently passes, with known-bug assertions marked `.fails` (so E1 flips them to passing, proving the fix).
- [ ] Leak probes exist for: DM→room, room→other-room, room→DM-of-non-member.
- [ ] Fixtures are synthetic/anonymized — no live companion-data content committed to the repo.

**Anchors.** existing e2e patterns under `src/app/e2e/`; `src/faculties/memory/retrieval/access.ts:96-194` (gates the probes exercise); fixture shape reference: `2k8j` observed-evidence section.

---

## E1 — Epic: Group-chat stabilization on the current pipeline

**Type:** epic · **Priority:** P0 · **Absorbs:** `psfn-framework-2k8j` · **Depends:** E0.4 (harness)

**Summary.** Kill the remaining one-speaker bindings without opening the prompt engine: introduce `ConversationScope`, fix core-memory room scoping, gate `speaking_with` to DMs, harden attribution, scope emotion state with directional carry-over, fix sleeptime cadence, scope reflections, and guarantee multi-companion observation correctness.

**Operator decisions binding here.** Room = channelId; ≤5 recent speakers; DM/group shapes symmetric; deterministic filtering pre-prompt; group→DM affect carry-over only, fast decay; text-prefix attribution canonical.

**Epic AC.** Live group room shows stable room-scoped core memory across speaker changes; no reproducible cross-room or room→DM state bleed; all E0.4 known-bug assertions flipped to passing; targeted suites + lint + build green.

### E1.1 — Introduce ConversationScope and thread it from ingress to consumers

**Type:** feature · **Priority:** P0 (prerequisite for E1.2/.3/.5/.7)

**Context.** The one-speaker assumption survives at *binding points* because each consumer independently derives "who am I talking to" from loose params (`message.isDirectMessage`, `authorId`, contact lookups). One value object ends that class of bug.

**Scope.**
- Define `ConversationScope` in `src/core/session/` (or `src/shared/contracts/` if cross-boundary): `{ kind: 'dm', channelId, contact }` | `{ kind: 'group', channelId, recentSpeakers: ContactRef[≤5], roomName?, memberCountHint? }`, plus derived `key(): 'dm:<contactId>' | 'room:<channelId>'`.
- Resolve once per turn at session-manager ingress from existing metadata (`channelId`, `isDirectMessage`, canonical contact resolution, recent-entry participant scan already implemented at `manager.ts:1336-1348`).
- Thread through: `buildCoreMemoryFormatContext`, `buildRuntimeContextBlock`, emotion runtime, reflection/heartbeat entry, memory retrieval context construction. This bead is *mechanical threading only* — behavior changes land in the dependent beads.
- `resolveConversationChatType` (`runtime-context.ts:566`) becomes a scope accessor; delete the ad-hoc rederivations it replaces (clean break, no shims).

**Non-goals.** No behavior change in this bead; downstream beads flip behavior. No API-channel group support (E3 territory at earliest).

**AC.**
- [ ] Exactly one construction site per turn; consumers listed above take the scope object, not `isDirectMessage`/`authorId` loose params.
- [ ] Type prevents `kind:'group'` from carrying a single canonical `contact` field (compile-time, not convention).
- [ ] `npm run build`, full targeted session/runtime suites green with zero behavior diffs (harness snapshot comparison pre/post).

**Anchors.** `src/core/session/manager.ts:570,1331-1358`; `src/core/agent/substrate-agent/runtime-context.ts:66,566-567,613-700`; `src/channels/discord/adapter.ts:398-422`.

### E1.2 — Channel-scoped core memory binding, block naming, and startup hydration

**Type:** bug · **Priority:** P0 · **Absorbs:** `psfn-framework-2k8j` (primary)

**Context.** `buildCoreMemoryFormatContext()` sets `participantName = recentParticipants[0]` (`manager.ts:1353-1355`) — the most recent speaker, not a stable subject. Live evidence: `<core_memory>` described Carlini as a generic AI assistant; `<human>` blended multiple people; `<core_profile>` flipped to the last speaker. The store side is already channel-scoped (`core-memory/store.ts:364-388`, key `channel:<channelId>`); the *binding and rendering* are wrong.

**Scope.**
- DM scope: bind the canonical contact (not "first recent participant"); user-facing block is named for the contact (e.g., `<human name="Vega">` — exact shape mirrors group form below; operator decision #1: keep DM/group symmetric).
- Group scope: never a single-person `<human>`. Room summary context: room name/ID, recent-member count, ≤5 recently active names; per-person detail lives in per-contact profiles, sensitivity-gated, not blended into one block.
- Producers (orient updates, sleeptime writes at `sleeptime-agent.ts:672-674`) and consumers (context builder read at `manager.ts:1113-1116`) verified to use `scope.key` symmetrically — write-side already builds channel scope; prove the read side matches.
- Startup hydration: on boot, hydrate active core-memory blocks for recently active channels from last persisted content so the first post-restart prompt has non-empty scoped blocks while async memory catches up (bead `2k8j` requirement).
- One-time audit (script or maintenance command) of existing core-memory rows: report rows whose scope key is `legacy_global` or mismatched; no destructive migration — report + operator decision.

**Non-goals.** No synchronous memory retrieval in the chat path. No per-member ACL matrix. No Loom redesign.

**AC.**
- [ ] Harness: in a 3-human room, speaker changes across 3 consecutive turns produce byte-identical core-memory block scope binding (content may evolve; subject binding may not flip).
- [ ] Harness: DM block is named for the contact; group block contains room identity + ≤5 recent names and no single-person profile body.
- [ ] Harness: room A core memory never appears in room B or in a DM prompt; DM core memory never appears in any room (E0.4 leak probes flip to green).
- [ ] Restart test: first prompt after process restart contains hydrated scoped blocks for a channel active within the hydration window.
- [ ] Audit command output documented in bead notes on close.

**Anchors.** `src/core/session/manager.ts:1331-1358,1113-1116`; `src/faculties/core-memory/store.ts:5-6,28-38,80-94,364-388`; `src/faculties/memory/sleeptime-agent.ts:633-674`.

### E1.3 — Gate speaking_with context to DM scope only

**Type:** bug · **Priority:** P0

**Context.** `runtime_speaking_with_*` tokens are populated even for group turns (`runtime-context.ts:717-722` — audit found the DM-only guard missing). A room of five gets prompt context asserting a single interlocutor.

**Scope.**
- `speaking_with` block and all `runtime_speaking_with_*` variables render only for `scope.kind === 'dm'`.
- Group turns rely on `conversation_state` (`current_message_author` + `recent_active_participants`) — already correct shape.
- Check the seeded runtime layer template for `{{#if}}` guards consistent with the variable behavior (empty-section pruning must remove the block cleanly, not leave headers).

**AC.**
- [ ] Harness: group-turn prompt contains no `speaking_with` block and no populated `runtime_speaking_with_*` token; DM-turn prompt unchanged from current behavior.
- [ ] Unresolved-token telemetry shows no new leaks from the removal.

**Anchors.** `src/core/agent/substrate-agent/runtime-context.ts:706-750`; `config/runtime-prompt-layers.seed.json:30` (conversation_state layer).

### E1.4 — Canonical attribution contract: one formatter, escaping, forgery tests

**Type:** feature · **Priority:** P1

**Context.** Attribution is a text prefix `"Name (id): "` built in `entry-attribution.ts:58-68` and structurally dropped at `message-conversion.ts:226-281`. Operator decision #7: text-prefix is canonical (general LLM limitation — provider chat formats don't carry per-message speaker metadata portably). What's missing is hardening: a display name containing `"): "` or a crafted "Alice (discord:123):" prefix inside message *content* can forge attribution.

**Scope.**
- Single exported formatter + (for tooling/tests) parser: the only code allowed to construct or interpret the prefix. Delete duplicate inline formatting.
- Escaping/sanitization for display names (strip/encode delimiter sequences, control chars, leading whitespace tricks); stable author ID always present as the trustworthy component.
- Content-forgery mitigation: document the trust rule (only the prefix outside user-authored content is authoritative) and ensure history rendering never lets user content start a line that is indistinguishable from a real prefix (e.g., escape or mark user-content lines that match the prefix grammar).
- Round-trip and adversarial tests (hostile display names, prefix-shaped message bodies, unicode confusables at the delimiter).
- Write the contract into `docs/` (short section: format, trust rule, escaping).

**Non-goals.** No structural provider metadata (not portable). No renaming of existing stored entries.

**AC.**
- [ ] One formatter; grep proves no other call site builds the prefix pattern.
- [ ] Adversarial test suite green: hostile names cannot break out; content cannot forge a prefix that the renderer emits as authoritative.
- [ ] Docs section merged in the same change.

**Anchors.** `src/core/session/entry-attribution.ts:58-68,168-229`; `src/primitives/llm/message-conversion.ts:226-281`; `src/core/session/manager/context-builder.ts:195-260`.

### E1.5 — Scoped emotion/appraisal state with directional fast-decay carry-over

**Type:** feature · **Priority:** P1 · **Depends:** E1.1

**Context.** Audit indicates emotion snapshots/appraisal are keyed to contact/last-speaker with no room dimension (`runtime-context.ts:1072`; `src/core/emotion/state.ts` VAD/mood). Operator-ratified semantics: per-scope state; a room argument may briefly color a following DM ("Jeff was so annoying in gc") but decays fast; **group→DM only, never DM→group; DM→DM allowed for the same contact across channels**; disliking one user must not meaningfully affect others.

**Scope.**
- First: a short written audit of current keying (emotion state, appraisal chains, per-contact baselines) — confirm or correct the audit's inference before changing persistence. Post findings to the bead before implementation.
- Persist emotion/appraisal state keyed by `scope.key`; companion-global baseline (her overall mood/VAD) remains a separate layer that scoped states modulate, so "her mood" still exists.
- Carry-over modifier: on scope switch group→DM (same companion, DM contact is a member of that group), apply a bounded, fast-decaying modifier from the group state (half-life on the order of minutes — config-owned in the emotion settings owner, not hardcoded). Direction enforcement mirrors continuity flow rules (`policy.ts:447-473` precedent): DM state never seeds any group state; DM→DM carry-over only when same canonical contact.
- Per-contact emotional baselines (`contacts/types.ts` `emotionalBaseline`) unchanged — they are about the *contact*, not the scope.
- Restart persistence: scoped states participate in existing internal-state rehydration.

**Non-goals.** No changes to appraisal LLM prompts beyond scope key plumbing. No cross-companion emotion sharing.

**AC.**
- [ ] Audit note posted (current keying, confirmed with anchors) before the change lands.
- [ ] Test: high-arousal group state → subsequent DM shows bounded modifier that decays below threshold within the configured half-life; DM state change produces zero group-state delta; second unrelated DM contact sees no modifier.
- [ ] Config knobs live in a JSON owner (settings/emotion), documented; no magic constants.
- [ ] Restart test: scoped states rehydrate.

**Anchors.** `src/core/emotion/state.ts`; `src/core/agent/substrate-agent/runtime-context.ts:1072-1130`; `src/system/trust/policy.ts:447-473` (directional-flow precedent); internal-state rehydration (see `PSFN_PROJECT_STATE_20260611.md` §2 heartbeat notes).

### E1.6 — Group-aware, JSON-owned sleeptime cadence

**Type:** bug · **Priority:** P1

**Context.** Sleeptime fires every 3rd turn per session (`DEFAULT_CADENCE_TURNS = 3`, `sleeptime-agent.ts:50,550`) unless a rest window suppresses it. In a busy 10-person room that is near-continuous background LLM work — matches operator observation "sleeptime firing frequently despite being intended as sleep/cleanup," and burns charge. Group rooms already have watermark/range machinery for extraction (`docs/memory.md:135-149`); sleeptime should use the same posture.

**Scope.**
- Cadence config moves to a JSON owner (scheduler or memory settings owner — follow existing ownership of `groupMemory.*` settings), per-mode: `direct` keeps turn-cadence; `group` uses watermark/interval-based batching (min-interval + min-new-entries), not per-N-turns.
- Investigate whether the "sleeptime as sleep/cleanup" intent means group sleeptime should defer to rest-window/nightly consolidation entirely (operator hinted this); implement the conservative version (interval batching) and note the open question for the memory-lane rework.
- Telemetry: sleeptime fire-rate per channel per hour, visible in Garden scheduler views.

**AC.**
- [ ] Group room fixture: 30 rapid turns produce ≤ configured number of sleeptime runs (vs ~10 today).
- [ ] DM behavior unchanged by default.
- [ ] Settings validated by the owner-file contract guard; `npm run verify:settings-contract` green.
- [ ] Fire-rate telemetry visible.

**Anchors.** `src/faculties/memory/sleeptime-agent.ts:50,502,534-564`; `src/system/config/settings-contract-guard.ts`; `docs/memory.md:135-149`; `docs/operations.md:165-171`.

### E1.7 — Reflection and heartbeat turns take a ConversationScope

**Type:** feature · **Priority:** P2 · **Depends:** E1.1

**Context.** Reflection/heartbeat runtime binds a single "bound canonical contact hint" (`runtime-context.ts:1498-1502`); group-scoped reflection would either mis-bind one member or fall back incoherently.

**Scope.**
- Reflection/heartbeat entry points accept a scope. DM-scoped behavior byte-identical to today. Group-scoped reflection reflects on the room (uses room core-memory context from E1.2, room-scoped memories, no single-contact binding).
- Continuity fallback keys (`collectContinuityFallbackKeys`, `runtime-context.ts:1469-1470`) become scope-aware.
- Internal channels (`internal:heartbeat`, `internal:reflection:*`) keep their existing isolation rules (`manager-primitives.ts:88-106`).

**AC.**
- [ ] DM reflection prompt snapshot pre/post identical (golden).
- [ ] Group reflection fixture: prompt contains room scope context, no `speaking_with`, no single-member core-memory binding.
- [ ] Existing heartbeat/reflection suites green.

**Anchors.** `src/core/agent/substrate-agent/runtime-context.ts:1469-1502`; `src/core/session/manager-primitives.ts:74-106`; `src/core/scheduler/heartbeat-post-turn-runtime.ts`.

### E1.8 — Multi-companion observation correctness in shared rooms

**Type:** feature · **Priority:** P1

**Context.** Target deployment: ~10 friends + several companions on the same substrate in one room. Companions are contacts with `isMachineIntelligence` (`contacts/types.ts:256`); group extraction already weights them (`extraction/group-classifier.ts`). Unverified: a peer companion must never be selected as DM-canonical human, core-memory subject, or `speaking_with` target, and its messages must be attributed like any speaker.

**Scope.**
- Guard rails: canonical-contact resolution for `scope.kind:'dm'` and core-memory subject selection exclude `isMachineIntelligence` contacts unless the DM *is* with that companion (companion-DM is legitimate — Artemis case; then it binds normally and the machine-intelligence flag flows to prompt state, which already exists at `runtime-context.ts:282,1459`).
- Harness fixtures include a peer companion speaking in the room: attribution rendered, participant list includes it, extraction weighting applied, no human-profile blending.
- Loop-risk note: no automatic reply-to-companion suppression here (fatigue budgets are the designed control, separate epic) — but verify existing behavior doesn't auto-respond in a tight loop in fixtures; if it does, file separately, don't patch silently.
- **CHARTER GATE (Law 26 / §8.10 / Phase 12):** the charter requires fatigue/load policy *before* companion-to-companion chat becomes active. This bead delivers observation correctness only; **enabling multiple companions to actively converse in a shared live room remains gated on the FatigueBudgetPort epic** (rate/charge/attention budgets, loop stopping conditions). Until then, multi-companion rooms run with companions that do not reply to each other, or the fatigue epic lands first. This gate must be stated on the bead and in the room-enablement runbook.

**Non-goals.** No companion-to-companion protocol (`psfn-framework-8pyl`). No fatigue budgets (charter 8.10 work) — but they gate live enablement, see above.

**AC.**
- [ ] Fixture: peer companion speaks; `<human>`/profile blocks contain zero companion-derived content; participant XML lists it with its identity.
- [ ] Companion-DM fixture: binding works, `speaking_with_is_machine_intelligence` true.
- [ ] Loop check documented in bead notes; any auto-reply loop found is filed as its own bug, not silently patched.
- [ ] Charter gate recorded: live multi-companion conversational rooms blocked on fatigue policy; documented where operators will see it (Garden channel view or ops doc).

**Anchors.** `src/core/contacts/types.ts:256`; `src/faculties/memory/extraction/group-classifier.ts`; `src/core/agent/substrate-agent/runtime-context.ts:282,1459`.

---

## E2 — Epic: PromptPlan — one assembly path, one artifact, real caching

**Type:** epic · **Priority:** P0 (foundation) · **Absorbs:** remainder of `psfn-framework-8sow.10` · **Depends:** E0 (goldens/Loom), E1 (scope object, stable behavior to freeze)

**Summary.** Collapse the prompt system to a single per-turn artifact (`PromptPlan`: ordered blocks with volatility classes + one variable namespace + messages + tool definitions + cache plan) with three consumers: provider serializer, Loom snapshot, cache. Removes the dual assembly paths (charter violation: one function, many things), fixes Loom fidelity by construction, engages provider-side caching model-agnostically, and puts the macro surface on a diet without violating the purity rule.

**Operator decisions binding here.** Purity rule non-negotiable (bare values + operator-editable layer text; consolidate duplicates hard); model-agnostic caching (OpenRouter/open/local primary → byte-stable prefix is the universal mechanism; Anthropic `cache_control` as serializer feature); clean break on dead paths, no compatibility shims.

**Epic AC.** One assembly path (both legacy dual paths deleted); Loom renders the persisted plan and matches the wire byte-for-byte; static-prefix byte-stability asserted in CI across consecutive turns; `promptCaching.configured === true` with per-provider engagement telemetry; macro manifest governs the namespace; goldens lock DM/group/heartbeat/reflection shapes.

### E2.1 — Single variable namespace with a registered manifest

**Type:** feature · **Priority:** P0

**Context.** Three variable maps are built in separate phases (`buildPromptTemplateVariables`, `buildDynamicPromptTemplateVariables`, additions inside `buildRuntimeContextBlock`) and merged with no conflict rules; the same key can be written twice with no defined winner. Also the direct cause of "variables where it should be static": dynamic values contaminating the static prefix render and busting byte-stability.

**Scope.**
- Variable manifest: every macro registered with name, type, volatility (`static | session_stable | turn`), producer. Extends `PROMPT_RUNTIME_MACRO_HINTS` rather than paralleling it (one registry).
- Namespace built once per turn from `ConversationScope` + envelope + state; duplicate registration or later-phase write = startup/turn hard error (fail closed).
- Volatility enforcement: a `turn`-volatile variable referenced inside a `static`-class layer is a build-time contract error — this mechanically prevents the static-prefix contamination class of bug.
- `VOLATILE_MACRO_TOKENS` and the stable-variable exclusion list (`prompt-lifecycle.ts:43-83`) derive from the manifest instead of hand-maintained lists.

**AC.**
- [ ] Every existing macro appears in the manifest with declared volatility; CI fails on unregistered token usage in seeded layers.
- [ ] Test: registering a duplicate key throws; writing a variable after namespace freeze throws.
- [ ] Test: a static-class layer referencing a turn-volatile macro fails validation with a clear error.
- [ ] `docs/prompt-macros.md` regenerated or updated from the manifest (single source of truth).

**Anchors.** `src/core/identity/prompt-runtime.ts:329-343,1092-1113`; `src/core/agent/substrate-agent/turn-execution-runtime.ts:169-194`; `prompt-lifecycle.ts:43-83,361-378`.

### E2.2 — PromptPlan artifact and single assembly path

**Type:** feature · **Priority:** P0 · **Depends:** E2.1

**Context.** Assembly spans 8 stages / 37+ files; `composeSplit` vs `compose` (`prompt-lifecycle.ts:278-322`) and `buildContext` vs `captureTurnContextSnapshot` (`manager.ts:1098-1293`) are dual paths re-deriving the same thing — flagged by operator as a charter/dev-rules violation.

**Scope.**
- Define `PromptPlan` (blocks with id/layer/volatility/producer/scopeKey/renderedText/tokensEst; frozen variable namespace; messages incl. attribution; toolDefinitions; cachePlan boundaries; ConversationScope + envelope refs).
- Refactor existing producers (composer layers, runtime-context sections, memory blocks, session context) to *emit blocks into the plan*; content and ordering initially byte-identical to today (goldens from E0.4/E2.7 prove it).
- Provider serialization (`message-conversion.ts` + system merge at `prompt-assembly.ts:359-391`) becomes a pure function of the plan.
- Delete `compose`/`composeSplit` duality (one composer API) and `captureTurnContextSnapshot` (snapshot = persisted plan). Clean break; update callers; no shims.
- Datetime anchor handling (strip-and-append hack at `message-conversion.ts:198-230`) becomes an ordered turn-volatile block — no post-hoc string surgery.

**Non-goals.** No block content redesign in this bead (that's E2.5/E2.6); no cache engagement yet (E2.4).

**AC.**
- [ ] Goldens: DM/group/heartbeat/reflection wire payloads byte-identical pre/post refactor (modulo an approved allowlist of intentional fixes, each documented).
- [ ] `grep` proves `composeSplit`, `captureTurnContextSnapshot` are gone; one assembly entrypoint.
- [ ] The persisted turn snapshot IS the plan (schema-versioned); no parallel snapshot builder remains.
- [ ] Full suite + lint + build green; live smoke (`npm run smoke:chat`) clean.

**Anchors.** `prompt-lifecycle.ts:278-322`; `manager.ts:1098-1293`; `context-builder.ts:162-400`; `prompt-assembly.ts:257-391`; `message-conversion.ts:198-281`.

### E2.3 — Loom renders the PromptPlan

**Type:** feature · **Priority:** P1 · **Absorbs:** remainder of `8sow.10` (separated views) · **Depends:** E2.2

**Context.** With the plan persisted per turn, the Loom stops re-deriving. `8sow.10`'s deferred intent (separate views for prompt / provider payload / memory / tools / cache) becomes natural: they're projections of one artifact.

**Scope.**
- Admin API serves the plan; UI tabs: Blocks (with E0.3 provenance headers), Provider Wire (serialized payload), Tools (from E0.1, now plan-backed), Memory (retrieval inputs/withheld summary), Cache (volatility regions, prefix hash timeline, hit/miss).
- Diff affordance: compare two turns' plans (which blocks changed — this is how prompt regressions get spotted in seconds).
- Keep E0 truncation-honesty guarantees.

**AC.**
- [ ] For a live turn: Provider Wire tab content byte-equal to the gateway-logged provider request.
- [ ] Turn-diff view shows block-level changes between consecutive turns; static region shows zero diff across a quiet conversation.
- [ ] `8sow.10` closeable as absorbed.

**Anchors.** `admin-ui/src/lib/components/prompt-monitor/`; `src/operator/garden/api-routes.ts`; E2.2 plan schema.

### E2.4 — Model-agnostic provider cache engagement

**Type:** feature · **Priority:** P1 · **Depends:** E2.2 · **Related:** `psfn-framework-57m` (OpenRouter param support)

**Context.** `promptCaching: { configured: false, engaged: false }` (`prompt-assembly.ts:509-512`). Primary stack is OpenRouter + open models and local runners, where the cache mechanism is implicit prefix/KV reuse — i.e., *byte-stable prefix is the feature*. Anthropic `cache_control` is a per-provider extra.

**Scope.**
- CachePlan on the artifact: static boundary (base+operator+static layers), session-stable boundary; serializers apply per-provider mechanism: Anthropic → `cache_control` breakpoints; OpenRouter/open/local → guarantee byte-stable prefix ordering + pass provider cache params where supported.
- Land behind a `models.json`/settings owner flag; verify on a test channel before live default (live-deployment billing/latency caution).
- Telemetry: per-turn prefix-stability check (did the static region's bytes change? which block caused it?) + provider-reported cache metrics where available; surfaced in the E2.3 Cache tab.
- Prefix-instability is a *named alert*, not a silent stat — a regression here is exactly the "variables where it should be static" bug returning.

**AC.**
- [ ] Ten-turn quiet conversation on the test channel: static region hash identical across all turns; any change identifies the offending block in telemetry.
- [ ] Anthropic roster slot: request payload carries cache breakpoints; hit metrics recorded.
- [ ] Flag documented in owner-file schema; `verify:settings-contract` green.
- [ ] `promptCaching.configured/engaged` reflect reality in turn telemetry.

**Anchors.** `prompt-assembly.ts:509-512`; `src/primitives/llm/` provider ports; `src/system/config/` models/providers owners; `prompt-lifecycle.ts:380-491` (internal cache stays as render memoization).

### E2.5 — Macro consolidation under the purity rule

**Type:** feature · **Priority:** P1 · **Depends:** E2.1

**Context.** ~100+ macros with heavy duplication (datetime alone has ~8 spellings: `current_datetime`, `now()`, `current_date`, `date()`, `unix_timestamp`, `timestamp()`, ISO/human variants...). Operator direction: consolidate hard; keep bare values; **never** hardcode prose — the framing around values must stay operator-editable (concerns-block distress incident is the canonical warning). Tooling text exempt; personality-adjacent text not.

**Scope.**
- Consolidation pass over the manifest: one canonical macro per datum + documented aliases *removed* (clean break; seeded layers updated in the same change; operator-customized live layers checked via Garden layer dump before removal, coordinated with operator).
- Convenience/prose macros with bare siblings (table in `docs/prompt-macros.md:41-54`): migrate default layers to bare-sibling + layer text, then delete the prose macro. The two known violations (continuity-gap notice, charge block — `docs/prompt-macros.md:63-66`) migrate to macro+layer form.
- Renderer: single-pass over the manifest + `{{#if}}`; unresolved token in a required layer = hard error; in optional layer = section dropped + telemetry event (kills the 3-pass silent-leak loop at `prompt-runtime.ts:1167`).
- Target number is an outcome, not a quota — but expect roughly half the current surface; every survivor is manifest-registered with volatility.

**AC.**
- [ ] No prose/guidance strings constructed in code paths feeding personality-adjacent blocks (concerns, continuity, affect framing) — all live in editable layers; spot-audited.
- [ ] Datetime macros reduced to a documented canonical set; seeded layers reference only survivors.
- [ ] Renderer test: unresolved required token fails the turn loudly; optional section drops with telemetry.
- [ ] `docs/prompt-macros.md` regenerated; live layer dump reviewed with operator before alias deletion (noted in bead).

**Anchors.** `src/core/identity/prompt-runtime.ts:51-56,1115-1195`; `docs/prompt-macros.md`; `src/core/intention/concerns.ts` (`OPEN_THREADS_BODY_TEMPLATE`, `softenConcernText` — the code-owned rewrite rules become data per the doc's open item).

### E2.6 — Decompose runtime-context block building into declared section producers

**Type:** refactor · **Priority:** P2 · **Depends:** E2.2

**Context.** `buildRuntimeContextBlock` is ~450 lines interleaving data fetch, variable construction, and XML rendering (`runtime-context.ts:665-1119`); state builders look up their own dependencies (hidden coupling, `1070-1130`).

**Scope.**
- Each section (trust, affect, concerns, participants, tooling, charge, continuity-gap, metacognition...) becomes a producer with declared inputs (scope, envelope, namespace) returning a plan block; no producer fetches its own global state.
- Target: no prompt-producing function over ~80 lines; each section independently unit-testable.
- Pure mechanical decomposition — goldens hold byte-identical output.

**AC.**
- [ ] Goldens unchanged; `buildRuntimeContextBlock` monolith gone; largest producer ≤ ~80 lines.
- [ ] Each producer has a direct unit test with fabricated inputs (no runtime scaffolding).

**Anchors.** `runtime-context.ts:665-1119`.

### E2.7 — Prompt-shape goldens and static-prefix byte-stability in CI

**Type:** feature · **Priority:** P0 (land FIRST in this epic, before E2.2)

**Context.** Prompt regressions are personality regressions for a live companion. Goldens must exist before the engine is opened.

**Scope.**
- Golden snapshots (deterministic fixtures, fixed clock injection — assembly must accept an injected clock; incidental fix if it doesn't) for: DM turn, group turn (3 humans + companion), heartbeat, reflection, DM-with-memories, group-with-withheld-memories.
- Static-prefix stability test: two consecutive turns, assert byte-equal static region; wire into `npm test`.
- Scrubbing rules for genuinely-variable content (IDs, timestamps) per golden-testing practice; goldens reviewed like code.

**AC.**
- [ ] Six goldens committed and green on pre-E2.2 behavior.
- [ ] Static-prefix stability test green pre-refactor (or failing with the cause documented and fixed as a fast-follow — this is exactly the "should-be-static variables" bug made visible).
- [ ] Golden update procedure documented (intentional changes require reviewed regeneration).

**Anchors.** E0.4 harness; `prompt-lifecycle.ts:41,361-378` (hashes to assert against).

---

## E3 — Epic: Context Envelope — channel/relationship/trust semantics

**Type:** epic · **Priority:** P1 · **Absorbs:** `psfn-framework-8sow.11`, `psfn-framework-zet.1`, `psfn-framework-4caj.1` (contract portion) · **Depends:** E1 (scope), E2.1 (variables) — E2.2+ helpful but not required

**Summary.** Split the overloaded `channelVisibility` into ratified orthogonal dimensions (`channelPrivacy: private/invite_only/public` + derived `audienceScope`/`audienceKnowledge` + `broadcast` flag), make privacy channel-owned, keep the 6-layer deterministic gate shape, add the contact-tracking policy gate as scale scaffolding, and gate the admin memory API. Design target: invite-only rooms of ~10 known people + companions; large-audience behavior expressible but LATER.

**Epic AC.** Every channel resolves to an explicit envelope visible in Garden; withheld-reason codes cite envelope dimensions; `semi_private` is gone (clean break); leak-rate test family green in CI; contact creation gateable through the approval queue.

### E3.1 — Ratify and land the Context Envelope contract

**Type:** feature · **Priority:** P1 · **Absorbs:** contract portion of `4caj.1`

**Context.** Vocabulary ratified 2026-07-01 (plan §3.3/§7). This bead is the *contract*: types, owner-file schema, derivation rules, precedence — reviewed by operator before wiring (E3.3). Answers "do we need more tiers?" — no: 4 trust × 4 sensitivity is enough for the target; the gap was missing *dimensions*, which the envelope adds. Levels stay as-is.

**Scope.**
- Types in `src/system/trust/types.ts`: `ChannelPrivacy = 'private'|'invite_only'|'public'` (replaces `ChannelVisibility`; `semi_private` removed, no alias); `AudienceScope = 'one'|'few'|'many'|'unbounded'`; `AudienceKnowledge = 'all_known'|'partially_known'|'anonymous'`; `broadcast: boolean`; envelope = `{channelPrivacy, audienceScope, audienceKnowledge, broadcast}` + refs to trust/sensitivity (unchanged).
- Owner-file schema: `channels.json` owns per-channel privacy + broadcast + `contactTracking` mode + audience thresholds (config-owned numbers, defaults ~few≤10/many≤100); `trust-policy.json` keeps ceilings, gains envelope-keyed `visibilityAllowed` replacing the old visibility-keyed map. Precedence documented in the schema: channel-owned label > operator trust-policy override > derived default (`invite_only`).
- Delivery-guidance rule written into the contract doc: substrate ships length/delivery knobs only; persona/tone prose is layer text (charter).
- Migration map documented: `private→private`, `semi_private→invite_only`, `public→public`, `broadcast→(public + broadcast flag)`; continuity direction table updated for the new names (same relative ordering).
- Contract doc in `docs/` (or extend `docs/architecture.md`) + operator review checkpoint before E3.2/E3.3 start.

**AC.**
- [ ] Types + owner schemas merged behind the contract guard; `verify:settings-contract` green.
- [ ] Contract doc covers: dimensions, derivation, precedence, migration map, continuity direction, delivery-guidance rule, explicit LATER list (role-gating, sentiment views, content firewall).
- [ ] Operator sign-off recorded on the bead before dependent beads start.

**Anchors.** `src/system/trust/types.ts:13,33`; `src/system/config/trust-policy-config.ts:22-34`; `src/system/config/startup-owner-files.ts`; `config/trust-policy.seed.json`.

### E3.2 — Channel-owned privacy label migration

**Type:** feature · **Priority:** P1 · **Absorbs:** `8sow.11` · **Depends:** E3.1; **Related:** `psfn-framework-m82u` (owner-file migration framework — use it if landed, else a guarded one-off)

**Context.** Privacy labels currently live in three places with undocumented precedence: trust-policy overrides/prefixes/default, per-contact `ContactChannelLink.privacyLevel`, per-contact `ContactConversationChannel.privacyLevel`. Channel-owned was already the suspected end-state in the 8sow record.

**Scope.**
- `channels.json` becomes the authority for per-channel privacy; the 7-step `classifyChannel` hierarchy (`policy.ts:297-333`) simplifies to: channel-owned label → operator override → derived default (`isDirectMessage→private`, else `invite_only`). Prefix heuristics (`api:`, `internal:`, `subagent:`...) become seed data for channel records, not runtime authority.
- Per-contact privacy fields demoted to evidence (kept for provenance/history, no longer consulted by gating); mark deprecated in types; removal is a later cleanup bead.
- One-time migration: enumerate known channels from contact conversation-channel rows + session store; emit channel records with derived labels; **report** ambiguous ones for operator resolution rather than guessing (fail closed: unresolved channels get `invite_only` + a Garden warning badge).
- Garden: channel list view with envelope columns + edit affordance.

**AC.**
- [ ] `classifyChannel` consults channel records; per-contact labels provably absent from gating decisions (test).
- [ ] Migration produces a reviewable report; no silent guesses; unresolved → safe default + visible badge.
- [ ] Garden channel view shows and edits privacy/broadcast/tracking per channel.
- [ ] Continuity/mirroring behavior verified unchanged for equivalently-labeled channels (goldens).

**Anchors.** `src/system/trust/policy.ts:297-333`; `src/core/contacts/types.ts:29,34-40`; `src/system/config/startup-owner-files.ts`; `src/core/session/continuity.ts`; `src/core/session/manager/mirroring.ts`.

### E3.3 — Envelope derivation and gating wire-through

**Type:** feature · **Priority:** P1 · **Depends:** E3.1, E3.2

**Context.** With the contract and channel ownership landed, derive the full envelope per turn and consume it in the existing deterministic gates without changing their layered shape.

**Scope.**
- Derivation at scope-resolution time: `audienceScope` from topology + known-roster size (E4.1 roster if landed; recent-speaker count as interim); `audienceKnowledge` from fraction of recent speakers resolvable to contacts; envelope attached to `ConversationScope` and frozen into the variable namespace + PromptPlan.
- Memory policy layer 5 (`policy.ts:262-270`) consults envelope (`visibilityAllowed` keyed by privacy; broadcast flag retains approval-token machinery from `broadcast-safety.ts`); layers 1-4 untouched.
- Withheld-reason codes updated to cite envelope dimensions (extends the existing 8 reason tags).
- Response style resolution (`policy.ts:365-436`) decoupled from privacy: style comes from channel-owned delivery settings; envelope no longer implies tone.
- Continuity direction (`policy.ts:447-473`) re-expressed over `channelPrivacy` (same semantics, new names).

**AC.**
- [ ] Harness: per-envelope fixtures (dm-private, invite_only-few-all_known, public-many-partially_known, public+broadcast) produce documented gate outcomes; withheld reasons cite dimensions.
- [ ] Response style provably independent of privacy (test: public channel with expressive delivery setting).
- [ ] No prompt contains privacy-reasoning prose (harness assertion).
- [ ] Full trust/retrieval suites green.

**Anchors.** `src/system/trust/policy.ts:209-279,365-436,447-473`; `src/faculties/memory/retrieval/access.ts:141-230`; `src/system/trust/broadcast-safety.ts:121-130`.

### E3.4 — Contact-tracking policy gate (human-in-the-loop contact creation)

**Type:** feature · **Priority:** P1 · **Depends:** E3.1

**Context.** Scale scaffold, ratified: in small trusted rooms contacts auto-create as today; as rooms grow, new tracked contacts require operator approval; `role_gated` reserved for the LATER large-audience doc. Guard: "1000 people in chat — I'm not adding profiles from 'vtubegooner69' to memory."

**Scope.**
- `channels.json` per-channel `contactTracking: 'auto' | 'approval' | 'role_gated'` (default `auto`; `role_gated` validates but returns not-implemented — fail closed, visible).
- `approval` mode: contact creation from a new speaker enqueues to the existing approval queue (boundary approval machinery) instead of auto-upserting (`upsert-resolve-operations.ts:86-200`); until approved, the speaker is *untracked*: transcript attribution + text-prefix identity only; no contact record, no profile, no per-person memory extraction (extraction's mention-only path must respect the gate too), no social-graph entity.
- Memory extraction behavior for untracked speakers: room-scoped facts may still record `sourceSpeakerName` (attribution truth) but create no contact-keyed rows.
- Garden: pending contact approvals view (name, channel, first-seen, sample messages) with approve/deny.
- Charter §9.6: when approval is required, the human must be *meaningfully notified* — route a pending-contact notification through the existing gateway notification path (system-derived mode), not just a silent queue row.

**Non-goals.** No sentiment-only views, no reply-suppression tiers, no content firewall (LATER doc).

**AC.**
- [ ] Fixture: `approval` room — new speaker triggers queue entry; no contact/profile/graph rows until approval; post-approval, subsequent messages resolve normally.
- [ ] Pending approval produces an operator notification via the gateway notification path (test), per charter §9.6.
- [ ] Untracked-speaker room memories carry speaker-name provenance but zero contact-keyed records (query assertion).
- [ ] `auto` rooms byte-identical to current behavior.
- [ ] Owner-file validation + Garden approval flow tested.

**Anchors.** `src/core/contacts/store/upsert-resolve-operations.ts:86-200`; `src/boundary/gateway/approval-boundary.ts`; `src/faculties/memory/extraction/mention-only-contacts.ts`; `src/system/config/startup-owner-files.ts`.

### E3.5 — Sensitivity-gate the Garden admin memory API

**Type:** feature · **Priority:** P1 · **Absorbs:** `psfn-framework-zet.1` · **Depends:** E3.1 (vocabulary) — can start earlier if zet.1's existing notes suffice

**Context.** `/api/admin/memory` currently exposes all memories with no sensitivity handling (`api-routes-memory.ts`). The operator is trusted, but the surface should require explicit elevation for intimate/confidential content (audit trail, shoulder-surfing, future multi-operator).

**Scope.**
- Default admin listing redacts `intimate`/`confidential` bodies (metadata visible); explicit reveal action per item or session-elevated mode, audited (who/when/what) via existing Garden audit/telemetry.
- Bulk operations respect the same gate; export paths included.
- Align with whatever zet.1 already specifies (it's the surviving Sprint-9-synthesis bead — merge its notes into this bead on filing).

**AC.**
- [ ] Default memory list shows redacted bodies for high-intimacy rows; reveal is explicit + audit-logged.
- [ ] Bulk/export paths covered by the same gate (test).
- [ ] Garden UX still workable for daily memory curation (operator check).

**Anchors.** `src/operator/garden/api-routes-memory.ts`; `src/operator/garden/` audit/telemetry services; `src/system/trust/types.ts:10,30-31`.

### E3.6 — Envelope leak-rate test family in CI

**Type:** feature · **Priority:** P1 · **Depends:** E3.3; extends E0.4

**Context.** The SPRINT_9_MEMORY benchmark direction named privacy/trust leak metrics; the envelope makes the matrix concrete. This is the permanent regression net for everything E1-E3 built.

**Scope.**
- Fixture matrix over envelope classes × sensitivity levels × trust tiers (not exhaustive — the meaningful corners, documented): assert zero-leak for each forbidden combination and presence for each allowed one.
- Withheld-summary correctness: blocked memory produces reason-coded withheld entries, never partial content.
- Wire into CI as a named suite; failures block merge.

**AC.**
- [ ] Documented corner matrix (~20-30 cases) implemented; all green.
- [ ] Includes: room→DM-non-member block, DM→room block, high-intimacy cross-contact block, public-channel personal-sensitivity block, broadcast-flag approval-token path.
- [ ] Suite listed in CLAUDE.md validation commands on close.

**Anchors.** E0.4 harness; `src/faculties/memory/retrieval/access.ts`; `working_docs/SPRINT_9_MEMORY.md` (metrics list).

---

## E4 — Epic: Social graph minimum viable wiring

**Type:** epic · **Priority:** P2 · **Absorbs:** `psfn-framework-4caj.9`, `psfn-framework-4caj.14` (routing-metadata portion) · **Depends:** E1 (scope), E3.1/E3.4 (envelope + tracking gate); E2 helpful for prompt exposure

**Summary.** Not the grand graph. Four capabilities: who is present (roster), who knows whom / who is related to whom (edges, populated by a background worker in the memory-agent lane), and what shared background exists (linking retrieval). Schema and edge ops already exist (`social-graph.ts`); this epic is population + exposure, gated by envelope and tracking policy.

**Epic AC.** In the live friend room the companion can answer "who's usually here?" and "how do Vega and Iki know each other?" from roster + edges + evidence memories; nothing graph-derived renders in `anonymous`-knowledge or broadcast contexts; untracked speakers never enter the graph.

### E4.1 — Room roster: known-members query and Garden surface

**Type:** feature · **Priority:** P2

**Context.** Presence today = last-5-speakers inference. `ContactChannelActivityRow` (`store/domain-types.ts:17-33`) already records (contact, channel, first/last seen) — the roster is a query away. No join/leave events needed for MVP (Discord presence enrichment later).

**Scope.**
- Store query: known members of channel X ordered by last-seen, with first-seen and activity recency; bounded (cap + pagination — don't load huge contact sets, operator direction).
- Verify write-path coverage: every group message updates the activity row (confirm in session/contact wiring; fix gaps).
- Garden: room detail view listing known members with trust/relationship columns.
- Feeds E3.3's `audienceKnowledge`/`audienceScope` derivation (replace recent-speaker interim).
- Roster is *data*, not prompt content — prompt stays at ≤5 recent speakers (operator constraint); a member-count hint in group core-memory context (E1.2) may cite roster size.

**AC.**
- [ ] Query returns correct membership for harness fixtures incl. members who haven't spoken recently.
- [ ] Activity rows written on every group ingress path (test per channel adapter).
- [ ] Garden room view renders roster; bounded query proven (no full-table contact hydration).
- [ ] Envelope derivation consumes roster size.

**Anchors.** `src/core/contacts/store/domain-types.ts:17-33`; `src/core/contacts/store.ts`; ingress paths `src/channels/discord/adapter.ts:398-422`, telegram equivalent; `src/operator/garden/`.

### E4.2 — Graph-builder worker in the memory-agent lane ("the gremlin")

**Type:** feature · **Priority:** P2 · **Absorbs:** `4caj.9` · **Depends:** E4.1, E3.4

**Context.** Edges today are manual or mention-inferred at extraction time. Ratified approach: a background worker beside sleeptime/extraction — never inline in the chat path — that reads accumulated group evidence and proposes edges.

**Scope.**
- New job in the memory-agent lane on the group-watermark cadence (share E1.6's batching machinery): reads new room-scoped memories + provenance (`sourceSpeakerNames`, `addressMode: overheard_room_context`, `subjectContactId`) since watermark.
- Proposes: (a) `acquaintance`-class edges from repeated co-presence (N co-active sessions threshold, config-owned); (b) typed edges from overheard interactions naming two tracked people; (c) typed **bidirectional** edges from named-relationship facts ("my sister Iki" → sibling both ways), extending `inferRelationshipTypeFromFact` (`mention-only-contacts.ts:30-45`).
- All proposals: confidence 0.5-0.7, `source: 'memory'`, evidence-memory links populated; never overwrite operator-set (`source: 'manual'`) or higher-confidence edges; conflicting proposals surface in Garden for review rather than auto-resolving (fail closed).
- Only tracked contacts participate (E3.4 gate); sensitivity on edges inherited from evidence memory sensitivity (max of sources).
- Garden: proposed-edges review view (approve/adjust/reject) — reuses the graph's existing sensitivity filtering for display.

**Non-goals.** No nightly relationship *trust* review (that's `4caj.4-.8`, later). No inference chains (friend-of-friend). No decay model yet (note as follow-up).

**AC.**
- [ ] Fixture: room transcript with two people repeatedly co-present + one overheard "X is Y's sister" produces exactly the expected proposals with evidence links; re-running from the same watermark produces no duplicates.
- [ ] Operator-set edge survives a conflicting proposal (conflict surfaces in Garden).
- [ ] Untracked speaker in fixtures produces zero graph rows.
- [ ] Worker runs on cadence in live smoke; charge accounted in the existing ledger lane.

**Anchors.** `src/core/contacts/store/social-graph.ts:230-459`; `src/faculties/memory/extraction/mention-only-contacts.ts:30-45`; `src/faculties/memory/types.ts:64-89`; scheduler lane wiring `src/app/agent/scheduler-runtime.ts`.

### E4.3 — Bidirectional consistency and edge hygiene

**Type:** feature · **Priority:** P2 · **Depends:** E4.2

**Context.** Audit: edges are directional-by-record with no symmetry maintenance — A→B "sibling" doesn't imply B→A. Symmetric types (sibling, friend, household, partner, colleague) must be consistent; asymmetric types (parent/child, manager/direct_report) must be *inverse*-consistent.

**Scope.**
- Type-level table: symmetric / inverse-pair / genuinely-directional per `SocialGraphRelationshipType`.
- Upsert enforces: writing a symmetric edge maintains the mirror; writing parent(A→B) maintains child(B→A); confidence/evidence shared.
- One-time hygiene pass over existing edges: report violations; auto-fix unambiguous ones, queue ambiguous for Garden review.
- `mergeSocialGraphForContacts` (`social-graph.ts:536-716`) updated to preserve the invariants through contact merges.

**AC.**
- [ ] Property test: any edge write leaves the graph consistent under the type table.
- [ ] Contact merge preserves consistency (existing merge tests extended).
- [ ] Hygiene report generated; fixes documented on bead close.

**Anchors.** `src/core/contacts/types.ts:8-21,211-223`; `src/core/contacts/store/social-graph.ts:354-459,536-716`.

### E4.4 — Minimal prompt exposure: participant relationships in conversation_state

**Type:** feature · **Priority:** P2 · **Depends:** E4.2, E3.3; E2.1 for macro registration

**Context.** Nothing graph-derived reaches the prompt today; the model sees 5 speakers but not that two of them are siblings. Minimal exposure, hard-capped, envelope-gated.

**Scope.**
- When ≥2 *currently listed* participants (the ≤5 recent set) share a high-confidence (≥ threshold, config-owned) edge whose sensitivity passes the current envelope + trust gates, render compact lines inside `conversation_state`: e.g., `<participant_relationships><rel a="Vega" b="Iki" type="sibling"/></participant_relationships>`.
- Hard caps: ≤5 lines; deterministic selection (confidence desc, then recency); absent entirely when empty.
- Never rendered when `audienceKnowledge: anonymous` or broadcast flag set.
- Bare-value macros registered in the manifest (`runtime_participant_relationships_xml` + count); framing text lives in the runtime layer per purity rule.
- Gating is deterministic pre-prompt (same invariant as memory).

**AC.**
- [ ] Harness: sibling edge between two present participants renders one line; same edge with `intimate` sensitivity in an `invite_only` room with a `public`-trust speaker present does NOT render (gate test — document the chosen gate rule in the contract).
- [ ] Caps enforced; empty case renders nothing (no empty XML shell).
- [ ] Anonymous/broadcast fixtures render nothing.
- [ ] Macro manifest-registered; goldens updated deliberately.

**Anchors.** `runtime-context.ts:613-700`; `config/runtime-prompt-layers.seed.json:30`; `social-graph.ts:461-511` (sensitivity-filtered listing).

### E4.5 — Shared-background retrieval mode (linking memories between two people)

**Type:** feature · **Priority:** P2 · **Depends:** E4.2

**Context.** Retrieval already consumes edges to weight related-contact memories (`retrieval.ts:1910-1949`) but there is no entry point for "what links A and B": shared rooms, co-mentions, overheard interactions, edge evidence.

**Scope.**
- Retrieval mode `sharedBackground(contactA, contactB)`: union of (edge evidence memories) + (memories whose provenance names both) + (room-scoped memories from rooms both are rostered in, relevance-ranked), standard access gates applied for the *asking* context (all six layers — asking in a room ≠ asking in the operator's DM).
- Exposed as: **an action on the canonical `memory` tool** (charter Law 33 — one semantic surface per domain; no new model-facing tool name, no `shared_background` helper registered/discoverable/promotable as its own tool), plus a Garden query view.
- Bounded: top-K with the usual withheld summary.

**AC.**
- [ ] Fixture: A+B share a room, one overheard interaction, one sibling edge with evidence → query returns evidence-ranked set with correct provenance; asking from a low-trust context withholds per policy with reason codes.
- [ ] Exposed as a `memory` tool action only; grep proves no separate model-facing tool name exists (Law 33 check); docs/tool-surface note updated.
- [ ] Bounded + withheld-summary behavior tested.

**Anchors.** `src/faculties/memory/retrieval.ts:168-186,1910-1949`; `src/faculties/memory/retrieval/social.ts`; `src/faculties/memory/tools.ts`.

---

## Absorption and filing notes

| Existing bead | Disposition |
|---|---|
| `psfn-framework-2k8j` (P0 core memory scoping) | absorbed by **E1.2** (close as duplicate w/ pointer, or re-title into it — operator call) |
| `psfn-framework-o1xa` (P0 Loom visibility) | absorbed by **E0.1/E0.2** |
| `psfn-framework-8sow.10` (Loom views, deferred) | absorbed by **E0.1 + E2.3** |
| `psfn-framework-8sow.11` (channel-owned privacy, deferred) | absorbed by **E3.2** |
| `psfn-framework-zet.1` (admin memory sensitivity gating) | absorbed by **E3.5** |
| `psfn-framework-4caj.1` (relationship/trust/privacy contract) | contract portion → **E3.1**; dynamic-trust remainder stays in `4caj` |
| `psfn-framework-4caj.9` (graph edges from group observation) | absorbed by **E4.2** |
| `psfn-framework-4caj.14` (group-room source-speaker routing metadata) | largely already-landed provenance + **E4.2**; verify residue on filing |
| `psfn-framework-4caj.15` (policy-controlled group memory extraction) | related to **E3.4** untracked-speaker rules; cross-link, keep separate |
| `psfn-framework-jhqb`, `qhxv`, `m82u`, `917v` | independent; `m82u` noted as soft dependency of E3.2 |

**Priorities at filing:** E0.*, E1.1-1.3, E2.7 → P0. E1.4-1.6, E1.8, E2.1-2.5, E3.1-3.6 → P1. E1.7, E2.6, E4.* → P2. Epic order is the dependency spine; parallelism within epics per the depends lines.

**Every bead on filing gets:** this doc + plan doc referenced; labels (`group-chat`, `prompt-runtime`, `trust-envelope`, `social-graph`, `cache`, `loom` as applicable); explicit non-goals copied, not linked.
