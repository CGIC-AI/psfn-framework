#!/usr/bin/env bash
# ── Watchdog ──
# Polls the admin health endpoint. If no response within timeout, sends alert.
# Usage: ./scripts/self/watchdog.sh [health_url] [timeout_seconds] [alert_file]

set -euo pipefail

HEALTH_URL="${1:-http://127.0.0.1:${ADMIN_PORT:-8090}/health}"
TIMEOUT="${2:-180}"  # 3 minutes default
ALERT_FILE="${3:-./data/watchdog_alert.json}"
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"  # seconds between checks
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-false}"
KNOWN_GOOD_FILE="${KNOWN_GOOD_FILE:-./data/known_good_commit}"
ROLLBACK_RESTART_CMD="${ROLLBACK_RESTART_CMD:-}"

fail_count=0
max_fails=$(( TIMEOUT / CHECK_INTERVAL ))

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [Watchdog] $*"
}

send_alert() {
  local reason="$1"
  local rollback_status="${2:-not-attempted}"
  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Write alert file
  mkdir -p "$(dirname "$ALERT_FILE")"
  cat > "$ALERT_FILE" <<EOF
{
  "status": "alert",
  "reason": "$reason",
  "timestamp": "$timestamp",
  "health_url": "$HEALTH_URL",
  "consecutive_failures": $fail_count,
  "rollback_status": "$rollback_status"
}
EOF
  log "ALERT written to $ALERT_FILE: $reason (rollback=$rollback_status)"

  # Send Discord webhook if configured
  if [ -n "$DISCORD_WEBHOOK_URL" ]; then
    local rollback_note=""
    if [ "$rollback_status" != "not-attempted" ]; then
      rollback_note=" | rollback: $rollback_status"
    fi
    curl -s -X POST "$DISCORD_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"content\": \"Watchdog alert: $reason (${fail_count} consecutive failures)$rollback_note\"}" \
      || log "Failed to send Discord webhook"
  fi
}

clear_alert() {
  if [ -f "$ALERT_FILE" ]; then
    rm -f "$ALERT_FILE"
    log "Alert cleared — service recovered"
  fi
}

record_known_good() {
  if ! command -v git >/dev/null 2>&1; then
    return
  fi

  local commit
  commit=$(git rev-parse --verify HEAD 2>/dev/null || true)
  if [ -z "$commit" ]; then
    return
  fi

  mkdir -p "$(dirname "$KNOWN_GOOD_FILE")"
  local previous=""
  if [ -f "$KNOWN_GOOD_FILE" ]; then
    previous=$(cat "$KNOWN_GOOD_FILE")
  fi

  if [ "$previous" != "$commit" ]; then
    echo "$commit" > "$KNOWN_GOOD_FILE"
    log "Known-good commit updated: $commit"
  fi
}

rollback_to_known_good() {
  if [ "$AUTO_ROLLBACK" != "true" ]; then
    log "Auto-rollback disabled; skipping rollback"
    return 1
  fi

  if ! command -v git >/dev/null 2>&1; then
    log "Git not available; cannot rollback"
    return 1
  fi

  if [ ! -f "$KNOWN_GOOD_FILE" ]; then
    log "Known-good file missing ($KNOWN_GOOD_FILE); cannot rollback"
    return 1
  fi

  local target_commit
  target_commit=$(cat "$KNOWN_GOOD_FILE")
  if [ -z "$target_commit" ]; then
    log "Known-good commit is empty; cannot rollback"
    return 1
  fi

  local current_commit
  current_commit=$(git rev-parse --verify HEAD 2>/dev/null || true)
  log "Attempting rollback from ${current_commit:-unknown} to $target_commit"

  if ! git -c advice.detachedHead=false checkout --detach "$target_commit" >/dev/null 2>&1; then
    log "Rollback checkout failed for commit $target_commit"
    return 1
  fi

  log "Rollback checkout succeeded ($target_commit)"
  if [ -n "$ROLLBACK_RESTART_CMD" ]; then
    log "Running rollback restart command: $ROLLBACK_RESTART_CMD"
    /bin/bash -lc "$ROLLBACK_RESTART_CMD" >/dev/null 2>&1 &
  fi
  return 0
}

log "Starting watchdog (url=$HEALTH_URL, timeout=${TIMEOUT}s, interval=${CHECK_INTERVAL}s)"
log "Max consecutive failures before alert: $max_fails"
log "Auto-rollback: $AUTO_ROLLBACK (known-good: $KNOWN_GOOD_FILE)"

while true; do
  # Check health endpoint
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$http_code" = "200" ]; then
    record_known_good
    if [ "$fail_count" -gt 0 ]; then
      log "Health check OK (recovered after $fail_count failures)"
      clear_alert
    fi
    fail_count=0
  else
    fail_count=$((fail_count + 1))
    log "Health check FAILED (HTTP $http_code, failure $fail_count/$max_fails)"

    if [ "$fail_count" -ge "$max_fails" ]; then
      rollback_status="not-attempted"
      if rollback_to_known_good; then
        rollback_status="success"
      elif [ "$AUTO_ROLLBACK" = "true" ]; then
        rollback_status="failed"
      fi

      send_alert "Health endpoint unresponsive (HTTP $http_code)" "$rollback_status"
      # Reset counter after alerting so we don't spam
      fail_count=0
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
