# PSFN Helm Chart

This chart renders the first PSFN Kubernetes/k3s topology for one companion:

- gateway Deployment and public API Service/Ingress
- agent Deployment and internal mTLS Garden admin transport Service
- Garden Deployment and browser UI Service/Ingress
- bundled Postgres + pgvector StatefulSet, or external Postgres Secret reference
- bundled Redis StatefulSet for app cache, or external Redis Secret reference
- bundled LiteLLM Deployment/Service for provider routing, or external LiteLLM URL
- optional emo_sim observer-eval engine Deployment/Service/PVC (`emosim.enabled`)
- optional companion-ui test web Deployment/Service/Ingress serving the PWA
  static build (`companionUiTest.enabled`)
- PVC-backed system-data, companion-data, workspace, runtime, and model-cache roots
- cert-manager Issuer/Certificate resources for internal SPIFFE mTLS
- default-deny NetworkPolicies for gateway/agent/garden/Postgres/Redis/LiteLLM flows

The chart is in `deploy/helm/psfn`. Runtime app behavior still comes from the
repo-owned entrypoints: `dist/gateway-main.js`, `dist/agent-main.js`, and
`dist/operator-main.js`.

## Prerequisites

- k3s or Kubernetes with a default StorageClass.
- Helm 4.x or compatible Helm 3.x renderer.
- cert-manager CRDs/controllers installed before applying this chart.
- A NetworkPolicy-capable CNI if you expect NetworkPolicies to be enforced.
  Stock k3s flannel does not enforce NetworkPolicy by itself.
- A PSFN app image built from `docker/Dockerfile.agent`. The image now carries
  `/app/config/*.seed.json` for opt-in first-install owner-file bootstrap
  (`bootstrap.seedOwnerFiles`, default `false`), plus pinned `rg` and `bd`
  CLIs for source search and beads issue workflows.

Local image build:

```bash
docker build \
  --platform linux/amd64 \
  -f docker/Dockerfile.agent \
  -t localhost/psfn-framework:0.1.0-kube .
```

For Pi/k3s testing, build/import an ARM64 image and set
`psfnAppImage.repository`, `psfnAppImage.tag`, and preferably
`psfnAppImage.digest`.

## Required Values

Default values render with `CHANGE_ME_*` placeholders so `helm lint` and
`helm template` stay usable. Replace these before an actual install:

- `secrets.values.apiKey` -> `API_KEY`, consumed by gateway
- `secrets.values.satelliteHubApiKey` -> `SATELLITE_HUB_API_KEY` (hub
  `PSFN_API_KEY`) and the gateway `API_SATELLITE_KEYS` list; required when
  `satelliteHub.enabled=true` and never the same value as `apiKey`/`adminToken`
- `secrets.values.adminToken` -> `ADMIN_TOKEN`, consumed by gateway/Garden
- `secrets.values.gatewaySessionHmacKey` -> `GATEWAY_SESSION_HMAC_KEY`, consumed by gateway
- `secrets.values.gatewaySessionIntegrityAuthToken` ->
  `GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN`, the role-bound worker proof consumed
  by the agent; derive it for the configured companion as documented in
  `docs/setup.md`, or provide that proof through `secrets.existingSecret`.
  The agent also derives its Garden audit opaque-ID key from this proof through
  a one-way, domain-separated transform; it never receives the gateway root key
- `secrets.values.gatewayCompanionAuthToken` ->
  `GATEWAY_COMPANION_AUTH_TOKEN`, the distinct role-bound agent proof required
  by multi-companion agents; it is optional for single-companion installs
- `secrets.values.backupEncryptionKey` -> `PSFN_BACKUP_ENCRYPTION_KEY`, consumed by app workloads
- provider/channel secrets as needed: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
  `LITELLM_API_KEY`, `DISCORD_TOKEN`, `DISCORD_BOT_ID`, `DEEPGRAM_API_KEY`,
  `ELEVENLABS_API_KEY`, `FAL_API_KEY`, `NTFY_TOKEN`
- `satelliteHub.elevenLabsVoiceId` when `satelliteHub.enabled=true`
- optional embedding/Hugging Face secrets: `EMBEDDING_API_KEY`, `HF_TOKEN`
- bundled Postgres placeholder: `postgres.auth.password`
- bundled Redis placeholder: `redis.auth.password`

Set `secrets.allowMissingRequired=false` in install values to make Helm fail
early when the required app keys are absent. You may also set
`secrets.existingSecret` and provide the documented keys yourself.

