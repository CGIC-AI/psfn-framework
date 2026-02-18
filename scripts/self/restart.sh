#!/usr/bin/env bash
# ── Restart ──
# Sends SIGTERM to the runtime process, waits for clean shutdown, then starts again.
# Usage: ./scripts/self/restart.sh [pid_file] [start_command]

set -euo pipefail

PID_FILE="${1:-./data/psfn.pid}"
START_CMD="${2:-npm run start}"
SHUTDOWN_TIMEOUT="${SHUTDOWN_TIMEOUT:-30}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Restart] $*"
}

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
exec $START_CMD
