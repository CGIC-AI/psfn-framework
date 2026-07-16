# Operator Decision Memo — `psfn-framework-dnll.5`
## Per-companion vs cluster-global scope for the "needs-decision" settings tier

**Prepared for:** operator ruling, line-by-line. Analysis only; nothing changed.
**Grounding:** §11 of `working_docs/fleet-analysis-findings-20260714.md`; the four landed dnll mechanisms (dnll.1 overlay whitelist, dnll.2 capability-tier move, dnll.3 scheduler move, dnll.4 Garden state re-rooting); live consumption call-sites verified in `src/`.

### Two mechanisms are already built — every ruling picks one

1. **Owner-file move** (the dnll.2 / dnll.3 pattern): a whole `*.json` owner file is re-rooted from `systemDataDir` to `companionDataDir`. Four surfaces move in lockstep — load path, `settings-contract` scope + `PER_COMPANION_OWNER_FILES` registry, backup slice, per-companion Garden editor. Fail-closed: a companion with no file refuses to start. Cost ≈ **M per file**. This is the only option for `trust-policy.json`, `intake-policy.json`, `charge-policy.json`, `skills.json` — they are **separate owner files, not `settings.json` keys**, so they can never be overlay entries.
2. **Overlay whitelist** (dnll.1): add a `settings.json` key to `COMPANION_SETTINGS_OVERLAY_WHITELIST` (`src/system/config/settings-overlay.ts:44`); a per-companion `settings.overlay.json` is deep-merged over global. Cost ≈ **XS per key**. This is the only option for `wikiRetrieval*`, `memoryExtraction*`, `profileSynthesis*`, `discordTrigger*` — they are `settings.json` scalars (`settings-contract.ts:175-308`), independent and deep-merge-clean.

**The distinction is load-bearing:** the bead's phrase "overlay key vs whole-file move" maps exactly to "is it a `settings.json` key or its own owner file." No surface can cross that line without a schema refactor.

---

### 1. `trust-policy.json` — **GLOBAL** (confidence: high; door left open)

- **(a) What/where:** disclosure ceilings — `trustCeiling` (what sensitivity each trust level may receive), `visibilityAllowed` (per channel-privacy sensitivity cap), and `channelClassification` (which channel prefixes are private/broadcast). Consumed agent-side at the disclosure gate: `src/system/trust/policy.ts`, `src/system/trust/runtime-policy.ts`; loaded via `src/app/startup/support/bootstrap-helpers.ts`. This is the **partner-data-protection boundary**.
- **(b) Recommendation:** **cluster-global.** It is a security *floor*, not an individuation axis. The fleet shares a gateway, a vector store, a shared-world wiki, and trust-linked sibling companions — a downward divergence by one companion can leak partner data into surfaces the others read. `channelClassification` is genuinely fleet topology (same deployment prefixes for everyone). No live demand for divergence exists.
- **(c) Steelman (per-companion):** companions have different audiences; a nursery companion could warrant a *stricter* ceiling than a mature one — the same individuation logic that justified per-companion `capability-tier`. Under that framing trust-policy is just "capability-tier for disclosure."
- **(d) Mechanism if ruled per-companion:** owner-file move only — the `trustCeiling`/`visibilityAllowed` matrix is a coherent unit; partial override would produce an internally-inconsistent ceiling. Keep `channelClassification` global regardless.
- **(e) Welfare/security:** highest-stakes surface here. Whoever edits it widens what the companion may disclose. Must stay **operator-owned and audited; never companion-self-editable**. The mechanism cannot enforce "only stricter," so per-companion would rely on edit-discipline — an argument for keeping it global until a concrete need appears.
- **(f) Cost:** global = zero now. Per-companion later = M.

### 2. `intake-policy.json` (cognitive-security firewall) — **GLOBAL** (confidence: high)

