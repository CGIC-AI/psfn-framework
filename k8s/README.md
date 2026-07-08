# PSFN Kubernetes Deployment

Kubernetes manifests for deploying the PSFN companion runtime with LiteLLM gateway, Text Embeddings Inference, and optional PostgreSQL.

## Architecture

```
┌─────────────────────────────────────────┐
│  psfn pod (Deployment)                  │
│  ┌────────────┐  ┌───────────────────┐  │
│  │  gateway    │←→│  agent            │  │
│  │  (secrets,  │  │  (companion logic,│  │
│  │   LLM proxy,│  │   memory, tools,  │  │
│  │   channels) │  │   API :3000,      │  │
│  │             │  │   admin :3001)    │  │
│  └─────┬──────┘  └───────────────────┘  │
│        │  Unix socket (emptyDir)        │
└────────┼────────────────────────────────┘
         │
    ┌────┴──────┐     ┌───────────┐     ┌──────────┐
    │  litellm  │     │  tei      │     │ postgres │
    │  :4000    │     │  :8090    │     │ :5432    │
    │  (LLM     │     │  (embed-  │     │ (pgvector│
    │   gateway)│     │   dings)  │     │  + data) │
    └───────────┘     └───────────┘     └──────────┘
```

**psfn pod** runs gateway + agent as sidecars sharing a Unix socket via `emptyDir` volume. The gateway holds all secrets and proxies external calls. The agent serves the OpenAI-compatible API on port 3000 and the Garden admin UI on port 3001.

**litellm** is a lightweight LLM gateway (no GPU) that routes model requests to upstream providers (OpenRouter, etc.) with credential isolation.

**tei** (Text Embeddings Inference) runs a local embedding model on CPU. The agent calls it via the `EMBEDDING_PROVIDER=api` interface.

**postgres** is the default in-cluster database with pgvector for vector similarity search. It can be replaced with an external managed database by setting `POSTGRES_DATABASE_URL`.

## Quick Start

```bash
# Dev (relaxed security, debug logging)
kubectl kustomize k8s/overlays/dev | kubectl apply -f -

# Production
kubectl kustomize k8s/overlays/production | kubectl apply -f -
```

## Building Container Images

Both Dockerfiles use multi-stage builds: they compile TypeScript via tsup, build the Garden admin UI (Svelte), then produce a minimal production image.

```bash
# From the repo root:
docker build -f docker/Dockerfile.gateway -t psfn-gateway:0.1.0 .
docker build -f docker/Dockerfile.agent -t psfn-agent:0.1.0 .
```

The build stages run `npm ci`, `npm run build` (tsup), and for the agent image also `npm --prefix admin-ui run build` (Garden). The production stage copies only `dist/`, `admin-ui/build/`, and production `node_modules`.

To push to a registry:

```bash
docker tag psfn-gateway:0.1.0 registry.example.com/psfn-gateway:0.1.0
docker tag psfn-agent:0.1.0 registry.example.com/psfn-agent:0.1.0
docker push registry.example.com/psfn-gateway:0.1.0
docker push registry.example.com/psfn-agent:0.1.0
```

Then update the image refs in `k8s/base/psfn-deployment.yaml`.

## File Structure

```
k8s/
├── base/
│   ├── kustomization.yaml          # Wires all base resources
│   ├── namespace.yaml              # psfn namespace
│   ├── rbac.yaml                   # ServiceAccount
│   ├── configmap.yaml              # PSFN runtime configuration
│   ├── secrets.yaml                # API keys, tokens
│   ├── pvc.yaml                    # Persistent storage claims
│   ├── psfn-deployment.yaml        # Gateway + Agent sidecar pod
│   ├── lightllm-deployment.yaml    # LiteLLM gateway proxy
│   ├── lightllm-config.yaml        # LiteLLM model routing + secrets
│   ├── tei-deployment.yaml         # Text Embeddings Inference
│   ├── tei-config.yaml             # TEI model selection
│   ├── postgres-statefulset.yaml   # PostgreSQL + pgvector
│   ├── services.yaml               # ClusterIP services for all components
│   └── networkpolicy.yaml          # Egress/ingress isolation
├── overlays/
│   ├── dev/
│   │   └── kustomization.yaml      # Debug logging, relaxed auth, smaller resources
│   └── production/
│       ├── kustomization.yaml       # Postgres enabled, tighter resources
│       └── external-postgres.yaml   # ExternalName service for managed DB
└── README.md
```

## Configuration Reference

### PSFN Config (`configmap.yaml`)

| Key | Default | Description |
|-----|---------|-------------|
| `PSFN_RUNTIME_MODE` | `split` | Runtime mode (always `split` in k8s) |
| `PSFN_RUNTIME_LAYOUT_MODE` | `production` | Data directory layout |
| `GATEWAY_SOCKET` | `/run/psfn/gateway.sock` | Unix socket path (shared via emptyDir) |
| `API_PORT` | `3000` | OpenAI-compatible API port |
| `API_HOST` | `0.0.0.0` | API bind address |
| `ADMIN_PORT` | `3001` | Garden admin UI port |
| `ADMIN_HOST` | `0.0.0.0` | Admin bind address |
| `ALLOW_INSECURE_LOCAL_API` | `false` | Skip API key auth on loopback |
| `PERSISTENCE_BACKEND` | `postgres` | Runtime persistence backend |
| `EMBEDDING_PROVIDER` | `api` | Embedding backend: `api`, `ollama`, or `transformers` |
| `EMBEDDING_API_URL` | `http://tei:8090/v1/embeddings` | TEI endpoint |
| `EMBEDDING_API_MODEL` | `BAAI/bge-large-en-v1.5` | Embedding model name |
| `EMBEDDING_DIMS` | `1024` | Embedding vector dimensions |
| `LITELLM_BASE_URL` | `http://litellm:4000/v1` | LiteLLM gateway endpoint |
| `LOG_LEVEL` | `info` | Logging level |

