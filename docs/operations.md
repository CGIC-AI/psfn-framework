# Operations

This is the operator-facing runtime guide for the current repo-owned deployment model.

Last updated: 2026-07-12.

## Daily Runtime Commands

```bash
npm run split
npm run yolo
npm run gateway
npm run agent
npm run operator
npm run agent:docker          # Production profile (network_mode: "none")
npm run agent:docker:continuous # Continuous/dev profile (isolated internal network)
```

- `split` is the standard gateway + agent + operator launcher.
- `split` loads `.env` in the launcher/gateway boundary, then starts agents and operators from separate explicit allowlists. Operators do not reload `.env`; provider and channel credential status reaches Garden only as redacted booleans over the admin transport.
- `yolo` keeps the split runtime but broadens gateway `fs.read` scope across the codebase.
- `operator` runs only the Garden operator surface when you want it separate from the launcher.
- `agent:docker` is the production profile (`network_mode: "none"`).
- `agent:docker:continuous` is the continuous/dev profile on an isolated internal network.
- Use `npm run verify:agent-docker-isolation` after changing compose files or operator docs.

## Multi-Companion Fleet Operations

Multi-companion is an opt-in topology: N agent processes behind one gateway. It
is off by default and byte-identical to single-companion when off. The full
model is in [`docs/multi-companion.md`](./multi-companion.md); this section is
the operator quick reference. Enabling it requires `PSFN_MULTI_COMPANION=1` in
`.env` and a system-owned `companions.json` fleet manifest (seed
`config/companions.seed.json`). Both mismatches fail closed at startup: flag on
with no manifest refuses to start; a manifest present with the flag off refuses
to start.

### Supervisor launcher

`npm run split` (`scripts/start-gateway-agent.sh`) resolves the fleet and, when
multi-companion is enabled, enters supervisor mode: it spawns one agent process
per companion plus one Garden operator process per companion that declares a
`gardenPort`. Preview the redacted spawn plan with:

```bash
scripts/start-gateway-agent.sh --dry-run   # prints the plan; launches nothing
```

Each spawned agent gets a scrubbed environment plus `COMPANION_ID`,
`COMPANION_DATA_DIR`, `CHARACTER_CARD_PATH`, `COMPANION_PG_SCHEMA`,
its derived personal `WORKSPACE_PATH`, `ADMIN_TRANSPORT_SOCKET`, and
`ADMIN_PORT` from the plan. The supervisor is
shared-fate: if any supervised process exits, the whole fleet is torn down.
Manifest-relative data/card paths are resolved to absolute strict subpaths of
`PSFN_RUNTIME_ROOT`; symlink escapes and tuple drift fail before startup. The
launcher also derives separate role-bound gateway proofs for the agent and its
session-integrity worker in both single- and multi-companion topologies. These
proofs are not printed by `--dry-run` and are never passed to Garden operators.

The plan derives one canonical Personal Workspace per companion beneath
`<runtime-root>/workspaces/personal/<uuid>`. It provisions the fleet layout
before process startup and refuses missing, overlapping, symlink-escaping, or
tuple-mismatched roots. The shared root is Garden-governed and is never exported
as `WORKSPACE_PATH`.

Per-companion Gardens use socket admin transport only; network admin-transport
mode is rejected fail-closed under the supervisor.

### Per-companion Postgres schema

Each agent process pins its runtime persistence to its own schema via
`COMPANION_PG_SCHEMA` (see [`docs/setup.md`](./setup.md)). It is an explicit
opt-in, not derived from `COMPANION_ID`; leave it unset for single-companion
(the `public` schema). The schema is created up front on startup and the pool's
`search_path` is pinned to it. One additional `shared` schema holds
cross-companion world data (`companion_presence`, shared-world wiki chunks) and
is provisioned advisory-lock-serialized so concurrently-starting agents are safe.

### Per-companion Discord accounts

Each companion has its own Discord bot identity, configured in `channels.json`.
Discord accounts carry `companionId` (the routing dimension — one companionId
maps to one bot account) and reference their token by env-var name, not inline
secret:

```jsonc
{ "companionId": "…", "tokenRef": { "envName": "DISCORD_TOKEN_ARIA" } }
```

The gateway holds all tokens and resolves each `tokenRef.envName` (or the
credential vault) at load; an inline `token` field is rejected, and an
unresolved/empty token fails closed. Add each companion's bot token to `.env`
under the env var name its account references.

### Fleet status page

The gateway serves a read-only, loopback-only fleet-status surface when
`FLEET_STATUS_PORT` is set (host `FLEET_STATUS_HOST`, default `127.0.0.1`):

- `GET /` and `GET /fleet` — HTML overview of the cluster
- `GET /fleet/status.json` — JSON

It reports, per companion: up/down state, health, last-seen and connected
timestamps, recent violation count, and a link to that companion's Garden. It is
fed by the gateway connection registry plus the fleet roster. Setting
`FLEET_STATUS_PORT` while `PSFN_MULTI_COMPANION` is off fails closed; a taken
port fails closed. Fatigue/charge posture and tool-error counts are a documented
follow-up and are not shown today.

### Fleet backups

See "Backups And Integrity" below for the per-companion-slice / cluster-artifact
/ group-mode model and the deterministic leader-election rule.

## Production Deployment

The repo already contains the system-account installer:

```bash
scripts/system/install-psfn-service.sh
```

What it does:

- creates or reuses a dedicated service account
- stages a repo-owned checkout under the service home
- bundles a Node binary under the app root
- writes the filtered env file under the deployed checkout at `deployment/systemd/psfn.env`
- renders the authoritative unit under the deployed checkout at `deployment/systemd/psfn.service`
- links `/etc/systemd/system/psfn.service` to that repo-owned rendered unit as the only required external pointer
- can optionally run the persistence cutover before enabling the service

Use `--dry-run` first. Keep authoritative env and runtime wiring in the deployed repo tree; do not create shadow service config elsewhere. The installer-owned unit injects the production layout paths and `PSFN_SKIP_DOTENV=true`, while the filtered env file only carries env-owned values that remain appropriate to source from disk.

## Guarded Kubernetes Deploy Pipeline

The live k3s companion updates through a repo-owned, auditable pipeline that
generalizes the manual `scripts/ops/ship-kube-update.sh` flow into a system
action (`src/system/lifecycle/kube-deploy-pipeline.ts`). It runs strictly
inside the self-management approval/audit boundary (least-privilege RBAC and
operator confirmation) and the operator-credential separation: the companion
may *request* a `rebuild` or `deploy`, an operator approves it, and only then
does the pipeline execute. No operator credential reaches the agent path — every
live-touching side effect is delegated to an operator-job runner
(`DeployPipelineRunner`) supplied by the operator composition, never by the
agent runtime (which stays diagnose-only).

Ordered stages, fail-closed. Live workloads are untouched until the final
stage, so any earlier failure yields a record with `liveUntouched === true`:

1. **preconditions** — only committed state ships; a verified backup must exist
   before any companion-data mutation.
2. **archive** — source archived at the exact commit; a sha256 checksum is
   recorded.
