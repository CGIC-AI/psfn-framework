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

### Satellite Hub Eidoverse visitor path

`satelliteHub.eidoverse` renders the `EIDOVERSE_MCP_*` environment that the Hub
reads (`apps/satellite-hub/src/ts/hub/eidoverse-mcp.ts`). It is disabled by
default, and the disabled render contains no Eidoverse key at all.

Enabling it requires `satelliteHub.enabled=true`, a `worldName`, an `agentName`,
and the keys its `transport` needs; partial configuration fails rendering rather
than shipping a pod that cannot start. The identity token is never a chart value
on the container: `tokenRef` names the environment entry the Hub dereferences,
and that entry is populated from the application Secret key
`secrets.keys.eidoverseJoinToken` (the two must match), mirroring the Home
Assistant control-token pattern.

`transport` selects how the Hub reaches the world, and each transport renders
only its own keys:

- `poll` (default, Phase 1) needs a `command` that resolves inside the Hub image
  and a credential-free `ws://`/`wss://` `worldUrl`. The Hub spawns that stdio
  MCP server and polls `pending_pings` on `pendingPingsPollIntervalMs`.
- `mcpl` (Phase 2) needs `mcpl.doorUrl`, a credential-free `ws://`/`wss://` URL
  including the door's path and carrying no query string of its own — the
  identity token is attached at dial time. Knocks then arrive as pushed
  `channels/incoming` traffic and no poll timer exists. `mcpl.featureSets` is
  the grant the Hub issues; advertisement is not authorization, so nothing the
  door declares about itself widens it. `mcpl.catchupWake` decides whether
  mentions the door replays after a reconnect may start turns, and defaults to
  `false`. `mcpl.wakeQueueLimit` bounds the wake-dispatch queue the pushed
  traffic feeds: turns are serialized and the push transport has none of the
  poll timer's natural backpressure, so past that many waiting batches an
  arriving batch is dropped and counted, with a log line carrying counts only.

Two operational consequences:

- **The stdio MCP server binary is not bundled.** Under `transport: poll`,
  `command` must already exist in the Hub image or the pod cannot connect.
- **Connectivity becomes a startup requirement.** The Hub rethrows
  `EidoverseMcpUnavailableError`, so the pod crash-loops until the configured
  door (or command and world) is reachable. With `networkPolicy.enabled=true`, a
  LAN or non-443 world also needs
  `satelliteHub.eidoverse.egressCIDRs`/`egressPort`;
  `networkPolicy.satelliteHub.allowExternalEgress` only opens public 443.

`satelliteHub.eidoverse.body` bounds the Hub-owned locomotion runner
(`EIDOVERSE_BODY_*`). It always renders with the visitor path because the
allowlist itself is the gate: `walk_to`/`face`/`stop` only, refused entirely
unless the Hub's claim profile grants `avatar_action`. Keep `walkTimeoutMs`
above the door's own ~90s walk budget.

`satelliteHub.eidoverse.snapshot` renders the optional first-person vision
environment (`EIDOVERSE_SNAPSHOT_*`) and is disabled by default; the disabled
render contains no snapshot key. It needs a live spectator renderer attached to
the world, which is a separate moving part from the world sequencer, so an
enabled snapshot path still degrades to text `look()` notes rather than failing a
turn. Leave `baseUrl` empty to let the Hub derive the origin from `worldUrl`;
set it only for a separate credential-free `http://`/`https://` origin.

`satelliteHub.eidoverse.placeMap` renders the optional Hub-owned world/region to
`places.json` mapping into a ConfigMap mounted read-only at `mountPath`
(`EIDOVERSE_PLACE_MAP_PATH`). The mapping is read-only and never creates or
changes entries in `places.json`.

`npm run verify:chart-render` renders both states with `helm template` and asserts
the exact environment, the secret-backed token, the place-map ConfigMap and
mount, and every fail-closed rejection. It requires the `helm` binary.

Live values files, kubeconfigs, cluster names, infrastructure addresses, and
credentials do not belong in this repository.
