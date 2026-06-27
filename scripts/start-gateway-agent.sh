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

psfn_require_production_launcher_env

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

if [ "${YOLO_MODE}" -eq 1 ]; then
  export PSFN_RUNTIME_MODE="yolo"
else
  export PSFN_RUNTIME_MODE="${PSFN_RUNTIME_MODE:-split}"
fi
export PSFN_RUNTIME_MODE="$(printf '%s' "${PSFN_RUNTIME_MODE}" | tr '[:upper:]' '[:lower:]')"

MODE_LABEL="split"
if [ "${PSFN_RUNTIME_MODE}" = "yolo" ]; then
  MODE_LABEL="yolo"
fi

export PSFN_LIFECYCLE_RESTART_EXIT_CODE="${PSFN_LIFECYCLE_RESTART_EXIT_CODE:-75}"

if [ "${DEBUG_MODE}" -eq 1 ]; then
  export LOG_LEVEL="${LOG_LEVEL:-debug}"
  export PSFN_DEBUG_MODE=true
  export PSFN_DEBUG_EVENTS="${PSFN_DEBUG_EVENTS:-true}"
  export PSFN_DEBUG_THINKING="${PSFN_DEBUG_THINKING:-true}"
  export PSFN_DEBUG_TEXT="${PSFN_DEBUG_TEXT:-true}"
  echo "[${MODE_LABEL}] debug mode enabled (LOG_LEVEL=${LOG_LEVEL})"
fi

if [ "${PSFN_RUNTIME_MODE}" = "yolo" ]; then
  echo "[${MODE_LABEL}] YOLO mode active: gateway fs.read can access full codebase paths; fs.write remains personal-workspace-scoped."
fi

psfn_require_node_major 22

DEFAULT_SOCKET_PATH="/run/psfn/gateway.sock"
SOCKET_SUFFIX="$(basename "${ROOT_DIR}" | tr -cs 'A-Za-z0-9._-' '-')"
FALLBACK_SOCKET_PATH="${XDG_RUNTIME_DIR:-/tmp}/psfn-gateway-${SOCKET_SUFFIX}/gateway.sock"

if [ -z "${GATEWAY_SOCKET:-}" ]; then
  RESOLVED_GATEWAY_SOCKET="$(psfn_resolve_gateway_socket_path "${DEFAULT_SOCKET_PATH}" "${FALLBACK_SOCKET_PATH}")"
  export GATEWAY_SOCKET="${RESOLVED_GATEWAY_SOCKET}"
  if [ "${GATEWAY_SOCKET}" = "${FALLBACK_SOCKET_PATH}" ]; then
    echo "[${MODE_LABEL}] /run/psfn not writable; using GATEWAY_SOCKET=${GATEWAY_SOCKET}"
  fi
fi

if [ -z "${ADMIN_TRANSPORT_SOCKET:-}" ]; then
  export ADMIN_TRANSPORT_SOCKET="$(dirname "${GATEWAY_SOCKET}")/garden-admin.sock"
fi

SOCKET_PATH="${GATEWAY_SOCKET}"
LAUNCHER_LOCK_DIR=""
LAUNCHER_LOCK_HELD=0
GATEWAY_PID=""
AGENT_PID=""
OPERATOR_PID=""
LAUNCHED_PID=""
AGENT_ENV=()

append_agent_env() {
  local name="$1"
  if [ "${!name+x}" = "x" ]; then
    AGENT_ENV+=("${name}=${!name}")
  fi
}

