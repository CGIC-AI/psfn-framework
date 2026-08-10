# Satellite Hub On k3s (Pi Runbook)

This is the reproducible procedure for running the in-repo Satellite Hub
application inside the live single-node k3s cluster (helm release `psfn`,
namespace `psfn`, arm64), wired to the in-cluster gateway `/v1` edge with a
dedicated satellite-scoped credential, the companion event relay bridge, and a
cert-manager-managed client certificate staged for the satellite mTLS path.

Chart reference: [`deploy/helm/psfn/README.md`](../deploy/helm/psfn/README.md)
(section "Satellite Hub"). Public overlay template:
[`deploy/helm/psfn/overlays/pi-satellite-hub.values.yaml`](../deploy/helm/psfn/overlays/pi-satellite-hub.values.yaml).

Before deployment, copy that template to the ignored
`deploy/helm/psfn/overlays/pi-satellite-hub.local.values.yaml` and populate
the local copy with the deployment's private addresses, CIDRs, credential
digests, and device registry. The commands below refer to that ignored file.

## Topology And Design Decisions

- **Exposure: hostPort, matching the gateway.** LAN satellite devices and
  browsers dial `ws://<pi>:8787` directly. The gateway already exposes its
  `/v1` edge as hostPort 10053 on the node; the hub follows the same
  single-node mechanism (`hostPorts.satelliteHub`) instead of the Traefik
  ingress host (`psfn-hub.local` stays disabled — LAN devices have no name
  resolution for it). The hub Deployment uses a Recreate strategy so hostPort
  rollouts cannot deadlock on a single node.
- **Auth now: dedicated satellite-scoped bearer key.** The hub authenticates
  with `secrets.values.satelliteHubApiKey`, which the chart injects into the
  hub as `PSFN_API_KEY` and into the gateway inside `API_SATELLITE_KEYS`.
  Every satellite key yields a distinct satellite-scoped principal id
  (`api-key-<sha256(key)[:24]>`, Sprint-10 H4) that is only admitted by
  `satellites.json` endpoints explicitly listing it in
  `auth.apiKeyPrincipalIds`, is confined to satellite surfaces, and cannot
  claim other endpoints. The shared operator `API_KEY` is never handed to the
  hub.
