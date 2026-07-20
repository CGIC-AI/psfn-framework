#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "${ROOT_DIR}/scripts/system/runtime-env.sh"

DEBUG_MODE=0
YOLO_MODE=0
DRY_RUN_MODE=0
if psfn_is_truthy_env_value "${PSFN_SUPERVISOR_DRY_RUN:-}"; then
  DRY_RUN_MODE=1
fi
for arg in "$@"; do
  case "$arg" in
    --debug|-d)
      DEBUG_MODE=1
      ;;
    --yolo)
      YOLO_MODE=1
      ;;
    --dry-run)
      DRY_RUN_MODE=1
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

if [ -z "${GATEWAY_OPERATOR_API_BASE_URL:-}" ]; then
  export GATEWAY_OPERATOR_API_BASE_URL="http://127.0.0.1:${API_PORT}/v1"
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
OPERATOR_ENV=()
SUPERVISOR_MODE=0
AGENT_PIDS=()
COMPANION_PLAN=()
LAUNCHER_ADMIN_PORT="${ADMIN_PORT:-}"
LAUNCHER_ADMIN_TRANSPORT_SOCKET="${ADMIN_TRANSPORT_SOCKET}"
LAUNCHER_COMPANION_DATA_DIR_WAS_SET=0
LAUNCHER_COMPANION_DATA_DIR=""
if [ "${COMPANION_DATA_DIR+x}" = "x" ]; then
  LAUNCHER_COMPANION_DATA_DIR_WAS_SET=1
  LAUNCHER_COMPANION_DATA_DIR="${COMPANION_DATA_DIR}"
fi

append_agent_env() {
  local name="$1"
  if [ "${!name+x}" = "x" ]; then
    AGENT_ENV+=("${name}=${!name}")
  fi
}

append_operator_env() {
  local name="$1"
  if [ "${name}" = "POSTGRES_DATABASE_URL" ] \
    && ! psfn_is_truthy_env_value "${PSFN_MULTI_COMPANION:-}"; then
    return
  fi
  if psfn_is_truthy_env_value "${PSFN_FLEET_AUTH:-}"; then
    case "${name}" in
      ADMIN_ALLOW_INSECURE|ADMIN_TOKEN)
        return
        ;;
    esac
  fi
  if [ "${!name+x}" = "x" ]; then
    OPERATOR_ENV+=("${name}=${!name}")
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
    ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI \
    ADMIN_TRANSPORT_TLS_KEY_PATH \
    ADMIN_TRANSPORT_URL \
    BACKUP_ROOT_DIR \
    CHARACTER_CARD_PATH \
    COMPANION_DATA_DIR \
    COMPANION_ID \
    COMPANION_PG_SCHEMA \
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
    GATEWAY_COMPANION_AUTH_TOKEN \
    GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN \
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
    POSTGRES_DATABASE_URL_FD \
    PRIMARY_TELEGRAM_USER_ID \
    PRIMARY_USER_ID \
    PSFN_DEBUG_EVENTS \
    PSFN_DEBUG_MODE \
    PSFN_DEBUG_TEXT \
    PSFN_DEBUG_THINKING \
    PSFN_FLEET_AUTH \
    PSFN_LIFECYCLE_RESTART_EXIT_CODE \
    PSFN_LOGS_DIR \
    PSFN_MULTI_COMPANION \
    PSFN_REDIS_PASSWORD \
    PSFN_REDIS_TLS_CA_CERT_PATH \
    PSFN_REDIS_TLS_REJECT_UNAUTHORIZED \
    PSFN_REDIS_URL \
    PSFN_REDIS_USERNAME \
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