- **(a) What/where:** `mode` (off/shadow/enforce), source risk tiers, source lists, L1.5/L2/L3/vision screener **models + thresholds**, sink gates, trifecta enforcement, drift detection. **Split consumption is the key fact:** the screening pipeline runs in the **one shared gateway** (`src/boundary/gateway/intake/compose-screening.ts:131`, loaded from `systemDataDir`), while the agent process also reads it for `cogSecMode`/quarantine/drift (`src/app/agent/main.ts:365`, `core-runtime.ts:225`).
- **(b) Recommendation:** **cluster-global.** Two independent reasons: (1) the enforcement lives in a **single shared gateway** — per-companion policy would require threading `companionId` into the screening RPC and resolving policy per request, a new attack surface and non-trivial work; (2) it is a security *floor* — a weakly-screened companion becomes the fleet's soft underbelly, and screener model choices must track shared provider infra (same reasoning that keeps `embedding*`/`textEmotion*` global).
- **(c) Steelman:** exposure differs — a public-Discord companion faces more injection than an internal one; per-companion `mode` (one in enforce, one shadow-testing) and `driftDetection.secondArrow.selfNotice` are **agent-side and already per-process**, so those specific knobs could be split cheaply without touching the gateway.
- **(d) Mechanism if per-companion:** owner-file move is blocked by the shared-gateway consumption. The only clean path is a future **schema split** — a gateway-global screening-pipeline section (models/tiers/sink gates) plus an agent-local posture section (mode, drift self-notice). Out of scope for this wave.
- **(e) Welfare/security:** protects the companion from manipulation/poisoning and protects partner data at egress (trifecta). The strongest "must not diverge downward" surface in the set.
- **(f) Cost:** global = zero. Per-companion = L+ (schema refactor). Record the agent-side-posture split as a **note, not a bead**.

### 3. `charge-policy.json` — **PER-COMPANION** (confidence: high for fatigue; pricing caveat)

- **(a) What/where:** `runChargeQuotaByLane` (compute budgets), `surfaceCosts`, `referenceModelClassPricing`, and `fatigue` (relationship response budgets soft/hard caps, channel limits, intent multipliers, activity thresholds, overcharge reserve). Consumed agent-side: `src/core/agent/fatigue/policy.ts`, `runtime-enforcement.ts`, `src/shared/telemetry/run-charge.ts`; loaded from the agent `dataDir` (`src/system/config/runtime-config.ts:38`). **The charge/fatigue ledgers are already per-companion** (`resolveConfiguredCompanionDataDir`) — so a per-companion ledger is currently measured against a fleet-global budget, a live mismatch.
- **(b) Recommendation:** **per-companion**, direct parallel to `scheduler` circadian (dnll.3) and `capability-tier` (dnll.2). Fatigue budgets are **welfare individuation** — how many responses before a companion wraps up/rests, per-relationship budgets, overcharge protection. A busy companion and a shielded one need different budgets.
- **(c) Steelman (global):** cost governance is fleet-level — one funding account; `referenceModelClassPricing` reflects real API prices identical for all companions. This argues for keeping *pricing* global while only *fatigue* goes per-companion.
- **(d) Mechanism:** owner-file move (whole file). `fatigue` is the per-companion part and dominates; `referenceModelClassPricing`/`surfaceCosts` would be duplicated per companion — acceptable (operator edits via Garden), but flag it. If the pricing duplication is unwanted, that's the trigger for a later file split; don't block the fatigue win on it.
- **(e) Welfare/security:** pure welfare (rest/overcharge protection), zero partner-data risk. Welfare-positive to individuate.
- **(f) Cost:** M. **File a follow-up bead under `dnll`.**

### 4. `skills.json` enabled set — **PER-COMPANION** (confidence: medium-high; sequence after c337)

