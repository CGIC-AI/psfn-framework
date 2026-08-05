#!/usr/bin/env bash
# Push the latest source branch (default: origin/main) into a companion's
# in-pod repo checkout whenever the head has moved.
#
#   scripts/ops/sync-companion-source.sh                # sync if changed
#   scripts/ops/sync-companion-source.sh --local        # force direct kubectl (cluster on this host)
#   scripts/ops/sync-companion-source.sh --check        # report drift only, change nothing
#   scripts/ops/sync-companion-source.sh --check-config # validate target offline
#
# Why: the companion's pod has no network egress, so her checkout (seeded once
# from a git bundle over kubectl cp) cannot fetch for itself. This script runs
# where kubectl and the canonical checkout are both reachable, ships only the
# missing history as an incremental bundle, and fast-forwards her checkout.
# Workstation-initiated, same trust shape as sync-companion-beads.sh: the
# cluster never opens a connection back, and her copy simply goes stale when
# this box is offline.
#
# Fail-closed refresh: fast-forward only (no reset --hard), and it refuses to
# move her branch when tracked files are dirty or history has diverged, so
# local commits and untracked work are never discarded. Bundles are removed on
# every path via traps.
#
# Required config (environment or scripts/ops/private-ops.env):
#   PSFN_COMPANION_ID          companion UUID; selects pod psfn-agent-<id>-*
# Optional:
#   PSFN_NAMESPACE             default psfn
#   PSFN_SOURCE_BRANCH         default main
#   PSFN_REPOSITORY_CHECKOUT   default: the checkout containing this script
#   PSFN_COMPANION_REPO_PATH   default /runtime/workspaces/personal/<id>/psfn-framework
#   PSFN_HOST_ALIAS            when set, kubectl runs over this SSH lane
#
# Bead: psfn-framework-hkwl9
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/load-private-ops-config.sh
source "$SCRIPT_DIR/load-private-ops-config.sh"
load_private_ops_config "$SCRIPT_DIR"

NAMESPACE="${PSFN_NAMESPACE:-psfn}"
BRANCH="${PSFN_SOURCE_BRANCH:-main}"
HOST_ALIAS="${PSFN_HOST_ALIAS:-}"
REPO="${PSFN_REPOSITORY_CHECKOUT:-$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel)}"
CHECK_ONLY=0
CHECK_CONFIG=0

case "${1:-}" in
  --local) HOST_ALIAS="" ;;
  --check) CHECK_ONLY=1 ;;
  --check-config) CHECK_CONFIG=1 ;;
  "") ;;
  -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 1 ;;
esac

require_private_ops_value PSFN_COMPANION_ID "private config"
COMPANION_ID="${PSFN_COMPANION_ID}"
POD_REPO_PATH="${PSFN_COMPANION_REPO_PATH:-/runtime/workspaces/personal/${COMPANION_ID}/psfn-framework}"

if [[ $CHECK_CONFIG -eq 1 ]]; then
  printf 'configuration valid: namespace=%s branch=%s repo=%s pod-path=%s\n' \
    "$NAMESPACE" "$BRANCH" "$REPO" "$POD_REPO_PATH"
  exit 0
fi

# kubectl, optionally over the SSH lane. printf %q keeps argument boundaries
# intact when the remote shell re-parses the command line.
kctl() {
  if [[ -n "$HOST_ALIAS" ]]; then
    # shellcheck disable=SC2046
    ssh "$HOST_ALIAS" "sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n $NAMESPACE $(printf '%q ' "$@")"
  else
    kubectl -n "$NAMESPACE" "$@"
  fi
}

kexec() {
  kctl exec "$POD" -c agent -- sh -c "$1"
}

echo "==> resolving target ref (origin/$BRANCH in $REPO)"
if ! git -C "$REPO" fetch -q origin "$BRANCH" 2>/dev/null; then
  echo "    WARNING: fetch failed (offline?); using last known origin/$BRANCH" >&2
