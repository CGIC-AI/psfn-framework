# Setup

PSFN supports three installation paths. Choose one and keep using its lifecycle
commands; do not combine process supervision or persistent volumes from
different paths.

| Path | Provides | Prerequisites |
| --- | --- | --- |
| Docker Compose | PostgreSQL, gateway, agent, Garden, model prefetch, alert sink | Docker with Compose v2 |
| Repository-native | Supervised host processes for gateway, agent, Garden, alert sink | PostgreSQL 17 with pgvector |
| Helm / Kubernetes | PostgreSQL, gateway, agent, Garden, model prefetch, alert sink, mTLS | `kubectl`, Helm, and either Docker+k3d or an existing cluster with a default StorageClass |

All paths require Node.js 24.19 or newer within the Node 24 LTS line, npm, a
supported provider credential, and network access to that provider. A first
install also downloads pinned local embedding, emotion, and CogSec models.

## Common onboarding

From a clean checkout:

```bash
npm ci
npm run onboard
```

The interactive flow asks for:

- one of the three deployment paths;
- a provider endpoint, credential environment-variable name, and model names;
- a new companion or an existing supported companion definition; and
- the persistent data roots used by that path.

It generates and validates the canonical owner files. Compose and
repository-native onboarding also write the selected provider credential and
generated runtime credentials to the ignored `.env` file. Kubernetes writes
only non-secret target and edge coordinates there; it does not write the
provider key. Export the environment variable named in generated
`providers.json` before running a `helm:*` command.

Rerun onboarding to change providers or regenerate configuration. Existing
owner files are shown as updates and are not silently replaced.

## Path 1: Docker Compose

This is the smallest self-contained persistent installation.

```bash
npm run compose:up
npm run compose:verify
```

Open `http://127.0.0.1:10053`. The Garden login token is `ADMIN_TOKEN` in the
ignored `.env` file. The OpenAI-compatible API listens on
`http://127.0.0.1:10054/v1`.

Data is stored below `PSFN_DATA_ROOT` (default `./data`) and in the Compose
PostgreSQL volume. `compose:down`, `compose:restart`, and `compose:update`
preserve it.

Use these commands after installation:

```bash
npm run compose:status
npm run compose:doctor
npm run compose:logs
npm run compose:restart
npm run compose:update
npm run compose:down
```

## Path 2: repository-native

Use this path when the runtime should be supervised directly from the checkout.
Before onboarding, create a PostgreSQL 17 server with pgvector and have a
credentialed `postgres` administrator URL available. The onboarding flow asks
for that URL and writes it only to the ignored `.env` file.

```bash
npm run local:up
npm run local:verify
```

`local:up` validates pgvector, creates isolated runtime roles, builds the
application and Garden, and starts a detached supervisor. The same Garden and
API defaults are used: ports `10053` and `10054` on loopback.

```bash
npm run local:status
npm run local:doctor
npm run local:logs
npm run local:restart
npm run local:update
npm run local:recover
npm run local:down
```

`local:update` builds a candidate before replacing the running release and
records the previous good build. `local:recover` restores that recorded build
without replacing owner files or persistent data.

## Path 3: Helm / Kubernetes

The public chart is [`deploy/helm/psfn`](../deploy/helm/psfn/). The lifecycle
always requires the exact kubectl context; it never selects a cluster from the
current context. It stages generated owner files and Kubernetes Secrets without
placing credential values in Helm arguments or release history.

For a cluster that pulls from a registry, use an immutable tag or digest:

```bash
export PSFN_KUBE_CONTEXT=my-cluster-context
export PSFN_IMAGE=registry.example/psfn:0.1.0
export PROVIDER_API_KEY='<provider credential>'

npm run helm:up
npm run helm:verify
```

`PROVIDER_API_KEY` is an example. Export the exact name referenced by your
generated `providers.json`.