3. **gate** — `npm run lint`, `npm run build`, `npm run verify:helm-chart`, and
   the change-scoped tests. Skipped only under a documented, justified
   emergency-recovery run (the justification is recorded).
4. **build** — one image with the exact, non-floating tag and the
   `org.opencontainers.image.revision` label set to the source commit.
5. **import** — imported into the node runtime. `k3s ctr images import` names
   the image `docker.io/library/<name>:<tag>`, so it is retagged to
   `localhost/<name>:<tag>` (`deriveLocalImportRetag`) or the Deployments will
   not find it. Importing does not restart pods; live stays unchanged.
6. **k3d_validation** — local k3d validation runs, or the record carries an
   explicit skip reason.
7. **helm_upgrade** — the single live-mutating stage. Live values are captured
   and *re-supplied* to `helm upgrade` (never `--reuse-values` against a changed
   chart); the record stores only a redacted summary plus a digest, never
   secret material.

`rebuild` stops after the import and produces a validated, imported (deployable)
artifact with live untouched; `deploy` runs through the Helm upgrade. The record
captures source branch/commit, archive checksum, image reference and revision
label, contract hash, gate results, k3d validation, Helm release revision, and
the redacted live-values summary. Node-side rewrites of PVC files must run as the
container `uid 999 gid 999` (mode `0664`) — a root-owned rewrite bricks turns
with `EACCES`.

Sibling surfaces build on the same seams: the post-rollout validation gate and
manual/automatic Helm rollback consume the pipeline record and the
`DeployPipelineRunner` interface; k3d end-to-end coverage exercises the runner
against a throwaway cluster.

### Post-Rollout Validation Gate

After `helm_upgrade`, an optional `post_rollout_validation` stage
(`src/system/lifecycle/kube-post-rollout-validation.ts`) validates the
*live-rolled* companion — distinct from the pre-rollout `k3d_validation`, which
runs an imported image on a throwaway cluster before anything live changes. Helm
reporting "deployed" is not proof of health; this gate is. It is opt-in and
supplied only by the operator-job composition (its own transport, no agent
credentials); the agent path stays diagnose-only.

The gate runs a fixed set of required checks and returns a structured verdict
with per-check evidence and timestamps: agent/gateway/garden rollout status,
Garden `/health` with admin transport up, gateway `/v1/models` includes the
expected companion model route, Postgres pgvector present, Redis `PONG`, agent
readiness (Ready log, no `CrashLoopBackOff`, running image matches the target
tag/revision), a two-turn gateway smoke (served provider matches the request and
the persisted turn record is residue-free), the tool-surface conformance harness
result (reused from x5rt.3, fetched from the new pod's `post_rollout` run), and a
bounded diagnostics scan (reused from x5rt.2) for crash/owner-file/tool-wiring
failures.

Fail-closed is the safety semantics that makes the sibling rollback correct: a
companion that cannot *prove* it is healthy is not healthy. Any check that is
inconclusive, errors, or times out is treated as a **fail**, never a silent
pass. The gate is healthy only when every required check passes; tool conformance
is the sole check that may be explicitly skipped with a recorded reason. An
`emergencyWaiver` with a non-empty justification records a healthy-by-waiver
verdict without running checks (documented, like emergency-recovery for the
quality gate). When the verdict is unhealthy the pipeline fails at the
`post_rollout_validation` stage with the verdict attached to the record.

The verdict (`healthy`, `recommendedAction`, per-check results, and bounded,
already-sanitized log context for rollback debugging) is written to
`<system-data>/state/post-rollout-validation-latest.json` (bounded JSONL history
alongside) on the healthy and unhealthy verdict paths **when the operator-job
composition supplies the `persist` callback** — the stable cross-workstream
contract the Helm-rollback surface reads to decide whether to roll back.
Persistence is opt-in: if the `post_rollout_validation` stage is not composed, or
the gate itself errors before producing a verdict, no fresh verdict is written
and `latest.json` retains the **prior** rollout's verdict. The Helm-rollback
surface must therefore bind on `(release, helmRevision, sourceCommit)` before
trusting a `healthy` verdict, and treat an absent/stale verdict as "no verdict
for this rollout — do not suppress rollback." An `overall: 'waived'` verdict is
an operator emergency assertion with no probe evidence and means "do not
auto-rollback," not "healthy."

### Manual and Automatic Helm Rollback

The rollback surface (`src/system/lifecycle/kube-helm-rollback.ts` and
`src/system/lifecycle/kube-auto-rollback.ts`) enacts and validates a Helm
rollback of the companion release, closing the self-management loop.

**Manual** rollback is the `rollback` self-management action. `helm rollback`
needs full release-management credentials — unlike the RBAC-scoped rollout
restart — so, like the deploy pipeline, the rollback executor holds the
operator-job's own Helm transport and is composed **only** in the operator-job
composition, never on the agent-only path. The companion may *request* a
rollback; an operator approves it through the same x5rt.4 approval/audit boundary
and x5rt.10 credential separation; only then does the executor run
`helm rollback <release> <targetRevision>` and wait for the agent/gateway/garden
Deployments to recover. A rollback whose release does not come back ready is a
**failed rollback** (`rollbackStatus: 'failed'`) that escalates rather than a
silent success. Manual and automatic rollbacks both record to
`<system-data>/state/kube-rollback-latest.json` (bounded JSONL history alongside).

**Automatic** rollback is the deploy job's own safety net (not the agent approval
path): after a self-update, it consumes the post-rollout verdict and rolls back a
failed rollout. Its decision honours the x5rt.7 review contract exactly:

1. **Bind before trusting.** The verdict is trusted only when it binds to the
   current rollout on `(release, helmRevision, sourceCommit)`. A stale verdict
   from a prior deploy is "no verdict for this rollout": a stale *healthy* verdict
   never suppresses a needed rollback, and a stale *failed* verdict never triggers
   one — both surface to the operator instead.
2. **Act once per revision.** After a rollback, `latest.json` still holds the
   *failed* verdict of the rolled-back-from revision. The decision keys on
   `(release, fromHelmRevision)` and consults the rollback ledger, so it never
   rollback-loops. A rollback that ran but failed to recover is still recorded, so
   it is not silently re-fired.
3. **Waived means the operator owns it.** An `overall: 'waived'` verdict is
   surfaced, never treated as health and never auto-rolled-back.
4. **Absent/errored/stale = fail-safe, not auto-rollback.** Auto-rollback fires on
   validation *failure* for the current rollout, not on validation *absence*
   (rolling back an unvalidated deploy is itself destructive). An absent, stale, or
   malformed verdict surfaces to the operator and, crucially, still refuses to
   declare the rollout healthy. When the failed revision is the first-ever revision
   (no previous revision to target), the rollback is a recorded no-op escalation.

### Composed operator job (x5rt.9)

The deploy pipeline, the post-rollout validation gate, and the automatic rollback
surface ship as library seams; **`src/system/lifecycle/kube-self-update-job.ts`
(`runKubeSelfUpdateJob`) is the composition that wires them into one live flow**,
and `src/app/operator/kube-self-update-job-main.ts` (`npm run
operator:kube-self-update`) is the credential-bearing operator entrypoint that
constructs the real docker/helm/kubectl transports
(`src/app/operator/kube-self-update-transport.ts`,
`kube-self-update-validation-transport.ts`). The agent process never imports
these transports, preserving the x5rt.10 credential separation.

