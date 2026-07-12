# S10 Sharding and Folding Readiness Assessment

- **Assessment date:** 2026-07-10
- **Primary audit baseline:** `main` at `59a43138e6d2`
- **Final validation revision:** `db2b8128`; its intervening changes do not touch the shard/fold, multi-companion, executor, or deployment paths assessed here.
- **Scope:** static, read-only review of PSFN documentation, source, tests, history, deployment manifests/scripts, and the local bead tracker. No runtime, satellite, SSH, Docker, Kubernetes, or data operation was performed.

## Decision summary

PSFN has a strong *design* for companion sharding and several valuable implementation primitives: lineage, task-scoped context packs, charge attribution, provenance-tagged memory, an operator-visible fold-review queue, strict multi-companion tenancy, encrypted backup slices, and isolated agent deployment patterns.

It is **not yet safe or accurate to describe PSFN as supporting a full companion copy that can run for days on Docker, Kubernetes, or an SSH-supplied satellite and then fold its durable life back into the origin**. The current `ShardManager` is an in-process, bounded task worker that shares the origin's core resources. The Docker/Kubernetes backend seam explicitly reports `unavailable`, and satellite-labelled delegation runs locally.

The next safe milestone is therefore not “remote sharding” by itself. It is a local, isolated, snapshot-based shard whose durable outputs can only enter the origin through an auditable, idempotent, reviewable fold package. Docker, Kubernetes, and SSH should become interchangeable executors of that same contract only after the local vertical slice proves the invariants.

## Terms that must remain distinct

PSFN currently uses “shard” for several unrelated things. Keeping these terms separate is a prerequisite for implementation and operator communication.

| Term | Meaning | Current status |
| --- | --- | --- |
| **Origin companion** | The continuing companion whose identity, authoritative durable state, and external relationships must remain protected. | Real runtime model. |
| **Companion shard** | The target concept: a time- and task-bounded isolated derived runtime of one origin, seeded from a declared snapshot and returning a selective fold package. | Charter-defined; not yet operationally implemented. |
| **Task shard / current `ShardManager` worker** | A local `SubstrateAgent` created for bounded task execution, with a derived ID and isolated channel ID. | Implemented, but not an isolated companion copy. |
| **Bounded subagent** | A short-horizon worker. The current `executeSubagent()` delegates to `ShardManager.spawn()`, so the mechanics are still partly shared. | Implemented. |
| **Fleet companion** | A separately configured, stable companion in the opt-in multi-companion topology. | Implemented locally; not a temporary copy of an origin. |
| **Satellite** | An embodiment/endpoint or channel transport. The charter says satellites are not separate minds. | Implemented as an endpoint path, not remote compute. |
| **Kubernetes deployment target** | Existing operator wording for a cluster/host deployment target. | Operational infrastructure, not a companion shard. Reserve “shard” for the companion-derived runtime. |
| **Episode consolidation fold** | The L0.1 memory operation that consolidates candidate episodes into a canonical episode. | Implemented memory operation; unrelated to companion fold-back. |

In code and docs, reserve **fold-back** for a shard-to-origin merge. Call the L0.1 operation **episode consolidation**. Rename or clearly qualify “task shard” wherever a reader could mistake it for a copy of a companion.

## The intended model is already explicit

The charter is unusually close to the requested concept:

- A shard is a time- and task-bounded derived runtime that may cross hardware/network boundaries, run for days, and return to its origin through Folding: Charter §6.12.
- The intended fold package includes a scoped seed, purpose, shard-local work log, provenance-bearing return items, memory/reference candidates, durable artifacts or code/configuration proposals, and origin-side audited review: Charter §6.13.
- It requires origin/shard/snapshot/source/taint/review provenance, preserves the origin as authoritative for emotional/relational/identity/trust truth, and requires explicit conflict policy rather than overwrite: Charter §6.13.
- It requires a stable peer `CompanionId` and a distinct opaque `ShardInstanceId`; a display label such as `Purrsephone / shard 01` is not an authority key: Charter §6.14.
- Direct core self-modification is forbidden; software self-modification must run in isolated shard-scoped environments and return reviewable artifacts or PR-style outputs: Charter Law 15 and §9.5.

