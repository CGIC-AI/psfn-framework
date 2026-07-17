#!/usr/bin/env bash
set -uo pipefail

namespace=""
target=""
mapping=""
context=""
retry_seconds="1"
child_pid=""
stopping=0

usage() {
  cat <<'EOF'
Usage: keep-kube-port-forward.sh [options]

Keep one loopback-only kubectl port-forward alive across pod rollouts.

Required:
  --namespace NAME       Kubernetes namespace
  --target RESOURCE      Service target, for example service/psfn-garden
  --mapping PORTS        Local-to-service ports, for example 10154:10054

Optional:
  --context NAME         kubectl context (default: current context)
  --retry-seconds N      delay before reconnecting (default: 1)
  -h, --help             show this help
EOF
}

fail() {
  echo "keep-kube-port-forward: $*" >&2
  exit 2
}

require_value() {
  local option=$1
  local value=${2-}
  [[ -n "$value" ]] || fail "$option requires a value"
}

while (($# > 0)); do
  case "$1" in
    --namespace)
      require_value "$1" "${2-}"
      namespace=$2
      shift 2
      ;;
    --target)
      require_value "$1" "${2-}"
      target=$2
      shift 2
      ;;
    --mapping)
      require_value "$1" "${2-}"
      mapping=$2
      shift 2
      ;;
    --context)
      require_value "$1" "${2-}"
      context=$2
      shift 2
      ;;
    --retry-seconds)
      require_value "$1" "${2-}"
      retry_seconds=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ -n "$namespace" ]] || fail "--namespace is required"
[[ "$target" =~ ^(service|svc)/[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  fail "--target must name one Service"
[[ "$mapping" =~ ^[0-9]+:[0-9]+$ ]] ||
  fail "--mapping must be LOCAL_PORT:SERVICE_PORT"
[[ "$retry_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] ||
  fail "--retry-seconds must be a non-negative number"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"

kube_args=()
if [[ -n "$context" ]]; then
  kube_args+=(--context "$context")
fi

kubectl "${kube_args[@]}" --namespace "$namespace" get "$target" >/dev/null ||
  fail "$target was not found in namespace $namespace"

cleanup_child() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  child_pid=""
}

stop() {
  stopping=1
  cleanup_child
}

trap stop INT TERM
trap cleanup_child EXIT

while ((stopping == 0)); do
  kubectl "${kube_args[@]}" --namespace "$namespace" port-forward \
    --address 127.0.0.1 "$target" "$mapping" &
  child_pid=$!

  if wait "$child_pid"; then
    status=0
  else
    status=$?
  fi
  child_pid=""

  ((stopping == 0)) || break
  echo "keep-kube-port-forward: kubectl exited with status $status; retrying in ${retry_seconds}s" >&2
  sleep "$retry_seconds"
done