- **mTLS: staged, not yet the runtime auth path.** See
  [Why not full mTLS yet](#why-not-full-mtls-yet-and-the-upgrade-path). A
  cert-manager client Certificate for the hub is issued and auto-renewed NOW
  so the flip is a configuration change, not an infrastructure change.
- **Certificate ownership: kube cert-manager, not the PSFN cert-manager
  sidecar.** The chart already owns every in-cluster workload identity
  (gateway RPC, agent RPC client, agent admin, Garden client) through the same
  cert-manager CA/Issuer that is live in the cluster (`psfn-ca` READY, backed
  by `psfn-selfsigned`). Adding the hub as one more Certificate keeps a single
  CA custody chain, automated renewal, and kubelet secret propagation. The
  PSFN cert-manager sidecar (`src/app/cert-manager/`,
  [`docs/certificates.md`](./certificates.md)) remains the issuer for
  NON-cluster LAN satellites (standalone Pi endpoints etc.), where no
  cert-manager exists; running it for in-cluster identities would split CA
  custody across two roots for no gain.

## Prerequisites

- Live cluster with the `psfn` release healthy (gateway/agent/garden green).
- cert-manager installed with Issuers `psfn-ca` and `psfn-selfsigned` READY in
  namespace `psfn` (already true on the live cluster; the chart renders them).
- A clean PSFN monorepo checkout whose `apps/satellite-hub` history includes:
  - `HUB_TEXT_ONLY` text-only mode (hub commit `2b8d234`),
  - the companion backplane bridge (`PSFN_COMPANION_BASE_URL` wiring, hub
    commits `2c9816e`/`9999af5`, merge `f84fcda`).
- Docker with buildx/QEMU able to build `linux/arm64` images.

## 1. Build The arm64 Image

From the monorepo root:

```bash
SATELLITE_HUB_MONOREPO_REF="$(git rev-parse HEAD)" \
SATELLITE_HUB_IMAGE_REPOSITORY=localhost/psfn-satellite-hub \
SATELLITE_HUB_PLATFORM=linux/arm64 \
docker/satellite-hub/build-image.sh
```

The script fails closed on dirty Hub image inputs, a monorepo ref mismatch, or
a floating tag, and prints the produced reference, e.g.
`localhost/psfn-satellite-hub:0.1.0-kube-<sha12>`.

## 2. Transfer And Import Into k3s (Retag Trap)

```bash
docker save localhost/psfn-satellite-hub:0.1.0-kube-<sha12> | gzip > /tmp/psfn-hub.tar.gz
scp /tmp/psfn-hub.tar.gz <pi>:/tmp/
ssh <pi> 'zcat /tmp/psfn-hub.tar.gz | sudo k3s ctr images import -'
```

**Trap:** containerd normalizes unqualified image names. Verify the imported
name matches what the chart references EXACTLY:

```bash
ssh <pi> 'sudo k3s ctr images ls | grep psfn-satellite-hub'
```

If the image shows up as `docker.io/library/psfn-satellite-hub:...` (this
happens when the tag was built without the `localhost/` registry prefix),
retag it — the chart's `localhost/psfn-satellite-hub` reference will otherwise
never resolve and the pod sticks in `ErrImagePull`:

```bash
ssh <pi> 'sudo k3s ctr images tag \
  docker.io/library/psfn-satellite-hub:0.1.0-kube-<sha12> \
  localhost/psfn-satellite-hub:0.1.0-kube-<sha12>'
```

**Do NOT set `satelliteHub.image.digest` for tar-imported images.** The chart
renders `repo:tag@digest`, and a `ctr images import`ed image is only known to
containerd by its `repo:tag` name — kubelet treats the digest reference as
needing a registry pull from the (nonexistent) `localhost` registry and the
pod sticks in `ErrImagePull`/`ImagePullBackOff` (hit live 2026-07-10, helm
rev 34). Digest pinning is for images served from a real registry. With tar
imports, the commit-tied tag is the pin; leave `digest: ""`. The same applies
to `companionUiTest.image.digest`.

## 3. Generate The Hub Credential And Principal Id

```bash
HUB_KEY=$(openssl rand -hex 24)
node -e 'const {createHash} = require("node:crypto");
const key = process.argv[1].trim();
console.log("api-key-" + createHash("sha256").update(key).digest("hex").slice(0, 24));' "$HUB_KEY"
```

The printed `api-key-...` value is the principal id `satellites.json` must
list. Keep `$HUB_KEY` out of the repo and out of the overlay file; it is
supplied at `helm upgrade` time (or through `secrets.existingSecret`).

## 4. Register The Hub In satellites.json

`satellites.json` is a system-data owner file
(`src/shared/contracts/satellite-registry.ts`); on the live cluster it lives
in the `system-data` PVC root. Add a satellite + endpoint entry for the hub
(neutral ids shown; align with `satelliteHub.identity.*` in the overlay). The
companion relay scopes (`approvals`, `artifacts`, `tool_activity`, and
`emotion`, deny-by-default per w9hj.1 / 7ang.1) are what authorize the hub's
companion bridge SSE stream, artifact previews, approval decisions, and
redacted emotion snapshots. The `emotion` scope is what gates the redacted
`emotion.snapshot` frames (rounded VAD/mood, top-K discrete labels, confidence,
and ACAC axis scores only — never rationale text, concerns, or salient
entities); an endpoint without it receives zero emotion frames:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "satellites": [
    {
      "satelliteId": "hub-pi",
      "displayName": "Satellite Hub (k3s)",
      "mobility": "static",
      "endpoints": [
        {
          "endpointId": "hub-pi-main",
          "displayName": "Hub main endpoint",
          "claimTypes": ["text-only", "voice-only"],
          "promptChannelType": "satellite-hub",
          "auth": {
            "mode": "api_key",
            "apiKeyPrincipalIds": ["api-key-<sha256(HUB_KEY)[:24]>"]
          },
          "defaultIdentity": {
            "authorId": "operator",
            "authorName": "Operator",
            "canonicalContactId": "operator",
            "channelPrivacy": "private"
          },
          "maxCapabilities": [
            "text",
            "audio_input",
            "speech_to_text",
            "audio_output",
            "text_to_speech",
            "presence",
            "telemetry",
            "touch"
          ],
          "telemetryScopes": [
            "presence",
            "status",
            "approvals",
            "artifacts",
            "tool_activity",
            "emotion"
          ]
        }
      ]
    }
  ]
}
```

Notes:

- `fleet-auth` device turns additionally require a server-owned
  `hubDeviceEnrollment` on the exact device-facing endpoint, for example
  `{"deviceId":"office-device","enrollmentVersion":7,"enrollmentStatus":"active"}`.
  Register a distinct endpoint for each enrolled device relayed by the Hub.
  The gateway derives the assertion's device/version/status, companion,
  session, and place expectations from authenticated endpoint/session routing
  plus this registry entry; request body or browser identity fields never
  override them. Setting `enrollmentStatus` to `revoked` denies new turns.
- `claimTypes` must include the overlay's `satelliteHub.identity.claimType`
  (`text-only` for the initial text-only ship; keep `voice-only` listed so the
  voice flip is registry-compatible).
- `maxCapabilities` must include `touch` for `POST /v1/companion/stimuli`;
  each browser device that sends `touch.interaction` must also have `touch` in
  its Hub device-registry `maxCapabilities.control` list.
- The endpoint admits ONLY the listed principal; rotating the hub key means
  updating both the Secret (helm upgrade) and this list, then restarting the
  gateway (it reads `API_SATELLITE_KEYS` at startup).
- The registry is read by the gateway at startup: after editing, restart the
  gateway pod (`kubectl -n psfn rollout restart deploy/psfn-gateway`) and check
  the log for satellite registry validation errors (fail-closed on any typo).

## 5. Deploy With The Overlay

Never use `--reuse-values` with a changed chart — always re-supply the full
values stack:

```bash
helm upgrade psfn deploy/helm/psfn \
  --namespace psfn \
  -f <live-base-values>.yaml \
  -f deploy/helm/psfn/overlays/pi-satellite-hub.local.values.yaml \
  --set satelliteHub.image.tag=0.1.0-kube-<sha12> \
  --set-string satelliteHub.image.digest=<sha256:... from ctr images ls> \
  --set-string secrets.values.satelliteHubApiKey="$HUB_KEY"