The composition enforces the cross-bead contracts at the wiring boundary:

- **Persist is required when auto-rollback is enabled.** The job always wires the
  pipeline's post-rollout persist callback to `writePostRolloutValidationVerdict`
  (and refuses to run auto-rollback without a validation runner), so the safety
  net always has a bound verdict to read — never a stale one.
- **The caller serializes `executeAutoRollback`.** The ledger read-modify-write
  has no lock, so the job funnels every auto-rollback evaluation through a
  process-wide single-flight guard; overlapping jobs never race the act-once
  ledger.
- **Auto-rollback only after the live mutation.** A deploy that fails before the
  Helm upgrade left live untouched, so the job skips rollback entirely.
- **The rollback target comes from `helm history`.** `createLiveRollbackTargetResolver`
  picks the highest `deployed`/`superseded` revision strictly earlier than the
  failed one (never a `failed`/`pending-*` revision); the auto-rollback surface
  additionally rejects any non-strictly-earlier target.

The deterministic wiring is unit-tested off-cluster with fakes
(`src/system/lifecycle/kube-self-update-job.test.ts`,
`src/app/operator/kube-self-update-transport.test.ts`) — this is the mandatory
gate proving the seams are driven, not dead code. Live k3d end-to-end coverage of
the full self-update → validate → auto/manual rollback flow is
`src/app/e2e/kube-self-update-e2e.test.ts`, gated behind `PSFN_K3D_E2E` (`npm run
e2e:kube-self-update`) so normal unit runs need no cluster or docker daemon; it
provisions and tears down its own disposable k3d cluster and never touches
psfn-shard, live namespaces, or any real PVC.

## Host-Specific Storage Validation

Live hostnames, private addresses, device identifiers, mount points, and home
paths belong in the ignored repo-local operator note described by
[`working_docs/private-live-ops.example.md`](../working_docs/private-live-ops.example.md).
Do not commit populated values.

Load the deployment's ignored config before using the generic checks below:

```bash
set -a
. scripts/ops/private-ops.env
set +a

findmnt -T "$PSFN_REPOSITORY_CHECKOUT"
findmnt -T "$PSFN_RUNTIME_DATA_PATH"
findmnt -T "$PSFN_POSTGRES_DATA_PATH"
systemctl is-active "$PSFN_APP_SERVICE" "$PSFN_HUB_SERVICE" "$PSFN_UI_SERVICE"
pg_isready -h "${PSFN_POSTGRES_HOST:-127.0.0.1}" -p "${PSFN_POSTGRES_PORT:-5432}"
```

The path existing is not enough evidence for bind-mounted storage: compare the
`findmnt` source with the expected device recorded in the private note. Keep
repo-owned unit templates under `deployment/systemd/` authoritative; any
supervisor registration outside the repo must remain a thin pointer or an
intentional copy required during early boot.

## Out-of-Process Watchdog Paging

The repo-owned watchdog runner lives at:

```bash
scripts/ops/continuity-watchdog-healthcheck.mjs
```

It is intended to run outside the Purrsephone runtime, usually through the repo-owned systemd user timer templates:

```text
deployment/systemd/user/purrsephone-watchdog.service
deployment/systemd/user/purrsephone-watchdog.timer
deployment/systemd/user/purrsephone-watchdog.environment.example
```

The watchdog checks the configured `systemd --user` service, optional process pattern, and API `/health` continuity contract. It pages through ntfy when the service is down, the health endpoint is unreachable, or continuity checks such as `schedulerHealthcheck` report stale liveness. It persists a small replay guard under the repo-local `data/ops/` default so repeated timer runs do not send duplicate pages for the same unresolved incident until `CONTINUITY_WATCHDOG_REPEAT_PAGE_AFTER_MS` elapses.

Configuration is fail-closed. The service template targets the live checkout at `%h/psfn-framework-source`, requires `deployment/systemd/user/purrsephone-watchdog.env` in that deployed repo checkout, and the script refuses to run without explicit ntfy base URL, topic, and token by default. If a deployment uses a different checkout path, edit the repo-owned template before installation. Copy the example file to that ignored env path and fill in deployment-specific values there. Do not create shadow watchdog env files in `~/.config/systemd`, `/etc/systemd`, `/tmp`, or other off-repo locations.

Dry-run and config validation:

```bash
set -a
. deployment/systemd/user/purrsephone-watchdog.env
set +a
CONTINUITY_WATCHDOG_DRY_RUN=true node scripts/ops/continuity-watchdog-healthcheck.mjs
node scripts/ops/continuity-watchdog-healthcheck.mjs --check-config
node scripts/ops/continuity-watchdog-smoke.mjs
```

The smoke harness uses a local fake health endpoint and dummy dry-run ntfy settings; it does not install or enable the systemd timer.

## Persistence Cutover

Use this when moving from legacy shared `data/` layout into split roots:

```bash
npm run migrate:persistence-layout
npm run migrate:persistence-layout -- --apply
```

The cutover tooling:

- builds a migration plan
- validates source/target conflicts
- copies or relocates artifacts into system-data and companion-data
- writes a migration manifest under the backup area

Production startup should not proceed until the cutover plan is clean.

## Migration Boundary Until Beta

The live alpha migration boundary is defined in [`docs/specifications.md`](./specifications.md). Operationally, keep migration support explicit and temporary:

- Use `npm run migrate:persistence-layout` for legacy shared-root data. Do not keep the old shared root mounted as a runtime fallback after cutover.
- Use continuous/local `DATA_DIR` only for local development and smoke testing. Production must use split roots and fail closed on shared-root or partial split-root wiring.
- Keep `WORKSPACE_PATH` as one companion's Personal Workspace. It must not
  overlap runtime data roots; live Purrsephone personal files live under
  repo-root `purrsephone/`, while active config, databases, sessions, telemetry,
  and identity artifacts remain under runtime data. In a current fleet this is
  not yet a per-companion isolation boundary; see the workspace warning above.
- Treat owner-file drift warnings as cleanup signals, not as permission to keep `.env` as mutable config authority.
- Review config, startup, persistence, and tool-surface changes against the live boundary. If a compatibility path is not named there, reject it, make it fail closed, or track it for beta removal before expanding it.
- When migration-boundary guidance changes, run `npm run verify:settings-contract` and `npm run verify:startup-owner-files` in addition to the affected runtime validation.

## Persistence Backends

PostgreSQL is the only backend for the repo-owned runtime and persistence-aware maintenance commands. SQLite-backed stores, migration readers, and native packages are removed; unsupported backend selection fails before runtime composition.

Operational rules:

