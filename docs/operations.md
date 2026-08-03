# Operations

This is the operator-facing runtime guide for the current repo-owned deployment model.

Last updated: 2026-08-01.

Before touching a Helm release, follow the canonical
[Helm Cluster Upgrade Guide](./helm-upgrades.md). It is the detailed, mandatory
end-to-end procedure; this document holds the subsystem and recovery references
it links to.

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
- `split` loads `.env` in the launcher/gateway boundary, then starts agents and operators from separate explicit allowlists. Operators do not reload `.env`; the cluster Garden receives only its approved database URL plus Garden/runtime wiring, while provider and channel credential status reaches it only as redacted booleans over the admin transport.
- `yolo` keeps the split runtime but broadens gateway `fs.read` scope across the codebase.
- `operator` runs only the Garden operator surface when you want it separate from the launcher.
- `agent:docker` is the production profile (`network_mode: "none"`).
- `agent:docker:continuous` is the continuous/dev profile on an isolated internal network.
- Use `npm run verify:agent-docker-isolation` after changing compose files or operator docs.

### Interactive turn latency budget

For an idle, warm companion, a no-attachment single-sentence chat turn has an
operational budget of 30 seconds from transport receipt to visible completion.
The foreground stages are expected to stay within these regression budgets:

- channel queue wait: 1 second;
- session-context assembly: 2 seconds;
- all other pre-turn context work, including emotion observation: 2 seconds;
- prompt assembly: 2 seconds;
- provider request to first token: 20 seconds; and
- first token to visible turn completion: the remaining 3 seconds for a short
  reply.

These are observability budgets, not client or provider timeouts. Exceeding one
should identify the stage to investigate; it must not be handled by raising an
outer timeout. Garden's dashboard response exposes the content-free live
percentiles at
`stats.transientSessionTelemetry.latencyPercentiles.series`. Relevant metrics
include `channel_queue_wait`, `session_context_assembly`,
`emotion_observation`, `context_assembly`, `prompt_assembly`, `llm_ttft`, and
`visible_turn_complete`. The last metric is the API receipt-to-visible-response
budget named above; `turn_complete` instead measures the agent's full pipeline,
including post-turn scheduling. The aggregate is process-local and resets when
the operator process restarts.

## Companion Cluster Operations

Every deployment is a cluster described by the mandatory `companions.json`
manifest: N agent processes behind one gateway and one authenticated cluster
Garden. A one-entry manifest is a cluster of one and uses the same control plane,
SSO, and operator procedure as a larger roster. The full model is in
[`docs/multi-companion.md`](./multi-companion.md); this section is the operator
quick reference. The manifest is always required (seed
`config/companions.seed.json`) and fails closed at startup if missing or invalid;
there is no `PSFN_MULTI_COMPANION` flag (retired). Cluster Garden wiring requires
`PSFN_FLEET_AUTH=1`.

### Supervisor launcher

`npm run split` (`scripts/start-gateway-agent.sh`) resolves the cluster and spawns
one agent process per companion plus exactly one cluster Garden process on the
normal cluster-level
`ADMIN_PORT`. `gardenPort` is retired from `companions.json`; any remaining
entry fails validation instead of activating a compatibility path. Preview the
redacted spawn plan with:

```bash
scripts/start-gateway-agent.sh --dry-run   # prints the plan; launches nothing
```

Each spawned agent gets a scrubbed environment plus `COMPANION_ID`,
`COMPANION_DATA_DIR`, `CHARACTER_CARD_PATH`, `COMPANION_PG_SCHEMA`,
its derived personal `WORKSPACE_PATH`, and its registry-derived
`ADMIN_TRANSPORT_SOCKET`. The plan builds the same immutable target registry as
Garden, with exact `garden-admin-<companion-uuid>.sock` paths derived from
canonical companion IDs. Endpoint collisions fail before process launch. After
starting all N agents, the supervisor waits deterministically until every
planned socket is listening; an agent exit or missing endpoint aborts without
starting Garden. Only then does it start the one Garden. The supervisor is
shared-fate: if any supervised process exits, the whole cluster is torn down.
The cluster Garden receives `POSTGRES_DATABASE_URL` for its approved direct
database services. Those services are instantiated per registered companion,
and the authenticated request target must match the selected service binding
before a query can run.
Manifest-relative data/card paths are resolved to absolute strict subpaths of
`PSFN_RUNTIME_ROOT`; symlink escapes and tuple drift fail before startup. The
launcher also derives separate role-bound gateway proofs for every agent and its
session-integrity worker. These
proofs are not printed by `--dry-run` and are never passed to Garden operators.
`companions.json` also names one unique database role and credential reference
per companion plus the dedicated shared-schema migration role/reference. The
launcher resolves those references at the gateway boundary and passes only the
matching database URL to each agent through `POSTGRES_DATABASE_URL_FD`; dry-run
output redacts every database credential. The shared DDL authority is topology
owned rather than owned by optional Cluster Auth.

The plan derives one canonical Personal Workspace per companion beneath
`<runtime-root>/workspaces/personal/<uuid>`. It provisions the cluster layout
before process startup and refuses missing, overlapping, symlink-escaping, or
tuple-mismatched roots. The shared root is Garden-governed and is never exported
as `WORKSPACE_PATH`.

The local cluster Garden uses socket admin transport only; network
admin-transport mode is rejected fail-closed under the supervisor.

Local topology rollback is revision-based, not a live compatibility switch.
Stop the launcher, restore the previous pinned revision and its matching
pre-cutover `companions.json`, then restart and verify the same canonical
gateway browser origin. Do not add `gardenPort` back to the current schema, run
old and new Gardens together, expose direct Garden ports, or fall back to one
shared admin token. Owner files and companion state do not move during this
rollback.

### Per-companion Postgres schema

Each agent process pins its runtime persistence to the schema named by its
manifest entry via `COMPANION_PG_SCHEMA` (see
[`docs/setup.md`](./setup.md)). The schema is created up front on startup and the pool's
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

### Unified cluster human origin

With cluster auth enabled (system-owned `fleet-auth.json` present; file presence
is the single source of truth), the gateway is the only browser origin. Open the
exact HTTPS `canonicalOrigin` from `fleet-auth.json` at `/fleet`; unauthenticated
browser requests are sent through the gateway-owned OAuth login. Authorized
Garden routes are `/companions/<companion-uuid>/garden/...`. The optional static
Companion UI is `/companion-ui/` and is bound by the server to one registered
companion. The old direct Garden host/port is not a browser edge in this mode.
The same compiled Garden bundle renders the `/fleet` overview; its
`/v1/fleet/portal` request returns only the current principal's bounded
authorized projection. The retired raw cluster-status listener and
`/fleet/status.json` route are absent.

`fleet-auth.json` accepts an optional admin-unconditional `accountRoster`
(`[{ "providerSubjectId": "<discord snowflake>", "companionId": "<companion uuid>",
"contactId": "<canonical companion contact id>", "role": "owner" }]`). Owner
entries require the canonical `contactId`; other roles may omit it only when a
live principal contact binding already supplies the identity. A
Discord-authenticated session whose token-verified subject matches an entry is
projected as that role for the companion. On a fresh fleet, the exact first
rostered owner login activates the principal and provider subject, registers the
companion authority, and materializes its contact binding and owner grant in one
transaction. A pending trusted-host first-owner ceremony retains precedence.
The `contactId` names the rostered admin's canonical contact; no contact identity
is synthesized. A configured `contactId` must name the matching contact in that
companion's store. The session itself must still be real,
unexpired, and unrevoked, and subjects not in the roster keep the full
gauntlet unchanged. A malformed roster entry, an unknown role, or a roster
companion outside the companions registry refuses startup. The roster is also
the deployment access-mode seam (operator ruling D1, 2026-07-30): exactly one
rostered human for a companion selects sole-admin mode (nothing subject-gated
for that admin); zero or two-plus selects multi-admin mode (everything visible
except other-humans' sensitive memories, which open through an audited
escalation grant — `POST /v1/fleet-auth/escalation/grant`, TTL
`ttls.escalationGrantMs`).

For every Garden request, the gateway resolves the live OPL1.5 session/contact/
grant/policy context for the companion encoded in the path. Only then does it
mint and durably consume a short-lived, exact request capability and connect to
the one cluster Garden, which verifies the binding before selecting that
companion's registered agent transport. Unknown companions, authorization
denial, stale or revoked sessions, and missing upstream registrations all
return the same 404 before an agent connection, so the edge does not enumerate
the cluster.
Browser cookies, bearer credentials, forwarding metadata, and caller-supplied
capability assertions are stripped. Garden verifies the signed method, target,
action, authorization digest, body length, request id, decision id, audience,
and companion before stripping the assertion again at the agent boundary.

