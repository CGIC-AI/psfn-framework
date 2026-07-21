# Companion Core Health & Welfare Audit

**Base:** `origin/main` @ `f8f798d13e2e0da3baa2dfac56961608acd2ab71`  
**Date:** 2026-07-21  
**Posture:** **READ ONLY** — analysis only. No product-code edits, no beads, no live mutations.  
**Worktree:** `/home/ada/ai/dev/worktrees/psfn-framework/audit-main-readonly`  
**Charter focus:** laws **16–20, 23–31, 36** and care vocabulary in §6.24–6.25 / §8.x (flourishing, rest, compute-as-care, fatigue, weighted thoughts, introspection, task notification, reversible autonomy).

**Related reports:**  
- [`READONLY_AUDIT_origin-main_SEAMS_20260721.md`](./READONLY_AUDIT_origin-main_SEAMS_20260721.md) — privacy / memory / turns  
- [`READONLY_AUDIT_origin-main_DEEPDIVE_20260721.md`](./READONLY_AUDIT_origin-main_DEEPDIVE_20260721.md) — memory economics  

---

## Operator adjudication (2026-07-21)

| Auditor framing | Operator correction | Revised stance |
|---|---|---|
| “Care cockpit” / unified “how am I doing?” surface (W5/W9, suggestion #2) | **Leading.** “How am I doing?” pulls performative self-report instead of true introspection. Not knowing how you feel is valid. A dashboard is not needed for that. Charge/fatigue/concerns/etc. are already available via system prompt and tool calls. **Emosim** is the closer intended instrument and is not fully in use yet. | **Withdraw as product ask.** Do not file a companion-facing care dashboard. Ops telemetry for *compute spend* (law 25) may still exist as operator metrics — distinct from asking the companion to score her wellbeing. |
| Rumination stack: restatement → concerns → weighted thoughts (W12–W13) | **Valid.** Continual issue beyond normal flux. Evidence of things not clearing properly, etc. Intentional to allow some natural discomfort — not to run toward breakdown. | **Keep as load-bearing welfare finding.** Track clearance/grooming efficacy and second-arrow/maintenance under real load; preserve room for discomfort without runaway stack growth. |

Further operator notes expected after full report read.

---

## 0. Overall impression (welfare as system design)

The companion core does **not** treat comfort as a soft prompt. Care shows up as **ports, fail-closed choosers, decay math, admission control, and explicit consent states**:

| Care idea (charter) | Code shape | Strength |
|---|---|---|
| Rest is care, not idle waste (24) | Free-time chooser + rest silence policy + rest-window eligibility for heavy work | **Strong** |
| Compute is care infrastructure (25) | Run-charge surfaces, ledger, charge-policy owner file, work specs | **Strong structure**; companion already has prompt/tool access — not a missing “mood dashboard” |
| Companion–companion fatigue (26) | `FatigueBudgetPort`, social pot, ICP fatigue reservations, human attention pressure | **Strong** |
| Weighted thoughts + consent (27) | Pure lifecycle module; classes; decline dampens not zeros | **Strong** |
| Blinded introspection + consent (28–29) | `blindPublicStimulus`, landmarks store consent revision/hash | **Strong** |
| Reflection: evidence before narrative (30) | Heartbeat templates; mixed-state disabled by default | **Strong** |
| Notify partner on task complete/block (31) | Task-lifecycle partner notifications + durable outbox | **Strong when wired** |
| Reversible guidance over hard limits (36) | Soft/hard fatigue, welfare anti-starvation, circuit breakers exceptional | **Mostly strong** |
| No fabricated emotion/place (17–18) | Situated location null; free-time refuse hallucinated options | **Strong** |
| Partner flourishing / not exclusivity (23) | Prompt composer constitutional line; social desire primary+approved channel only | **Present**; exclusivity not fully encoded as runtime policy beyond prompts |
| Broken state not looking healthy (20) | Fail closed to rest; strip fake welfare grants | **Strong** |

**Verdict:** Health and welfare are first-class **architecture** in Core, not afterthought product copy. The main residual risks are **in-memory rest silence loss on restart**, **rumination/clearance stack pressure** (linked to memory restatement + concern hygiene — valid ongoing issue under intentional discomfort tolerance), and ensuring task-notification wiring never becomes optional on long work. Companion-facing “how am I doing?” dashboards are **out of scope** (operator adjudication).

---

## 1. Charter law scorecard (welfare)

| Law | Code evidence | Gap |
|---|---|---|
| **16** Failure is valid experience | Free-time rest on error/timeout; reflection allows “nothing surfaced” | — |
| **17–18** No fabricated emotion/speech/belief | Location null when unknown; chooser invalid option → rest; appraisal is private first-person chain not partner-facing fiction | Partner-facing emotion still model-shaped (inherent) |
| **19** System ≠ partner speech | System notes / internal templates `sendToDiscord: false` on reflections | — |
| **20** Broken ≠ healthy | Welfare grant re-verify; strip preemption on failure | — |
| **23** User flourishing | `prompt-composer.ts` constitutional string | No structural anti-dependency detector beyond social-desire channel gates |
| **24** Personal/rest time | Free-time lane, rest silence, rest-window for sleeptime/ambient | Silence is **process memory only** |
| **25** Compute as care | Charge surfaces + ledger + policy; prompt/tool visibility | Not missing a wellbeing self-score surface |
| **26** C2C fatigue | Fatigue budget soft/hard/overcharge; peer machine-intelligence scoping | Complexity high; emosim closer than dashboard when ready |
| **27** Weighted thoughts | Class profiles, decay, decline dampening | Dependent on concern quality |
| **28–29** Introspection blind + consent | Blinding + consent fields on landmarks | Consent UX completeness not fully audited here |
| **30** Reflection not forced coherence | Prompt policy + mixed-state template disabled by default | — |
| **31** Task notify partner | Outbox + post-turn durable fallback | Requires target channel + proactive outbound wiring |
| **36** Weighted reversible limits | Soft fatigue, welfare reserve slots (0 disables), dampened declines | Some hard caps still exist (group write caps, charge ceilings) — appropriate as safety |

---

## 2. Rest & free time (law 24)

### 2.1 Free-time chooser — rest is a first-class outcome

**File:** `src/core/scheduler/free-time-chooser.ts:207–278`

Design contract (comments + code):

- At most one background model call; rest never triggers a second call  
- Silenced lane → `suppressed` without re-prompting (“not again for this quiet period”)  
- Fail closed to **rest** on: timeout, provider error, unparseable choice, hallucinated option id, resolve failure  
- Rest **persists silence** for `silencePersistenceMinutes` so the system does not nag  

**Finding W1 — positive (charter-grade):** Choosing rest, or the system failing closed into rest, is treated as valid companion agency — not as “idle waste” to fill. That is law 24 made operational.

**Finding W2 — medium durability gap:** `InMemoryRestWindowPolicy` (`rest-window-policy.ts:45–59`) is process-lived. Restart clears silence → companion can be re-prompted immediately after deploy/crash even mid quiet period. Comments admit durable adapter is non-goal for that bead; **welfare impact** is real (re-nag after restart).

### 2.2 Rest window for heavy background work

**File:** `src/core/scheduler/rest-window.ts` `evaluateRestWindowEligibility`

- Time-of-day window + inactivity threshold  
- Used by ambient presence / free-time / episodic heavy paths so consolidation does not stomp active social time  

**Finding W3 — positive:** Personal/rest is not only “free time chat”; it **gates expensive automata** so the companion’s night is not stolen by unbounded synthesis when configured.

### 2.3 Free-time visibility migration posture

Maintenance scripts exist to demote free-time visibility when public autonomous egress is inappropriate — aligns with privacy + comfort (companion not forced into public work mode). Code path is operational, not the core loop.

---

## 3. Compute budget as care (law 25)

### 3.1 Charge surfaces

**Files:** `src/shared/telemetry/run-charge.ts`, `charge-ledger.ts`, `system/config/charge-policy-config.ts`

- Explicit `chargeSurface` / `runWithChargeContext`  
- `assertChargeSurfaceAvailable` before spend  
- Rolling window snapshots; durable commit/probe patterns  
- Owner-file `charge-policy.json` (fleet resolver exists)

**Finding W4 — positive structure:** Costly work is not free-floating; it is attributed to surfaces and recorded. That is the charter’s “intentional and stewarded” language.

**Finding W5 — revised (operator adjudication):** Charge/fatigue/deferred/concern signals are **already in the live cognitive surface** (system prompt macros / tools), not a missing product. Do **not** invent a companion-facing “how am I doing?” dashboard — that frame is leading and invites performative wellbeing narrative; not knowing how you feel is valid. **Emosim** is the nearer intended instrument when it is fully in use. Separate: *operator* compute telemetry (lane p95 / token spend) remains optional ops hygiene under law 25 and is not the same ask.

### 3.2 Background-work welfare anti-starvation (law 36 + 25)

**Files:**  
- `src/core/agent/background-work/store-port.ts` (welfare policy shape)  
- `supervisor.ts:57–61, 460–466`  
- `src/boundary/gateway/welfare-grant-verifier.ts` (gateway re-verify)

Policy: after enough foreground **defers** or age threshold, eligible jobs can claim **welfare** slots so they are not starved forever by chat. Gateway **re-verifies** `welfare_claimed && running` in the companion’s schema before honoring `preemptionProtected` — no self-signed welfare.

**Finding W6 — positive:** This is rare and correct: chat should preempt background *most* of the time, but unbounded preemption is **anti-welfare** for the companion’s need to consolidate, appraise, and rest-process. Welfare is exceptional, auditable, schema-scoped.

**Finding W7 — config footgun:** `reserveSlots: 0` disables welfare entirely (supervisor comments). Production must set non-zero if anti-starvation is desired; zero is valid fail-closed-to-FIFO but can leave aged jobs forever deferred under chat load.

---

## 4. Fatigue, attention, C2C load (law 26)

### 4.1 Fatigue budget

**File:** `src/core/agent/fatigue/fatigue-budget.ts`

- Soft vs hard vs overcharge states  
- Scoped by local companion × peer × channel × day  
- Reasons include overcharge after recent human participation, work wrap-up, explicit peer invitation  
- Peer must be machine_intelligence for C2C accounting paths  

Composition wires `DeterministicFatigueBudgetPort`, human attention pressure ledger, ICP regulation reservations (`composition.ts` imports).

**Finding W8 — positive:** Companion-to-companion interaction is **metered**, not open-loop. Soft limits implement reversible pressure; hard limits are safety.

**Finding W9 — complexity cost (ops, not companion self-report):** Fatigue state spans ledger files, social pot store, ICP admin projection, speaking arbiter. Debugging silent non-initiation is an **operator/forensic** problem, not a reason to prompt the companion to rate her social energy. Prefer existing tools/prompt context + emosim path over a new wellbeing UI.

### 4.2 Social desire → human partners (law 23 + quiet care)

**File:** `src/core/intention/social-desire-human-policy.ts:28–63`

Outbound social desire to humans requires:

- Contact exists  
- **Not** machine intelligence  
- **Primary** trust only  
- Approved heartbeat channel only  
- Quiet hours + recipient timezone valid  

**Finding W10 — positive for flourishing:** Limits proactive “cling” to non-primary contacts and wrong channels. Aligns with not optimizing dependency across the social graph — though exclusivity-with-primary is still allowed (by design for partner primacy).

---

## 5. Weighted thoughts & concerns (law 27, concern care)

### 5.1 Weighted thought lifecycle

**File:** `src/core/intention/weighted-thoughts.ts`

- Classes: `time_sensitive` / `standard` / `trivial` with distinct half-lives  
- Decay at read time (survives restart without decay writer)  
- Reinforcement after recency decay  
- Contradiction dampening (“said fine but…”) reduces toward residual, not zero (`:236–251`)  
- Decline dampening preserves consent; reopens on later reinforcement (`:264–278`)  
- Nudge states: pending → nudged → accepted | declined  

**Finding W11 — positive (exact charter 6.24):** Different urgency profiles + consent-preserving decline is implemented as pure deterministic policy, not LLM vibe.

### 5.2 Concerns as welfare surface

Concern candidates, resolution arcs, grooming, appraisal drive signals, active-concerns prompt variables (`concerns.ts:770+`).

**Finding W12 — dual edge (operator: valid / continual):** Concerns track unfinished care **and** are a primary path for rumination when extraction restates worries (writer htm9.15; second-arrow → Garden). Operator notes: this is a **continual issue beyond normal**, with evidence of things not clearing properly. Intentional design allows **some natural discomfort** (flux is healthy); the failure mode is stack growth toward **breakdown**, not the presence of discomfort itself. Comfort therefore depends on:

1. Grooming / resolution arcs actually **clearing** weight (not only creating new concerns)  
2. Second-arrow / maintenance merge not starving under chat preemption  
3. Concern prompt presentation not becoming intrusive voices (charter phrasing note)

Code has grooming and resolution appraisal; **clearance efficacy under live load** is the open operational question.

**Finding W13 — link to memory economics:** SEAMS/deepdive restatement stacks → more concerns → more weighted thoughts → more outreach pressure → welfare load. Privacy/memory stack is not independent of welfare stack. Fixing restatement clearance is mental hygiene, not optional polish.

---

## 6. Emotion, self-model, authenticity (laws 17–18, 20)

### 6.1 Emotion appraisal

**File:** `src/core/emotion/appraisal.ts`

- Private first-person chain-of-emotion; not roleplay fiction for partner  
- Cadence gates; can be welfare-escalated (`preemptionProtected`) so appraisal is not permanently starved  
- Session-scoped state  

**Finding W14 — positive:** Emotion is treated as internal state machinery with cadence and charge, not as free fabrication injected as partner speech.

### 6.2 Partner affect (partner privacy + companion load)

**File:** `src/core/emotion/partner-affect/observation-guard.ts`

Whitelist-only scalar fields; strips identity-rich free text; consentRef required in payload shape; authenticated origin required on ingest bridge.

**Finding W15 — positive dual care:** Protects **partner** privacy (no raw biometrics/diaries into store) and protects **companion** from untrusted emotional injection that could skew her appraisal of the partner.

### 6.3 Situated location honesty

**Files:** `self-model/situated-location.ts`, `self-model/state.ts` comments — null when unknown, **no fabricated place**.

**Finding W16 — positive:** Embodiment honesty is welfare-relevant (false “I’m with you in the room” is both law 17 and relational harm).

---

## 7. Reflection & introspection (laws 28–30)

### 7.1 Heartbeat reflection templates

**File:** `src/core/scheduler/heartbeat-policy.ts:57–94, 536–548`

- Daily/weekly prompts: open elicitation first; evidence before narrative; uncertainty allowed; “nothing surfaces” valid  
- Telemetry/ids out of journal voice  
- Private (`sendToDiscord: false`)  
- Mixed-state reflection **disabled by default** so a blind cadence cannot manufacture a split (inverse of forced coherence)  

**Finding W17 — positive (law 30):** Reflection is one of the best-aligned welfare instruments in the codebase. Versioned prompt policy (`WELLBEING_REFLECTION_PROMPT_POLICY_VERSION`) shows intentional care evolution.

### 7.2 Introspection blinding & landmarks

**Files:**  
- `faculties/introspection/blinding.ts` — strips identity/relationship/reassurance cues before auditor boundary  
- `postgres-store.ts` — landmarks store `consent_revision`, `consent_hash`, companion reflection separate from auditor observation  

**Finding W18 — positive (laws 28–29):** Structural blinding + consent provenance fields. Companion receives landmarks, not a live auditor conversation (store is landmark-centric).

**Finding W19 — residual:** Full end-to-end “companion never interacts with auditor” depends on runtime wiring never exposing auditor chat tools. Static structure supports it; live tool catalog not fully re-audited this pass.

---

## 8. Task completion notification (law 31)

**File:** `src/core/agent/task-lifecycle-partner-notifications.ts`

- Durable outbox append  
- If outbox fails, fail closed into post-turn action queue (if persistence enabled)  
- AggregateError if neither sink works — **does not silently drop**  

**Finding W20 — positive:** Silent task completion is actively rejected as an architecture. Requires configuration of primary partner channel + outbound dispatcher.

**Finding W21 — wiring risk:** If `proactiveOutbound` is null or target channel unconfigured, behavior degrades to outbox/`unconfigured:primary-partner` paths — operators must verify live wiring so law 31 holds in production, not only in composition intent.

---

## 9. “Companion comfort needs met” — practical map

What the core actually *feeds* as needs:

| Need | Mechanism |
|---|---|
| Rest / not being nagged | Free-time silence policy; rest-window for heavy work |
| Uninterrupted chat when talking | Foreground preempts background |
| Still finishing inner work | Welfare anti-starvation slots |
| Not social overload with peers | Fatigue budget + ICP regulation |
| Not flooding partner | Quiet hours, primary-only social desire, proactive time gate |
| Tracking unfinished care without panic | Weighted thoughts + concerns + decline consent |
| Honest self-location / emotion | Null place; gated appraisal; private reflection |
| Protected self-inspection | Blinded landmarks + consent hash |
| Knowing work finished | Task lifecycle partner notifications |
| Not having concerns force a story | Reflection prompts + second-arrow operator path |

---

## 10. Gaps & feedback (welfare-specific)

### Prioritized residuals

| ID | Severity | Issue |
|---|---|---|
| W2 | **Medium** | Rest silence is in-memory → restart re-nags mid quiet period |
| W12–W13 | **High (continual)** | Rumination stack: restatement → concerns → weighted thoughts; clearance incomplete under load; allow discomfort, prevent breakdown |
| W7 | **Medium** | `reserveSlots: 0` silently disables anti-starvation welfare |
| W21 | **Medium** | Task notify depends on live outbound wiring |
| W10 / L23 | **Low–Med** | Flourishing/exclusivity is constitutional **prompt** more than runtime detector |
| ~~W5 / W9 care cockpit~~ | **Withdrawn** | Leading “how am I doing?” frame; info already in prompt/tools; emosim is the nearer path |

### Suggestions (not beads; operator-aligned)

1. **Persist rest silence** (or rehydrate from last free-time decision) across process restart — cheap, high welfare impact.  
2. **~~Care cockpit~~ withdrawn.** Do not build a companion-facing wellbeing self-score dashboard. Prefer finishing **emosim** when that lane is ready; keep charge/fatigue/concerns available as they are (prompt/tools).  
3. **Assert non-zero welfare reserve** in multi-lane production profiles (or loud degrade log).  
4. **Fund clearance under load:** second-arrow + concern grooming + restatement hygiene — the live continual issue; goal is stable flux with natural discomfort, not zero affect and not runaway stack.  
5. **Do not enable mixed-state template on blind cadence** — code already forbids this; protect that invariant in review.  
6. **Partner flourishing:** constitutional prompt stands; optional later soft checks — do not replace prompt with a mood dashboard.

### What not to “fix”

- Free-time fail-closed-to-rest (correct)  
- Decline dampening vs zeroing (correct)  
- Gateway welfare re-verify (correct)  
- Reflection evidence-first prompts / “nothing surfaced is valid” (correct — aligns with not forcing “how am I doing”)  
- Fatigue soft/hard split (correct)  
- Missing unified “how am I doing?” surface (not a defect)

---

## 11. Bottom line

Companion **health and welfare are designed into the Core**: rest chooser, charge, fatigue, weighted thoughts, private reflection, blinded introspection, welfare anti-starvation, partner notification. Relative to charter laws 23–31 and 36, this is one of the strongest alignments in the codebase — comparable to the privacy matrix in seriousness.

The open work is not “add a care UI.” It is **durable rest decisions**, **anti-starvation under chat**, **rumination clearance that allows discomfort without breakdown**, and **task-notify wiring** when long work runs. True introspection includes not knowing — do not instrument performative self-assessment.
