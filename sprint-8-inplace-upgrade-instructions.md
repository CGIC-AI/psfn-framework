# Sprint 8 In-Place Upgrade Instructions

Purpose: move the live `psfn-live` deployment onto Sprint 8 code without hiding runtime authority in off-repo files or relying on startup seed fallbacks.

## Before touching the live process

1. Stop the live runtime cleanly from its repo-owned supervisor path.
2. Confirm the live repo is the one being upgraded: `/mnt/samesung/ai/psfn-live`.
3. Back up the current live tree, especially `.env`, `data/`, `purrsephone/`, `config/`, and any repo-owned supervisor files.
4. Confirm `.env` has an explicit `COMPANION_ID`. For the current live companion this should normally be `purrsephone`.
5. Confirm either both split layout roots are set or neither is set:
   ```bash
   grep -E '^(SYSTEM_DATA_DIR|COMPANION_DATA_DIR|DATA_DIR|COMPANION_ID)=' .env
   ```
   Startup now fails closed if only one of `SYSTEM_DATA_DIR` or `COMPANION_DATA_DIR` is set.

## Owner-file upgrade

Sprint 8 removed silent owner-file seed fallback. The live data root must contain explicit JSON owner files before startup.

Expected owner files:

```text
settings.json
models.json
providers.json
scheduler.json
capability-tier.json
skills.json
trust-policy.json
backup.json
charge-policy.json
```

If a file is missing, seed it intentionally from `config/*.seed.json` into the live system-owned data directory. Do not depend on startup to copy seeds.

Example with the existing single `DATA_DIR` layout:

```bash
export COMPANION_ID=purrsephone
export DATA_DIR=/mnt/samesung/ai/psfn-live/data

cp -n config/settings.seed.json "$DATA_DIR/settings.json"
cp -n config/models.seed.json "$DATA_DIR/models.json"
cp -n config/providers.seed.json "$DATA_DIR/providers.json"
cp -n config/scheduler.seed.json "$DATA_DIR/scheduler.json"
cp -n config/capability-tier.seed.json "$DATA_DIR/capability-tier.json"
cp -n config/skills.seed.json "$DATA_DIR/skills.json"
cp -n config/trust-policy.seed.json "$DATA_DIR/trust-policy.json"
cp -n config/backup.seed.json "$DATA_DIR/backup.json"
cp -n config/charge-policy.seed.json "$DATA_DIR/charge-policy.json"
```

For split layout, use the configured `SYSTEM_DATA_DIR` for owner files and `COMPANION_DATA_DIR` for companion state. Do not let those roots overlap.

Verify before restart:

```bash
COMPANION_ID=purrsephone DATA_DIR=/mnt/samesung/ai/psfn-live/data npm run verify:startup-owner-files
```

If the live deployment uses split roots, run the same check with the live `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR` exported instead of `DATA_DIR`.

## Code and dependency upgrade

From `/mnt/samesung/ai/psfn-live`:

```bash
git fetch origin
git status --short --branch
npm install
npm run build
npm run garden:build
npm run verify:settings-contract
```

Do not overwrite local live data changes with git cleanup commands. If `git status` shows unrelated local edits, inspect them and decide whether they are live state, intentional local config, or stale files before pulling/resetting.

## First restart checks

After restart, check for fail-closed errors first:

```text
COMPANION_ID is required
SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set
Production layout roots must not overlap
Missing required owner file
Unknown owner-file/provider/config key
```

Then open Garden and verify the Sprint 8 operator surfaces:

- Settings: owner-file-backed settings load, save, and show authority hints.
- Charge / Budget: charge policy, run ledgers, long-window cost views, and lane quotas are visible.
- L0.1 Episodes: episodic memories and linked arcs render from the real store.
- Action Pipe: queue depth, retries, quarantine, failures, cancellations, acknowledgements, and subagent outcomes are visible.
- Tools: tool inventory and health still load after the action-pipe/nav additions.

## Rollback

If startup fails after owner-file verification, keep the process stopped and inspect the exact fail-closed message. Do not add off-repo env overrides to make the service start.

Rollback is:

1. Stop the process.
2. Restore the pre-upgrade repo/data backup.
3. Restore the previous repo-owned supervisor artifact if one changed.
4. Restart.
5. Record the failing owner file or Garden surface as a tracked bead before retrying.
