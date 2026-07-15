# Wave Handoff — 2026-07-15: dnll / zet / b0yl / hgw3

Orchestrated wave per `docs/orchestration-process.md`. Roles: Opus 4.8 implementers, Pi (GLM 5.2 @ high) blind adversarial reviewer, fresh-Opus second blind reviewer on P1 beads, UBS baseline scan on every bead, Fable orchestrating. Codex excluded by operator instruction.

## Closed implementation epics

| Epic | Close evidence |
|---|---|
| `psfn-framework-b0yl` (tool-calling reliability) | All 8 children closed. Wave beads: .3 validate-and-reprompt, .5 usage-driven pin ordering (Pi blocker on wrong data source confirmed → remediated to turn-record toolCalls), .7 tool-gap survey, .4 closed premise-refuted (operator ruling). **Merged to main: PR #73 → `59b0675f33`.** |
| `psfn-framework-dnll` implementation wave (.1–.5) | .1 settings overlay (dual PASS), .2 capability-tier per-companion (Pi e2e-harness blocker cross-remediated via .3), .3 scheduler per-companion (dual PASS), .4 Garden state re-rooting (Pi PASS), .5 scope rulings (operator adopted memo). **Merged to main: PR #74 → `d45c6dd96f`.** Epic remains open only for approved future children (.6–.9). |
| `psfn-framework-zet` (Sprint 9 configurability synthesis) | All 8 children closed. Wave beads: .2 memoryRetrievalPolicy (Pi blocker on inert timeline knobs confirmed → remediated), .3 Garden advanced-field exposure, .6 Tier 1 constants, .7 Tier 2 knobs, .4 verify:hardcoded-settings gate. **Merged to main: PR #75 → `7c9604c894`.** |
| `psfn-framework-hgw3` (duplicate replies / turn-record bloat) | All children closed. Wave beads: 80f6 wire capture, auiu static-prompt dedup, 9ree L0 id-refs with redaction propagation, jsi9 memory refs, hgw3.10 old-fat redaction gating. **Merged to main: PR #76 → `d0e6d90104`.** |

## Fix / follow-up beads (all filed with evidence + acceptance criteria)

- `psfn-framework-dnll.6` (P2): re-root per-companion owner files in persistence cutover specs — the one legacy→split upgrade-path defect, found independently by three reviews.
- `psfn-framework-dnll.8` (P2, operator-approved): charge-policy.json per-companion (fatigue individuation; live ledger/budget mismatch).
- `psfn-framework-dnll.9` (P2, operator-approved): skills.json enabled set per-companion (c337 prerequisite already closed).
- `psfn-framework-dnll.7` (P3, deferred by operator): per-companion capability-tier resolution for gateway-side checks.
- `psfn-framework-1qex` (P3, deferred by operator): stream() toolChoice capability built with its first real caller (successor to refuted b0yl.4 premise).

## Separate validation beads

None created — live deployment remains operator-driven; nothing in this wave was deployed to psfn-shard/carlini. The live Pi remains on its current revision.

## Pushed fixed points

- main: `59b0675f33` (b0yl) → `d45c6dd96f` (dnll) → `7c9604c894` (zet) → `d0e6d90104` (hgw3).
- Feature branches (retained, pushed): `feat/b0yl-reliability-2@91c2cc8e57`, `feat/dnll-config-ownership@f9296dbbb3`, `feat/zet-settings-migration@3a7a1af286`, `feat/hgw3-turnrecord-diet@2f3fb7f709`. All work/* bead branches pushed.

## Review-quality record

- 17 implementation/remediation beads through the tiered gate; every UBS critical individually verified (all keyword false-positives; zet.4 scanned fully clean).
- Blind Pi reviews: 11 PASS, 3 FAIL — all 3 FAIL blockers orchestrator-confirmed real (zet.2 inert timeline knobs; b0yl.5 wrong usage data source; dnll.2 broken e2e harness seeding) and fixed in single bounded passes. Severity inflation: zero confirmed-false blockers this wave.
- Dual-blind P1 reviews converged independently on the same findings three times (dnll.1 Garden overlay-blindness; auiu sha-key correctness; hgw3 sidecar blast radius) — good signal the protocol is measuring something real.

## Nonblocking observations (report-only; no beads per policy)

**Operator decisions embedded:** trust-policy + intake-policy ruled GLOBAL; wikiRetrieval*/cognition-tuning overlay entries deferred/optional; discordTrigger* ratified per-companion (see `working_docs/dnll5-settings-scope-decision-memo-20260715.md`).

