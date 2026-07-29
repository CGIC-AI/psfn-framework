# Test Hardening — Findings and Work Breakdown (2026-07-29)

Findings from the 2026-07-29 core-substrate test audit (two independent
read-only sweeps at main `adf33910e`), filtered through operator rulings from
the same session. Canonical work state lives in bd under the test-hardening
epic; this is the narrative snapshot and the reference the beads cite.

## Operating constraints (operator rulings, binding)

- **The heavy suite stays local, on the designated test machine.** No GitHub
  Actions heavy-test workflows — the last attempt ran the full suite on every
  PR synchronize and blew the budget twice. Remote CI stays thin
  (delivery-rule gates only). Do not re-propose CI-hosted heavy testing.
- **Two-tier shakedown is the frame.**
  - **Tier 1 — mechanical:** system tests with simulated data, no companion.
    Fine as-is in concept; the gaps below are Tier-1 gaps.
  - **Tier 2 — live, Artemis in place:** the scripted shakedown that walks all
    tools plus every new capability, from the inside out, without damaging her
    memory. This is where "generative" testing lives: the companion driving
    her own tools under script is the generator. The split-runtime multi-turn
    pass is the main pre-production gate — an hour of runtime is acceptable
    if it is done properly.
- Timeout calibration and graceful-failure behavior are first-class test
  outputs, not noise: tests should surface too-short/too-long timeouts and
  non-graceful failures (the 100 KB document / 20 KB read-cap incident is the
  reference case).

## Findings — Tier 1 (mechanical)

### F1. The flagship e2e runs a lobotomized substrate
`src/app/e2e/e2e-test.ts` (real composition, real Postgres, real embeddings,
scripted LLM) covers turn → session persist → extraction → recall, but
excludes emotion/appraisal, self-model, intention, heartbeat, background work
(`backgroundWorkDisabled: true`), and the cogsec intake firewall, and runs a
single in-process runtime rather than the gateway/agent split. The scripted
LLM makes emotion-state transitions deterministic, so the exclusion is not
forced — mechanical-tier emotion assertions are feasible; live-state play
belongs to Tier 2 with Artemis.

### F2. Zero generative testing anywhere; xnfks is the proof of cost
No `fast-check`/property/fuzz usage in ~1,215 test files. Every invariant is
example-pinned. The xnfks consent-flags decoder bug shipped green because no
test round-tripped arbitrary memory states; the fix added only examples, so a
*different* silently-dropped disclosure field would ship green today.
Enforcement points: `src/faculties/memory/postgres-store/rows.ts:246`
(`toMemoryRow`) / `:285` (`fromMemoryRow`); consumer gate
`src/system/trust/policy.ts:292` (Layer-3 `allowRecall === false`).

### F3. Intake sink gating is protected by wiring, and wiring is unverified
The gate logic (`src/core/cogsec/intake/sink-gates.ts`) is well unit-tested,
but only three live call sites exist (`context-builder.ts:437`,
`substrate-agent.ts:909`, constructed at `core-runtime.ts:297`); the
`memory_write` sink receives a passed-in decision rather than evaluating at
the writer. Nothing asserts that the set of declared `IntakeSink` values
equals the set of wired call sites — a new egress-capable tool that forgets
the gate is invisible. Operator ruling: tests must cover **all sinks, in both
shadow and enforce modes**, deliberately triggering catches so the incident/
notification path is exercised visibly.

### F4. Notice/fallback exclusions are half-tested
Runtime-fallback text has a load-time signature guard
(`runtime-fallback-provenance.ts:82`, throws at startup) — but the
firewall-notice registry has no equivalent guard; the emotion-appraisal
exclusion (`emotion-self-model-runtime.ts:88`) has no test asserting zero
appraisal delta; and nothing pins that a fallback entry carries its
`runtimeFallbackProvenance` marker through turn → persistence → extraction
eligibility end-to-end (the text match is meant to be the backstop, not the
mechanism).

