# Cognitive-Security Follow-Ups — Notes

- **Date:** 2026-07-09
- **Author:** Fable (orchestrator), after integrating the 18-bead `htm9` cognition-intake-firewall epic
- **Bead batch:** [`cogsec-followup-beads.jsonl`](./cogsec-followup-beads.jsonl) — epic `psfn-framework-cgsf` + 14 children (`cgsf.1` closed same-day)
- **Branch:** `feat/cogsec-intake-firewall` (merged with `origin/main`, tip moving)
- **Related:** [`COGSEC_INTAKE_FIREWALL_RESEARCH_20260709.md`](./COGSEC_INTAKE_FIREWALL_RESEARCH_20260709.md) (design brief), `FABLE_AUDIT_REVIEW_S10.md` (on branch `docs/fable-audit-review-s10`), [`cogsec-intake-firewall-beads.jsonl`](./cogsec-intake-firewall-beads.jsonl) (the epic itself), [`cogsec-evals-beads.json`](./cogsec-evals-beads.json) (eval-repo items)

---

## Why this file exists

The beads Dolt server was unreachable from the checkout for the entire implementation session, so this batch is a file for later import (tracked by `cgsf.8`). It is also the honest post-mortem of a large push: what shipped, what didn't, and — more usefully — **how we found the thing that didn't**.

## How this list was derived

Not from memory or intent. Every bead below is anchored to a command that was run against the integrated branch:

- `grep -rn 'evaluateL2|evaluateL3' src/ --include='*.ts' | grep -v '\.test\.ts'` → found `cgsf.1`.
- `grep -rn 'createIntakeSinkGate|canaryEgressGuard|driftVelocityReview' …` → confirmed sink gates, canary, and both drift lanes **are** wired to live entrypoints.
- `node scripts/identity-literal-scan.mjs` on `origin/main` and on the branch → `cgsf.7` (41 vs 69 violations; main was already red).
- `npx vitest run` on `origin/main`, on `245ab94e` (pre-pi-bump), and on the branch → `cgsf.11` (identical 76 failures everywhere; not ours).
- Reading `config/intake-policy.seed.json` → `cgsf.3` (`unscreened: "allow"` on all six sinks) and `cgsf.4` (`mode: "shadow"`).

The rest come from the implementing agents' own final reports, where each explicitly named what it left undone. Those admissions are the most valuable artifact of the whole session; they are quoted verbatim in the bead descriptions rather than paraphrased.

## The one that matters: L2/L3 were dead code (`cgsf.1` — **now fixed**, commit `2837dd2e`)

> **Resolved 2026-07-09.** Escalation is live gateway-side via an
> `IntakeEscalationPort` (`src/boundary/gateway/intake/escalation.ts`), composed
> in `compose-screening.ts`. The agent process holds no escalation port and
> stays L1-only by construction. Re-verified after integration: the call-site
> grep below now resolves, and the chain `gateway/main.ts` →
> `privileged-core.ts` → `composeGatewayIntakeScreening` → escalation port →
> `evaluateL2`/`evaluateL3` is complete. The section below is kept as written
> because the *lesson* outlives the bug.
>
> One consequence surfaced by the fix and beaded as `cgsf.14`: `image_ocr` is
> `hostile` tier and mandatory at both L2 and L3, so in enforce mode every
> benign image is delivered as an L3 safe representation rather than verbatim
> OCR. That is what the shipped policy demands; whether it is what we *want* is
> a product decision that needs `cgsf.2`'s data.

`evaluateL2`, `evaluateL3`, and `applyL3ScreeningOutcome` were fully implemented and heavily unit-tested. **Nothing called them.** The live path was `IntakeScreeningService.screen()`, which ran L1 scanners plus the L1.5 ONNX scorer and returned; `compose-screening.ts` never constructed an escalator.

So the firewall, as first merged, was only its **deterministic half** — envelope + taint, L1 scanners, L1.5 classifier, vision screening, sink gates, quarantine, drift lanes, canary — while every L2/L3 policy knob in `intake-policy.json` sat inert.

**Why it happened, because this will happen again.** `htm9.6` (L2) and `htm9.7` (L3) each ended their reports with a variant of *"runtime wiring into the live screening service remains with the htm9.3 decision layer."* `htm9.3` (sink gates) scoped itself, correctly per its own bead, to sinks. Neither agent was wrong about its bead. The wiring lived in the seam between two tickets, and **unit tests could not see the seam** — each screener's tests passed against a directly-constructed instance.

