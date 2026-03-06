# Runtime Mode Runbook

This runbook defines the split operational flows for:

- `continuous` runtime (dev/ongoing iteration)
- `production` runtime (isolated deploy)

## 1. Directory Contract

Continuous runtime defaults:

- `DATA_DIR=./data`
- `WORKSPACE_PATH=./workspace`

Production runtime defaults:

- `SYSTEM_DATA_DIR=./runtime/production/system-data`
- `COMPANION_DATA_DIR=./runtime/production/companion-data`
- `WORKSPACE_PATH=./runtime/production/workspace`
- `PSFN_LOGS_DIR=./runtime/production/logs`
- `PSFN_TEMP_DIR=./runtime/production/tmp`
- `BACKUP_ROOT_DIR=./runtime/production/backups`

Do not point production paths at `./data` or `./workspace`.

## 2. Container Boot

Continuous/dev stack:

```bash
docker compose -f docker/docker-compose.yml up --build -d
```

Production stack:

```bash
docker compose -f docker/docker-compose.production.yml up --build -d
```

Syntax validation before boot:

```bash
docker compose -f docker/docker-compose.yml config
docker compose -f docker/docker-compose.production.yml config
```

## 3. Restart / Rebuild Flows

The lifecycle scripts now require explicit runtime mode to prevent cross-mode restarts.

Continuous:

```bash
./scripts/self/restart.sh --mode continuous
./scripts/self/rebuild.sh --mode continuous
```

Production:

```bash
./scripts/self/restart.sh --mode production
./scripts/self/rebuild.sh --mode production
```

Optional explicit PID file / start command:

```bash
./scripts/self/restart.sh --mode production ./runtime/production/companion-data/psfn.pid "PSFN_RUNTIME_LAYOUT_MODE=production npm run start"
```

## 4. Backups

Continuous:

- default backup root: `./data/backups`

Production:

- default backup root: `./runtime/production/backups`

Quick check:

```bash
ls -la ./runtime/production/backups
```

## 5. Rollback

When running watchdog rollback with production mode, ensure restart command keeps production layout mode:

```bash
export AUTO_ROLLBACK=true
export ROLLBACK_RESTART_CMD="PSFN_RUNTIME_LAYOUT_MODE=production npm run start"
```

If rollback is invoked, verify:

1. runtime process starts with production paths
2. no writes occur in `./data` or `./workspace`

## 6. Operational Guards

- Never run `docker-compose.production.yml` with continuous mount env vars.
- Never run lifecycle restart scripts without `--mode`.
- Validate both compose files after edits.
- Keep secrets in env/secret stores; keep mutable config in JSON owners.