build_agent_env() {
  AGENT_ENV=()
  local name
  for name in \
    ALLOW_AGENT_OUTBOUND_NETWORK \
    ALLOW_INSECURE_LOCAL_API \
    API_HEALTH_SCHEDULER_HEALTHCHECK_STALE_AFTER_MS \
    API_HOST \
    API_PORT \
    ADMIN_HOST \
    ADMIN_PORT \
    ADMIN_TRANSPORT_LISTEN_HOST \
    ADMIN_TRANSPORT_LISTEN_PORT \
    ADMIN_TRANSPORT_MODE \
    ADMIN_TRANSPORT_PEER_AUTH_MODE \
    ADMIN_TRANSPORT_SOCKET \
    ADMIN_TRANSPORT_TIMEOUT_MS \
    ADMIN_TRANSPORT_TLS_CA_PATH \
    ADMIN_TRANSPORT_TLS_CERT_PATH \
    ADMIN_TRANSPORT_TLS_KEY_PATH \
    ADMIN_TRANSPORT_URL \
    BACKUP_ROOT_DIR \
    CHARACTER_CARD_PATH \
    COMPANION_DATA_DIR \
    COMPANION_ID \
    CONFIG_DIR \
    CONTINUITY_WATCHDOG_ENDPOINT \
    CONTINUITY_WATCHDOG_MAX_FAILURES \
    CONTINUITY_WATCHDOG_RESTART_PID \
    CONTINUITY_WATCHDOG_STATE_FILE \
    CONTINUITY_WATCHDOG_TIMEOUT_MS \
    DATA_DIR \
    DATABASE_BASENAME \
    DATABASE_PATH \
    EMBEDDING_DIMS \
    EXTRACTION_DRAIN_TIMEOUT_MS \
    GATEWAY_SOCKET \
    HOME \
    LANG \
    LC_ALL \
    LC_CTYPE \
    LOG_LEVEL \
    LOGNAME \
    MODULE_REGISTRY_PATH \
    NODE_ENV \
    NODE_OPTIONS \
    PATH \
    PERSISTENCE_BACKEND \
    POSTGRES_DATABASE_URL \
    PRIMARY_TELEGRAM_USER_ID \
    PRIMARY_USER_ID \
    PSFN_DEBUG_EVENTS \
    PSFN_DEBUG_MODE \
    PSFN_DEBUG_TEXT \
    PSFN_DEBUG_THINKING \
    PSFN_LIFECYCLE_RESTART_EXIT_CODE \
    PSFN_LOGS_DIR \
    PSFN_RUNTIME_LAYOUT_MODE \
    PSFN_RUNTIME_MODE \
    PSFN_RUNTIME_ROOT \
    PSFN_TEMP_DIR \
    PWD \
    SHELL \
    SHELL_EXEC_ALLOWED_CWD \
    SHELL_EXEC_ALLOWLIST \
    SHELL_EXEC_DEFAULT_MAX_OUTPUT_CHARS \
    SHELL_EXEC_DEFAULT_TIMEOUT_MS \
    SHELL_EXEC_ENABLED \
    SHELL_EXEC_ENV_ALLOWLIST \
    SHELL_EXEC_MAX_OUTPUT_CHARS \
    SHELL_EXEC_MAX_TIMEOUT_MS \
    SHUTDOWN_FORCE_EXIT_TIMEOUT_MS \
    SYSTEM_DATA_DIR \
    TELEGRAM_PRIMARY_USER_ID \
    TERM \
    TMP \
    TMPDIR \
    TZ \
    USER \
    WORKSPACE_PATH; do
    append_agent_env "${name}"
  done
}

launch_background() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
  else
    "$@" &
  fi
  LAUNCHED_PID=$!
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts="${2:-50}"
  local attempt
  for attempt in $(seq 1 "${attempts}"); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_exited_pid_status() {
  local pid="$1"
  if [ -z "${pid}" ]; then
    return 255
  fi

  if ! kill -0 "${pid}" 2>/dev/null; then
    wait "${pid}" 2>/dev/null
    return $?
  fi

  local stat=""
  stat="$(ps -o stat= -p "${pid}" 2>/dev/null | tr -d '[:space:]' || true)"
  case "${stat}" in
    Z*)
      wait "${pid}" 2>/dev/null
      return $?
      ;;
  esac

  return 255
}

