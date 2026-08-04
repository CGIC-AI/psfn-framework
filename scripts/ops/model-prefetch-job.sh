#!/usr/bin/env bash
set -euo pipefail

action="${1:?action is required}"
namespace="${2:?namespace is required}"
release="${3:?release is required}"
selector="app.kubernetes.io/instance=${release},app.kubernetes.io/component=model-prefetch"

case "$action" in
  delete)
    kubectl -n "$namespace" delete job -l "$selector" \
      --ignore-not-found --wait=true >/dev/null
    ;;
  wait)
    mapfile -t jobs < <(kubectl -n "$namespace" get job -l "$selector" -o name)
    if [[ ${#jobs[@]} -ne 1 ]]; then
      echo "expected exactly one model-prefetch Job, found ${#jobs[@]}" >&2
      exit 1
    fi
    kubectl -n "$namespace" wait --for=condition=complete "${jobs[0]}" --timeout=30m
    ;;
  *)
    echo "unknown action: ${action}" >&2
    exit 2
    ;;
esac
