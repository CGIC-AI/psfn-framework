# Sprint 11 — Free-Time Social Autonomy (jp36) — Wave Status

Status: **implementation complete**, epic seam review passed after one remediation, PR open to `main` (merge held for third-party review per operator instruction).
Feature branch: `feat/jp36-social-autonomy` @ `f3f823c7` (origin-equal). Base: `origin/main` @ `66059b01` (reconciled 2026-07-20).
Date: 2026-07-20. Orchestrated per `docs/orchestration-process.md`; Codex/Pi unavailable — Opus subagents served as implementers and single-reviewer lanes (operator-authorized deviation), one review + one fix pass per bead, dual-blind Opus pass for the epic seam review.

## Shipped implementation (all 10 features closed with per-bead review evidence)

- **jp36.1 CogSec outbound disclosure gate** — pure destination-eligibility decision layer, per-turn `DisclosureLineage` accumulated from session/memory/wiki/tool-result admission, composed into the egress sink guard (`DisclosureDecision.allowed` keys release; sink-deny always wins). Includes the jp36.1.2 bug tree: runtime metadata authority on `project_add_artifact`, legacy-artifact quarantine, and the review-discovered generic-write forge-path fix.
- **jp36.2 Free-time workspace continuity** — resolver, chooser (menu-constrained single background call, first-class rest + silence), lane-independent session identity, one-time visibility migration, destination-scoped return-note projection + routing, manifest v2. Composition seams for project-driven sessions deliberately deferred (fail-closed; `qgqw.6`).
- **jp36.3 Room participation foundation** — `sendReaction` seam + curated emoji surface, passive-name candidates (deterministic suppression matrix + debounce), participation appraiser (fail-closed ternary) + injection suite (found and fixed a real sanitizer gap).
- **jp36.4 Fatigue economy** — Postgres social pot (advisory-lock serialization), per-channel draw caps with ICP priority, human-never-charged invariant, continuous cap/24 regeneration.
- **jp36.5 Gateway speaking arbiter** — two-phase reservation/egress-lease store (send-once-per-trigger fence added in remediation after an empirically reproduced double-send), reservation phase (deterministic gates before model spend), egress lease phase (speak-least fairness, Law-36 durable single-probe breaker, real pot draw), live ICP precedence transport (delivering-window fence gap fixed in remediation), durable charge fencing (migration 11). **Autonomous send surface shipped INERT** (`egressLease.enabled` code-pinned false, structurally excluded from owner-file config) pending `qgqw.3`.
- **jp36.6 Room classification epochs** — `classificationSource` tracking, Garden click-to-accept demotion flow with a write-gate on `operator_confirmed`, epoch enforcement in the pure decision layer (only-adds-denials, verified), runtime data join with a composition-driven acceptance test.
- **jp36.7 Publication lifecycle** — hash-bound `exact_replay` capsules, gateway custody riding the existing approval queue (cross-process lock added in remediation after an empirically reproduced lost-update), Gate provenance view, companion `publication` edit-loop tool (content-only authority). External publication adapters remain deferred per bible §23.3.
- **jp36.8 Garden/telemetry** — typed content-free participation bus events, `scheduler.json` `socialAutonomy` owner-file block (enablement structurally excluded), Fleet Command room-arbiter view.
- **jp36.9 Review-surfaced fixes** — stale-presence fail-closed, channel-deletion reachability verified + pinned, voice-as-Location presence windows.
- **jp36.10 Fleet topology collapse** — `PSFN_MULTI_COMPANION` retired, `companions.json` mandatory (derived topology; one-entry fleet byte-identical to old single mode), helm auto-provisioning + migration doc.

## Review record

- ~60 reviewed units (leaf beads + remediations + seam review). Three per-bead review FAILs, each with an empirically reproduced blocker, each fixed in one bounded remediation and independently re-verified: arbiter double-send (jp36.5.1.1), capsule-custody lost-update/torn-write (jp36.7.1.2), ICP delivering-window fence (jp36.5.2.1).
- Epic seam review (dual-blind): lens A PASS (both P1 candidates downgraded with evidence — autonomous egress is provably un-enableable); lens B FAIL with two wave-introduced gate blockers (unclassified `publication` conformance entry; stale `verify:startup-owner-files` harness), both fixed at `f3f823c7` and re-verified.
- All five orchestrator merge resolutions audited hunk-by-hunk in the seam review: clean.

## Gates on the assembled head

`npm run build`, `npm run lint`, `verify:settings-contract`, `verify:hardcoded-settings`*, `verify:dependency-cycles`, `verify:shared-type-guards`, `verify:model-usage-capture`, `verify:startup-owner-files`, admin-ui `check`: green.
Full `npm test`: 12,636 passed; remaining failures attributed to `origin/main` (postgres-store pgvector expectation; api-routes round-trip pollution — fail identically on main) — inherited, report-only.
(*hardcoded-settings: green for wave constants; a baseline-drift failure for `EXTRACTION_CHUNK_LLM_CONCURRENCY` is inherited from main.)

## Fixes epic (psfn-framework-qgqw) — open children

- `qgqw.1` (P2) contacts hard-deleted vs ratified archive-never-delete semantics.
- `qgqw.2` (P2) deferred memory extraction across a demotion boundary stamps the post-demotion epoch.
- `qgqw.3` (P1) **egress-sender hardening — blocks ever enabling `egressLease.enabled`**: dedupe on post-TTL re-drive, `wrapUntrustedContext` datamark, disclosure-gate keying/routing, draw refund keyed on fencing token, continuation-exhaustion read, code-fence screen (seven consolidated requirements from three review gates).
- `qgqw.4` (P2) Law-36 `breakerFiring` structural record computed but unsurfaced.
- `qgqw.6` (P2) wire the deferred free-time workspace seams (project-driven sessions, contact-DM resolution, lineage capture, segment sanitization, silence/interval invariant).

## Operator decisions requested (report-only)

1. **Unlinked-peer posture** (jp36.5.2.2): design-review R2 option (a) speak-least+jitter implemented per the bead; never formally adjudicated — confirm vs fail-closed-to-silence.
2. **Cross-installation federation transport** (jp36.5.2.1): no repo foundation exists; the bead shipped local signals + the speak-least fallback. File a foundation effort or amend the AC.
3. **One-entry fleet semantics** (jp36.10.1): fleet stores stay OFF for a one-entry manifest per the bead's acceptance; if always-a-fleet should mean full fleet infra, that is a follow-up design decision.

## Rollout notes

- Deployed `charge-policy.json` owner files need the new `socialPot`, `roomEpisodePressure`, and `roomEpisodeCircuitBreaker` blocks (fail-closed load otherwise; seeds carry defaults).
- `scheduler.json` gains the `socialAutonomy` block (omitting it is byte-identical to defaults).
- Existing single-companion installs get `companions.json` auto-provisioned by the chart (`bootstrap.provisionSingleCompanionManifest`), documented in `docs/helm-upgrades.md`.
- One-time maintenance CLIs shipped (manual, dry-run default): `projects:quarantine-legacy-artifacts`, `projects:migrate-free-time-visibility`, `projects:migrate-manifests-v2`.