For a new local install, run onboarding and choose **Kubernetes / Helm**, then
**Local k3d cluster**. Onboarding writes the non-secret context, cluster, native
Garden port, and optional connected Tailnet hostname to the ignored `.env`.
`helm:up` creates the pinned local cluster on first use, builds and imports the
current checkout, and keeps Garden connected through the cluster's Traefik
ingress without a Garden port-forward:

```bash
export PROVIDER_API_KEY='<provider credential>'

npm run helm:up
npm run helm:verify
```

`PROVIDER_API_KEY` is the example name; use the exact environment-variable name
shown by onboarding. When a connected Tailscale node is detected, onboarding
offers to publish Garden at `https://<node>.<tailnet>.ts.net/login`. Tailscale
terminates HTTPS on port 443 and forwards to the native loopback ingress. The
same standalone Garden token login remains in force.

The default namespace and release are `psfn`; override them with
`PSFN_HELM_NAMESPACE` and `PSFN_HELM_RELEASE`. New local k3d installs publish
Garden natively on loopback port `10053`; the API retains its supervised
loopback forward on `10054`. The native local URL is
`https://127.0.0.1:10053/login`; its cluster-issued certificate is expected on
loopback. `helm:connect` restores the API forward after a
restart and revalidates the native Garden/Tailscale route, but Garden itself no
longer depends on that command.

```bash
npm run helm:status
npm run helm:doctor
npm run helm:connect
npm run helm:disconnect
npm run helm:logs
npm run helm:restart
npm run helm:update
npm run helm:token
npm run helm:down
```

`helm:token` is the only command that prints the Garden login token. The
lifecycle retains application and PostgreSQL PVCs and the generated Secrets.
`helm:down` scales the release to zero; a later `helm:up` restores it from the
same persistent state.

## What a verified installation means

An installation is ready for normal use after both its `*:doctor` and
`*:verify` commands pass. Verification proves more than process health:

1. PostgreSQL, gateway, agent, Garden, model provisioning, and the alert sink
   are ready.
2. Authenticated Garden and the public API are reachable.
3. A real request reaches the configured provider.
4. The exact user and assistant turn is found in canonical persistent storage.
5. The workloads restart, then the same turn and Garden remain available.

Provider authentication, quota, or model-access failures are reported as
external provider failures; the lifecycle never substitutes a different
provider.

## Configuration and persistent data

Environment variables own secrets, ports, sockets, database wiring, and root
locations. Mutable settings live in canonical owner files such as
`settings.json`, `models.json`, `providers.json`, `scheduler.json`, and
`capability-tier.json`.

`SYSTEM_DATA_DIR`, `COMPANION_DATA_DIR`, and `WORKSPACE_PATH` must be distinct.
The workspace is the companion's Personal Workspace, not a runtime state or
configuration directory. The runtime rejects missing or overlapping production
roots.

Do not edit generated owner files inside an image. Change them through Garden
or in the persistent owner-file location. See
[`operations.md`](./operations.md) for upgrades, recovery, and backup rules.

## Compose model cache

The persistent Compose and Helm paths prefetch the pinned local models before
starting the isolated agent. For the separate disposable contributor smoke
harness, an offline model cache can be supplied as documented by its help:

```bash
npm run smoke:docker -- --help
```

That smoke harness is a checkout test, not a fourth deployment path. Keep all
downloaded model content out of Git.

## Common failures

- If Garden does not load, run the path's `*:status` and `*:doctor`; for Helm,
  also run `helm:connect` to restore supervised forwards and revalidate native
  k3d/Tailscale ingress.
- If onboarding reports a provider/model mismatch, use model identifiers served
  by the selected provider. No provider is assumed.
- If model prefetch fails, confirm outbound HTTPS access and retry `*:up`; it is
  safe against the existing persistent volumes.
- If repository-native startup cannot provision roles, verify the administrator
  URL authenticates as PostgreSQL user `postgres` and pgvector is installed.
- If Helm refuses to start, run onboarding to record an exact context. Existing
  clusters need a pinned `PSFN_IMAGE`; local k3d needs the matching onboarded
  `PSFN_K3D_CLUSTER` target.
