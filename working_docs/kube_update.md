# k3s / Helm Migration — Planning & Gotchas

Status: **planning, not started.** No code touched, no beads filed yet.
Owner: this is a single-companion (Purrsephone) deployment; charter = 1 system = 1 companion.

All file:line references below were verified by reading the actual source in this
session, not from docs (docs lag code in several places — see gotchas).


## 1. Target architecture

Four pods + stateful stores. Three request flows, all code-verified this session
(see `src/app/gateway/main.ts`, `src/app/agent/main.ts`, `src/app/operator/main.ts`,
`src/operator/garden/operator-surface.ts`).

**Load-bearing rule: ingress NEVER touches the agent.** The agent only accepts
cluster-internal sockets (`gateway.sock`, `garden-admin.sock`), never a direct
ingress hop.

```
FLOW 1 — chat / OpenAI-compat API / channels
  client ──HTTP──▶ gateway (API_PORT) ──RPC (gateway.sock)──▶ agent ──▶ Postgres

FLOW 2 — Garden admin UI (browser)
  browser ──HTTP──▶ garden (ADMIN_PORT, SPA) ──proxy (garden-admin.sock)──▶ agent ──▶ Postgres

FLOW 3 — device / satellite voice
  device ──WS──▶ hub (:8787) ──HTTP (API)──▶ gateway ──RPC (gateway.sock)──▶ agent ──▶ Postgres
```

Pods and edges:

```
                          ┌─────────────────────────────────────┐
  FLOW 1 + FLOW 3 ───────▶│  gateway   API_PORT (HTTP)          │
  (chat API, hub calls)   │            gateway.sock (RPC server) │
                          │            secrets, channels,        │
                          │            LLM/emb clients, egress   │
                          └───────────────┬─────────────────────┘
                                          │ gateway.sock  (agent connects as client)
                                          ▼
  FLOW 2 ──────────────────┐   ┌─────────────────────────────────────┐
  (admin UI)               │   │  agent     companion loop            │
                           │   │            binds garden-admin.sock   │
                           │   │            (admin transport, owns     │
                           │   │             memory/session/contact    │
                           │   │             stores) ─▶ Postgres+pgvec  │
                           │   │            deny-all egress NetPolicy   │
  ┌────────────────────────┘   │            (allow gateway + db only)   │
  │                                                 ▲                  │
  ▼                                                 │                  │
  ┌──────────────────────────────────┐              │                  │
  │  garden   ADMIN_PORT (HTTP SPA)   │──proxy──────┘                  │
  │           proxies /api/admin/* to │  (garden-admin.sock)            │
  │           agent via GardenAdmin-  │                                │
  │           TransportProxy          │                                │
  └──────────────────────────────────┘                                │
                                                                       │
  FLOW 3 (device leg)                                                  │
  ┌──────────────────────────────────┐     calls gateway HTTP API ─────┘
  │  satellite-hub  ws://:8787        │      (PSFN_API_BASE_URL, already
  │                 serves devices    │       network-clean today)
  └──────────────────────────────────┘
```

Stateful stores: **Postgres+pgvector** (required, fail-closed without pgvector)
and **Redis** (cache; app-wiring is a separate concern, see §4 gotcha 10).

### Reconciliation with the user-stated flows

Two of three match the code exactly:
- FLOW 1 `ingress > gateway > agent > db` — ✓ matches
- FLOW 3 `ingress > hub > gateway > agent` — ✓ matches

FLOW 2 as written was `ingress > gateway > garden > db`. The code today does
`ingress > garden > agent > db`, for two reasons:
1. **garden is its own ingress target** — it binds `ADMIN_PORT` directly
   (`operator/main.ts:22`), not reached *through* the gateway.
2. **garden proxies to the agent**, not the db — because the **agent owns the
   stores** and serves `garden-admin.sock` (`agent/main.ts:345`).

To make it literally `ingress > gateway > garden > db` would be a **redesign**,
not a wiring change: (a) gateway would have to reverse-proxy admin traffic to the
  garden pod, and (b) the garden pod would have to read Postgres directly instead
  of going through the agent's admin transport. Flagged here so we decide
