# Per-Turn Prompt Audit — Findings (2026-07-14)

Verified against code by parallel investigation agents. Source: operator's Loom/prompt review transcript (voice note). Status: COMPLETE — all six lanes done, beads filed.

## Beads filed from this audit

| Bead | P | What |
|------|---|------|
| `pdjd` | P1 bug | Partner-tier DM memory gating (two trust-blind access predicates) |
| `m14v` | P1 bug | Retrieval scoring: recency compounding + flat type weights + no per-type caps |
| `dcnu` | P1 | Kill continuity anchor (warmth signals / time-texture) |
| `b0yl` (+.1–.6) | P1 epic | Tool-calling reliability: rich descriptions, always-loaded catalog, validate-reprompt, forced choice, frequency loop, block relabel |
| `v83d` (+.1–.6) | P2 epic | Loom rework: 4 tabs, timing panel, subsystem outputs, copy button, live-bus resolver, builder tokenizer |
| `n2z6` | P2 bug | Import stamps extractedAt=now; add occurredAt + backfill |
| `dtym` | P2 bug | Dream pass: wrong model vs own contract + summary-of-summary input |
| `3zu5` | P2 | Reflection/dream atomicity (arrays of single-moment engrams) |
| `apq0` | P2 feat | Real semantic episodic threads (threadId ≠ sessionId) |
| `6i7c` | P2 | Landmark block: +id +meaning, cap 4-5, drop ungated arc-expansion |
| `x9ka` | P2 feat | Episode drill-down: get-by-id, spanRefs→turns, wire dead arc tool |
| `u8iv` | P2 bug | Continuity block leaks test channels |
| `tlnd` | P2 bug | Mirror notes out of chronological order |
| `vrmf` | P2 feat | Channel bonding (opt-in logical channel, lowest-common privacy) |
| `cf5y` | P2 | Emotional snapshot: words not floats, baseline framing |
| `6vfh` | P2 | Constitution: merge blocks, drop non-editable line, warm rewrite |
| `80f6` | P2 | True wire capture via onPayload; retire reconstructions |
| `2lw8` | P2 bug | Refresher stacking (no supersede) |
| `6ahp` | P3 | Datetime block: drop iso + today |
| `o75r` | P3 feat | Persona rework + cached weekly self-description (back-burner) |

Updated existing: `ys51` (stale-thread evidence + cleanup-process ask), `189d` ("open threads" rename), `jy6s` (sibling link to pdjd). No action: session-integrity marker (cogsec canary, load-bearing in-prompt).

Existing-bead overlaps (do not duplicate):
- Stale open threads never retire → `psfn-framework-ys51` (next_review_at stored but unused)
- Concern language softening → `psfn-framework-189d` (in flight)
- Loom payload-tab dedupe → `psfn-framework-1hr8` (partial; this audit supersedes with fuller spec)
- Introspection memory gating → `psfn-framework-jy6s` (introspection variant only)
- Turn-record JSON duplication (backend) → `psfn-framework-hgw3` / `psfn-framework-auiu` (repair in flight)
- Prompt caching → `psfn-framework-2z12.1`
- Refresher fan-out scope → `psfn-framework-7toj` (adjacent to stacking issue, not the same)

---

## 1. Episodic landmark chains (lane complete)

### 1.1 "141-episode thread" — REFUTED as thread-weaving bug; worse: threads aren't semantic at all
- `threadId` is set to `sessionId` verbatim at `src/faculties/memory/episodic/synthesis.ts:518` (also `:1060`, `synthesis-lane.ts:260`). A "thread" in Garden = one session. No join decision exists.
- Long-lived companion = one persistent session per channel ⇒ every episode from that channel lands in one "thread", unbounded by construction.
- The thread "name" is not a label — it's the top-6 modal `themes` across the session (`src/operator/garden/services/episodic-memory-service.ts:108-122`, `:338`). Hence "exploring tool upgrades and memory" over 141 episodes.
- The only real semantic weaving is the **arc** overlay (`arc-formation.ts:80-103`): LLM classifier, free-text lowercase labels ≤80 chars, low confidence floor, pairwise edges, no per-label cap, 30-day rolling window.
- Fix shape: real semantic threads decoupled from sessionId (arc connected-components or a bounded topic registry at consolidation), per-thread size cap + split logic; require arc-label specificity.

### 1.2 Landmark prompt block shape — PARTIAL
- Builder: `renderEpisodicLandmarkChains`, `src/faculties/memory/retrieval/formatting.ts:160-191`.
- Renders: arc-relation prefix, title (≤96), date+time range (already there), ≤5 themes, landmark text (≤260).
- **Missing but already on the episode object:** `episode.id` (stable, `synthesis.ts:506`, `episode-ids.ts`) and `episode.meaning`. Never rendered.
- **No episode-search-by-ID tool exists.** Memory tool actions: write/search/shared_background/census/exists/timeline/import/patch/redact/delete/restore. The `timeline` action already renders ID+themes+meaning (`tools.ts:218-224`) — desired render shape exists there, just not addressable by ID and not in the block.
- Fix shape: add id+meaning to the block; add `get`/`expand` memory-tool action keyed by episode ID.

