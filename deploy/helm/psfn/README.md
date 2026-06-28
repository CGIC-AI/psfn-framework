# PSFN Helm Chart

This chart renders the first PSFN Kubernetes/k3s topology for one companion:

- gateway Deployment and public API Service/Ingress
- agent Deployment and internal mTLS Garden admin transport Service
- Garden Deployment and browser UI Service/Ingress
- bundled Postgres + pgvector StatefulSet, or external Postgres Secret reference
- bundled Redis StatefulSet for app cache, or external Redis Secret reference
- bundled LiteLLM Deployment/Service for provider routing, or external LiteLLM URL
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
  `/app/config/*.seed.json` for seed-once owner-file bootstrap.

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

- `secrets.values.apiKey` -> `API_KEY`, consumed by gateway and satellite hub
- `secrets.values.adminToken` -> `ADMIN_TOKEN`, consumed by gateway/Garden
- `secrets.values.gatewaySessionHmacKey` -> `GATEWAY_SESSION_HMAC_KEY`, consumed by gateway
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
PVC-backed. The seed init container copies `/app/config/*.seed.json` into
`system-data` only when the target owner file is missing. It never overwrites
Garden-edited owner files. A starter `companion.json` ConfigMap is copied once
into `companion-data` only if no companion card exists.

Mutable owner JSON stays on PVCs, not in ConfigMaps.

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
SATELLITE_HUB_SOURCE=/home/ada/psfn-framework/PSFN-Satellite-Hub \
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
  --set satelliteHub.elevenLabsVoiceId=<elevenlabs-voice-id> \
  --set-string secrets.values.deepgramApiKey=<deepgram-key> \
  --set-string secrets.values.elevenLabsApiKey=<elevenlabs-key> \
  --set ingress.satelliteHub.enabled=true

kubectl -n psfn-test rollout status deploy/psfn-satellite-hub
kubectl -n psfn-test port-forward svc/psfn-satellite-hub 8787:8787
curl http://127.0.0.1:8787/
```

The rendered hub container runs `node dist/ts/hub/main.js`, listens on
`REALTIME_VOICE_PORT=<ports.satelliteHub>`, and points
`PSFN_API_BASE_URL` at the in-cluster Gateway Service:

```text
http://<release>-psfn-gateway:<ports.gatewayApi>/v1
```

The hub NetworkPolicy allows ingress only from the configured ingress
controller selector, egress to kube-dns, egress to the Gateway API Service, and
optional external HTTPS egress for Deepgram/ElevenLabs provider calls. The agent
NetworkPolicy remains separate and still has no broad outbound egress.

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

Agent logs should show the production Postgres path, not SQLite:

```bash
kubectl -n psfn-test logs deploy/psfn-agent --since=10m | \
  grep -E 'PostgreSQL persistence backend selected|skipping SQLite startup checks|Ready'
```

## Backup And Pi Cutover

Live Pi cutover requires explicit operator confirmation and a service freeze
window. Do not interrupt the live Purrsephone system during chart prep or test
cluster shakedowns.

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