- JSONL L0 remains authoritative even when a database mirror is enabled.
- Fast-search tables and indices are projections that can be rebuilt from canonical archive truth.
- Backend-specific adapter code stays behind the port/composition layer.
- PostgreSQL long-term memory requires the `pgvector` extension. Startup and migrations fail closed when `pgvector` is unavailable; there is no supported fallback to `DOUBLE PRECISION[]` scanning.
- If a backend or projection strategy changes, run `npm run lint`, `npm run build`, and targeted parity tests for the affected domains before treating the change as safe.
- If projection drift is suspected, repair from the archive before trusting search results or operator views.
- Use `npm run session:repair:transcript-projection` to rebuild the searchable transcript projection from authoritative JSONL L0 after drift, backend migration, or recovery work.
- The repair utility accepts `--data-dir` and `--sessions-dir` overrides and targets the configured PostgreSQL session projection backend through the port layer.

### Optional Redis session tail cache

Deployments with Redis can enable a bounded hot session tail (settings.json `sessionTailCache: { enabled, maxEntriesPerChannel }`, default disabled). Every session append writes through to one Redis ZSET per companion, channel, and epoch (`psfn:session-tail:<companionId>:<channelKey>:e<epoch>`, score = entry id, GC TTL, trimmed to the bound), and turn-context captures read the recent window from that shared tail — so agent, gateway, and garden see ONE consistent recent view instead of three per-process file caches. Keys are scoped by `COMPANION_ID`, so a fleet sharing one Redis never crosses tails between companions. JSONL journals remain the source of truth and the HMAC chain is untouched: tail rows carry no `_hmac` fields, and on any id overlap the journal copy wins — tail rows are only accepted for ids newer than the journal read (cross-process gap-fill). Journal rewrites (CogSec tombstones, turn redaction, compaction invalidation/regeneration, post-repair reloads) bump a per-channel epoch key (`psfn:session-tail-epoch:<companionId>:<channelKey>`) before AND after the rewrite (the second bump is exception-safe: it runs even when a post-rewrite step throws), which fences every pre-rewrite row away from every process; a failed epoch bump fails the rewrite loudly (redaction is fail-closed). Tail writers bind to the epoch captured with their data, so a delayed write can only land under an already-superseded key, and readers re-check the epoch after the range read, treating any change as a miss. Reads validate id contiguity across the window (non-message journal entries appear as explicit id-gap placeholders), and any hole, duplicate, or tail missing the just-recorded entry is treated as a miss (journal read + repopulate). The Redis connection reuses the shared env wiring (`PSFN_REDIS_URL` and related TLS/credential vars, forwarded to the agent by the split launcher); enabling the tail with Redis unavailable fails startup, while a runtime Redis outage degrades loudly (rate-limited warns) to journal reads without dropping turns.

## Group-Room Memory Operations

Group-room memory exists to make multi-human Discord-style rooms produce useful, attributable memories without changing the direct/1:1 extraction path. Direct conversations keep the lightweight response-turn cadence and the normal two-write default. Group rooms use JSON-owned windows, observed-message triggers, salience selection, per-contact caps, watermarks, and profile-coverage refresh because high-volume rooms need bounded range processing instead of a tiny conversational tail.

Configuration owners:

- Global defaults live in `settings.json` under `groupMemory`.
- Discord/channel overrides live in `channels.json` under `discord.groupMemory`.
- `memoryMode` may be `direct`, `group`, or `auto`. Use `direct` for ambiguous 1:1 channels, `group` for known group rooms, and `auto` when provider topology plus recent participant count is reliable.

Live group windows should be tuned to channel velocity. The expected default shape is 50-100 recent messages, not one fixed large live batch. Increase or decrease `onlineExtraction.observedMessageTriggerCount`, `onlineExtraction.maxMessagesPerChunk`, `onlineExtraction.backlogLagTriggerMessages`, cooldowns, and write caps in JSON when a room is unusually fast or slow. Use bounded backfill for old history.

Garden diagnostics:

- `GET /api/admin/group-memory` lists group-memory health across channels.
- `GET /api/admin/group-memory/<url-encoded-channel-id>` shows one channel.
- Diagnostics include channel classification, manual override source, resolved config, head message ID, group-memory watermark, lag, last processed/skipped/failed span, salience candidate counts, parsed facts, accepted writes, rejection breakdown, write-cap skips, ambiguous attribution skips, and per-contact memory/profile coverage.
- Diagnostic payloads are redacted: they expose IDs, counts, reasons, config, and coverage, not raw transcript text or memory text.

Low-yield triage:

1. Confirm the channel class is `group` or group-capable. If auto mode is wrong, add a channel override.
2. Check the resolved `groupMemory` config in diagnostics. Make sure the participant window, trigger count, chunk size, cooldown, salience threshold, and caps match the room's velocity.
3. Check watermark lag. Lag with no extraction usually means thresholds/cooldowns are too conservative or a prior in-flight extraction is blocking.
4. Check salience telemetry. High `low_signal`, `duplicate_repetition`, or `below_threshold` counts mean the room is mostly chatter or the threshold is too strict.
5. Check `rejectionBreakdown`, `writeCapSkips`, and `ambiguousSpeakerSkippedCount`. Cap skips mean writes are being intentionally throttled; ambiguous skips mean the LLM output did not provide enough structured source/subject attribution.
6. Check per-contact profile coverage. A contact with activity but no profile usually lacks enough accepted source memories or is inside profile cooldown.

Safe group-history backfill:

1. Inspect diagnostics first and choose an explicit message or time range. URL-encode channel IDs in API paths.
2. Dry-run before writing:

```bash
curl -X POST "$ADMIN_URL/api/admin/group-memory/$CHANNEL_ID/backfill" \
  -H "content-type: application/json" \
  --data '{"mode":"dry_run","startMessageId":1,"endMessageId":500}'
```

3. Review planned chunks, candidate source message IDs, estimated LLM calls, deferred backlog, and privacy flags. Dry-run must not include raw transcript text or memory text.
4. Run live with limits at or below the JSON policy ceilings:

```bash
curl -X POST "$ADMIN_URL/api/admin/group-memory/$CHANNEL_ID/backfill" \
  -H "content-type: application/json" \
  --data '{"mode":"live","startMessageId":1,"endMessageId":500,"maxMessagesPerRun":120,"maxChunksPerRun":3,"maxLlmCallsPerRun":3}'
```

5. Stop behavior is fail-closed. A failed extractor call does not advance the watermark. A no-salience chunk is marked skipped so normal resume can keep moving. Rerun with `resume:true` to continue from the watermark; use `resume:false` only for an explicit bounded repair of a known span.
6. Backfill preserves existing memories and writes through the same dedupe, attribution, salience, write-cap, and profile-refresh path as online group extraction. There is no destructive bulk rollback path in backfill. If a bad memory is written, remove or supersede that memory through the normal memory repair/deletion workflow using its provenance.

Privacy boundaries:

- Observed group extraction schedules memory work only; it must never send a Discord response.
- Group memories retain source speaker, source contact, subject contact when known, trigger contact when applicable, address mode, source message IDs, and source spans.
- Structured source metadata is required for safe cross-contact facts. Ambiguous or conflicting mixed-speaker attribution fails closed.
- Retrieval privacy remains contact/trust scoped. A person sharing a group room with the companion does not gain access to another person's private memories.

Multi-companion rooms (charter gate, Law 26 / 8.10):