# Operator processes receive only Garden auth, the approved direct database
# credential, runtime layout, owner-file, and admin-transport wiring. They do
# not inherit provider, channel, companion-auth, shell, or gateway signing
# credentials.
build_operator_env() {
  OPERATOR_ENV=()
  local name
  for name in \
    ADMIN_ALLOW_INSECURE \
    ADMIN_HOST \
    ADMIN_PORT \
    ADMIN_TOKEN \
    ADMIN_TRANSPORT_LISTEN_HOST \
    ADMIN_TRANSPORT_LISTEN_PORT \
    ADMIN_TRANSPORT_MODE \
    ADMIN_TRANSPORT_PEER_AUTH_MODE \
    ADMIN_TRANSPORT_SOCKET \
    ADMIN_TRANSPORT_TIMEOUT_MS \
    ADMIN_TRANSPORT_TLS_CA_PATH \
    ADMIN_TRANSPORT_TLS_CERT_PATH \
    ADMIN_TRANSPORT_TLS_EXPECTED_PEER_SPIFFE_URI \
    ADMIN_TRANSPORT_TLS_KEY_PATH \
    ADMIN_TRANSPORT_URL \
    BACKUP_ROOT_DIR \
    CHARACTER_CARD_PATH \
    COMPANION_DATA_DIR \
    COMPANION_ID \
    COMPANION_PG_SCHEMA \
    CONFIG_DIR \
    DATA_DIR \
    FLEET_SSO_GARDEN_TLS_CA_PATH \
    FLEET_SSO_GARDEN_TLS_CERT_PATH \
    FLEET_SSO_GARDEN_TLS_EXPECTED_PEER_SPIFFE_URI \
    FLEET_SSO_GARDEN_TLS_KEY_PATH \
    FLEET_SSO_GARDEN_TLS_SERVER_NAME \
    GATEWAY_OPERATOR_API_BASE_URL \
    GATEWAY_SOCKET \
    HOME \
    LANG \
    LC_ALL \
    LC_CTYPE \
    LOG_LEVEL \
    LOGNAME \
    NODE_ENV \
    NODE_OPTIONS \
    PATH \
    POSTGRES_DATABASE_URL \
    PSFN_FLEET_AUTH \
    PSFN_LOGS_DIR \
    PSFN_MULTI_COMPANION \
    PSFN_RUNTIME_LAYOUT_MODE \
    PSFN_RUNTIME_MODE \
    PSFN_RUNTIME_ROOT \
    PSFN_TEMP_DIR \
    PWD \
    SYSTEM_DATA_DIR \
    TERM \
    TMP \
    TMPDIR \
    TZ \
    USER \
    WORKSPACE_PATH; do
    append_operator_env "${name}"
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
    if psfn_is_truthy_env_value "${PSFN_FLEET_AUTH:-}"; then
      launch_background env -u ADMIN_TOKEN -u ADMIN_ALLOW_INSECURE \
        ./node_modules/.bin/tsx src/app/gateway/main.ts
    else
      launch_background ./node_modules/.bin/tsx src/app/gateway/main.ts
    fi
  else
    if psfn_is_truthy_env_value "${PSFN_FLEET_AUTH:-}"; then
      launch_background env -u ADMIN_TOKEN -u ADMIN_ALLOW_INSECURE npm run gateway
    else
      launch_background npm run gateway
    fi
  fi
  GATEWAY_PID="${LAUNCHED_PID}"
}

spawn_agent_process() {
  if [ -z "${POSTGRES_DATABASE_URL:-}" ]; then
    echo "[${MODE_LABEL}] POSTGRES_DATABASE_URL is required by the launcher credential boundary" >&2
    return 1
  fi

  local postgres_database_url_fd
  exec {postgres_database_url_fd}<<<"${POSTGRES_DATABASE_URL}"
  local POSTGRES_DATABASE_URL_FD="${postgres_database_url_fd}"
  build_agent_env
  if [ -x "./node_modules/.bin/tsx" ]; then
    launch_background env -i "${AGENT_ENV[@]}" ./node_modules/.bin/tsx src/app/agent/main.ts
  else
    launch_background env -i "${AGENT_ENV[@]}" npm run agent
  fi
  exec {postgres_database_url_fd}<&-
}

start_agent() {
  spawn_agent_process
  AGENT_PID="${LAUNCHED_PID}"
}

# Export one fleet entry's companion-scoped values into the launcher env so the
# spawn allowlists pick them up, then env -i re-scrubs the child environment.
# The per-companion admin transport socket comes from the validated target
# registry in the plan (derived by the canonical TS helper, never here).
export_companion_env() {
  local companion_id="$1"
  local companion_data_dir="$2"
  local character_card_path="$3"
  local postgres_schema="$4"
  local personal_workspace_path="$5"
  local companion_auth_token="$6"
  local session_integrity_auth_token="$7"
  local admin_transport_socket="$8"

  export COMPANION_ID="${companion_id}"
  export COMPANION_DATA_DIR="${companion_data_dir}"
  export CHARACTER_CARD_PATH="${character_card_path}"
  export COMPANION_PG_SCHEMA="${postgres_schema}"
  export WORKSPACE_PATH="${personal_workspace_path}"
  export GATEWAY_COMPANION_AUTH_TOKEN="${companion_auth_token}"
  export GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN="${session_integrity_auth_token}"
  export ADMIN_TRANSPORT_SOCKET="${admin_transport_socket}"
}

