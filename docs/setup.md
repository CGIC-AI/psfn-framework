# Setup

PSFN now boots through the split runtime. `src/index.ts` only validates the runtime mode contract and exits; use `npm run dev`, `npm run split`, `npm run gateway`, or `npm run agent`.

## Prerequisites

- Node.js 22+
- One provider secret for the model/provider seed you plan to use. A fresh install usually means `OPENROUTER_API_KEY`.
- Optional channel/service secrets only for the surfaces you enable:
  - `DISCORD_TOKEN` and `DISCORD_BOT_ID`
  - `TELEGRAM_BOT_TOKEN`
  - `API_KEY`
  - `ADMIN_TOKEN`
  - `DEEPGRAM_API_KEY`
  - `ELEVENLABS_API_KEY`

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
- `backup.json`

On first boot, PSFN seeds these from `config/*.seed.json` where applicable.

## First Local Bring-Up

1. Set the minimum bootstrap values in `.env`:

   ```dotenv
   OPENROUTER_API_KEY=...
   CHARACTER_CARD_PATH=./data/character.json
   DATA_DIR=./data
   DATABASE_PATH=./data/companion.db
   ```

2. Start the split runtime:

   ```bash
   npm run dev
   ```

3. If you want the integrated Garden SPA served by the admin host, build it once:

   ```bash
   npm run garden:build
   ```

4. If you want the standalone Garden dev server instead:

   ```bash
   npm run garden:dev
   ```

## Runtime Modes

### Continuous / local

- Default mode when `PSFN_RUNTIME_LAYOUT_MODE` is unset.
- Uses the legacy shared root (`DATA_DIR`, default `./data`) for system and companion data.
- Good for local development and smoke testing.

### Production / split roots

- Set `PSFN_RUNTIME_LAYOUT_MODE=production`.
- Set both `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR`, or neither.
- Production layout defaults under `./runtime/production/` if explicit dirs are not provided.
- Shared `DATA_DIR` is forbidden in production mode.

## Common Launch Commands

```bash
npm run dev          # gateway + agent launcher
npm run split        # same as dev
npm run yolo         # split runtime with broader fs.read policy
npm run gateway      # gateway only
npm run agent        # agent only
npm run agent:docker # production containerized agent
```

## Optional Surface Wiring

### Admin + API

```dotenv
ADMIN_HOST=127.0.0.1
ADMIN_PORT=3001
ADMIN_TOKEN=...

API_HOST=127.0.0.1
API_PORT=3000
API_KEY=...
```

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
```
