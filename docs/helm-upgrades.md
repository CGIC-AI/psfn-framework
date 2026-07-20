# Helm Fleet Upgrade Guide

Read this document before changing any PSFN Helm release, including production
and local validation clusters. It is the canonical upgrade brief: it calls out
ordering constraints and operator-visible changes that are easy to miss.
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

The gateway and agent init sequence also runs the explicit scheduler owner
migration. In addition to the retired-cadence conversion, it upgrades a
canonical scheduler written before shared-world wiki care existed by adding
`backgroundMaintenance.sharedWorldWikiCaretaker.batchSize: 25`. The migrator
also adds the canonical `backgroundWork` supervisor and post-turn tuning block
when upgrading an owner written before that block existed. The migrator
validates the complete candidate before an atomic write, preserves unrelated
owner values, and refuses malformed or ambiguous existing caretaker data.
The same init boundary explicitly adds the canonical `wikiStartupHydration`
and `lifecycleKubernetes` blocks to `settings.json` when upgrading an owner
written before those required blocks existed. Present blocks are never
replaced; malformed present values fail closed.

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
      expectedIdentitySha256: <sha256-of-exact-companion.json-bytes>
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

### Upgrade a legacy slug COMPANION_ID to the UUID identity contract

Builds at or after the aylm wave require `COMPANION_ID` to be a lowercase
RFC-4122 UUID. A deployment still running a legacy slug id fails closed on all
three app processes at startup:

```text
Error: COMPANION_ID must be a lowercase RFC-4122 UUID, got "<legacy-slug>"
```

Nothing in the runtime mints the UUID — the operator generates it
(`uuidgen | tr 'A-Z' 'a-z'`) and carries it into the release values. For a
single-companion deployment the switch is data-safe because nothing durable is
keyed off the id value:

- Postgres stays on the `public` schema (`COMPANION_PG_SCHEMA` is an explicit
  opt-in, never derived from `COMPANION_ID`).
- Session journals are channel-keyed under `COMPANION_DATA_DIR` and their
  integrity HMAC does not bind the companion id.
- Redis `psfn:session-tail:<companionId>:…` keys embed the old id but are
  rebuildable caches; the journal is the source of truth.
- Keep `fleet.enabled=false`. Enabling fleet mode switches the data dir to the
  UUID-derived `<runtimeRoot>/companions/<uuid>` path and orphans the existing
  companion data.

The two gateway worker proofs ARE derived from the companion id and must be
re-derived for the new UUID against the same gateway HMAC keyring:

```bash
NEW_UUID=$(uuidgen | tr 'A-Z' 'a-z')
COMPANION_ID="$NEW_UUID" GATEWAY_SESSION_HMAC_KEY=<gateway keyring value> \
  npm run resolve:single-companion-auth
# stdout: <agentToken>\t<sessionIntegrityToken>
```

Update the app secret with the new `GATEWAY_COMPANION_AUTH_TOKEN` (agent
token) and `GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN` (session-integrity token),
then upgrade with the new id and image:

```bash
helm -n <ns> get values <release> -o yaml > live-values.yaml
helm upgrade <release> deploy/helm/psfn -n <ns> \
  -f live-values.yaml \
  --set runtime.companionId="$NEW_UUID" \
  --set psfnAppImage.tag=<new-tag> \
  --set psfnAppImage.gitCommit=<new-sha> \
  --set psfnAppImage.previousGitCommit=<previous-sha>
```

Never use `--reuse-values` across a chart version change: values blocks new to
the chart (for example `fleet.*`) are absent from the merged values and
template rendering fails with a nil-pointer error such as
`at <.Values.fleet.enabled>: nil pointer evaluating interface {}.enabled`.
Exporting the live values to a file and passing `-f` merges the new chart
defaults correctly.

Ordering with the charge/skills owner cutover above: the owner migration is
bound to owner files, not to the runtime id. If the deployment's receipt at
`SYSTEM_DATA_DIR/migrations/system-owner-fleet-reroot.json` already reports
`status: completed`, do not re-run or re-enable the hook for the id change —
a receipt written by a maintenance-pod run may record a generic maintenance
companion id in its fleet entry, and that is expected. If the owner files have
not been migrated yet, run that section first, using the new UUID as the
migration's `companionId`.

