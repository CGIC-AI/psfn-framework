#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEBUG_MODE=0
for arg in "$@"; do
  case "$arg" in
    --debug|-d)
      DEBUG_MODE=1
      ;;
  esac
done

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

# Local-dev defaults so split mode is one-command.
if [ -z "${ADMIN_PORT:-}" ]; then
  export ADMIN_PORT=3001
fi

if [ -z "${ADMIN_HOST:-}" ]; then
  export ADMIN_HOST=127.0.0.1
fi

if [ -z "${ADMIN_TOKEN:-}" ] && [ -z "${ADMIN_ALLOW_INSECURE:-}" ]; then
  export ADMIN_ALLOW_INSECURE=true
fi

if [ "${DEBUG_MODE}" -eq 1 ]; then
  export LOG_LEVEL="${LOG_LEVEL:-debug}"
  export PSFN_DEBUG_MODE=true
  export PSFN_DEBUG_EVENTS="${PSFN_DEBUG_EVENTS:-true}"
  export PSFN_DEBUG_THINKING="${PSFN_DEBUG_THINKING:-true}"
  export PSFN_DEBUG_TEXT="${PSFN_DEBUG_TEXT:-true}"
  echo "[split] debug mode enabled (LOG_LEVEL=${LOG_LEVEL})"
fi

DEFAULT_SOCKET_PATH="/run/psfn/gateway.sock"
FALLBACK_SOCKET_PATH="${XDG_RUNTIME_DIR:-/tmp}/psfn-gateway/gateway.sock"

if [ -z "${GATEWAY_SOCKET:-}" ]; then
  default_dir="$(dirname "${DEFAULT_SOCKET_PATH}")"
  if mkdir -p "${default_dir}" 2>/dev/null && [ -w "${default_dir}" ]; then
    export GATEWAY_SOCKET="${DEFAULT_SOCKET_PATH}"
  else
    fallback_dir="$(dirname "${FALLBACK_SOCKET_PATH}")"
    mkdir -p "${fallback_dir}"
    export GATEWAY_SOCKET="${FALLBACK_SOCKET_PATH}"
    echo "[split] /run/psfn not writable; using GATEWAY_SOCKET=${GATEWAY_SOCKET}"
  fi
fi

SOCKET_PATH="${GATEWAY_SOCKET}"
GATEWAY_PID=""
AGENT_PID=""

cleanup() {
  if [ -n "${AGENT_PID}" ] && kill -0 "${AGENT_PID}" 2>/dev/null; then
    kill "${AGENT_PID}" 2>/dev/null || true
  fi
  if [ -n "${GATEWAY_PID}" ] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    kill "${GATEWAY_PID}" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

echo "[split] starting gateway..."
npm run gateway &
GATEWAY_PID=$!

echo "[split] waiting for gateway socket: ${SOCKET_PATH}"
for _ in $(seq 1 200); do
  if [ -S "${SOCKET_PATH}" ]; then
    break
  fi
  if ! kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    echo "[split] gateway exited before socket became ready"
    exit 1
  fi
  sleep 0.1
done

if [ ! -S "${SOCKET_PATH}" ]; then
  echo "[split] warning: gateway socket not detected yet, starting agent anyway"
fi

echo "[split] starting agent..."
npm run agent &
AGENT_PID=$!

echo "[split] admin ui: http://${ADMIN_HOST}:${ADMIN_PORT}"
echo "[split] running (gateway pid=${GATEWAY_PID}, agent pid=${AGENT_PID})"
wait -n "${GATEWAY_PID}" "${AGENT_PID}"