Secrets are rendered only as Kubernetes Secrets. The chart does not copy secret
material into ConfigMaps, annotations, labels, or NOTES.

## Runtime Layout

The chart sets the production split-root contract explicitly:

```text
SYSTEM_DATA_DIR=/app/system-data
COMPANION_DATA_DIR=/app/companion-data
WORKSPACE_PATH=/app/workspace
PSFN_LOGS_DIR=/app/logs
PSFN_TEMP_DIR=/app/tmp
BACKUP_ROOT_DIR=/app/backups
CONFIG_DIR=/app/config
CHARACTER_CARD_PATH=/app/companion-data/companion.json
```

`system-data`, `companion-data`, `workspace`, `runtime`, and `model-cache` are
PVC-backed. The seed init container creates the runtime directories and, only
when `bootstrap.seedOwnerFiles=true`, copies `/app/config/*.seed.json` into
the correct owner root for any missing owner file. Cluster-global owners go to
`system-data`; `scheduler.json` and `capability-tier.json` go to
`companion-data`. It never overwrites Garden-edited owner files. A starter
`companion.json` ConfigMap is copied once into `companion-data` only if no
companion card exists.

`bootstrap.seedOwnerFiles` defaults to `false`. With it disabled, absent owner
files fail closed at startup with the runtime's `loadRequiredJson` error rather
than silently running on seed defaults — the runtime must not seed itself
(`src/system/config/load-or-seed.ts`). Set it to `true` for a first-ever
install to consciously opt in to seeding, then leave it `false` (or unset) for
all subsequent upgrades so a stale seed can never mask a missing/mis-migrated
owner file.

Mutable owner JSON stays on PVCs, not in ConfigMaps.

### Upgrading releases created before per-companion owner files

`scheduler.json` and `capability-tier.json` used to live under `system-data`.
Every app workload runs the same idempotent init migration before startup:

- If the companion-owned target is absent and a legacy system-owned file
  exists, the file is first copied byte-for-byte and a source-hash marker is
  written under `companion-data/.owner-migrations/`.
- After owner routing, the compiled `migrate-scheduler-owner` entrypoint
  validates and atomically upgrades the retired `salienceDecayIntervalMs` /
  `socialGraphBuilder.intervalMs` shape to
  `backgroundMaintenance.intervalMs`. An already-canonical scheduler is
  validated without being rewritten; mixed or invalid shapes fail closed.
- The legacy source is retained as the rollback snapshot. The runtime never
  reads it as a fallback after the upgrade.
- A later companion-owned edit is preserved. The marker binds the unchanged
  legacy source, so the init path can distinguish a legitimate target edit from
  an ambiguous first migration.
- If an unmarked source and target differ, or the legacy source changes after a
  marked migration, startup fails closed with an actionable error. The chart
  never guesses which schedule or capability tier is authoritative.
- If neither file exists, only an intentional first install with
  `bootstrap.seedOwnerFiles=true` creates the companion-owned file. Otherwise
  the init container fails before runtime startup.

Before upgrading another cluster, preserve its values and take a backup. Then
compare hashes for both files at the old and new roots without printing their
contents:

```bash
RELEASE=psfn
NAMESPACE=psfn
helm get values "$RELEASE" -n "$NAMESPACE" -o yaml > "/tmp/${RELEASE}-values.yaml"
chmod 600 "/tmp/${RELEASE}-values.yaml"

kubectl -n "$NAMESPACE" exec deploy/psfn-agent -- sh -c '
  for root in /app/system-data /app/companion-data; do
    for file in scheduler.json capability-tier.json; do
      if [ -f "$root/$file" ]; then sha256sum "$root/$file"; else echo "MISSING $root/$file"; fi
    done
  done
'
```

If the old workload is already crash-looping because it requires the new
companion-owned paths, skip the `kubectl exec` preflight. That is not a reason
to roll back or copy files manually: deploy the fixed chart and exact image as
the forward recovery. Its init container runs before the application and
performs the same guarded migration directly on the PVCs. Use its logs for a
fail-closed conflict diagnosis:

```bash
kubectl -n "$NAMESPACE" logs deploy/psfn-agent -c seed-runtime-files --tail=-1
```

Safe automatic upgrade states are: legacy source present and target absent;
both present and byte-identical before the first marked migration; or target
present with no legacy source. If both exist and differ without a marker, stop,
back up both, and explicitly reconcile the authoritative file before upgrading.
Do not enable seed defaults to conceal a conflict.

