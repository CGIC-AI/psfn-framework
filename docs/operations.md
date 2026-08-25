# Operations

This repository owns complete lifecycle commands for three public deployment
paths. A live installation's addresses, kubeconfig, Helm values, credentials,
host inventory, and infrastructure automation remain operator-owned and must
not be committed here.

## Lifecycle map

| Operation | Docker Compose | Repository-native | Helm / Kubernetes |
| --- | --- | --- | --- |
| Start/install | `npm run compose:up` | `npm run local:up` | `npm run helm:up` |
| Inspect | `npm run compose:status` | `npm run local:status` | `npm run helm:status` |
| Diagnose | `npm run compose:doctor` | `npm run local:doctor` | `npm run helm:doctor` |
| Full persistence proof | `npm run compose:verify` | `npm run local:verify` | `npm run helm:verify` |
| Restart | `npm run compose:restart` | `npm run local:restart` | `npm run helm:restart` |
| Update | `npm run compose:update` | `npm run local:update` | `npm run helm:update` |
| Logs | `npm run compose:logs` | `npm run local:logs` | `npm run helm:logs` |
| Stop, preserving data | `npm run compose:down` | `npm run local:down` | `npm run helm:down` |

Run commands from the same checkout and environment used for installation.
Lifecycle commands validate all required owner files and credentials before
acting. They do not silently switch providers or deployment paths.

## Access and readiness

The default local endpoints are:

- Garden login: `http://127.0.0.1:10053/login`
- OpenAI-compatible API: `http://127.0.0.1:10054/v1`

Compose and repository-native installations take the Garden `ADMIN_TOKEN` from
their ignored `.env`. Kubernetes keeps it in the retained application Secret;
retrieve it only when needed with `npm run helm:token`.

Helm exposes neither service publicly by default. `helm:up` creates supervised
loopback port-forwards. If cluster workloads are healthy but a page no longer
loads after a reboot or shell exit, run:

```bash
PSFN_KUBE_CONTEXT=my-cluster-context npm run helm:connect
```

`helm:disconnect` stops only those local forwards. It does not stop workloads.

Use `*:doctor` for routine readiness. It checks the supervisor/workloads,
PostgreSQL, gateway subsystems, agent, Garden health, token login, and the
authenticated Garden application. Use `*:verify` after first installation or a
meaningful update: it adds a real provider turn, exact canonical TurnRecord
proof, a full runtime restart, and post-restart persistence and Garden checks.

## Updates and recovery

### Docker Compose

`compose:update` rebuilds the current checkout and reconciles the persistent
stack. Compose data roots and the PostgreSQL volume are not replaced. Run
`compose:verify` after updating.

### Repository-native

`local:update` first verifies the running installation, retains the current
built runtime as last-good, builds the checkout, and restarts it. A failed
candidate is retained for diagnosis and the old build is restored
automatically. `local:recover` explicitly restores the last-good build retained
by the most recent update.

Owner files, PostgreSQL, sessions, and workspaces are outside the build and are
not rolled back with code. Use the product's owner revision/audit surfaces when
configuration itself must be reversed.

### Helm / Kubernetes

Every command requires `PSFN_KUBE_CONTEXT`; there is no current-context
fallback. For a registry-backed cluster, `PSFN_IMAGE` must contain an exact tag
or digest. For local k3d, set the matching `PSFN_K3D_CLUSTER` and the lifecycle
builds and imports an exact source-tagged image.

`helm:update` performs an atomic Helm upgrade and waits for the complete
release. Helm restores the previous release when readiness fails. Application
PVCs, the PostgreSQL StatefulSet claim, generated runtime Secrets, and
persisted owner files carry retention policy and survive failed installs,
rollbacks, and `helm:down`.

The lifecycle installs the chart's pinned cert-manager version when the cluster
does not already provide its CRDs/controllers. It never changes kubeconfig or
creates/selects a cluster.

## Stop and resume

All three `*:down` commands stop compute while retaining runtime data.

- Compose stops and removes its containers and network, retaining named volumes
  and bind-mounted data.
- Repository-native stops the detached supervisor and all four host processes.
- Helm stops local forwards and scales every release Deployment and StatefulSet
  to zero, retaining PVCs, Secrets, and the Helm release.

Resume with the corresponding `*:up`, then run `*:doctor`. Do not use manual
volume deletion, `docker compose down --volumes`, or Helm uninstall as ordinary
stop operations.

## Runtime roots and ownership

Production mode uses non-overlapping roots:

```text
PSFN_RUNTIME_ROOT       parent for runtime-managed storage
SYSTEM_DATA_DIR         system owner files and system state
COMPANION_DATA_DIR      one companion's owner files and continuity state
WORKSPACE_PATH          that companion's Personal Workspace
```

`SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR` must be set together.
`WORKSPACE_PATH` must not overlap either one. Startup fails closed when the
layout is incomplete or overlapping.

Mutable settings are owned by canonical JSON files, including
`settings.json`, `models.json`, `providers.json`, `scheduler.json`,
`capability-tier.json`, `channels.json`, `skills.json`, `trust-policy.json`,
`intake-policy.json`, `charge-policy.json`, and `backup.json`. Environment
variables own secrets and process/host wiring, not ordinary settings.

The Helm lifecycle stages the onboarding copies in a ConfigMap, then init
containers copy only files absent from persistent storage. An upgrade therefore
does not overwrite configuration changed through Garden.

## Credentials

Never commit populated `.env` files, credential files, Kubernetes Secrets,
kubeconfigs, private keys, database URLs, tokens, or identity material.

Compose and repository-native onboarding keep secrets in the ignored `.env`.
The Helm lifecycle reads the selected provider variable from the process
environment, creates or updates Kubernetes Secrets without passing values on
the Helm command line, and reuses previously generated runtime/database
credentials. Secret values are not printed by status, doctor, or verify.

## Backups

Backup behavior is governed by `backup.json`, `BACKUP_ROOT_DIR`, and an
encryption key supplied through the deployment's secret channel. The backup
root must be durable and writable or startup fails.

Before depending on a backup lane, validate the generic backup/restore contract:

```bash
npm run verify:backup-restore
```

A real recovery rehearsal must restore into an isolated target and prove owner
fingerprints, PostgreSQL state, sessions, workspace content, and post-restore
startup. Keep retention rules, storage endpoints, and recovery evidence in the
operator's external configuration authority.

## Diagnosis order

When `*:doctor` fails, inspect in this order:

1. the lifecycle's status output and component/workload logs;
2. persistent-root separation, volume attachment, ownership, and free space;
3. required owner files and settings-contract versions;
4. PostgreSQL/pgvector readiness and migration-role access;
5. gateway-to-agent transport and role-bound authentication;
6. model-prefetch completion and provider authentication/quota/model access;
7. Garden loopback forwarding for Helm.

Do not weaken policy or add a second configuration path to make a failed health
check green. Repair the owning file, credential, volume, or workload and rerun
the same lifecycle command.

## Public/private deployment boundary

The generic, public deployment authorities are:

- `scripts/compose-lifecycle.ts` with `docker/compose.yml`;
- `scripts/local-lifecycle.ts` with the runtime entrypoints; and
- `scripts/helm-lifecycle.ts` with `deploy/helm/psfn`.

There are no parallel Kustomize, proxy, or deployment trees. Private operators
may wrap these public lifecycles, but their values, overlays, service names,
addresses, cluster definitions, credentials, and run evidence stay outside the
application repository. The public source never identifies or infers a live
deployment.
