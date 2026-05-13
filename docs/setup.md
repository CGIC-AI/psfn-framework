# Setup

PSFN boots through the split runtime. The legacy `src/app/startup/index.ts` entrypoint is disabled and exits fail-closed; use `npm run split` for the full gateway + agent + operator stack, or launch `npm run gateway`, `npm run agent`, and `npm run operator` individually.

## Prerequisites

- Node.js 22+
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
cd psfn-live
npm install
cp .env.example .env
```

The root install also provisions `admin-ui/`.

## What Goes In `.env`

Keep `.env` limited to:

- Secrets
- Host, port, and socket wiring
- Runtime mode and persistence layout wiring
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

Startup requires these files to exist. Distributed `config/*.seed.json` files are examples/templates only; PSFN does not silently copy them into runtime state.

## First Local Bring-Up

1. Set the minimum bootstrap values in `.env`:

   ```dotenv
   OPENROUTER_API_KEY=...
   COMPANION_ID=companion
   CHARACTER_CARD_PATH=./data/character.json
   DATA_DIR=./data
   DATABASE_PATH=./data/companion.db
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

3. Provide the explicit character card at `CHARACTER_CARD_PATH`. Startup fails if the configured identity file is missing.

4. Start the split runtime (gateway + agent + operator):

   ```bash
   npm run split
   ```

   The launcher loads `.env` for gateway/operator processes, then starts the agent with a curated non-secret environment allowlist. Provider credentials, API keys, and admin tokens stay gateway/operator-owned.

5. If you want the integrated Garden SPA served by the admin host, build it once:

   ```bash
   npm run garden:build
   ```

6. If you want the standalone Garden dev server instead:

   ```bash
   npm run garden:dev
   ```

## Runtime Modes

### Continuous / local

- Default mode when `PSFN_RUNTIME_LAYOUT_MODE` is unset.
- Uses the legacy shared root (`DATA_DIR`, default `./data`) for both system and companion data.
- Good for local development and smoke testing.
- This shared-root support is an alpha migration boundary item that survives only until beta. Do not build new setup or runtime behavior that depends on shared-root fallback.

### Production / split roots

- Set `PSFN_RUNTIME_LAYOUT_MODE=production`.
- Set both `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR`, or neither.
- Production layout defaults under `./runtime/production/` if explicit dirs are not provided.
- Shared `DATA_DIR` is forbidden in production mode.

Production does not fall back to local/continuous layout. Partial split-root config, overlapping roots, malformed owner files, and mutable settings in `.env` should be fixed directly rather than papered over with compatibility paths.

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

### Wyoming

```dotenv
WYOMING_ENABLED=true
WYOMING_HOST=127.0.0.1
WYOMING_PORT=10400
```

## Sanity Checks

Use the smallest set that proves your setup:

```bash
npm run lint
npm run build
npm run smoke:chat
npm run verify:settings-contract
npm run verify:agent-docker-isolation
```