kubectl -n psfn rollout status deploy/psfn-satellite-hub
kubectl -n psfn rollout status deploy/psfn-gateway   # picks up API_SATELLITE_KEYS
```

The overlay ships text-only (`satelliteHub.textOnly=true`,
`HUB_TEXT_ONLY=true`): Deepgram/ElevenLabs secrets and the voice id are
optional and the hub serves text turns plus the companion bridge only.

### Voice mode

Set in the overlay (or a later upgrade):

```yaml
satelliteHub:
  textOnly: false
  identity:
    claimType: voice-only
  capabilityProfile: voice-only
  elevenLabsVoiceId: <voice-id>
```

and supply `secrets.values.deepgramApiKey` + `secrets.values.elevenLabsApiKey`
(render fails closed without them when `secrets.allowMissingRequired=false`;
the pod fails closed at startup either way because the env refs become
mandatory).

## 6. Certificates: Issuance And Renewal

Enabling the hub renders Certificate `psfn-satellite-hub-client` from the same
CA/Issuer as the runtime's internal mTLS, with SPIFFE URI SAN
`spiffe://cluster.local/psfn/satellite-hub/<companionId>`:

```bash
kubectl -n psfn get certificate psfn-satellite-hub-client   # READY=True
kubectl -n psfn get secret psfn-satellite-hub-client-tls
```

- **Renewal** is automatic: cert-manager reissues at `renewBefore` (chart
  default 360h before the 2160h expiry) and updates the Secret; kubelet
  propagates the mounted files (`/run/psfn/tls/psfn-client/{ca.crt,tls.crt,tls.key}`)
  into the running hub pod within ~1 minute.
- **Hub pickup of renewed certs:** the hub reads the cert/key files per
  request (`postChatCompletionWithClientCertificate` does `readFileSync` at
  call time), so once mTLS client auth is enabled hub-side, renewed
  certificates are picked up WITHOUT a pod restart.
- **Key rotation caveat:** cert-manager rotates the private key on renewal,
  so `clientCertFingerprintSha256`/`clientCertSpkiSha256` pins in
  `satellites.json` would break every renewal. Bind the SPIFFE URI SAN
  (`clientCertSan`) instead — it is stable across renewals and is validated
  against the CA chain (`API_TLS_CLIENT_CA_PATH`).

Today the certificate is mounted but not used for authentication (bearer key
is the runtime path). It exists now so issuance/renewal is proven on the live
cluster before the mTLS flip.

## Why Not Full mTLS Yet, And The Upgrade Path

Satellite mTLS (Sprint-10 C1, commit `0061b5e2`) binds endpoint identity to
the REAL TLS peer certificate of the gateway API listener. End-to-end that
requires, today:

1. **Direct TLS on the gateway `/v1` edge** (`API_TLS_CERT_PATH` /
   `API_TLS_KEY_PATH` / `API_TLS_CLIENT_CA_PATH`, which enables
   `requestCert`). This flips the SINGLE API listener to HTTPS for every
   consumer at once: the Traefik ingress backend (`psfn-gateway.local`), the
   hostPort 10053 LAN clients, and every in-cluster `/v1` caller would need
   `https://` plus trust for the private CA in the same change window.
