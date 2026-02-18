#!/usr/bin/env bash
# ── Rebuild & Restart ──
# Runs npm run build, then calls restart.sh.
# Usage: ./scripts/self/rebuild.sh [pid_file] [start_command]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Rebuild] $*"
}

log "Building project..."
cd "$PROJECT_DIR"

if npm run build; then
  log "Build succeeded"
else
  log "Build FAILED — aborting restart"
  exit 1
fi

log "Proceeding to restart..."
exec "$SCRIPT_DIR/restart.sh" "$@"
