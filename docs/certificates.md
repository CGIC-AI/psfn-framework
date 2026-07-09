# Certificates: Private CA And The Cert-Manager Sidecar

PSFN's satellite backplane authenticates satellites with mutual TLS: the API
listener terminates TLS with `requestCert` enabled and binds each satellite's
identity to its **real TLS peer certificate**
(`src/channels/backplane/http/client-cert.ts`). This document explains why
that requires a deployment-owned private CA and how to bootstrap and operate
one with the cert-manager sidecar (`src/app/cert-manager/`).

## Threat Model Recap

- **Header assertions are theater.** Certificate fingerprints and subjects are
  public values; any caller can replay them in a header. Since Sprint-10 C1,
  client-cert identity is derived only from the terminated TLS socket's peer
  certificate (or from a token-authenticated TLS-terminating proxy). Inbound
  `X-PSFN-Client-Cert-*` headers are stripped at ingress.
- **Let's Encrypt cannot issue client certificates.** Public ACME CAs issue
  certificates with the `serverAuth` EKU only; the CA/Browser Forum baseline
  forbids them from minting `clientAuth` leaves. Satellite client certificates
  therefore *must* come from a CA you own.
- **A private CA also closes the server side.** When the gateway's server
  certificate chains to your own CA, satellites pin exactly one root and a
  compromised public CA cannot mint a certificate your fleet trusts.
- **Key custody.** The sidecar's CA key never leaves its state directory
  (mode 0600, never served by any endpoint). Issued private keys are returned
  exactly once in the API response and are not persisted — except for
  bundles the sidecar itself keeps renewed at explicitly configured output
  paths (the "managed" flow below).

## The Sidecar

The cert-manager is a standalone process — no imports from the gateway/agent
runtimes — with a small authenticated HTTP API and a background renewal loop.

```bash
npm run cert-manager -- init   # one-time: generate the root CA + config
npm run cert-manager           # serve the issuance API + renewal loop
npm run cert-manager:start     # same, from the tsup build (dist/cert-manager-main.js)
```

State directory (default `<system-data>/cert-manager/`, override with
`CERT_MANAGER_STATE_DIR`):

```text
cert-manager.json    sidecar config (all knobs; created by init)
ca/ca.key            CA private key, 0600 — never served, never leaves this dir
ca/ca.crt            CA certificate (public; also at GET /ca.pem)
issued-certs.json    metadata for issued certs (serial, expiry, SANs) — no keys
live/<kind>-<id>/    default output dir for managed (auto-renewed) bundles
```

Configuration (`cert-manager.json`, strict parsing — unknown keys fail
startup):

```json
{
  "version": 1,
  "listen": { "host": "127.0.0.1", "port": 10070, "allowNonLoopback": false },
  "ca": { "commonName": "PSFN Private CA", "validityDays": 3650 },
  "defaults": {
    "serverCertDays": 90,
    "clientCertDays": 90,
    "renewBeforeDays": 30,
    "renewCheckIntervalMinutes": 60
  }
}
```

Environment:

- `CERT_MANAGER_TOKEN` — **required**, ≥32 chars. The sidecar refuses to start
  without it; there is no insecure mode. All routes except `GET /ca.pem` and
  `GET /healthz` require `Authorization: Bearer <token>`.
- `CERT_MANAGER_STATE_DIR` — optional state-dir override. Without it the
  sidecar resolves the system-data root exactly like the runtime
  (`src/persistence/layout.ts`) and nests under `<system-data>/cert-manager`.

The listener binds loopback by default. Binding anything else requires the
explicit `listen.allowNonLoopback: true` opt-in (put TLS or a tunnel in front
if you do).

### API surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | liveness probe |
| `GET /ca.pem` | none | CA certificate (public material) |
| `GET /v1/certs` | bearer | issued-cert metadata + expiries |
| `POST /v1/certs/server` | bearer | issue server cert — `{identityId, sans, validityDays?, manage?}` |
| `POST /v1/certs/client` | bearer | issue client cert — `{identityId, sans?, validityDays?, manage?}` |
| `POST /v1/certs/renew` | bearer | re-issue — `{kind, identityId}` |

