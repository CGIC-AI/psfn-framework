# ICP — Intentions, Concerns, Plans & Proactive Initiation

> **Working draft** in `working_docs/docs-gap/icp.md` — promote to `docs/icp.md` after review.
> **System:** `icp` (`system:icp`) · **Code:** `src/core/icp/` (weighted thoughts, initiation) + `src/core/intention/` (appraisal, pending-follow-ups) + `src/shared/contracts/icp-autonomy.ts`
> **Tracker:** `working_docs/docs-gap/TRACKER.md` #3 · **Status:** draft from code @ 2026-08-06

## Orientation

ICP is the intentional companion's autonomy core: **Intentions** (what she means to do), **Concerns** (what weighs on her), **Plans** (how she means to get there), plus the machinery that turns private motivation into a governed proactive initiation. `src/core/icp/` owns initiation candidates, precedence, and felt impulse; `src/core/intention/` owns appraisal bridges and pending follow-ups; `src/shared/contracts/icp-autonomy.ts` is the content-free control-plane vocabulary that crosses the companion boundary without leaking private reasoning.

**Who it's for:** contributors touching proactive outbound, scheduler wiring, or Garden autonomy surfaces, and reviewers auditing consent and charge bounds.

**Fits between:** `scheduler.md` (when reflection fires) → here (what it decides) → `memory.md` (what it remembers) → `channels.md` (where it delivers).

## Mental model

```
Private motivation (never serialized)
   │
   ├─ weighted_thought ─► WeightedThoughtCandidateAdapter ─┐
   ├─ intention       ─► IntentionCandidateAdapter        ─┤
   ├─ free_time       ─► free-time chooser                ─┼─► IcpInitiationCandidate (pending)
   └─ felt_impulse    ─► FeltImpulseInitiation            ─┘      │
       ("would_message" lever, operator ruling D4)                 │
                                                                   ▼
                                   InitiationConsentEvaluator ─► permitted | deferred | declined | rejected
                                                                   │
                                                                   ▼
                                   SocialPrecedence / SpeakingPrecedenceResolver ─► permit (15-min TTL)
                                                                   │
                                                                   ▼
                                   Proactive time gate + outbound gates ─► OutreachOutbox (delivered | suppressed)
```

Two hard invariants:

* **Private stays private.** Eight private fields (`peerContactId`, `reasonSummary`, `continuationTaskKind`, `permitId`, `pendingFollowUpId`, `deliveryDisposition`, `retryAttempt`, `retryEligibleAtMs`) never cross into `IcpInitiationCandidateSharedMetadata` (`initiation-candidate.ts:57`) or the shared arbitration handle (`icp-prov:<uuid>`). The content-free contract (`icp-autonomy.ts:8`) is deliberate — audit all eight, not a subset, when reviewing leakage.
* **Autonomous sending is code-pinned OFF** until `qgqw.3` (P1). The egress lease `enabled` flag is not exposed in owner files (`scheduler-config.ts:50`); only tunables are. Initiation still builds candidates and permits — delivery is the gated half.

## Entry points

| Entry | Location | Purpose |
|-------|----------|---------|
| `IcpInitiationCandidate` | `src/core/icp/initiation-candidate.ts:26` | Durable candidate: `{candidateId, rootInitiationId, source, status, provenanceRef, reasonSummary (private), expiresAtMs, permitId?}` — shared projection is `Omit<private>` (`:57`) |
| `FeltImpulseInitiation` | `src/core/icp/felt-impulse-initiation.ts` | Affect-driven `felt_impulse` source — replaces wall-clock impulse with emo-sim `would_message` lever (operator ruling D4, `icp-autonomy.ts:32`) |
| `WeightedThoughtCandidateAdapter` | `src/core/icp/weighted-thought-candidate-adapter.ts` | Maps `weighted_thought` (schedule-borne deliberation) → candidate |
| `IntentionCandidateAdapter` | `src/core/icp/intention-candidate-adapter.ts` | Maps `intention` store entries → candidate |
| `InitiationConsentEvaluator` | `src/core/icp/initiation-consent-evaluator.ts` | Evaluates candidate against local policy, availability, and charge |
| `LocalPolicyContract` | `src/core/icp/local-policy-contract.ts` | Per-companion initiation policy (quiet hours, block lists, channel mismatch) |
| `SocialPrecedence` / `SpeakingPrecedenceResolver` | `src/core/icp/social-precedence.ts`, `speaking-precedence-resolver.ts` | Two-phase speaking arbiter (reservation + egress-lease) — cheap appraiser + lease window |
| `AgentFacingAutonomy` | `src/core/icp/agent-facing-autonomy.ts` | Companion-visible surface for autonomy state (not authoritative over permits) |
| `ICP_INITIATION_SOURCES` | `src/shared/contracts/icp-autonomy.ts:27` | `free_time | weighted_thought | intention | foreground | felt_impulse` |
| `IcpAvailabilityState` | `src/shared/contracts/icp-autonomy.ts:15` | `available | open_to_chat | busy | resting | do_not_disturb` + `companion|operator|runtime` source + 24h lease TTL |

