# Helm Cluster Upgrade Guide

Read and follow this document before changing any PSFN Helm release, including
production and local validation clusters. This is the required, canonical
deploy-and-upgrade procedure. Do not substitute an ad hoc `helm upgrade`,
`kubectl set image`, `kubectl set env`, or a sequence of `kubectl port-forward`
processes for it. The one controlled gateway image stage documented below is
the only `kubectl set image` exception, and the final Helm upgrade must
immediately reconcile it.

Every deployment uses the same topology: one gateway, one cluster Garden, and one
agent Deployment per entry in the mandatory `companions.json`. One entry is a
cluster of one, not a second deployment mode.

## Never-again rules

- No `helm upgrade` until the rendered chart owns every live companion
  Deployment, Service, certificate, NetworkPolicy admission, PVC mount, and
  browser edge.
- No `--reuse-values` across chart versions.
- No `PSFN_LEGACY_WORKSPACE_COMPANION_ID` or
  `PSFN_LEGACY_WORKSPACE_SHA256` as a way to force startup when
  `WORKSPACE_PATH` is already the first companion's canonical Personal
  Workspace. Those variables are only for the explicit, digest-approved
  migration of a distinct, non-empty legacy workspace described in the live
  alpha migration boundary.
- No production access through self-healing `kubectl port-forward` loops. Use
  chart-owned durable ingress; if another durable exposure is required, add it
  to the chart and values before the rollout.

## Required end-to-end procedure

### 1. Set the deployment coordinates

Run the commands from a clean checkout at the exact commit being deployed.
Choose values for every placeholder before continuing:

```bash
umask 077
export RELEASE=<helm-release>
export NAMESPACE=<namespace>
export TARGET_SHA="$(git rev-parse HEAD)"
export TARGET_SHORT_SHA="$(git rev-parse --short=8 HEAD)"
export TARGET_TAG="0.1.0-kube-${TARGET_SHORT_SHA}"
export TARGET_IMAGE="localhost/psfn-framework:${TARGET_TAG}"
export VALUES_FILE="$(mktemp "/tmp/${RELEASE}-values.XXXXXX.yaml")"
chmod 600 "$VALUES_FILE"
```

For remote k3s shipping, also set the operator-selected SSH destination. Keep
private hostnames in `scripts/ops/private-ops.env` or the ignored private ops
note, not in tracked values or documentation:

```bash
export CLUSTER_HOST=<ssh-destination>
export REMOTE_DIR=<absolute-remote-staging-directory>
case "$REMOTE_DIR" in /*) ;; *) echo "REMOTE_DIR must be absolute" >&2; exit 1 ;; esac
```

Do not continue from a dirty checkout. `scripts/ops/ship-kube-update.sh` builds
its image from `git archive HEAD`, so uncommitted files are never part of the
artifact — but it does not error on a dirty tree; verify `git status` yourself.

### 2. Discover live authority before changing it

Confirm the current Kubernetes authority, release revision, workload inventory,
images, PVCs, browser edge, and chart-owned policy objects:

```bash
helm history "$RELEASE" -n "$NAMESPACE"
helm get values "$RELEASE" -n "$NAMESPACE" -o yaml > "$VALUES_FILE"
helm get manifest "$RELEASE" -n "$NAMESPACE" \
  > "/tmp/${RELEASE}-live-manifest.yaml"

kubectl -n "$NAMESPACE" get deploy,pods,svc,ingress,pvc
kubectl -n "$NAMESPACE" get networkpolicy
kubectl -n "$NAMESPACE" get certificate
kubectl -n "$NAMESPACE" get deploy \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image'
```

The app inventory must contain:

- exactly one `${RELEASE}-gateway`;
- exactly one `${RELEASE}-garden`;
- one agent Deployment for every manifest companion, labeled
  `psfn.io/fleet-target=registered` and `psfn.io/companion-id=<uuid>`, whose
  Pod template also carries `app.kubernetes.io/component=agent`;
- one per-companion admin Service and both per-companion agent certificates;
- chart-owned NetworkPolicies admitting every registered agent to gateway RPC
  and Garden to every registered agent admin Service.

Do not assume a fixed `${RELEASE}-agent` Deployment exists. Cluster agent names
include the companion UUID and are selected by labels throughout this runbook.

### 3. Reconcile Helm ownership before any upgrade

A Helm upgrade is allowed only after the captured values render the whole live
topology. Render the candidate and compare it with the live resources:

```bash
helm lint deploy/helm/psfn
npm run verify:helm-chart

helm template "$RELEASE" deploy/helm/psfn \
  --namespace "$NAMESPACE" \
  -f "$VALUES_FILE" \
  > "/tmp/${RELEASE}-candidate.yaml"

helm template "$RELEASE" deploy/helm/psfn \
  --namespace "$NAMESPACE" \
  -f "$VALUES_FILE" \
  --show-only templates/workloads.yaml \
  --show-only templates/fleet-agents.yaml \
  --show-only templates/networkpolicy.yaml \
  --show-only templates/certificates.yaml \
  --show-only templates/ingress.yaml \
  --show-only templates/pvc.yaml \
  > "/tmp/${RELEASE}-topology-candidate.yaml"

kubectl -n "$NAMESPACE" diff \
  -f "/tmp/${RELEASE}-topology-candidate.yaml"

kubectl create --dry-run=client --validate=false \
  -f "/tmp/${RELEASE}-live-manifest.yaml" -o name \
  | rg '^(deployment.apps|service|ingress.networking.k8s.io|persistentvolumeclaim|networkpolicy.networking.k8s.io|certificate.cert-manager.io)/' \
  | sort > "/tmp/${RELEASE}-helm-topology-before.txt"
kubectl create --dry-run=client --validate=false \
  -f "/tmp/${RELEASE}-candidate.yaml" -o name \
  | rg '^(deployment.apps|service|ingress.networking.k8s.io|persistentvolumeclaim|networkpolicy.networking.k8s.io|certificate.cert-manager.io)/' \
  | sort > "/tmp/${RELEASE}-helm-topology-after.txt"
kubectl -n "$NAMESPACE" get \
  deploy,svc,ingress,pvc,networkpolicy,certificate \
  -l "app.kubernetes.io/instance=${RELEASE}" -o name \
  | sort > "/tmp/${RELEASE}-live-topology.txt"

diff -u "/tmp/${RELEASE}-helm-topology-before.txt" \
  "/tmp/${RELEASE}-live-topology.txt"
diff -u "/tmp/${RELEASE}-helm-topology-before.txt" \
  "/tmp/${RELEASE}-helm-topology-after.txt"
```

`kubectl diff` exits non-zero when it finds a difference; inspect the output
rather than treating that status alone as an error. It cannot report a live
object that is absent from the candidate, which is why both identity-list
comparisons are mandatory. Investigate every difference: the first exposes
release-labeled live topology outside the current Helm manifest; the second
exposes objects the new chart would add or remove. Stop if the candidate would
delete a live companion agent, per-companion Service/certificate, follower
NetworkPolicy admission, PVC mount, Cluster Auth credential, or browser edge.
First encode the intended live topology in the values file and render again.
Never run `helm upgrade` while hand-created resources or `kubectl` patches are
the only owners of the live topology.

Verify these cluster invariants in the rendered YAML and values:

- `fleet.enabled=true`, `fleetAuth.enabled=true`,
  `networkPolicy.enabled=true`, and `bootstrap.seedOwnerFiles=false`;
- `fleet.companions` contains every entry in the system-owned
  `companions.json`, in the same order;
- `runtime.companionId` is the first entry and
  `runtime.workspacePath` is exactly
  `<fleet.runtimeRoot>/workspaces/personal/<first-companion-uuid>`;
- `runtime.companionDataDir`, `runtime.characterCardPath`, and the primary PVC
  claims also name that first companion;
- every follower has distinct companion-data, Personal Workspace, and auth
  Secret references;
- `hostPorts.gatewayApi.enabled=false`,
  `hostPorts.garden.enabled=false`, `ingress.gateway.path=/`, and
  `ingress.gateway.pathType=Prefix`;
- the Gateway Ingress is the sole browser origin and its TLS hostname equals
  `fleet-auth.json > canonicalOrigin`.

The chart validations fail closed on most of this tuple. The comparison is
still required because Helm cannot validate whether an unowned live object was
created by hand.

### 4. Prove the durable browser edge

Production and durable validation clusters use the chart-owned Gateway Ingress.
Verify its address and TLS Secret before rolling app pods:

```bash
kubectl -n "$NAMESPACE" get ingress "${RELEASE}-gateway" -o wide
export EDGE_TLS_SECRET="$(kubectl -n "$NAMESPACE" get ingress \
  "${RELEASE}-gateway" -o jsonpath='{.spec.tls[0].secretName}')"
test -n "$EDGE_TLS_SECRET"
kubectl -n "$NAMESPACE" get secret "$EDGE_TLS_SECRET"
```

If the platform has no Ingress, stop and add a reviewed, chart-owned durable
Service exposure before the upgrade. The current chart's gateway Service is
`ClusterIP`; do not hand-patch it to `NodePort` and do not treat a
`kubectl port-forward` retry loop as production ingress. The local k3d helper's
optional localhost forwards are disposable shakedown convenience only.

### 5. Back up before owner-file or database mutation

Take and verify the normal encrypted cluster backup. Run the scale and
maintenance-Pod block only when the target diff and owner dry runs show a
mutation is required. If no owner changes are needed, leave the old agents and
Garden running during the later gateway stage.

When owner changes are required, keep all app workloads stopped while applying
them. Postgres, Redis, and cert-manager may remain up:

```bash
kubectl -n "$NAMESPACE" scale \
  "deployment/${RELEASE}-gateway" "deployment/${RELEASE}-garden" \
  --replicas=0
kubectl -n "$NAMESPACE" scale deployment \
  --selector "app.kubernetes.io/instance=${RELEASE},psfn.io/fleet-target=registered" \
  --replicas=0
```

Create one maintenance Pod from the cluster-of-one agent Deployment. This
mechanically preserves its exact env, Secret references, PVC claims, canonical
Personal Workspace mount, and uid/gid 999 security context while replacing the
container with the target image. The changed `system-data` mount is the only
volume permission difference. The custom labels deliberately do not match the
agent Service or NetworkPolicy selectors:

```bash
export AGENT_DEPLOYMENTS="$(kubectl -n "$NAMESPACE" get deployment \
  --selector "app.kubernetes.io/instance=${RELEASE},psfn.io/fleet-target=registered" \
  -o name)"
test "$(printf '%s\n' "$AGENT_DEPLOYMENTS" | sed '/^$/d' | wc -l)" -eq 1
export AGENT_DEPLOY="$AGENT_DEPLOYMENTS"
export MAINTENANCE_POD="${RELEASE}-owner-maintenance"

test -z "$(kubectl -n "$NAMESPACE" get pod "$MAINTENANCE_POD" \
  --ignore-not-found -o name)"
kubectl -n "$NAMESPACE" get "$AGENT_DEPLOY" -o json \
  | jq --arg name "$MAINTENANCE_POD" --arg image "$TARGET_IMAGE" \
      --arg release "$RELEASE" '
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: $name,
          labels: {
            "app.kubernetes.io/instance": $release,
            "app.kubernetes.io/component": "owner-maintenance"
          }
        },
        spec: .spec.template.spec
      }
      | .spec.restartPolicy = "Never"
      | del(.spec.initContainers)
      | .spec.containers = [
          (.spec.containers[] | select(.name == "agent")
            | .name = "owner-maintenance"
            | .image = $image
            | .imagePullPolicy = "IfNotPresent"
            | .command = ["sh", "-c"]
            | .args = ["mkdir -p \"$PSFN_TEMP_DIR\" \"$PSFN_LOGS_DIR\" \"$BACKUP_ROOT_DIR\"; sleep infinity"]
            | del(.ports, .readinessProbe, .livenessProbe, .startupProbe,
                  .resources, .lifecycle)
            | .volumeMounts |= map(
                if .name == "system-data" then del(.readOnly) else . end
              )
          )
        ]
    ' \
  | kubectl -n "$NAMESPACE" apply -f -
kubectl -n "$NAMESPACE" wait \
  --for=condition=Ready "pod/${MAINTENANCE_POD}" --timeout=180s
```

Review the generated Pod before using it. It must show the target tag with
`IfNotPresent`, run as uid/gid 999, mount `system-data` read/write, and mount the
sole companion root and canonical Personal Workspace from their live PVCs:

```bash
kubectl -n "$NAMESPACE" get pod "$MAINTENANCE_POD" -o yaml
kubectl -n "$NAMESPACE" exec "$MAINTENANCE_POD" -- \
  sh -c 'id && printf "%s\n%s\n%s\n" \
    "$SYSTEM_DATA_DIR" "$COMPANION_DATA_DIR" "$WORKSPACE_PATH" \
    && stat -c "%u:%g %a %n" \
      "$SYSTEM_DATA_DIR" "$COMPANION_DATA_DIR" "$WORKSPACE_PATH"'
```

Preserve each existing owner that may change. The create-only checks avoid
inventing a missing owner during backup:

```bash
export OWNER_BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
kubectl -n "$NAMESPACE" exec "$MAINTENANCE_POD" -- \
  sh -c '
    set -eu
    stamp=$1
    for owner in \
      "$SYSTEM_DATA_DIR/intake-policy.json" \
      "$SYSTEM_DATA_DIR/settings.json" \
      "$COMPANION_DATA_DIR/scheduler.json" \
      "$COMPANION_DATA_DIR/charge-policy.json"; do
      if [ -e "$owner" ]; then cp -p "$owner" "$owner.bak-$stamp"; fi
    done
  ' sh "$OWNER_BACKUP_STAMP"
```

Do not create a missing PVC root or guess it from a display name. This generated
Pod is intentionally cluster-of-one. If the selector finds anything other than
one agent, stop and use the digest-approved whole-cluster owner migration rather
than broadening this Pod by hand.

### 6. Upgrade owner-file contracts

The target checkout is the authority for which migrations are required. Review
the config-contract delta before applying anything:

```bash
git diff <currently-deployed-commit> "$TARGET_SHA" -- \
  src/system/config src/system/settings config package.json
```

Use the repo-owned migration that matches the owner:

