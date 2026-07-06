#!/usr/bin/env bash
# Two-way beads sync between the shared workstation DB (source of truth for
# merge) and the companion's live copy on the psfn-shard workspace PVC.
#
#   scripts/ops/sync-companion-beads.sh            # full round-trip
#   scripts/ops/sync-companion-beads.sh --pull     # only companion -> shared
#   scripts/ops/sync-companion-beads.sh --push     # only shared -> companion
#
# Workstation-initiated over the existing SSH lane: the cluster never opens a
# connection back to this machine and the companion's tooling keeps working
# when this box is offline (her copy just goes stale until the next sync).
# bd import has per-issue upsert semantics, so the round-trip merges her
# created/updated beads into the shared DB and returns the merged state.
#
# Run after any bd activity worth sharing, on ship (ship-kube-update.sh), or
# from a cron. Bead: psfn-framework-hpx6 follow-on (companion beads write).
set -euo pipefail

HOST_ALIAS="${PSFN_HOST_ALIAS:-psfn-pi}"
NAMESPACE="${PSFN_NAMESPACE:-psfn}"
BEADS_POD_DEPLOY="deploy/psfn-gateway"
MODE="both"

case "${1:-}" in
  --pull) MODE="pull" ;;
  --push) MODE="push" ;;
  "") ;;
  -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 1 ;;
esac

rexec() {
  ssh "$HOST_ALIAS" "sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n $NAMESPACE exec ${2:-} $BEADS_POD_DEPLOY -- sh -c 'cd /app/workspace && $1'"
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/beads-sync.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

if [[ "$MODE" == "pull" || "$MODE" == "both" ]]; then
  echo "==> pulling companion beads (export from gateway pod)"
  rexec "bd export" >"$TMP/companion.jsonl"
  COMPANION_LINES=$(wc -l <"$TMP/companion.jsonl")
  echo "    companion export: ${COMPANION_LINES} records"
  if [[ "$COMPANION_LINES" -gt 0 ]]; then
    bd import "$TMP/companion.jsonl" 2>&1 | tail -1
  else
    echo "    companion DB empty; nothing to merge (refusing is safer than importing nothing over it)"
  fi
fi

if [[ "$MODE" == "push" || "$MODE" == "both" ]]; then
  echo "==> pushing shared beads to companion copy"
  bd export >"$TMP/shared.jsonl"
  SHARED_LINES=$(wc -l <"$TMP/shared.jsonl")
  [[ "$SHARED_LINES" -gt 0 ]] || { echo "FAIL: shared export produced 0 records; refusing to push emptiness" >&2; exit 1; }
  echo "    shared export: ${SHARED_LINES} records"
  rexec "bd import -" -i <"$TMP/shared.jsonl" 2>&1 | tail -1
fi

echo "==> sync complete (${MODE})"
