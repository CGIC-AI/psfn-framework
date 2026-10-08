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
LOG_PATH="$LOG_DIR/split-runtime-$(date +%Y%m%dT%H%M%S).log"
ROUND_ID="$(printf '%s' "$PSFN_SHAKEDOWN_ROOT" | sha256sum | cut -c1-16)"
TMUX_SESSION="${PSFN_TMUX_SESSION:-psfn-shakedown-$ROUND_ID}"
# A dedicated tmux server inherits this round's freshly sourced environment.
# Reusing the desktop tmux server would silently retain old credentials/paths.
round_tmux() { tmux -L "psfn-shakedown-$ROUND_ID" "$@"; }
export GATEWAY_SOCKET="${GATEWAY_SOCKET:-$PSFN_TEMP_DIR/gateway.sock}"
export ADMIN_TRANSPORT_MODE=socket
export ADMIN_TRANSPORT_SOCKET="${ADMIN_TRANSPORT_SOCKET:-$PSFN_TEMP_DIR/garden-admin-$COMPANION_ID.sock}"

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

# Revalidate protected roots and the disposable Postgres target before stopping
# anything. Restart may be invoked directly, outside bootstrap-local.mjs.
node --input-type=module -e 'import(process.argv[1]).then(m => m.resolveBootstrapConfig())' \
  "$REPO_ROOT/shakedown/harness/lib/bootstrap-config.mjs"

mkdir -p "$LOG_DIR" "$PSFN_TEMP_DIR"
if round_tmux has-session -t "=$TMUX_SESSION" 2>/dev/null; then
  owner="$(round_tmux show-option -qv -t "=$TMUX_SESSION" @psfn-shakedown-root)"
  if [[ "$owner" != "$PSFN_SHAKEDOWN_ROOT" ]]; then
    echo "Refusing to stop a tmux session not owned by this shakedown round." >&2
    exit 1
  fi
  supervisor_pid="$(round_tmux list-panes -t "=$TMUX_SESSION" -F '#{pane_pid}')"
  round_tmux kill-session -t "=$TMUX_SESSION"
  stop_deadline=$((SECONDS + 20))
  while kill -0 "$supervisor_pid" 2>/dev/null; do
    if (( SECONDS >= stop_deadline )); then
      echo "Previous shakedown supervisor did not finish stopping; refusing a second runtime." >&2
      exit 1
    fi
    sleep 1
  done
fi

ensure_garden_ui_build
# Pass paths through tmux's environment, not a shell-interpolated command.
# exec makes the tracked supervisor the pane process; SIGHUP/TERM stops its
# children and removes the temporary credential file.
round_tmux new-session -d -s "$TMUX_SESSION" -c "$REPO_ROOT" \
  -e "PSFN_SPLIT_LOG=$LOG_PATH" \
  'exec node --import tsx shakedown/harness/run-split-runtime.mjs > "$PSFN_SPLIT_LOG" 2>&1'
round_tmux set-option -t "=$TMUX_SESSION" @psfn-shakedown-root "$PSFN_SHAKEDOWN_ROOT"

deadline=$((SECONDS + 90))
api_ready=0
admin_ready=0
agent_ready=0
while (( SECONDS < deadline )); do
  if ! round_tmux has-session -t "=$TMUX_SESSION" 2>/dev/null; then
    echo "Shakedown runtime exited before readiness; inspect $LOG_PATH" >&2
    exit 1
  fi
  if curl -fsS -H "Authorization: Bearer $API_KEY" "$API_HEALTH_URL" >/dev/null 2>&1; then
    api_ready=1
  fi
  if curl -fsS -H "Authorization: Bearer $ADMIN_TOKEN" "$ADMIN_HEALTH_URL" >/dev/null 2>&1; then
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
