#!/usr/bin/env bash
# Restart the split gateway/agent runtime for a shakedown lane — see
# docs/shakedown.md. Fail-closed: every path, port, and secret comes from the
# already-sourced shakedown env (there are no /mnt or previous-sprint defaults);
# a missing required variable is a named, non-zero exit. Runtime stores are
# Postgres-only, so PERSISTENCE_BACKEND is pinned to postgres and no sqlite
# DATABASE_PATH is ever set.
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s. Source the shakedown env (docs/shakedown.md) before running the harness.\n' "$name" >&2
    exit 1
  fi
}

# Fail closed on the whole required set before doing any work.
for var in \
  PSFN_REPO_ROOT COMPANION_ID WORKSPACE_PATH \
  SYSTEM_DATA_DIR COMPANION_DATA_DIR CHARACTER_CARD_PATH DATA_DIR \
  PSFN_LOGS_DIR PSFN_TEMP_DIR BACKUP_ROOT_DIR \
  API_HOST API_PORT ADMIN_HOST ADMIN_PORT API_CORS_ALLOWLIST \
  API_KEY ADMIN_TOKEN GATEWAY_SESSION_HMAC_KEY \
  POSTGRES_DATABASE_URL PSFN_SHAKEDOWN_ROOT; do
  require_env "$var"
done

REPO_ROOT="$PSFN_REPO_ROOT"
API_HEALTH_URL="http://${API_HOST}:${API_PORT}/health"
ADMIN_HEALTH_URL="http://${ADMIN_HOST}:${ADMIN_PORT}/health"
LOG_DIR="$PSFN_LOGS_DIR"
PID_FILE="${PSFN_RUNTIME_PID_FILE:-$PSFN_SHAKEDOWN_ROOT/runtime.pid}"
LOG_PATH="$LOG_DIR/split-runtime-$(date +%Y%m%dT%H%M%S).log"
TMUX_SESSION="${PSFN_TMUX_SESSION:-psfn-shakedown}"
SOCKET_SUFFIX="$(basename "$REPO_ROOT" | tr -cs 'A-Za-z0-9._-' '-')"
SOCKET_DIR="${XDG_RUNTIME_DIR:-/tmp}/psfn-gateway-${SOCKET_SUFFIX}"
GATEWAY_SOCKET_PATH="${SOCKET_DIR}/gateway.sock"
ADMIN_SOCKET_PATH="${SOCKET_DIR}/garden-admin.sock"

# Runtime stores are Postgres-only. Pin the backend and the split/layout mode
# for the child; everything else is inherited from the sourced shakedown env.
export PERSISTENCE_BACKEND=postgres
export PSFN_RUNTIME_MODE="${PSFN_RUNTIME_MODE:-split}"
export PSFN_RUNTIME_LAYOUT_MODE="${PSFN_RUNTIME_LAYOUT_MODE:-production}"

ensure_garden_ui_build() {
  local admin_ui_dir="$REPO_ROOT/admin-ui"
  local admin_build_index="$admin_ui_dir/build/index.html"
  if [[ ! -d "$admin_ui_dir" ]]; then
    return
  fi
  if [[ ! -d "$admin_ui_dir/node_modules" ]]; then
    npm --prefix "$admin_ui_dir" ci >/dev/null
  fi
  npm --prefix "$admin_ui_dir" run build >/dev/null
  if [[ ! -f "$admin_build_index" ]]; then
    echo "Garden UI build missing after admin-ui build step: $admin_build_index" >&2
    exit 1
  fi
}

kill_pid_if_running() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

kill_port_listeners() {
  local port="$1"
  mapfile -t port_pids < <(
    ss -ltnp "sport = :${port}" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
      | sort -u
  )
  for pid in "${port_pids[@]:-}"; do
    kill_pid_if_running "$pid"
  done
}

kill_repo_runtime_processes() {
  mapfile -t runtime_pids < <(
    ps -eo pid=,args= \
      | grep -F "$REPO_ROOT" \
      | grep -E 'npm run split|src/app/(gateway|agent|operator)/main\.ts' \
      | awk '{ print $1 }'
  )
  for pid in "${runtime_pids[@]:-}"; do
    kill_pid_if_running "$pid"
  done
}

mkdir -p "$LOG_DIR"
mkdir -p "$DATA_DIR"

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(cat "$PID_FILE" || true)"
  kill_pid_if_running "$existing_pid"
  sleep 2
fi

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  tmux kill-session -t "$TMUX_SESSION" || true
  sleep 1
fi

kill_repo_runtime_processes
kill_port_listeners "$API_PORT"
kill_port_listeners "$ADMIN_PORT"
rm -f "$GATEWAY_SOCKET_PATH" "$ADMIN_SOCKET_PATH"
sleep 2

ensure_garden_ui_build

# tmux inherits the current (sourced) environment, so every secret and path
# already exported by the shakedown env — POSTGRES_DATABASE_URL,
# OPENROUTER_API_KEY, DISCORD_*, layout dirs — is passed straight through to `npm run split`.
tmux new-session -d -s "$TMUX_SESSION" \
  "cd \"$REPO_ROOT\" && npm run split > \"$LOG_PATH\" 2>&1"

tmux list-panes -t "$TMUX_SESSION" -F '#{pane_pid}' | head -n 1 > "$PID_FILE"

deadline=$((SECONDS + 90))
api_ready=0
admin_ready=0
agent_ready=0
while (( SECONDS < deadline )); do
  if curl -sS "$API_HEALTH_URL" >/dev/null 2>&1; then
    api_ready=1
  fi
  if curl -sS "$ADMIN_HEALTH_URL" >/dev/null 2>&1; then
    admin_ready=1
  fi
  if [[ -f "$LOG_PATH" ]] && grep -q 'Ready — waiting for messages' "$LOG_PATH"; then
    agent_ready=1
  fi
  if (( api_ready == 1 && admin_ready == 1 && agent_ready == 1 )); then
    break
  fi
  sleep 2
done

printf '%s\n' "$LOG_PATH"
printf 'workspace=%s\n' "$WORKSPACE_PATH"
printf 'tmux_session=%s\n' "$TMUX_SESSION"
printf 'api_ready=%s admin_ready=%s agent_ready=%s\n' "$api_ready" "$admin_ready" "$agent_ready"

if (( api_ready != 1 || admin_ready != 1 || agent_ready != 1 )); then
  echo "Runtime did not reach all three health signals within the deadline." >&2
  exit 1
fi
