# PSFN Pi Shard Config Notes

Current as of 2026-07-03, after the Purrsephone k3s migration and admin host-port follow-up.

This is an operator working note, not an authoritative config file. Do not paste secrets or raw Helm values into this document.

## Host Identity

- Host alias: `psfn-pi`
- Hostname: `psfn-shard`
- SSH user: `psfn`
- LAN address: `192.168.1.173`
- Workstation source observed over SSH: `192.168.1.230`
- Tailscale state: installed but logged out / `NeedsLogin`
- Tailscale phone source allowlist: `100.92.198.22/32`

Tailscale caveat: the kube NetworkPolicies already allow the phone source CIDR, but phone access will not work until the Pi is signed into Tailscale. Run `tailscale status` on the Pi for the current login URL; do not store one-time login URLs in repo docs.

## Boot And Desktop State

The Pi is intentionally running headless to save memory.

- Default target: `multi-user.target`
- `lightdm.service`: inactive and disabled
- `k3s.service`: active and enabled
- `ssh.service`: active and enabled
- No `lightdm`, `labwc`, `wf-panel`, `chromium`, `Xorg`, or Wayland desktop processes should remain after the shutdown pass.

Restore desktop later if needed:

```bash
sudo systemctl set-default graphical.target
sudo systemctl enable --now lightdm.service
```

## Storage Layout

The live write-heavy paths are on the NVMe drive.

- Device: `/dev/nvme0n1`
- Model: `CT500P3SSD8`
- Filesystem: ext4
- Label: `PSFN_NVME`
- UUID: `d1f3c5fc-c352-418f-8fbd-bf72d84935a2`
- Mount: `/mnt/psfn-nvme`
- Mount options observed: `rw,noatime`

Important bind mounts:

```text
/home/psfn/psfn-framework-source -> /dev/nvme0n1[/psfn-framework-source]
/var/lib/psfn/runtime           -> /dev/nvme0n1[/psfn-runtime]
/var/lib/postgresql/17/main     -> /dev/nvme0n1[/postgresql-17-main]
/var/log/postgresql             -> /dev/nvme0n1
/home/psfn/psfn-satellite-hub   -> /dev/nvme0n1
/home/psfn/.cache               -> /dev/nvme0n1
/home/psfn/.npm                 -> /dev/nvme0n1
```

Always use `findmnt -T <path>` before debugging storage issues. A directory existing is not proof that it is backed by the NVMe mount.

## Live Kube Runtime

- Runtime: k3s on `psfn-shard`
- Namespace: `psfn`
- Helm release: `psfn`
- Helm chart version: `psfn-0.1.0`
- Current Helm revision: `5`
- Current chart staging dir: `/mnt/psfn-nvme/psfn-kube-runtime/chart-f7acb261`
- Live values file: `/mnt/psfn-nvme/psfn-kube-runtime/values-purrsephone-4dfbc0d9.json`
- App image: `localhost/psfn-framework:0.1.0-kube-4dfbc0d9`
- Companion: `purrsephone` / `Purrsephone`

The live values file is mode `0600` and may contain secrets. Do not print it wholesale.

Runtime staging artifacts currently present:

```text
chart-4dfbc0d9
chart-f7acb261
chart-xafn
psfn-framework-4dfbc0d9-arm64-image.tar
psfn-helm-chart-4dfbc0d9.tgz
psfn-helm-chart-f7acb261.tgz
psfn-helm-chart-xafn.tgz
values-purrsephone-4dfbc0d9.json
```

## Kube Workloads

Expected ready state:

```text
psfn-agent      1/1 Running
psfn-garden     1/1 Running
psfn-gateway    1/1 Running
psfn-litellm    1/1 Running
psfn-postgres-0 1/1 Running
psfn-redis-0    1/1 Running
```

Deployments:

```text
psfn-agent    localhost/psfn-framework:0.1.0-kube-4dfbc0d9
psfn-garden   localhost/psfn-framework:0.1.0-kube-4dfbc0d9
psfn-gateway  localhost/psfn-framework:0.1.0-kube-4dfbc0d9
psfn-litellm  ghcr.io/berriai/litellm:v1.74.9-stable@sha256:f78c763d6f2289305a3acc3a003c6170f797bdda70c56e75776fbab670e663cc
```

StatefulSets:

```text
psfn-postgres  docker.io/pgvector/pgvector:0.8.1-pg17@sha256:3e8b3adfd27b5707128f60956f62a793c3c9326ea8cfaf0eab7adccb5d700b21
psfn-redis     docker.io/library/redis:8.4.0-bookworm@sha256:c22af04bb576503bf16b3e34a1fd2fd82de0f765afd866d2e380145e0af30d78
```

PVCs:

```text
data-psfn-postgres-0  20Gi local-path
data-psfn-redis-0      5Gi local-path
psfn-companion-data   12Gi local-path
psfn-model-cache      10Gi local-path
psfn-runtime          12Gi local-path
psfn-system-data       4Gi local-path
psfn-workspace        12Gi local-path
```

## Network And Admin Access

Cluster services:

```text
psfn-gateway       ClusterIP 10053/TCP
psfn-gateway-rpc   ClusterIP 10054/TCP
psfn-garden        ClusterIP 10054/TCP
psfn-agent-admin   ClusterIP 10055/TCP
psfn-litellm       ClusterIP 4000/TCP
psfn-postgres      ClusterIP 5432/TCP
psfn-redis         ClusterIP 6379/TCP
```

Node-facing host ports are enabled only for Gateway API and Garden:

```yaml
hostPorts:
  gatewayApi:
    enabled: true
    port: 10053
    sourceCIDRs:
      - 192.168.1.230/32
      - 100.92.198.22/32
  garden:
    enabled: true
    port: 10054
    sourceCIDRs:
      - 192.168.1.230/32
      - 100.92.198.22/32
```

Stable LAN endpoints from the workstation:

```text
Garden login: http://192.168.1.173:10054/login
Gateway API:  http://192.168.1.173:10053/v1/models
```

Do not expose broad LAN or Tailscale ranges unless intentionally approved. Keep Gateway RPC, agent admin transport, Postgres, Redis, and LiteLLM cluster-internal.

Note: k3s/CNI hostPort routing may not appear as a normal process listener in `ss -ltnp`. Verify with curls and NetworkPolicy inspection instead of expecting to see `10053` or `10054` in `ss`.

## Host Services

Current host-level service posture:

```text
k3s.service                  active  enabled
ssh.service                  active  enabled
postgresql@17-main.service   active  enabled-runtime
postgresql.service           active  enabled
litellm.service              active  enabled
psfn.service                 inactive disabled
psfn-satellite-hub.service   inactive indirect
psfn-companion-ui.service    inactive indirect
lightdm.service              inactive disabled
```

Host-local listeners observed:

```text
127.0.0.1:4000  host LiteLLM
127.0.0.1:5432  host PostgreSQL
0.0.0.0:22      SSH
```

Do not restart or enable the old `psfn.service` app runtime while kube Purrsephone is live; that risks duplicate Discord logins and runtime state split. The old host Postgres/LiteLLM services still exist separately from kube services, so be explicit about whether a command targets the host or the cluster.

## Backups

Pre-kube backups on the Pi:

```text
/mnt/psfn-nvme/pre-kube-backups/purrsephone-online-pre-kube-20260703T022648Z  3.6G
/mnt/psfn-nvme/pre-kube-backups/purrsephone-frozen-pre-kube-20260703T025842Z  1.4G
```

Copies on this workstation:

```text
/home/ada/psfn-live-backups/purrsephone-online-pre-kube-20260703T022648Z  3.6G
/home/ada/psfn-live-backups/purrsephone-frozen-pre-kube-20260703T025842Z  1.4G
```

Do not remove old SD-backed or pre-kube backup material without explicit operator approval.

## Validation Commands

Run from this repo/workstation:

```bash
ssh psfn-pi 'systemctl get-default; systemctl is-active k3s.service ssh.service lightdm.service || true'
ssh psfn-pi 'sudo -n k3s kubectl -n psfn get pods,deploy,sts,svc,pvc -o wide'
curl -fsS -i --max-time 10 http://192.168.1.173:10054/login | sed -n "1,12p"
```

Gateway API check without printing the API key:

```bash
API_KEY=$(ssh psfn-pi 'sudo -n k3s kubectl -n psfn get secret psfn-app -o jsonpath="{.data.API_KEY}"' | base64 -d)
curl -fsS --max-time 15 -H "Authorization: Bearer ${API_KEY}" http://192.168.1.173:10053/v1/models
unset API_KEY
```

In-cluster checks:

```bash
ssh psfn-pi 'curl -fsS --max-time 10 http://127.0.0.1:10054/health'
ssh psfn-pi 'sudo -n k3s kubectl -n psfn exec sts/psfn-postgres -- psql -U psfn -d psfn -tAc "select extname from pg_extension where extname='\''vector'\'';"'
ssh psfn-pi 'sudo -n k3s kubectl -n psfn exec sts/psfn-redis -- sh -c '\''redis-cli -a "$REDIS_PASSWORD" ping'\'''
```

Expected current smoke results:

```text
Garden health: HTTP 200, adminTransport.status=ok
Gateway models: includes purrsephone
Postgres extension: vector
Redis: PONG
```

NetworkPolicy allowlist check:

```bash
ssh psfn-pi 'sudo -n k3s kubectl -n psfn get networkpolicy psfn-gateway psfn-garden -o yaml | grep -A4 -B2 -E "192\\.168\\.1\\.230|100\\.92\\.198\\.22"'
```

## Rollback And Recovery Notes

Helm rollback:

```bash
ssh psfn-pi 'sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm history psfn -n psfn'
ssh psfn-pi 'sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm rollback psfn <revision> -n psfn --wait --timeout 10m'
```

After any rollback:

```bash
ssh psfn-pi 'sudo -n k3s kubectl -n psfn rollout status deploy/psfn-agent --timeout=300s'
ssh psfn-pi 'sudo -n k3s kubectl -n psfn rollout status deploy/psfn-gateway --timeout=300s'
ssh psfn-pi 'sudo -n k3s kubectl -n psfn rollout status deploy/psfn-garden --timeout=300s'
```

Open follow-up already tracked:

- `psfn-framework-ael8`: validate kube admin endpoints after an approved Pi reboot.