### PSFN Secrets (`secrets.yaml`)

| Key | Required | Description |
|-----|----------|-------------|
| `API_KEY` | No | API authentication key |
| `ADMIN_TOKEN` | No | Garden admin UI token |
| `OPENROUTER_API_KEY` | No | Direct provider key (when not using LiteLLM) |
| `POSTGRES_DATABASE_URL` | Yes | Postgres connection string |
| `DISCORD_TOKEN` | No | Discord bot token |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `HF_TOKEN` | No | HuggingFace token for gated models |

### LiteLLM Config (`lightllm-config.yaml`)

The `litellm_config.yaml` data key contains the full LiteLLM routing configuration in YAML format. Edit the `model_list` to add providers and models. Secrets are referenced as `os.environ/KEY_NAME` and resolved from `litellm-secrets`.

| Secret Key | Description |
|------------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter provider API key |
| `LITELLM_MASTER_KEY` | LiteLLM virtual key for client auth |

### TEI Config (`tei-config.yaml`)

| Key | Default | Description |
|-----|---------|-------------|
| `TEI_MODEL_ID` | `BAAI/bge-large-en-v1.5` | HuggingFace model ID to serve |
| `TEI_MAX_BATCH_TOKENS` | `16384` | Maximum tokens per batch |
| `TEI_MAX_CLIENT_BATCH_SIZE` | `32` | Maximum texts per request |

### PostgreSQL Credentials (`postgres-statefulset.yaml`)

| Key | Default | Description |
|-----|---------|-------------|
| `POSTGRES_USER` | `psfn` | Database user |
| `POSTGRES_PASSWORD` | `changeme` | Database password (change in production) |

## Using an External Database

To point at an external managed PostgreSQL (RDS, Cloud SQL, Neon, Supabase, etc.) instead of the in-cluster StatefulSet:

1. Set the connection string in `secrets.yaml`:
   ```yaml
   stringData:
     POSTGRES_DATABASE_URL: "postgresql://user:password@your-rds-host.amazonaws.com:5432/psfn"
   ```

2. Edit `k8s/overlays/production/kustomization.yaml` — uncomment the `patchesStrategicMerge` section and the StatefulSet delete patch to remove the in-cluster Postgres.

3. Set `externalName` in `k8s/overlays/production/external-postgres.yaml` to your database hostname so the `postgres` service DNS resolves to the external host:
   ```yaml
   spec:
     externalName: your-rds-host.amazonaws.com
   ```

4. Ensure your external database has the `vector` and `pg_trgm` extensions installed. Migrations run automatically on startup.

## Changing the Embedding Model

1. Update `TEI_MODEL_ID` in `k8s/base/tei-config.yaml` to the HuggingFace model ID.
2. Update `EMBEDDING_API_MODEL` and `EMBEDDING_DIMS` in `k8s/base/configmap.yaml` to match the new model's output dimensions.
3. If the model is gated, set `HF_TOKEN` in `secrets.yaml`.

Common embedding models:

| Model | Dims | Size | Notes |
|-------|------|------|-------|
| `BAAI/bge-large-en-v1.5` | 1024 | 1.3 GB | High quality, English |
| `BAAI/bge-base-en-v1.5` | 768 | 440 MB | Balanced |
| `BAAI/bge-small-en-v1.5` | 384 | 130 MB | Fast, lightweight |
| `sentence-transformers/all-MiniLM-L6-v2` | 384 | 90 MB | Very fast, good quality |

## Changing the LLM Provider

Edit the `litellm_config.yaml` key in `k8s/base/lightllm-config.yaml`. The format follows LiteLLM's model routing syntax:

```yaml
model_list:
  - model_name: anthropic/claude-sonnet-4-20250514
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: openai/gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
```

Add the corresponding API keys to `litellm-secrets` in `lightllm-config.yaml`.

## Scaling

The PSFN deployment uses `Recreate` strategy (not rolling) because the companion has persistent state and only one instance should run at a time.

LiteLLM can scale horizontally:
```yaml
# In an overlay:
- target:
    kind: Deployment
    name: litellm
  patch: |
    - op: replace
      path: /spec/replicas
      value: 3
```

TEI can also scale independently for embedding throughput.

## Network Policies

The manifests include NetworkPolicies that enforce:
- **psfn pod**: can only reach litellm (:4000), tei (:8090), postgres (:5432), and DNS
- **litellm**: accepts ingress only from psfn; egress only to HTTPS (:443) and DNS
- **tei**: accepts ingress only from psfn; no egress
- **postgres**: accepts ingress only from psfn; no egress

## Resource Tuning

Default resource requests/limits per overlay:

| Component | Dev | Production |
|-----------|-----|------------|
| Gateway | 256Mi / 1Gi | 512Mi / 2Gi |
| Agent | 512Mi / 2Gi | 1Gi / 4Gi |
| LiteLLM | 256Mi / 512Mi | 256Mi / 512Mi |
| TEI | 2Gi / 4Gi | 2Gi / 4Gi |
| PostgreSQL | 512Mi / 2Gi | 512Mi / 2Gi |

Adjust via Kustomize patches in your overlay.
