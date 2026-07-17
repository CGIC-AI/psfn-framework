# Helm Fleet Upgrade Guide

Read this document before changing any PSFN Helm release, including Carlini,
Pi, and local validation clusters. It is the canonical upgrade brief: it calls
out ordering constraints and operator-visible changes that are easy to miss.
Detailed subsystem procedures remain in the linked runbooks.

## Current upgrade notes

### Deploy the gateway before agents

For releases that include the welfare-grant verification boundary introduced
by `b87ba13cbc`, deploy the new gateway before any new agent.

During the old-agent/new-gateway skew window, an agent cannot present the new
gateway-verifiable welfare grant. The gateway strips
`preemptionProtected`, so affected welfare jobs use the pre-welfare FIFO
behavior. Runtime correctness is unchanged; only the anti-starvation
optimization is temporarily inactive. New-agent/old-gateway is not the planned
rollout direction.

Use the component-selective deployment lane when its contract and chart-
provenance guards admit the staged rollout:

```bash
npm run ship:kube -- --host <cluster-host> --namespace <namespace> \
  --components gateway --dry-run

# Continue only when the dry run says gateway is the sole app component to roll.
npm run ship:kube -- --host <cluster-host> --namespace <namespace> \
  --components gateway

npm run ship:kube -- --host <cluster-host> --namespace <namespace> \
  --components agent,garden
```

The dry run is mandatory because a chart-provenance change can automatically
add the agent to the selected components. Do not continue if that happens.
Do not bypass a guard that rejects the selective rollout. Stop and prepare an
operator-reviewed staged Helm values plan that keeps the old agent image pinned
through the gateway rollout, then moves the agents to the same exact target
image. Do not collapse the stages into an unreviewed `--components all`
deployment for this boundary.

### Migrate legacy charge and skills owners before app startup

Existing releases may still have `charge-policy.json` and `skills.json` under
the system-data PVC. The current runtime requires those files under each
companion-data PVC. This is a fail-closed owner cutover, not a seed operation:
keep `bootstrap.seedOwnerFiles=false` and use the digest-approved
`ownerMigration` hook.

The hook supports both chart topologies:

- A single-companion release lists its one existing companion-data PVC. The
  migration runs with `PSFN_MULTI_COMPANION=false` and binds the explicit
  `companionId`; a `companions.json` file is neither created nor expected. Set
  `ownerMigration.multiCompanion=false` explicitly in the migration overlay.
- A multi-companion installation lists every companion from `companions.json`,
  with a distinct existing claim and canonical mount path for each. Omitting a
  companion or reusing a claim/path fails rendering or migration. Set
  `ownerMigration.multiCompanion=true` even when that manifest currently has
  only one entry; topology is never inferred from destination count.

For either topology, stop every app process that can read an old owner before
the pre-upgrade hook runs. Dependencies such as Postgres and Redis stay up:

```bash
kubectl -n "$NAMESPACE" scale \
  deploy/${RELEASE}-gateway deploy/${RELEASE}-agent deploy/${RELEASE}-garden \
  --replicas=0
```

Take the whole-install snapshot and use the dry-run migrator's exact SHA-256
approvals. A single-companion values fragment has this shape (substitute live
claim names, paths, identity, and digests; never copy the examples):

```yaml
bootstrap:
  seedOwnerFiles: false
ownerMigration:
  required: true
  enabled: true
  multiCompanion: false
  systemDataClaim: <existing-system-data-claim>
  backupsClaim: <existing-backups-or-runtime-claim>
  backupsDir: /backups
  backupsSubPath: <optional-existing-claim-subpath>
  snapshotOutputDir: /backups/pre-owner-migration
  approvals:
    charge-policy.json: <exact-dry-run-sha256>
    skills.json: <exact-dry-run-sha256>
  companions:
    - companionId: <release-companion-id>
      claimName: <existing-companion-data-claim>
      mountPath: /runtime/companions/<release-companion-id>
      expectedIdentity: <expected-character-identity>
  verification:
    enabled: true
```

The migration image must be pinned by digest. `snapshotOutputDir` must be below
`backupsDir`, and verification cannot be disabled. For a PVC whose normal
backup mount uses a `backups` subdirectory, keep
`ownerMigration.backupsDir=/backups` and set
`ownerMigration.backupsSubPath=backups`. The hook then mounts that exact PVC
subdirectory at `/backups`; the snapshot cannot succeed on disposable container
storage outside the backup mount.

When this owner cutover and the welfare-grant boundary ship together, preserve
the gateway-first rule without letting an old agent read the new owner layout:

1. Scale the old gateway, agent, and Garden to zero as above.
2. Run the migration upgrade with the new gateway at one replica and the agent
   and Garden at zero replicas.
3. Verify the new gateway image and readiness.
4. Run the final upgrade with `ownerMigration.required=false`,
   `ownerMigration.enabled=false`, and the agent/Garden restored to their
   intended replicas on the same exact image.

