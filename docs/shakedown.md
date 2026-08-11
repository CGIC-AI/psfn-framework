# Cumulative Recertification

This document defines the public recertification contract for a release
candidate. It describes what a complete shakedown must prove and how its
evidence is identified. Deployment topology, private endpoints, credentials,
companion identities, operator scripts, and run artifacts belong in the
operator's private operations authority.

A recertification is cumulative. It covers the product baseline and the change
since the last accepted candidate. A focused regression pass can support that
work, but cannot replace the cumulative result.

## Pin the candidate and its owners

Freeze one source candidate before collecting evidence. The round record must
contain:

- the full source commit ID and source tree ID;
- the immutable build or artifact revision used by each tested process;
- the previous accepted source revision, when the round is a delta from an
  earlier certification; and
- a sorted fingerprint manifest for every effective startup owner file in each
  system and companion scope.

The owner manifest records the logical scope, canonical owner name, SHA-256
digest, and schema version. It must not copy owner-file contents, filesystem
locations, credentials, identities, or endpoints into public artifacts. Derive
the owner set from
[`describeStartupOwnerFileChecks`](../src/system/config/startup-owner-files.ts)
rather than maintaining another list. `npm run verify:startup-owner-files` and
`npm run verify:settings-contract` establish repository and schema parity; the
private operations authority owns collection of effective deployment
fingerprints.

Any source, build, or owner change invalidates later evidence that depended on
the earlier fingerprint. Start a new round or rerun the affected coverage; do
not silently update the candidate under an open scorecard.

## Evidence classes

Every result identifies its evidence class and the exact candidate revision.

| Class | Acceptable evidence | Insufficient by itself |
| --- | --- | --- |
| Source contract | A focused test or verifier exercising the production contract | File existence, a bead status, or prose |
| Persisted behavior | Content-safe database rows, journals, audit events, owner revisions, or state transitions tied to the probe | A model reply claiming that an action happened |
| Boundary behavior | An allow/refusal result from the production eligibility, authorization, or routing seam | Reimplementing the policy in a test-only evaluator |
| Operator surface | A Garden action followed through its production service to durable state or a bounded refusal | An HTTP success status or screenshot without state evidence |
| Recovery | Restore into an isolated target, verify data and owner fingerprints, then exercise the restored runtime | A completed backup job or archive listing |
| Experience | A structured companion/Partner session with the observation and the supporting runtime evidence kept distinct | Treating self-report as proof of a storage or tool side effect |

Evidence must be attributable without retaining sensitive payloads. Prefer
opaque case IDs, timestamps, content hashes, counters, reason codes, and exact
state transitions. Raw conversations, owner contents, screenshots, and
deployment inventories remain outside this repository.

## Cumulative coverage

Each row needs at least one executed proof or an explicit disposition with an
owner, reason, accepted risk, and revisit condition. The source links identify
the public contract; they do not certify a deployment.

| Area | Minimum recertification proof | Public authority |
| --- | --- | --- |
| CogSec | Exercise clean, hostile, malformed, and dependency-failure intake across `shadow`, `boundary`, and `strict`; prove sink decisions, content-free telemetry, quarantine/release, operator review, and emotion/memory exclusion. | [`cognitive-security.md`](./cognitive-security.md), `src/shared/contracts/cogsec-mode.ts`, `src/core/cogsec/` |
| Garden | Follow settings, memory, identity, CogSec, scheduler, tool-health, recovery, and fleet actions through the production Garden service boundary; assert durable results and bounded authorization failures. | [`garden-control-plane.md`](./garden-control-plane.md), `src/operator/garden/` |
| Memory and biography | Prove L0 session provenance, episodic projection, typed memory, retrieval, current-author biographical claims, contested conflicts, review transitions, and cross-session continuity without collapsing biography into recent interaction shape. | [`memory.md`](./memory.md), `src/faculties/memory/` |
| Automata | Prove bounded automata launch, progress, completion/failure delivery, memory governance, and cancellation. Separately run the Automata Bus v1 conformance corpus; do not claim runtime bus integration from its contract-only reducer. | [`automata-bus-contract.md`](./automata-bus-contract.md), `src/faculties/subagents/`, `src/faculties/automata/bus/` |
| Sessions | Prove append-only recording, routing to the intended logical session, restart continuity, compaction provenance, corruption isolation/repair, and source-addressable recovery. | [`chat-turn-lifecycle.md`](./chat-turn-lifecycle.md), `src/core/session/`, `src/persistence/sessions/` |
| Scheduler and background work | Prove persisted scheduling, restart rehydration, due-time execution, background supervision, failure escalation, rest-window ownership, and no-work idle purity. Elapsed-time evidence is required for cadence claims. | [`architecture.md`](./architecture.md#scheduler-and-background-work), `src/core/scheduler/`, `src/core/agent/background-work/` |
| Tools and routing | Prove registry/help agreement, schema-derived arguments, result propagation, capability refusal and allowance at every tier, model-purpose routing, and recorded model usage. Include `external.mcp`: nursery refuses while apprentice and autonomous are eligible, without using arbitrary external servers as a test oracle. | [`tool-surface.md`](./tool-surface.md), `src/core/agent/tool-surface/`, `src/system/capabilities/` |
| Backup and recovery | Verify encrypted backup contents, PostgreSQL and extension restoration, sessions/workspace/companion slices, owner fingerprints, and post-restore startup in an isolated target. | [`operations.md`](./operations.md#backups), `src/persistence/backups/`, `npm run verify:backup-restore` |
| Fleet | Prove companion scoping, tenant isolation, authenticated Garden routing, session renewal, roster and portal projections, cross-companion denial, and fleet-wide owner posture without exposing private topology. | [`multi-companion.md`](./multi-companion.md), [`fleet-auth-authority-model.md`](./fleet-auth-authority-model.md), `src/boundary/fleet-auth/` |

## Round shape

1. Record the candidate, tree, immutable artifact revisions, owner-fingerprint
   manifest, environment class, and change inventory.
2. Run the public automated floor on the exact candidate: focused subsystem
   tests, `npm run build`, `npm run lint`,
   `npm run verify:repository-hygiene`,
   `npm run verify:startup-owner-files`,
   `npm run verify:settings-contract`, and
   `npm run verify:backup-restore`.
3. Execute production-path proofs for every cumulative coverage row in the
   isolated targets authorized by the private operations plan. Preserve
   continuity-bearing data and use disposable state for destructive probes.
4. Match every source change and coverage row to evidence or an explicit
   disposition. Record failures as failures even when cleanup succeeds.
5. Issue one round verdict with the exact candidate identity, coverage
   disposition, findings, waivers, and residual risks.

A passing round requires all mandatory rows to pass or carry an explicit
operator-approved waiver. It also requires restoration of any temporarily
changed tier or owner state, with the before and after fingerprints recorded.

## Public/private boundary

This repository intentionally provides no universal live-deployment shakedown
harness or runbook. The private operations authority selects targets, provisions
credentials and dedicated test sinks, protects continuity-bearing data, stores
evidence, and defines cleanup. Public source and tests define the behavior to
prove; they do not assert that any particular installation has passed it.