2. **TLS reload on renewal.** The gateway reads its listener certificate once
   at startup (`createApiHttpServer` → `readFileSync`); cert-manager renewals
   are not picked up without a pod restart. That hardening is tracked
   separately as **psfn-framework-zlon (P1)** and is a prerequisite for
   running the edge on chart-issued short-lived certs.
3. **Hub companion-bridge client certificates.** The hub presents its client
   certificate on the chat-completions path (fail-closed: requires an
   `https://` base URL), but the companion bridge (SSE events, artifact
   previews, approval decisions) uses plain `fetch` with no client-cert
   support. A hub-side change (branch off hub `main`) is required before the
   bridge can survive an mTLS-only endpoint.

Given 1–3, this deployment uses the scoped bearer principal now. The concrete
flip, once zlon lands and the hub bridge gains client-cert support:

1. Gateway values/env: issue a gateway API server Certificate from the chart
   CA, set `API_TLS_CERT_PATH`/`API_TLS_KEY_PATH` to its mounted paths and
   `API_TLS_CLIENT_CA_PATH` to the CA bundle. Migrate the Traefik ingress
   backend and hostPort clients to HTTPS + CA trust in the same window.
2. Hub env: set `PSFN_CLIENT_CERT_PATH=/run/psfn/tls/psfn-client/tls.crt`,
   `PSFN_CLIENT_KEY_PATH=/run/psfn/tls/psfn-client/tls.key`,
   `PSFN_CA_CERT_PATH=/run/psfn/tls/psfn-client/ca.crt`, and switch
   `PSFN_API_BASE_URL`/`PSFN_COMPANION_BASE_URL` to
   `https://psfn-gateway:10053/v1`. (The certificate and mount already exist —
   step 6 above.)
3. `satellites.json`: switch the hub endpoint to
   `"auth": { "mode": "mtls", "clientCertSan": "URI:spiffe://cluster.local/psfn/satellite-hub/<companionId>" }`
   (match the exact SAN string the gateway logs for the presented cert;
   subject/SAN bindings only count when the chain validates against the client
   CA). Cert bindings are matched all-of and fail closed.
4. Remove the hub key from `API_SATELLITE_KEYS` once mTLS is verified.

## 7. Validation

```bash
# Pods and cert
kubectl -n psfn get pods -l app.kubernetes.io/component=satellite-hub
kubectl -n psfn get certificate psfn-satellite-hub-client

# Hub HTTP surface from the LAN (hostPort)
curl http://<pi>:8787/

# Chat turn through the hub's claim identity (from a trusted-CIDR host):
# a text turn via the hub websocket, or directly against the gateway edge to
# prove the satellite-scoped key + registry entry:
curl -sS http://<pi>:10053/v1/chat/completions \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H 'X-PSFN-Satellite-Claim-Type: text-only' \
  -H 'X-PSFN-Satellite-Id: hub-pi' \
  -H 'X-PSFN-Satellite-Endpoint-Id: hub-pi-main' \
  -H 'X-PSFN-Satellite-Session-Id: smoke-1' \
  -d '{"model":"psfn","messages":[{"role":"user","content":"ping"}]}'

# Companion relay scope grant (SSE stream should open, not 403):
curl -N -sS "http://<pi>:10053/v1/companion/events?satelliteId=hub-pi&endpointId=hub-pi-main&claimType=text-only" \
  -H "Authorization: Bearer $HUB_KEY" | head -5

# Hub logs: companion bridge connected, no auth errors
kubectl -n psfn logs deploy/psfn-satellite-hub --tail=50
```

Failure modes are fail-closed and diagnosable from the gateway logs: an
unlisted principal id → `403` on satellite surfaces; a claim type missing from
`claimTypes` → claim rejection; missing relay scopes →
`companion_relay_not_registered` / scope-denied SSE.

Expected benign warning: the hub probes `GET /v1/identity` for display
metadata, which is not a satellite surface, so the satellite-scoped key gets
`403` and the hub logs `PSFN identity endpoint failed (403)` once and
continues with a null identity (non-fatal by hub design). If the companion
display name matters on hub-served UIs, admitting `GET /v1/identity` to the
satellite surface allowlist in `src/channels/api/server.ts` is a small
framework follow-up.

## Repo Validation (before shipping chart changes)

```bash
npm run verify:helm-chart   # includes enabled-hub, text-only, and fail-closed renders
npm run lint
npm run build
```
