# Setup

PSFN boots through the split runtime. The legacy `src/app/startup/index.ts` entrypoint is disabled and exits fail-closed; use `npm run split` for the full gateway + agent + operator stack, or launch `npm run gateway`, `npm run agent`, and `npm run operator` individually.

Before upgrading any Helm cluster, read the canonical
[Helm Fleet Upgrade Guide](./helm-upgrades.md). It carries rollout-order
constraints and operator-visible access changes; this setup guide remains the
authority for initial configuration and ownership.

## Prerequisites

- Node.js 22+
- PostgreSQL 16+ with the `pgvector` extension. The repo-owned runtime is Postgres-only for memories, episodes, contacts, concerns, intentions, internal state, and searchable projections.
- One provider secret for the model/provider owner file you plan to use. The shipped examples include OpenRouter, so using those examples usually means `OPENROUTER_API_KEY`.
- Optional channel/service secrets only for the surfaces you enable:
  - `DISCORD_TOKEN` and `DISCORD_BOT_ID`
  - `TELEGRAM_BOT_TOKEN`
  - `API_KEY`
  - `ADMIN_TOKEN`
  - `DEEPGRAM_API_KEY`
  - `ELEVENLABS_API_KEY`
  - `API_SATELLITE_KEYS` — comma-separated per-satellite bearer keys (each >=16 chars); each key yields a distinct satellite-scoped principal that `satellites.json` endpoints must list in `auth.apiKeyPrincipalIds`. Only needed when running satellites; leave unset otherwise.
- Required deployment identity wiring:
  - `COMPANION_ID`

## Install

```bash
git clone <repo-url>
cd psfn-framework
npm install
cp .env.example .env
```

The root install also provisions `admin-ui/`.
Default installs skip `onnxruntime-node`'s CUDA side-download and use the bundled CPU runtime. Set `ONNXRUNTIME_NODE_INSTALL_CUDA=v12` for an intentional ONNX Runtime CUDA binary install.

## What Goes In `.env`

Keep `.env` limited to:

- Secrets
- Host, port, and socket wiring
- Runtime mode and persistence layout wiring
- Personal files workspace wiring (`WORKSPACE_PATH`)
- Explicit bootstrap overrides such as `CHARACTER_CARD_PATH`
- Explicit deployment identity such as `COMPANION_ID`

The runtime ignores mutable settings that are owned by JSON files. Do not use `.env` for embeddings, model roster, scheduler cadence, capability tier, channel policy, skills, charge/fatigue policy, or trust policy.

## What Goes In JSON Owner Files

Mutable runtime/admin configuration lives in canonical JSON owner files.

Cluster-global owner files live under `SYSTEM_DATA_DIR`:

- `settings.json`
- `models.json`
- `providers.json`
- `channels.json`
- `trust-policy.json`
- `intake-policy.json`
- `backup.json`

Four whole owner files live under each companion's `COMPANION_DATA_DIR`:

- `scheduler.json`
- `capability-tier.json`
- `charge-policy.json`
- `skills.json`

In a local shared-root layout, system-data and companion-data resolve to the
same directory, so the ownership distinction does not change the path.
Production split-root and Helm deployments must place all four per-companion
files under `COMPANION_DATA_DIR`; startup does not fall back to system-root
copies.

Startup verifies the seed-backed owner files before the split runtime comes up. Distributed `config/*.seed.json` files are examples/templates only; PSFN does not silently copy them into runtime state.

`channels.json` has no seed file. Channel config loads safe defaults when it is absent and is created or updated when channel settings are saved through Garden or the admin API.

## First Local Bring-Up

1. Set the minimum bootstrap values in `.env`:

   ```dotenv
   OPENROUTER_API_KEY=...
   COMPANION_ID=companion
   DATA_DIR=./data
   WORKSPACE_PATH=./purrsephone
   CHARACTER_CARD_PATH=./data/companion.json
   POSTGRES_DATABASE_URL=postgresql://psfn:password@127.0.0.1:5432/psfn
   PSFN_BACKUP_ENCRYPTION_KEY=<long random secret>
   ```