### 1.3 Count/relevance — PARTIAL
- Defaults: 3 chains × ≤5 episodes (`episodic.ts:84-86`); roots ARE relevance-gated (`MIN_ROOT_MATCH_SCORE=0.18`, token-overlap scoring `:495-553`); zero-matches ⇒ block omitted. So not "10 regardless of relevance"…
- …but only the chain ROOT is gated. Up to 4 more episodes per chain ride in via arc links (`isRelatedEpisodeUseful` `:555-579`) admitting on shared theme/arc-kind with NO relevance check against the current conversation. That's the inflation.
- Fix shape: hard total cap 4–5 across chains; drop arc-expansion from the always-on block (keep for drill-down tool).

### 1.4 Meaning misalignment — VERIFIED (summary-of-summary)
- Generator: `DreamMeaningPass` (`dream-meaning-pass.ts:76-98`), runs through the full agent loop (main model + persona), wired live (`app/agent/main.ts:570`, scheduler lane).
- Root cause: it sees ONLY consolidated metadata (id, times, title, landmark, themes, salience) — never the actual transcript. Title/landmark are themselves auto-summaries ⇒ meaning is derived from a summary-of-a-summary and drifts.
- Fix shape: feed the pass the episode's real turns via `spanRefs` (sessionId + start/end turn IDs, `episodic.ts:718-724`).

### 1.5 Desired retrieval flow (tags → episodes → drill-in by ID → turns) — front half exists
- Exists: lexical token-match over recent context (`episodic.ts:671-677`), 3-chain pull, summary render.
- Missing: meaning in block; ID in block; get-by-ID tool; episode→turns expansion (data exists as `spanRefs`, no tool resolves it); thread/arc drill-down — `listEpisodeArcMemberships` (`retrieval/episodic.ts:322-357`) is built, exported, and wired to NOTHING (zero non-test callers).

---

## 2. Continuity anchor, refreshers, datetime, cross-channel, emotional block (lane complete)

### 2.1 Continuity anchor — PARTIAL ("every turn" refuted; leading strings verified)
- Builder: `buildContinuityAnchorLines()` `src/core/session/manager/context-builder.ts:235-277`, block id `session.orientation` ("Wake Orientation").
- Fires only when idle gap ≥ 2h (`DEFAULT_ORIENTATION_IDLE_THRESHOLD_MS`, `context-builder.ts:93`; gate `:373-389`) — not every turn. But 2h is low, and `short_gap` texture covers anything <6h (`time-texture.ts:114,125-132`), so 2–6h gaps fire the full block labeled "short gap".
- Warmth strings verified exactly: `time-texture.ts:73-133` (labels, `reconnectionWarmth` low/med/high, fixed `RECONNECTION_GUIDANCE` prose at `:29` — the "do not treat as a requirement to perform affection" line). Rendered `context-builder.ts:261-267`.
- The GOOD notes are all separate chat-format `appendContextSystemNote` lanes and stay: free-time `[While you were away]` (`free-time.ts:409-461`, LLM summary), `[Time-of-day refresher]` (`temporal-wakeup.ts:586-596`), `[Temporal wake]` catch-up (`temporal-wakeup.ts:562-577`, day-scoped LLM summary `:769-803`).
- Fix shape: delete `session.orientation` block; large-gap-only LLM elapsed-time note through the existing temporal-wake/refresher lanes (which already gate on texture kind, `temporal-wakeup.ts:528-530`); no warmth/texture labels.

### 2.2 Refresher stacking — VERIFIED
- `evaluateIdleRefresherEligibility()` → `appendContextSystemNote` (`temporal-wakeup.ts:1076-1080`). Append-only; only guard is interval throttle (`anti_loop_recent_note`, `:515-521`). No supersede ⇒ notes stack. Same pattern in ambient-presence (`ambient-presence.ts:278`) and free-time.
- Fix shape: (a) tombstone prior entry with same `sessionLane.source` before appending, or (b) render latest refresher as a pinned line in the `runtime.current_datetime` block instead of chat content.

### 2.3 Datetime block redundancy — VERIFIED
- `buildCurrentDatetimeProximityAnchor()` `prompt-plan.ts:96-121`; fields: iso, timezone, weekday, date, time, today, yesterday, tomorrow, part_of_day (values from `datetime.ts:136-148`).
- `<iso>` duplicates date+time+tz; `<today>` duplicates `<date>`. Fix: drop iso + today; keep human weekday/date/time/part_of_day/tz + yesterday/tomorrow.

