# Operations

This document covers the runtime interfaces maintained by this repository. It
does not prescribe an operator's hosts, cluster layout, service names, storage
mounts, private addresses, or deployment automation. Keep those details in a
separate private configuration repository.

## Supported entrypoints

Run components explicitly:

```bash
npm run gateway
npm run agent
npm run operator
```

The gateway, agent, and operator may run as separate processes or workloads.
Deployment tooling is responsible for supplying their environment, owner files,
credentials, health checks, restart policy, and durable storage.

## Runtime roots

Production mode requires non-overlapping system and companion roots:

```text
PSFN_RUNTIME_ROOT       parent for runtime-managed storage
SYSTEM_DATA_DIR         system-owned configuration and state
COMPANION_DATA_DIR      one companion's configuration and state
WORKSPACE_PATH          that companion's Personal Workspace
```

Set `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR` together. `WORKSPACE_PATH` must
not overlap either runtime data root. The process fails closed when production
roots overlap or are incomplete.

Treat these roots as persistent data. Do not bake live owner files, identity
cards, databases, credentials, sessions, telemetry, or backup payloads into an
image or this repository.

## Configuration ownership

Use environment variables for secrets and process wiring. Mutable settings are
owned by JSON files under the configured data roots, including:

- `settings.json`
- `models.json`
- `providers.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`
- `intake-policy.json`
- `charge-policy.json`
- `backup.json`

Before promoting configuration changes, run:

```bash
npm run verify:settings-contract
npm run build
```

Examples in `.env.example` are bootstrap documentation only. They are not a
source of truth for a live installation.

## Credentials

Prefer file- or descriptor-backed credentials where the runtime supports them.
Give each process only the credentials it needs, keep credential files outside
the source tree, and restrict filesystem permissions at creation time. Never
commit populated environment files, Kubernetes Secrets, kubeconfigs, TLS private
keys, database URLs, provider tokens, or generated identity material.

## Health and logs

Supervise each component independently. Capture stdout/stderr in the deployment
platform and retain enough history to diagnose startup failure and request
correlation. A supervisor should use the component's documented health surface,
not the presence of a process name, as its readiness signal.

When startup fails, verify in this order:

1. runtime-root separation and write permissions;
2. required owner files and their schema versions;
3. credential-file presence and permissions;
4. database connectivity and migration authority;
5. gateway transport and companion authentication wiring;
6. provider and channel configuration.

## Backups

Backup behavior is configured through `backup.json` and `BACKUP_ROOT_DIR`.
Operators are responsible for mounting durable backup storage and supplying the
encryption key through a secret channel. A configured backup lane must be able to
write its root or startup fails.

Validate backup and restore behavior before relying on it:

```bash
npm run verify:backup-restore
```

Store restore procedures, retention policy, storage endpoints, and any
deployment-specific recovery artifacts in the private deployment repository.

## Deployment boundary

This repository intentionally does not track live Helm values, rendered
manifests, cluster scripts, system service units, host inventories, hardware
profiles, or operator-specific CI. A deployment repository may consume the
published application images and invoke the entrypoints above. The application
repository must remain publishable without exposing that deployment repository.

Use reserved documentation addresses and placeholder hostnames in public tests
and examples. Keep real operational evidence outside this checkout.
