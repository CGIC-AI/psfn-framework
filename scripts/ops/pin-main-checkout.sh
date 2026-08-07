#!/usr/bin/env bash
# Keep the shared checkout pinned to origin/main.
#
# Contract: this directory is a main mirror. Side work belongs in worktrees
# under ~/ai/dev/worktrees/psfn-framework, never here. This script fast-forwards
# main only when the checkout is exactly on main, clean (ignoring untracked
# tool/audit files), and not mid-merge/cherry-pick/rebase. Any other state —
# local commits, a parked branch, conflicts, staged work — makes it skip with a
# log line, because that state is a signal a human needs to resolve, not
# something to plow through.
#
# Usage: pin-main-checkout.sh [repo-dir]
# Cron example: 7-57/10 * * * * $HOME/psfn-framework/scripts/ops/pin-main-checkout.sh
set -euo pipefail

REPO="${1:-$HOME/psfn-framework}"
LOG="${PIN_MAIN_LOG:-$REPO/.git/pin-main.log}"

log() { printf '%s %s\n' "$(date -Is)" "$1" >>"$LOG"; }

cd "$REPO"

# Serialize with any other instance of this script.
exec 9>"$REPO/.git/pin-main.lock"
flock -n 9 || exit 0

branch="$(git symbolic-ref --short -q HEAD || true)"
if [ "$branch" != "main" ]; then
  log "SKIP: on branch '$branch', not main"
  exit 0
fi

if [ -e .git/MERGE_HEAD ] || [ -e .git/CHERRY_PICK_HEAD ] || [ -e .git/REBASE_HEAD ] \
  || [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  log "SKIP: merge/cherry-pick/rebase in progress"
  exit 0
fi

# Tracked modifications or staged changes block the sync; untracked files do not.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "SKIP: dirty tracked files or staged changes"
  exit 0
fi

git fetch --prune --quiet origin

local_head="$(git rev-parse main)"
remote_head="$(git rev-parse origin/main)"
if [ "$local_head" = "$remote_head" ]; then
  exit 0
fi

if git merge-base --is-ancestor "$local_head" "$remote_head"; then
  git merge --ff-only --quiet origin/main
  log "SYNCED: ${local_head:0:9} -> ${remote_head:0:9}"
else
  log "SKIP: local main has diverged from origin/main (local commits present); rebase manually"
fi
