#!/usr/bin/env bash
# ── Restart ──
# Sends SIGTERM to the runtime process, waits for clean shutdown, then starts again.
# Usage: ./scripts/self/restart.sh --mode <continuous|production> [pid_file] [start_command]

set -euo pipefail

SHUTDOWN_TIMEOUT="${SHUTDOWN_TIMEOUT:-30}"
RUNTIME_MODE="${PSFN_RUNTIME_MODE:-}"

usage() {
  cat <<EOF
Usage: ./scripts/self/restart.sh --mode <continuous|production> [pid_file] [start_command]

Examples:
  ./scripts/self/restart.sh --mode continuous
  ./scripts/self/restart.sh --mode production ./runtime/production/companion-data/psfn.pid
  ./scripts/self/restart.sh --mode production ./runtime/production/companion-data/psfn.pid "PSFN_RUNTIME_LAYOUT_MODE=production npm run start"
EOF
}

POSITIONAL=()
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      if [ $# -lt 2 ]; then
        echo "Missing value for --mode" >&2
        usage
        exit 1
      fi
      RUNTIME_MODE="$2"
      shift 2
      ;;
    --mode=*)
      RUNTIME_MODE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        POSITIONAL+=("$1")
        shift
      done
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done
set -- "${POSITIONAL[@]}"

if [ -z "$RUNTIME_MODE" ]; then
  echo "Missing required runtime mode. Provide --mode <continuous|production> or PSFN_RUNTIME_MODE." >&2
  usage
  exit 1
fi

case "$RUNTIME_MODE" in
  continuous)
    DEFAULT_PID_FILE="./data/psfn.pid"
    ;;
  production)
    DEFAULT_PID_FILE="./runtime/production/companion-data/psfn.pid"
    ;;
  *)
    echo "Invalid runtime mode '$RUNTIME_MODE'. Expected continuous or production." >&2
    usage
    exit 1
    ;;
esac

PID_FILE="${1:-$DEFAULT_PID_FILE}"
START_CMD="${2:-PSFN_RUNTIME_LAYOUT_MODE=${RUNTIME_MODE} npm run start}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Restart] $*"
}

normalize_relative_path() {
  local path="$1"
  while [[ "$path" == ./* ]]; do
    path="${path#./}"
  done
  printf '%s' "$path"
}

validate_mode_guards() {
  local pid_path_rel
  pid_path_rel="$(normalize_relative_path "$PID_FILE")"

  case "$RUNTIME_MODE" in
    production)
      if [[ "$pid_path_rel" == data/* || "$pid_path_rel" == workspace/* ]]; then
        echo "Production mode cannot use continuous PID path '$PID_FILE'." >&2
        exit 1
      fi
      if [[ "$START_CMD" != *"PSFN_RUNTIME_LAYOUT_MODE=production"* ]]; then
        echo "Production mode restart requires start_command to include PSFN_RUNTIME_LAYOUT_MODE=production." >&2
        exit 1
      fi
      ;;
    continuous)
      if [[ "$pid_path_rel" == runtime/production/* ]]; then
        echo "Continuous mode cannot use production PID path '$PID_FILE'." >&2
        exit 1
      fi
      if [[ "$START_CMD" == *"PSFN_RUNTIME_LAYOUT_MODE=production"* ]]; then
        echo "Continuous mode restart cannot use a production layout start command." >&2
        exit 1
      fi
      ;;
  esac
}

log "Runtime mode: $RUNTIME_MODE"
log "PID file: $PID_FILE"
validate_mode_guards

# Find the process
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
elif command -v pgrep &>/dev/null; then
  PID=$(pgrep -f 'node.*dist/index.js' || echo "")
else
  PID=""
fi

if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  log "Sending SIGTERM to PID $PID..."
  kill -TERM "$PID"

  # Wait for clean shutdown
  elapsed=0
  while kill -0 "$PID" 2>/dev/null && [ "$elapsed" -lt "$SHUTDOWN_TIMEOUT" ]; do
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if kill -0 "$PID" 2>/dev/null; then
    log "Process did not exit within ${SHUTDOWN_TIMEOUT}s, sending SIGKILL"
    kill -9 "$PID" 2>/dev/null || true
    sleep 1
  fi

  log "Process stopped"
else
  log "No running process found"
fi

# Start the process
log "Starting: $START_CMD"
exec /bin/bash -lc "$START_CMD"
