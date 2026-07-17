#!/usr/bin/env bash
# Tier sweep (Layer A) — see docs/shakedown.md. Runs the case harness across the
# three local tiers (nursery -> apprentice -> autonomous), editing
# capability-tier.json and restarting the runtime between tiers, and emits one
# run JSON per tier.
#
# Fail-closed: every path comes from the already-sourced shakedown env; there
# are no /mnt or previous-sprint defaults and this script sources no env file of
# its own. The capability-tier owner file is backed up before the sweep and
# restored on exit (trap), and the restore is verified before the script leaves.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s. Source the shakedown env (docs/shakedown.md) before running the harness.\n' "$name" >&2
    exit 1
  fi
}

for var in PSFN_TIER_FILE PSFN_MATRIX_DIR POSTGRES_DATABASE_URL API_KEY; do
  require_env "$var"
done

TIER_FILE="$PSFN_TIER_FILE"
MATRIX_DIR="$PSFN_MATRIX_DIR"
HARNESS="${PSFN_HARNESS_PATH:-$SCRIPT_DIR/live-system-shakedown.mjs}"
RESTART_SCRIPT="${PSFN_RESTART_SCRIPT:-$SCRIPT_DIR/restart-split-runtime.sh}"
LAST_PHASE_OUTPUT=""

if [[ ! -f "$TIER_FILE" ]]; then
  echo "Capability tier owner file not found: $TIER_FILE" >&2
  exit 1
fi
if [[ ! -f "$HARNESS" ]]; then
  echo "Case harness not found: $HARNESS" >&2
  exit 1
fi
if [[ ! -x "$RESTART_SCRIPT" && ! -f "$RESTART_SCRIPT" ]]; then
  echo "Restart script not found: $RESTART_SCRIPT" >&2
  exit 1
fi

derive_api_user_id() {
  if [[ -n "${PSFN_API_USER_ID:-}" ]]; then
    printf '%s\n' "$PSFN_API_USER_ID"
    return
  fi
  API_TOKEN="$API_KEY" node -e 'const crypto = require("node:crypto"); const token = process.env.API_TOKEN.trim(); console.log(`api-key-${crypto.createHash("sha256").update(token).digest("hex").slice(0, 24)}`);'
}

API_USER_ID="$(derive_api_user_id)"

mkdir -p "$MATRIX_DIR"

# Back the owner file up before any tier edit. Keep both a file copy and the
# content so the restore can be verified byte-for-byte.
TIER_BACKUP="$(mktemp)"
cp "$TIER_FILE" "$TIER_BACKUP"
ORIGINAL_TIER_JSON="$(cat "$TIER_FILE")"

TIER_RESTORED=0
restore_tier() {
  # Restore the owner file from the backup, then verify the restore matches the
  # pre-sweep content. A failed restore is a hard error even on the exit path —
  # the sweep must never leave capability-tier.json mutated.
  # Idempotent: the signal traps exit into the EXIT trap, so guard against a
  # second invocation running diff against an already-removed backup.
  if [ "$TIER_RESTORED" = "1" ]; then
    return 0
  fi
  TIER_RESTORED=1
  local restore_file
  restore_file="$(mktemp)"
  printf '%s' "$ORIGINAL_TIER_JSON" > "$restore_file"
  mv "$restore_file" "$TIER_FILE"
  if ! diff -q "$TIER_BACKUP" "$TIER_FILE" >/dev/null 2>&1; then
    echo "FATAL: capability-tier.json restore verification failed; $TIER_FILE does not match the pre-sweep backup $TIER_BACKUP" >&2
    rm -f "$TIER_BACKUP"
    exit 1
  fi
  rm -f "$TIER_BACKUP"
  echo "capability-tier.json restored and verified against pre-sweep backup." >&2
}

# Restore runs once on any exit. INT/TERM handlers exit with the conventional
# 128+signal code, which triggers the EXIT trap — so Ctrl-C (SIGINT) and kill
# (SIGTERM) both restore and verify the owner file before the process dies.
trap restore_tier EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set_tier() {
  local tier="$1"
  local tmp
  tmp="$(mktemp)"
  jq --arg tier "$tier" '.tier = $tier' "$TIER_FILE" > "$tmp"
  mv "$tmp" "$TIER_FILE"
}

restart_runtime() {
  "$RESTART_SCRIPT" >/dev/null
}

run_phase() {
  local tier="$1"
  local phase="$2"
  local label="$3"
  local case_ids="${4:-}"
  local output="$MATRIX_DIR/live-system-shakedown.${label}.json"
  LAST_PHASE_OUTPUT="$output"

  set_tier "$tier"
  restart_runtime

  PSFN_SHAKEDOWN_PHASE="$phase" \
  PSFN_CASE_IDS="$case_ids" \
  PSFN_API_USER_ID="$API_USER_ID" \
  PSFN_SHAKEDOWN_OUTPUT="$output" \
  node "$HARNESS"
}