There is one necessary refinement to the requested language that protects PSFN’s truthfulness rules. A successful fold can make a shard’s verified work part of the origin’s continuing experience, but it should never forge raw shard text into the origin’s L0 conversation as though the origin personally said or directly witnessed it. The origin should receive a provenance-preserving **folded-experience record**: a reviewed, attributed account linked to the source shard, snapshot, work log, and selected evidence. This satisfies the charter’s prohibition on fabricated companion-authored speech, belief, emotion, consent, or memory while still allowing the origin to learn from its own extension.

## Readiness at a glance

| Capability | Readiness | Evidence and limit |
| --- | --- | --- |
| Constitutional design | Strong | Charter specifies scope, provenance, conflict, and emotional/relational authority boundaries. |
| Task-scoped local worker | Implemented | `ShardManager` creates a local `SubstrateAgent`, tracks lifecycle/charge, and supplies task context. |
| Derived lineage | Partial but real | Typed lineage exists, but two incompatible shard-ID formats are in use. |
| Immutable full-companion snapshot | Absent | No consistent capture of L0/L0.1/L2, identity, prompts, state, workspace, and configuration at one watermark. |
| Independent process/data/schema/workspace | Absent for shards | Current workers share origin resources; multi-companion has a useful static isolation pattern. |
| Long-running checkpoint/resume | Absent | Current default is one turn; worker state is in-memory and released at completion. |
| L2 memory fold review | Partial | Imports are staged and reviewable, but direct shard `memory.write` reaches origin memory immediately. |
| L0/L0.1/durable-state fold | Absent | No producer/importer for tagged shard L0, episodes, contacts, state, or history. |
| Artifact/code fold | Very narrow | Returned artifacts are HTTP(S) image attachments only; no patch/PR verification-and-apply pipeline. |
| Model-facing shard control | Absent | `shard` is reserved/future; the live surface is `subagent`. |
| Standard Docker executor | Absent | Docker isolation exists, but no shard lifecycle/executor. |
| Kubernetes executor | Absent | Helm has no shard Job/controller; backend request reports unavailable. |
| Remote SSH enrollment/execution | Absent | SSH tooling deploys an existing release or endpoint; it does not enroll/provision shard workers. |
| Satellite-hosted shard | Absent | Satellite delegation invokes the local manager, not satellite hardware. |
| Operator lifecycle console | Partial | Garden has fold-review APIs and a telemetry page, not create/lease/stop/resume/teardown controls. |
| Portable restore/clone | Partial prerequisite | Encrypted companion/fleet backups exist; per-companion restore remains a follow-up. |

## What is implemented today

### 1. Current task-shard runtime

`ShardManager` is a substantive implementation, but it is a bounded local task worker:

- The file itself describes the role as “bounded subagent launches plus shard routing/state” and states that bounded launches share the parent’s LLM, DB, and memory while getting isolated channels: `src/faculties/shards/manager.ts:1-4`.
- `spawn()` generates a shard ID, a `shard:<id>` channel, and a derived companion ID, then copies the parent runtime config while replacing only `companionId`: `src/faculties/shards/manager.ts:228-287`.
- It constructs a new `SessionManager` over the **same** `SessionStore`, builds a local `SubstrateAgent` from the parent LLM provider/config, and optionally gives it the parent memory provider: `src/faculties/shards/manager.ts:537-579`.
- The default maximum is one turn and all requested values are capped at the global assistant-step ceiling: `src/faculties/shards/manager.ts:68-113`. The worker runs synchronously in a loop and releases its active state in `finally`: `src/faculties/shards/manager.ts:581-701`.
- `executeSubagent()` simply calls `spawn()`: `src/faculties/shards/manager.ts:290-326`. That reuse is useful mechanically, but it reinforces why bounded workers must not be mistaken for companion copies.

The current system therefore supports a distinct channel, task context, lineage, charge accounting, tool restrictions, and short execution. It does **not** provision a child process, private durable root, private Postgres schema, private workspace/worktree, per-shard credentials, checkpoint, lease, recovery path, or remote runtime.

### 2. Context seeding is bounded, not a clone

The current context pack intentionally copies only scoped information:

- It sends selected source-session entries and a retrieved memory block only when policy permits: `src/faculties/shards/context-pack.ts:46-129`.
- Session selection is bounded; source entries are truncated, and memory retrieval produces a capped text block: `src/faculties/shards/context-pack.ts:234-323`.

