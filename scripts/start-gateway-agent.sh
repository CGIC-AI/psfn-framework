#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "${ROOT_DIR}/scripts/system/runtime-env.sh"

DEBUG_MODE=0
YOLO_MODE=0
for arg in "$@"; do
  case "$arg" in
    --debug|-d)
      DEBUG_MODE=1
      ;;
    --yolo)
      YOLO_MODE=1
      ;;
  esac
done

DOTENV_FILE="${PSFN_DOTENV_FILE:-.env}"
if [ "${DOTENV_FILE}" != "${DOTENV_FILE#/}" ]; then
  RESOLVED_DOTENV_FILE="${DOTENV_FILE}"
else
  RESOLVED_DOTENV_FILE="${ROOT_DIR}/${DOTENV_FILE#./}"
fi

if [ "${PSFN_SKIP_DOTENV:-false}" != "true" ]; then
  psfn_source_dotenv_preserving_existing_env "${RESOLVED_DOTENV_FILE}"
fi

psfn_export_default_module_registry_path
psfn_export_default_vad_lexicon_path

# Local-dev defaults so split/yolo mode is one-command.
if [ -z "${API_PORT:-}" ]; then
  export API_PORT=10053
fi

if [ -z "${API_HOST:-}" ]; then
  export API_HOST=127.0.0.1
fi

if [ -z "${API_KEY:-}" ] && [ -z "${ALLOW_INSECURE_LOCAL_API:-}" ]; then
  export ALLOW_INSECURE_LOCAL_API=true
fi

if [ -z "${ADMIN_PORT:-}" ]; then
  export ADMIN_PORT=10054
fi

if [ -z "${ADMIN_HOST:-}" ]; then
  export ADMIN_HOST=127.0.0.1
fi

if [ -z "${ADMIN_TOKEN:-}" ] && [ -z "${ADMIN_ALLOW_INSECURE:-}" ]; then
  export ADMIN_ALLOW_INSECURE=true
fi

if [ -z "${GATEWAY_SESSION_HMAC_KEYS:-}" ] && [ -z "${GATEWAY_SESSION_HMAC_KEY:-}" ]; then
  export GATEWAY_SESSION_HMAC_KEY="psfn-dev-session-hmac"
fi

if [ -z "${ALLOW_AGENT_OUTBOUND_NETWORK:-}" ]; then
  export ALLOW_AGENT_OUTBOUND_NETWORK=true
fi

if [ "${YOLO_MODE}" -eq 1 ]; then
  export PSFN_RUNTIME_MODE="yolo"
else
  export PSFN_RUNTIME_MODE="${PSFN_RUNTIME_MODE:-split}"
fi
export PSFN_RUNTIME_MODE="$(printf '%s' "${PSFN_RUNTIME_MODE}" | tr '[:upper:]' '[:lower:]')"

MODE_LABEL="split"
RESTART_BASE="split"
if [ "${PSFN_RUNTIME_MODE}" = "yolo" ]; then
  MODE_LABEL="yolo"
  RESTART_BASE="yolo"
fi

if [ "${DEBUG_MODE}" -eq 1 ]; then
  export LOG_LEVEL="${LOG_LEVEL:-debug}"
  export PSFN_DEBUG_MODE=true
  export PSFN_DEBUG_EVENTS="${PSFN_DEBUG_EVENTS:-true}"
  export PSFN_DEBUG_THINKING="${PSFN_DEBUG_THINKING:-true}"
  export PSFN_DEBUG_TEXT="${PSFN_DEBUG_TEXT:-true}"
  echo "[${MODE_LABEL}] debug mode enabled (LOG_LEVEL=${LOG_LEVEL})"
fi

if [ -z "${LIFECYCLE_RESTART_COMMAND:-}" ]; then
  if [ "${DEBUG_MODE}" -eq 1 ]; then
    export LIFECYCLE_RESTART_COMMAND="npm run ${RESTART_BASE}:debug"
  else
    export LIFECYCLE_RESTART_COMMAND="npm run ${RESTART_BASE}"
  fi
fi

if [ "${PSFN_RUNTIME_MODE}" = "yolo" ]; then
  echo "[${MODE_LABEL}] YOLO mode active: gateway fs.read can access full codebase paths; fs.write remains workspace-scoped."