Issue/renew responses contain `certPem`, `keyPem` (the only delivery of the
key), `caCertPem`, plus `fingerprintSha256` / `spkiSha256` — the pin values
`satellites.json` client-cert bindings use.

`manage` opts an identity into sidecar-managed renewal:

- `true` — write the bundle under `live/<kind>-<id>/` in the state dir;
- `{"certPath": "...", "keyPath": "..."}` — absolute paths of your choosing,
  so `API_TLS_*` and satellite configs can simply point at them.

Keys written this way get mode 0600; everything is written atomically.

## Quickstart: Bootstrap A Deployment

1. **Init the CA** (once per deployment):

   ```bash
   export CERT_MANAGER_TOKEN="$(openssl rand -hex 32)"   # or any 32+ char secret manager value
   npm run cert-manager -- init
   npm run cert-manager &
   ```

2. **Issue the gateway server certificate** as a managed bundle. Use the DNS
   names/IPs satellites will actually dial as SANs:

   ```bash
   STATE=./data/cert-manager        # your resolved state dir
   curl -sS -H "Authorization: Bearer $CERT_MANAGER_TOKEN" \
     -X POST http://127.0.0.1:10070/v1/certs/server \
     -d '{"identityId":"gateway","sans":["gateway.internal","10.0.0.5"],"manage":true}' \
     | jq '{serialNumber, notAfter, outputs}'
   ```

3. **Issue one client certificate per satellite/companion.** The CN is the
   satellite's stable identity id. Save `certPem`/`keyPem` from the response
   onto the satellite host — this response is the only copy of the key:

   ```bash
   curl -sS -H "Authorization: Bearer $CERT_MANAGER_TOKEN" \
     -X POST http://127.0.0.1:10070/v1/certs/client \
     -d '{"identityId":"satellite-kitchen-pi"}' > kitchen-pi.json
   jq -r .certPem  kitchen-pi.json > satellite.crt
   jq -r .keyPem   kitchen-pi.json > satellite.key && chmod 600 satellite.key
   jq -r .caCertPem kitchen-pi.json > psfn-ca.crt
   jq -r .fingerprintSha256 kitchen-pi.json   # pin for satellites.json bindings
   ```

4. **Wire the gateway** (`.env`):

   ```bash
   API_TLS_CERT_PATH=<state>/live/server-gateway/cert.pem
   API_TLS_KEY_PATH=<state>/live/server-gateway/key.pem
   API_TLS_CLIENT_CA_PATH=<state>/ca/ca.crt
   # Per-satellite bearer keys (each yields a distinct satellite principal):
   API_SATELLITE_KEYS=<key-for-kitchen-pi>,<key-for-hall-cam>
   ```

   Then bind the certificate in `satellites.json` — either pin the
   fingerprint (`clientCertFingerprintSha256`, works even without chain
   validation) or, since `API_TLS_CLIENT_CA_PATH` makes the chain validate,
   bind `clientCertSubject: "CN=satellite-kitchen-pi"`. Binding matching is
   fail-closed all-of: every configured attribute must match.

5. **Verify with curl** from the satellite host:

   ```bash
   # mTLS handshake + satellite bearer key:
   curl --cacert psfn-ca.crt --cert satellite.crt --key satellite.key \
     -H "Authorization: Bearer <that-satellites-API_SATELLITE_KEYS-entry>" \
     https://gateway.internal:10053/v1/satellites/config

   # Negative check: without --cert/--key the satellite endpoints must refuse
   # the request (the TLS handshake succeeds — the listener requests but does
   # not require a cert, because non-satellite API clients have none — but
   # mTLS-bound satellite auth fails closed).
   ```

## Adding A New Companion/Satellite Later

New satellites appear over time; no openssl ceremony needed:

1. `POST /v1/certs/client` with the new stable identity id; deliver the
   returned bundle to the device (the key exists only in that response).
2. Append a fresh bearer key for it to `API_SATELLITE_KEYS`.
3. Register the endpoint in `satellites.json` with the cert binding
   (fingerprint pin and/or `CN=` subject) and its `apiKeyPrincipalIds` entry.
