#!/usr/bin/env bash
# Hand fields owned by imperative kubectl field managers back to Helm before a
# `helm upgrade` (psfn-framework-c73nz).
#
# WHY: Helm 4 upgrades deploy/helm/psfn with server-side apply, so every field a
# previous `kubectl set image`, `kubectl set env`, `kubectl patch` or
# `kubectl edit` touched is owned by that kubectl field manager and the next
# `helm upgrade` fails outright with "conflict occurred while applying object
# ... conflicts with \"kubectl-set\"". Image-only rollouts with `kubectl set
# image` are a normal operating pattern, so a release drifts into a state it
# cannot upgrade from.
#
# Removing a manager's managedFields entry drops only the OWNERSHIP RECORD,
# never a live value: the following helm upgrade applies cleanly and Helm owns
# the fields again. Safe and idempotent. Covers every namespaced object kind the
# chart renders that operators touch by hand: Deployments, StatefulSets,
# Services, NetworkPolicies, ConfigMaps and Secrets, selected by the chart's
# release label.
#
#   usage: release-kubectl-field-ownership.sh --context <ctx> --namespace <ns> [--release <name>] [--dry-run]
#
# Requires kubectl >= 1.27 (`--show-managed-fields`; modern kubectl strips
# managedFields from `-o json` by default, which would silently report "no
# ownership").
set -euo pipefail

CTX=""
NS=""
RELEASE="psfn"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CTX="$2"; shift 2 ;;
    --namespace) NS="$2"; shift 2 ;;
    --release) RELEASE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CTX" && -n "$NS" ]] || { echo "usage: $0 --context <ctx> --namespace <ns> [--release <name>] [--dry-run]" >&2; exit 2; }

MANAGERS='kubectl-set kubectl-patch kubectl-edit kubectl-client-side-apply kubectl-scale'
KINDS='deployments statefulsets services networkpolicies configmaps secrets'
released=0

for kind in $KINDS; do
  names="$(kubectl --context "$CTX" -n "$NS" get "$kind" \
    -l "app.kubernetes.io/instance=$RELEASE" -o name 2>/dev/null || true)"
  for ref in $names; do
    idxs="$(kubectl --context "$CTX" -n "$NS" get "$ref" -o json --show-managed-fields \
      | MANAGERS="$MANAGERS" python3 -c '
import json, os, sys
managers = set(os.environ["MANAGERS"].split())
entries = json.load(sys.stdin)["metadata"].get("managedFields", [])
print(" ".join(str(i) for i, e in enumerate(entries) if e.get("manager") in managers))
')"
    if [[ -z "$idxs" ]]; then
      continue
    fi
    # Remove the highest index first so earlier indices stay valid.
    patch="["
    for i in $(echo "$idxs" | tr ' ' '\n' | sort -rn); do
      patch+="{\"op\":\"remove\",\"path\":\"/metadata/managedFields/$i\"},"
    done
    patch="${patch%,}]"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  $ref: would release kubectl ownership (managedFields entries: $idxs)"
      continue
    fi
    if kubectl --context "$CTX" -n "$NS" patch "$ref" --type=json -p "$patch" >/dev/null; then
      echo "  $ref: released kubectl ownership (entries: $idxs)"
      released=$((released + 1))
    else
      echo "  $ref: PATCH FAILED" >&2
      exit 1
    fi
  done
done
echo "released kubectl field ownership on $released object(s) in $NS (release $RELEASE)"