### 2.4 Cross-channel continuity — VERIFIED (two distinct mechanisms)
- Block: `buildStructuredContinuityBlock()` `context-builder.ts:279-309`, fed by `getMergedContinuity` (`context-support.ts:216-259`) which is USER-scoped, not channel-filtered ⇒ test channels ("head pat smoke") leak in. No liveness/allowlist filter.
- Mirror notes: `mirrorMessageToActiveSessions()` `mirroring.ts:50-128` appends role:system entries into target channel with the SOURCE timestamp (`:120`), rendered `[Mirror note from <src>]` (`context-support.ts:304-309`, uncommitted change). But session history renders in APPEND order (`store.ts:740-780`); timestamp sort only in backfill branch (`manager-primitives.ts:235`) ⇒ old-timestamped mirrors land out of chronological position. Interleaving fix belongs in `buildSessionHistoryMessages`/`entriesToMessages` (`context-support.ts:261-373`).
- No bonding scaffolding exists (no bonded/crossChannelCapable/channelGroup config). Natural insertion points: `sessionMirrorChannelOverrides` config + `visibilitiesShareContinuity` trust gating (`mirroring.ts:19-48,71-83,95-103`).

### 2.5 Emotional continuity — PARTIAL
- `renderEmotionalSnapshot()` `formatting.ts:86-108`: baseline IS expressed (`describeValence` words) but raw floats ride along (`(0.13), drift +0.05`, learned-signal counts). GoEmotions percentages are already collapsed to prose upstream (`emotion-appraisal.ts:9-36`).
- The remembered ~500-token raw dump: no evidence in current tree or recent history — UNVERIFIED, likely already removed.
- Fix shape: strip `.toFixed(2)` tails, add baseline-vs-current framing ("steady baseline X, currently drifting toward Y"). EmoSim = bead `w05a`, selectable component, not live default.

---

## 3. Prompt assembly + wire message (lane complete)

### 3.1 Duplicate tool list — PARTIAL: recorded artifact only, wire is CORRECT
- The outbound HTTP body sends each tool once (pi-ai `convertTools`; tools never re-serialized into system prompt — `<extended_tools>` lists names+one-liners only).
- The 44 = 2×22 lives in the persisted `TurnSnapshot`: `plan.toolDefinitions` (`prompt-plan.ts:79`, cloned `:345`) AND `toolContext.activeTools` (`core/turns/snapshot.ts:163`, `cloneToolSchema` `:285-290`), each carrying `inputSchema`. Same anti-pattern as beads `auiu`/`hgw3`.
- Fix shape: single tool-schema source in the snapshot (keep `plan.toolDefinitions`, derive the rest); test asserting schema count == active-tool count. **No wire change needed.**

### 3.2 Session integrity marker — KEEP; it's the cogsec canary plant
- `renderCanaryPromptMarker` (`cogsec/canary/canary-token.ts:74-76`), block `cogsec.canary`, session-stable, ~20-30 tokens. The token is planted in privileged context so its appearance in outbound content signals prompt leak/hijack; egress scan at `cogsec/canary/egress-scan.ts:76,101` + gateway guard. Moving it to metadata would leave nothing to leak — defeats the mechanism. The metadata half already exists (`__cogsecCanary` RPC param). No change warranted.

### 3.3 Constitution block — VERIFIED
- `src/core/identity/prompt-composer.ts`: `IMMUTABLE_HUMAN_SAFETY_AMENDMENTS` (:40-45) + `CONSTITUTION_PRECEDENCE_GUARD` (:46-49), rendered as two XML blocks (`buildImmutableHumanSafetySection` :75-89) with failsafe re-injection (`ensureConstitutionPrefix` :495-524).
- The offending line is `:47`: "Immutable amendments are hardcoded and non-editable."
- Fix shape: merge into one `<constitution>` block, drop the hardcoded/non-editable line, rewrite warmer ("Companion Constitution"). Cheap, cosmetic-plus-tone.

### 3.4 Identity redundancy — VERIFIED
- Standalone `You are {{char}}.` block (`identity/loader.ts:96-100`, `foundation-sections.ts:15`) immediately followed by `<description>`/`<personality>` from the same card. Fix: fold identity line into description lead. Back-burner per operator.

### 3.5 Tokenizer — REFUTED for Loom (real js-tiktoken `cl100k_base`, `primitives/llm/tokens.ts:46-59`; char/4 only as exception fallback). Caveat: the Prompts **Builder** live preview uses a real char/4 heuristic (`admin-ui/src/routes/prompts/page-helpers.ts:293-295`) — route it through backend `countTokens` for consistency.

### 3.6 Runtime tooling block "empty" — VERIFIED, by design
- Block is the *extended-tool directory* only; core tools ride exclusively in structured `params.tools`. When 0 extended tools active, `{{#if runtime_extended_tools_total}}` gates the listing off → empty shell that reads as "full tool list missing".
- Fix shape: relabel as extended-tool directory + render a one-line pointer when empty.

