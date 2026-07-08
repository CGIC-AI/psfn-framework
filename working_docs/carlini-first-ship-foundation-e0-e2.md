# Carlini first ship on the ship:kube pipeline — foundation_e0_e2

Date drafted: 2026-07-06. Target: `o_0@100.96.206.29` (`miniforum01`, amd64,
k3s, namespace `psfn`). Carlini live baseline: helm rev 15, image
`0.1.0-kube-55be96f8` (2026-07-02), ~94 commits behind this ship.

**BLOCKED ON ACCESS**: no workstation key is authorized for
`o_0@100.96.206.29` (all of `~/.ssh/id_ed25519`, `id_rsa`,
`fox_failspark_ssh` refused; Pi fallback password refused). Operator must
authorize a key first, e.g.:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub o_0@100.96.206.29   # will prompt for the o_0 password
# optional alias (then use --host carlini below):
printf '\nHost carlini\n  HostName 100.96.206.29\n  User o_0\n  IdentityFile ~/.ssh/id_ed25519\n' >> ~/.ssh/config
```

`scripts/ops/ship-kube-update.sh` is multi-target as of psfn-framework-jn72:
it probes the node arch (→ builds linux/amd64 for miniforum01), stages under
`/home/o_0/psfn-kube-runtime`, and forwards `--host`/`--namespace` to the
gate and beads sync.

## Pre-ship (one-time, section 3b of psfn-live-ops)

1. **SSA strategy pre-patch** — Carlini's deployments were created under
   RollingUpdate; the chart now demands Recreate:

   ```bash
   for d in psfn-agent psfn-gateway psfn-garden; do
     ssh carlini "sudo k3s kubectl -n psfn patch deploy $d --type=merge \
       -p '{\"spec\":{\"strategy\":{\"type\":\"Recreate\",\"rollingUpdate\":null}}}'"
   done
   ```

2. **LiteLLM route audit** — pull Carlini's `models.json`
   (`/app/system-data/models.json` in any app pod) and compare every
   provider=litellm slot against the chart's explicit unprefixed route list
   (`deploy/helm/psfn/values.yaml` liteLlm config — currently Purrsephone's
   six models). Any Carlini slot missing a route silently falls back to
   direct OpenRouter. If Carlini's set differs, ship with a
   `--values-overlay` that owns Carlini's route list.

3. **ConfigMap ownership** — if Carlini's litellm ConfigMap was ever
   `kubectl replace`d, fold the live content into the overlay FIRST (else
   the upgrade reverts the hotfix), then
   `ssh carlini "sudo k3s kubectl -n psfn delete configmap <litellm-cm>"`
   immediately before the ship so helm re-creates and owns it.

4. **Owner-file spot check** — new scheduler blocks since 55be96f8
   (`reflectionNovelty`, `temporalWakeup.wakeSummary`, `freeTime.returnNote`)
   all default cleanly when absent — verified in scheduler-config.ts. No
   migration needed. `observerEvalSidecar` sessionLabel/agentName are only
   required for `emosim_server` adapter (Carlini: disabled). The 55be96f8
   scheduler migration (sleeptime removal) is already done on Carlini.

## Ship

First ship MUST be full stack (live images predate the contract hash — the
guard will demand it anyway):

```bash
npm run ship:kube -- --host carlini --components all
```

Gate runs automatically. If the smoke 503s right after the rollout, wait
~90s (agent's by-design second restart) and rerun:

```bash
PSFN_KUBE_HOST=carlini npm run verify:kube-rollout -- --remote --host carlini --expect-tag 0.1.0-kube-<shortsha> --smoke
```

Verify `/v1/models` returns `carlini`, and `model_usage_events` shows
`requested_provider == provider` for litellm slots.

## Post-ship enablement (operator-approved scope for Carlini)

Companion self-management, same shape as Purrsephone's (skill section 3b
items 5–6): host source checkout via git bundle (suggest
`/home/o_0/psfn-source`; `chown -R 999:999` + host
`git config --system --add safe.directory <path>`), values overlay enabling
`repositoryCheckout` + `beads` (keep `close`/`sync` out of
BEADS_ALLOW_ACTIONS), in-pod `bd init --prefix psfn-framework` +
`bd import <shared-export>` in `/app/workspace`, `bd metrics off`,
`bead-authoring` skill to `<workspace>/skills/bead-authoring/SKILL.md`
chown 999:999 (hot-loads, no restart). Set
`PSFN_SOURCE_CHECKOUT=/home/o_0/psfn-source` on future ships so the bundle
refresh reaches Carlini's checkout.

Off-node backups for miniforum01 (psfn-backup.sh equivalent + a validity
gate) are NOT covered here — separate bead; the frozen-DB trap from the Pi
applies: the script must `pg_restore --list` its own dump or fail the unit.