write_aborted_phase() {
  local output="$1"
  local phase="$2"
  local label="$3"
  local blocked_by_output="$4"
  local blocked_by_case="$5"
  local blocked_by_status="$6"

  node - "$output" "$phase" "$label" "$blocked_by_output" "$blocked_by_case" "$blocked_by_status" <<'NODE'
const { mkdirSync, writeFileSync } = require('node:fs');
const [output, phase, label, blockedByOutput, blockedByCase, blockedByStatus] = process.argv.slice(2);
const parent = output.includes('/') ? output.slice(0, output.lastIndexOf('/')) : '';
if (parent) mkdirSync(parent, { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  completed: false,
  harnessStatus: 'matrix_aborted',
  phase,
  label,
  blockedByOutput,
  blockedByCase,
  blockedByStatus,
  results: [],
};
writeFileSync(output, JSON.stringify(payload, null, 2));
writeFileSync(output.replace(/\.json$/, '.partial.json'), JSON.stringify(payload, null, 2));
NODE
}

phase_abort_reason() {
  local output="$1"
  node - "$output" <<'NODE'
const { readFileSync } = require('node:fs');
const output = process.argv[2];
const payload = JSON.parse(readFileSync(output, 'utf8'));
const blocker = Array.isArray(payload.results)
  ? payload.results.find((result) => ['harness_error', 'agent_busy', 'runtime_stale', 'matrix_aborted'].includes(result?.caseStatus))
  : null;
if (payload.harnessStatus === 'matrix_aborted' || blocker) {
  console.log(JSON.stringify({
    caseId: blocker?.caseId ?? blocker?.id ?? null,
    status: blocker?.caseStatus ?? payload.harnessStatus ?? 'matrix_aborted',
  }));
  process.exit(1);
}
NODE
}

run_phase_or_abort() {
  local tier="$1"
  local phase="$2"
  local label="$3"
  local case_ids="$4"
  shift 4
  local remaining_labels=("$@")
  local status=0
  run_phase "$tier" "$phase" "$label" "$case_ids" || status=$?
  local reason='{"caseId":null,"status":"harness_error"}'
  if [[ -f "$LAST_PHASE_OUTPUT" ]]; then
    reason="$(phase_abort_reason "$LAST_PHASE_OUTPUT")" || status=1
  fi
  if [[ -z "$reason" ]]; then
    reason='{"caseId":null,"status":"harness_error"}'
  fi
  if [[ "$status" -ne 0 ]]; then
    local blocked_case
    local blocked_status
    blocked_case="$(node -e 'const value = JSON.parse(process.argv[1]); console.log(value.caseId ?? "");' "$reason")"
    blocked_status="$(node -e 'const value = JSON.parse(process.argv[1]); console.log(value.status ?? "matrix_aborted");' "$reason")"
    for remaining in "${remaining_labels[@]}"; do
      write_aborted_phase "$MATRIX_DIR/live-system-shakedown.${remaining}.json" "$remaining" "$remaining" "$LAST_PHASE_OUTPUT" "$blocked_case" "$blocked_status"
    done
    return "$status"
  fi
}

NURSERY_CASES="${PSFN_NURSERY_CASES:-l0_baseline,docs_audit,prompt_stack,contact_sessions,concern_cycle,heartbeat_policy,values_list,repo_read,analysis_workbench_large_evidence,analysis_workbench_simple_math_avoidance,analysis_workbench_memory_lookup_avoidance,scratchpad_roundtrip,memory_write_private,memory_recall_public,memory_recall_semi_private,memory_recall_broadcast,agent_feedback,tool_discovery,fs_catalog,persona_update_guard,issue_read_sync}"
APPRENTICE_CASES="${PSFN_APPRENTICE_CASES:-contact_mutation,contact_trust_preview,values_add_update,memory_patch_delete_restore,issue_create_update,image_analyze,image_create,image_edit,selfie_create,spawn_subagent,notify_operator,schedule_template_listing,heartbeat_mutation,north_star_cycle,prompt_mutation_cycle,prompt_toggle_cycle,promoted_tools_cycle,session_switching,focus_cycle,skill_manage,orient_append,memory_import_batch,memory_redact,web_fetch}"
AUTONOMOUS_CASES="${PSFN_AUTONOMOUS_CASES:-issue_close_cycle,lifecycle_restart,lifecycle_rebuild}"

run_phase_or_abort nursery coverage nursery "$NURSERY_CASES" apprentice autonomous
run_phase_or_abort apprentice coverage apprentice "$APPRENTICE_CASES" autonomous
run_phase_or_abort autonomous autonomous autonomous "$AUTONOMOUS_CASES"

printf '%s\n' "$MATRIX_DIR"
