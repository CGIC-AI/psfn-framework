#!/usr/bin/env bash
# ── Rebuild & Restart ──
# Runs npm run build, then calls restart.sh.
# Usage: ./scripts/self/rebuild.sh --mode <continuous|production> [pid_file] [start_command]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_MODE="${PSFN_RUNTIME_MODE:-}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Rebuild] $*"
}

usage() {
  cat <<EOF
Usage: ./scripts/self/rebuild.sh --mode <continuous|production> [pid_file] [start_command]
EOF
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
  esac
done

extract_runtime_mode() {
  local mode="$RUNTIME_MODE"
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode)
        if [ $# -lt 2 ]; then
          return 1
        fi
        mode="$2"
        shift 2
        ;;
      --mode=*)
        mode="${1#*=}"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done
  printf '%s' "$mode"
}

if ! RUNTIME_MODE="$(extract_runtime_mode "$@")"; then
  echo "Missing value for --mode" >&2
  usage
  exit 1
fi

if [ -z "$RUNTIME_MODE" ]; then
  echo "Missing required runtime mode. Provide --mode <continuous|production> or PSFN_RUNTIME_MODE." >&2
  usage
  exit 1
fi

case "$RUNTIME_MODE" in
  continuous|production)
    ;;
  *)
    echo "Invalid runtime mode '$RUNTIME_MODE'. Expected continuous or production." >&2
    usage
    exit 1
    ;;
esac

log "Runtime mode: $RUNTIME_MODE"
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