Use the saved values with an exact, non-floating image reference. For a local
k3d import, the pinned commit tag is sufficient; production registries should
also set the immutable digest:

```bash
IMAGE_REPOSITORY=localhost/psfn-framework
IMAGE_TAG=0.1.0-kube-<git-short-sha>
helm upgrade --install "$RELEASE" deploy/helm/psfn \
  --namespace "$NAMESPACE" \
  -f "/tmp/${RELEASE}-values.yaml" \
  --set-string psfnAppImage.repository="$IMAGE_REPOSITORY" \
  --set-string psfnAppImage.tag="$IMAGE_TAG" \
  --set-string psfnAppImage.digest= \
  --set psfnAppImage.pullPolicy=IfNotPresent \
  --set bootstrap.seedOwnerFiles=false \
  --wait --timeout 10m
```

This one upgrade handles both historical boundaries in order: system-to-
companion owner routing, then the scheduler schema conversion. Do not edit the
PVC JSON by hand or run a separate schema rewrite before Helm. Repeat this
command for every release/companion root in a multi-release cluster.

After the Helm upgrade, require all three app rollouts and verify the new owner
paths and markers:

```bash
kubectl -n "$NAMESPACE" rollout status deploy/psfn-agent --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/psfn-gateway --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/psfn-garden --timeout=300s
kubectl -n "$NAMESPACE" exec deploy/psfn-agent -- sh -c '
  for file in scheduler.json capability-tier.json; do
    test -f "/app/companion-data/$file"
    test -f "/app/companion-data/.owner-migrations/$file.from-system.sha256" \
      || test ! -f "/app/system-data/$file"
  done
'
```

The retained system-owned files preserve rollback evidence, but forward
recovery with the fixed chart is the normal response to the ownership-cutover
crash loop. Later companion-owned edits are intentionally not mirrored back to
the retired path.

## Repository Checkout

`/app/workspace` is the personal files PVC, not the application source tree.
The chart can optionally mount an existing repository checkout at
`/app/repository` and sets `GIT_REPO_ROOT=/app/repository` only when that mount
is enabled. The chart does not clone or seed source code.

HostPath example:

```yaml
repositoryCheckout:
  enabled: true
  hostPath:
    path: /srv/psfn/repository
```

PVC example:

```yaml
repositoryCheckout:
  enabled: true
  persistentVolumeClaim:
    claimName: psfn-source-checkout
```

Beads policy env remains unset by default so the runtime keeps its existing
fallback behavior. To force-enable beads tools for a mounted checkout, set:

```yaml
beads:
  toolsEnabled: true
  allowActions:
    - ready
    - show
    - create
    - update
    - close
    - sync
```

## Host Port Exposure

Services render as ClusterIP by default. On a single-node k3s host, set:

```yaml
hostPorts:
  gatewayApi:
    enabled: true
    port: 10053
    sourceCIDRs:
      - 192.0.2.10/32
  garden:
    enabled: true
    port: 10054
    sourceCIDRs:
      - 192.0.2.10/32
```

This binds the Gateway API and Garden/admin UI directly on the node while
keeping Gateway RPC, agent admin transport, Postgres, Redis, and LiteLLM
cluster-internal. Use it only when those node ports are reserved for PSFN; the
old systemd app services must remain stopped to avoid port and Discord login
conflicts. When `networkPolicy.enabled=true`, set `sourceCIDRs` to the operator
workstation or trusted subnet that should reach the node-facing port.

The Gateway and Garden Deployments use a Recreate strategy so single-node k3s
rollouts do not deadlock when both the old and new pods need the same hostPort.
The agent Deployment keeps the default rolling strategy because it does not bind
a hostPort.

## Database

Default greenfield mode renders `pgvector/pgvector:0.8.1-pg17` pinned to:

```text
sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21
```

The init SQL runs:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

External Postgres mode:

```bash
helm template psfn deploy/helm/psfn \
  --set postgres.enabled=false \
  --set postgres.external.enabled=true \
  --set postgres.external.databaseUrlSecret.name=my-postgres-url
```

The external Secret must contain `postgres-database-url` unless you override
`postgres.external.databaseUrlSecret.key`.

Backup/restore validation still requires PG17 client tools and pgvector present
in the scratch restore database.

## LiteLLM

`liteLlm.enabled=true` and `liteLlm.mode=internal` render a dedicated LiteLLM
Deployment and ClusterIP Service at:

```text
http://<release>-litellm.<namespace>.svc:4000/v1
```

