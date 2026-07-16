# Wave Handoff — 2026-07-15: dnll / zet / b0yl / hgw3

Orchestrated multi-agent implementation wave under the repository's wave protocol (worktree-isolated bead branches → feature branches → tiered adversarial review → bounded remediation → agent-pair-validated PRs to main). Roles: Opus 4.8 implementers, Pi (GLM 5.2 @ high) blind adversarial reviewer, fresh-Opus second blind reviewer on P1 beads, UBS baseline scan on every bead, Fable orchestrating. Codex excluded by operator instruction.

## Closed implementation epics

| Epic | Close evidence |
|---|---|
| `psfn-framework-b0yl` (tool-calling reliability) | All 8 children closed. Wave beads: .3 validate-and-reprompt, .5 usage-driven pin ordering (Pi blocker on wrong data source confirmed → remediated to turn-record toolCalls), .7 tool-gap survey, .4 closed premise-refuted (operator ruling). **Merged to main: PR #73 → `59b0675f33`.** |
| `psfn-framework-dnll` implementation wave (.1–.5) | .1 settings overlay (dual PASS), .2 capability-tier per-companion (Pi e2e-harness blocker cross-remediated via .3), .3 scheduler per-companion (dual PASS), .4 Garden state re-rooting (Pi PASS), .5 scope rulings (operator adopted memo). **Merged to main: PR #74 → `d45c6dd96f`.** Epic remains open only for approved future children (.6–.9). |
| `psfn-framework-zet` (Sprint 9 configurability synthesis) | All 8 children closed. Wave beads: .2 memoryRetrievalPolicy (Pi blocker on inert timeline knobs confirmed → remediated), .3 Garden advanced-field exposure, .6 Tier 1 constants, .7 Tier 2 knobs, .4 verify:hardcoded-settings gate. **Merged to main: PR #75 → `7c9604c894`.** |
| `psfn-framework-hgw3` (duplicate replies / turn-record bloat) | All children closed. Wave beads: 80f6 wire capture, auiu static-prompt dedup, 9ree L0 id-refs with redaction propagation, jsi9 memory refs, hgw3.10 old-fat redaction gating. **Merged to main: PR #76 → `d0e6d90104`.** |

## Fix / follow-up beads (formal acceptance criteria populated on each; discovered-from edges linked)

- **`psfn-framework-eb14` (P1)**: CogSec redaction must reach `_shared/wirebodies` — a partner message tombstoned in L0 after capture persists verbatim in `capturedWirePayload.body` and renders in the Loom raw-wire panel; the 9ree/hgw3.10 gating covers `recentEntries`/`plan.messages` only. Partner-data redaction/retention risk per the Blocking Risk Standard (reclassified from report-only during handoff validation). Discovered-from 80f6 + hgw3.10.
- `psfn-framework-dnll.6` (P2): re-root per-companion owner files in persistence cutover specs — legacy→split upgrade-path defect, found independently by three reviews. Discovered-from dnll.2/dnll.3.
- `psfn-framework-dnll.8` (P2, operator-approved): charge-policy.json per-companion (fatigue individuation; live ledger/budget mismatch).
- `psfn-framework-dnll.9` (P2, operator-approved): skills.json enabled set per-companion (c337 prerequisite already closed).
- `psfn-framework-dnll.7` (P3, deferred by operator): per-companion capability-tier resolution for gateway-side checks.
- `psfn-framework-1qex` (P3, deferred by operator): stream() toolChoice capability built with its first real caller (successor to the refuted b0yl.4 premise).

## Separate validation beads

None created — no live deployment was performed in this wave; live rollout remains operator-driven. Rollout precondition recorded below (per-companion owner files on split-root fleets).

## Pushed fixed points

- main: `59b0675f33` (b0yl) → `d45c6dd96f` (dnll) → `7c9604c894` (zet) → `d0e6d90104` (hgw3).
- Feature branches (retained, pushed): `feat/b0yl-reliability-2@91c2cc8e57`, `feat/dnll-config-ownership@f9296dbbb3`, `feat/zet-settings-migration@3a7a1af286`, `feat/hgw3-turnrecord-diet@2f3fb7f709`.
- Every work/* bead branch containing commits is pushed. Exception (no remote ref, intentional): `work/b0yl-reliability-2-b0yl-4-forced-choice` contains zero commits — the bead closed premise-refuted with no code, so its branch is identical to base `66293a0d` and was not pushed.

## Review-quality record

- 17 implementation/remediation beads through the tiered gate. Mandatory `npm run lint` passed on every bead and on all four integrated feature branches at final check.
- UBS baseline scan on every bead; every reported critical individually verified (all were keyword false-positives on capability-token/signature vocabulary; zet.4 scanned fully clean).
- Blind Pi reviews: 16 total — **13 PASS** (b0yl.3; dnll.1/.3/.4; zet.3/.4/.6/.7; 80f6; auiu; 9ree; jsi9; hgw3.10) and **3 FAIL** (zet.2, b0yl.5, dnll.2). All 3 FAIL blockers were orchestrator-confirmed real (inert timeline knobs; wrong usage data source; broken e2e harness seeding) and fixed in single bounded passes. Zero confirmed-false blockers.
- Dual-blind P1 reviews (Opus + Pi) converged independently on the same findings three times (dnll.1 Garden overlay-blindness; auiu sha-key correctness; hgw3 sidecar blast radius).

## Nonblocking observations (report-only; complete register)

**Operator decisions embedded this wave:** trust-policy + intake-policy ruled GLOBAL; wikiRetrieval*/cognition-tuning overlay entries deferred/optional; discordTrigger* ratified per-companion (rulings recorded on dnll.5; memo at `working_docs/dnll5-settings-scope-decision-memo-20260715.md`).