# Spawn one agent for a single fleet entry.
start_companion_agent() {
  export_companion_env "$@"
  spawn_agent_process
  AGENT_PIDS+=("${LAUNCHED_PID}")
}

# Spawn the one fleet Garden only after every validated agent-admin transport is
# listening. The fleet operator has no companion identity, personal workspace,
# or companion database schema; request routing uses the complete immutable
# target registry built by src/app/operator/main.ts.
start_fleet_operator() {
  unset COMPANION_ID CHARACTER_CARD_PATH COMPANION_PG_SCHEMA WORKSPACE_PATH
  unset GATEWAY_COMPANION_AUTH_TOKEN GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN
  if [ "${LAUNCHER_COMPANION_DATA_DIR_WAS_SET}" -eq 1 ]; then
    export COMPANION_DATA_DIR="${LAUNCHER_COMPANION_DATA_DIR}"
  else
    unset COMPANION_DATA_DIR
  fi
  export ADMIN_TRANSPORT_SOCKET="${LAUNCHER_ADMIN_TRANSPORT_SOCKET}"
  export ADMIN_PORT="${LAUNCHER_ADMIN_PORT}"
  build_operator_env
  if [ -x "./node_modules/.bin/tsx" ]; then
    launch_background env -i "${OPERATOR_ENV[@]}" ./node_modules/.bin/tsx src/app/operator/main.ts
  else
    launch_background env -i "${OPERATOR_ENV[@]}" npm run operator
  fi
  OPERATOR_PID="${LAUNCHED_PID}"
}

start_operator() {
  build_operator_env
  if [ -x "./node_modules/.bin/tsx" ]; then
    launch_background env -i "${OPERATOR_ENV[@]}" ./node_modules/.bin/tsx src/app/operator/main.ts
  else
    launch_background env -i "${OPERATOR_ENV[@]}" npm run operator
  fi
  OPERATOR_PID="${LAUNCHED_PID}"
}

# Resolve the multi-companion fleet via the canonical TS helper. The helper owns
# all flag parsing, path resolution, and validation (no duplicate logic here).
# Empty stdout => single-companion topology (SUPERVISOR_MODE stays 0). Non-empty
# stdout => one tab-delimited companion record per line. A non-zero helper exit
# fails the launcher closed before anything is started.
resolve_companion_fleet() {
  # Byte-identical single-companion path: when the topology flag is not present
  # at all, never invoke the helper.
  if [ -z "${PSFN_MULTI_COMPANION:-}" ]; then
    return 0
  fi

  local plan_output=""
  if [ -x "./node_modules/.bin/tsx" ]; then
    if ! plan_output="$(./node_modules/.bin/tsx scripts/resolve-companion-fleet.ts)"; then
      echo "[${MODE_LABEL}] failed to resolve companion fleet from companions.json; refusing to start" >&2
      exit 1
    fi
  else
    if ! plan_output="$(npm run --silent resolve:companion-fleet)"; then
      echo "[${MODE_LABEL}] failed to resolve companion fleet from companions.json; refusing to start" >&2
      exit 1
    fi
  fi

  if [ -z "${plan_output}" ]; then
    # Flag parsed to off (e.g. PSFN_MULTI_COMPANION=0) with no fleet manifest.
    return 0
  fi

  SUPERVISOR_MODE=1
  COMPANION_PLAN=()
  local line
  while IFS= read -r line; do
    if [ -n "${line}" ]; then
      COMPANION_PLAN+=("${line}")
    fi
  done <<< "${plan_output}"

  if [ "${#COMPANION_PLAN[@]}" -eq 0 ]; then
    echo "[${MODE_LABEL}] multi-companion mode resolved an empty fleet; refusing to start" >&2
    exit 1
  fi
}