Only the gateway receives `LITELLM_BASE_URL` and provider credential env. The
agent keeps talking to the gateway over the existing mTLS RPC transport and does
not receive direct LiteLLM endpoint or API-key wiring. With NetworkPolicy
enforcement, gateway egress to LiteLLM is allowed and agent egress to LiteLLM is
not.

External LiteLLM mode keeps the same gateway-owned route while omitting the
bundled pod:

```bash
helm template psfn deploy/helm/psfn \
  --set liteLlm.mode=external \
  --set liteLlm.external.baseUrl=https://litellm.example/v1
```

Set `liteLlm.enabled=false` for direct-provider-only deployments. Model routing
still follows `providers.json` and `models.json`; OpenRouter-sourced model
entries can intentionally bypass LiteLLM through their direct source route.

The bundled LiteLLM config is a replaceable ConfigMap. The default config
contains an OpenRouter wildcard route and reads secrets from environment
variables, not ConfigMaps. Use `liteLlm.config.existingConfigMap` when you need a
custom LiteLLM config.

## emo_sim Observer-Eval Engine (optional)

`emosim.enabled=true` deploys the long-lived emo_sim emotion-simulation server
consumed by the observer eval sidecar
(`observerEvalSidecar.adapter.kind=emosim_server` in `settings.json`), as a
single-replica Recreate Deployment with a `/state` PVC so one persistent
session accumulates temporal emotion state across turns and restarts.

Build the image from `docker/Dockerfile.emosim` with an emo_sim checkout as
the build context (see the Dockerfile header for the exact command) and set
`emosim.image.repository`/`emosim.image.tag`.

The sidecar's `settings.json` should point at the ClusterIP service:

```text
http://<release>-emosim:17342
```

Security: the emo_sim API is UNAUTHENTICATED by upstream design. The chart
exposes it only as a ClusterIP service and, when `networkPolicy.enabled=true`,
restricts ingress to agent pods on the HTTP port and denies all egress. Never
expose ports 17341/17342 outside the cluster.

Simulation pacing (`--timescale`, `--drivescale`, `--tick`) is controlled via
`emosim.extraArgs` without an image rebuild.

## Redis Prompt Cache

Default Redis mode renders `redis:8.4.0-bookworm` pinned to:

```text
sha256:c22af04bb576503bf16b3e34a1fd2fd82de0f765afd866d2e380145e0af30d78
```

The agent receives:

```text
PSFN_APP_CACHE_MODE=redis
PSFN_REDIS_URL=redis://<release>-psfn-redis:6379
PSFN_REDIS_PASSWORD=<from Secret>
```

Set `redis.enabled=false` for memory cache mode, or `redis.mode=external` with
`redis.external.url` and `redis.external.passwordSecret`.

## Internal mTLS

The default cert-manager path creates a namespace Issuer:

1. self-signed bootstrap Issuer
2. CA Certificate/Secret
3. CA Issuer
4. workload Certificates for gateway RPC, agent RPC client, agent admin server,
   and Garden admin client

Each workload cert includes the SPIFFE URI SAN used by the app mTLS checks:

```text
spiffe://cluster.local/psfn/gateway/<companionId>
spiffe://cluster.local/psfn/agent/<companionId>
spiffe://cluster.local/psfn/garden/<companionId>
```

Use `certificates.issuer.existingIssuerRef` to point at an existing Issuer or
ClusterIssuer. cert-manager itself is not installed by this chart.

## Network Policies

The chart renders default deny plus workload policies for:

- ingress -> gateway API
- agent -> gateway RPC
- Garden -> agent admin transport
- gateway and agent -> Postgres
- agent -> Redis
- gateway -> LiteLLM, when internal LiteLLM is enabled
- optional satellite hub -> gateway API
- optional companion-ui test surface: ingress -> port 8080, egress denied

The agent policy does not contain broad `0.0.0.0/0` egress and the chart does
not set `ALLOW_AGENT_OUTBOUND_NETWORK=true`. The agent policy also has no
LiteLLM egress rule; provider routing remains a gateway responsibility.

## Embeddings

The default owner seed uses local Transformers:

```text
embeddingProvider=transformers
embeddingModel=Xenova/all-MiniLM-L6-v2
embeddingDims=384
model cache=/app/models/transformers
```

The model-cache PVC is mounted at `/app/models/transformers`. Models download
on first use unless you pre-populate the PVC or enable `modelPrefetch`.

## Model Prefetch