wait_for_lifecycle_restart_child() {
  local attempts="${1:-100}"
  local status=255
  local pid=""
  local attempt
  for attempt in $(seq 1 "${attempts}"); do
    for pid in "${AGENT_PID}" "${GATEWAY_PID}" "${OPERATOR_PID}"; do
      set +e
      wait_for_exited_pid_status "${pid}"
      status=$?
      set -e
      if [ "${status}" -eq "${PSFN_LIFECYCLE_RESTART_EXIT_CODE}" ]; then
        return 0
      fi
    done
    sleep 0.1
  done
  return 1
}

launcher_pid_is_active() {
  local pid="$1"
  if [ -z "${pid}" ]; then
    return 1
  fi
  case "${pid}" in
    *[!0-9]*)
      return 1
      ;;
  esac
  if ! kill -0 "${pid}" 2>/dev/null; then
    return 1
  fi

  local command_line=""
  command_line="$(ps -o args= -p "${pid}" 2>/dev/null || true)"
  case "${command_line}" in
    *start-gateway-agent.sh*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

acquire_launcher_lock() {
  local socket_dir=""
  local existing_pid=""
  local existing_root=""
  local attempt

  socket_dir="$(dirname "${SOCKET_PATH}")"
  LAUNCHER_LOCK_DIR="${socket_dir}/launcher.lock"

  if [ -z "${socket_dir}" ] || [ "${socket_dir}" = "/" ]; then
    echo "[${MODE_LABEL}] invalid gateway socket directory for launcher lock: ${socket_dir}" >&2
    return 1
  fi
  if ! mkdir -p "${socket_dir}" 2>/dev/null; then
    echo "[${MODE_LABEL}] unable to create gateway socket directory for launcher lock: ${socket_dir}" >&2
    return 1
  fi

  for attempt in 1 2; do
    if mkdir "${LAUNCHER_LOCK_DIR}" 2>/dev/null; then
      printf '%s\n' "$$" > "${LAUNCHER_LOCK_DIR}/pid"
      printf '%s\n' "${ROOT_DIR}" > "${LAUNCHER_LOCK_DIR}/root"
      printf '%s\n' "${SOCKET_PATH}" > "${LAUNCHER_LOCK_DIR}/socket"
      LAUNCHER_LOCK_HELD=1
      return 0
    fi

    existing_pid="$(cat "${LAUNCHER_LOCK_DIR}/pid" 2>/dev/null || true)"
    existing_root="$(cat "${LAUNCHER_LOCK_DIR}/root" 2>/dev/null || true)"
    if [ "${existing_pid}" = "$$" ] && [ "${existing_root}" = "${ROOT_DIR}" ]; then
      LAUNCHER_LOCK_HELD=1
      return 0
    fi

    if launcher_pid_is_active "${existing_pid}"; then
      echo "[${MODE_LABEL}] launcher lock held by pid ${existing_pid}; refusing to start another launcher for ${SOCKET_PATH}" >&2
      return 1
    fi

    echo "[${MODE_LABEL}] removing stale launcher lock at ${LAUNCHER_LOCK_DIR}" >&2
    rm -rf "${LAUNCHER_LOCK_DIR}"
  done

  echo "[${MODE_LABEL}] unable to acquire launcher lock at ${LAUNCHER_LOCK_DIR}" >&2
  return 1
}

release_launcher_lock() {
  if [ "${LAUNCHER_LOCK_HELD}" -ne 1 ] || [ -z "${LAUNCHER_LOCK_DIR}" ]; then
    return
  fi

  local existing_pid=""
  existing_pid="$(cat "${LAUNCHER_LOCK_DIR}/pid" 2>/dev/null || true)"
  if [ "${existing_pid}" = "$$" ]; then
    rm -rf "${LAUNCHER_LOCK_DIR}"
  fi
  LAUNCHER_LOCK_HELD=0
}

start_gateway() {
  if [ -x "./node_modules/.bin/tsx" ]; then
    launch_background ./node_modules/.bin/tsx src/app/gateway/main.ts
  else
    launch_background npm run gateway
  fi
  GATEWAY_PID="${LAUNCHED_PID}"
}