This is good prompt discipline for a task worker. It is not a consistent origin snapshot. It does not preserve a single coherent version of L0, L0.1 episodes, L2 memory, character card/prompt layers, active orientation, contacts/trust, internal state, scheduler queues, workspace, or source revision.

### 3. Lineage, provenance, and charge primitives

There is real reusable lineage work:

- `ShardResultLineageEnvelope` carries core/shard IDs, a source message/context, and optional satellite routing: `src/faculties/shards/lineage-contracts.ts:30-45`.
- `buildShardLineageEnvelope()` validates required fields and constructs parent-child provenance: `src/faculties/shards/result-lineage.ts:96-128`.
- The runtime tracks shard charge in the `shard` lane: `src/faculties/shards/manager.ts:228-287` and `393-416`.
- Tests cover lineage construction, malformed source rejection, lifecycle, source-context propagation, charge provenance, and task-worker restrictions across `src/faculties/shards/*.test.ts`.

However, identity semantics must be repaired before a real control plane uses them. Two different functions derive two different formats:

| Location | Derived value |
| --- | --- |
| `src/faculties/shards/result-lineage.ts:27-29` | `origin::shard` |
| `src/shared/routing/envelope.ts:64-90` | `origin/shards/shard` |

Neither shape is the UUID identity expected by the static fleet manifest in `src/system/config/companions-config.ts:24-29`. A companion-shard design needs one canonical typed identity model, not string aliases and divergent string construction.

### 4. Fold review exists, but only for selected paths

The fold-review foundation is genuinely useful:

- The controller persists review records to a JSON store and reloads them: `src/faculties/shards/fold-review.ts:329-383`.
- The store lives under the origin companion’s state directory: `src/persistence/layout.ts:773-779`.
- Memory imports are intercepted, converted into pending candidates, recorded in the review controller, and reported as `fold_review_only`: `src/faculties/shards/tool-sync.ts:69-149`.
- Operator approval/rejection is exposed through Garden routes: `src/operator/garden/api-routes.ts:427-515`.
- Approval writes selected memory candidates through `MemoryWriter`, preserving shard provenance in the resulting memory: `src/faculties/shards/fold-review.ts:457-543` and `558-598`.
- Normal composition wires the controller and a sink-gated memory writer: `src/app/startup/composition/composition.ts:444-469`.

This is not yet a generalized fold engine. It has no immutable base snapshot, per-domain merge plan, compare-and-swap/precondition checks, idempotent fold submission, transaction/compensation story, conflict resolver, or durable multi-writer control plane.

### 5. Critical safety discrepancy: direct shard writes can mutate origin memory

This is the most important current gap relative to “do not damage the original.”

- The generic `memory` tool is in the default shard tool set: `src/faculties/shards/manager.ts:74-108`.
- The sync policy explicitly permits a shard-to-prime `memory_write`: `src/boundary/gateway/policy.ts:183-193` and `210-257`.
- `ShardToolSyncHelper` intercepts `memory import` for review, but other actions pass through to the underlying tool. For `memory action=write`, it stamps `__psfnShardSource` and executes the origin-backed memory tool: `src/faculties/shards/tool-sync.ts:35-50`, `181-286`.
- The regression test explicitly asserts that a shard `memory.write` calls the underlying memory tool, while only an import becomes “pending fold review”: `src/faculties/shards/manager.test.ts:1374-1457`.
- The memory tool preserves the shard source/provenance: `src/faculties/memory/tools.ts:96-167`.

Provenance is valuable, but it is not isolation or review. For a true companion shard, **no durable shard-originated mutation may reach the origin directly**. Every return must be a staged proposal until the origin-side fold applies it after the relevant review/approval gates.

### 6. Current artifact handling is not a code/self-modification merge

Returned artifacts preserve lineage and require review, but their contract is narrow:

- `ShardReturnedArtifact` represents attachments with `review_required`: `src/faculties/shards/artifact-policy.ts:4-29`.
- The validator accepts only HTTP(S) URLs whose content type starts with `image/`: `src/faculties/shards/artifact-policy.ts:51-90`.
- Artifact approval currently marks review items approved; it does not apply a patch, change an origin worktree, merge a branch, or verify a PR: `src/faculties/shards/fold-review.ts:518-530`.