2. Intentionally copy the example owner files into their canonical owner roots
   and edit them for this deployment. This shared-root local example uses
   `./data` for both roots:

   ```bash
   cp config/settings.seed.json ./data/settings.json
   cp config/models.seed.json ./data/models.json
   cp config/providers.seed.json ./data/providers.json
   cp config/scheduler.seed.json ./data/scheduler.json
   cp config/capability-tier.seed.json ./data/capability-tier.json
   cp config/trust-policy.seed.json ./data/trust-policy.json
   cp config/intake-policy.seed.json ./data/intake-policy.json
   cp config/charge-policy.seed.json ./data/charge-policy.json
   cp config/backup.seed.json ./data/backup.json
   cp config/skills.seed.json ./data/skills.json
   ```

   For production split roots, place the outputs from
   `scheduler.seed.json`, `capability-tier.seed.json`,
   `charge-policy.seed.json`, and `skills.seed.json` under
   `COMPANION_DATA_DIR`; place every other owner file shown above under
   `SYSTEM_DATA_DIR`. In fleet mode, provision those four files separately for
   every companion root. Startup rejects a missing per-companion owner and
   never reads a system-root copy as a fallback.

   For existing Helm releases, the chart's guarded automatic cutover covers
   only `scheduler.json` and `capability-tier.json`, followed by scheduler
   schema migration; see
   [`deploy/helm/psfn/README.md`](../deploy/helm/psfn/README.md#upgrading-releases-created-before-schedulercapability-owner-routing).
   Existing multi-companion split fleets with registered per-companion owners
   under `SYSTEM_DATA_DIR` must instead use the digest-approved,
   receipt-bearing workflow in
   [`docs/operations.md`](./operations.md#existing-split-fleets-with-shared-per-companion-owners).

   The `models.seed.json` template ships `promptCaching.enabled: true`, so new deployments engage provider prompt caching on the byte-stable system-prompt prefix out of the box (Anthropic / OpenRouter→Anthropic get `cache_control` breakpoints; other providers get the stable-prefix benefit plus telemetry, no wire change). Set `promptCaching.enabled: false` in `models.json` to fully disable it. Tune lifetime with `promptCaching.retention` (`none`/`short`/`long`, default `short`) and the session key with `promptCaching.scope` (`channel`/`request`, default `channel`).

3. Provision the intake firewall's L1.5 prompt-injection classifier model (optional but recommended; ~704 MiB, gitignored, never downloaded at runtime):

   ```bash
   npm run provision:injection-model -- --dest ./models/prompt-injection-v2
   ```

   Without it the gateway skips L1.5 scoring with a loud startup warning and screens on the deterministic L1 layer alone; a present-but-broken model directory fails startup closed. Override the location with `PSFN_INJECTION_MODEL_DIR`. The `intake-policy.json` owner file copied above controls the firewall mode (`off`/`shadow`/`enforce`; the seed ships `shadow`) — see [`docs/cognitive-security.md`](./cognitive-security.md).

4. Provide the explicit character card at `CHARACTER_CARD_PATH`. Startup fails if the configured identity file is missing. Keep this active identity file under runtime data, not under the personal writable workspace.

5. Keep the backup encryption key secret in `.env` or your deployment secret manager. `backup.json` should contain only the env key reference. Generate a local key with `openssl rand -base64 48`.

6. Start the split runtime (gateway + agent + operator):

   ```bash
   npm run split
   ```

   The launcher loads `.env` for gateway/operator processes, then starts the agent with a curated non-secret environment allowlist. Provider credentials, API keys, and admin tokens stay gateway/operator-owned.

7. If you want the integrated Garden SPA served by the admin host, build it once:

   ```bash
   npm run garden:build
   ```

8. If you want the standalone Garden dev server instead:

   ```bash
   npm run garden:dev
   ```

## Runtime Modes

### Continuous / local

- Default mode when `PSFN_RUNTIME_LAYOUT_MODE` is unset.
- Uses the legacy shared root (`DATA_DIR`, default `./data`) for both system and companion data.
- Uses `WORKSPACE_PATH` as one companion's Personal Workspace for documents,
  downloads, generated images, personal journal/scratchpad files,
  knowledge-base notes, authored skills, modules, and experiments. It is not a
  runtime-state root or a general shared-files root. In the live Purrsephone
  deployment this is repo-root `./purrsephone`.
- Good for local development and smoke testing.
- This shared-root support is an alpha migration boundary item that survives only until beta. Do not build new setup or runtime behavior that depends on shared-root fallback.

### Production / split roots

- Set `PSFN_RUNTIME_LAYOUT_MODE=production`.
- Set both `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR`, or neither.
- Production layout defaults under `./runtime/production/` if explicit dirs are not provided.
- Shared `DATA_DIR` is forbidden in production mode.

Production does not fall back to local/continuous layout. Partial split-root config, overlapping roots, malformed owner files, and mutable settings in `.env` should be fixed directly rather than papered over with compatibility paths.

### Multi-companion (optional)

Multi-companion is an opt-in topology and is off by default. When you enable it,
these process-wiring env vars come into play (documented in full in
[`docs/multi-companion.md`](./multi-companion.md) and
[`docs/operations.md`](./operations.md)):

- `PSFN_MULTI_COMPANION` — topology opt-in. When on, a system-owned
  `companions.json` fleet manifest is required; when off, `companions.json` must
  be absent. Both mismatches fail closed at startup.
- `COMPANION_PG_SCHEMA` — per-companion Postgres schema for a single agent
  process. Explicit opt-in, not derived from `COMPANION_ID`; unset means the
  `public` schema (single-companion). The supervisor launcher sets this per
  spawned agent from the fleet manifest.
- `PSFN_RUNTIME_ROOT` — canonical persistence root for manifest-relative
  `companionDataDir` and `characterCardPath`. The fleet resolver emits absolute
  paths beneath this root and rejects traversal or symlink escapes.
- `FLEET_STATUS_PORT` / `FLEET_STATUS_HOST` — the gateway's read-only,
  raw loopback-only fleet-status operator listener (host defaults to
  `127.0.0.1`). It is a separate opt-in HTTP listener with no browser-session
  authentication, not the authenticated HTTPS `/fleet` portal. Setting the
  port while `PSFN_MULTI_COMPANION` is off or selecting a wildcard, public, or
  ambiguous host fails closed. Never publish or tunnel it without an
  independent authentication boundary and private network policy. Rollback is
  to remove both variables from repository-owned runtime wiring and restart the
  gateway; the authenticated portal remains available.
- Per-companion Discord tokens are referenced by env-var name from
  `channels.json` (`tokenRef.envName`), not inline. Add each companion's bot
  token to `.env` under the env var name its account references (for example
  `DISCORD_TOKEN_ARIA`); the token secret stays gateway-owned.

Leave the multi-companion topology variables unset for the default topology.
The standard launcher derives and injects role-bound gateway authentication
proofs in both topologies so the isolated session-integrity worker never shares
the normal agent role. A direct `npm run agent` launch must provide
`GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN`; in multi-companion mode it must also
provide the exact fleet tuple and `GATEWAY_COMPANION_AUTH_TOKEN`.

If an existing split fleet still has any registered per-companion owner under
`SYSTEM_DATA_DIR`—including `scheduler.json`, `capability-tier.json`,
`charge-policy.json`, or `skills.json`—do not copy the shared system file into
one companion by hand and do not point `migrate:persistence-layout` at
`SYSTEM_DATA_DIR`. Stop the fleet and use the digest-approved,
receipt-bearing `npm run migrate:system-owner-fleet` workflow documented in
[`docs/operations.md`](./operations.md#existing-split-fleets-with-shared-per-companion-owners).
Before apply, mount every exact manifest root and run
`npm run snapshot:system-owner-fleet -- --output <backup-family-dir>`; a missing
root is a hard preflight failure and is never created by migration. Rehearse an
old-release rollback only into fresh empty PVC roots with
`npm run restore:system-owner-fleet-snapshot -- --manifest <family-manifest> --restore-runtime-root <fresh-root>`.
It enumerates every configured companion and retires the shared source only
after every exact-byte destination verifies, by moving the approved inode into
the durable receipt-owned quarantine. Its bootstrap receipt owns unpredictable
quarantine, staging, and copy identifiers before those objects are created, and
retries preserve rather than delete unbound or replaced crash remnants. Do not
remove the quarantine or retained staging artifacts manually; they are part of
deterministic receipt verification and retry.

For a multi-release Helm upgrade, run that command once from the repo-owned
maintenance environment with all manifest PVC roots mounted, then require
`npm run preflight:startup-owner-files` to pass before upgrading any individual
release. Keep `bootstrap.seedOwnerFiles=false` throughout the upgrade. Rolling
back to a pre-routing release requires restoring the verified pre-migration
backup of system-data and every companion-data root together, never copying a
quarantined shared owner into selected companions.

### Multi-companion workspaces

Do not set per-companion workspace paths in `companions.json`. The fleet
resolver derives `<runtime-root>/workspaces/personal/<companion-uuid>` and the
single `<runtime-root>/workspaces/shared` root, validates containment and
non-overlap, and provisions them before launch. Each agent and its Garden
receive only the matching personal root as `WORKSPACE_PATH`. The shared root is
available through its authenticated, reviewed Garden surface and has no
environment-variable escape hatch. See
[`docs/multi-companion.md`](./multi-companion.md#workspace-scopes-current-behavior-and-target-contract).

The Helm deployment reads the isolated-worker proof from the application
Secret key named by `secrets.keys.gatewaySessionIntegrityAuthToken` (default
`GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN`). Derive it for the configured
`COMPANION_ID` with the same gateway HMAC keyring used by the gateway, and
provision it without logging the token. It is a distinct role-bound proof, not
the raw `GATEWAY_SESSION_HMAC_KEY` and not the normal companion-agent proof.
The agent derives a separate Garden audit opaque-ID key from this proof with a
domain-separated one-way transform. Rotating the worker proof changes the
opaque IDs returned by Garden but does not alter or discard the audit records.

## Common Launch Commands

```bash
npm run split        # gateway + agent + operator launcher
npm run yolo         # split runtime with broader fs.read policy
npm run gateway      # gateway only
npm run agent        # agent only (companion loop + private admin transport)
npm run operator     # Garden operator surface only
npm run agent:docker          # Production profile (network_mode: "none")
npm run agent:docker:continuous # Continuous/dev profile (isolated internal network)
```

## Optional Surface Wiring

### Fleet-authenticated browser origin

When the system-owned `fleet-auth.json` is present and `PSFN_FLEET_AUTH=1`, do
not publish `ADMIN_HOST`/`ADMIN_PORT` as a browser endpoint. Terminate HTTPS at
the exact `canonicalOrigin`, route the full origin to the gateway API listener,
and open `/fleet`. This is the authenticated bounded portal and is unrelated to
the raw `FLEET_STATUS_PORT` listener even though that loopback-only listener
retains its legacy `GET /fleet` alias. A direct TLS listener must receive no
forwarding headers. A single reverse proxy requires
`FLEET_SSO_TRUST_PROXY=true`, exact forwarded
host/proto metadata, and an independent network restriction that admits only
that proxy. Non-loopback gateway-to-Garden traffic must configure the complete
`FLEET_SSO_GARDEN_TLS_*` mTLS tuple; partial configuration fails startup.
For Helm fleet mode, keep `networkPolicy.enabled=true`,
`hostPorts.gatewayApi.enabled=false`, `ingress.gateway.path=/`, and
`ingress.gateway.pathType=Prefix`; the chart rejects fleet auth if any of these
sole-origin requirements is weakened. The chart never wires the raw
`FLEET_STATUS_PORT` listener into the public workload.

The optional static Companion UI may be registered with
`FLEET_SSO_COMPANION_UI_ORIGIN`. If the fleet has more than one companion, also
set `FLEET_SSO_COMPANION_UI_COMPANION_ID` to one exact registered UUID. It is
then available only at authenticated `/companion-ui/`; the configured origin is
internal wiring, never a second browser edge.

### Garden operator surface + public API

```dotenv
ADMIN_HOST=127.0.0.1
ADMIN_PORT=3001
ADMIN_TOKEN=...

API_HOST=127.0.0.1
API_PORT=3000
API_KEY=...

# optional private agent/operator transport override
ADMIN_TRANSPORT_SOCKET=./runtime/sockets/garden-admin.sock
```

With fleet auth disabled, `admin-ui/build` is served from the internal or
loopback admin host root, for example `http://127.0.0.1:3001/`. With fleet auth
enabled, the same Garden is reachable only through
`/companions/<companion-uuid>/garden/` on the canonical gateway HTTPS origin;
`ADMIN_TOKEN` and `ADMIN_ALLOW_INSECURE` are rejected on that operator process.
The repo launcher also scrubs those legacy variables from the fleet-auth
gateway and keeps proxy trust and raw fleet-status wiring gateway-owned; child
agent/operator allowlists do not inherit them.

### Discord voice

```dotenv
DISCORD_VOICE_ENABLED=true
DISCORD_VOICE_GUILD_ID=...
DISCORD_VOICE_USER_ID=...
DEEPGRAM_API_KEY=...
ELEVENLABS_API_KEY=...
```

Provider selection and tuning stay in `settings.json`.

### Satellite Hub Endpoints

Wyoming/OpenHome endpoint transports live in the Satellite Hub repository. Configure endpoint host/port/runtime wiring there, then configure PSFN's `satellites.json` registry for claim-validated hub/API traffic.

Satellite authentication has two layers:

- **Per-satellite bearer keys**: set `API_SATELLITE_KEYS` (comma-separated, each >=16 chars). Each key yields a distinct satellite-scoped principal id that the matching `satellites.json` endpoint must list in `auth.apiKeyPrincipalIds`. Satellite keys are only valid on satellite surfaces.
- **Fleet-auth Hub devices**: each device-facing endpoint must declare a strict
  `hubDeviceEnrollment` with `deviceId`, positive `enrollmentVersion`, and
  `enrollmentStatus` (`active` or `revoked`). The authenticated Hub key selects
  the endpoint; the gateway then binds the signed assertion to this enrollment,
  the API surface's companion, the authenticated Hub session, and the
  satellite's optional `placeId` before a turn can enter the agent runtime.
- **Mutual TLS**: satellite client-cert identity is bound to the API listener's real TLS peer certificate (or to `X-PSFN-Client-Cert-*` headers only behind a trusted proxy presenting `API_TRUSTED_PROXY_CLIENT_CERT_TOKEN`). Certificate issuance, renewal, and revocation run through the cert-manager sidecar (`npm run cert-manager`, `src/app/cert-manager/`) — see [`docs/certificates.md`](./certificates.md) for the full bootstrap.

## Sanity Checks

Use the smallest set that proves your setup:

```bash
npm run lint
npm run build
npm run smoke:chat
npm run verify:settings-contract
npm run verify:agent-docker-isolation
```