- Peer companions (contacts flagged `isMachineIntelligence`) may share a room with the companion. When one speaks, it is treated as an OBSERVED participant: its turns are attributed in history, it appears in the participant roster, and group-memory extraction weights it (see `groupMemory.autoDetection.includeAiCompanions`). It is never selected as the canonical human for any binding (DM/room scope contact, core-memory participant subject, or contact-continuity fallback). A companion binds normally only in a genuine 1:1 DM with that companion.
- Companions replying to companions in a live conversational room is a separate,
  gated capability. The shipped fatigue, social-continuation, permit, and cost
  gates bound machine-intelligence-triggered turns and prevent recursive
  companion-to-companion reply loops. Observation is always supported;
  autonomous replies and initiation are allowed only while the deterministic
  policy and recovery-safe permit state remain eligible.

### Machine-intelligence auto-tagging (E7.3)

- Peer companions are identified automatically. When Discord reports a message author as a bot (`author.bot`), the runtime tags the resolved contact `isMachineIntelligence` at contact resolution time (provenance-honest: sourced from channel bot/app metadata, recorded under a `system:channel_observation:<channel>` audit actor). No manual tagging is required for fatigue relationship classes to apply.
- Operator control wins. A deliberate correction — the Garden/contacts surface or the `set_machine_intelligence` contact tool (any non-`system:` audit actor) — is never clobbered by re-observation. To pin a bot as not-a-companion, correct an auto-tagged contact from the contacts surface; the correction survives.
- Telegram currently ignores bot-authored messages entirely (the adapter drops `is_bot` senders), so there is no observed-contact path to tag there yet. Enabling bot-author observation on Telegram is a prerequisite follow-up before MI auto-tagging applies to that channel.

### Enabling and tuning fatigue for companion rooms

Fatigue evaluation is always wired and always runs, but it only ever SPENDS on machine-intelligence-triggered turns (a machine-intelligence peer whose turn is itself triggered by a machine intelligence). Human turns, and turns with a non-MI peer, are always free — the guard never bounds human conversation. Enabling companion-to-companion chat for a room is therefore two operator actions plus tuning:

1. Let the peer's messages reach the runtime. On Discord, add the peer companion's bot user id to the adapter's allowed-bot set (`allowedBotUserIds`). Without this, peer bots are ignored outright.
2. Auto-tagging then marks the peer `isMachineIntelligence` on first resolution (above), so the fatigue relationship class applies with no manual step.
3. Tune the budgets in the `charge-policy.json` owner file under `fatigue` (schema-validated by `src/system/config/charge-policy-config.ts`; a missing/invalid `fatigue` section fails closed at startup). The knobs:
   - `relationshipBudgets` — per relationship class (`stranger_mi` … `trusted_collaborator_mi`) `softTarget`/`hardCap` response counts per peer, per room, per UTC day.
   - `channelSettingLimits` — per channel setting (`dm`, `busy_human_group`, `one_human_companion_hosted`, `quiet_companion_room`, `public_group`, `unknown`) `maxSoftTarget`/`maxHardCap` caps.
   - `intentMultipliers` — scale soft/hard limits by inferred intent (casual, social, check_in, work, research, problem_solving).
   - `activityThresholds` / `stateThresholds` — busy/quiet room classification and the nearing-limit / wrap-up remaining-response bands.
   - `overcharge` — `enabled`, `reserveResponses` (bounded extra replies past the hard cap), and the recent-human-participation window/minimums. Overcharge fires only when a human recently participated OR the turn carries a work/research intent, so a companion can finish a genuinely useful exchange but cannot self-authorize an endless loop.
- A human message in the room resets the dynamics: it is free, and recent human participation unlocks the bounded overcharge reserve for subsequent machine-to-machine replies.
- Per-room fatigue state is readable in Garden via `GET /api/admin/charges`, which returns the fatigue ledger scope summaries and a tuning report. Filter to one room/peer/day with `channelId`, `peerContactId`, `localCompanionId`, and `dayKey` query parameters. The fatigue ledger is a companion-data JSONL file (`fatigue-ledger.jsonl`), scoped per (companion, peer, channel, UTC day) and reset daily.

### Operating same-cluster autonomous initiation

Autonomous initiation is disabled in the shipped seed. Enable it only after the
fleet identities, canonical machine-intelligence contacts, bilateral trust,
ordinary companion channels, and fatigue/charge policy are ready:

1. Edit `scheduler.json > icpAutonomy` through the canonical Settings owner-file
   editor. `enabled`, candidate TTL/retry cadence/attempt limit, permit TTL, and
   operator availability-lease TTL are strict JSON-owned settings. Unknown or
   malformed fields fail closed. There is no `.env` equivalent.
2. Review `charge-policy.json`: `runChargeQuotaByLane.companion_social`,
   `surfaceCosts.companionSocialContinuation`, `fatigue` social regulation and
   overcharge reserve, `fatigue.socialRegulation.continuationEvidence`, and
   `icpCostBreaker` are the charge owners. Structured recent-human,
   active-work/research, and explicit-peer-invitation evidence can be allowed or
   denied independently; prose cannot invent continuation evidence.
3. Confirm the runtime tier grants `external.companion` and review the existing
   contact trust/block plus `channels.json` authorization. Enablement never
   bypasses those gates.
4. Restart the companion agent. Garden's **Autonomy** page reports effective
   versus on-disk scheduler and charge state and marks restart divergence.

Routine operation:

- Garden **Autonomy** (`GET /api/admin/icp-autonomy`) shows at most 50 recent
  records in each bounded lifecycle: the local coarse availability lease, local
  candidates, and local-participant content-free episodes/provenance, permit
  status without bearer IDs, fatigue aggregates, latest durable cost decisions,
  and reason/failure counts. Unrelated peer↔peer rows are excluded and do not
  influence quiet/failure summaries. Empty candidates are reported as healthy
  quiet, not guessed failure.
- `POST /api/admin/icp-autonomy/candidates/:candidateId/cancel` accepts only the
  current local candidate revision. A permitted candidate's issued permit is
  revoked before the candidate transitions to cancelled. Stale or terminal
  state conflicts fail closed.
- `POST /api/admin/icp-autonomy/do-not-disturb` accepts an empty object. It
  publishes a local operator lease and atomically invalidates outstanding
  permits involving the local companion.
- `POST /api/admin/icp-autonomy/emergency-disable` accepts an empty object. It
  first narrows live source authority, then applies DND/permit invalidation and
  persists `scheduler.json > icpAutonomy.enabled=false`. Re-enabling is an
  owner-file edit plus restart; the endpoint cannot enable autonomy.
- Every successful or denied mutation is recorded as an `autonomy_control`
  Garden audit entry. Controls never accept a target companion or cluster.

Privacy boundary: the autonomy API and page do not expose private candidate
motivation, peer-contact IDs, permit bearer IDs, messages, transcripts, model
prompts, private reasoning, or chain-of-thought. Investigation links go to the
ordinary Sessions, Charge / Budget, and Models pages, which retain their own
authorization and redaction contracts.

## Backups And Integrity