Validate with `scripts/ops/validate-kube-rollout.sh --expect-tag <new-tag>`:
the UUID fail-closed error must be gone from all three processes, and the
gateway `/v1/models` companion route must resolve. A simultaneous first
rollout can show one benign agent restart if it exhausts its gateway RPC
connect retries before the gateway is ready; it must recover on the next
start.

### Choose the Garden administration topology

`fleetAuth.enabled=false` is the normal single-admin topology. Garden requires
`ADMIN_TOKEN`, and `ingress.garden.enabled=true` exposes it through its own
Ingress. This is the chart default:

```bash
helm upgrade --install "$RELEASE" deploy/helm/psfn \
  --namespace "$NAMESPACE" \
  --set fleetAuth.enabled=false \
  --set ingress.garden.enabled=true \
  --set-string ingress.garden.host=psfn-garden.example.internal
```

Use `hostPorts.garden.enabled=true` instead when a single-node deployment needs
direct node-port access without an Ingress controller. Set
`hostPorts.garden.hostIP` and, when NetworkPolicy is enabled,
`hostPorts.garden.sourceCIDRs` to match the intended operator network. In both
cases, authenticate with `ADMIN_TOKEN`; retrieve or provision it through the
cluster's normal secret-management path, never logs or shell history.

Set both exposure flags to false when this release should be reachable only by
port-forward:

```bash
helm upgrade "$RELEASE" deploy/helm/psfn \
  --namespace "$NAMESPACE" \
  --set ingress.garden.enabled=false \
  --set hostPorts.garden.enabled=false
kubectl -n "$NAMESPACE" port-forward \
  --address 127.0.0.1 "svc/${RELEASE}-garden" 10054:10054
```

`fleetAuth.enabled=true` is the multi-admin/multi-companion topology: one login
and identity gates backend data across settings and companions instead of
maintaining separate admin keys. In that mode the chart suppresses the separate
Garden Ingress and serves authorized Gardens through the configured canonical
gateway HTTPS origin at `/companions/<companion-uuid>/garden/`. A Garden
hostPort is invalid in this topology.

Before declaring the upgrade complete, verify the rendered topology matches the
chosen values:

```bash
kubectl -n "$NAMESPACE" get ingress
kubectl -n "$NAMESPACE" get deploy "${RELEASE}-garden" \
  -o jsonpath='{range .spec.template.spec.containers[*].ports[*]}{.hostIP}:{.hostPort}{"\n"}{end}'
test -z "$(kubectl -n "$NAMESPACE" get deploy "${RELEASE}-garden" \
  -o jsonpath='{.spec.template.spec.containers[*].volumeMounts[?(@.name=="adminui-build-overlay")].name}')"
```

An `adminui-build-overlay` mount is stale local drift: it hides the UI bundled
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
   `fleetAuth.enabled`, `ingress.garden.enabled`, and
   `hostPorts.garden.enabled` state.
6. Verify Postgres/pgvector, Redis, owner-file placement, migration receipts,
   and agent `ToolWiringValidator`/`Ready` logs.
7. Remove the protected temporary values file after the release is verified.

## Failure and recovery boundaries

- Do not repair owner failures by enabling seeds, copying one fleet-wide owner
  into a selected companion, adding fallback readers, or editing PVC JSON by
  hand. Follow the fail-closed migration procedure linked above.
- A gateway-first welfare skew is an expected degradation to FIFO, not a reason
  to roll agents forward before gateway validation.
- If Garden access changes, compare the saved Helm exposure values with the
  chosen single-admin or SSO topology before changing application code.
- Roll back only to a revision compatible with the current owner layout and
  sole-browser-origin contract. Restore owner data only from the verified
  backup family described by the migration runbook.

## Detailed references

- [Operations guide](./operations.md)
- [Setup and configuration ownership](./setup.md)
- [Helm chart reference](../deploy/helm/psfn/README.md)
- [Multi-companion topology](./multi-companion.md)
- [Satellite Hub Kubernetes deployment](./satellite-hub-kube.md)