There are two admitted HTTPS-origin shapes:

- Direct TLS: exact canonical `Host`, no forwarding headers.
- One trusted proxy: set `FLEET_SSO_TRUST_PROXY=true`; require exact canonical
  `Host` and `X-Forwarded-Host`, `X-Forwarded-Proto: https`, optional exact
  HTTPS port, and one IP-valued `X-Forwarded-For`. RFC `Forwarded`, lists, mixed
  direct-TLS metadata, or mismatched callback origins fail closed. Restrict the
  gateway listener to that proxy independently with NetworkPolicy/firewall.

The local cluster launcher uses loopback Garden upstreams. Any non-loopback
`FLEET_SSO_GARDEN_HOST` requires the complete `FLEET_SSO_GARDEN_TLS_*` tuple;
the gateway validates the Garden SPIFFE URI and Garden validates the gateway
SPIFFE URI. Partial TLS configuration aborts startup. In Helm, keep the
cluster-authenticated default, enable `ingress.gateway.tls`, and name an existing
browser-trusted TLS Secret. Cluster auth also requires `networkPolicy.enabled=true`,
`hostPorts.gatewayApi.enabled=false`, and the exact root
`ingress.gateway.path=/` with `pathType=Prefix`; any other combination fails
rendering rather than creating a second or incomplete browser edge. The chart
renders that gateway as the sole browser Ingress, cert-manager identities for
gateway-to-Garden mTLS, and NetworkPolicy allowing Garden and the optional
Companion UI only from gateway pods. It has no raw cluster-status listener;
the raw status listener remains a separately managed loopback-only operator
surface.

Rollback keeps the same edge invariant. Capture the current values, certificate
Secrets, and cluster owner backup before the change. Roll back only to a revision
that retains the cluster roster, unified router, Cluster Auth, and sole-gateway
Ingress; direct Garden Ingress/hostPort and `ADMIN_TOKEN` are not recovery
paths. Verify the gateway TLS host, `/fleet` login/callback, one authorized
Garden, one denied cross-companion route when the roster has multiple entries,
logout while one companion is unavailable, and a revoked session before
declaring recovery. Run `helm lint deploy/helm/psfn` and
`npm run verify:helm-chart` on the exact rollback values before applying them.

### Cluster backups

See "Backups And Integrity" below for the per-companion-slice / cluster-artifact
/ group-mode model and the deterministic leader-election rule.

## Production Deployment

### Live deployment authority (read this first)

The live companion in this repo runs as a **k3s deployment**, not the host
systemd unit. The authoritative runtime is the Kubernetes namespace `psfn`
(the agent, gateway, and Garden workloads rendered from `deploy/helm/psfn`),
with the system-owned owner files mounted at `/runtime/system-data` from the
`<release>-system-data` PVC and all persistent state on Kubernetes PVCs.

The host systemd unit produced by the system-account installer below is
**disabled, non-authoritative legacy**. Its separate on-host runtime tree at
`/var/lib/psfn/runtime/system-data` is a stale copy, not live authority, unless
an operator has explicitly reactivated `psfn.service` on the node. Do not
conflate the two roots: mutating the host tree does not touch live state, and
host-systemd diagnostics can misdirect a change onto the wrong root (this
misdirection is exactly what psfn-framework-brev was filed to correct).

Before any live mutation, discover the running workloads and inspect owner-file
state read-only (`<release>` is the deployed Helm release name, `psfn` by
default; `<owner-file>` is a JSON owner file such as `charge-policy.json`):

```bash
# What is actually running, and which PVCs back it
kubectl get deploy,pods -n psfn
kubectl get pvc -n psfn

# System owner-file mount and hashes inside the shared gateway (read-only)
kubectl exec -n psfn deploy/<release>-gateway -- ls -la /runtime/system-data
kubectl exec -n psfn deploy/<release>-gateway -- \
  sh -c 'cd /runtime/system-data && sha256sum *.json'

# Every UUID-suffixed cluster agent and its exact companion root (read-only)
kubectl get pods -n psfn \
  -l 'app.kubernetes.io/component=agent,psfn.io/fleet-target=registered' \
  -L psfn.io/companion-id

# Confirm the host unit is not the live authority on the node
systemctl status psfn.service   # expected: disabled / inactive
```

Only after this discovery confirms which root is live should any owner-file or
persistence change proceed. The installer flow below provisions the non-k3s
host-systemd path and is not the live deployment.

The repo already contains the system-account installer:

```bash
scripts/system/install-psfn-service.sh
```

What it does:

- creates or reuses a dedicated service account
- stages a repo-owned checkout under the service home
- bundles a Node binary under the app root
- writes the filtered env file under the deployed checkout at `deployment/systemd/psfn.env`
- renders the host systemd unit under the deployed checkout at `deployment/systemd/psfn.service` (repo-owned so no shadow copy is authoritative; this host unit is the legacy path, not the live k3s deployment described above)
- links `/etc/systemd/system/psfn.service` to that repo-owned rendered unit as the only required external pointer
- can optionally run the persistence cutover before enabling the service

Use `--dry-run` first. Keep authoritative env and runtime wiring in the deployed repo tree; do not create shadow service config elsewhere. The installer-owned unit injects the production layout paths and `PSFN_SKIP_DOTENV=true`, while the filtered env file only carries env-owned values that remain appropriate to source from disk.

<a id="helm-upgrade-for-per-companion-scheduler-and-capability-owners"></a>

### Kubernetes upgrade dispatch