4. Restart/reload the gateway to pick up the env change.

No CA change is needed — the client-CA (`ca.crt`) already trusts the new leaf.

## Renewal Behavior

- Leaf certificates default to **90 days** (server and client); the CA to
  **~10 years**. Issuance refuses validity that outlives the CA.
- The renewal loop sweeps every `renewCheckIntervalMinutes` (default 60).
  Managed certificates within `renewBeforeDays` of expiry (default 30) are
  re-issued with a **fresh keypair** and rewritten in place at their output
  paths; renewals are logged loudly (`RENEWED certificate before expiry`).
- Renewal **failures are errors**, not warnings, and never abort the rest of
  the sweep.
- Unmanaged certificates (keys held only by the satellite) cannot be
  auto-renewed; when one enters the renewal window the sidecar logs an
  **error** telling you to `POST /v1/certs/renew` and redeploy the bundle.
- Consumers read cert files at startup (`createApiHttpServer` uses
  `readFileSync`), so restart the gateway — or have your process manager
  watch the managed paths — after a server-cert renewal. Satellites likewise
  need the renewed bundle redeployed.

## Revocation And CA Compromise

There is **no CRL/OCSP in v1**. Plan around it:

- **Removing one satellite** = remove its key from `API_SATELLITE_KEYS` and
  its `satellites.json` endpoint/binding. Because satellite auth requires the
  bearer key *and* the cert binding, a lingering leaf certificate alone
  grants nothing. If the leaf's key itself is known-stolen and you want the
  TLS layer closed too, rotate the client CA (below).
- **CA key compromise** = full rotation, treat as an incident:
  1. Stop the sidecar. Move `ca/` and `issued-certs.json` aside (do not
     delete — forensics).
  2. `npm run cert-manager -- init` to mint a new root, then restart the
     sidecar.
  3. Re-issue the gateway server cert and every satellite client cert from
     the new root.
  4. Swap `API_TLS_CLIENT_CA_PATH` (and every satellite's pinned
     `psfn-ca.crt`) to the new `ca.crt`, deploy new bundles, restart. Old
     leaves are now untrusted everywhere — that *is* the revocation.
  5. Rotate `API_SATELLITE_KEYS` and `CERT_MANAGER_TOKEN` while you're there;
     assume anything on that host leaked.

## Running As A Sidecar

### systemd

```ini
# /etc/systemd/system/psfn-cert-manager.service
[Unit]
Description=PSFN cert-manager sidecar (private CA)
After=network-online.target
Before=psfn-gateway.service

[Service]
WorkingDirectory=/opt/psfn
Environment=CERT_MANAGER_STATE_DIR=/opt/psfn/data/cert-manager
EnvironmentFile=/etc/psfn/cert-manager.env   # CERT_MANAGER_TOKEN=..., mode 0600
ExecStart=/usr/bin/node /opt/psfn/dist/cert-manager-main.js serve
Restart=on-failure
User=psfn
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/psfn/data/cert-manager

[Install]
WantedBy=multi-user.target
```

One-time bootstrap: `sudo -u psfn env CERT_MANAGER_STATE_DIR=/opt/psfn/data/cert-manager node /opt/psfn/dist/cert-manager-main.js init`.

### docker compose

```yaml
services:
  cert-manager:
    build: .
    command: ["node", "dist/cert-manager-main.js", "serve"]
    environment:
      CERT_MANAGER_TOKEN: ${CERT_MANAGER_TOKEN:?required}
      CERT_MANAGER_STATE_DIR: /state
    volumes:
      - cert-manager-state:/state
    # Loopback-only by design: publish to the host loopback, never 0.0.0.0.
    ports:
      - "127.0.0.1:10070:10070"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:10070/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 60s

volumes:
  cert-manager-state:
```

Inside the container set `listen.host` to `0.0.0.0` **with**
`listen.allowNonLoopback: true` in `cert-manager.json` (the container network
boundary is the host publish rule above), or keep loopback and share the
network namespace with the gateway container.

To init inside compose:
`docker compose run --rm cert-manager node dist/cert-manager-main.js init`.