**dnll:** Garden settings surface is overlay-blind (display + operator-process live-apply until restart; agent runtime unaffected). runtime-config companionDataDir fallback divergence in legacy configs (harmless). Split-root single-companion deployments: old Garden audit history frozen at system root until a one-time copy (data intact; optional startup WARN suggested). Rollout runbook line needed: place per-companion capability-tier.json + scheduler.json before upgrading a split-root fleet (fail-closed by design). `artifact-lifecycle-service` is unwired code (cosmetically fixed only). `protectedWritePaths` covers `state/` but not the companionDataDir root (defense-in-depth candidate). Contract-guard scope check is derivation-tautological (catches hardcode drift only, not load-site rooting drift). `verifyStartupOwnerFiles` has no non-test caller (boot gate is the loader itself).

**zet.2:** vestigial `scoring.ts` module-load exports now lag a tuned policy (test-only consumers; mark or drop). No dedicated admin-ui control for memoryRetrievalPolicy (backend + generic advanced editor only). Sleeptime cadence/message/maxWrites already scheduler-owned (not re-migrated).

**zet.3:** AdvancedSettingsMode object controls swallow malformed JSON silently (pre-existing line, now more reachable — concrete silent-lost-edit scenario documented in the review with a setFieldError remedy sketch). ~8 newly surfaced fields are dual-exposed alongside curated controls (consistent with existing pattern).

**zet.6:** LLM circuit-breaker triple + fallback cooldowns deferred (invasive, security-sensitive plumbing). Tier-budget Math.min clamp silently caps `analysisWorkbenchMaxWallTimeMs` above the hardcoded tier ceiling. Two inconsistent shell timeout/output ceiling sets exist (`capabilities/shell.ts` vs `shell-policy-config.ts`, both dead until shell exec ships).

**zet.7 refusals (evidence-backed, recorded in the bead):** focus limits (error-string-coupled module consts — needs its own refactor), safeguard thresholds (env-owned; Garden ownership is a safety-tier decision), MAX_OFFICE_XML_ENTRY_BYTES (zip-bomb guard, code-owned), DreamMeaningPass knobs (constructor options unthreaded), episodic no-option consts (memory-faculty internals). Pre-existing: `comfyui.ts waitForHistory` swallows non-OK poll responses.

**zet.4:** scanner scope is module-level scalar consts only (object-literal members, `let`, enum/class fields need reviewer judgment — AGENTS.md wording narrowed to match). Migratable-candidate list surfaced, not silently baselined: world-autonomy-limiter cooldown/hourly-limit, discord-startup retries, gateway keepalive interval, companion-stimulus cooldown, LLM fallback cooldowns, ICP initiation retries, heartbeat-template cooldown. `startup-owner-files.test.ts` stale-scheduler-drift assertion is shipped-broken on main (asserts wrong validation-order field — one-line fix). HARDCODED_VALUES_INVENTORY.md referenced by the epic never existed in the tree.

**b0yl:** correction/recovery telemetry is name-keyed not signature-keyed (over-counts recovery); abort-during-correction reports correction rather than cancellation (telemetry-only); usage-suggestion throttle is in-memory (restart re-fires once) with a partial-write duplicate edge; scan caps flag `truncated` honestly. Survey proposal held for operator: Stage-0 zero-code plan-anchor experiment (scratchpad description + focus-session gating, measured via b0yl.5 telemetry) → Stage-1 lightweight `plan` tool only if lift shows.

**9ree:** per-page range-read batching opportunity on the Garden observability path (N records → up to 2N range reads; merged read would cut it). Empty-provenance messages pass ungated (inherent to provenance-keyed gating; flag only if lost-provenance becomes a tracked scenario). Archive-retention pruning of referenced ids heal-drops silently (consistent with documented heal semantics). `continuityEntries` and `episodicChains` text left inline (scoped follow-up diet candidates).

**hgw3.10:** heal-drop telemetry is log.info + process counter, not in the Garden diagnostic ring (meets bead acceptance; Garden surfacing = optional follow-up). channelId gating asymmetry vs gatePlanMessages fallback (defensive only, unreachable for records this codebase writes). Merged-range-read micro-opt shared with the ref-backed path.

**hgw3 epic-level:** wirebodies sidecar has no GC/retention (per-turn, large; any future GC must be ref-aware or it dangles refs and breaks channel reads) — the CogSec half of this is now P1 bead eb14, the retention half remains here. Eager wire-body resolution taxes agent hot-path reads (lazy/projected resolve candidate). Three sidecars share whole-channel fail-closed read blast radius (quarantine/skip-on-resolve-failure is an epic-family decision). Intern-throw on disk-full enters the live write path across all three sidecars (heal-not-block hardening belongs at the shared seam once, if mandated). Pre-existing: `/autonomy` missing from GARDEN_CLIENT_ROUTES (one-line fix).

**Process notes:** Pi @ xhigh reliably hit provider timeouts as silent zombies (five concurrent xhigh jobs all died; wrapper kept reporting "running") — effort high at ≤3 concurrency was fast (8–25 min) and high-quality; the pi-companion wrapper should surface session-level errors. UBS "secret/signature/token" and "hardcoded secrets" criticals were 100% keyword false-positives across 10 scans on this codebase's vocabulary.
