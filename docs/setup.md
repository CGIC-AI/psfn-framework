# Setup

PSFN boots through the split runtime. The legacy `src/app/startup/index.ts` entrypoint is disabled and exits fail-closed; use `npm run split` for the full gateway + agent + operator stack, or launch `npm run gateway`, `npm run agent`, and `npm run operator` individually.

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

The runtime ignores mutable settings that are owned by JSON files. Do not use `.env` for embeddings, model roster, scheduler cadence, capability tier, channel policy, skills, or trust policy.

## What Goes In JSON Owner Files

Mutable runtime/admin configuration lives under the system-data config domain:

- `settings.json`
- `models.json`
- `providers.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`
- `charge-policy.json`
- `backup.json`

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

2. Intentionally copy the example owner files into the system data directory and edit them for this deployment:

   ```bash
   cp config/settings.seed.json ./data/settings.json
   cp config/models.seed.json ./data/models.json
   cp config/providers.seed.json ./data/providers.json
   cp config/scheduler.seed.json ./data/scheduler.json
   cp config/capability-tier.seed.json ./data/capability-tier.json
   cp config/trust-policy.seed.json ./data/trust-policy.json
   cp config/charge-policy.seed.json ./data/charge-policy.json
   cp config/backup.seed.json ./data/backup.json
   cp config/skills.seed.json ./data/skills.json
   ```

3. Provide the explicit character card at `CHARACTER_CARD_PATH`. Startup fails if the configured identity file is missing. Keep this active identity file under runtime data, not under the personal writable workspace.

4. Keep the backup encryption key secret in `.env` or your deployment secret manager. `backup.json` should contain only the env key reference. Generate a local key with `openssl rand -base64 48`.

5. Start the split runtime (gateway + agent + operator):

   ```bash
   npm run split
   ```

   The launcher loads `.env` for gateway/operator processes, then starts the agent with a curated non-secret environment allowlist. Provider credentials, API keys, and admin tokens stay gateway/operator-owned.

6. If you want the integrated Garden SPA served by the admin host, build it once:

   ```bash
   npm run garden:build
   ```

7. If you want the standalone Garden dev server instead:

   ```bash
   npm run garden:dev
   ```

## Runtime Modes

### Continuous / local

- Default mode when `PSFN_RUNTIME_LAYOUT_MODE` is unset.
- Uses the legacy shared root (`DATA_DIR`, default `./data`) for both system and companion data.
- Uses `WORKSPACE_PATH` as the personal files root for documents, downloads, generated images, journal/scratchpad files, knowledge-base notes, authored skills, modules, and experiments. In the live Purrsephone deployment this is repo-root `./purrsephone`.
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
- `FLEET_STATUS_PORT` / `FLEET_STATUS_HOST` — the gateway's read-only,
  loopback-only fleet-status page (host defaults to `127.0.0.1`). Setting the
  port while `PSFN_MULTI_COMPANION` is off fails closed.
- Per-companion Discord tokens are referenced by env-var name from
  `channels.json` (`tokenRef.envName`), not inline. Add each companion's bot
  token to `.env` under the env var name its account references (for example
  `DISCORD_TOKEN_ARIA`); the token secret stays gateway-owned.

Leave all of these unset for the default single-companion topology.

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

When `admin-ui/build` is present, Garden is served from the admin host root, for example `http://127.0.0.1:3001/`. There is no `/garden` prefix on the integrated SPA route.

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

## Sanity Checks

Use the smallest set that proves your setup:

```bash
npm run lint
npm run build
npm run smoke:chat
npm run verify:settings-contract
npm run verify:agent-docker-isolation
```
