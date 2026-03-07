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

## 2. Preflight Setup

Create mode-specific directories before booting compose stacks (bind mounts fail closed when paths are missing):

```bash
mkdir -p runtime/continuous/{system-data,companion-data,workspace,logs,tmp,backups}
mkdir -p runtime/production/{system-data,companion-data,workspace,logs,tmp,backups}
```

Confirm no cross-mode path overlap:

```bash
realpath runtime/continuous
realpath runtime/production
```

## 3. Container Boot

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

## 4. Restart / Rebuild Flows

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

Production-mode safeguards now enforced by scripts:

- `--mode production` rejects PID paths under `./data` and requires `PSFN_RUNTIME_LAYOUT_MODE=production` in custom start commands.
- `--mode continuous` rejects PID paths under `./runtime/production`.
- Graceful stop paths (`SIGINT`, `SIGTERM`, and runtime `stop()`) now send a shutdown notification through lifecycle notifier channels.
- `self_restart` / `self_rebuild` still send pre-restart notification first and suppress the generic shutdown message to avoid duplicate operator alerts.

## 5. Backups

Continuous:

- default backup root: `./data/backups`

Example:

```bash
tar -czf ./data/backups/continuous-$(date +%Y%m%d-%H%M%S).tgz ./data ./workspace
```

Production:

- default backup root: `./runtime/production/backups`

Example:

```bash
tar -czf ./runtime/production/backups/production-$(date +%Y%m%d-%H%M%S).tgz ./runtime/production
```

Quick check:

```bash
ls -la ./runtime/production/backups
```

Scheduled backup artifacts are structured as:

- `<backup-root>/<timestamp>/database/<sqlite-file>`
- `<backup-root>/<timestamp>/sessions/*.jsonl`

Restore verification defaults to enabled (`BACKUP_VERIFY_RESTORE=true`) and rehearses a restore plus SQLite integrity check for each scheduled backup cycle.

Manual restore verification smoke:

```bash
npm run verify:backup-restore -- --backup-root ./runtime/production/backups
```

Expected output includes `"verified": true` and `"integrityDetails": ["ok"]`.

## 6. Rollback

Production rollback flow:

1. Stop runtime with explicit production mode.
2. Restore from the desired backup artifact.
3. Restart with production mode and production layout env.
4. Verify writes stay in `./runtime/production/*`.

Example:

```bash
./scripts/self/restart.sh --mode production ./runtime/production/companion-data/psfn.pid "echo rollback-stop"
tar -xzf ./runtime/production/backups/<backup-file>.tgz -C .
./scripts/self/restart.sh --mode production ./runtime/production/companion-data/psfn.pid "PSFN_RUNTIME_LAYOUT_MODE=production npm run start"
```

When using watchdog auto-rollback, ensure restart command keeps production layout mode:

```bash
export AUTO_ROLLBACK=true
export ROLLBACK_RESTART_CMD="PSFN_RUNTIME_LAYOUT_MODE=production npm run start"
```

If rollback is invoked, verify:

1. runtime process starts with production paths
2. no writes occur in `./data` or `./workspace`

## 7. Operational Guards

- Never run `docker-compose.production.yml` with continuous mount env vars.
- Never run lifecycle restart scripts without `--mode`.
- Never pass a production start command to `--mode continuous`.
- Validate both compose files after edits.
- Keep secrets in env/secret stores; keep mutable config in JSON owners.

## 8. Verification Commands

Run these after operational changes:

```bash
docker compose -f docker/docker-compose.yml config
docker compose -f docker/docker-compose.production.yml config
./scripts/self/restart.sh --mode continuous --help
./scripts/self/restart.sh --mode production --help
./scripts/self/rebuild.sh --mode continuous --help
./scripts/self/rebuild.sh --mode production --help
npm run verify:backup-restore -- --backup-root ./runtime/production/backups
```