**The lesson worth keeping:** for a layered system, per-layer tests prove the layers, never the layering. The acceptance criterion for `cgsf.1` is deliberately an end-to-end test through the *real composed service* with only the HTTP transport mocked. Had that test existed for L1.5, the same gap in L2 would have been caught the day L2 landed.

Secondary lesson: an agent that says "wiring belongs to another bead" is filing a dependency, not completing one. Treat that sentence as a bead-creation trigger.

## Verified wired (do not re-audit)

| Subsystem | Entry point | Evidence |
|---|---|---|
| Sink gates | `src/app/agent/core-runtime.ts:218` | `maybeCreateIntakeSinkGate` |
| Canary egress | `src/boundary/gateway/approval-boundary.ts:92`, `server.ts` | `canaryEgressGuard.inspect` |
| Drift + second-arrow lanes | `src/app/agent/main.ts:1000,1037` | policy-gated lane construction |
| Vision screening | `src/app/agent/core-runtime.ts:370` → RPC `intake.screen_image` | `screenImageIntake` |
| L1 + L1.5 screening | `api-surface.ts:76`, `web.ts:709`, `voice-turn-runtime.ts:236`, file-ingest | `screening.screen(...)` |

## Sequencing

```
cgsf.1 (L2/L3 wiring, P0)  [CLOSED 2026-07-09, commit 2837dd2e]
   └─> cgsf.2 (measure cost/latency in shadow)
          ├─> cgsf.14 (benign-image delivery: OCR vs safe representation)
          └─> cgsf.4  (flip shadow -> enforce)   <-- the bead that makes the epic real
cgsf.3  (per-sink unscreened posture)  ──────────┘
cgsf.9  (ONNX weights + owner file on hosts) ─────┘

cgsf.10 (satellite certs) — deploy-blocking the moment the branch merges
cgsf.7  (identity-literals sweep) — do once, post-merge
cgsf.8  (tracker reconcile) — blocked on the Dolt server
```

Independent: `cgsf.5` (canary reverse-RPC seam), `cgsf.6` (release delivery path), `cgsf.11` (sandbox), `cgsf.12` (dedup, needs production data), `cgsf.13` (pi-agent upstream, deferred by operator).

## Two things that are decisions, not bugs

1. **`unscreened: "allow"` on every sink** (`cgsf.3`). Enforce mode still fails open for any path that doesn't produce an envelope. That is the correct rollout posture — but it means "enforce" is narrower than the word suggests until every inbound surface is enveloped. Flip the state-mutation sinks (`persona_mutation`, `trust_mutation`) to `deny` first; they already cap at `maxSourceRiskTier: standard`.

2. **Shadow is the default** (`cgsf.4`). The entire stack observes and blocks nothing until an operator changes one key. The characteristic failure of a security sprint is shipping a firewall nobody turns on. `cgsf.2` exists so the flip is made on measurements rather than nerve.

## Locked decisions — do not re-open during follow-up work

These were operator calls during the epic and are not up for revision by a passing agent:

- Companion-facing notices are **calm and truthful, never alarming**; firewall activity carries a signature phrase that **excludes it from the emotion/stress model** and from memory candidacy. This is the heart of the design, not a nicety.
- The drift and second-arrow lanes **never auto-mutate** memory, trust, or emotion. They raise operator review cards. `htm9.15`'s consolidation applies memory *supersession* (never deletion) and only on explicit operator approval.
- Quarantine **release is operator-only**, with a server-side double-confirm token — the UI modal is a mirror of that check, not the check itself.
- **Genuine repeated concerns must not be suppressed.** A real ongoing problem legitimately recurs; the second-arrow detector targets near-duplicate, bursty, self-sourced stacking, not recurrence as such.
- **Trusted origin ≠ safe.** Everything gets at least L1; trusted-list hits lower the effective tier by exactly one step and never below `trusted`.

## Residual risk accepted (documented, not beaded)

- **Pixel-perturbation and steganographic attacks on the downstream vision model have no deployable detector.** `htm9.8` mitigates by keeping `image_ocr` provenance at `hostile` tier regardless of how clean the VLM transcript reads — a benign transcript never upgrades trust. Documented in code at the decision site.
- **L2/L3 are probabilistic layers.** They reduce noise; the structural layers (envelope, taint propagation, sink gates) carry the guarantees. If an escalation layer is wrong, a sink gate should still hold. Keep it that way.
