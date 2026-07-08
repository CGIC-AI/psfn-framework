# PSFN Kube Cluster Config - 2026-06-28

This is the operator handoff for the temporary PSFN Kubernetes environment on `o_0`.

Raw provider keys and bot tokens are intentionally not copied here. They live in Kubernetes Secrets and can be retrieved with the commands below when needed.

## Access

- SSH host: `o_0@100.96.206.29`
- Hostname: `miniforum01`
- OS: Ubuntu 26.04
- Architecture: `x86_64`
- Kubernetes: k3s `v1.36.2+k3s1`
- Kubeconfig: `/etc/rancher/k3s/k3s.yaml`
- Practical kubectl command on host: `sudo k3s kubectl`

## URLs

- Garden UI: `http://carlinigarden.filthyhabits.live/`
- Garden login: `http://carlinigarden.filthyhabits.live/login`
- Garden health: `http://carlinigarden.filthyhabits.live/health`
- Garden raw-IP login: `http://100.96.206.29/login`
- Garden fallback UI: `http://psfn-garden.100.96.206.29.sslip.io/`
- Gateway API: `http://psfn-gateway.100.96.206.29.sslip.io/`

Ingress is currently plain HTTP through Traefik on external port `80`. Do not use `https://` for these ingress URLs unless TLS ingress is added later. The Garden service listens internally on port `10054`.

Unauthenticated Garden root requests return `401 Unauthorized`; `/health` should return HTTP 200. For browser access, open `/login` and paste the Garden admin token there.

The cluster also has an operator-applied hostless Garden catch-all Ingress named `psfn-garden-catchall`. That is why the raw IP can route to Garden even though the Helm chart's normal Ingress rules are host-based.

## Kubernetes Release

- Namespace: `psfn`
- Helm release: `psfn`
- Helm version on host: `v4.2.2`
- cert-manager chart: Jetstack `v1.20.3`
- StorageClass: `local-path`
- Ingress controller: Traefik from k3s

App image imported into k3s:

```text
localhost/psfn-framework:0.1.0-kube
sha256:64f8ac7da6b04c568c78ad48581a21ffcfe4162f34993d2d44138ca7cfc7444a
```

The image was built on the remote host from tracked source archived from local commit:

```text
2f75be112bf359b1b3b48d02854ba5931c0d960b
```

Remote runtime setup files are under:

```text
/home/o_0/psfn-kube-runtime
```

## Workloads

Expected ready workloads:

```bash
sudo k3s kubectl -n psfn get pods,deploy,sts,pvc,svc,ingress,certificate,networkpolicy
```

Core app components:

- `psfn-agent`
- `psfn-garden`
- `psfn-gateway`
- `psfn-litellm`
- `psfn-postgres`
- `psfn-redis`

PVCs:

- `data-psfn-postgres-0`
- `data-psfn-redis-0`
- `psfn-companion-data`
- `psfn-model-cache`
- `psfn-runtime`
- `psfn-system-data`
- `psfn-workspace`

Certificates:

- `psfn-ca`
- `psfn-agent-admin`
- `psfn-agent-rpc-client`
- `psfn-garden-admin-client`
- `psfn-gateway-rpc`

## Secrets

Secrets are stored in Kubernetes Secrets:

- `psfn-app`
- `psfn-postgres`
- `psfn-redis`

Retrieve the Garden admin token on the host:

```bash
sudo k3s kubectl -n psfn get secret psfn-app \
  -o jsonpath='{.data.ADMIN_TOKEN}' | base64 -d; echo
```

Retrieve the gateway API key on the host:

```bash
sudo k3s kubectl -n psfn get secret psfn-app \
  -o jsonpath='{.data.API_KEY}' | base64 -d; echo
```

Retrieve LiteLLM proxy key on the host:

```bash
sudo k3s kubectl -n psfn get secret psfn-app \
  -o jsonpath='{.data.LITELLM_API_KEY}' | base64 -d; echo
```

Do not copy these values into committed files.

## Model Routing

LiteLLM service:

```text
http://psfn-litellm.psfn.svc:4000/v1
```

Primary local model route:

```text
model: ChatGPTN
api_base: http://192.168.1.43:8000/v1
```

OpenRouter remains behind LiteLLM using `openrouter/*` model routes. The direct OpenRouter provider is disabled in the seeded PSFN provider config so app traffic goes through LiteLLM.