Do not leave the one-time migration enabled in saved values. The receipt and
quarantined legacy sources remain as recovery evidence. The complete snapshot,
approval, receipt, retry, and restore procedure is in
[Existing split fleets with shared per-companion owners](./operations.md#existing-split-fleets-with-shared-per-companion-owners).

### Direct Garden web exposure is removed

The chart renders no direct Garden Ingress or Garden hostPort in either fleet
authentication state. This is intentional and does not affect companion
runtime behavior.

With `fleetAuth.enabled=false`, Garden remains an internal ClusterIP service.
Operator web access is a local port-forward authenticated with `ADMIN_TOKEN`:

```bash
RELEASE=psfn
NAMESPACE=psfn
kubectl -n "$NAMESPACE" port-forward "svc/${RELEASE}-garden" 10054:10054
```

Open `http://127.0.0.1:10054/` and authenticate with the release's
`ADMIN_TOKEN`. Retrieve or provision that secret through the cluster's normal
secret-management path; do not print it into logs or shell history.

With `fleetAuth.enabled=true`, do not port-forward Garden as a browser
authority. Open the configured canonical gateway HTTPS origin and use
`/companions/<companion-uuid>/garden/`. The gateway is the sole browser edge.
See [Unified fleet human origin](./operations.md#unified-fleet-human-origin).

Before declaring the upgrade complete, prove the old exposure is gone:

```bash
test -z "$(kubectl -n "$NAMESPACE" get ingress \
  -l app.kubernetes.io/component=garden -o name)"
test -z "$(kubectl -n "$NAMESPACE" get deploy "${RELEASE}-garden" \
  -o jsonpath='{range .spec.template.spec.containers[*].ports[*]}{.hostPort}{end}')"
test -z "$(kubectl -n "$NAMESPACE" get deploy "${RELEASE}-garden" \
  -o jsonpath='{.spec.template.spec.containers[*].volumeMounts[?(@.name=="adminui-build-overlay")].name}')"
```

The expected result is no Garden Ingress and no Garden `hostPort`. An
`adminui-build-overlay` mount is also stale local drift: it hides the UI bundled
in the application image and must not be carried into another cluster.

## Preflight checklist

1. Confirm the exact source commit, target architecture, namespace, Helm
   release, and current image references.
2. Take and verify the required database/PVC backup.
3. Capture live values without printing secrets:

   ```bash
   RELEASE=psfn
   NAMESPACE=psfn
   helm get values "$RELEASE" -n "$NAMESPACE" -o yaml \
     > "/tmp/${RELEASE}-values.yaml"
   chmod 600 "/tmp/${RELEASE}-values.yaml"
   ```

4. Inspect the chart delta and render with the captured values. Do not use
   `--reuse-values` across a changed chart.
5. Complete any required owner migration before starting per-release upgrades.
   The current fleet-wide and per-release procedures are in
   [Helm upgrade for per-companion owners](./operations.md#helm-upgrade-for-per-companion-scheduler-and-capability-owners).
6. Build or pull one exact, non-floating image reference. Verify its revision
   label matches the source commit.
7. Run `helm lint deploy/helm/psfn`, `npm run verify:helm-chart`, and the
   topology-specific pre-ship gate before mutating the release.

## Rollout sequence

1. Upgrade the gateway image first when crossing the welfare-grant boundary.
2. Wait for gateway readiness and verify `/v1/models`, provider routing, and
   the expected gateway image/revision.
3. Upgrade agents to the same exact target image. Upgrade Garden in this stage
   unless the release has a separate reviewed Garden stage.
4. Wait for every selected Deployment and run the repository validation gate:

   ```bash
   scripts/ops/validate-kube-rollout.sh \
     --remote --host <cluster-host> --namespace <namespace> \
     --expect-tag <exact-tag> --smoke
   ```

5. Verify Garden through the correct access path for the release's
   `fleetAuth.enabled` state. Confirm there is no direct Garden Ingress or
   hostPort.
6. Verify Postgres/pgvector, Redis, owner-file placement, migration receipts,
   and agent `ToolWiringValidator`/`Ready` logs.
7. Remove the protected temporary values file after the release is verified.

## Failure and recovery boundaries

- Do not repair owner failures by enabling seeds, copying one fleet-wide owner
  into a selected companion, adding fallback readers, or editing PVC JSON by
  hand. Follow the fail-closed migration procedure linked above.
- A gateway-first welfare skew is an expected degradation to FIFO, not a reason
  to roll agents forward before gateway validation.
- Loss of direct Garden web access is expected. Use the documented access path;
  do not restore a privileged Garden Ingress or hostPort.
- Roll back only to a revision compatible with the current owner layout and
  sole-browser-origin contract. Restore owner data only from the verified
  backup family described by the migration runbook.

## Detailed references

- [Operations guide](./operations.md)
- [Setup and configuration ownership](./setup.md)
- [Helm chart reference](../deploy/helm/psfn/README.md)
- [Multi-companion topology](./multi-companion.md)
- [Satellite Hub Kubernetes deployment](./satellite-hub-kube.md)