Use the [required end-to-end Helm procedure](./helm-upgrades.md#required-end-to-end-procedure)
for every cluster, including a cluster of one. That procedure owns image
build/import, chart reconciliation, gateway-first rollout, label-selected cluster
agents, SSO/Garden validation, and cleanup.

Owner migrations remain subsystem-specific:

- if `charge-policy.json` or `skills.json` is still under `SYSTEM_DATA_DIR`,
  stop the whole cluster and complete
  [Existing split clusters with shared per-companion owners](#existing-split-clusters-with-shared-per-companion-owners);
- run `migrate:scheduler-owner` once per exact companion root when its dry run
  reports a plan;
- run `migrate:intake-policy-owner` against the exact system root for schema
  v1;
- apply the compiled required-settings migration in the stopped,
  target-image maintenance Pod; the chart init boundary then validates the
  already-migrated result before app processes start.

Keep `bootstrap.seedOwnerFiles=false`. Seeds are first-install templates and
sources for explicitly missing keys, never upgrade authority. Select the
UUID-suffixed agent Deployments through the release label plus
`psfn.io/fleet-target=registered`, not a fixed `deploy/psfn-agent` name. Their
Pods additionally carry `app.kubernetes.io/component=agent` for pod/log
selection.

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
container `uid 999 gid 999`. Manual owner repair normalizes the final file to
mode `0664`; the repo-owned durable atomic migration helper creates its
replacement at `0600`, so the maintenance procedure must restore `0664` after
an apply. A root-owned rewrite bricks turns with `EACCES`.

Sibling surfaces build on the same seams: the post-rollout validation gate and
manual/automatic Helm rollback consume the pipeline record and the
`DeployPipelineRunner` interface; k3d end-to-end coverage exercises the runner
against a throwaway cluster.

### Post-Rollout Validation Gate

The manual, cluster-aware acceptance order is mandatory and lives in
[Post-upgrade validation gate](./helm-upgrades.md#9-post-upgrade-validation-gate).
The lifecycle gate below is an additional operator-job surface; on this branch
it does not replace the browser SSO, per-companion Garden, or label-selected
cluster checks.

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
an operator-managed cluster, live namespaces, or any real PVC.

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

This watchdog targets a **host-systemd** deployment: it checks a
`systemd --user` service and pages on failure. It is the liveness path for the
legacy non-k3s host unit, not for the live k3s deployment (see "Live deployment
authority" above), where Kubernetes owns restart/liveness and the health
contract is probed against the in-cluster workloads. Only run this watchdog on a
node where `psfn.service` (or the equivalent user unit) is the intended runtime.

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

### Owner-file migration framework

The per-companion owner files `charge-policy.json` and `skills.json` were once
rooted under `SYSTEM_DATA_DIR`.
Current runtime requires each under its companion root with no legacy fallback,
so re-rooting an existing installation is a one-time, digest-approved migration
built from three pieces. A cluster of one is simply a one-member destination set:

- **CLI** — `npm run migrate:system-owner-fleet`
  (`src/app/maintenance/migrate-system-owner-fleet.ts`). The default mode is a
  read-only plan; `--apply` executes; each source is gated by an explicit
  `--approve <owner-file>=<exact-sha256>` argument so the operator confirms the
  exact bytes being fanned out. In multi-companion mode it fans each approved
  source to every companion enumerated in `companions.json`. In the default
  topology it binds the explicit `COMPANION_ID` and `COMPANION_DATA_DIR` as the
  one destination without inventing a cluster manifest. It retires the source
  only after all destinations verify. Digests only — the command carries no
  secrets.
- **Helm pre-upgrade hook** —
  `deploy/helm/psfn/templates/owner-migration-upgrade.yaml`, gated by
  `ownerMigration.enabled`. It runs as a `pre-upgrade` Job that first snapshots
  the whole cluster, then runs the same compiled `--apply` migration with the
  bound `--approve` digests, then runs packaged per-companion readiness probes;
  Helm admits the new revision only after every probe passes. Missing claims,
  wrong paths, image-digest failures, shared-companion claims, or an omitted
  required hook fail the upgrade with the old revision left deployed.
- **Receipts** — the durable schema-v4 receipt lands at
  `SYSTEM_DATA_DIR/migrations/system-owner-fleet-reroot.json`; retired sources
  move into receipt-owned quarantine directories under `SYSTEM_DATA_DIR`, and
  the whole-cluster snapshot lands under the backups area (`BACKUP_ROOT_DIR`). The
  receipt is what makes the migration crash-recoverable and idempotent on retry.

The supported scope and beta-removal condition are recorded in
`docs/specifications.md` (Live Alpha Migration Boundary). The exact operator
procedure — snapshot, plan, approve, apply, and post-migration preflight —
follows.

### Existing split clusters with shared per-companion owners

Installations created before per-companion owner-file rooting may still have
`charge-policy.json` or `skills.json` under `SYSTEM_DATA_DIR`. Scheduler and
capability-tier use the separate retained-source Helm init cutover and are not
inputs to this fan-out transaction. Stop every app process. For a
cluster, verify every exact `companionDataDir` from `companions.json` is already
mounted, including the sole entry in a cluster of one.
The migration never creates a missing PVC root. Capture the mechanically
verified whole-install snapshot before inspecting or applying the fan-out:

```bash
npm run snapshot:system-owner-fleet -- \
  --output "$BACKUP_ROOT_DIR/pre-system-owner-fleet-<timestamp>"
npm run migrate:system-owner-fleet
```

The snapshot command writes one cluster/system tree plus one
`companions/<companion-id>/...` tree for every manifest root. Each tree has a
per-file digest manifest, and the cluster manifest binds those manifests by
SHA-256. Any excluded or special file fails capture; a partial family is
removed and cannot be used as rollback evidence.

The plan prints one `--approve <owner-file>=<sha256>` argument for every
system-root source it found. Review the enumerated companion destinations and
run the apply command with all printed approvals, for example:

```bash
npm run migrate:system-owner-fleet -- --apply \
  --approve charge-policy.json=<exact-sha256> \
  --approve skills.json=<exact-sha256>
```

The final Helm chart can rehearse the same transaction as one explicit
pre-upgrade boundary. Set `ownerMigration.required=true`, keep
`bootstrap.seedOwnerFiles=false`, bind the exact printed approvals, and list
the system, backup, and every companion PVC. The list must match the
already-present `companions.json`; a cluster of one lists its sole identity and
root, and a larger cluster lists every entry. The hook
captures the whole-install snapshot before its
canonical compiled migration init container runs; packaged per-companion probes
must then prove distinct writable owners before Helm admits the new revision.
Verification cannot be disabled. `snapshotOutputDir` must remain beneath the
PVC-mounted `backupsDir`; use `backupsSubPath` when the claim's backup tree is a
subdirectory. This is not an automatic fallback: the feature is disabled by
default, missing or duplicated claims and paths fail closed, and it must be
removed from values after the one-time cutover. `npm run e2e:kube-owner-upgrade` exercises the real
old-chart install, final-chart upgrade, failure matrix, and fresh-PVC old-chart
restore.

The supported command validates `charge-policy.json` and `skills.json` with
their canonical runtime schemas before it creates or mutates a migration
object. A new receipt validates the pinned system-root sources. Receipt-bound
recovery validates the live source while it exists and, after quarantine,
validates the current owner at every identity-bound exact destination. Valid
atomic post-migration owner edits are allowed; malformed old receipt state or a
malformed current owner fails closed. Malformed JSON or schema drift therefore
leaves the source and every companion root unchanged. Keep
`bootstrap.seedOwnerFiles=false`; a seed copy is new default state, not
preserved operator state and cannot certify this migration.

The command first durably writes a bootstrap receipt at
`SYSTEM_DATA_DIR/migrations/system-owner-fleet-reroot.json`. That receipt binds
unpredictable operation, quarantine, staging, and copy identifiers before any
quarantine or staging directory is created. Each created directory and copy is
then fsynced and bound to its filesystem identity in the receipt before use. The
command copies without overwrite or merge, verifies every destination digest,
and only then atomically moves the exact source into its receipt-owned quarantine
directory. Receipt, quarantine, and private destination staging directories are
descriptor-pinned; symlinked ancestors or identity changes fail closed.

Receipt-recorded staging hard links and any superseded, unbound crash remnants
are retained so cleanup never becomes a pathname check-then-delete. Do not
remove them before this alpha migration support is retired. If interrupted,
repeat the exact apply command: only an identity-bound partial copy that is an
exact prefix of the approved source is resumed. An unbound copy is durably
superseded under a new receipt-recorded identifier and preserved for operator
inspection. Unknown artifacts, replacements, changed sources, a changed cluster,
pre-existing destinations, or destination tampering are hard conflicts; the
tool never deletes the evidence or chooses a winner. After
completion, run
`npm run preflight:startup-owner-files` in the target runtime environment before
restarting the cluster. The runtime preflight validates global owners at
`SYSTEM_DATA_DIR` once and every per-companion owner at each exact root resolved
from `companions.json`; an owner in another companion root or a system-root
decoy cannot satisfy the check. `npm run verify:startup-owner-files` is the
separate repository gate: it validates distributed seeds in a disposable,
explicit split-root fixture and is never called by the launcher.

Rollback is a whole-cluster restore boundary. If an old release must be restored
after charge/skills fan-out, stop every cluster process and provision a fresh,
empty system-data PVC plus one fresh, empty companion-data PVC for every
manifest entry. Mount them beneath one fresh runtime root using the original
relative paths, then rehearse/perform the verified restore:

```bash
npm run restore:system-owner-fleet-snapshot -- \
  --manifest "$BACKUP_ROOT_DIR/pre-system-owner-fleet-<timestamp>/system-owner-fleet-snapshot.json" \
  --restore-runtime-root <fresh-runtime-root>
```

The restore verifies the whole artifact family before its first write and
refuses non-empty destinations. If it fails after writing begins, discard the
entire fresh PVC set; never reuse a partial restore. Point the old release only
at the successfully restored PVC family, run its startup preflight, and then
reopen traffic. Do not copy the quarantined
source back by hand, selectively restore one companion, delete the receipt, or
reuse a partially migrated root: those actions sever the receipt's provenance
and can reintroduce a shared owner alongside individuated state. Forward
recovery is to fix the reported conflict and repeat the same digest-approved
apply command; rollback is the verified all-root backup restore.

## Migration Boundary Until Beta

The live alpha migration boundary is defined in [`docs/specifications.md`](./specifications.md). Operationally, keep migration support explicit and temporary:

- Use `npm run migrate:persistence-layout` for legacy shared-root data. Do not keep the old shared root mounted as a runtime fallback after cutover.
- Use `npm run migrate:system-owner-fleet` only for the receipt-bearing alpha
  fan-out of registered per-companion owner files left in a current split
  cluster's system root. Do not point the one-companion persistence cutover at
  `SYSTEM_DATA_DIR` and do not retain a shared fallback reader.
- Use `npm run migrate:scheduler-owner -- --data-dir <exact-companion-data-dir>`
  only as an explicit one-companion alpha owner-shape migration. The standard
  launcher never runs it, and the command refuses to infer a system, shared, or
  companion root. Run it separately for each intended companion, then run the
  runtime startup-owner preflight before restarting the cluster.
- Use continuous/local `DATA_DIR` only for local development and smoke testing. Production must use split roots and fail closed on shared-root or partial split-root wiring.
- Keep `WORKSPACE_PATH` as one companion's Personal Workspace. It must not
  overlap runtime data roots; live Purrsephone personal files live under
  repo-root `purrsephone/`, while active config, databases, sessions, telemetry,
  and identity artifacts remain under runtime data. In a current cluster this is
  not yet a per-companion isolation boundary; see the workspace warning above.
- Treat owner-file drift warnings as cleanup signals, not as permission to keep `.env` as mutable config authority.
- Review config, startup, persistence, and tool-surface changes against the live boundary. If a compatibility path is not named there, reject it, make it fail closed, or track it for beta removal before expanding it.
- When migration-boundary guidance changes, run `npm run verify:settings-contract`
  and `npm run verify:startup-owner-files`, plus
  `npm run preflight:startup-owner-files` in the affected runtime environment.

## Persistence Backends

PostgreSQL is the only backend for the repo-owned runtime and persistence-aware maintenance commands. SQLite-backed stores, migration readers, and native packages are removed; unsupported backend selection fails before runtime composition.

Operational rules:

- JSONL L0 remains authoritative even when a database mirror is enabled.
- Fast-search tables and indices are projections that can be rebuilt from canonical archive truth.
- Backend-specific adapter code stays behind the port/composition layer.
- PostgreSQL long-term memory requires the `pgvector` extension. Startup and migrations fail closed when `pgvector` is unavailable; there is no supported fallback to `DOUBLE PRECISION[]` scanning.
- If a backend or projection strategy changes, run `npm run lint`, `npm run build`, and targeted parity tests for the affected domains before treating the change as safe.
- If projection drift is suspected, repair from the archive before trusting search results or operator views.
- Projection drift records carry a `kind`. Best-effort `sync` drift (a failed ordinary append) leaves search available. Fail-closed `redaction` drift (a CogSec/turn redaction failed to propagate to the projection, so the projection may still hold content canon has redacted) is durable, excludes the affected session from transcript keyword search until repair succeeds, and raises an operator-only Cognitive Security incident (`cogsec_projectiondrift_*`, `session_integrity` class) in Garden.
- Use `npm run session:repair:transcript-projection` to rebuild the searchable transcript projection from authoritative JSONL L0 after drift, backend migration, or recovery work. A successful channel rebuild clears both drift kinds and restores search for the session.
- The repair utility accepts `--data-dir` and `--sessions-dir` overrides and targets the configured PostgreSQL session projection backend through the port layer.

### Persistent external testing-harness channel

All conversational shakedown, e2e, evaluation, and rollout-smoke traffic that
enters through the OpenAI-compatible API must use the dedicated
`testing-harness` principal. Configure it explicitly in the system-owned
`channels.json`:

```json
{
  "api": {
    "testingHarness": {
      "principalId": "testing-harness",
      "tokenRef": {
        "kind": "env",
        "envName": "TESTING_HARNESS_API_KEY"
      },
      "gardenAdmin": {
        "enabled": true,
        "principalId": "testing-harness",
        "operatorGrantId": "testing-harness-garden-grant",
        "role": "admin",
        "allowedActions": [
          "action_pipe.read",
          "action_pipe.manage",
          "cogsec.read",
          "cogsec.manage",
          "confirmations.read",
          "confirmations.manage",
          "devices.manage",
          "models.read",
          "prompts.read",
          "settings.read",
          "settings.write"
        ]
      }
    }
  }
}
```

Set `TESTING_HARNESS_API_KEY` in the gateway secret environment to a distinct
bearer token of at least 16 characters. It must not reuse `API_KEY`,
`ADMIN_TOKEN`, or a satellite key. A missing owner section, partial section,
missing credential, weak credential, or credential collision fails closed at
configuration load or API construction. In Helm deployments, place
`TESTING_HARNESS_API_KEY` in the operator-managed Secret selected through
`secrets.existingSecret`; `secrets.keys.testingHarnessApiKey` controls the key
name.

`gardenAdmin` is optional and is separate from the conversational channel. When
present, it authorizes only the listed Garden actions at the gateway unified
origin. Kubernetes additionally requires
`fleetAuth.testingHarnessGardenVerifierEnabled=true`; this projects
`PSFN_TESTING_HARNESS_GARDEN_VERIFIER=true` into both sides of the Fleet Garden
boundary. The owner policy, verifier switch, and dedicated secret are all
required. Partial policy, a verifier switch without the policy, or a missing
secret aborts startup or leaves the door closed. The reverse mismatch (policy
present, verifier switch off) is deliberately safe-closed.

The gateway consumes the bearer and never forwards it. It records a durable
Fleet authorization event tagged with `provider: testing_harness`, then issues
the same single-use, short-lived, companion-audience capability used by browser
Fleet SSO. The synthetic session receives only the minimum route assurance
(`oauth` or `escalated`) and can never receive break-glass assurance.

Requests authenticated by that token resolve to the named API principal and
always use the durable session key `api:testing-harness`. `X-Session-ID` is
intentionally ignored for this principal, so independent processes and
post-restart calls rejoin the same room:

```bash
curl http://127.0.0.1:10053/v1/chat/completions \
  -H "Authorization: Bearer $TESTING_HARNESS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "companion",
    "messages": [{"role": "user", "content": "Continue our testing conversation."}]
  }'
```

The credential has the normal API surface, including eval/model-room calls, but
it cannot supply satellite or external-channel identity claims that would escape
the named room. The room deliberately does **not** use the reserved `:testing:`
session namespace: it is a real persistent conversation, so normal memory
extraction and continuity apply. Use a dedicated test companion; do not point
harness traffic at a partner's companion.

The chat door and Garden-admin door are intentionally distinct: configuring the
chat principal alone does not enable Garden administration, and Garden policy
does not widen the chat surface.

### Ephemeral testing-session lifecycle

Harnesses must name ephemeral channels with the reserved
`<existing-channel-prefix>:testing:<name>` namespace. For an API harness, set
`x-session-id` to a value such as
`testing:kube-rollout-validation-20260719`; its stored channel id becomes
`api:<principal>:testing:kube-rollout-validation-20260719`. The marker
preserves ordinary channel-type inference while explicitly excluding the
session from temporal wake/refresher targeting, near-turn maintenance, and
episodic synthesis, plus the sleeptime stack (consolidation, arcs, dreams,
wiki updates, orientation rewrites, and durable memory writes).

When testing is complete, stop the owning companion workloads and purge each
session by its exact channel-index key:

```bash
npm run session:purge -- --session 'api:<principal>:testing:kube-rollout-validation-20260719'
```

For a multi-companion cluster, select the manifest-owned companion explicitly:

```bash
npm run session:purge -- \
  --companion-id '<companion-uuid>' \
  --session 'api:<principal>:testing:kube-rollout-validation-20260719'
```

The command accepts no wildcards. It stages the complete journal chain and
channel-index removal for rollback, clears that companion and session's exact
Redis tail-key family when Redis is configured, then removes the channel's
message and drift projection rows in one PostgreSQL transaction. In split-root
deployments it resolves journals from the companion data root. In cluster mode
it resolves both that root and the non-public PostgreSQL schema from
`companions.json`; missing or ambiguous companion/schema selection fails
closed. When Redis is not configured the report says
`no tail cache configured`. A configured but unreachable Redis aborts and
rolls the staged journals/index back rather than reporting a clean purge.

This ephemeral namespace is for isolated destructive or cleanup-sensitive
probes only, not conversational shakedown/e2e/eval traffic. The command refuses
ordinary sessions. An exceptional non-testing purge requires
`--force-non-testing` and an interactive confirmation in which the operator
types the exact id; use that escape hatch only after independently verifying
the target and backup.

### Optional Redis session tail cache

Deployments with Redis can enable a bounded hot session tail (settings.json `sessionTailCache: { enabled, maxEntriesPerChannel }`, default disabled). Every session append writes through to one Redis ZSET per companion, channel, and epoch (`psfn:session-tail:<companionId>:<channelKey>:e<epoch>`, score = entry id, GC TTL, trimmed to the bound), and turn-context captures read the recent window from that shared tail — so agent, gateway, and garden see ONE consistent recent view instead of three per-process file caches. Keys are scoped by `COMPANION_ID`, so a cluster sharing one Redis never crosses tails between companions. JSONL journals remain the source of truth and the HMAC chain is untouched: tail rows carry no `_hmac` fields, and on any id overlap the journal copy wins — tail rows are only accepted for ids newer than the journal read (cross-process gap-fill). Journal rewrites (CogSec tombstones, turn redaction, compaction invalidation/regeneration, post-repair reloads) bump a per-channel epoch key (`psfn:session-tail-epoch:<companionId>:<channelKey>`) before AND after the rewrite (the second bump is exception-safe: it runs even when a post-rewrite step throws), which fences every pre-rewrite row away from every process; a failed epoch bump fails the rewrite loudly (redaction is fail-closed). Tail writers bind to the epoch captured with their data, so a delayed write can only land under an already-superseded key, and readers re-check the epoch after the range read, treating any change as a miss. Reads validate id contiguity across the window (non-message journal entries appear as explicit id-gap placeholders), and any hole, duplicate, or tail missing the just-recorded entry is treated as a miss (journal read + repopulate). The Redis connection reuses the shared env wiring (`PSFN_REDIS_URL` and related TLS/credential vars, forwarded to the agent by the split launcher); enabling the tail with Redis unavailable fails startup, while a runtime Redis outage degrades loudly (rate-limited warns) to journal reads without dropping turns.

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
cluster identities, canonical machine-intelligence contacts, bilateral trust,
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

## emo-sim Observer-Eval Sidecar

The observer-eval sidecar wraps the external `emo_sim` engine as a bounded
affect accumulator. It is TRACKING-ONLY: lever events and observations are
non-authoritative telemetry read by the Garden admin surface; nothing in the
live companion loop consumes them.

For what it is, the `authoritative: false` boundary, config knobs, the export
API, and the Garden page, see
[`observer-eval-sidecar.md`](./observer-eval-sidecar.md). This section is the
operational runbook only.

Build pin (fail closed). `emo_sim` lives in a separate repo, so it cannot be
pinned by a submodule ref here. `docker/Dockerfile.emosim` pins the build to an
exact upstream commit via `ARG EXPECTED_EMOSIM_SHA` and a `verify` stage that
reads the build context's own git SHA (`COPY .git` → `git rev-parse HEAD`) and
refuses the build on any mismatch, empty SHA, or missing `.git`. There is no
unpinned path. The verified SHA is baked into the image at
`/app/EMOSIM_PINNED_SHA` as provenance. The comparison logic is unit-tested in
`docker/emosim-verify-sha.sh`; to move the pin, change the ARG default in-repo
(reviewed like any other change) and rebuild against a matching checkout.

The pin tracks `emo_sim` `main`, which carries the directed social-need work
(upstream PRs #1 and #4). The `emo_sim` checkout used for a build —
`$PSFN_EMOSIM_SRC`, default `~/emo_sim`, per
`scripts/ops/ship-kube-update.sh --components emosim` — must be at the pinned
commit or the verify stage refuses the build; `git -C ~/emo_sim checkout main &&
git pull` is normally enough. Always pin a commit reachable from `main`: the
verify stage resolves the SHA from the build context's own git metadata, so a
commit reachable only from a feature or integration branch can vanish from a
fresh clone while the pin still demands it. Both merged
features are additive to the API this repo consumes (a relationship record
gains nullable `social_need`/`social_need_scale`; session creation gains an
optional `drive_config`), and no engine data file changed, so the `/api/model`
contract the adapter asserts — 17 appraisal dims, the 48-emotion vector — is
unchanged across the bump.

Read cadence. The adapter samples the server at 1 Hz
(`EMOSIM_MIN_READ_CADENCE_MS`); there is no sub-second polling regardless of the
emo_sim internal tick rate. The server ticks fast on its own wall clock, so at
least one tick always lands between the two per-observation reads.

Physiological-drive exclusion. Per the oth4 operator ruling, physiological
drives (hunger, thirst, sleep_pressure) saturate without real physiological
inputs and MUST NOT drive behavior. They are excluded from every lever and
affect read: `would_rest` reads only mood arousal (never `drives.sleepPressure`;
the old `wouldRest.sleepPressureThreshold` config key is removed and rejected
fail-closed by the settings normalizer), and `would_message` reads social need
and attachment-family dominance only. Drive values are still recorded in the
snapshot for observability; recording is not consuming.

Deterministic degradations. The `emo_sim` server API cannot honor
`deterministic.disableDrives` (requested by the projection). Rather than
silently drop it, the adapter records a structured degradation on every
observation under `runtime.deterministicDegradations` (option, requested value,
`honored: false`, reason, human detail) so downstream consumers can see the
corpus condition (drives keep accumulating across the shared session).

Mood-free event appraisal (projection v3). The observer projection composes an
event appraisal from the PSFN emotion state and hands it to emo-sim, which then
tilts affect with its OWN accumulated mood. v2 also folded PSFN accumulated mood
(EMA) into the projected event signal (valence, self_norm, attachment), so mood
inertia was applied twice — softening clearly-negative inputs net-positive under
a positive-mood (Love) basin. v3 removes the mood component from the projected
EVENT appraisal (the turn's own VAD, discrete labels, and safe metadata only);
accumulated mood is applied exactly once, downstream in emo-sim. Coefficients are
NOT rescaled to compensate. The change is recorded so corpora are distinguishable:
the projection version string moves `appraisal-projection.v2` → `.v3` (schema
1 → 2), and every observer-derived projection carries a structured
`projectedAppraisal.appraisalAdjustments` record (`mood-free-event-appraisal`,
reason `double-mood-inertia`, affected dimensions) plus a mood-free caveat — the
same never-silently-applied pattern as the deterministic degradations above.

Calibration suites. The old single confidence-weighted divergence score and its
aligned/watch/divergent band (the `0.18 / 0.42` thresholds) are LEGACY: they
collapse unrelated concepts into one number and hide the real failure modes.
They are retained for back-compat of persisted rows and the Garden surface but
are not extended (see `OBSERVER_EVAL_LEGACY_DIVERGENCE_NOTE`). Calibration is now
three independent, separately-runnable suites under
`src/core/eval/observer-sidecar/calibration/`, each with documented pass criteria:

- event-direction — a clearly-positive/negative input projects a mood-free event
  appraisal of the correct sign (0 sign inversions; mood-invariant). This encodes
  the v2-window shapes (the dense positive sweep and the fourteen-negatives-under-
  a-positive-basin case) and fails on a mood-contaminated projection.
- mood-trajectory — the EMA-mood trajectory over a projected mood-free event
  stream trends the expected direction (a sustained negative run seeded from a
  positive basin trends down). The EMA is a documented calibration reference, not
  emo_sim's internal accumulator.
- outreach-timing — the `would_message` shadow lever fires when, and only when,
  the modeled social/attachment pressure has crossed threshold and been sustained,
  driven through the real `ObserverLeverTracker`.

The suites run over synthetic fixtures, not live corpus data. They prove the
PSFN-side projection/timing LOGIC; the end-to-end agreement figures on real inputs
(e.g. the negative-direction rate, the live emo_sim mood trajectory, live fire
counts) must be re-baselined operator-side on a clean v2 window with physiological
drives disabled, and cannot be proven from fixtures.

## Backups And Integrity

- Backup cadence and retention live in `backup.json` and `scheduler.json`.

### Generational retention (GFS)

- Retention is a four-tier Grandfather-Father-Son roll applied by `applyTieredRetention` (`src/persistence/backups/retention.ts`): **rotating** (the most-recent 6-hour-cadence snapshots), **daily** (newest backup per UTC calendar day), **weekly** (newest per ISO week), and **monthly** (newest per calendar month). Tiers are additive and protective — a higher tier claims a shared snapshot first, so a snapshot kept as a monthly or weekly generation never consumes a daily or rotating slot. `maxRotatingBackups` / `maxDailyBackups` / `maxWeeklyBackups` / `maxMonthlyBackups` in `backup.json` size each tier; `maxDailyBackups` is optional and, when a pre-existing owner file omits it, defaults from `DEFAULT_BACKUP_DAILY_COUNT` at load (the daily tier is not silently disabled). Setting any tier count to `0` disables that tier.
- The shipped seed policy (`config/backup.seed.json`) is 4 rotating / 7 daily / 4 weekly / 12 monthly — roughly 27 retained generations. The 12 monthly generations give a full 12-month recovery depth, which is what lets a cognitive-security event that is only detected months later still be rolled back to a pre-compromise snapshot.
- Sizing is approximately the sum of the tier counts times the per-snapshot size: ~27 generations at the measured ~600 MB/snapshot is ~16 GB of retained backup footprint.
- Fail-closed invariant: the single newest backup directory always survives pruning regardless of tier counts (even all-zeros), so at least one recent recovery point can never be rotated away. `maxRotatingBackups` also validates to a minimum of 1 in `backup.json`, and env/JSON resolution never lowers it below that.
- Backups are encrypted at rest. `backup.json` declares `encryption.mode: "required"` and an env key reference; the actual key material stays in `PSFN_BACKUP_ENCRYPTION_KEY` or another configured env secret. Startup fails closed when the key is missing.
- Under the PostgreSQL runtime backend the scheduled backup stages a `pg_dump` custom-format archive (requires `pg_dump`/`pg_restore` on PATH) plus session JSONL, memory mutation ledger, and character-card files; the scheduler refuses to start without a database backup source.
- The scheduled backup also stages the full companion-data file tree (journals, generated media/selfies, vault notes, prompt and card history, scratchpad) into `companion-tree/` with a per-file sha256 manifest; the walk is exhaustive except for sessions (captured separately), backup targets, and repair snapshots, so new companion-authored file classes can never silently fall out of scope.
- System-data JSON owner files are staged into `system-config/` with a per-file sha256 manifest. This includes `settings.json`, `models.json`, `providers.json`, `channels.json`, `backup.json`, `trust-policy.json`, `intake-policy.json`, and `partner-affect-shadow.json` when present. `.env`, generated systemd env files, and raw provider/channel secrets are not copied by this system-config snapshot. `capability-tier.json`, `scheduler.json`, `charge-policy.json`, and `skills.json` are per-companion owner files rooted at `companionDataDir`, so they are captured by the exhaustive `companion-tree` slice above, not this cluster-global system-config slice.
- Helm deployments also stage `helm-recovery/`: the recovery-safe deployable files from the repo-owned `deploy/helm/psfn` chart plus a versioned descriptor containing release name, namespace, Helm revision, an exact chart-content digest, and the effective agent/gateway/Garden image references. Documentation files, live Helm values, rendered manifests, Kubernetes Secret objects, and secret material are deliberately excluded. Real YAML parsing rejects secret-bearing values regardless of quoting, inline-map, or snake-case syntax; unsupported overlays, packed/opaque subcharts, special files, and source/destination overlap fail closed before capture writes anything. The chart has a per-file sha256 manifest and is verified before encryption and again by `verify:backup-restore`.
- Every snapshot contains `backup-contents.json`, which records whether Helm recovery is `required` or `absent`. In production this marker is inside the authenticated encrypted payload, so deleting the entire Helm subtree cannot make a Kubernetes backup masquerade as a non-Kubernetes backup. Restore operators still re-provision credentials and review deployment-specific overrides rather than replaying stale secrets.
- The configured Personal Workspace is staged separately into `workspace-tree/` with its own sha256 manifest. This covers its docs, downloads, images, journal/scratchpad files, authored skills/modules, experiments, and canonical `knowledge/wiki/` store. In cluster mode, each companion slice contains only that companion's Personal Workspace; the cluster artifact contains only the governed Shared Companion Workspace. Group mode captures the complete `workspaces/` parent in its one family artifact. Runtime roots, backup targets, VCS metadata, dependency directories, caches, and temp directories are excluded and recorded in the manifest.
- Workspace backup fails closed if `WORKSPACE_PATH` overlaps runtime data roots, logs, temp, backup output, the mirror target, or other protected runtime paths. Keep personal wiki/reference documents under `WORKSPACE_PATH/knowledge/wiki/`; do not rely on the external Obsidian bridge for canonical storage or backup coverage.
- With `verifyRestore` enabled, every scheduled cycle verifies the plaintext staging area before encryption: it restores the dump into a dedicated scratch database (`<dbname>_restore_verify`, derived from the runtime database URL) and asserts schema, pgvector functionality on restored vectors, critical-table presence, and that tables populated at the source restored non-empty. One-time setup: `CREATE DATABASE <dbname>_restore_verify OWNER <runtime-role>` and `CREATE EXTENSION vector` in it as superuser (the extension survives wipes; user tables/sequences/views are dropped each run). The dump archive table of contents is also checked via `pg_restore --list`; companion-tree, workspace-tree, system-config, backup-contents, and Helm manifests are re-verified; and the L0 session-archive snapshot must parse as JSONL.
- The gateway-owned fleet-auth lane verifies the complete coordinator/recovery family before encryption. Before any scratch mutation it requires the authenticated coordinator manifest and recovery manifest to name exactly the same companion/shared schema slices and requires every recovery dump digest to match the coordinator artifact. It then runs the canonical owner-authenticated family restore against `<dbname>_restore_verify`, applies and checks the recorded access/isolation contracts, verifies the fleet-auth import transaction against a cloned authority floor, and rolls every restored schema back. Provision the scratch database so the backup/restore, fleet-auth migration, companion-owner, and shared-migration roles can connect and so each schema owner can create its own schema; gateway startup migrates only the scratch `fleet_auth` schema. Missing, routed, wrong-role, cross-database, or unusable owner credentials fail before restore mutation. This rehearsal never invokes a production restore or updates the production authority floor.
- After verification, the retained backup set contains `encrypted-backup.json` plus `snapshot.tar.gz.enc`; the plaintext staging directory is removed. Mirrors receive the encrypted package, not the plaintext tree.
- `npm run verify:backup-restore -- --backup-dir <snapshot> --postgres-restore-url <scratch-url> [--postgres-source-url <url>]` decrypts encrypted backup sets using the manifest key reference and runs the same fidelity verification (the decant rehearsal).
- A failed scheduled backup logs an error and emits a `backup.failed` event on the runtime event bus. When the failure is a partial fleet family (`FleetBackupPartialFailureError`), both the log line and the backup diagnostic name the failing unit — companion id, schema, and per-unit error — plus the fleet manifest that recorded every outcome.
- Every backup lane proves its backup root is writable before it arms itself (`assertBackupRootWritable`, `src/persistence/backups/backup-root.ts`) and throws `BackupRootNotWritableError` otherwise, which fails startup. A lane that cannot write its root is a lane that silently loses every cycle, so it must never report itself enabled instead. In Kubernetes this means the workload owning a backup lane must mount the runtime PVC's `backups` subPath at `runtime.backupsDir`: the fleet agents and the gateway (which owns the fleet-auth consistent lane) all carry that mount in `deploy/helm/psfn/templates/workloads.yaml` and `fleet-agents.yaml`.
- The gateway-owned fleet-auth lane persists a scheduling watermark, `fleet-auth-backup-watermark.json`, at the root of the backup tree (a plain file, which tiered retention never prunes — pruning only considers timestamp-named directories). The cadence is seeded from it at startup rather than from process start, so the lane survives short-lived pods: with no watermark, or one older than `intervalMs`, a catch-up cycle runs at boot; with a newer one, the lane waits out the remainder so restart churn cannot turn a heavy consistent backup into a per-boot job. The watermark records the last *attempt* as well as the last completion, which is what bounds a crash-looping gateway to one cycle per interval. A replaced backup volume correctly resets it, and a damaged watermark is treated as absent (the safe direction: an extra backup, never a skipped one).
- Cluster backups are per-companion by default: each companion is captured as its own slice (its own `postgresSchema` dump, companion-data tree, and Personal Workspace) so one companion can be moved to another cluster as a slice. A separate `cluster` artifact captures the shared-world schema (`shared`), system-data owner files, the Shared Companion Workspace, and the Helm recovery bundle when applicable; Helm files and peer Personal Workspaces never leak into companion slices. Enabling `groupMode` (`backup.json`, env override `BACKUP_GROUP_MODE`) instead collapses the cluster into one whole-database family artifact containing the complete workspace family and system-level bundle. Exactly one process runs the cluster backup cycle: the leader is deterministic — the first companion in `companions.json` order (`isFleetBackupLeader`, `src/persistence/backups/fleet-scheduler.ts`), no distributed lock — and followers register no backup lane. Partial failure (`FleetBackupPartialFailureError`) is recorded and re-thrown, never swallowed. Destination-aware restore helpers in `src/persistence/backups/fleet-restore.ts` restore exactly one companion, cluster, or group scope after verifying the backup manifests and reject existing or overlapping destination roots rather than merging them.
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

### Append-only subsystem-output tables — keep-forever retention

Two Postgres tables record what each background subsystem produced for a turn so
projection reads survive terminal background-job purge:
`agent_turn_subsystem_output_refs` and `agent_turn_subsystem_output_status`
(`src/persistence/postgres/migrations.ts`). Both carry `BEFORE
UPDATE/DELETE/TRUNCATE` reject triggers — they are append-only by design, and
`purgeTerminal` deletes only `agent_background_work_jobs`, never these refs — so
they have no pruning path and grow for the life of the companion.

**Operator decision (recorded): keep forever.** The rows are tiny, and the
cognitive-security recovery guarantee comes from the 12-month generational
backup depth (above), not from trimming these tables. A retention/prune surface
is deliberately not built. If measured growth ever challenges this, the prune
must be an explicit, audited maintenance path that drops the trigger inside a
guarded transaction — never a silent background delete of companion-derived
records. The math below documents why keep-forever is safe.

**Write rate.** Rows are written only by the memory-extraction background job via
`PostgresBackgroundWorkStore.completeEffect` (it is the only caller that sets
`projectsSubsystemOutputs: true`). Extraction is interval-gated, so this is
per-extraction, not per-turn:

- `…_status`: at most **1 row per extraction** (the primary key is turn-scoped;
  every insert path is `ON CONFLICT DO NOTHING`).
- `…_refs`: **N rows per applied extraction**, where `N = |memoryIds| +
  |concernIds| + |contactIds|` after dedupe. The default memory-write cap is 2
  (`DEFAULT_MAX_WRITES`), plus a handful of concern/contact ids, so typical `N`
  is ~0–4. `completeEffect` hard-caps the batch at **128** (it throws above),
  bounding the worst case.

**Bytes per row.** Every column is `TEXT` except `recorded_at_ms BIGINT`; there
is no `jsonb` and no payload body — the tables store only identifiers, a small
status enum (`applied`/`failed`/`outcome_unknown`), and a compact
`loom-output:v1:<kind>:<base64url-id>` ref string (~70 bytes). Including the
Postgres heap-tuple header and index tuples (`…_refs` is double-indexed: the
5-column primary key plus `idx_agent_turn_subsystem_output_refs_turn`), a live
row is roughly **~500–700 B for `…_refs`** and **~300–400 B for `…_status`**.

**Projected growth.** Per applied extraction that lands ~3 refs: `1 × ~375 B`
(status) `+ 3 × ~650 B` (refs) ≈ **~2.3 KB all-in**. At a realistic-to-heavy
**300–1,000 extractions/day** per companion that is **~0.75–2.5 MB/day**, i.e.
**~0.3–1 GB/year**. The pathological 128-ref cap case is ~83 KB for a single
extraction and cannot recur without a matching extraction rate.

Against the retained backup footprint (~16 GB) and the operator's "100 GB is
excessive" ceiling, ~0.3–1 GB/year keeps a decade of history in the low single-
digit gigabytes — comfortably keep-forever. **Revisit trigger:** if the measured
row rate (a `SELECT count(*)` on either table over a known window) implies a
sustained multi-GB/year trajectory, plan the guarded drop-trigger maintenance
path described above rather than letting it run unbounded.

> Consistency note (non-exploitable, hardening only): the projection-binding
> hash for these refs is plain SHA-256 (`src/shared/contracts/subsystem-output-refs.ts`),
> whereas fleet-auth digests are HMAC-keyed. Assessed non-exploitable — the hash
> binds internal turn identifiers, not an attacker-influenced signature — so it
> is recorded here for consistency, not scheduled for change.

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
are not committed to git and are never downloaded at runtime. Provisioning is a
**verified deploy prerequisite** — the posture depends on `intake-policy.json`
`mode` (`src/boundary/gateway/intake/compose-screening.ts`, `cyy7l`):

- **`mode=enforce` + weights absent → gateway startup FAILS CLOSED** with an
  actionable error naming `npm run provision:injection-model`. A degraded
  L1-only firewall under an enforce posture reports "armed" while L1.5 never
  scores, so the gateway refuses to start until the weights are on disk.
- **`mode=shadow` + weights absent → loud skip**: one structured startup
  warning (never per-message), screening continues on the deterministic L1
  layer alone, and intake health is flagged `injectionClassifier.degraded`.
- **weights present but broken (any mode) → gateway startup fails closed.**

Provision (pinned revision, every file sha256-verified):

```bash
npm run provision:injection-model -- --dest ./models/prompt-injection-v2
```

On Kubernetes, provisioning targets the model-cache PVC at
`<runtime.modelCacheDir>/prompt-injection-v2` (the gateway's
`PSFN_INJECTION_MODEL_DIR`). Set `modelPrefetch.enabled=true` (requires
`persistence.modelCache.enabled=true`); the chart's model-prefetch Job runs an
`injection-classifier` container that provisions the pinned weights onto the
PVC before the restricted-egress gateway starts. Verify the deploy contract
(the prefetch destination must match the gateway's model path) with:

```bash
npm run verify:deployment-contracts
```

Failure symptoms:

- Gateway `CrashLoopBackOff` with `mode=enforce but the L1.5 injection
  classifier weights are not provisioned` → the model-cache PVC was never
  populated (run/enable the prefetch, or provision the PVC out of band).
- Startup log `Intake L1.5 injection classifier weights are not provisioned;
  gateway intake screening runs on the deterministic L1 layer alone (DEGRADED)`
  under `mode=shadow` → the firewall is running without L1.5 scoring; provision
  before switching to enforce.

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

### Intake-policy schema v1 → v2

Schema v2 adds the required `skill_write` sink. Runtime startup does not fill
it from defaults and will reject schema v1. With app processes stopped, run
the repo-owned migration against the exact system owner root, inspect the
plan, apply it, and run canonical preflight:

```bash
npm run migrate:intake-policy-owner -- --data-dir "$SYSTEM_DATA_DIR"
npm run migrate:intake-policy-owner -- --data-dir "$SYSTEM_DATA_DIR" --apply
npm run preflight:startup-owner-files
```

The migration preserves all existing policy values, adds only
`sinkGates.sinks.skill_write`, bumps `schemaVersion` to 2, validates the full
candidate, and publishes it with a durable atomic replacement. A v1 file that
already carries `skill_write`, an incomplete sink map, or a changed file
identity fails closed instead of being guessed at.

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

### Partner Affect shadow observations

The Partner Affect observation foundation ([design](partner-affect.md), slice
1) is policy-owned by `partner-affect-shadow.json` (cluster-global, seeded
from `config/partner-affect-shadow.seed.json`). The subsystem ships disabled
and partner-unbound; enabling it requires an exact canonical partner contact
id — the owner file fails validation otherwise. All mutable policy lives in
the owner file: staleness and evidence windows, minimum confidence, the
independent-family quorum, conflict tolerance, allowed Signal Families,
per-metric directions, the authorized-source consent registry (source-level
opt-in/revocation), and the shadow retention cap.

Shadow-only invariant: accepted/suppressed observations and the derived
estimate are recorded for inspection and never feed prompts, emotion
appraisal, memory candidacy, scheduling, notifications, or world actions (a
source-tree isolation test enforces the import boundary). Observations enter
through `POST /v1/telemetry` with eventType
`external.telemetry.partner_affect.observation`; payloads are screened at the
API door and again by the fail-closed observation guard (whitelisted scalar
summary fields only — raw coordinates, biometric streams, message bodies, and
purchase line items are rejected and never stored). Garden exposes the raw
policy editor under Settings and two read-only inspection endpoints:
`GET /api/admin/partner-affect/shadow` (policy summary + deterministic
estimate with per-family freshness/coverage/missingness/conflicts) and
`GET /api/admin/partner-affect/observations` (recent accepted and suppressed
records, structural reason codes only), both gated by the contacts-read
authority.

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

## External MCP Client Operations

External MCP configuration is system-owned in `mcp-servers.json`; credentials
remain gateway-owned secret references. Editing the file through Garden
**Settings → Owner files** validates the complete replacement and reports that
a restart is required. Startup rejects missing/malformed config, non-HTTPS
endpoints, embedded credentials, invalid trust claims, permissive default tool
policy, and destructive/control tools without `confirmation: "always"`.

Use Garden **Tools → Health** for the companion-scoped operational view. Each
server card intentionally contains only its id/display name, configured trust
level, active/loaded state, policy effects/confirmation, and the latest static
metadata screening disposition/hash/time/tool count. Endpoint URLs,
credential references, descriptions, schemas, and tool results are never health
data.

The normal lifecycle is:

- `unloaded` before first selection: catalog access has caused no network I/O.
- `schema loaded` after search/inspect/call: one companion/server client is
  active and its screened definitions are resident.
- `screened` plus `sha256:<digest>`: that exact canonical metadata version has
  passed CogSec. This means screened, not trusted or permanently approved.
- automatic unload after `limits.idleConnectionTtlMs`, companion disconnect, or
  gateway shutdown. `limits.metadataCacheTtlMs` independently controls when an
  active session relists tools.

Use **Unload server** to close one connection and discard its loaded schemas, or
**Unload all** for every server belonging to the authenticated companion. These
controls call the reversible authenticated endpoint
`POST /api/admin/tools/mcp/release`; `{ "serverId": "private-notes" }` selects
one server and `{}` selects all. The gateway derives the companion from the
authenticated Garden lane and never accepts a companion id in the body. The
next selected MCP action reconnects lazily. The static hash cache may remain
outside conversational context so byte-identical metadata does not need another
CogSec pass; broker shutdown clears it.

Dynamic results never use the static cache. Every `tools/call` response is
bounded, canonicalized, and screened through CogSec before any text returns to
the agent. A trusted or primary server does not bypass this rule. Trust only
sets an upper bound on what PSFN may send and combines with the configured tool
effect and confirmation mode.

Failure triage:

| Symptom | Check |
| --- | --- |
| Server absent from the catalog | `enabled`, `allowedCompanionIds`, and the authenticated companion identity |
| TLS/certificate failure | Endpoint hostname/SAN, private CA PEM secret, certificate chain, and TLS 1.2+ support |
| URL blocked before connection | HTTPS scheme, hosting factor, DNS result, target allowlist, and absence of redirects |
| 401/403 | Bearer/API-key reference or OAuth client, issuer, token endpoint, and scopes; secrets are never logged |
| Tool absent/denied | Exact `toolPolicy.tools` name and `default: "deny"`; a remote list change never grants policy |
| Metadata withheld/invalid | CogSec event and server schema bytes; changed metadata must pass a fresh scan |
| Call needs approval | Tool `confirmation` plus outbound sensitivity; approval is bound to the exact arguments |
| Repeated connection failures | Tools health last-failure summary and gateway logs; unload once after correcting the cause |

Do not work around failures by enabling plain HTTP, disabling certificate
verification, widening the trust factors beyond reality, or copying secrets into
the owner file. PSFN intentionally has no stdio or legacy SSE fallback.

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

## Container and IaC Security Scanning (Trivy)

Trivy owns exactly the surfaces the other gates do not: **rendered Helm/Kubernetes
misconfiguration** and **built container images**. It never scans npm lockfiles
(OSV owns those; see *Dependency Update Policy*) and never scans source code
(Semgrep owns that). The wrapper is `scripts/ci/run-trivy-scan.mjs`.

### Pinned scanner and supply-chain posture

Trivy runs from an **immutable digest** (v0.72.0,
`ghcr.io/aquasecurity/trivy@sha256:c6e969c…5b97ada`) — never `aquasecurity/trivy-action`,
`setup-trivy`, or a floating tag. The Trivy ecosystem suffered a March 2026
credential compromise, so only the reproduced post-incident digest is trusted;
the wrapper probes `trivy --version` and **fails closed** if it is not `0.72.0`
before any scan runs. Every invocation is **tokenless**, passes
`--disable-telemetry` and `--skip-version-check`, and **never mounts the Docker
socket**.

### Config scan (Helm/Kubernetes misconfiguration)

`node scripts/ci/run-trivy-scan.mjs config` renders the repo-authoritative chart
with real Helm and the representative fail-closed non-fleet values (the same
inputs `verify:deployment-contracts` uses) into a per-template directory
(`helm template --output-dir`), then scans the rendered YAML at
`--severity HIGH,CRITICAL --exit-code 1`. A missing Helm binary, render failure,
empty render, missing/expired ignore entry, or scanner error fails the gate
closed. It runs in `.github/workflows/trivy-config.yml` on IaC-touching pull
requests (a **standalone** gate, never wired into `ci-required`) and weekly so
the bundled misconfiguration checks stay fresh.

The current baseline is **clean** at HIGH/CRITICAL: the first-party app
containers (agent, gateway, Garden, LiteLLM, and their init containers) run with
`readOnlyRootFilesystem: true` (the `/app` image is read-only by design; a writable
`/tmp` emptyDir backs incidental temp writes), and Postgres/Redis carry an
explicit hardened container security context (`allowPrivilegeEscalation: false`,
`seccompProfile: RuntimeDefault`).

### Image scan (vulnerabilities)

`node scripts/ci/run-trivy-scan.mjs image (--input <archive.tar> | --image <ref@sha256:…>)`
scans an **exported image archive** or an **exact remote digest** — never a
floating tag, never the Docker socket — at `--severity HIGH,CRITICAL --exit-code 1`.
`.github/workflows/trivy-image.yml` runs it daily and on demand against the digest
from the `image_digest` dispatch input or the `TRIVY_IMAGE_DIGEST` repository
variable; with neither set it **fails loudly rather than skipping**. A private
registry would need a separately reviewed credentialed path.

### Feed policy (mutable DB, immutable pins)

Trivy's **vulnerability database is a mutable security feed** and is refreshed on
every run (Trivy downloads the latest DB by default), so advisories that land
after build time are caught rather than silently frozen. The **application/image
target is immutable** (always an exact `@sha256:` digest), and the scanner itself
is pinned by digest. This is the deliberate split: mutable *feed*, immutable
*pins*.

### Exception policy (`.trivyignore.yaml`)

Exceptions live in the repo-owned `.trivyignore.yaml` and are **exact** (one rule,
one rendered template path), **justified** (a `statement`), **owned**, and
**expiring**. Broad rule- or path-wide suppression is forbidden. Trivy 0.72.0 does
not enforce the `expiry` field for misconfiguration ignores, so the wrapper does:
an entry that is missing, malformed, unscoped, or **past its expiry** fails the
gate closed and forces a fresh review. The only current exceptions risk-accept
`AVD-KSV-0014` (writable root filesystem) on the third-party Postgres and Redis
StatefulSets, whose upstream images write across the root filesystem at startup;
read-only-root hardening for them is a live-validated follow-up.

## CI Typecheck Baseline

The `Typecheck (baselined)` CI lane runs the root `tsconfig.json` and fails when
any `(source path, TypeScript diagnostic code)` pair is new or exceeds its
checked-in count in `config/typecheck-baseline.json`. Counts deliberately omit
line numbers, so moving otherwise-unchanged code does not churn the baseline.
Compiler failures and non-file diagnostics fail closed rather than becoming
baseline entries.

Run the same gate locally:

```bash
npm run verify:typecheck-baseline
```

When a reviewed change removes existing errors, refresh the baseline with
`npm run verify:typecheck-baseline -- --update`. Update mode rejects new pairs
and count increases. Review the JSON diff and only land removals or reduced
counts; never re-baseline to accept a new error.

The Garden UI is outside the root TypeScript project. It has its own
`admin-ui/tsconfig.json` and is checked with `npm --prefix admin-ui run check`;
a dedicated Garden typecheck CI gate is separate follow-up work.

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
npm run verify:typecheck-baseline
npm run verify:repository-hygiene
npm run verify:commit-identities -- --base <base-sha> --head <head-sha>
npm run verify:agent-docker-isolation
npm run test:group-harness
npm run test:prompt-goldens
npm run test:leak-matrix
```

- `npm run test:group-harness` runs the group-chat prompt-shape regression suite (`src/core/session/group-chat-harness/`). It drives the real prompt-assembly and memory-retrieval paths against synthetic multi-human room, DM, and non-member fixtures: room-visibility leak probes, group history attribution, room-scoped core memory, and conversation_state. Known group-chat defects are encoded as `it.fails(...)` expected failures (speaking_with tokens populating on group turns; DM core-memory participant binding following an arbitrary history speaker instead of the canonical contact) and flip to real failures when a fix lands. Reusable assertion helpers live in `group-chat-harness/assertions.ts`.
- `npm run test:leak-matrix` runs the Context Envelope leak-rate test family (`src/core/session/group-chat-harness/envelope-leak-matrix.test.ts`, E3.6). A documented ~26-row corner matrix (envelope class x sensitivity x trust tier, plus consent/disclosure-boundary/high-intimacy-contact-scope corners) drives the REAL `MemoryRetriever.retrieve` gating pipeline (`evaluateRetrievalAccessDecision` / `evaluateMemoryPolicy`) against synthetic sentinel memories -- not the unit-level gate suite in `src/system/trust/envelope-gating.test.ts` (E3.3), which this suite complements rather than duplicates. Every forbidden corner asserts zero leak of the sentinel text through the assembled output plus the correct withheld reason code (via the label `formatMemoryWithheldReasonLabel` renders); every allowed corner asserts presence, including positive controls for the room->DM-of-member, trust-ceiling, high-intimacy-contact-scope, and consent-granted paths. It reuses the group-chat-harness fixtures and adds a small set of additive fixture variants (a broadcast channel, an anonymous-audience room, and consent-flagged/boundary-tagged/contact-scoped sentinel memories) to `group-chat-harness/fixtures.ts`.
- `npm run test:prompt-goldens` runs the prompt-shape golden suite (`src/core/session/group-chat-harness/prompt-shape-goldens.test.ts`). Six deterministic golden snapshots under `group-chat-harness/goldens/` freeze the full rendered system prompt plus ordered block list for DM, group, heartbeat, DM-scoped reflection, DM-with-memories, and group-with-withheld-memories turns, and the suite also asserts the frozen static prompt prefix is byte-equal across consecutive turns. A failing golden means the assembled prompt shape changed: never blind re-record. For an intentional shape change, regenerate with `npx vitest run src/core/session/group-chat-harness/prompt-shape-goldens.test.ts -u`, review the golden diff like code, and explain the block-level change in the PR; then run `npm run test:prompt-goldens` twice to prove determinism. The full update procedure is documented in the test file header.
- `npm run smoke:chat` exercises the split-runtime admin bootstrap and the
  persistent testing-harness chat room; it requires
  `TESTING_HARNESS_API_KEY`. Set
  `PSFN_SMOKE_REPORT_PATH=/tmp/psfn-smoke-report.json` to capture a JSON
  artifact with the bootstrap, chat, and optional voice checks.
- `npm run verify:startup-owner-files` validates repository seeds against an
  explicit isolated split-root fixture. `npm run preflight:startup-owner-files`
  validates the real runtime roots and topology without creating fixtures; the
  launcher runs it immediately before the gateway. `npm run e2e` uses its own
  isolated runtime harness.
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