provision_companion_fleet() {
  if [ "${SUPERVISOR_MODE}" -ne 1 ]; then
    return 0
  fi
  echo "[supervisor] provisioning fleet workspaces under the launcher lock..."
  if [ -x "./node_modules/.bin/tsx" ]; then
    ./node_modules/.bin/tsx scripts/provision-companion-fleet.ts
  else
    npm run provision:companion-fleet
  fi
}

resolve_single_companion_auth() {
  if [ "${SUPERVISOR_MODE}" -eq 1 ]; then
    return 0
  fi

  local auth_output=""
  if [ -x "./node_modules/.bin/tsx" ]; then
    if ! auth_output="$(./node_modules/.bin/tsx scripts/resolve-single-companion-auth.ts)"; then
      echo "[${MODE_LABEL}] failed to derive role-bound gateway credentials; refusing to start" >&2
      exit 1
    fi
  else
    if ! auth_output="$(npm run --silent resolve:single-companion-auth)"; then
      echo "[${MODE_LABEL}] failed to derive role-bound gateway credentials; refusing to start" >&2
      exit 1
    fi
  fi

  local companion_auth_token=""
  local session_integrity_auth_token=""
  IFS=$'\t' read -r companion_auth_token session_integrity_auth_token <<< "${auth_output}"
  if [ -z "${companion_auth_token}" ] || [ -z "${session_integrity_auth_token}" ]; then
    echo "[${MODE_LABEL}] gateway credential helper returned an invalid response; refusing to start" >&2
    exit 1
  fi
  export GATEWAY_COMPANION_AUTH_TOKEN="${companion_auth_token}"
  export GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN="${session_integrity_auth_token}"
}

print_supervisor_plan() {
  local record companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket
  echo "[supervisor] dry-run spawn plan (${#COMPANION_PLAN[@]} companion(s)):"
  echo "[supervisor]   gateway: ${SOCKET_PATH}"
  for record in "${COMPANION_PLAN[@]}"; do
    IFS=$'\t' read -r companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket <<< "${record}"
    echo "[supervisor]   agent: companionId=${companion_id} schema=${postgres_schema} dataDir=${companion_data_dir} workspace=${personal_workspace_path} card=${character_card_path} adminSocket=${admin_transport_socket}"
  done
  echo "[supervisor]   Garden: one fleet operator port=${LAUNCHER_ADMIN_PORT} targets=${#COMPANION_PLAN[@]}"
}

prepare_fleet_admin_transports() {
  local record companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket
  for record in "${COMPANION_PLAN[@]}"; do
    IFS=$'\t' read -r companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket <<< "${record}"
    if [ -e "${admin_transport_socket}" ] || [ -L "${admin_transport_socket}" ]; then
      if [ ! -S "${admin_transport_socket}" ]; then
        echo "[supervisor] refusing to replace non-socket admin transport path for ${companion_id}: ${admin_transport_socket}" >&2
        return 1
      fi
      rm -f -- "${admin_transport_socket}"
    fi
  done
}

start_companion_agents() {
  local record companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket
  for record in "${COMPANION_PLAN[@]}"; do
    IFS=$'\t' read -r companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket <<< "${record}"
    echo "[supervisor] starting agent for companion ${companion_id} (schema=${postgres_schema}, dataDir=${companion_data_dir})"
    start_companion_agent "${companion_id}" "${companion_data_dir}" "${character_card_path}" "${postgres_schema}" "${personal_workspace_path}" "${companion_auth_token}" "${session_integrity_auth_token}" "${admin_transport_socket}"
  done
}