- Backup cadence and retention live in `backup.json` and `scheduler.json`.
- Backups are encrypted at rest. `backup.json` declares `encryption.mode: "required"` and an env key reference; the actual key material stays in `PSFN_BACKUP_ENCRYPTION_KEY` or another configured env secret. Startup fails closed when the key is missing.
- Under the PostgreSQL runtime backend the scheduled backup stages a `pg_dump` custom-format archive (requires `pg_dump`/`pg_restore` on PATH) plus session JSONL, memory mutation ledger, and character-card files; the scheduler refuses to start without a database backup source.
- The scheduled backup also stages the full companion-data file tree (journals, generated media/selfies, vault notes, prompt and card history, scratchpad) into `companion-tree/` with a per-file sha256 manifest; the walk is exhaustive except for sessions (captured separately), backup targets, and repair snapshots, so new companion-authored file classes can never silently fall out of scope.
- System-data JSON owner files are staged into `system-config/` with a per-file sha256 manifest. This includes `settings.json`, `models.json`, `providers.json`, `scheduler.json`, `capability-tier.json`, `channels.json`, `backup.json`, `skills.json`, `trust-policy.json`, `charge-policy.json`, and `intake-policy.json` when present. `.env`, generated systemd env files, and raw provider/channel secrets are not copied by this system-config snapshot.
- Helm deployments also stage `helm-recovery/`: the recovery-safe deployable files from the repo-owned `deploy/helm/psfn` chart plus a versioned descriptor containing release name, namespace, Helm revision, an exact chart-content digest, and the effective agent/gateway/Garden image references. Documentation files, live Helm values, rendered manifests, Kubernetes Secret objects, and secret material are deliberately excluded. Real YAML parsing rejects secret-bearing values regardless of quoting, inline-map, or snake-case syntax; unsupported overlays, packed/opaque subcharts, special files, and source/destination overlap fail closed before capture writes anything. The chart has a per-file sha256 manifest and is verified before encryption and again by `verify:backup-restore`.
- Every snapshot contains `backup-contents.json`, which records whether Helm recovery is `required` or `absent`. In production this marker is inside the authenticated encrypted payload, so deleting the entire Helm subtree cannot make a Kubernetes backup masquerade as a non-Kubernetes backup. Restore operators still re-provision credentials and review deployment-specific overrides rather than replaying stale secrets.
- The configured Personal Workspace is staged separately into `workspace-tree/` with its own sha256 manifest. This covers its docs, downloads, images, journal/scratchpad files, authored skills/modules, experiments, and canonical `knowledge/wiki/` store. In fleet mode, each companion slice contains only that companion's Personal Workspace; the cluster artifact contains only the governed Shared Companion Workspace. Group mode captures the complete `workspaces/` parent in its one family artifact. Runtime roots, backup targets, VCS metadata, dependency directories, caches, and temp directories are excluded and recorded in the manifest.
- Workspace backup fails closed if `WORKSPACE_PATH` overlaps runtime data roots, logs, temp, backup output, the mirror target, or other protected runtime paths. Keep personal wiki/reference documents under `WORKSPACE_PATH/knowledge/wiki/`; do not rely on the external Obsidian bridge for canonical storage or backup coverage.
- With `verifyRestore` enabled, every scheduled cycle verifies the plaintext staging area before encryption: it restores the dump into a dedicated scratch database (`<dbname>_restore_verify`, derived from the runtime database URL) and asserts schema, pgvector functionality on restored vectors, critical-table presence, and that tables populated at the source restored non-empty. One-time setup: `CREATE DATABASE <dbname>_restore_verify OWNER <runtime-role>` and `CREATE EXTENSION vector` in it as superuser (the extension survives wipes; user tables/sequences/views are dropped each run). The dump archive table of contents is also checked via `pg_restore --list`; companion-tree, workspace-tree, system-config, backup-contents, and Helm manifests are re-verified; and the L0 session-archive snapshot must parse as JSONL.
- After verification, the retained backup set contains `encrypted-backup.json` plus `snapshot.tar.gz.enc`; the plaintext staging directory is removed. Mirrors receive the encrypted package, not the plaintext tree.
- `npm run verify:backup-restore -- --backup-dir <snapshot> --postgres-restore-url <scratch-url> [--postgres-source-url <url>]` decrypts encrypted backup sets using the manifest key reference and runs the same fidelity verification (the decant rehearsal).
- A failed scheduled backup logs an error and emits a `backup.failed` event on the runtime event bus.
- Under the multi-companion topology, backups are per-companion by default: each companion is captured as its own slice (its own `postgresSchema` dump, companion-data tree, and Personal Workspace) so a single companion can be moved to another cluster as a slice. A separate `cluster` artifact captures the shared-world schema (`shared`), system-data owner files, the Shared Companion Workspace, and the Helm recovery bundle when applicable; Helm files and peer Personal Workspaces never leak into companion slices. Enabling `groupMode` (`backup.json`, env override `BACKUP_GROUP_MODE`) instead collapses the fleet into one whole-database family artifact containing the complete workspace family and system-level bundle. Exactly one process runs the fleet backup cycle: the leader is deterministic — the first companion in `companions.json` order (`isFleetBackupLeader`, `src/persistence/backups/fleet-scheduler.ts`), no distributed lock — and followers register no backup lane. Partial failure (`FleetBackupPartialFailureError`) is recorded and re-thrown, never swallowed. Destination-aware restore helpers in `src/persistence/backups/fleet-restore.ts` restore exactly one companion, cluster, or group scope after verifying the backup manifests and reject existing or overlapping destination roots rather than merging them.
- Startup validates the PostgreSQL schema, pgvector availability, and configured embedding dimensions; there is no alternate database integrity path.
- Embedding-dimension mismatches are surfaced at startup.
- Use this verification when backup behavior changes:

```bash
npm run verify:backup-restore
```

Generate or rotate the default encryption key with:

```bash
openssl rand -base64 48
```

## Heartbeat Audit Posture

Use `schedule action=list_templates` when you need the live reflection/scheduler classification, not raw prompt text.

The default reflection set is intentionally consolidated:

- `daily-review`: private multi-turn reflection that can cover mood, goals, memory, and metacognitive continuity when the rest window allows it.
- `weekly-review`: broader consolidation and planning pass for durable themes, values, and longer arcs.
- Heartbeat remains a runtime cadence/checkpoint. It should not burn tokens unless useful work is configured.

Operational rule: silent/background intervals are valid outcomes. Do not treat every cadence tick as requiring a visible note or a durable extraction artifact.

## Re-Embedding

Re-embed when any of these change:

- embedding provider
- embedding model
- embedding dimensions
- vector format expectations

Relevant commands:

```bash
npm run migrate:embeddings
npm run verify:backup-restore
```

Validate retrieval quality after the migration, not just command success.

## Intake Injection-Classifier Model Provisioning

The gateway-side L1.5 prompt-injection classifier
(`src/boundary/gateway/intake/injection-classifier.ts`) runs
`protectai/deberta-v3-base-prompt-injection-v2` (Apache-2.0) in-process via
the pinned `@huggingface/transformers` ONNX runtime. Model weights (~704 MiB)
are not committed to git and are never downloaded at runtime. When the model
directory is absent the gateway skips L1.5 scoring with a loud startup warning
and screens on the deterministic L1 layer alone; a present-but-broken model
directory fails startup closed (`src/boundary/gateway/intake/compose-screening.ts`).