| Owner change | Required action |
| --- | --- |
| Shared `charge-policy.json` or `skills.json` still under system-data | Run the snapshot, dry-run, digest approval, and apply flow in [Existing split clusters with shared per-companion owners](./operations.md#existing-split-clusters-with-shared-per-companion-owners) once for the entire cluster. |
| Legacy or older `scheduler.json` shape | In the maintenance Pod, run `node /app/dist/migrate-scheduler-owner.js --data-dir "$COMPANION_DATA_DIR" --dry-run`, inspect `addedPaths`/`removedPaths`, then repeat with `--apply`. |
| `intake-policy.json` schema v1 | In the maintenance Pod, run `node /app/dist/migrate-intake-policy-owner.js --data-dir "$SYSTEM_DATA_DIR" --dry-run`, confirm only `sinkGates.sinks.skill_write` and `schemaVersion` change, then repeat with `--apply`. |
| Older `settings.json` missing required runtime blocks | In the maintenance Pod, run `node /app/dist/migrate-required-settings-blocks.js --dry-run --data-dir "$SYSTEM_DATA_DIR"`, inspect the plan, then repeat with `--apply`. Do not defer this apply to the final Helm init: the controlled gateway stage changes only the main container image. |
| A brand-new required owner such as `partner-affect-shadow.json` | Create it only when absent from the matching target-image seed. For Partner Affect, copy `config/partner-affect-shadow.seed.json` to the system owner root; it ships with `enabled: false`. Never replace an existing owner with the seed. |
| A required nested block has no migration CLI | Add only missing keys from the target seed, preserving every live-tuned value. If a present value is malformed or conflicts with the target shape, stop for operator review; do not overwrite the conflicting subtree. |

For shakedown-era owners on this branch, inspect these exact paths:

- `charge-policy.json` requires
  `fatigue.socialRegulation.roomEpisodePressure`,
  `fatigue.socialRegulation.roomEpisodeCircuitBreaker`, and
  `fatigue.socialPot`. There is no repo-owned charge-shape CLI for these
  additions. Copy only absent fields from `config/charge-policy.seed.json` into
  every companion owner, after the per-file backup. Never replace the whole
  `fatigue` or `socialRegulation` object.
- The scheduler migrator adds the required
  `backgroundMaintenance.sharedWorldWikiCaretaker` and `backgroundWork` blocks.
  On this branch, an absent `socialAutonomy` block is validated through
  `DEFAULT_SOCIAL_AUTONOMY_CONFIG`; it is not a fail-closed startup omission.
  Add it from `config/scheduler.seed.json` only when the operator wants the
  defaults made explicit. Do not describe it as a required migration.
- `partner-affect-shadow.json` is cluster-global under `SYSTEM_DATA_DIR`, not a
  per-companion owner. Its seed is safe only for a truly absent file because it
  starts disabled and unbound.

The migration CLIs are dry-run by default, validate the complete candidate, pin
the source identity, and publish with a durable atomic rename. They do not
create the pre-migration backup above. They create the replacement with mode
`0600`, so the PVC maintenance step must explicitly restore the deployment's
owner-file contract after all applies and manual repairs. Open a shell in the
target-image maintenance Pod, run the selected dry-run/apply commands above,
then normalize every file they created or replaced:

```bash
kubectl -n "$NAMESPACE" exec -it "$MAINTENANCE_POD" -- sh

chmod 0664 <every-owner-file-created-or-replaced>
stat -c '%u:%g %a %n' <every-owner-file-created-or-replaced>
```

The maintenance Pod runs as uid/gid 999, so its atomic replacements retain
that owner; the expected final output is `999:999 664`. If an existing file is
not already owned by 999, stop and use the platform-approved PVC ownership
repair before continuing—the non-root Pod must not be made privileged merely
to hide drift. A root-owned file can make the runtime fail with `EACCES`. Do
not use `bootstrap.seedOwnerFiles=true` to repair an upgrade, do not merge a
whole seed over an existing owner, and do not add a fallback reader.

For a missing new owner, use a create-only check in the target-image
maintenance environment:

```bash
test ! -e "$SYSTEM_DATA_DIR/partner-affect-shadow.json"
install -m 0664 \
  /app/config/partner-affect-shadow.seed.json \
  "$SYSTEM_DATA_DIR/partner-affect-shadow.json"
```

Finish with the runtime preflight against the mounted production roots:

```bash
node /app/dist/preflight-startup-owner-files.js
```

Run that command inside the maintenance Pod after all applies. It uses the
live agent's inherited env, Secrets, system owner root, companion owner root,
and canonical Personal Workspace, but executes the target image's compiled
preflight. This is different from `npm run verify:startup-owner-files`, which
validates repository seeds in an isolated fixture.

Leave the app Deployments at zero after a mutating owner-file maintenance
window. The target gateway must prove the new owner contract before any agent
or Garden restarts; step 8 provides the controlled zero-replica gateway path.

### 7. Build and import one exact image

#### Local k3d

The local helper can recreate a disposable cluster-of-one deployment:

```bash
scripts/ops/setup-local-artemis-shakedown.sh \
  --cluster <k3d-cluster> \
  --namespace "$NAMESPACE" \
  --release "$RELEASE" \
  --reset-cluster \
  --no-port-forward
```

For an upgrade that must preserve existing PVCs, build and import the target
without resetting data:

```bash
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=${TARGET_SHA}" \
  -f docker/Dockerfile.agent \
  -t "localhost/psfn-framework:${TARGET_TAG}" .

docker run --rm --entrypoint sh \
  "localhost/psfn-framework:${TARGET_TAG}" \
  -c 'test -f /app/contract-hash.txt \
    && test -f /app/skills/conversation/SKILL.md \
    && test -f /app/deploy/helm/psfn/Chart.yaml \
    && test -f /app/deploy/helm/psfn/recovery-chart.sha256'

k3d image import "localhost/psfn-framework:${TARGET_TAG}" \
  -c <k3d-cluster>
```

The bundled-skill assertion is explicit because this branch's
`ship-kube-update.sh` does not yet contain that check.

#### Remote k3s

Use the repository ship path for its build and dry-run evidence. It probes the
remote architecture, builds from committed `HEAD`, checks the embedded
contract/recovery assets, and stops before import or Helm mutation:

```bash
PSFN_REMOTE_DIR="$REMOTE_DIR" npm run ship:kube -- \
  --host "$CLUSTER_HOST" \
  --namespace "$NAMESPACE" \
  --components all \
  --dry-run
```

Until the bundled-skill assertion is incorporated into that script, run it
against the built image before shipping:

```bash
docker run --rm --entrypoint test \
  "psfn-framework:${TARGET_TAG}" \
  -f /app/skills/conversation/SKILL.md
```

Do not run the ship script without `--dry-run` on this branch. Its selective
probes and rollout waits still address a fixed `deploy/psfn-agent`, while the
chart renders a UUID-suffixed agent Deployment. A full invocation can
mutate Helm successfully and then fail on that nonexistent rollout target.
Use the same tag-oriented import sequence manually, then use the label-aware
gateway/final Helm procedure below:

```bash
docker save "psfn-framework:${TARGET_TAG}" \
  | gzip > "/tmp/psfn-${TARGET_SHORT_SHA}.tar.gz"
scp "/tmp/psfn-${TARGET_SHORT_SHA}.tar.gz" \
  "${CLUSTER_HOST}:${REMOTE_DIR}/"
ssh "$CLUSTER_HOST" \
  "cd '${REMOTE_DIR}' \
   && gunzip -f psfn-${TARGET_SHORT_SHA}.tar.gz \
   && sudo k3s ctr images import psfn-${TARGET_SHORT_SHA}.tar \
   && sudo k3s ctr images tag \
      docker.io/library/psfn-framework:${TARGET_TAG} \
      localhost/psfn-framework:${TARGET_TAG} \
   && rm -f psfn-${TARGET_SHORT_SHA}.tar"
```

Tar-imported images are tag-addressed. Never set a digest for one: the imported
containerd record is not the registry digest contract expressed by Helm.
Clear any inherited `psfnAppImage.digest` and per-workload digest overrides in
the staged and final upgrades.

### 8. Roll gateway first when the contract changes

Render the exact final target before touching the live gateway:

```bash
helm template "$RELEASE" deploy/helm/psfn \
  --namespace "$NAMESPACE" \
  -f "$VALUES_FILE" \
  --set-string 'psfnAppImage.repository=localhost/psfn-framework' \
  --set-string "psfnAppImage.tag=${TARGET_TAG}" \
  --set-string "psfnAppImage.gitCommit=${TARGET_SHA}" \
  --set-string 'psfnAppImage.digest=' \
  --set-string 'psfnAppImage.pullPolicy=IfNotPresent' \
  --set-string 'workloads.gateway.image.repository=' \
  --set-string 'workloads.gateway.image.tag=' \
  --set-string 'workloads.gateway.image.digest=' \
  --set-string 'workloads.gateway.image.pullPolicy=' \
  --set-string 'workloads.agent.image.repository=' \
  --set-string 'workloads.agent.image.tag=' \
  --set-string 'workloads.agent.image.digest=' \
  --set-string 'workloads.agent.image.pullPolicy=' \
  --set-string 'workloads.garden.image.repository=' \
  --set-string 'workloads.garden.image.tag=' \
  --set-string 'workloads.garden.image.digest=' \
  --set-string 'workloads.garden.image.pullPolicy=' \
  > "/tmp/${RELEASE}-final-target.yaml"
```

Confirm the render still owns the complete topology. If the target chart
changes the agent or Garden pod contract before they can talk to the old
gateway, or the new gateway image requires pod wiring that is absent from the
live gateway Deployment, stop and split out a backward-safe chart/wiring
release first. An image-only gateway skew cannot make an incompatible
multi-workload chart transition safe.

If the chart also needs an owner-migration Job, use the maintenance sequence in
[Migrate legacy charge and skills owners before app startup](#migrate-legacy-charge-and-skills-owners-before-app-startup).
Whether the old agents remained running or owner maintenance left every app
Deployment at zero, use the same narrow, reviewable gateway exception:

```bash
test "$(kubectl -n "$NAMESPACE" get deployment "${RELEASE}-gateway" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="gateway")].imagePullPolicy}')" \
  = IfNotPresent
kubectl -n "$NAMESPACE" set image \
  "deployment/${RELEASE}-gateway" \
  "gateway=${TARGET_IMAGE}"
kubectl -n "$NAMESPACE" scale \
  "deployment/${RELEASE}-gateway" --replicas=1
kubectl -n "$NAMESPACE" rollout status \
  "deployment/${RELEASE}-gateway" --timeout=300s
```

This is temporary image drift, not topology drift. Do not change env, mounts,
Services, certificates, or policies with `kubectl`; the final Helm command
below must persist the same target image and remove the drift before the
maintenance window ends. This also avoids clearing a live global registry
digest in an intermediate Helm revision, which could otherwise change the old
agent and Garden image references. The tar-imported target remains tag-only.
If the pull-policy assertion fails, stop and ship a backward-safe chart release
that changes the live app pull policies while their current registry images
remain resolvable; do not patch the policy ad hoc.

Verify the gateway is Ready, is running `TARGET_TAG`, and has no startup owner,
Cluster Auth, TLS, or RPC errors before starting agents:

```bash
kubectl -n "$NAMESPACE" get deploy "${RELEASE}-gateway" \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl -n "$NAMESPACE" logs "deployment/${RELEASE}-gateway" \
  --since=15m
```

Then move every component to the shared target and clear all temporary
per-component image overrides:

```bash
helm upgrade "$RELEASE" deploy/helm/psfn \
  --namespace "$NAMESPACE" \
  -f "$VALUES_FILE" \
  --set-string 'psfnAppImage.repository=localhost/psfn-framework' \
  --set-string "psfnAppImage.tag=${TARGET_TAG}" \
  --set-string "psfnAppImage.gitCommit=${TARGET_SHA}" \
  --set-string 'psfnAppImage.digest=' \
  --set-string 'psfnAppImage.pullPolicy=IfNotPresent' \
  --set-string 'workloads.gateway.image.repository=' \
  --set-string 'workloads.gateway.image.tag=' \
  --set-string 'workloads.gateway.image.digest=' \
  --set-string 'workloads.gateway.image.pullPolicy=' \
  --set-string 'workloads.agent.image.repository=' \
  --set-string 'workloads.agent.image.tag=' \
  --set-string 'workloads.agent.image.digest=' \
  --set-string 'workloads.agent.image.pullPolicy=' \
  --set-string 'workloads.garden.image.repository=' \
  --set-string 'workloads.garden.image.tag=' \
  --set-string 'workloads.garden.image.digest=' \
  --set-string 'workloads.garden.image.pullPolicy=' \
  --timeout 10m

kubectl -n "$NAMESPACE" scale deployment \
  --selector "app.kubernetes.io/instance=${RELEASE},psfn.io/fleet-target=registered" \
  --replicas=1
kubectl -n "$NAMESPACE" scale \
  "deployment/${RELEASE}-garden" --replicas=1
```

Never use `--reuse-values` across chart versions. Supplying the captured file
with `-f` merges it with new chart defaults; `--reuse-values` can omit new
required blocks and fail template evaluation.

### 9. Post-upgrade validation gate

An upgrade is not complete until every check below is green, in order.

1. **All app pods are Ready with stable restarts.**

   ```bash
   kubectl -n "$NAMESPACE" rollout status \
     "deployment/${RELEASE}-gateway" --timeout=300s
   kubectl -n "$NAMESPACE" rollout status deployment \
     --selector "app.kubernetes.io/instance=${RELEASE},psfn.io/fleet-target=registered" \
     --timeout=300s
   kubectl -n "$NAMESPACE" rollout status \
     "deployment/${RELEASE}-garden" --timeout=300s

   kubectl -n "$NAMESPACE" get pods \
     -l "app.kubernetes.io/instance=${RELEASE}"
   kubectl -n "$NAMESPACE" get pods \
     -l "app.kubernetes.io/instance=${RELEASE}" \
     -o custom-columns='POD:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,IMAGE:.spec.containers[*].image'
   ```

   Every gateway, Garden, and registered agent container must report `true`
   (the `1/1` state in normal `kubectl get pods` output). Capture the restart
   counts, wait through at least one readiness/liveness interval, and confirm
   they do not increase.

2. **Every companion has both authenticated gateway roles.**

   ```bash
   kubectl -n "$NAMESPACE" logs \
     "deployment/${RELEASE}-gateway" --since=15m \
     | rg 'Companion connection authenticated'
   ```

   The structured log entries must cover every `companions.json` UUID for both
   `agent` and `internal_session_integrity`. Missing entries are a failed
   rollout, commonly caused by follower NetworkPolicy, certificate, or role
   proof wiring.

3. **Recent logs contain no unresolved startup failure.**

   ```bash
   kubectl -n "$NAMESPACE" logs \
     "deployment/${RELEASE}-gateway" --since=15m
   kubectl -n "$NAMESPACE" logs \
     --selector 'app.kubernetes.io/component=agent,psfn.io/fleet-target=registered' \
     --all-containers=true --prefix --since=15m
   kubectl -n "$NAMESPACE" logs \
     "deployment/${RELEASE}-garden" --since=15m
   ```

   Require gateway `Ready`, agent `Ready — waiting for messages`, and successful
   `ToolWiringValidator` output. Investigate every `ERROR`, owner validation
   failure, `EACCES`, certificate error, RPC retry exhaustion, or repeated
   database refusal.

4. **Chart-owned cluster network and certificate objects are complete.**

   ```bash
   kubectl -n "$NAMESPACE" get networkpolicy
   kubectl -n "$NAMESPACE" get svc,certificate \
     -l "app.kubernetes.io/instance=${RELEASE}" \
     -L psfn.io/companion-id
   kubectl -n "$NAMESPACE" get certificate \
     -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,SECRET:.spec.secretName'
   ```

   Every companion needs one admin Service, one RPC client certificate, and one
   admin certificate. The shared gateway policy must admit registered agents
   on gateway RPC (`ports.gatewayRpc`, default `10054`), and the agent policy
   must allow their RPC egress.

5. **The rostered owner can complete SSO at the durable canonical origin.**

   In a browser, open `<fleet-auth canonicalOrigin>/fleet`. Complete the provider
   login as a subject explicitly rostered with role `owner` for the companion
   being checked. The result must return to `/fleet`, show only the authorized
   roster, and remain on the exact canonical HTTPS origin. A login that works
   only through a port-forward or a direct Garden address does not pass.

6. **Every companion Garden loads through the portal.**

   Open every roster entry and verify
   `/companions/<companion-uuid>/garden/` loads without a 401, 403, 502, TLS
   error, or cross-companion data. Check the Garden health/dashboard view for
   memory, LLM/provider, Discord (when enabled), embeddings, scheduler,
   database continuity, and gateway-link health. A direct request to Garden
   port `10054` is not a browser validation path; cluster Garden transport is
   mTLS-only behind the gateway.

7. **Persistence and owner state are valid.**

   Confirm Postgres/pgvector and Redis pods are Ready, every expected schema
   exists, owner migration receipts are complete, and owner modes remain
   `999:999 664`. Run `node /app/dist/preflight-startup-owner-files.js` in the mounted
   maintenance Pod one final time (the npm-script form needs dev tooling the
   production image does not carry; see step 6).

The checked-in `scripts/ops/validate-kube-rollout.sh` still probes a fixed
`psfn-agent` Deployment and is therefore supplemental on this branch, not a
replacement for the label-selected agent gate above.

### 10. Close out or recover

When the gate is green:

```bash
helm history "$RELEASE" -n "$NAMESPACE"
kubectl -n "$NAMESPACE" delete pod \
  "${MAINTENANCE_POD:-${RELEASE}-owner-maintenance}" --ignore-not-found
rm -f "$VALUES_FILE" \
  "/tmp/psfn-${TARGET_SHORT_SHA}.tar.gz" \
  "/tmp/${RELEASE}-live-manifest.yaml" \
  "/tmp/${RELEASE}-candidate.yaml" \
  "/tmp/${RELEASE}-topology-candidate.yaml" \
  "/tmp/${RELEASE}-helm-topology-before.txt" \
  "/tmp/${RELEASE}-helm-topology-after.txt" \
  "/tmp/${RELEASE}-live-topology.txt" \
  "/tmp/${RELEASE}-final-target.yaml"
```

If validation fails, stop. Preserve logs, rendered manifests, Helm revision,
image references, and migration receipts. Roll back only when the prior image
understands the current owner-file layout and Cluster Auth topology. Otherwise
fix forward or restore the verified whole-cluster backup; never selectively copy
quarantined owners back into one companion.

## Special migrations and release boundaries

### Gateway-first compatibility boundary

For releases that include the welfare-grant verification boundary introduced
by `b87ba13cbc`, deploy the new gateway before any new agent.

During the old-agent/new-gateway skew window, an agent cannot present the new
gateway-verifiable welfare grant. The gateway strips
`preemptionProtected`, so affected welfare jobs use the pre-welfare FIFO
behavior. Runtime correctness is unchanged; only the anti-starvation
optimization is temporarily inactive. New-agent/old-gateway is not the planned
rollout direction.

Use the controlled gateway image stage and final Helm reconciliation in step 8.
Do not use the ship script's component-selective lane on this branch: its fixed
agent Deployment target predates the UUID-suffixed cluster agent. The gateway
must prove readiness before the final Helm revision moves the agent and Garden
to the same exact target.

### Migrate legacy charge and skills owners before app startup

Existing releases may still have `charge-policy.json` and `skills.json` under
the system-data PVC. The current runtime requires those files under each
companion-data PVC. This is a fail-closed owner cutover, not a seed operation:
keep `bootstrap.seedOwnerFiles=false`. Use the maintenance CLI path documented
below for a tar-imported shakedown image. The optional `ownerMigration` hook is
only for an image available from a registry by immutable digest; never put a
made-up digest on an image that exists only because it was imported into
containerd.

The hook has one cluster shape. List every companion from `companions.json` with
its distinct existing claim and canonical mount path. A cluster of one therefore
lists one entry; a larger cluster lists all entries. Omitting a companion or
reusing a claim/path fails rendering or migration.

Before the hook, stop every app process that can read an old owner. Dependencies
such as Postgres and Redis stay up:

```bash
kubectl -n "$NAMESPACE" scale \
  "deployment/${RELEASE}-gateway" "deployment/${RELEASE}-garden" \
  --replicas=0
kubectl -n "$NAMESPACE" scale deployment \
  --selector "app.kubernetes.io/instance=${RELEASE},psfn.io/fleet-target=registered" \
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
approvals. A cluster-of-one values fragment has this shape (substitute live
claim names, paths, identity, and digests; never copy the examples):

```yaml
bootstrap:
  seedOwnerFiles: false
ownerMigration:
  required: true
  enabled: true
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

When the hook is used, its migration image must be available from a registry
and pinned by digest. `snapshotOutputDir` must be below `backupsDir`, and
verification cannot be disabled. For a PVC whose normal backup mount uses a
`backups` subdirectory, keep
`ownerMigration.backupsDir=/backups` and set
`ownerMigration.backupsSubPath=backups`. The hook then mounts that exact PVC
subdirectory at `/backups`; the snapshot cannot succeed on disposable container
storage outside the backup mount.

When this owner cutover and the welfare-grant boundary ship together, preserve
the gateway-first rule without letting an old agent read the new owner layout.
The chart deliberately requires one gateway, one agent, and one Garden
replica in rendered values, so a Helm revision with agent/Garden replicas set
to zero is invalid. Do not attempt that impossible intermediate revision.

1. Scale the old gateway, agent, and Garden to zero as above.
2. From the PVC-mounted maintenance environment, take the whole-install
   snapshot, dry-run and approve the exact source digests, apply the migration,
   and run the packaged per-companion readiness probes. Keep the Helm hook
   disabled for this path.
3. Use the controlled `kubectl set image` gateway stage in step 8, scale only
   the gateway to one, and verify its exact image and readiness.
4. Run the final Helm upgrade with every app component on the same exact target
   image and with `ownerMigration.required=false` and
   `ownerMigration.enabled=false`.

If policy requires the Helm hook rather than a maintenance environment, split
the owner cutover into an earlier release that does not cross a gateway-first
contract boundary. A successful hook is followed by Helm applying the main
cluster resources at their required replicas; it cannot preserve a gateway-only
skew window.

Do not leave the one-time migration enabled in saved values. The receipt and
quarantined legacy sources remain as recovery evidence. The complete snapshot,
approval, receipt, retry, and restore procedure is in
[Existing split clusters with shared per-companion owners](./operations.md#existing-split-clusters-with-shared-per-companion-owners).

### Formalize an existing primary as a cluster tenant

An install created before cluster values existed becomes a one-entry cluster; it
does not retain a second chart mode. Before upgrading, choose a lowercase
RFC-4122 companion ID and map the existing primary into all three authorities:

1. Add one `fleet.companions` entry. Point `companionDataClaim` and
   `workspaceClaim` at the existing primary PVCs, choose its Postgres schema,
   and bind both role-proof keys through `authSecret`.
2. Put the matching one-entry `companions.json` in the system-data PVC. Its
   companion-data/card paths and Postgres schema must match the Helm entry.
3. Put the matching roster and credential references in `fleet-auth.json`, and
   supply every referenced `FLEET_AUTH_*` credential through
   `fleetAuth.credentialEnv`.
4. Set the primary `runtime.*` paths to
   `<fleet.runtimeRoot>/companions/<companion-id>` and
   `<fleet.runtimeRoot>/workspaces/personal/<companion-id>`. Mount the existing
   PVCs there; never copy them into new empty claims merely to match the path.

The chart does not infer or overwrite either owner file. Missing, mismatched,
or invalid roster data blocks startup. After provisioning, verify the one-entry
manifest before the rollout:

```bash
kubectl -n "$NAMESPACE" exec deploy/"${RELEASE}-gateway" -- sh -c '
  test -f /runtime/system-data/companions.json
  node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(\"/runtime/system-data/companions.json\")).companions.length === 1 ? 0 : 1)"
'
```


### Upgrade a legacy slug COMPANION_ID to the UUID identity contract

Builds at or after the aylm wave require `COMPANION_ID` to be a lowercase
RFC-4122 UUID. A deployment still running a legacy slug id fails closed on all
three app processes at startup:

```text
Error: COMPANION_ID must be a lowercase RFC-4122 UUID, got "<legacy-slug>"
```

Nothing in the runtime mints the UUID — the operator generates it
(`uuidgen | tr 'A-Z' 'a-z'`) and carries it into the release values. For a
cluster-of-one deployment, preserve the existing durable roots while changing
the identity:

- Postgres stays on the `public` schema (`COMPANION_PG_SCHEMA` is an explicit
  opt-in, never derived from `COMPANION_ID`).
- Session journals are channel-keyed under `COMPANION_DATA_DIR` and their
  integrity HMAC does not bind the companion id.
- Redis `psfn:session-tail:<companionId>:…` keys embed the old id but are
  rebuildable caches; the journal is the source of truth.
- Update the one `fleet.companions` entry and its canonical UUID-derived paths together;
  never point the release at an empty replacement claim.

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
companion id in its cluster entry, and that is expected. If the owner files have
not been migrated yet, run that section first, using the new UUID as the
migration's `companionId`.

Use the label-selected validation gate above: the UUID fail-closed error must be
gone from all three process types, every companion must authenticate, and the
gateway model/provider route must resolve. A simultaneous first rollout can
show one agent restart if it exhausts its gateway RPC connect retries before
the gateway is ready; it must recover on the next start and the restart count
must then remain stable.

### Verify the cluster Garden origin

There is one Garden administration topology. Cluster Auth gates the roster and
each companion Garden through the canonical gateway HTTPS origin at
`/companions/<companion-uuid>/garden/`, including when the roster has one
entry. A separate Garden Ingress, Garden hostPort, and `ADMIN_TOKEN` browser
path are not upgrade choices.

Before declaring the upgrade complete, verify the rendered topology:

```bash
kubectl -n "$NAMESPACE" get ingress
kubectl -n "$NAMESPACE" get deploy "${RELEASE}-garden" \
  -o jsonpath='{range .spec.template.spec.containers[*].ports[*]}{.hostIP}:{.hostPort}{"\n"}{end}'
test -z "$(kubectl -n "$NAMESPACE" get deploy "${RELEASE}-garden" \
  -o jsonpath='{.spec.template.spec.containers[*].volumeMounts[?(@.name=="adminui-build-overlay")].name}')"
```

An `adminui-build-overlay` mount is stale local drift: it hides the UI bundled
in the application image and must not be carried into another cluster.

## Failure and recovery boundaries

- Do not repair owner failures by enabling seeds, copying one cluster-wide owner
  into a selected companion, adding fallback readers, or editing PVC JSON by
  hand. Follow the fail-closed migration procedure linked above.
- A gateway-first welfare skew is an expected degradation to FIFO, not a reason
  to roll agents forward before gateway validation.
- If Garden access changes, compare the saved Helm exposure values with the
  canonical Cluster Auth/sole-gateway topology before changing application code.
- Roll back only to a revision compatible with the current owner layout and
  sole-browser-origin contract. Restore owner data only from the verified
  backup family described by the migration runbook.

## Detailed references

- [Operations guide](./operations.md)
- [Setup and configuration ownership](./setup.md)
- [Helm chart reference](../deploy/helm/psfn/README.md)
- [Multi-companion topology](./multi-companion.md)
- [Satellite Hub Kubernetes deployment](./satellite-hub-kube.md)