fi

echo "[${MODE_LABEL}] verifying startup owner files..."
if [ -x "./node_modules/.bin/tsx" ]; then
  ./node_modules/.bin/tsx scripts/verify-startup-owner-files.ts
else
  npm run verify:startup-owner-files
fi

DEFAULT_SOCKET_PATH="/run/psfn/gateway.sock"
SOCKET_SUFFIX="$(basename "${ROOT_DIR}" | tr -cs 'A-Za-z0-9._-' '-')"
FALLBACK_SOCKET_PATH="${XDG_RUNTIME_DIR:-/tmp}/psfn-gateway-${SOCKET_SUFFIX}/gateway.sock"

if [ -z "${GATEWAY_SOCKET:-}" ]; then
  default_dir="$(dirname "${DEFAULT_SOCKET_PATH}")"
  if mkdir -p "${default_dir}" 2>/dev/null && [ -w "${default_dir}" ]; then
    export GATEWAY_SOCKET="${DEFAULT_SOCKET_PATH}"
  else
    fallback_dir="$(dirname "${FALLBACK_SOCKET_PATH}")"
    mkdir -p "${fallback_dir}"
    export GATEWAY_SOCKET="${FALLBACK_SOCKET_PATH}"
    echo "[${MODE_LABEL}] /run/psfn not writable; using GATEWAY_SOCKET=${GATEWAY_SOCKET}"
  fi
fi

if [ -z "${ADMIN_TRANSPORT_SOCKET:-}" ]; then
  export ADMIN_TRANSPORT_SOCKET="$(dirname "${GATEWAY_SOCKET}")/garden-admin.sock"
fi

SOCKET_PATH="${GATEWAY_SOCKET}"
GATEWAY_PID=""
AGENT_PID=""
OPERATOR_PID=""

start_gateway() {
  if [ -x "./node_modules/.bin/tsx" ]; then
    ./node_modules/.bin/tsx src/app/gateway/main.ts &
  else
    npm run gateway &
  fi
  GATEWAY_PID=$!
}

start_agent() {
  if [ -x "./node_modules/.bin/tsx" ]; then
    ./node_modules/.bin/tsx src/app/agent/main.ts &
  else
    npm run agent &
  fi
  AGENT_PID=$!
}

start_operator() {
  if [ -x "./node_modules/.bin/tsx" ]; then
    ./node_modules/.bin/tsx src/app/operator/main.ts &
  else
    npm run operator &
  fi
  OPERATOR_PID=$!
}

stop_pid() {
  local pid="$1"
  if [ -z "${pid}" ]; then
    return
  fi
  if kill -0 "${pid}" 2>/dev/null; then
    pkill -TERM -P "${pid}" 2>/dev/null || true
    kill "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  fi
}

cleanup() {
  stop_pid "${OPERATOR_PID}"
  stop_pid "${AGENT_PID}"
  stop_pid "${GATEWAY_PID}"
}

trap cleanup INT TERM EXIT

echo "[${MODE_LABEL}] starting gateway..."
start_gateway

echo "[${MODE_LABEL}] waiting for gateway socket: ${SOCKET_PATH}"
for _ in $(seq 1 200); do
  if [ -S "${SOCKET_PATH}" ]; then
    break
  fi
  if ! kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    echo "[${MODE_LABEL}] gateway exited before socket became ready"
    exit 1
  fi
  sleep 0.1
done

if [ ! -S "${SOCKET_PATH}" ]; then
  echo "[${MODE_LABEL}] warning: gateway socket not detected yet, starting agent anyway"
fi

echo "[${MODE_LABEL}] starting agent..."
start_agent

echo "[${MODE_LABEL}] starting operator..."
start_operator

echo "[${MODE_LABEL}] admin ui: http://${ADMIN_HOST}:${ADMIN_PORT}"
echo "[${MODE_LABEL}] running (gateway pid=${GATEWAY_PID}, agent pid=${AGENT_PID}, operator pid=${OPERATOR_PID})"
wait -n "${GATEWAY_PID}" "${AGENT_PID}" "${OPERATOR_PID}"