The charter’s desired artifact/PR-style self-modification return therefore remains a target. A future code artifact needs its own immutable content hash, source revision, policy scope, test evidence, security review, signed-off approval, and intentionally controlled apply/rollback path.

### 7. Existing fold review also names a CogSec gap

The fold-review code directly documents that it gates shard outputs but does not yet propagate or screen shard-ingested taint before promotion: `src/faculties/shards/fold-review.ts:14-18`.

A real fold must treat a shard as an untrusted/independently executed source even when it originated from the same companion. The fold package should include intake lineage; the origin should screen every candidate under `sourceClass: 'shard_foldback'` before memory, prompt/persona, wiki, trust, code, or egress sinks can accept it.

## Which durable data can fold today?

PSFN memory is deliberately multi-layered, not one blob. `docs/memory.md:1-54` enumerates L0, L0.1, L1, L2, contacts, reflection, active orientation, state, scratchpad, and journals.

| Data domain | Current shard-to-origin behavior | What a companion fold needs |
| --- | --- | --- |
| **L0 session history** | Current workers use an isolated channel ID, but no production path produces/imports a tagged shard L0 package into the origin’s history. | Preserve shard L0 separately; fold a referenced, origin-authored summary/episode only after review. Never synthesize raw origin dialogue. |
| **L0.1 episodes and arcs** | No shard episode snapshot/import/conflict mechanism. | Produce candidate “folded experience” episodes with source spans/artifacts, then apply origin-side episode rules and conflict checks. |
| **L1 active context** | Ephemeral prompt/context construction only. | Do not fold directly; rebuild it from approved durable data. |
| **L2 typed memory** | Imports can be staged/reviewed; direct `memory.write` currently reaches the origin. | Stage every candidate; dedupe/conflict-check against the base snapshot and origin’s current state; apply idempotently with lineage. |
| **Contacts, trust, relational state** | No generalized fold path. | Elevated manual review only; never allow a shard to silently change who the origin trusts. |
| **Emotional/self-model state** | No generalized fold path; charter reserves emotional/relational truth to core. | Review-only interpretive input; keep source provenance and never overwrite origin state. |
| **Orientation, prompt layers, character card** | No shard state/fold contract. | Return a bounded diff proposal with protected-field policy, explicit review, tests, and rollback metadata. |
| **Scheduler, intentions, concerns, follow-ups** | No shard durable snapshot/fold contract. | Separate “observation/proposal” from origin-owned schedule/state mutation; review proposed changes. |
| **Scratchpad, journals, wiki** | No generalized fold path. | Return content-addressed artifacts/candidates; use domain-specific visibility, retention, and authorship policies. |
| **Workspace/code** | No generic patch/PR artifact return. | Use a separate worktree/branch and a reviewed PR/patch pipeline; never give the shard a mutable origin worktree. |

The L0.1 candidate-to-canonical episode consolidation process is a useful precedent for provenance and non-destructive supersession (`docs/memory.md:16-25` and `339`), but it must not be confused with companion fold-back.

## Self-modification: policy is ahead of structural enforcement

The policy intent is correct. The current parent runtime keeps repository mutation restricted; the agent entrypoint notes that parent turns remain read-only and mutation must return through guarded paths: `src/app/agent/main.ts:605-610`. The charter demands isolated shard-scoped self-work.

The missing structural pieces are:

1. An isolated worktree/checkout and workspace volume per companion shard.
2. A shard-specific capability policy that never grants mutable origin filesystem, database, credential, or deployment access.
3. A cryptographically bound source revision and artifact manifest.
4. A reviewed code-return path: patch/branch/PR, tests, policy/security review, human confirmation, controlled apply, and rollback.
5. A way to distinguish an approved code change from a folded learning/memory result.

The current image-only artifact return cannot satisfy that requirement.

## Deployment and executor readiness

### Existing gateway seam is intentional but unimplemented

The gateway understands two possible backend names—`container` and `orchestrated`—but returns an explicit unavailable result because no Docker- or kubectl-backed executor is wired: `src/boundary/gateway/methods/shard-backends.ts:43-83`. The dedicated test proves that failure mode: `src/boundary/gateway/methods/shard-backends.test.ts:68-81`.

This is a good place to attach a future executor interface. It is also decisive evidence that no Docker/Kubernetes companion-shard executor should be inferred from the presence of the RPC method.