## Key types

| Type | Location | Purpose |
|------|----------|---------|
| `IcpInitiationCandidateStatus` | `src/shared/contracts/icp-autonomy.ts:40` | `pending | deferred | declined | rejected | permitted | consumed | expired | cancelled` |
| `IcpAutonomyReasonCode` | `src/shared/contracts/icp-autonomy.ts:66` | Stable machine reasons — 33 total (`peer_busy`, `quiet_hours`, `charge_pressure`, `permit_expired`, `recursive_trigger`, `invitation_outstanding`, …) |
| `IcpInitiationCandidateSharedMetadata` | `src/core/icp/initiation-candidate.ts:57` | Projection allowed in shared arbitration — `Omit`s **all 8** private fields: `peerContactId`, `reasonSummary`, `continuationTaskKind`, `permitId`, `pendingFollowUpId`, `deliveryDisposition`, `retryAttempt`, `retryEligibleAtMs` |
| `IcpPermitStatus` | `src/shared/contracts/icp-autonomy.ts:62` | `issued | consumed | revoked | expired` — `MAX_ICP_PERMIT_TTL_MS = 15 min` (`:12`) |
| `IcpAvailabilityState` | `src/shared/contracts/icp-autonomy.ts:15` | Peer presence, `MAX_ICP_AVAILABILITY_LEASE_TTL_MS = 24h` |
| `MAX_ICP_CANDIDATE_TTL_MS` | `src/core/icp/initiation-candidate.ts:69` | `7 days` hard TTL |
| `MAX_ICP_CANDIDATE_REASON_CHARS` | `src/core/icp/initiation-candidate.ts:70` | `1000` char bound on private `reasonSummary` |
| `initiation-lineage.ts` / `initiation-source-runtime.ts` | `src/core/icp/` | Root initiation ID lineage + source runtime binding across retries (`retryAttempt`, `retryEligibleAtMs`, `pendingFollowUpId` reconciliation) |

## Motivational stores (the I / C / P substrate)

The "Intentions, Concerns, Plans" framing names **durable motivational stores** under `src/core/intention/`; initiation candidates are *projections* of these stores, not the stores themselves. **Plans** is a conceptual label, not a separate `plan` store — the deliberate-resolution substrate is realized by weighted thoughts + concern-resolution arcs.

| Quadrant | Store port (`src/core/intention/`) | Lifecycle | Feeds candidate source |
|----------|-----------------------------------|-----------|------------------------|
| **Concerns** | `concern-store-port.ts` — `ActiveConcern` (status / priority / owner / sensitivity / VAD / evidence) | candidate → grooming (`concern-grooming.ts`) → resolution arc (`concern-resolution-arc.ts`, vw3w.2) → resolution appraisal written to the reflection journal | `IntentionCandidateAdapter` |
| **Weighted thoughts** | `weighted-thought-store-port.ts` (Charter 6.24) — `ThoughtWeight` with create / reinforce / top-N | nudge-eligible until accepted; cache hydrated from durable storage on connect (9vi.13 lesson) | `WeightedThoughtCandidateAdapter` |
| **Social desires** | `social-desire-store-port.ts` (epic oth4) — per-contact pressure, keyed by `contactId` (≤1 durable desire per contact) | decay applied at read time, no decay writer across restarts | free-time chooser |
| **Pending follow-ups** | `pending-follow-up-store-port.ts` | durable follow-ups reconciled against action identity at delivery (`pendingFollowUpId`) | candidate delivery |

Every store-port follows one pattern: a backend `Awaitable` interface, a Promise-normalized port wrapper, and a synchronous cache snapshot for the read-hot deterministic trigger paths. **Private motivation never leaves `src/core/intention/` + `src/core/icp/`**; only the content-free `IcpInitiationCandidateSharedMetadata` projection (Key types above) crosses into shared arbitration.

## Data flow

### 1. Candidate creation

Any of four private lanes may propose a candidate with `(peerContactId, preferredChannel, source, provenance handle icp-prov:<uuid>)`:

* Free-time chooser picks a social desire to act on → `free_time` candidate.
* Weighted-thought scheduler → `weighted_thought`.
* Intention store (appraisal) → `intention`.
* Emo-sim `would_message` → `felt_impulse` (replaces wall-clock trigger).

The candidate is persisted with `revision` and `createdAtMs/expiresAtMs` (7-day TTL). Private `reasonSummary` is bounded to 1k chars; shared metadata never contains it.