start_agent() {
  build_agent_env
  if [ -x "./node_modules/.bin/tsx" ]; then
    launch_background env -i "${AGENT_ENV[@]}" ./node_modules/.bin/tsx src/app/agent/main.ts
  else
    launch_background env -i "${AGENT_ENV[@]}" npm run agent
  fi
  AGENT_PID="${LAUNCHED_PID}"
}

start_operator() {
  if [ -x "./node_modules/.bin/tsx" ]; then
    launch_background ./node_modules/.bin/tsx src/app/operator/main.ts
  else
    launch_background npm run operator
  fi
  OPERATOR_PID="${LAUNCHED_PID}"
}

stop_pid() {
  local pid="$1"
  if [ -z "${pid}" ]; then
    return
  fi

  if ! kill -0 "${pid}" 2>/dev/null; then
    wait "${pid}" 2>/dev/null || true
    return
  fi

  local pgid=""
  pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "${pgid}" ]; then
    kill -TERM -- "-${pgid}" 2>/dev/null || true
  else
    kill -TERM "${pid}" 2>/dev/null || true
  fi

  if ! wait_for_pid_exit "${pid}" 100; then
    if [ -n "${pgid}" ]; then
      kill -KILL -- "-${pgid}" 2>/dev/null || true
    else
      kill -KILL "${pid}" 2>/dev/null || true
    fi
    wait_for_pid_exit "${pid}" 20 || true
  fi

  wait "${pid}" 2>/dev/null || true
}

cleanup_children() {
  stop_pid "${OPERATOR_PID}"
  stop_pid "${AGENT_PID}"
  stop_pid "${GATEWAY_PID}"
}

cleanup() {
  cleanup_children
  release_launcher_lock
}

handle_shutdown_signal() {
  local signal="$1"
  cleanup_children
  release_launcher_lock
  trap - INT TERM EXIT
  if [ "${signal}" = "TERM" ]; then
    exit 0
  fi
  exit 130
}

trap 'handle_shutdown_signal INT' INT
trap 'handle_shutdown_signal TERM' TERM
trap cleanup EXIT

acquire_launcher_lock

echo "[${MODE_LABEL}] verifying startup owner files..."
if [ -x "./node_modules/.bin/tsx" ]; then
  ./node_modules/.bin/tsx scripts/verify-startup-owner-files.ts
else
  npm run verify:startup-owner-files
fi

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
  if psfn_is_production_runtime; then
    echo "[${MODE_LABEL}] gateway socket not detected; refusing to start agent in production"
    exit 1
  fi
  echo "[${MODE_LABEL}] warning: gateway socket not detected yet, starting agent anyway"
fi

echo "[${MODE_LABEL}] starting agent..."
start_agent

echo "[${MODE_LABEL}] starting operator..."
start_operator

echo "[${MODE_LABEL}] admin ui: http://${ADMIN_HOST}:${ADMIN_PORT}"
echo "[${MODE_LABEL}] running (gateway pid=${GATEWAY_PID}, agent pid=${AGENT_PID}, operator pid=${OPERATOR_PID})"
set +e
wait -n "${GATEWAY_PID}" "${AGENT_PID}" "${OPERATOR_PID}"
EXIT_STATUS=$?
set -e

if [ "${EXIT_STATUS}" -ne "${PSFN_LIFECYCLE_RESTART_EXIT_CODE}" ]; then
  if wait_for_lifecycle_restart_child 100; then
    EXIT_STATUS="${PSFN_LIFECYCLE_RESTART_EXIT_CODE}"
  fi
fi

if [ "${EXIT_STATUS}" -eq "${PSFN_LIFECYCLE_RESTART_EXIT_CODE}" ]; then
  echo "[${MODE_LABEL}] lifecycle restart requested; stopping children and re-execing launcher"
  cleanup_children
  trap - INT TERM EXIT
  exec "$0" "$@"
fi

exit "${EXIT_STATUS}"