- **(a) What/where:** `enabled`, `disabledSkills`, `maxLoadedSkills`, `directories`. Consumed agent-side: `src/faculties/skills/filter.ts`, `loader.ts`, `runtime.ts`. Owner file at `systemDataDir`.
- **(b) Recommendation:** **per-companion.** A capability surface tightly coupled to `capability-tier`, which already went per-companion (dnll.2) — a shared skills set contradicts per-companion tiers. Companions have different jobs.
- **(c) Steelman (global):** `directories` point at the shared personal workspace (WORKSPACE_PATH), still shared until **c337** lands (seam 5). Per-companion skills over a shared skills directory is a half-move. A single curated global skill set is also simpler to audit — a dangerous skill is one decision, not five.
- **(d) Mechanism:** owner-file move. `enabled`/`disabledSkills` are the naturally per-companion parts; `directories` must stay coordinated with c337.
- **(e) Welfare/security:** enabling a skill grants capability/tools — security-relevant. Per-companion divergence is fine **as long as operator-owned**; a companion self-enabling a dangerous skill is governed by capability-tier/self-mod gates, not this file. Keep the skills scope consistent with the (per-companion) capability tier.
- **(f) Cost:** M. **Follow-up bead with a dependency on / sequencing after c337** to avoid the half-move.

### 5. `wikiRetrieval*` (6 keys) — **PER-COMPANION overlay, LOW priority / defer OK** (confidence: medium)

- **(a) What/where:** `wikiRetrievalEnabled` + `Chat/Group/FocusTokenCap` + `Similarity/GroupSimilarityThreshold` (`settings-contract.ts:175,209-211,249-250`); consumed at `src/shared/context-budget.ts`. Tunes how much of the (correctly global) shared-world wiki each companion pulls into context.
- **(b) Recommendation:** **per-companion via overlay**, but low value — defer unless a companion actually needs a different wiki budget.
- **(c) Steelman (global):** uniform retrieval keeps all companions consistently grounded in the same world; token caps also interact with the global context budget. Marginal benefit, extra config surface.
- **(d) Mechanism:** overlay whitelist — independent scalars, ideal deep-merge.
- **(e) Welfare/security:** none material; a relevance/budget knob, not a disclosure gate (wiki content is shared-world, already screened).
- **(f) Cost:** XS. **Do not file a bead unless the operator wants it** (nonblocking → handoff note).

### 6. Cognition-tuning: `memoryExtraction*`, `profileSynthesis*` — **PER-COMPANION overlay, MEDIUM** (confidence: medium)