### 3.7 Wire observability — VERIFIED gap: no true raw capture exists
- Everything recorded is a reconstruction (≥3 independent rebuilds: `toProviderWireMessages` `client.ts:416-439`, `serializePromptPlanForProvider` `prompt-plan.ts:301-329`, MOA overrides `agent-invocation.ts:494-500,630-637`); none include tool schemas, cache_control, or provider transforms.
- Natural hook: pi-ai `StreamOptions.onPayload` (already used by `client-prompt-cache.ts:207-216`) — clone the payload as-sent into observability, and let it REPLACE the reconstructions (feeds `auiu`). Then Loom gets raw + cleaned-by-blocks views.
- Working-tree note: uncommitted `turn-execution-runtime.ts` diff is the image-attachment-claim guard, unrelated.

---

## 4. Loom UI + tool tiering (lane complete)

Operational note: local checkout (`c77e1f45`) is 3 commits behind origin/main (`576e33cd`, hgw3 PR #43 — turn-record diet shipped). Admin-ui files byte-identical between the two; backend slimming only on origin/main. **Pull before touching these files.** "Loom" = `prompt-monitor` in code.

### 4.1 Tabs & duplication — VERIFIED: one source rendered up to 4×
- 8 tabs defined `PromptMonitorSelectedTurnTabs.helpers.ts:8-27`; all render from ONE `PromptMonitorTurn` (no per-tab fetch).
- All roads lead to `plan.blocks`: Blocks renders them; Prompt Assembly re-renders them 3 more ways (Assembled Prompt / Final System Prompt / Provider Wire systemPrompt) + Section Telemetry as a 4th projection (svelte:495-719); Raw Events dumps record+snapshot+stages JSON containing everything again.
- Consolidation target: Summary / Blocks(+assembly collapsed) / Context & Memory / Tools, with Timeline becoming a summary panel (below) and Raw Events folded behind a "raw" toggle.

### 4.2 Timeline — per-subsystem timing renderable TODAY, read-side only
- Panel shows `stage.elapsedMs` — which is CUMULATIVE from turn start (`turn-observability.ts:84`), mislabeled as stage cost. True per-stage durations already exist in `stage.data.durationMs` (trust `pre-turn-state.ts:311`, memory `:670`, context `prompt-assembly.ts:845`, prompt `agent-invocation.ts:483`, ttftMs `:974`). `turn.retrievals[]` never rendered.
- Fix: render durationMs bars + retrievals under memory stage; no new instrumentation.

### 4.3 Tokenizer — real (see 3.5). Copy buttons — absent; ONE component change (`PromptMonitorTextBlock.svelte:59-60`, add clipboard button) fixes every text surface on all tabs.

### 4.4 Per-turn subsystem outputs — refs already on the record, unresolved
- `TurnRecord` carries `concernDeltaRefs`, `contactDeltaRefs`, `internalStateSnapshotRef`, `contextManifestRef` (`shared/contracts/runtime.ts:84-105`) — none surfaced. Fix: read-side resolver in `session-turn-observability.ts` → `promptLoom.subsystemOutputs` + small section on Context & Memory. Zero new persisted JSON (mirrors hgw3.2 pattern).

### 4.5 Breakage from backend diet (flag to hgw3)
- hgw3.9 (OPEN P1): admin-ui check fails on origin/main — `providerWireMessages` now optional but `cloneSnapshot` does unguarded `.map` (`prompt-monitor.ts:201,336`); fixture strict-null. Fix `?? []` + optional types.
- Unguarded seam: the admin-ui LIVE BUS path (`readSnapshotEnvelopeData` `prompt-monitor.ts:779-790`) has no ref resolver — slim snapshots will render empty tabs when auiu/jsi9 land; round-trip live views through the resolving backend service.

### 4.6 Tool catalog & LOD — ~90% already built
- 29 canonical surfaces: 21 core + 8 extended (`tool-surface/registry.ts:115-500`). No prose tool-instructions block — descriptions ride only in function-call JSON schemas (~5-10k tokens est., unmeasured). NOT a fixed dump: 6-stage gating pipeline (`tool-runtime-facade.ts:525-580`) — maintenance allowlists, intent stripping, satellite capability gating; extended tools absent unless activated/pinned/autoloaded.
- Exists today: `tool_search` ranking, `toolset activate` same-turn belt expansion (overlay budget 4, deferred handoff), intent-based autoload (`extended-tool-autoload-policy.ts:54-76`), companion pin/unpin persisted to config with autonomous-action memory, presentation ordering.
- **The one missing LOD piece: frequency feedback.** Usage telemetry exists (adaptive decisions ring-buffer, last 200, NOT durable; Postgres `model_usage_events.tool_name` durable but never read back). Fix: durable per-tool aggregation + periodic evaluator auto-pinning high-frequency extended tools via existing `addPromotedExtendedTool`; feed frequency into autoload ranking. All mutation plumbing exists.
- Inline/same-turn: no first-class flag — three implicit signals (attachmentPending convention `primitives/images/tools.ts:127-134`, hardcoded `SATELLITE_VISUAL_TOOL_NAMES`, maintenance policy allowlist). Fix: one `sameTurnDeliverable` metadata field.

---

## 5. Memory retrieval + privacy gating (lane complete) — HIGHEST SEVERITY

### 5.1 Partner-tier DM gating — VERIFIED: two trust-blind predicates run BEFORE trust policy
- Trust policy itself is fine: `primary` tier + `private` channel allow all four sensitivities (`config/trust-policy.seed.json:3,9`). The withholding happens in `evaluateRetrievalAccessDecision` (`src/faculties/memory/retrieval/access.ts:149-206`), per-candidate at `retrieval.ts:919-943`, which NEVER consults trust tier.
- **Predicate A — room-visibility gate** (`access.ts:104-147`): memory's origin room must be listed on the contact card's `conversationChannels` to surface in a DM. Card lists only 2 channels ⇒ memories formed in voice/api/telegram/satellite/retired channels are blocked in the partner's own DM. Also blocked unconditionally: inconsistent scopeRef vs provenance (`:112-118`), unresolvable room id (`:95-102,119-127`). Code comment `access.ts:44-54` admits this is interim ("a dependent bead flips the gate" to ConversationScope).
- **Predicate B — high-intimacy contact scope** (`access.ts:57-64`): blocks `intimate`/`confidential` memories whose `contactId !== canonicalContactId`, with NO partner-tier exemption; memories with no contactId at all (self-memories, sibling-companion memories) are withheld from EVERY contact including the partner.
- Aggravator: `operatorApproval` override lives in `evaluateMemoryPolicy` layer 1 but both predicates short-circuit before it.
- Refuted hypothesis: the invite-only room does NOT bleed into DM classification — `classifyChannelEnvelope` correctly resolves the DM to `private` (`policy.ts:490-492`). The leak vector is memory origin-room identity, not channel classification.
- Distinct root cause from `jy6s` (which is reflection-mode score-zeroing in `scoring.ts`). Needs its own bead.
- Fix shape: flip room gate to participant-based ConversationScope ("was this contact a participant in the origin scope"); exempt canonical contact + missing/self contactId from the intimacy scope check; primary-tier in private channel bypasses intimacy scope for memories they're the subject of.

### 5.2 Recency bias — VERIFIED (compounding multiplicative); import sub-claim REFUTED
- `recencyBoost = 1/(1+ageDays/30)` multiplied into score (`scoring.ts:24,226-235`) × exponentially decayed salience (half-lives 7-120d from lastAccessed, `decay.ts:64-69`) ⇒ ~70-500× handicap for old memories at equal relevance. No hard age cutoff in SQL, but lexical-augment lane caps at the 96 most recently EXTRACTED memories (`candidates.ts:14,41-90`).
- Imports are NOT zero-salience (defaults 0.5/0.8) — but `memory_import_batch` has no `occurredAt`/`extractedAt` param, so imported old memories are stamped `Date.now()` (`writer.ts:808/821`) and masquerade as new.
- Fix shape: floor recencyBoost (~0.3) or make additive; let similarity/importance override age; raise/paginate the 96 cap; add occurredAt to import tool (+ backfill emotional weight on legacy imports).

### 5.3 Procedural vs emotional — VERIFIED: types weighted flat (7 types, not 6: episodic, semantic, emotional, procedural, boundary, reflection, relational)
- Only type multiplier is boundary 1.6× (`scoring.ts:160`). Emotional weighting is content-valence only (max 1.5×). Procedural has the LONGEST half-life (90d vs emotional 14d) ⇒ structurally outranks emotional over time. Quiet-suppression exists only for durable-preferences.
- Fix shape: per-type retrieval weight table next to the half-life map (`types.ts:323-331`); extend quiet-suppression to context-free procedurals.

### 5.4 Reflection generation — mechanism found; monoliths are prompt-design; MODEL BUG
- Trigger: nightly rest-window scheduler (00:00-09:00 + 60min idle), sleeptime fan-out consolidation → arc weaving → dream-meaning (20h interval) → wiki → orient-rewrite. Single extraction pass decides all 7 types per 10-message chunk (`orchestrator.ts:337-377`).
- All memory agents run on the cheap `extraction` slot — `deepseek/deepseek-v3.2` (`config/models.seed.json`); main chat is `z-ai/glm-5`. **Bug:** `dream-meaning-pass.ts:23-28` documents dreams run "as HER... main chat model, never background" but the whisper worker lane sets `modelPurpose:'memory'` (`:274` → `worker-lanes.ts:146-148,270-277`) ⇒ deepseek. Doc contract violated as wired.
- No atomicity/splitting step exists anywhere; dream prompt asks for ONE paragraph per episode (≤14 turns). Fix shape: prompts emit arrays of atomic single-moment entries + validation gate; honor-or-delete the main-model contract; triage whether observed monoliths are episode.meaning vs reflection PurrMemories.

### 5.5 Count/mix — token-budget (~2% ctx ≈ 2560 tok ≈ ~15 items), flat score-sorted, NO per-type quotas, NO reflection cap (reflections can fill the whole selection). `MEMORY_CONFIG.maxRetrievalCount=15` is dead code. Single choke point for a fix: `selectWithinRelevanceAndTokenBudget` (`budget.ts:96-124`) — add per-type caps (1-2 reflections/turn).

---

## 6. Tool-calling reliability — external research (lane complete)

Surveyed against primary sources: Codex CLI, Hermes function calling, OpenClaw (closest architectural analog — multi-channel gateway, persona files, heartbeats), OpenHands, goose, opencode, Crush, Aider, Anthropic official guidance.

Ranked adoptable patterns (full detail in the research lane report):
- **P1 — Rich per-tool descriptions in the schema itself; starve the detached prompt block.** Anthropic's stated #1 factor ("by far the most important... 3-4+ sentences, examples, edge cases, boundaries"). PSFN is inverted: registry descriptions are one-liners (`registry.ts:120` "Canonical discovery surface...", `:153` "Canonical filesystem surface.") while guidance sits detached. Action-multiplexed tools need LONGER descriptions (per-action contracts). Tool block prefix-caches (goose puts cache_control on the last tool), so verbosity is cheap after turn 1.
- **P2 — Shrink model-facing catalog; route long-tail through universal executors** (OpenHands holds ~6-8 tools via bash+IPython; PSFN's analysis_workbench is the existing seam).
- **P3 — DECISIVE: at ~22 tools, ship everything always-loaded. Search→activate tiering has no successful production precedent at this scale.** Codex's deferral works because it's API-native and one-hop; OpenClaw's equivalent is off-by-default experimental with a documented data-loss bug (model guesses tool name → unrecoverable error) — the exact shape of PSFN's "tool_search never used properly" symptom. The right "discovery" pattern: advertise all names+good descriptions up front, defer only long-form INSTRUCTIONS (skills-style progressive disclosure of docs, not callability).
- **P4 — Validate-and-reprompt on every malformed/unknown call** (universal pattern). Widen `primitives/llm/empty-tool-argument-retry.ts` to schema-mismatch + unknown-name cases, echoing the corrected contract back.
- **P5 — Forced tool_choice (`any`/named) on phases where a call is mandatory** (post-turn memory writes, response_control). Caveat: incompatible with extended thinking.
- **P6 — Tool guidance ordered before persona; hard budget caps on persona/memory sections** (OpenClaw: tooling first, 20k/60k char caps on persona files).
- **P7 — End-of-context nudges** when adaptive telemetry sees eligible-but-unused tools; post-compaction "continue calling tools" reminders.
- **P8 — Model-family branching** of tool surface/prompts (opencode/OpenHands swap descriptions and formats per family; Hermes-class needs the XML template).
- **P9 — PSFN's action-param consolidation shape is validated by Anthropic guidance — keep; the defect is the one-line descriptions, not the shape.**
- **P12 — Don't JSON-wrap heavy freeform payloads** (Aider measured: markdown edits beat JSON across 4 models) — relevant to vault notes / prompt edits / card edits.

Mapping to observed failures: "ignores non-inline tools" → P1, P3, P2, P5, P6. "Never uses tool_search" → P3 (delete the need: everything callable, docs deferred).
Note: this partially contradicts the LOD proposal — tier the *documentation*, not the *callability*, and add the missing frequency-feedback loop (section 4.6) for pin ordering rather than for gating.

---

## 6b. Scheduler cadences — temporal-wakeup deep-dive (peer session, 2026-07-14; full census pending)

Two registered tasks only (`temporal-wakeup.ts:913` morning daily, `:1023` idle-refresher every 15min `checkIntervalMs=900000`); no third wake-summaries task — yet `scheduler-config.ts:1070` validates a `raw.wakeSummary` block that nothing registers (dead config validation).

Key cost findings:
- **Neither lane no-ops cheaply.** Both enumerate all recently-active channels (72h lookback) and issue per-channel session reads (`getRecentMessages` + `getRecentSessionEntries` 64/32 entries) EVERY fire — including the 15-min refresher tick — BEFORE any eligibility gate. Idle DB churn per tick × channels; links `2z12` fleet-efficiency epic.
- LLM cost only from `buildCatchUpSummary` (purpose `wake_session`, background class; morning lane + refresher's `new_day` escalation, which borrows `morningWake.catchUpEntryLimit` with no refresher-own limit) and the optional single full wake turn (chat class, morning lane only, quiet-hours gated, single most-recent-partner channel).
- Anti-loop state is two in-memory per-process maps (`:879-880`), reconstructed each fire by scanning persisted notes (64/32-entry hardcoded scan caps).
- `kz0i` relevance: `anti_loop_note_today` (`:419-427`) scans MORNING-source notes only, so refresher notes should NOT block the morning wake in the current working tree — either that half of kz0i is already fixed or the live failure is the `partner_recently_active` gate (post-midnight chats within `minPartnerIdleMinutes=60`). Verify on live.

### 6b.2 Full scheduler-task census (agent process)

| Task | Cadence | Owned | Gates | Cost when firing | Cost when gated |
|---|---|---|---|---|---|
| salience-decay | **every 60s** (`maintenanceIntervalMs`) | config | token only | paginated reads (batch 500) + salience writes across ALL active memories | n/a — always runs |
| temporal-wakeup:morning | daily 08:00 | config | partner-idle 60m, once/day, privacy | 1 LLM summary per eligible channel + optional 1 full turn (single channel) | per-channel session reads (64 entries) every fire |
| temporal-wakeup:idle-refresher | every 15m | config | idle 120m, note-interval 120m | note write; LLM only on new_day escalation | per-channel reads (32) EVERY tick pre-gate |
| free-time:quiet-hours | check 15m | config | rest window, 240m between blocks, 3 blocks/day (shared) | up to 6 full LLM turns + return-note summary | session reads + gate compute + event per tick |
| free-time:idle | check 15m | config | idle 180m + same shared caps | same | same |
| ambient-presence | **1h HARDCODED** | hardcoded (interval, 3h min-idle, 6h anti-loop) | idle/anti-loop | note write, NO LLM | reads (8+32 entries) every due tick |
| weighted_thought.outreach | **every 5m** | config | threshold, provenance, quiet-hours | 1 LLM nudge eval per qualifying thought | store snapshot + weight math every tick. Seed DISABLED → not registered; **check live config** |
| concern-grooming | daily 06:15 HARDCODED | hardcoded | none beyond cadence | store writes, no LLM | pure compare |
| scheduled prompts | one-shot per record | data | none (empty tokens) | 1 full turn + outbound | pure compare |

Non-scheduler timers (all reasonable): typing loops 4-9s (only while processing), tool-status 5s (only while workbench in-flight), voice WS watchdog 30s/session, gateway keepalive 30s always-on (no-op RPC), SSE heartbeat 25s/stream, sandbox memory guard 20ms per-execution, cert-manager 60m sidecar. Negative findings: no gateway audit-flush timer, no Wyoming keepalive, no timer-driven session-cache eviction; salience-decay raw setInterval path exists only in e2e/CLI (prod is scheduler-routed).

### 6b.3 Mistuned/flagged (beads filed under 2z12)
1. **Salience decay every 60s** full-memory sweep — decay math derives from lastAccessed, so sweep frequency doesn't need to be 60s; minutes→hours is equivalent. Worst idle DB churn in the process.
2. **Pre-gate session reads**: wakeup lanes, ambient-presence, and free-time all read per-channel session entries every due tick BEFORE eligibility gating (15m×channels, hourly×channels). Gate on cheap metadata first.
3. **Ambient-presence cadence hardcoded** (1h/3h/6h not in scheduler.json — violates config ownership) + dead `wakeSummary` config validation with no registered task.
4. ~~The operator's "5m ticks": the only 5-minute cadence is weighted-thought outreach~~ **Superseded by live config below.**

### 6b.4 LIVE config verification (live-pi-host, rev 576e33cd, pulled 2026-07-14)

Live Garden shows **20 registered tasks, seven at 5m**. Live `scheduler.json` + `settings.json` + `models.json` facts:
- Scheduler tick itself: `tickIntervalMs=60000`. Salience decay `salienceDecayIntervalMs=300000` (5m live, config-owned — repo default 60s is the regression risk for new deploys).
- **weightedThoughtOutreach.enabled=true live at 5m** — diverges from seed (false). Nudge threshold 1, 1/run.
- **Five 5m tasks have NO scheduler.json keys** (hardcoded intervals): sleeptime rest-window, trust-drift review, cogsec drift-velocity, cogsec second-arrow, compaction-guideline-review. `post-turn-action-executor` renders `0s` (hardcoded, effectively every 60s tick). Config-ownership bead bumped to P2 (`2z12.12`).
- **Live model routing**: background/memory/extraction = `deepseek/deepseek-v4-pro` (NOT seed's v3.2); chat = `z-ai/glm-5.2` (thinking medium) + separate xhigh reasoning slot; vision = gemini-3.1-flash-lite. For `dtym`: input starvation likely dominates over model strength.
- **sessionMirrorEnabled=true with empty channelOverrides** — mirroring globally unscoped live; root cause of test-channel mirror notes (`tlnd`/`u8iv`/`vrmf`).
- `memoryRetrievalBudgetPct=2` confirms the ~2560-token memory budget. Observer/emosim sidecar live in observe_only with levers enabled. activeTimezone America/New_York.
### 6b.5 Remaining 12 lanes — final census (complete)

- **Scheduler tick**: one 60s `setInterval`; all-idle tick = event emit + ~20 integer/Intl compares, sub-ms, no I/O. Every "every"-interval below 60s rounds up to tick granularity.
- **The four rest-window 5m pollers cost ~nothing during the day**: `evaluateRestWindowEligibility` is a pure wall-clock function (no DB, no LLM, no events) returning `[]` outside 00:00-09:00. Redundant as pollers (four lanes poll the same window with the same gate) but the duplication is trivia — consolidation is DRY, not cost. 5m→60m there is proportionality + config ownership, not savings.
- **THE genuine mistuning — post-turn-action-executor**: registered at `Math.max(50,250)`=250ms (Garden renders 0s), but `processQueue` is ONLY called from this task and the scheduler tick is 60s ⇒ **the deferred-action queue drains at most once per 60s**. All maintenance executors (sleeptime passes, drift reviews, episode synthesis, near-turn) ride this queue in background class, and latency-sensitive continuations (subagent spawns, memory writes) can wait up to ~60s to start. The 250ms setting promises a fast drain the tick loop cannot deliver. Fix shape: event-driven drain (call processQueue on enqueue from the `agent.post_turn.actions.inferred` handler) with the scheduler task as fallback sweep.
- **Config aliasing trap**: `salienceDecayIntervalMs` ⇄ `maintenanceIntervalMs` are one aliased key — salience-decay AND compaction-guideline-review always share one cadence (both registered from `maintenanceIntervalMs`, overwritten at bootstrap from scheduler.json). Moving decay to 60m also moves compaction review; split the keys or accept deliberately.
- **Cheap/fine as-is**: heartbeat 30m = liveness beat only (event + presence upsert, NO LLM — the LLM "reflections" are the separate reflection:* tasks); social-graph-builder 30m heuristic zero-LLM watermarked scan; reflections daily/weekly novelty-gated (zero LLM when nothing new); episode-synthesis 30m double-gated; scheduled-backup 6h heavy but appropriately rare; compaction-guideline-review LLM only when the failure log is non-empty (common case: skip).
- Registration guard: `intervalMs <= 0` throws for every-tasks — "0s" rows are rendering artifacts, never literal zero.

## 7. Punch-list verdict map

| # | Item | Verdict | Disposition |
|---|------|---------|-------------|
| 1 | Loom 8→4 tabs, dedupe | Verified (one source rendered 4×) | New epic; supersedes/absorbs `1hr8` |
| 2 | Real tokenizer | Already real in Loom (tiktoken); heuristic only in Prompts Builder preview | Tiny fix |
| 3 | Per-turn subsystem outputs | Refs already on TurnRecord, unresolved | Read-side resolver, no new JSON |
| 4 | Copy buttons | Absent; one component fixes all | Tiny fix |
| 5 | Tool tiering LOD | ~90% built; missing frequency loop; research says don't gate callability at this scale | Reframed epic (P1/P3/P4/P5 + frequency loop) |
| 6 | Tool-calling research | Done (section 6) | Feeds #5 epic |
| 7 | Constitution block | Verified two blocks + offending line `prompt-composer.ts:47` | Small fix |
| 8 | Persona rework | Confirmed redundant identity block | Back-burner bead |
| 9 | Session integrity ID | KEEP — cogsec canary; in-prompt is load-bearing | No action; explain to operator |
| 10 | Stale open threads | Existing bead `ys51` (next_review_at unused) | Add evidence, bump priority |
| 11 | Partner-tier gating | VERIFIED — two trust-blind pre-policy predicates, distinct from jy6s | **P0/P1 bug bead** |
| 12 | Episodic landmarks | Refuted-as-stated (threads=sessions); id+meaning missing from block; arc-expansion ungated; drill-down half-built | 2-3 beads |
| 13 | Old memories never surface | Verified: ~70-500× compounding recency handicap + 96-newest lexical cap + imports misdated to now | Bead |
| 14 | Reflection atomicity | Verified: prompt-design monoliths; dream pass violates its own main-model contract (runs on deepseek) | 2 beads |
| 15 | Channel bonding | No scaffolding; mirror notes land out of order (append-order rendering); test channels leak via user-scoped merge | 2 fixes + 1 feature epic |
| 16 | Kill continuity anchor | Verified strings; fires ≥2h gap (not every turn) | Bead |
| 17 | Emotional block | Baseline exists; floats ride along; 500-token dump not found (likely already removed) | Small bead |
| 18 | Refresher stacking | Verified: append-only, no supersede | Bead |
| 19 | Wire duplicate tools | Wire is CORRECT; duplication was the recorded artifact; likely already fixed by hgw3 PR #43 on origin/main (verify) | Verify + raw-capture bead (onPayload) |