fi
TARGET_HEAD="$(git -C "$REPO" rev-parse "refs/remotes/origin/$BRANCH")"
echo "    target: $(git -C "$REPO" rev-parse --short=8 "$TARGET_HEAD")"

echo "==> locating companion pod (psfn-agent-${COMPANION_ID}-*)"
POD="$(kctl get pods -o name | grep -F "psfn-agent-${COMPANION_ID}-" || true)"
POD="${POD#pod/}"
if [[ -z "$POD" || "$POD" == *$'\n'* ]]; then
  echo "FAIL: expected exactly one pod matching psfn-agent-${COMPANION_ID}-*, got: ${POD:-none}" >&2
  exit 1
fi
echo "    pod: $POD"

if ! POD_HEAD="$(kexec "git -C '$POD_REPO_PATH' rev-parse refs/heads/'$BRANCH'" 2>/dev/null)"; then
  echo "FAIL: no branch '$BRANCH' at $POD_REPO_PATH in $POD — seed the checkout first" >&2
  exit 1
fi
echo "    pod head: ${POD_HEAD:0:8}"

if [[ "$POD_HEAD" == "$TARGET_HEAD" ]]; then
  echo "==> up to date; nothing to do"
  exit 0
fi
if git -C "$REPO" merge-base --is-ancestor "$TARGET_HEAD" "$POD_HEAD" 2>/dev/null; then
  echo "==> pod checkout already contains origin/$BRANCH tip (local commits ahead); nothing to do"
  exit 0
fi
if [[ $CHECK_ONLY -eq 1 ]]; then
  echo "==> drift: pod is behind or diverged from origin/$BRANCH (run without --check to sync)"
  exit 2
fi

if ! git -C "$REPO" cat-file -e "$POD_HEAD" 2>/dev/null; then
  echo "FAIL: pod head ${POD_HEAD:0:8} is unknown to $REPO (diverged history?); reconcile manually" >&2
  exit 1
fi

HOST_BUNDLE="$(mktemp "${TMPDIR:-/tmp}/psfn-source-sync.XXXXXX.bundle")"
POD_BUNDLE="/runtime/tmp/psfn-source-sync.bundle"
trap 'rm -f "$HOST_BUNDLE"; kctl exec "$POD" -c agent -- rm -f "$POD_BUNDLE" 2>/dev/null || true' EXIT

echo "==> building incremental bundle (${POD_HEAD:0:8}..${TARGET_HEAD:0:8})"
git -C "$REPO" bundle create "$HOST_BUNDLE" \
  "refs/remotes/origin/$BRANCH" "^$POD_HEAD" >/dev/null

echo "==> shipping bundle to pod"
kctl cp "$HOST_BUNDLE" "${POD}:${POD_BUNDLE}" -c agent

echo "==> refreshing pod checkout (ff-only, fail-closed)"
kexec "
set -e
cd '$POD_REPO_PATH'
git fetch -q '$POD_BUNDLE' 'refs/remotes/origin/$BRANCH:refs/remotes/origin/$BRANCH'
current=\$(git rev-parse --abbrev-ref HEAD)
if [ \"\$current\" != '$BRANCH' ]; then
  echo '    origin/$BRANCH ref updated; checkout left on' \"\$current\" '— reconcile manually' >&2
  exit 3
fi
if [ -n \"\$(git status --porcelain --untracked-files=no)\" ]; then
  echo '    refusing to refresh: tracked changes present in pod checkout; branch unmoved' >&2
  exit 3
fi
git merge --ff-only 'refs/remotes/origin/$BRANCH' >/dev/null
echo \"    fast-forwarded to \$(git rev-parse --short=8 HEAD)\"
" || { echo "FAIL: pod-side refresh refused (see above); branch left unmoved" >&2; exit 1; }

echo "==> sync complete: pod checkout at ${TARGET_HEAD:0:8}"
