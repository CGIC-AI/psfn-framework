# Carlini Kube Upgrade Runbook - 55be96f8

Date: 2026-07-02
Bead: `psfn-framework-mkg2`
Source branch: `origin/foundation_e0_e2`
Source commit: `55be96f8`
Image tag: `localhost/psfn-framework:0.1.0-kube-55be96f8`

This records the Carlini Kubernetes upgrade path used on `miniforum01`
(`o_0@100.96.206.29`) so the same shape can be reused for Purrsephone later.
Do not store SSH passwords, API keys, admin tokens, Helm values contents, or
provider credentials in this document.

## Critical Scheduler Migration

This major update removes the old `scheduler.json` `sleeptime` cadence key.
Before restarting a live deployment on this build, migrate the live
`scheduler.json` owner file in the system-data PVC:

- Remove `sleeptime` if present.
- Add `nearTurnMemory`.
- Add `episodeSynthesis`.
- Add `sleepConsolidation`.
- Add `orientationRewrite`.
- Add `wikiPass`.
- Add `arcFormation`.
- Add `socialGraphBuilder`.
- Add `temporalWakeup`.
- Add `freeTime`.
- Add `weightedThoughtOutreach`.

Use the exact `config/scheduler.seed.json` from the target commit as the source
for missing block shapes. Preserve existing deployment-specific values. Leave
the optional flips conservative unless the operator explicitly chooses them:

- `episodeSynthesis.topicSegmentationEnabled`: keep `false`.
- `temporalWakeup.morningWake.timing`: keep `fixed`.
- `settings.json wikiRetrievalEnabled`: keep current value.
- `scheduler.json weightedThoughtOutreach.enabled`: keep `false`.
- `freeTime`: seed defaults are acceptable, tune later.
- Fatigue room enablement requires `channels.json.discord.allowedBotUserIds`
  plus `charge-policy.json` fatigue tuning; do not enable implicitly.

Validation shape:

```bash
sudo k3s kubectl -n psfn exec deploy/psfn-agent -- node -e '
const fs = require("fs");
const p = "/app/system-data/scheduler.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
console.log(JSON.stringify({
  hasSleeptime: Object.hasOwn(j, "sleeptime"),
  hasNearTurnMemory: Object.hasOwn(j, "nearTurnMemory"),
  hasEpisodeSynthesis: Object.hasOwn(j, "episodeSynthesis"),
  hasSleepConsolidation: Object.hasOwn(j, "sleepConsolidation"),
  hasArcFormation: Object.hasOwn(j, "arcFormation"),
  topicSegmentationEnabled: j.episodeSynthesis?.topicSegmentationEnabled,
  morningWakeTiming: j.temporalWakeup?.morningWake?.timing,
  weightedThoughtOutreachEnabled: j.weightedThoughtOutreach?.enabled
}, null, 2));
'
```

Expected for the conservative migration:

```json
{
  "hasSleeptime": false,
  "hasNearTurnMemory": true,
  "hasEpisodeSynthesis": true,
  "hasSleepConsolidation": true,
  "hasArcFormation": true,
  "topicSegmentationEnabled": false,
  "morningWakeTiming": "fixed",
  "weightedThoughtOutreachEnabled": false
}
```

## Build And Deploy Sequence

Local preflight:

```bash
bd prime
git fetch origin --prune
git status --short --branch
git rev-parse --short=8 HEAD
git rev-parse --short=8 origin/foundation_e0_e2
npm run verify:helm-chart
```

Build and local shakedown:

```bash
SHORT=55be96f8
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=${SHORT}" \
  -f docker/Dockerfile.agent \
  -t "localhost/psfn-framework:0.1.0-kube-${SHORT}" \
  -t localhost/psfn-framework:0.1.0-kube .

docker image inspect "localhost/psfn-framework:0.1.0-kube-${SHORT}" \
  --format 'revision={{index .Config.Labels "org.opencontainers.image.revision"}} id={{.Id}}'
```

Archive and copy clean source to the live kube host:

```bash
SHORT=55be96f8
git archive --format=tar.gz -o "/tmp/psfn-framework-${SHORT}.tar.gz" HEAD
sha256sum "/tmp/psfn-framework-${SHORT}.tar.gz"
scp "/tmp/psfn-framework-${SHORT}.tar.gz" o_0@100.96.206.29:/home/o_0/psfn-kube-runtime/
scp config/scheduler.seed.json o_0@100.96.206.29:/home/o_0/psfn-kube-runtime/scheduler.seed.${SHORT}.json
```

On the remote, build from the archive, not from `/home/o_0/psfn`:

```bash
SHORT=55be96f8
cd /home/o_0/psfn-kube-runtime
sha256sum "psfn-framework-${SHORT}.tar.gz"
test ! -e "source-${SHORT}" || echo "source-${SHORT} already exists"
mkdir -p "source-${SHORT}"
tar -xzf "psfn-framework-${SHORT}.tar.gz" -C "source-${SHORT}"
cd "source-${SHORT}"
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=${SHORT}" \
  -f docker/Dockerfile.agent \
  -t "localhost/psfn-framework:0.1.0-kube-${SHORT}" \
  -t localhost/psfn-framework:0.1.0-kube .
```

