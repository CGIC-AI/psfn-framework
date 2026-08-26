#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
[[ -f "$repo_root/package-lock.json" ]] || exit 0

exec "$repo_root/scripts/ci/run-repository-node.sh" \
  "$repo_root" "$repo_root/scripts/ci/bootstrap-worktree.mjs" "$repo_root"