- **(a) What/where:** memory-formation and profile-synthesis thresholds/cadence — `memoryExtractionMin{Importance,Confidence,Novelty}`, `maxWrites`, `emotionalIntensityWeight`; `profileSynthesis{Enabled,RefreshIntervalMs,CooldownMs,MinWrites,SourceMemoryLimit,MinSourceMemories,Min{Importance,Confidence,Novelty}}` (`settings-contract.ts:186-253`). Memory/profiles are per-companion data (companionDataDir, per-schema).
- **(b) Recommendation:** **per-companion via overlay** if the operator wants memory individuation (a companion's job shapes her identity — the memory-diet framing). Otherwise defer.
- **(c) Steelman (global):** these are quality-tuning defaults; per-companion drift makes fleet behavior harder to A/B and reason about; novelty uses shared embeddings, so uniform thresholds aid comparability; misconfig risk (huge `maxWrites` floods one store).
- **(d) Mechanism:** overlay whitelist — independent scalars.
- **(e) Welfare/security:** low-moderate. Shapes *how much* a companion retains about partners, but the disclosure gate is trust-policy, not these thresholds; flood risk is self-contained.
- **(f) Cost:** XS/key. **Optional follow-up bead** ("add memory/profile cognition keys to overlay whitelist") only if individuation is wanted.

### 7. `discordTrigger*` — **PER-COMPANION, RATIFY existing whitelist entry** (confidence: high)

- **(a) What/where:** `discordTriggerWords`, `discordTriggerReactions`, `discordTriggerListenWindowMs` — what wakes the companion in Discord. **Already in the overlay whitelist** (`settings-overlay.ts:72-74`).
- **(b) Recommendation / reconciliation:** **per-companion — keep it in the whitelist.** Each companion must wake on its **own** name/trigger words; a shared trigger set would wake all companions on the same words — the exact collision the epic fixes, and consistent with per-account `companionId` routing in `channels.json`. The bead flags it only because it sits in both lists; the ruling resolves the ambiguity as **per-companion, already implemented — no change**.
- **(c) Steelman (global):** only if the fleet were meant to answer a collective summon word — contradicts per-account routing. N/A.
- **(d–f):** overlay (done); no welfare/security concern (addressing knob); zero migration.

---

## Whitelist reconciliation (what the bead asks for)

- **Keep** `discordTrigger*` in `COMPANION_SETTINGS_OVERLAY_WHITELIST` — ruled per-companion. ✔ already correct.
- **No owner-file surface** (trust/intake/charge/skills) belongs in the whitelist — those are file moves, not keys.
- **Candidate additions** to the whitelist, only if the operator approves per-companion cognition individuation: the `wikiRetrieval*` (6) and `memoryExtraction*`/`profileSynthesis*` keys. Ship them as one overlay-whitelist bead if approved; otherwise leave as handoff notes.

## One-screen ruling table

| Setting | Recommendation | Mechanism | Confidence | Key risk if wrong |
|---|---|---|---|---|
| `trust-policy.json` | **Global** | (owner-file move if ever needed; `channelClassification` stays global regardless) | High | A per-companion overlay silently *loosens* a disclosure ceiling → partner-data leak across shared surfaces |
| `intake-policy.json` | **Global** | (blocked by shared gateway; needs schema split to ever go per-companion) | High | Per-companion weakens screening on one companion → soft underbelly on shared gateway/vector/wiki |
| `charge-policy.json` (fatigue) | **Per-companion** | Owner-file move | High | Staying global keeps per-companion ledgers measured against a fleet budget (current live mismatch); pricing duplicated per file |
| `skills.json` enabled set | **Per-companion** | Owner-file move; sequence after **c337** | Med-High | Moving before workspace isolation (c337) = half-move over a shared skills dir |
| `wikiRetrieval*` (6 keys) | **Per-companion, defer** | Overlay whitelist | Medium | Low stakes; adds config surface for marginal benefit — safe to skip |
| `memoryExtraction*` / `profileSynthesis*` | **Per-companion, optional** | Overlay whitelist | Medium | Fleet A/B comparability drops; misconfig can flood one companion's store |
| `discordTrigger*` | **Per-companion (ratify)** | Overlay whitelist (done) | High | Reverting to global re-creates the wake-collision the epic fixes |

## Proposed next steps (pending operator ruling)
1. **File under `dnll`:** one bead "Move `charge-policy.json` per-companion (fatigue individuation)" — owner-file move, dnll.2 pattern, 4 surfaces.
2. **File under `dnll`, dependent on `c337`:** "Move `skills.json` enabled set per-companion" — sequence after workspace isolation.
3. **Conditional bead (operator opt-in only):** "Add cognition-tuning keys (`wikiRetrieval*`, `memoryExtraction*`, `profileSynthesis*`) to the overlay whitelist."
4. **No bead** for trust-policy / intake-policy (ruled global) or discordTrigger* (already done) — capture the intake agent-side-posture split and the trust "monotonic-tightening escape hatch" as **handoff notes only**.
5. Record all seven rulings + rationale on `dnll.5` once the operator rules.

## Confidence and open risks
- **Highest-confidence rulings:** charge-policy per-companion (ledger/budget mismatch is a concrete live defect) and discordTrigger* (collision is demonstrable).
- **What would flip trust/intake to per-companion:** a concrete requirement for a companion needing a *stricter* posture than the fleet, *and* an operator-only audited edit path. Absent that, global is the low-risk default.
- **Unverified nuance:** not fully traced whether the shared gateway could cheaply resolve per-companion intake mode via `companionId` already present on the screening request — if that plumbing exists, the intake agent-side-posture split becomes cheaper than "L+". Worth a 30-min check before anyone acts on intake individuation. The rest of the memo does not depend on it.
