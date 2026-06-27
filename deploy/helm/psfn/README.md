# PSFN Helm Chart

This chart renders the first PSFN Kubernetes/k3s topology for one companion:

- gateway Deployment and public API Service/Ingress
- agent Deployment and internal mTLS Garden admin transport Service
- Garden Deployment and browser UI Service/Ingress
- bundled Postgres + pgvector StatefulSet, or external Postgres Secret reference
- bundled Redis StatefulSet for app cache, or external Redis Secret reference
- PVC-backed system-data, companion-data, workspace, runtime, and model-cache roots
- cert-manager Issuer/Certificate resources for internal SPIFFE mTLS
- default-deny NetworkPolicies for gateway/agent/garden/Postgres/Redis flows

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
- optional satellite hub -> gateway API

The agent policy does not contain broad `0.0.0.0/0` egress and the chart does
not set `ALLOW_AGENT_OUTBOUND_NETWORK=true`.

## Embeddings

The default owner seed uses local Transformers:

```text
embeddingProvider=transformers
embeddingModel=Xenova/all-MiniLM-L6-v2
embeddingDims=384
model cache=/app/models/transformers
```

The model-cache PVC is mounted at `/app/models/transformers`. Models download
on first use unless you pre-populate the PVC or add a future prefetch job.

API-backed embeddings remain supported by setting owner-file values and the
`EMBEDDING_API_KEY` Secret. The chart does not add a new embedding subsystem.

## Satellite Hub

`satelliteHub.enabled` defaults to `false` because PSFN-Satellite-Hub does not
yet have a pinned Dockerfile in this repo. If enabled, set
`satelliteHub.image.repository`, `satelliteHub.image.tag`, and preferably
`satelliteHub.image.digest`.

## Validation

```bash
helm lint deploy/helm/psfn
helm template psfn deploy/helm/psfn --namespace psfn-test > /tmp/psfn-render.yaml
npm run verify:helm-chart
```

If cert-manager CRDs are not installed, `kubectl apply --dry-run=client` will
report missing mappings for `cert-manager.io/v1` resources. That is a
prerequisite failure, not a template failure.