deliberately rather than assume — current diagram reflects code reality.


## 2. Verified current state (what the code actually does today)

### Transport — **Unix-socket-only on two of three edges** (this is the gating blocker)
Two cluster-internal edges are Unix-socket-bound today; the third is already HTTP.

- **Edge A — gateway RPC (`gateway.sock`):** server in gateway
  (`src/boundary/gateway/transport.ts`, header *"NDJSON-framed Unix socket transport"*,
  `server.listen(socketPath)`); agent connects as client (`net.createConnection`).
  **No TCP path, no `GATEWAY_TCP`/`GATEWAY_PORT` env anywhere.**
- **Edge B — admin transport (`garden-admin.sock`):** server is in the **agent**
  (`src/app/agent/admin-surface.ts:91`, started from `agent/main.ts:345`); the
  garden/operator is the client, proxying HTTP + telemetry WS over it
  (`src/operator/garden/transport-client.ts` `GardenAdminTransportProxy`,
  `request({ socketPath })`). Same socket-only constraint, and note the server side
  lives on the agent, not the gateway.
- **Edge C — hub → gateway:** already network-clean. `PSFN-Satellite-Hub/.env.example`:
  `PSFN_API_BASE_URL=http://127.0.0.1:3100/v1`, `PSFN_API_KEY=...`; devices reach hub
  on `ws://hub:8787`. **Maps straight to Service+Ingress, no code change needed.**