`modelPrefetch.enabled=false` by default. Set it to `true` to render a
one-shot `model-prefetch` Job that uses the PSFN app image, mounts the
model-cache PVC at `/app/models/transformers`, and downloads the text-emotion
model `SamLowe/roberta-base-go_emotions-onnx` before restricted-egress agent
startup relies on the cache.

Kubernetes NetworkPolicy cannot portably restrict egress by provider hostname.
When NetworkPolicies are enabled, the chart gives only the `model-prefetch` Job
DNS and external TCP/443 egress; the agent policy remains restricted and does
not inherit that access. If your cluster requires domain allowlisting, allow the
model provider endpoints, including Hugging Face model download endpoints, in
the CNI, firewall, proxy, or egress gateway.

Helm does not safely hard-order a normal Job before Deployment startup while
also creating the PVC it mounts. For a first boot with restricted agent egress,
install or upgrade once with the agent scaled down, wait for the Job, then
enable the agent:

```bash
helm upgrade --install psfn deploy/helm/psfn \
  --namespace psfn \
  --create-namespace \
  --set modelPrefetch.enabled=true \
  --set workloads.agent.replicaCount=0
kubectl -n psfn wait --for=condition=complete job/psfn-model-prefetch --timeout=30m
helm upgrade --install psfn deploy/helm/psfn \
  --namespace psfn \
  --set modelPrefetch.enabled=false \
  --set workloads.agent.replicaCount=1
```

API-backed embeddings remain supported by setting owner-file values and the
`EMBEDDING_API_KEY` Secret. The chart does not add a new embedding subsystem.

## Satellite Hub

`satelliteHub.enabled` defaults to `false`. The chart can run the external
PSFN-Satellite-Hub TypeScript runtime when you build a pinned image from a clean
hub source checkout. This repo owns the Kubernetes contract and a Dockerfile for
that external source; the hub source tree still owns the hub application code.

Build the image with the repo-owned Dockerfile and the hub checkout as the
Docker context:

```bash
SATELLITE_HUB_SOURCE="$HOME/psfn-framework/PSFN-Satellite-Hub" \
SATELLITE_HUB_SOURCE_REF=<full hub git commit> \
SATELLITE_HUB_IMAGE_REPOSITORY=localhost/psfn-satellite-hub \
SATELLITE_HUB_PLATFORM=linux/amd64 \
docker/satellite-hub/build-image.sh
```

The script refuses dirty hub source by default, refuses floating tags, and tags
the image as `0.1.0-kube-<source-sha12>` unless
`SATELLITE_HUB_IMAGE_TAG` is set. The Dockerfile uses the pinned
`node:22.22.2-slim` image digest and `npm ci` against the hub checkout's
`package-lock.json`.

For a local k3d/k3s shakedown, import the built image into the test cluster and
enable the hub with a concrete tag or digest:

```bash
k3d image import localhost/psfn-satellite-hub:0.1.0-kube-<source-sha12> -c <cluster>

helm upgrade --install psfn deploy/helm/psfn \
  --namespace psfn-test \
  --create-namespace \
  --set satelliteHub.enabled=true \
  --set satelliteHub.image.repository=localhost/psfn-satellite-hub \
  --set satelliteHub.image.tag=0.1.0-kube-<source-sha12> \
  --set satelliteHub.identity.satelliteId=hub-test \
  --set satelliteHub.identity.endpointId=hub-test-main \
  --set satelliteHub.identity.claimType=voice-only \
  --set-string secrets.values.satelliteHubApiKey=<dedicated-hub-key-16plus-chars> \
  --set satelliteHub.elevenLabsVoiceId=<elevenlabs-voice-id> \
  --set-string secrets.values.deepgramApiKey=<deepgram-key> \
  --set-string secrets.values.elevenLabsApiKey=<elevenlabs-key> \
  --set ingress.satelliteHub.enabled=true

kubectl -n psfn-test rollout status deploy/psfn-satellite-hub
kubectl -n psfn-test port-forward svc/psfn-satellite-hub 8787:8787
curl http://127.0.0.1:8787/
```

The rendered hub container runs `node dist/ts/hub/main.js`, listens on
`REALTIME_VOICE_PORT=<ports.satelliteHub>`, and points both
`PSFN_API_BASE_URL` and `PSFN_COMPANION_BASE_URL` (companion event relay
bridge, `satelliteHub.companionBridge.enabled`) at the in-cluster Gateway
Service:

```text
http://<release>-psfn-gateway:<ports.gatewayApi>/v1
```

Hub configuration surface:

- `satelliteHub.identity.{satelliteId,endpointId,claimType}` (required) are
  injected as `PSFN_SATELLITE_ID`/`PSFN_ENDPOINT_ID`/`PSFN_CLAIM_TYPE` and must
  match a `satellites.json` endpoint entry; the hub never falls back to its
  built-in default identity.
- `secrets.values.satelliteHubApiKey` (required) is the hub's dedicated bearer
  credential. It reaches the hub as `PSFN_API_KEY` and the gateway inside
  `API_SATELLITE_KEYS`, yielding a satellite-scoped principal
  (`api-key-<sha256(key)[:24]>`) that the registry endpoint must list in
  `auth.apiKeyPrincipalIds`. `secrets.values.extraSatelliteApiKeys` appends
  more per-satellite keys to the gateway list.
- `satelliteHub.textOnly=true` sets `HUB_TEXT_ONLY=true`; Deepgram/ElevenLabs
  secrets and `satelliteHub.elevenLabsVoiceId` become optional. Voice mode
  requires all three.
- With Home Assistant enabled under the default NetworkPolicy, set
  `satelliteHub.homeAssistant.egressCIDRs` to the exact HA host/subnet and
  `satelliteHub.homeAssistant.egressPort` to its API/WebSocket port. Private
  LAN egress remains denied for every address not explicitly listed.
  The private Hub control port is admitted only from the in-cluster Gateway
  pod selector; it is not added to hostPort or Ingress exposure.
- `hostPorts.satelliteHub` exposes `ws://<node>:8787` for LAN satellite
  devices, following the same single-node hostPort mechanism as the gateway
  API; set `sourceCIDRs` to the trusted subnet.
- A cert-manager client Certificate
  (`spiffe://<trustDomain>/psfn/satellite-hub/<companionId>`) is issued from
  the chart CA/issuer and mounted at
  `<certificates.mountBasePath>/psfn-client`. It stages the satellite mTLS
  upgrade path; runtime auth today is the scoped bearer key. See
  [`../../../docs/satellite-hub-kube.md`](../../../docs/satellite-hub-kube.md)
  for the full Pi runbook, the satellites.json entry pattern (including the
  companion relay scopes), and the mTLS flip procedure.

A public single-node example with pinned-tag placeholders lives at
`overlays/pi-satellite-hub.values.yaml` (kept out of chart packaging via
`.helmignore`). Copy it to `overlays/pi-satellite-hub.local.values.yaml`,
which is gitignored, and put deployment-specific addresses, CIDRs, credential
digests, and device registry entries only in that local file.

The hub NetworkPolicy allows ingress only from the configured ingress
controller selector (plus `hostPorts.satelliteHub.sourceCIDRs` when the
hostPort is enabled), egress to kube-dns, egress to the Gateway API Service, and
optional external HTTPS egress for Deepgram/ElevenLabs provider calls. The agent
NetworkPolicy remains separate and still has no broad outbound egress.

## Companion UI Test Surface

`companionUiTest.enabled` defaults to `false`. It renders an optional in-cluster
static web container that serves the `companion-ui` PWA so the operator can open
it in a browser and chat through the Satellite Hub. The container serves the
pre-built Vite `dist/` tree only — no server logic, no admin API, no outbound
calls. The browser talks to the hub directly. This is a stopgap test surface to
be replaced by a packaged app.

Build the image (ARM64 for the Pi) from this repo's `companion-ui/` source with
the repo-owned Dockerfile and build script:

```bash
COMPANION_UI_PLATFORM=linux/arm64 \
docker/companion-ui/build-image.sh
```

The script tags the image `0.1.0-kube-<repo-sha12>`, refuses a dirty tree
(override with `COMPANION_UI_ALLOW_DIRTY=true` only for throwaway probes) and
floating tags, and passes the source commit as `SOURCE_REVISION`. The hub
websocket URL is baked as a build-time default
(`COMPANION_UI_HUB_WS_URL`, default `ws://psfn-hub.local:8787/`) but stays
editable at runtime in the in-app Settings drawer, so the baked value is a
convenience, not a constraint. The runtime stage uses the pinned
`nginxinc/nginx-unprivileged` image (manifest-list digest, resolves the ARM64
sub-image on the Pi) and serves on port 8080 as uid 999, with the service worker
served no-cache and the PWA manifest served as `application/manifest+json`.

Import the image into k3s (containerd) and retag it under the `localhost/`
prefix the chart expects, then enable the workload:

```bash
docker save localhost/psfn-companion-ui:0.1.0-kube-<repo-sha12> \
  | sudo k3s ctr images import -
# containerd stores it as docker.io/localhost/... ; retag to the bare localhost/ ref:
sudo k3s ctr images tag \
  docker.io/localhost/psfn-companion-ui:0.1.0-kube-<repo-sha12> \
  localhost/psfn-companion-ui:0.1.0-kube-<repo-sha12>

helm upgrade --install psfn deploy/helm/psfn \
  --namespace psfn \
  --set companionUiTest.enabled=true \
  --set companionUiTest.image.repository=localhost/psfn-companion-ui \
  --set companionUiTest.image.tag=0.1.0-kube-<repo-sha12> \
  --set companionUiTest.image.pullPolicy=Never \
  --set ingress.companionUiTest.enabled=true

kubectl -n psfn rollout status deploy/psfn-companion-ui-test
```

Pinning is enforced: the chart rejects a missing repository, a missing
tag/digest, floating tags (`latest`/`main`/`main-latest`), and a digest that
does not start with `sha256:` when the workload is enabled. Prefer setting
`companionUiTest.image.digest` for a fully pinned deploy.

Reach it from a browser through the enabled Ingress host
(`ingress.companionUiTest.host`, default `psfn-companion.local`), or port-forward
for a quick check:

```bash
kubectl -n psfn port-forward svc/psfn-companion-ui-test 8080:8080
# open http://127.0.0.1:8080/ in a browser
```

Then open the in-app Settings drawer (floating gear button) and point the hub
websocket URL at the Satellite Hub — for example the in-cluster hub Ingress
(`ws://psfn-hub.local:8787/`, per `ingress.satelliteHub.host`) or a
port-forwarded hub. The companion-ui test pod itself needs the Satellite Hub
enabled (`satelliteHub.enabled=true`, see above) to have something to chat with.

The companion-ui test NetworkPolicy allows ingress only from the configured
ingress controller selector on port 8080 and denies all egress: the static
server never makes outbound calls, so the browser — not the pod — connects to
the hub.

## Shakedown Runbook

Use an isolated namespace and test values before any live Pi cutover. For the
Artie fixture, treat `/mnt/c/Temp/PSFN-TEST/psfn-shakedown` as read-only until
you intentionally copy data into test PVCs. Never point test values at live
Purrsephone runtime roots or live database credentials.

Install cert-manager first, with a pinned chart/version selected by the
operator:

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update jetstack
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version <pinned-cert-manager-version> \
  --set crds.enabled=true
```

For a greenfield local shakedown, build/import the PSFN image and install with
placeholder test secrets. If restricted agent egress is required on first boot,
run the `modelPrefetch` two-step flow above before enabling the agent.

Core readiness and smoke commands:

```bash
kubectl -n psfn-test get pods,deploy,sts,pvc,certificates,issuers,services,networkpolicies

kubectl -n psfn-test rollout status deploy/psfn-gateway
kubectl -n psfn-test rollout status deploy/psfn-agent
kubectl -n psfn-test rollout status deploy/psfn-garden

PG_PASS="$(kubectl -n psfn-test get secret psfn-postgres -o jsonpath='{.data.postgres-password}' | base64 -d)"
kubectl -n psfn-test exec psfn-postgres-0 -- \
  env PGPASSWORD="$PG_PASS" psql -U psfn -d psfn -tAc \
  "select extname from pg_extension where extname='vector';"

REDIS_PASS="$(kubectl -n psfn-test get secret psfn-redis -o jsonpath='{.data.redis-password}' | base64 -d)"
kubectl -n psfn-test exec psfn-redis-0 -- redis-cli -a "$REDIS_PASS" ping

kubectl -n psfn-test port-forward svc/psfn-gateway 10053:10053
API_KEY="$(kubectl -n psfn-test get secret psfn-app -o jsonpath='{.data.API_KEY}' | base64 -d)"
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10053/v1/models

kubectl -n psfn-test port-forward svc/psfn-garden 10054:10054
curl http://127.0.0.1:10054/health
```

If the satellite hub is enabled, also verify:

```bash
kubectl -n psfn-test rollout status deploy/psfn-satellite-hub
kubectl -n psfn-test port-forward svc/psfn-satellite-hub 8787:8787
curl http://127.0.0.1:8787/
```

NetworkPolicy behavior depends on the CNI. On a policy-enforcing cluster, the
gateway should be able to reach configured external provider endpoints while the
agent should not have arbitrary internet egress:

```bash
GATEWAY_POD="$(kubectl -n psfn-test get pod -l app.kubernetes.io/component=gateway -o jsonpath='{.items[0].metadata.name}')"
kubectl -n psfn-test exec "$GATEWAY_POD" -- \
  node -e "fetch('https://example.com').then(r=>console.log(r.status))"