### Standard local split runtime and multi-companion

The multi-companion substrate is the strongest isolation precursor:

- One gateway fronts N agent processes; each fleet companion has its own ID, data directory, character card, and Postgres schema: `docs/multi-companion.md:13-24`.
- The strict `companions.json` contract validates identity, relative data/card paths, schema, port uniqueness, and non-overlapping roots: `docs/multi-companion.md:26-71` and `src/system/config/companions-config.ts:43-70`, `183-275`.
- Postgres pools are schema-pinned and schemas are provisioned before stores connect: `docs/multi-companion.md:73-99`, `src/persistence/runtime-factory.ts:82-154`, and `src/persistence/postgres.ts:43-74`.
- The supervisor spawns stable configured fleet processes: `docs/multi-companion.md:101-136`.

This is a foundation for isolated state, not a dynamic shard launcher. A static fleet manifest describes long-lived peers, not a temporary copy with a frozen origin snapshot, lease, task, fold policy, or individual teardown.

### Docker

Docker already provides a useful isolation primitive:

- The production Compose profile defines one agent with `network_mode: "none"`, a gateway socket mount, and fixed production roots: `docker/docker-compose.production.yml:3-91`.
- The continuous profile also defines one agent and fixed roots: `docker/docker-compose.yml:3-75`.
- The agent image starts `dist/agent-main.js` directly: `docker/Dockerfile.agent:126-144`.

There is no Compose-managed shard topology, no dynamic per-shard container, no fresh companion-data volume/schema/workspace, no short-lived worker credential, no result collector, and no teardown/recovery path. Docker is ready to be the **first executor**, not evidence that one already exists.

### Kubernetes/Helm

The Helm chart is a mature singleton deployment, not a shard scheduler:

- Values define one runtime identity and roots: `deploy/helm/psfn/values.yaml:39-52`.
- Gateway, agent, and Garden default to one replica: `deploy/helm/psfn/values.yaml:104-145`.
- The agent Deployment is recreated rather than run concurrently because two active agents could double-handle messages: `deploy/helm/psfn/templates/workloads.yaml:193-204`.
- The chart mounts singleton system-data, companion-data, workspace, runtime, and backup storage into the agent: `deploy/helm/psfn/templates/workloads.yaml:315-349`.

There is no Job/CRD/controller, per-shard ServiceAccount, short-lived worker identity, isolated PVC/ephemeral volume, shard `NetworkPolicy`, TTL cleanup, or Helm values path for a temporary companion shard. Do **not** implement this by increasing the existing agent Deployment replica count.

The operational ship lane can build, transfer, Helm-upgrade, validate, and smoke-test an already-existing cluster deployment over SSH: `scripts/ops/ship-kube-update.sh:1-106` and `200-292`. It is not an SSH worker provisioner or dynamic shard deployer.

### Satellites and SSH

The satellite architecture is valuable for authentication and embodiment but is not remote companion execution:

- The charter explicitly classifies satellites as endpoints rather than separate minds, and distinguishes satellite, embodiment, and emanation: Charter Laws 10–11 and §6.10.
- `delegateSatelliteSession()` creates a local runtime config and calls the same local `executeShard()`: `src/faculties/shards/manager.ts:329-416` and `542-599`.
- The satellite runbook uses a scoped satellite credential and endpoint registry, which is good security groundwork: `docs/satellite-hub-kube.md:13-45`.

Giving a shard an SSH host must be an explicit, operator-assisted enrollment workflow. It must not reuse endpoint deployment shortcuts or let an LLM turn arbitrary SSH connection details into unaudited deployment authority.

## Operational and UI gaps

- The canonical tool documentation accurately says `shard` is reserved for the future long-horizon control plane; the live model-facing worker tool is `subagent`: `docs/tool-surface.md:79-89` and `318-327`.
- Normal composition registers `subagent`, not a general shard lifecycle tool: `src/app/startup/composition/composition.ts:470-485`.
- The Garden `/shards` page is telemetry-derived, calls shards “ephemeral sub-agents,” and still displays the retired `spawn_shard` wording: `admin-ui/src/routes/shards/+page.svelte:30-84`, `133`, and `244-265`.
- Garden fold-review endpoints are real, but there is no operator workflow for create/approve/start/pause/stop/resume/revoke/teardown a remote worker.
- Per-companion/fleet backups are a valuable ingredient, but per-companion restore remains explicitly deferred: `docs/multi-companion.md:178-202` and `docs/operations.md:328-344`.