### Auth — **the gateway RPC has zero transport auth today**
- No token, no `verifyClient`, no mTLS in `server.ts` / `client.ts`.
- **The Unix socket IS the entire auth boundary** ("only a co-located process in this fs
  namespace can connect"). Moving to TCP rebuilds this boundary — not optional.
- `src/boundary/gateway/session-hmac-env.ts` (GATEWAY_SESSION_HMAC_KEY*) is **journal
  integrity** (HMAC over session records for tamper detection), NOT transport auth.
- `src/boundary/gateway/tls.ts` is **outbound-only** — sets NODE_EXTRA_CA_CERTS /
  NODE_TLS_REJECT_UNAUTHORIZED for upstream HTTPS (LiteLLM/embeddings). Nothing to do
  with inbound transport.

### Agent network isolation — the k8s blocker (and the argument FOR the four-pod split)
- `src/app/agent/startup-guards.ts` `enforceNetworkIsolationOnStartup()`:
  `fetch('http://1.1.1.1/cdn-cgi/trace')`, and **if reachable, throws and refuses to start**
  unless `ALLOW_AGENT_OUTBOUND_NETWORK=true` (which logs `CRITICAL: DEGRADED`).
- k8s pods share **one network namespace across all containers**. So a co-located
  gateway+agent pod → agent can reach network → startup aborts.
- **The fix is the four-pod split itself:** agent in its own pod + deny-all-egress
  `NetworkPolicy` (allow only gateway + Postgres) → probe fails by design → agent boots
  clean, no DEGRADED flag. The topology recovers the original `network_mode: none` intent
  better than Docker co-location can.

### Persistence — Postgres hard-required, single-writer file state
- `src/persistence/runtime-factory.ts:59-64`: throws if
  `config.persistenceBackend !== 'postgres'`. Wires `createPostgresMemoryStore`,
  `createPostgresContactStore`, `createPostgresIntentionPorts`, etc.
- Production layout (`src/persistence/layout.ts`): `PSFN_RUNTIME_LAYOUT_MODE=production`
  requires `SYSTEM_DATA_DIR` + `COMPANION_DATA_DIR` set together, fail-closed on overlap,
  production forbids `DATA_DIR` shared-root.
- Single-writer local state (append/mutate per turn, must not have 2 writers):
  session JSONL, `prompt-registry.json`, `core_memory.json`, `charge-ledger.jsonl`,
  `north-star.json`, `post-turn-actions.queue.json`, safeguard audit trail, character-card
  history. → **1 writer per `companion-data` PVC forever** (charter; shards fold back via
  separate stores, never multi-writer into one L0 set).

### SQLite — hard dep in package.json, but dead/migration-only in the active runtime
- `package.json`: `better-sqlite3@11.10.0`, `sqlite-vec@0.1.6`, `@types/better-sqlite3@7.6.13`.
- **~48 non-test imports across `src/`** (contacts, intention, memory store, persistence,
  gateway audit). README says "retained for legacy migration tooling" — that's aspirational;
  the imports are real code, but the runtime factory hard-requires Postgres so they're
  unreachable in production. Purrsephone is fully migrated to Postgres.
- Migration tool exists: `src/app/maintenance/sqlite-to-postgres-memory-migration.ts`
  (npm script `migrate:sqlite-to-postgres-memory`) — the path other operators would use.

### Node — currently 22, constraint allows 24
- `package.json`: `engines.node = ">=22.0.0"` (no edit needed for 24); `@types/node@22.19.11`.
- `docker/Dockerfile.agent`: `FROM node:22-slim`.
- Sandbox runtime: Node v22.22.2 / OpenSSL 3.5.5.

### Secrets seam — already exists, not greenfield
- `src/boundary/gateway/bootstrap-input.ts:322`:
  `resolveOptionalEnvCredential(config.credentialVault, 'NTFY_TOKEN', env)` — there is a
  `credentialVault` abstraction already; extending it to a real backend is the path, not
  inventing one.
- (Note: "vault" elsewhere in the codebase = Obsidian vault, NOT HashiCorp.)

### Existing deployment surface
- `docker/docker-compose.production.yml` — production profile, `network_mode: "none"`,
  the env wiring to mirror in the chart.
- `docker/Dockerfile.agent` — non-root `psfn` user, RO identity mount.
- `deployment/systemd/*.service` — live systemd units (psfn, satellite-hub, companion-ui).
- **No k8s/Helm artifacts exist anywhere in the tree** (verified).


## 3. The work plan (six steps)

### Step 1 — Node 24 upgrade
- Bump `docker/Dockerfile.agent` `FROM node:22-slim` → `node:24-slim`.
- Bump `@types/node` to an exact 24.x pin (verify against registry; repo pins exact
  versions per the supply-chain rule in AGENTS.md).
- `engines.node` already `>=22.0.0`, no constraint edit.
- **First action after bump: run the PQC surface probe** (see §5) — this single result
  decides whether Step 3 gets native PQC for free.
- Native addons `better-sqlite3` + `sqlite-vec` rebuild against Node 24 ABI (prebuilts
  expected; breakage is acceptable debt given Postgres-only runtime, and Step 2 removes
  them anyway).

### Step 2 — Remove all SQLite code (cleaning)
- **Collides with active P0 epic `psfn-framework-zn9`** (backup-and-restore). Its finding:
  the backup service still only calls `sqlite db.backup()` at
  `src/persistence/backups/service.ts:210`. Step 2 must coordinate.
- Blast radius: ~30 non-test src files + 35 test files across `core/contacts/store/*`,
  `core/intention/*`, `faculties/memory/store/*`, `persistence/{sqlite-*,reflections/sqlite-mirror,
  sessions/transcript-projection,importers/*}`, `boundary/gateway/audit.ts`.
- Deletes `migrate:sqlite-to-postgres-memory` (the bootstrap path for future operators).
- **Requires updating the live alpha migration boundary** at `docs/specifications.md:36`
  (currently names SQLite as supported migration) and `docs/operations.md:76,97,109`.
- Scope decision pending (see §6).

### Step 3 — Add TCP/WSS transport, keep Unix sockets, PQC-ready
- Add TCP + WebSocket listener modes to `src/boundary/gateway/transport.ts` alongside the
  existing NDJSON Unix-socket transport. **Socket mode stays default** (local dev, smoke,
  e2e, co-located Docker). Dual-listener, gated behind env (`GATEWAY_TCP_*`).
- Two edges need a TCP/WSS listener added (both currently socket-only):
  - **Edge A — gateway RPC server** (`src/boundary/gateway/transport.ts`) → NDJSON-over-
    WebSocket subprotocol `psfn-rpc-v1`, so the agent pod can reach the gateway pod.
  - **Edge B — agent admin transport server** (`src/app/agent/admin-surface.ts`, the
    `garden-admin.sock` server) → HTTP+WS over TCP, so the garden pod can reach the
    agent pod. The client side is `GardenAdminTransportProxy` in
    `transport-client.ts` and gains a TCP connect mode.
  The hub edge (C) needs no transport change — it already speaks HTTP to the gateway.
- Auth boundary rebuild (fail-closed per repo charter): cert-manager client certs,
  cluster CA verify, **SPIFFE URI in cert SAN** (`spiffe://cluster.local/psfn/{agent|garden|<companion-id>}`)
  so Step 6 is an additive read, not a reissue.
- PQC posture depends on Step 1 probe: if Node 24 `tls` exposes `X25519MLKEM768`, wire it
  into the secureContext group list and you're done natively. If not, an oqs-enabled
  proxy sidecar is the fallback (additive, doesn't touch this bead's interface).

### Step 4 — Helm chart (`deploy/helm/psfn/`, new, repo-owned)
- **Location is mandated:** Live Deployment Boundary (AGENTS.md) requires everything
  operationally authoritative to live under this repo tree. Not off-repo.
- Deployments: gateway, agent, garden, satellite-hub. Services + Ingress (Traefik).
- `NetworkPolicy` (per the verified flows, §1):
  - agent = deny-all egress except **gateway** (RPC) + **Postgres**; the agent also
    *receives* the garden's admin-proxy connection on the admin-transport port.
  - garden = egress to **agent** (admin transport, Edge B) only — NOT the gateway;
    ingress from the Traefik ingress controller on ADMIN_PORT.
  - gateway = ingress on API_PORT (FLOW 1) + ingress from hub (FLOW 3); egress to
    agent (RPC), LLM/embedding providers, channels.
  - hub = ingress on :8787 (devices); egress to gateway (HTTP API) only.
- StatefulSets: Postgres+pgvector (or external `POSTGRES_DATABASE_URL`), Redis (cache
  infra; app wiring is separate — see gotcha).
- Four PVCs wired to production layout env matching `docker/docker-compose.production.yml`:
  `system-data`, `companion-data`, `workspace`, `logs/tmp/backups`. Character/identity RO.
- **Seed-once init:** copy `config/*.seed.json` into `system-data` PVC **only if owner
  files are absent**. Never overwrite live Garden edits.
- Secrets from K8s Secret (interim) until Step 5 lands.
- cert-manager Issuer + SPIFFE SANs.

### Step 5 — Secrets management ("so no one actually has keys")
- Retire `.env` as secret authority on the k8s path.
- Wire the existing `credentialVault` seam (`bootstrap-input.ts:322`) +
  `GATEWAY_SESSION_HMAC_KEY*` + provider/channel secrets (OPENROUTER_API_KEY,
  DISCORD_TOKEN, TELEGRAM_BOT_TOKEN, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, API_KEY,
  ADMIN_TOKEN) to External Secrets Operator syncing from a backend into K8s Secrets.
- **Honest framing of the threat model:** a root-of-trust credential still exists (k8s SA
  projected token now, SPIFFE SVID later) — that is unavoidable and the point. The win is
  no *human* holds long-lived provider keys; the workload authenticates via short-lived
  workload identity.
- Backend TBD (see §6).

### Step 6 — SPIFFE SVID (per-companion + per-shard identity, evaluate first)
- (a) Transport identity: each companion AND each shard gets its own SVID
  (`spiffe://cluster.local/psfn/companion/<id>`, `spiffe://cluster.local/psfn/shard/<id>`);
  gateway validates on mTLS. Builds on the SANs wired in Step 3.
- (b) DB-write provenance: stamp every shared-DB memory/intention write with the writer's
  SVID, so shard fold-back into main is auditable. **Touches the Postgres memory-store
  write path — real per-write cost.** User flagged "see if this is better": this bead
  includes a design note evaluating per-shard provenance vs a simpler fold-back manifest.


## 4. Things to look out for (the load-bearing gotchas)

1. **Unix sockets can't cross pod boundaries.** Two of three gateway edges are socket-only
   today. Step 3 (TCP/WSS) is the gating code work — without it, the four-pod split
   physically cannot communicate. Do not write the chart before Step 3 lands.
2. **The agent network-isolation guard (`startup-guards.ts`) aborts on any reachable
   network.** In k8s this is a *feature*, not a problem: the agent pod + deny-all NetPolicy
   makes the probe fail by design and the agent boots clean with no DEGRADED flag. But it
   means co-located gateway+agent in one pod is a non-starter without the degraded flag.
3. **Gateway RPC has zero transport auth.** The Unix socket was the entire boundary. TCP
   mode must rebuild it: mTLS + cluster CA + SPIFFE SAN + NetworkPolicy, fail-closed when
   enabled without creds. This is exactly the kind of change the repo charter wants done
   explicitly, never silently.
4. **1 writer per `companion-data` PVC, forever.** Charter: 1 system = 1 companion.
   Multi-writer corrupts session JSONL / prompt-registry / core_memory / charge-ledger.
   Shards fold back via *separate* stores, never multi-writer into one L0 set. Do not add
   leader election or HA — it's the wrong shape for this system.
5. **SQLite removal collides with P0 epic `psfn-framework-zn9`.** The backup service at
   `src/persistence/backups/service.ts:210` still calls `sqlite db.backup()`. Coordinate
   scope before swinging (see §6).
6. **"Remove all sqlite" is bigger than cleaning.** ~30 src files + 35 tests, and it
   deletes the migration tool future operators would use. Must update
   `docs/specifications.md:36` and `docs/operations.md`. Plan by subsystem, not a sweep.
7. **Owner files are PVC, not ConfigMap.** `settings.json`, `models.json`, `providers.json`,
   `scheduler.json`, `capability-tier.json`, `channels.json`, `skills.json`,
   `trust-policy.json`, `charge-policy.json`, `backup.json` are **mutated at runtime via
   Garden**. ConfigMap would clobber live edits on every rollout. Seed-once init only.
8. **"This will already support PQC" (Step 3) is contingent, not fact.** Node 24.7.0
   (Aug 27 2025) adds WebCrypto ML-KEM/ML-DSA per the release notes. Whether the `tls`
   module negotiates the `X25519MLKEM768` hybrid group for *handshakes* is **unverified**
   — could not run it in the dev sandbox (see §5). Probe it; don't bake the assumption in.
9. **Secrets "so no one has keys" — root-of-trust still exists.** The workload still needs
   a credential to authenticate to the secrets backend (SA token / SVID). That's the point:
   no *human* holds long-lived provider keys. Don't oversell this as zero-trust-of-anything.
10. **Redis cache is two separate concerns.** Chart *provisions* Redis infra (easy).
    *Wiring* what gets cached + invalidation is app-layer work with real design surface
    (Garden edits `settings.json` → cache must invalidate; memory write → cache update).
    Plan the app-wiring as its own bead after the chart.
11. **SPIFFE provenance stamping has a per-write cost.** Stamping SVID on every shared-DB
    memory write touches the Postgres memory-store hot path. User explicitly flagged
    "see if this is better" — evaluate vs a simpler fold-back manifest before committing.
12. **Node 22 + OpenSSL 3.5.5 surfaces ZERO PQC today** (measured: `tls.getCiphers()` PQ
    empty, WebCrypto ML-KEM/ML-DSA/X25519MLKEM768 none present). Node 24 is where this
    changes. Re-probe on 24 before claiming PQC works.
13. **`better-sqlite3` will rebuild against the Node 24 ABI.** Prebuilts expected; if they
    don't ship for a Node 24 minor, the Docker build breaks. Acceptable given Step 2, but
    don't let it block Step 1.
14. **Postgres backup requires `pg_dump`/`pg_restore` on PATH**, and verify-restore needs a
    scratch DB with `CREATE DATABASE <name>_restore_verify` + `CREATE EXTENSION vector` as
    superuser (one-time setup). Wire this into the chart's DB lifecycle or document it.
15. **Config-in-Postgres is a future effort, not part of this wave.** Owner-file loader
    (`src/system/config/startup-owner-files.ts`, `config-store.ts`) reads JSON from disk at
    boot; no Postgres config store, no settings cache exists today. Moving truth to Postgres
    means rewriting the loader AND the Garden save paths, and updating the migration
    boundary in `docs/specifications.md`. Chart against the PVC model; design values so the
    swap is a one-section change later.
16. **Embeddings backend is still an open input.** Local transformers (model-cache PVC,
    first-boot download) vs Ollama / OpenAI-compatible (externalizes it). Affects chart
    values; needs a decision.


## 5. What can't be verified from the dev sandbox

- **Node 24 PQC `tls` surface.** Sandbox has Node 22.22.2 only; no network egress (curl to
  the Node 24 changelog returned empty). The probe must run in the Docker build or the
  target env. Probe script:
  ```js
  const tls = require('tls');
  // Q1: does createSecureContext advertise X25519MLKEM768 in the group list?
  // Q2: WebCrypto ML-KEM-768/1024, ML-DSA present?
  // Outcome forks Step 3 PQC posture (native vs oqs proxy).
  ```
- **Docker IS available in the sandbox** (`docker version` reports server 29.5.2), so the
  Node 24 image build + probe *can* run here once work starts — just not without the bump.


## 6. Open decisions (need user input before work starts)

1. **SQLite removal scope vs `psfn-framework-zn9`:**
   - (i) exclude `persistence/backups/*` (zn9 owns the backup-service cutover), depend on zn9; or
   - (ii) subsume the backup-service sqlite removal into this work, own it, and narrow zn9.
2. **Secrets backend:** Vault · 1Password Connect · Infisical (self-hosted, k8s-native) ·
   cloud Secrets Manager · ESO-only-to-Secret. (Lean: Infisical for single-companion;
   Vault is overkill.)
3. **PQC in v1 or additive:** is harvest-now-decrypt-later of east-west traffic in the v1
   threat model (→ ship PQC with Step 3), or additive (→ separate bead)? Contingent on the
   Step 1 probe regardless.
4. **Cert CA:** cert-manager with a self-signed cluster CA + SPIFFE SANs (recommended, makes
   Step 6 a pure read), or target an existing private CA?
5. **Postgres:** bundled pgvector StatefulSet in the chart, or external
   (`POSTGRES_DATABASE_URL` points at your own)?
6. **Embeddings:** local transformers (model-cache PVC) vs Ollama / OpenAI-compatible?


## 7. Suggested sequencing

1. **Step 1** (Node 24 + probe) — lowest risk, settles the PQC question, leaves runtime on
   current footing. Do first, in isolation.
2. **Step 3** (TCP/WSS + mTLS) — gates the chart. Depends on Step 1 probe result.
3. **Step 2** (SQLite removal) — can run in parallel with Step 3 if scope is decided; owns
   its subsystems cleanly. Coordinate with zn9.
4. **Step 4** (Helm chart) — written against Step 3. The actual deploy.
5. **Step 5** (secrets) — lands after chart; Secrets come from a K8s Secret + env in the
   interim (identical to the current `.env` model migrated to a Secret object).
6. **Step 6** (SPIFFE) — additive read of Step 3 SANs; future, evaluate provenance cost
   first.

Redis app-wiring and Postgres-backed config store are separate efforts, tracked but not in
this wave.

---

_Tracking: use `bd` (not this file) for actual work state. This doc is the design reference;
beads filed against it should cite it. Regenerate the file:line refs against live code before
acting — docs lag code here._