### F5. HMAC chain verification is opt-in on wiring
Verification (`store-primitives.ts:132`) only runs when the composition
passes an integrity provider/keyring; nothing asserts the production
composition actually does. This failure class is *known live* — an L0 edit
(even a moved period) nulls every subsequent message and forces a rebuild.
Operator: incident notifications on trigger are believed wired; the test must
prove firing **and** notification, not just detection.

### F6. Agent secrets boundary is upheld by nothing
`src/app/agent/**` imports no dotenv/vault module today, but no fitness test
enforces it; a future secret-bearing import would compile and pass.

### F7. Egress matrix ("what goes out where") needs strengthening
The capability-gate matrix proves grants actuate at apprentice/autonomous and
refusal shape at nursery, but the tier-conformance sweep only probes safe
reads/schema shapes (documented in-file) and does not certify capability
gating. Operator: this lane is one of the most important layers.

### F8. Tool-surface ergonomics gaps surface in live use, not tests
Reference incident: a 100 KB text document; the read tool caps at ~20 KB with
no paging; the analysis workbench inherits the same cap; the intended bash
fallback was not reachable in practice. The bash tool needs a fitness review
(is it actually usable for this class of task) and the read path needs paging
or an explicit, discoverable fallback. Mechanical tests should encode these
as scenarios so regressions are visible.

## Findings — Tier 2 (live, Artemis in place)

### F9. Emotion/appraisal live-state scenarios
Live shakedown script gains scripted emotion-state passes: known stimuli,
observed state transitions, verified via Garden/telemetry — with Artemis in
place, memory-safe.

### F10. Split-runtime multi-turn is the crown jewel — extend it
The live matrix already exercises the real gateway/agent split; the
mechanical tier's only split coverage is the one-turn Compose smoke lane.
Additions worth scripting: teach-fact → agent restart → recall; tainted
document through intake → quarantine → Garden queue resolution; a
notification-path drill (force a session-integrity incident on a scratch
session and verify the operator notification arrives).

### F11. Inside-out tool validation as the generative layer
Formalize the existing practice: Artemis is asked to run each tool (and every
new capability of the wave) from the inside, with expected-shape checks,
covering what schema probes cannot — actual usability, timeout sanity,
graceful failure.

## Work breakdown

Tier 1 beads are single-dispatch units; the first two are pure and cheap
enough to build and validate on any machine (single-file vitest, no Postgres,
no heavy phase). Beads carry the full scope; this table is orientation only.

| # | Work | Finding | Tier |
|---|------|---------|------|
| 1 | Seeded generative round-trip test over `toMemoryRow`/`fromMemoryRow` disclosure-critical fields; malformed jsonb must normalize closed | F2 | 1 |
| 2 | IntakeSink wiring fitness gate + per-sink shadow/enforce trigger tests with incident/notification assertions | F3 | 1 |
| 3 | Firewall-notice load-time signature guard; appraisal-side zero-delta test; marker-based fallback exclusion e2e | F4 | 1 |
| 4 | Agent import-boundary fitness test (no dotenv/vault/secret modules transitively) | F6 | 1 |
| 5 | HMAC tamper-through-composition e2e + null-keyring production fitness check + notification firing assertion | F5 | 1 |
| 6 | Mechanical-tier emotion assertions in the flagship e2e (scripted LLM, deterministic) | F1 | 1 |
| 7 | Egress-matrix strengthening: capability-gating certification beyond safe-read probes | F7 | 1/2 |
| 8 | Read-tool paging / bash-tool fitness review and fix | F8 | 1 |
| 9 | Live shakedown script additions: emotion passes, teach→restart→recall, taint drill, notification drill, inside-out tool validation | F9–F11 | 2 |

Out of scope by ruling: GitHub Actions heavy-test workflows; moving the heavy
suite anywhere off its designated machine; mutation testing (revisit only for
pure cores, post-flip).