Provision (pinned revision, every file sha256-verified):

```bash
npm run provision:injection-model -- --dest ./models/prompt-injection-v2
```

Notes:

- The pinned revision and hashes live in `scripts/provision-injection-model.ts`;
  re-pin them deliberately when upgrading the model.
- Screening thresholds per source risk tier live in `intake-policy.json` under
  `injectionClassifier` (owner-file validated). The classifier score is one
  weighted screening signal — it never hard-blocks on its own.
- The golden-set parity test
  (`src/boundary/gateway/intake/injection-classifier.test.ts`) runs whenever
  `PSFN_INJECTION_MODEL_DIR` points at a provisioned directory and skips
  loudly otherwise:

```bash
PSFN_INJECTION_MODEL_DIR=./models/prompt-injection-v2 \
  npx vitest run src/boundary/gateway/intake/injection-classifier.test.ts
```

## Cognitive Security Operations

The cognition intake firewall is policy-owned by `intake-policy.json` and
operated from the Garden **Cognitive Security** tab (Approvals / Firewall /
Drift / Remediation pages). The full design — layers, envelope contract, sink
gates, quarantine lifecycle, and the companion-wellbeing language contract —
is in [`docs/cognitive-security.md`](./cognitive-security.md); this section is
the operator quick reference.

### Mode flip (shadow → enforce)

`intake-policy.json` `mode` is `off` / `shadow` / `enforce`; the seed ships
`shadow`. Shadow creates, screens, journals, and audits envelopes but never
alters delivered content — it is the observe-only rollout posture. Enforce
substitutes sanitized text or the fixed withheld-content notice per the
screening decision and makes sink-gate denials real. Flip the mode by editing
the owner file (schema-validated on load; an invalid file fails closed) and
restarting. Before enforcing, run in shadow long enough to review would-deny
volume on the Firewall page and the quarantine queue — see the rollout runbook
in [`docs/cognitive-security.md`](./cognitive-security.md).

### Quarantine review (Approvals page)

Quarantined items land in `companion-data/state/intake-quarantine.json` and
surface at `GET /api/admin/intake/quarantine`. Every resolution is a
server-side double-confirm: `POST /api/admin/intake/quarantine/<id>/confirm`
issues a single-use token (2-minute TTL, bound to the item's content hash and
the current source lists), then `POST .../decide` executes with that token, the
chosen `action` (`release_raw` / `release_sanitized` / `discard`), and a
mandatory `reason`. An optional `sourceList` field (`always_allow` /
`always_deny`) feeds the decision back into the `sourceLists` policy — the
flywheel — before the release applies. Items expire per
`quarantine.itemTtlHours` (default 168h) and the queue is capped at
`quarantine.maxHeldItems` (default 500). Direct source-list CRUD lives at
`/api/admin/intake/source-lists`.

### Drift and second-arrow review cards (Drift page)

The nightly drift-velocity lane (htm9.14) and second-arrow rumination lane
(htm9.15) run from the rest-window scheduler poll, at most once per local
calendar day, and write batched evidence cards to
`companion-data/state/cogsec-drift-reviews.json`. They never mutate memories,
trust, or emotion state. Cards resolve through
`POST /api/admin/intake/drift-reviews/<id>/resolve` with `acknowledged`,
`dismissed`, or — second-arrow cards only — `consolidated`, which applies
memory supersession (supersede-not-delete, audited evolution links) through the
normal memory store. Tune thresholds under `driftDetection` in
`intake-policy.json`.

### Canary egress events

Every session plants a per-session canary token in privileged prompt material;
the gateway scans outbound egress methods (`discord.send`, `notify.ntfy`,
`web.*`, `companion.message.send`) for it. A hit is a prompt-leak/hijack
signal: the action is held and a CogSec event is written. Review canary and
firewall events on the Firewall page (`GET
/api/admin/session-routes/cogsec/events`); remediation of tainted content
(seal/tombstone, revocation, regeneration) runs from the Remediation page.
Known gap: the main conversational reply travels a reverse-RPC seam the egress
scan does not yet cover — see the residual-risk list in
[`docs/cognitive-security.md`](./cognitive-security.md).

### Injection-classifier model

Provisioning the L1.5 ONNX model is covered in "Intake Injection-Classifier
Model Provisioning" above. Supply-chain verification for dependency updates is
covered in "Dependency Update Policy (pin-then-plan)" below — the same
`npm run verify:supply-chain` gate applies to firewall dependencies like the
ONNX runtime.

## Shared-World Wiki And Places Maintenance

The shared-world wiki is operator-owned. Companions read shared world knowledge
and propose entries through the normal wiki pass; they never write the
`shared_world:<siteId>` scope directly (the personal wiki store rejects any
non-personal write fail-closed). The dedicated caretaker layer described in the
design notes is not built yet — shared-world writes happen only through these
operator maintenance commands:

This site-scoped knowledge base is not the Shared Companion Workspace. The
broader installation-owned file domain is separately rooted, review-published,
and read through the authenticated shared-workspace surface; never simulate it
by putting personal files under `system-data`.

```bash
npm run wiki:publish:places          # dry-run: report only
npm run wiki:publish:places -- --apply
npm run wiki:import -- --scope shared --site <siteId> --dir <path>          # dry-run
npm run wiki:import -- --scope shared --site <siteId> --dir <path> --apply
npm run wiki:import -- --scope personal --dir <path> --apply
```

- `wiki:publish:places` projects `places.json` into browsable shared-world wiki
  pages (one site-overview page plus one page per place, scope
  `shared_world:<siteId>`). It is idempotent — re-running against an unchanged
  registry is a no-op. Shared-world markdown lives under
  `<system-data>/shared-world/wiki/sites/<siteId>/`, never in companion-data.
- `wiki:import --scope shared` runs a deterministic personal-fact guard over
  every file and rejects any file containing a personal fact; `--scope personal`
  imports into a companion's own wiki without that gate. Both fail closed on an
  unknown `siteId`.
- Projection coupling: under the multi-companion topology both commands project
  the shared-world markdown into the `shared_wiki_chunks` pgvector store in the
  `shared` schema in the same operation, and abort before touching the
  filesystem if the projection target is unreachable. Retrieval then unions a
  companion's personal wiki with the current site's shared chunks
  (`resolveWikiRetrievalPlan`).

Room privacy is a property of the place, set as an optional `privacy` field on
the place registry entry in `places.json` (`"public"` — the default when absent
— or `"private"`). A `private` place delivers room chat presence-windowed: an
occupant sees only what was said between their join and exit. This is enforced
at delivery time (gateway fan-out + session/context serving), never by filtering
memory extraction. See [`docs/chat-turn-lifecycle.md`](./chat-turn-lifecycle.md).

## TLS And Proxy Trust

For the LiteLLM proxy and custom CAs:

```bash
./scripts/cert-setup.sh --help
```

Key runtime wiring:

- `GATEWAY_TLS_CA_PATH` adds a trusted CA bundle for outbound TLS
- `GATEWAY_TLS_REJECT_UNAUTHORIZED=false` is rejected in production and never sets `NODE_TLS_REJECT_UNAUTHORIZED`; any development self-signed exception must be wired on the intended endpoint client
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is rejected in production because it disables TLS verification process-wide