AGENT_POD="$(kubectl -n psfn-test get pod -l app.kubernetes.io/component=agent -o jsonpath='{.items[0].metadata.name}')"
kubectl -n psfn-test exec "$AGENT_POD" -- \
  node -e "const c=new AbortController(); setTimeout(()=>c.abort(),8000); fetch('https://example.com',{signal:c.signal}).then(r=>{console.log('UNEXPECTED:'+r.status); process.exit(2)}).catch(e=>console.log(e.name+':'+e.message))"
```

Agent logs should confirm the production Postgres path:

```bash
kubectl -n psfn-test logs deploy/psfn-agent --since=10m | \
  grep -E 'PostgreSQL persistence backend selected|Ready'
```

## Backup And Pi Cutover

Live Pi cutover requires explicit operator confirmation and a service freeze
window. Do not interrupt the live Purrsephone system during chart prep or test
cluster shakedowns.

The shared application image carries the repo-owned chart at
`/app/deploy/helm/psfn`. The chart injects non-secret release, namespace,
revision, chart-content digest, every workload's effective image reference, and
source provenance into the agent. Scheduled encrypted backups therefore include
a hash-verified `helm-recovery/` bundle automatically for Helm deployments. A
checked-in `recovery-chart.sha256` binds the embedded chart to the chart rendered
by the active release; selective shipping automatically adds an agent rollout
when chart files changed. The bundle intentionally excludes documentation, live
Helm values, rendered manifests, and Kubernetes Secrets. `backup-contents.json`
marks Helm recovery as required inside the authenticated encrypted payload, so a
missing bundle fails restore verification. Operators must re-provision
credentials and review site-specific values instead of restoring stale secret
material.

Before cutover:

1. Verify the current non-kube backup path: Postgres `pg_dump`, L0/session
   JSONL, companion-data file tree, companion-tree hash manifest, and scratch
   restore with pgvector.
2. Run the restore verifier against a real backup set:

   ```bash
   npm run verify:backup-restore -- \
     --backup-dir <snapshot-dir> \
     --postgres-restore-url <scratch-postgres-url> \
     --postgres-source-url <source-postgres-url>
   ```

3. Decide how system-data owner files, workspace/home files, and secret-bearing
   env/systemd artifacts are restored. Do not silently place provider secrets in
   broad unencrypted backups.
4. Capture a fresh pre-cutover backup and record current systemd service state.
5. On the Pi, verify storage mounts with `findmnt` before copying data. Path
   existence is not enough; live write-heavy paths should resolve to the intended
   NVMe-backed mount.

Cutover outline:

1. Install or verify k3s, cert-manager, the StorageClass, ingress controller,
   and NetworkPolicy-capable CNI if enforcement is required.
2. Build/import or pull pinned PSFN and satellite-hub images for the Pi
   architecture.
3. Prepare Helm values with native Kubernetes Secrets, split production roots,
   Postgres+pgvector or external Postgres, Redis, certificates, and no
   off-repo authoritative runtime config.
4. Restore/copy Postgres, companion-data, system-data owner files, workspace,
   L0/session files, model cache, and runtime backup directories into PVCs
   intentionally.
5. Run model prefetch before relying on restricted agent egress.
6. Install into an isolated namespace and run the smoke checklist above.
7. Only after kube smoke is green, stop the existing repo-owned systemd PSFN
   services intentionally and switch ingress/DNS/ports to kube.
8. Post-cutover, verify chat/API, Garden health, backup schedule, Redis cache
   logs, Postgres restore probes, and satellite hub reachability if enabled.

Rollback points are before service freeze, after fresh backup, after PVC
restore, after Helm install before traffic switch, and immediately after traffic
switch. Roll back by scaling or uninstalling the Helm release, restoring data
from the fresh backup if needed, and restarting the repo-owned systemd
registrations.

## Validation

```bash
helm lint deploy/helm/psfn
helm template psfn deploy/helm/psfn --namespace psfn-test > /tmp/psfn-render.yaml
npm run verify:helm-chart
```

If cert-manager CRDs are not installed, `kubectl apply --dry-run=client` will
report missing mappings for `cert-manager.io/v1` resources. That is a
prerequisite failure, not a template failure.