wait_for_fleet_admin_transports() {
  local attempt record companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket
  local index ready_count
  echo "[supervisor] waiting for ${#COMPANION_PLAN[@]} validated agent admin transport(s)..."
  for attempt in $(seq 1 200); do
    if ! kill -0 "${GATEWAY_PID}" 2>/dev/null; then
      echo "[supervisor] gateway exited before fleet admin transports became ready" >&2
      return 1
    fi
    index=0
    ready_count=0
    for record in "${COMPANION_PLAN[@]}"; do
      IFS=$'\t' read -r companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket <<< "${record}"
      if ! kill -0 "${AGENT_PIDS[${index}]}" 2>/dev/null; then
        echo "[supervisor] agent ${companion_id} exited before admin transport became ready" >&2
        return 1
      fi
      if [ -S "${admin_transport_socket}" ]; then
        ready_count=$((ready_count + 1))
      fi
      index=$((index + 1))
    done
    if [ "${ready_count}" -eq "${#COMPANION_PLAN[@]}" ]; then
      echo "[supervisor] all validated agent admin transports are ready"
      return 0
    fi
    sleep 0.1
  done

  for record in "${COMPANION_PLAN[@]}"; do
    IFS=$'\t' read -r companion_id companion_data_dir character_card_path postgres_schema personal_workspace_path companion_auth_token session_integrity_auth_token admin_transport_socket <<< "${record}"
    if [ ! -S "${admin_transport_socket}" ]; then
      echo "[supervisor] agent admin transport missing for ${companion_id}: ${admin_transport_socket}" >&2
    fi
  done
  return 1
}

probe_fleet_admin_transports() {
  echo "[supervisor] probing every validated agent admin transport..."
  if [ -x "./node_modules/.bin/tsx" ]; then
    ./node_modules/.bin/tsx scripts/resolve-companion-fleet.ts --probe-ready
  else
    npm run --silent resolve:companion-fleet -- --probe-ready
  fi
  echo "[supervisor] every validated agent admin transport passed its health probe"
}

start_fleet_garden() {
  if ! kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    echo "[supervisor] gateway exited before the fleet Garden could start" >&2
    return 1
  fi
  echo "[supervisor] starting one fleet Garden (port=${LAUNCHER_ADMIN_PORT}, targets=${#COMPANION_PLAN[@]})"
  start_fleet_operator
}

supervise_companion_fleet() {
  echo "[supervisor] running (gateway pid=${GATEWAY_PID}, agent pids=${AGENT_PIDS[*]}, Garden pid=${OPERATOR_PID})"

  # Shared-fate: the first child (gateway, any agent, or the fleet Garden) to exit
  # tears down the whole set. No silent auto-restart; a non-zero exit propagates
  # loudly.
  set +e
  wait -n "${GATEWAY_PID}" "${AGENT_PIDS[@]}" "${OPERATOR_PID}"
  local exit_status=$?
  set -e

  echo "[supervisor] a supervised process exited (status=${exit_status}); shutting down the whole fleet (shared-fate)" >&2
  cleanup_children
  trap - INT TERM EXIT
  release_launcher_lock
  exit "${exit_status}"
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
  local pid
  for pid in "${AGENT_PIDS[@]:-}"; do
    stop_pid "${pid}"
  done
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

resolve_companion_fleet
resolve_single_companion_auth

if [ "${DRY_RUN_MODE}" -eq 1 ]; then
  if [ "${SUPERVISOR_MODE}" -eq 1 ]; then
    print_supervisor_plan
  else
    echo "[${MODE_LABEL}] dry-run: single-companion topology (gateway + one agent + operator)"
    echo "[${MODE_LABEL}]   gateway: ${SOCKET_PATH}"
  fi
  exit 0
fi

trap 'handle_shutdown_signal INT' INT
trap 'handle_shutdown_signal TERM' TERM
trap cleanup EXIT

acquire_launcher_lock

provision_companion_fleet

echo "[${MODE_LABEL}] verifying startup owner files..."
if [ -x "./node_modules/.bin/tsx" ]; then
  ./node_modules/.bin/tsx scripts/preflight-startup-owner-files.ts
else
  npm run preflight:startup-owner-files
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

if [ "${SUPERVISOR_MODE}" -eq 1 ]; then
  echo "[supervisor] multi-companion mode: spawning ${#COMPANION_PLAN[@]} agent(s)"
  prepare_fleet_admin_transports
  start_companion_agents
  wait_for_fleet_admin_transports
  probe_fleet_admin_transports
  start_fleet_garden
  supervise_companion_fleet
fi

echo "[${MODE_LABEL}] starting agent..."
start_agent

echo "[${MODE_LABEL}] starting operator..."
start_operator

if psfn_is_truthy_env_value "${PSFN_FLEET_AUTH:-}"; then
  echo "[${MODE_LABEL}] fleet ui: canonical HTTPS origin from fleet-auth.json (/fleet)"
else
  echo "[${MODE_LABEL}] admin ui: http://${ADMIN_HOST}:${ADMIN_PORT}"
fi
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