Agent startup validation showed:

- companion: `Carlini`
- persistence backend: PostgreSQL
- SQLite startup checks skipped
- chat model: `ChatGPTN`
- Redis prompt-prefix cache backend active
- scheduled backups enabled with `postgresSource: true`

Vision routing:

- Primary vision route: `openrouter/google/gemini-3.1-flash-lite`
- Secondary vision fallback: `openrouter/openai/gpt-5.4-nano`
- Both routes were smoke-tested through cluster LiteLLM with an image URL and returned non-empty text.

## Image Provider

FAL is configured for the kube gateway through Kubernetes Secret `psfn-app` key `FAL_API_KEY`.

Validation:

```bash
sudo k3s kubectl -n psfn get secret psfn-app \
  -o jsonpath='{.data.FAL_API_KEY}' | base64 -d | wc -c
sudo k3s kubectl -n psfn exec deploy/psfn-gateway -- sh -lc \
  'echo FAL_API_KEY_length=${#FAL_API_KEY}'
```

Expected result: `69`.

Image edit model defaults are not settings-owned yet. Follow-up bead: `psfn-framework-f170` adds canonical image provider/model defaults so Grok Imagine Edit can be configured instead of hard-coded or only prompt-guided.

## Smoke Checks

Garden health through ingress:

```bash
curl -i http://psfn-garden.100.96.206.29.sslip.io/health
```

Expected result: HTTP 200 with `status: "ok"`.

Custom Garden health:

```bash
curl -i http://carlinigarden.filthyhabits.live/health
```

Expected result: HTTP 200 with `status: "ok"`.

Garden root without auth:

```bash
curl -i http://psfn-garden.100.96.206.29.sslip.io/
```

Expected result before login/auth: HTTP 401.

Garden login flow:

```bash
TOKEN="$(sudo k3s kubectl -n psfn get secret psfn-app \
  -o jsonpath='{.data.ADMIN_TOKEN}' | base64 -d)"
curl -i -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "token=$TOKEN" \
  http://carlinigarden.filthyhabits.live/login
```

Expected result for a valid token: HTTP 302 redirecting back to `/`.

Gateway models from inside the gateway pod:

```bash
sudo k3s kubectl -n psfn exec deploy/psfn-gateway -- node --input-type=module -e '
const res = await fetch("http://127.0.0.1:10053/v1/models", {
  headers: { authorization: "Bearer " + process.env.API_KEY }
});
console.log(res.status, await res.text());
'
```

Real chat smoke from inside the gateway pod:

```bash
sudo k3s kubectl -n psfn exec deploy/psfn-gateway -- node --input-type=module -e '
const res = await fetch("http://127.0.0.1:10053/v1/chat/completions", {
  method: "POST",
  headers: {
    authorization: "Bearer " + process.env.API_KEY,
    "content-type": "application/json"
  },
  body: JSON.stringify({
    model: "carlini",
    messages: [{ role: "user", content: "Say one short hello as Carlini." }],
    max_tokens: 80
  })
});
console.log(res.status, await res.text());
'
```

This returned HTTP 200 during setup.

Postgres pgvector check:

```bash
sudo k3s kubectl -n psfn exec sts/psfn-postgres -- psql \
  -U psfn -d psfn -tAc "select extname from pg_extension where extname='vector';"
```

Expected result:

```text
vector
```

Redis ping:

```bash
sudo k3s kubectl -n psfn exec sts/psfn-redis -- sh -lc \
  'redis-cli -a "$REDIS_PASSWORD" ping'
```

Expected result:

```text
PONG
```

## Known Setup Notes

- Remote GitHub clone was unavailable without credentials, so tracked source was archived locally and copied to the host. Large image/dependency downloads happened on the remote host.
- A phase-zero Helm install was interrupted and left the release `pending-install`; this was corrected by fixing Helm release secret status and running `helm upgrade`.
- `local-path` PVC provisioning initially stalled while pulling `rancher/mirrored-library-busybox:1.37.0`; pulling that exact image into k3s containerd allowed PVCs to bind.
- The first Hugging Face model download failed because model prefetch egress was blocked by NetworkPolicy. `psfn-model-prefetch-egress` now allows DNS and TCP/443 for model prefetch pods.
- A partial ONNX cache from the failed download caused a protobuf parse error. The partial `SamLowe` cache was removed and prefetch rerun successfully.