### 2. Consent + policy evaluation

`InitiationConsentEvaluator` + `LocalPolicyContract` check:

* Availability lease valid and not `do_not_disturb/resting/busy` (or operator override).
* No `invitation_outstanding`, no `recursive_trigger`, no `channel_mismatch`.
* Quiet-hours (`quiet_hours`), charge/fatigue (`charge_pressure`, `cost_hard_stop`), block list (`peer_blocked`).
* Returns `permitted | deferred | declined | rejected` with a shared `reasonCode`.

### 3. Precedence + permit

On `permitted`, the two-phase arbiter runs:

* **Reservation phase** (`reservationPhase` tunables) — cheap participation appraiser selects passive candidates.
* **Egress-lease** — issues a 15-minute permit (`IcpPermitStatus.issued`). Lease expiry → `permit_expired`; replay → `permit_replayed`; companion mismatch → `permit_mismatch`.

The permit is recovered durably as `permitId` bound to `rootInitiationId` even before target-turn delivery (so a crash can reconcile).

### 4. Delivery

`wirePostTurnRuntime()` + `post-turn-outbound-gates` + `proactive-time-gate` enforce:

* Internal channels (`internal:free-time:*`, `subagent:*`) are blocked (fail-closed).
* `pendingFollowUpId` reconciliation across action identities ensures `delivered | suppressed` disposition is idempotent.
* On success, candidate transitions `permitted → consumed` with `deliveryDisposition`; on cooldown-gated retry, `retryAttempt` + `retryEligibleAtMs` govern backoff.

## External dependencies

| Dependency | Purpose | Critical |
|------------|---------|----------|
| PostgreSQL (`icp_*` tables via `persistence/`) | Candidate/permit/availability persistence | Yes |
| `EventBus` | Initiation lifecycle events to Garden | Yes |
| `Scheduler` | Cadence for weighted-thought + free-time → candidate creation | Yes |
| `SessionManager` / `places-registry` | `preferredChannel` resolution | Yes |

## Configuration

| Source | Priority | Example |
|--------|----------|---------|
| `scheduler.json` → `icpAutonomy` + `socialAutonomy.*` | Canonical | `IcpAutonomySchedulerConfig`, `SocialAutonomyConfig` tunables; `egressLease.enabled` code-pinned OFF |
| `channels.json` | Channel binding for `preferredChannel` | `dm` vs `current_room` |
| Memory / intention stores | Motivation content | Not config — candidate inputs |
| Env | Not used | No ICP config lives in `.env` |

Validate with `npm run verify:settings-contract`; `icp-autonomy-scheduler-config.test.ts` is the gate.

## Test infrastructure

| Type | Location | Coverage |
|------|----------|----------|
| Unit | `initiation-candidate.test.ts`, `initiation-consent-evaluator.test.ts`, `felt-impulse-initiation.test.ts`, `local-policy-contract.test.ts`, `social-precedence.test.ts` | Private-→shared projection strips private fields, TTL bounds, D4 `felt_impulse` lever, policy deny/allow, precedence lease |
| Integration | `co-location-thought-adapter.test.ts`, `candidate-scheduler-origin.test.ts` | Thought co-location, scheduler-origin lineage |
| Gates | `runtime-enablement.test.ts`, `speaking-precedence-resolver.test.ts` | Sending pinned OFF until `qgqw.3`, resolver ordering |

## Pitfalls & gotchas

* **Never log or ship `reasonSummary`.** It is bounded private motivation; the shared contract intentionally omits it. Logging it would leak internal reasoning to shared state.
* **Don't mint provenance handles by hand.** Use `parseIcpProvenanceHandle` (`icp-prov:<uuid>`); stale handle → `stale_provenance`.
* **Respect permit TTL.** 15 minutes, then `permit_expired`. Don't cache permits across restarts without rehydrating via store.
* **Autonomous sending is still OFF.** Wiring `egressLease.enabled` to true before `qgqw.3` bypasses the P1 gate — only tunables are exposed for a reason.
* **Deferred vs declined matters.** `deferred` is retryable (with `retryEligibleAtMs`); `declined` is terminal for that candidate. Mixing them breaks backpressure accounting.

## Cross-links

* `docs/scheduler.md` (who creates candidates), `docs/channels.md` (where they deliver), `docs/partner-affect.md` (felt-impulse sidecar signal), `docs/architecture.md#Composition-Layer`, `docs/specifications.md` (proactive outbound gates)

## Promotion notes

Move to `docs/icp.md`; cross-link from `docs/architecture.md` (Core Subsystems → ICP) and `docs/specifications.md` (proactivity). Keep `initiation-lineage.ts` diagram in the promoted doc.