Import into k3s and upgrade Helm:

```bash
SHORT=55be96f8
docker image inspect "localhost/psfn-framework:0.1.0-kube-${SHORT}" \
  --format 'id={{.Id}} revision={{index .Config.Labels "org.opencontainers.image.revision"}} size={{.Size}}'
docker save "localhost/psfn-framework:0.1.0-kube-${SHORT}" \
  -o "/home/o_0/psfn-kube-runtime/psfn-framework-${SHORT}-image.tar"
sudo k3s ctr images import "/home/o_0/psfn-kube-runtime/psfn-framework-${SHORT}-image.tar"

sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm get values psfn -n psfn -o yaml \
  > "/home/o_0/psfn-kube-runtime/values-live-${SHORT}.yaml"
chmod 600 "/home/o_0/psfn-kube-runtime/values-live-${SHORT}.yaml"

sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm upgrade --install psfn \
  "/home/o_0/psfn-kube-runtime/source-${SHORT}/deploy/helm/psfn" \
  --namespace psfn \
  -f "/home/o_0/psfn-kube-runtime/values-live-${SHORT}.yaml" \
  --set psfnAppImage.repository=localhost/psfn-framework \
  --set "psfnAppImage.tag=0.1.0-kube-${SHORT}" \
  --set-string psfnAppImage.digest= \
  --set psfnAppImage.pullPolicy=IfNotPresent
```

## Pass Criteria

```bash
sudo k3s kubectl -n psfn rollout status deploy/psfn-agent --timeout=300s
sudo k3s kubectl -n psfn rollout status deploy/psfn-gateway --timeout=300s
sudo k3s kubectl -n psfn rollout status deploy/psfn-garden --timeout=300s

curl -fsS -i http://127.0.0.1/health | sed -n "1,12p"
sudo k3s kubectl -n psfn exec deploy/psfn-garden -- node --input-type=module -e 'const res = await fetch("http://127.0.0.1:10054/health"); console.log(res.status, await res.text());'
sudo k3s kubectl -n psfn exec deploy/psfn-gateway -- node --input-type=module -e 'const res = await fetch("http://127.0.0.1:10053/v1/models", { headers: { authorization: "Bearer " + process.env.API_KEY } }); console.log(res.status, await res.text());'
sudo k3s kubectl -n psfn exec sts/psfn-postgres -- psql -U psfn -d psfn -tAc "select extname from pg_extension where extname='vector';"
sudo k3s kubectl -n psfn exec sts/psfn-redis -- sh -lc 'redis-cli -a "$REDIS_PASSWORD" ping'
sudo k3s kubectl -n psfn logs deploy/psfn-agent --tail=260
sudo k3s kubectl -n psfn get deploy psfn-agent psfn-gateway psfn-garden \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.template.spec.containers[0].image}{" ready="}{.status.readyReplicas}{"/"}{.status.replicas}{"\n"}{end}'
docker image inspect "localhost/psfn-framework:0.1.0-kube-55be96f8" \
  --format 'revision={{index .Config.Labels "org.opencontainers.image.revision"}} id={{.Id}}'
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm history psfn -n psfn --max 4
```

Carlini result on 2026-07-02:

- Helm revision: `15`, `deployed`.
- Agent, Gateway, and Garden all reference `localhost/psfn-framework:0.1.0-kube-55be96f8`.
- Deployments are `1/1`.
- Garden health is `200` with `adminTransport.status=ok`.
- Gateway `/v1/models` returns `carlini`.
- Postgres returns `vector`.
- Redis returns `PONG`.
- Agent logs show `Loaded character: Carlini`, `Ready`, and `ToolWiringValidator` with `toolCount=22`.
- Image label reports `org.opencontainers.image.revision=55be96f8`.
- No rollback was needed.

The new agent pod showed one restart during the rolling handoff because the
gateway pod restarted underneath the first agent process. The replacement pod
connected, became ready, and stayed running.

## Rollback

If the new agent crashloops or Carlini health degrades:

```bash
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm history psfn -n psfn
sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm rollback psfn <previous-good-revision> -n psfn
sudo k3s kubectl -n psfn rollout status deploy/psfn-agent --timeout=300s
sudo k3s kubectl -n psfn rollout status deploy/psfn-gateway --timeout=300s
sudo k3s kubectl -n psfn rollout status deploy/psfn-garden --timeout=300s
```

For this upgrade, previous good revision was `14`.

## Purrsephone Follow-Up Notes

Before upgrading Purrsephone to this line:

- Identify the live host and runtime namespace first; do not assume Carlini's
  host, namespace, values file, or companion identity.
- Migrate that deployment's live `scheduler.json` before any restart, using the
  same required block list and conservative optional settings above.
- Preserve live Helm values without printing them.
- Verify `/v1/models` returns the expected Purrsephone model id, not `companion`
  or `carlini`.
- Keep Purrsephone-specific identity, companion-data, workspace, Postgres, Redis,
  and model-cache PVCs intact.
- Only enable the optional topic segmentation, habit wake, wiki retrieval,
  weighted outreach, free-time tuning, or fatigue room behavior after an explicit
  operator decision.