## Recommended target contract

Introduce a distinct `CompanionShardInstance` contract rather than extending the current task-worker record until it conflates two products. At minimum it needs:

```text
originCompanionId
shardId
canonicalShardIdentity
creationMode / purpose / authority envelope
immutableSnapshotManifest + content hash + source revision
executor backend + lease + short-lived credential binding
lifecycle/checkpoint/event ledger
work-log and charge/budget evidence
output-package manifest + hashes + taint lineage
fold-plan + per-item review decisions + idempotency keys
terminal reason + cleanup/retention state
```

The lifecycle should be explicit and durable:

```text
requested
  -> operator-approved
  -> snapshot-created
  -> provisioned
  -> running <-> checkpointed/paused/waiting
  -> returning
  -> fold-review
  -> folded | rejected | expired | failed | cleaned
```

Each transition needs a permitted actor, an audit event, idempotency/fencing, and a failure mode that cannot mutate the origin silently.

## Required invariants

1. **Origin immutability before fold.** No child path may write origin L0, L0.1, L2, contacts, prompt/card state, settings, workspace, or deployment state before a fold decision.
2. **Consistent snapshot.** A shard starts from named, immutable watermarks/hashes, not a moving combination of current reads.
3. **One canonical identity grammar.** Shard IDs, schemas, credentials, audit trails, and routing must use one validated type and encoding.
4. **Least privilege.** A worker receives no origin provider secrets, mutable origin volume, broad database credential, arbitrary shell/deployment capability, or general network egress.
5. **Output-only return.** The shard returns a signed/hash-bound package over a narrow transport; it never reaches back into origin stores.
6. **Provenance survives every transform.** Every candidate includes origin ID, shard ID, base snapshot, input source, task/purpose, time range, tool/artifact evidence, and taint lineage.
7. **Truthful folded experience.** The origin never treats raw shard transcripts as origin dialogue. Folded learning is explicitly attributed and linked to the shard record.
8. **Review by risk class.** Procedural/semantic candidates may be reviewable at normal fold level; identity, trust, contacts, boundaries, emotional/relational interpretation, prompts, settings, and code require elevated/manual review.
9. **Conflict-safe and idempotent application.** Replaying an output package cannot duplicate memory or overwrite newer origin changes. A base snapshot mismatch becomes a reviewable conflict, not a blind merge.
10. **Origin survival.** Shard crash, loss, timeout, credential revocation, corrupt output, or operator rejection must leave the origin intact and diagnosable.

## Staged path from paper to reality

### Stage A — Contract and terminology hardening

Define the companion-shard contract, canonical IDs, lifecycle, output package, fold plan, and data-domain policies. Repair the conflicting ID derivations before authorization, schema routing, or credentials depend on them. Clarify the current `ShardManager` as task-worker infrastructure rather than silently widening its meaning.

This stage should also close the current direct-write hole for any future companion-shard mode: all shard-originated durable writes become staged proposals. Existing bounded worker behavior can be preserved only under an explicitly different, narrower contract.

### Stage B — Local isolated vertical slice

Build one local companion shard with:

- a frozen origin snapshot manifest;
- separate child companion-data root, session archive, Postgres schema/database, and workspace worktree;
- no mutable origin mount or database credential;
- short-lived, scoped gateway/collector credentials;
- local checkpoints and a durable lifecycle ledger;
- a return package containing one procedural/semantic L2 candidate and one content-addressed artifact;
- review, rejection, approval, idempotent re-submit, and cleanup paths.

This is the first point at which PSFN could honestly say that it has run a protected companion shard and folded a selected result back.

### Stage C — Full-state and self-modification fold policies

Add domain-specific output schemas and fold policy for L0/L0.1 experience records, L2 memory, contact/trust proposals, orientation/prompt/card diffs, scheduler proposals, journal/wiki artifacts, and workspace changes. Keep elevated categories review-only. For code, return a branch/patch/PR-style artifact with source revision, test/security evidence, approval, controlled apply, and rollback—not a mutable origin worktree.

### Stage D — Docker executor