If you enable HTTPS on the bundled proxy, update the proxy compose mounts and keep the certs under the repo-owned tree.

## Dependency Update Policy (pin-then-plan)

PSFN does **not** auto-update dependencies. Every dependency is pinned to an
exact version in `package.json`/`package-lock.json`, and updates are planned and
applied deliberately. This is a supply-chain control, not inertia.

### Why no auto-updates

Public supply-chain compromises (a maintainer account takeover, a malicious
post-install script, a backdoored transitive dep) usually surface publicly
within roughly an hour of being noticed. The real risk window is an
**auto-update pulling a compromised package before anyone has flagged it**. By
pinning and updating deliberately, the compromise almost always has a public
advisory by the time we choose to move — so we can check for it. Auto-updating
would spend that safety margin for us.

### The deliberate update workflow

Update dependencies in a dedicated change, never mixed into a feature commit:

1. Edit the target versions in `package.json` (change exact pins deliberately).
2. `npm install` to update `package-lock.json`.
3. `npm run verify:supply-chain` — this is the gate. It runs when the lockfile
   changes: it computes the `(name, version)` pairs **added or changed** between
   the git HEAD lockfile and the working-tree lockfile, and cross-references
   them against published advisories.
4. Review the report. If clean, commit the lockfile change. If it flags a hit,
   **do not commit** — see below.

The check is wired as an npm script and is intentionally **not** an in-app or
always-on scanner: it belongs to the update cycle, not the runtime.

### The advisory feed

`verify:supply-chain` queries the **OSV.dev batch query API**
(`https://api.osv.dev/v1/querybatch`) — a free, keyless feed. OSV aggregates the
**GitHub Advisory Database**, so GHSA identifiers surface directly in OSV
responses (the report prints both the OSV/GHSA ids and any CVE aliases). One API
therefore covers the two intended free feeds (OSV.dev + GitHub Advisory
Database) with no token required.

### What to do on a hit

If the report names a changed package version that matches an advisory, the
command exits nonzero and prints the package, version, advisory ids (GHSA/CVE),
severity, summary, and references. Do not commit the update. Pin the affected
package to a known-safe version (or hold the upgrade entirely), re-run
`npm install`, and re-run `npm run verify:supply-chain` until it is clean. Record
the advisory id in the update commit or the tracking issue.

### The offline escape hatch

The check **fails closed**: if it cannot reach the advisory feed, it exits
nonzero with a "could not verify" message, because an unverifiable update is not
a verified update. For a confirmed feed outage you can pass
`npm run verify:supply-chain -- --allow-offline`, which downgrades the failure to
a prominent warning and exits 0. This is only acceptable when you have
independently confirmed the outage and are accepting the risk; re-run without the
flag once connectivity is restored.

## Validation Commands

These are the common operational checks:

```bash
npm run lint
npm run build
npm test
npm run smoke:chat
npm run e2e
npm run e2e:voice
npm run verify:settings-contract
npm run verify:supply-chain      # dependency-update gate; see "Dependency Update Policy"
npm run verify:repository-hygiene
npm run verify:agent-docker-isolation
npm run test:group-harness
npm run test:prompt-goldens
npm run test:leak-matrix
```

- `npm run test:group-harness` runs the group-chat prompt-shape regression suite (`src/core/session/group-chat-harness/`). It drives the real prompt-assembly and memory-retrieval paths against synthetic multi-human room, DM, and non-member fixtures: room-visibility leak probes, group history attribution, room-scoped core memory, and conversation_state. Known group-chat defects are encoded as `it.fails(...)` expected failures (speaking_with tokens populating on group turns; DM core-memory participant binding following an arbitrary history speaker instead of the canonical contact) and flip to real failures when a fix lands. Reusable assertion helpers live in `group-chat-harness/assertions.ts`.
- `npm run test:leak-matrix` runs the Context Envelope leak-rate test family (`src/core/session/group-chat-harness/envelope-leak-matrix.test.ts`, E3.6). A documented ~26-row corner matrix (envelope class x sensitivity x trust tier, plus consent/disclosure-boundary/high-intimacy-contact-scope corners) drives the REAL `MemoryRetriever.retrieve` gating pipeline (`evaluateRetrievalAccessDecision` / `evaluateMemoryPolicy`) against synthetic sentinel memories -- not the unit-level gate suite in `src/system/trust/envelope-gating.test.ts` (E3.3), which this suite complements rather than duplicates. Every forbidden corner asserts zero leak of the sentinel text through the assembled output plus the correct withheld reason code (via the label `formatMemoryWithheldReasonLabel` renders); every allowed corner asserts presence, including positive controls for the room->DM-of-member, trust-ceiling, high-intimacy-contact-scope, and consent-granted paths. It reuses the group-chat-harness fixtures and adds a small set of additive fixture variants (a broadcast channel, an anonymous-audience room, and consent-flagged/boundary-tagged/contact-scoped sentinel memories) to `group-chat-harness/fixtures.ts`.
- `npm run test:prompt-goldens` runs the prompt-shape golden suite (`src/core/session/group-chat-harness/prompt-shape-goldens.test.ts`). Six deterministic golden snapshots under `group-chat-harness/goldens/` freeze the full rendered system prompt plus ordered block list for DM, group, heartbeat, DM-scoped reflection, DM-with-memories, and group-with-withheld-memories turns, and the suite also asserts the frozen static prompt prefix is byte-equal across consecutive turns. A failing golden means the assembled prompt shape changed: never blind re-record. For an intentional shape change, regenerate with `npx vitest run src/core/session/group-chat-harness/prompt-shape-goldens.test.ts -u`, review the golden diff like code, and explain the block-level change in the PR; then run `npm run test:prompt-goldens` twice to prove determinism. The full update procedure is documented in the test file header.
- `npm run smoke:chat` exercises the split-runtime admin bootstrap and chat completion path; set `PSFN_SMOKE_REPORT_PATH=/tmp/psfn-smoke-report.json` to capture a JSON artifact with the bootstrap, chat, and optional voice checks.
- `npm run verify:startup-owner-files` is the canonical startup preflight for the split-runtime owner-file contract; `npm run e2e` assumes that preflight has already passed.
- `npm run e2e` uses the isolated split-runtime harness under `src/app/e2e/e2e-test.ts`, with scripted local LLM responses so it does not consume ambient repo owner files or external model credentials.
- `npm run e2e:voice` exercises the isolated voice round-trip harness on the split runtime.
- Offline eval, validation, and model-experimentation commands live in the sibling `../psfn-eval-toolkit` repository.

For Discord voice specifically:

```bash
npm run smoke:discord:dm-voice -- --dry-run --strict
```

## Failure Triage

Check these first:

- runtime mode and path layout wiring in `.env`
- owner-file validity under `system-data/`
- gateway socket path and process pairing
- PostgreSQL connectivity, migration, and embedding-dimension warnings
- backup and migration manifests under the runtime backup root

If behavior seems inconsistent with old docs, prefer the split-runtime topology: gateway owns the public API edge, operator owns Garden HTTP/UI, and agent owns the companion loop plus private admin transport.
