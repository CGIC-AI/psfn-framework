# PSFN Helm chart

This is the generic public Kubernetes deployment for PSFN. Its supported
single-companion path runs PostgreSQL, gateway, isolated agent, Garden, pinned
model prefetch, an internal operator-alert sink, and cert-manager-backed mTLS.
Persistent owner files, continuity state, workspace, backups, models, and
PostgreSQL each use retained storage.

Use the repository lifecycle instead of assembling a long Helm command. It
creates the owner ConfigMap and runtime Secrets safely, bootstraps PostgreSQL
tenancy, pins/builds the application image, waits for all workloads, and creates
loopback-only Garden/API connections.

## Prerequisites

- Node.js 24.19 or newer in the Node 24 LTS line and `npm ci`
- `kubectl` and Helm
- an existing Kubernetes cluster with a default StorageClass
- Docker and k3d only when building directly into a local k3d cluster
- outbound HTTPS for the pinned image/model/cert-manager artifacts and provider

Generate owner files first:

```bash
npm run onboard
```

Choose **Kubernetes / Helm**. Export the provider credential under the exact
environment-variable name shown by onboarding and referenced by the generated
`providers.json`.

## Registry-backed cluster

Use an immutable application tag or digest:

```bash
export PSFN_KUBE_CONTEXT=my-cluster-context
export PSFN_IMAGE=registry.example/psfn:0.1.0
export PROVIDER_API_KEY='<provider credential>'

npm run helm:up
npm run helm:verify
```

`PROVIDER_API_KEY` is illustrative; use your generated provider variable name.
The lifecycle rejects floating `latest`/branch-style tags.

## Local k3d cluster

The lifecycle can build this checkout, tag it with the exact Git revision, and
import it into an existing k3d cluster:

```bash
export PSFN_KUBE_CONTEXT=k3d-psfn-local
export PSFN_K3D_CLUSTER=psfn-local
export PROVIDER_API_KEY='<provider credential>'

npm run helm:up
npm run helm:verify
```

The k3d name must correspond to `PSFN_KUBE_CONTEXT`. The lifecycle does not
create, delete, or select clusters.

## Operation

```bash
npm run helm:status       # Helm status, pods, PVCs, local connection
npm run helm:doctor       # complete readiness and authenticated Garden
npm run helm:verify       # real provider turn, persistence, restart proof
npm run helm:restart      # restart application workloads and recheck
npm run helm:update       # atomic upgrade of current checkout/image
npm run helm:logs         # follow all release containers
npm run helm:connect      # recreate loopback Garden/API forwards
npm run helm:disconnect   # stop only local forwards
npm run helm:token        # explicitly print the Garden login token
npm run helm:down         # scale to zero and retain persistent state
```

Garden defaults to `http://127.0.0.1:10053/login`; the API defaults to
`http://127.0.0.1:10054/v1`. Override the local ports with
`PSFN_GARDEN_PORT` and `PSFN_API_PORT`. Override the default `psfn`
namespace/release with `PSFN_HELM_NAMESPACE` and `PSFN_HELM_RELEASE`.

## Persistence and updates

The chart annotates application PVCs and the PostgreSQL StatefulSet claim for
retention. The lifecycle also retains generated application/database Secrets.
`helm:down` is the ordinary stop operation: it scales workloads to zero without
uninstalling the release. `helm:up` resumes it with the same owners, workspace,
memories, sessions, models, and database.

Upgrades are atomic. A failed readiness check rolls the Helm release back while
retained storage remains in place. Owner files from onboarding are copied only
when absent, so an upgrade does not overwrite changes made through Garden.

## Advanced chart use

Direct `helm install` is an advanced integration boundary. The default values
contain empty/placeholder secret inputs and expect the named owner ConfigMap;
the supported lifecycle creates those objects without leaking credential values
into Helm history. Operators who bypass it must provide an existing Secret and
owner ConfigMap, pin the application image, preserve all volume-retention rules,
and independently satisfy the tenancy and mTLS contracts.

The chart contains advanced fleet, ingress, Redis, Satellite Hub, Kubernetes
self-management, and observer-eval values for operator-owned deployments. They
are disabled by default and are not additional public installation modes.

Fleet deployments may enable `fleetAuth.localOperatorLogin` with exact
loopback origins such as `http://127.0.0.1:10053`. The Gateway then accepts the
existing `ADMIN_TOKEN` at `/fleet/login`, exchanges it for an opaque bounded
session, and continues to proxy Garden only through signed fleet capabilities.
Garden remains internal; no Garden Ingress or host port is created.

Live values files, kubeconfigs, cluster names, infrastructure addresses, and
credentials do not belong in this repository.