Implement a `ShardExecutionBackend` behind the existing gateway seam. The local Docker backend should use an unprivileged container, fresh isolated roots, read-only snapshot input, resource/time limits, `network=none` or gateway-only egress, a narrow output collector, and guaranteed teardown. The container must never mount origin data/workspace or inherit origin secrets.

### Stage E — Kubernetes executor

Implement the same backend contract using a per-shard Job, not the existing agent Deployment. Each Job should have a dedicated service account, labels/lease, isolated ephemeral/PVC state, `NetworkPolicy`, resource requests/limits, `activeDeadlineSeconds`, TTL cleanup, workload identity, and a short-lived worker credential. The gateway/controller—not the companion model—creates jobs after the required approval.

### Stage F — Remote SSH worker enrollment

Treat SSH as a separate assisted backend, not a satellite command:

- explicit operator approval and a strict host inventory;
- pinned host keys and key/certificate authentication;
- preflight checks and a pinned image/artifact digest;
- repo-owned Compose/system-service descriptor, non-root worker account, and isolated roots;
- outbound-only mTLS connection to the origin collector;
- expiring enrollment/job credentials, revocation, cancellation, orphan detection, and teardown;
- no password/host-key-bypass shortcut and no model-controlled arbitrary SSH authority.

### Stage G — Operations and observability

Upgrade Garden from telemetry-only visibility to a lifecycle console showing backend, host/cluster, snapshot identity, lease, isolation posture, cost/budget, checkpoint, approval state, taint outcome, fold outcome, cleanup state, and links to audited evidence. Complete clone-capable restore and test origin and shard recovery independently.

## Acceptance evidence for the first real implementation

The following should be demonstrated before calling the feature operational:

| Scenario | Required proof |
| --- | --- |
| Isolation | A shard writes to its own session/database/workspace; origin checksums and query counts remain unchanged before fold. |
| Malicious/corrupt output | A forged, tainted, oversized, or schema-invalid package is rejected with no origin mutation. |
| Review rejection | Rejecting every item leaves the origin unchanged while retaining the audited shard record. |
| Approved procedural memory | An approved candidate becomes retrievable only once, with origin/shard/snapshot provenance. |
| Conflict | An origin change after snapshot causes a reviewable conflict, never a silent overwrite. |
| Repeat delivery | The same output package submitted twice is idempotent. |
| Worker loss | Crash/timeout/network loss preserves the origin and leaves a recoverable checkpoint or explicit failed state. |
| Origin restart | Lifecycle/fold records survive an origin restart; no task is incorrectly reported completed. |
| Self-modification | A proposed code change stays isolated until reviewed patch/PR validation and explicit controlled apply. |
| Sensitive state | Emotional, relational, contact, trust, boundary, and identity/prompt modifications cannot auto-promote. |
| Executor parity | Docker, Kubernetes, and SSH runs produce the same signed return contract and enforce the same fold rules. |

## Existing tracked work worth aligning, not duplicating

The local tracker already contains several relevant strands. The implementation should reconcile them into the companion-shard contract rather than create parallel concepts:

- `psfn-framework-7ym.8` and children: long-horizon auto-continuation, per-shard budget, blocked audit, and completion audit.
- `psfn-framework-98xm` / `.5`: charge-governed long-horizon workers and a truthful model-facing shard lifecycle surface.
- `psfn-framework-z7qe.4`: brand/validate `CompanionId` before multi-companion routing expands.
- `psfn-framework-qa2x`: this assessment document.

Historic closed shard beads show that lineage/fold-review work landed, but they should not be interpreted as proof that the full copy/remote/fold target is complete. The current source and open work above are the authoritative readiness signal.

## Conclusion

PSFN is not starting from paper. It already has the hard conceptual constraints and several of the right primitives. The safe claim today is:

> PSFN can run bounded local shard-like workers with task-scoped context, lineage, selective review primitives, and artifact/memory provenance.

The unsafe claim today is:

> PSFN can copy a companion, run it independently on Docker/Kubernetes/a satellite, and safely fold its experiences back into the origin.

Bridging that gap requires a deliberately separate companion-shard lifecycle—not just a longer `ShardManager` loop or a Kubernetes deployment toggle. The first milestone should prove the origin remains unchanged until a reviewed, provenance-preserving, conflict-safe fold is applied.