**dnll:** Garden settings surface is overlay-blind (display + operator-process live-apply until restart; agent runtime unaffected). runtime-config companionDataDir fallback divergence in legacy configs (harmless). Split-root single-companion deployments: old Garden audit history frozen at system root until a one-time copy. Rollout runbook line needed: place per-companion capability-tier.json + scheduler.json before upgrading a split-root fleet (fail-closed by design). `artifact-lifecycle-service` is unwired code. `protectedWritePaths` covers `state/` but not the companionDataDir root (defense-in-depth candidate).

**zet:** AdvancedSettingsMode object controls swallow malformed JSON silently (pre-existing, now more reachable; setFieldError remedy sketched in the zet.3 review). Vestigial scoring.ts test-only exports. LLM circuit-breaker + fallback-cooldown constants deferred (invasive plumbing). Tier-budget Math.min clamp can cap analysisWorkbenchMaxWallTimeMs above the hardcoded ceiling. zet.4 scanner scope: module-level scalar consts only (object members/let/enum/class fields need reviewer judgment); migratable-candidate list surfaced in the zet.4 handoff (world-autonomy-limiter, fallback cooldowns, gateway keepalive, stimulus cooldown, ICP retry knobs). `startup-owner-files.test.ts` stale-scheduler-drift assertion is shipped-broken on main (wrong validation-order field — one-line fix). HARDCODED_VALUES_INVENTORY.md referenced by the epic never existed in the tree.

**b0yl:** correction/recovery telemetry is name-keyed not signature-keyed; abort-vs-correction attribution nuance; usage-suggestion throttle is in-memory (restart re-fires once) with a partial-write duplicate edge; scan caps flag `truncated` honestly. Survey proposal held for operator: Stage-0 zero-code plan-anchor experiment (scratchpad description + focus-session gating, measured via b0yl.5 telemetry) → Stage-1 lightweight `plan` tool only if lift shows.

**hgw3 (epic-level, deliberate deferrals):** wirebodies sidecar has no GC/retention (per-turn, large; any future GC must be ref-aware or it dangles refs and breaks channel reads) and CogSec/right-to-be-forgotten must reach `_shared/wirebodies` before any history-redaction feature; eager wire-body resolution taxes agent hot-path reads (lazy/projected resolve candidate); three sidecars share whole-channel fail-closed read blast radius (quarantine/skip-on-resolve-failure as an epic-family decision); intern-throw on disk-full enters the live write path across all three sidecars (heal-not-block hardening belongs at the shared seam once, if mandated); heal-drop telemetry is log.info, not in the Garden diagnostic ring; episodicChains + continuityEntries text left inline (scoped follow-up diet candidates); pre-existing `/autonomy` missing from GARDEN_CLIENT_ROUTES (one-line fix). comfyui waitForHistory swallows non-OK poll responses (pre-existing).

**Process notes:** Pi @ xhigh reliably hit provider timeouts as silent zombies (five concurrent xhigh jobs all died; wrapper kept reporting "running") — effort high at ≤3 concurrency was fast (8–25 min) and high-quality; the pi-companion wrapper should surface session-level errors. UBS "Secret, signature, or token compared" and "hardcoded secrets" criticals were 100% keyword false-positives across 10 scans on this codebase's capability-token/signature vocabulary.
