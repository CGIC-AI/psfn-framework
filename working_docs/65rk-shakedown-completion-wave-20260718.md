# 65rk release-shakedown completion wave — 2026-07-18

Feature branch: `feat/65rk-shakedown-completion` (reconciled with origin/main after PR #105 merged).

## Closed implementation beads (this wave)

- `psfn-framework-65rk.3` — Sprint 10 persisted-proof cases. work/65rk-s10-cases@33bfea9de0, integrated f48f755dac. Modular catalog `cases/sprint10/`, persisted-state proofs (`lib/persisted-proofs.mjs`), SSE fail-closed probe, scorecard artifact gating. Final check verified 6/6 remediation items.
- `psfn-framework-65rk.8` — shakedown-lite profile. work/65rk-lite-profile@e04fc79153 + remediation @7d3e2a0eb7, integrated abd6b400f6. `--profile lite|full` wrapper, declarative lite manifest, lite-only scorecard stamping/attestation. Verified P0 fixed: matrix child now runs in its own process group so deadline/signal termination lets the bash EXIT trap restore the capability tier; strengthened test proven to fail on pre-fix code.
- `psfn-framework-65rk.9` — coverage appendix extension. work/65rk-appendix@dbdb6a7663, integrated ec2077a532. 17 new rows (July hardening + Sprint 11), dangling refs fixed (s10f8→s10mc.8, s10f1→s10d6), new cases `model_lane_attribution` and `backup_encryption_roundtrip` (`cases/hardening.mjs`, `lib/hardening-proofs.mjs`). Blind review PASS, zero blockers.

Previously closed on this branch: `.2` (isolated bootstrap), `.4` (disposable support companions; also merged to main independently as PR #105), `.6` (22-token capability/refusal matrix + tier-conformance sweep).

## Review gates run

Per-bead: UBS baseline on every range (all criticals triaged as harness/fixture false-positives); blind adversarial review alternating Pi/Opus; every claimed blocker independently verified. One verified P0 total (65rk.8 signal-safety), one bounded remediation.

Epic seam review (dual blind, Opus + Pi): both PASS with zero blockers over merge-resolution diffs, multi-bead files (`run-tests.sh`, `live-system-shakedown.mjs`, `shakedown-scorecard.mjs`, `coverage-map.json`, `docs/shakedown.md`), and the lite/full composite contract traces.

## Nonblocking observations (report-only, no beads)

1. `model_lane_attribution` and `backup_encryption_roundtrip` are opt-in (no default tier list); `backup_encryption_roundtrip` requires `PSFN_SHAKEDOWN_SETTINGS_SAVE_PATH`/`_BODY` (fail-closed without). A bare default full round scores those two appendix rows RED until the operator opts the cases in — document in the round procedure; not a regression.
2. `.4` coverage IDs (`multi_companion_crossover_isolation`, `icp_durable_turns_restart`, `icp_fatigue_closeout_reserve`) are covered only when the support-companion artifact is fed to the scorecard. Fail-closed by design.
3. Lite attestation `complete` does not itself require `conformance.matches===true`; safety currently rides on the matrix `set -e` exit path. Defense-in-depth candidate for a future round.
4. Live `model_lane_attribution` may be brittle against `slot_key='unknown'` background rows (fail-closed RED, never false-pass) — live-tuning concern for the next round.
5. Lane/surface value lists in `lib/hardening-proofs.mjs` are hand-mirrored from `charge-policy.ts` (in sync today; drift → fail-closed RED only).
6. CogSec two-step Garden discard path is exercised against a live admin surface only in a real round; unit coverage is fixture-level.

## Remaining 65rk scope (not this wave)

- `65rk.10` companion UI / PWA e2e lane, `65rk.11` satellite hub e2e lane — operator-directed "scope next round" placeholders; both need live deployments.
- Epic `65rk` stays open until those and the release rounds complete.
