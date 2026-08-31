#!/usr/bin/env bash
# Tier sweep (Layer A) — see docs/shakedown.md. Runs the case harness across the
# three tiers (nursery -> apprentice -> autonomous) and emits one run JSON per
# tier. Works against two deployment targets, selected by PSFN_TARGET:
#
#   local (default): edits capability-tier.json in the round system-data and
#     restarts the split runtime between tiers, backing the owner file up before
#     the sweep and restoring + verifying it on exit.
#   kube: flips the tier LIVE through the canonical Garden owner-file editor
#     (POST /api/admin/settings/capabilities with a form-urlencoded configJson of
#     the full capability-tier owner object) — the capability runtime hot-reloads
#     on the persisted change, so there is no redeploy and no PVC file edit. The
#     pre-sweep tier is captured via the settings API, persisted to a durable
#     record under the matrix dir before the first flip, and restored + confirmed
#     (with bounded retry) through the settings API on exit.
#
# Fail-closed: every path/URL comes from the already-sourced shakedown env; there
# are no /mnt or previous-sprint defaults and this script sources no env file of
# its own. The pre-sweep tier is restored on exit (trap) and the restore is
# verified before the script leaves — a failed restore is a loud hard error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s. Source the shakedown env (docs/shakedown.md) before running the harness.\n' "$name" >&2
    exit 1
  fi
}

TARGET="${PSFN_TARGET:-local}"
case "$TARGET" in
  local|kube) ;;
  *)
    printf "Invalid environment variable: PSFN_TARGET — expected 'local' or 'kube', got %s\n" "$TARGET" >&2
    exit 1
    ;;
esac

# Common fail-closed requirements for both targets.
for var in PSFN_MATRIX_DIR POSTGRES_DATABASE_URL TESTING_HARNESS_API_KEY; do
  require_env "$var"
done
# Target-specific requirements. The kube tier flip goes through the settings API,
# so it needs the Garden admin base/token (admin token is validated fail-closed
# by lib/target.mjs); the local flip needs the owner file it edits.
if [[ "$TARGET" == "kube" ]]; then
  for var in PSFN_API_BASE COMPANION_ID; do
    require_env "$var"
  done
else
  require_env API_KEY
  require_env PSFN_TIER_FILE
fi

MATRIX_DIR="$PSFN_MATRIX_DIR"
HARNESS="${PSFN_HARNESS_PATH:-$SCRIPT_DIR/live-system-shakedown.mjs}"
TARGET_LIB="${PSFN_TARGET_LIB:-$SCRIPT_DIR/lib/target.mjs}"
RESTART_SCRIPT="${PSFN_RESTART_SCRIPT:-$SCRIPT_DIR/restart-split-runtime.sh}"
TIER_FILE="${PSFN_TIER_FILE:-}"
LAST_PHASE_OUTPUT=""

if [[ ! -f "$HARNESS" ]]; then
  echo "Case harness not found: $HARNESS" >&2
  exit 1
fi
if [[ ! -f "$TARGET_LIB" ]]; then
  echo "Target library not found: $TARGET_LIB" >&2
  exit 1
fi
if [[ "$TARGET" == "local" ]]; then
  if [[ ! -f "$TIER_FILE" ]]; then
    echo "Capability tier owner file not found: $TIER_FILE" >&2
    exit 1
  fi
  if [[ ! -x "$RESTART_SCRIPT" && ! -f "$RESTART_SCRIPT" ]]; then
    echo "Restart script not found: $RESTART_SCRIPT" >&2
    exit 1
  fi
fi

mkdir -p "$MATRIX_DIR"

# --- Pre-sweep tier capture -------------------------------------------------
# Both targets capture the tier that was live before the sweep so the exit trap
# can put it back. local captures the owner-file content (verified byte-for-byte
# on restore); kube captures the tier string via the settings API.
TIER_BACKUP=""
ORIGINAL_TIER_JSON=""
ORIGINAL_TIER=""
# Durable record of the pre-sweep kube tier. Written under the matrix dir BEFORE
# the first flip so a crashed/SIGKILLed run (which cannot run the exit trap) can
# still be recovered manually: `node lib/target.mjs set-tier "$(cat <file>)"`.
ORIGINAL_TIER_FILE="${PSFN_ORIGINAL_TIER_FILE:-$MATRIX_DIR/original-capability-tier}"
# Bounded retry budget for the kube revert on transient settings-API failure
# (e.g. a port-forward blip) before it escalates to a loud FATAL.
RESTORE_MAX_ATTEMPTS="${PSFN_TIER_RESTORE_MAX_ATTEMPTS:-5}"
RESTORE_RETRY_DELAY_S="${PSFN_TIER_RESTORE_RETRY_DELAY_S:-2}"
if [[ "$TARGET" == "local" ]]; then
  TIER_BACKUP="$(mktemp)"
  cp "$TIER_FILE" "$TIER_BACKUP"
  ORIGINAL_TIER_JSON="$(cat "$TIER_FILE")"
else
  # Preflight the kube transport before touching the tier: gateway reachable
  # (:10053 port-forward), Postgres reachable (proof queries), and the settings
  # API answers. get-tier fails closed on a missing admin base/token, naming it.
  node "$TARGET_LIB" check-gateway >/dev/null
  node "$TARGET_LIB" check-postgres >/dev/null
  ORIGINAL_TIER="$(node "$TARGET_LIB" get-tier)"
  if [[ -z "$ORIGINAL_TIER" ]]; then
    echo "FATAL: could not read the pre-sweep capability tier from the settings API." >&2
    exit 1
  fi
  # Persist the pre-sweep tier durably before ANY flip, so an out-of-band kill
  # still leaves a recoverable record on disk.
  printf '%s\n' "$ORIGINAL_TIER" > "$ORIGINAL_TIER_FILE"
  echo "kube target: pre-sweep capability tier is '$ORIGINAL_TIER' (durable record: $ORIGINAL_TIER_FILE)." >&2
fi

TIER_RESTORED=0
restore_tier() {
  # Restore the pre-sweep tier, then verify it. A failed restore is a hard error
  # even on the exit path — the sweep must never leave the tier mutated.
  # TIER_RESTORED is only set to 1 AFTER an effective, confirming read-back shows
  # the tier is actually back to the original, so an interleaved signal that
  # arrives before confirmation re-enters and retries rather than short-circuit.
  if [ "$TIER_RESTORED" = "1" ]; then
    return 0
  fi
  if [[ "$TARGET" == "kube" ]]; then
    # Re-flip via the settings API. set-tier confirms the persisted hot-reload by
    # re-reading the tier and prints the confirmed tier on stdout; we additionally
    # assert that read-back equals the original before marking restored. Retry a
    # bounded number of times on transient failure (e.g. a port-forward blip)
    # before escalating to a loud FATAL that names the durable recovery record.
    local attempt=0 confirmed=""
    while (( attempt < RESTORE_MAX_ATTEMPTS )); do
      attempt=$((attempt + 1))
      if confirmed="$(node "$TARGET_LIB" set-tier "$ORIGINAL_TIER")" \
        && [[ "$confirmed" == "$ORIGINAL_TIER" ]]; then
        TIER_RESTORED=1
        echo "kube target: capability tier restored to '$confirmed' and confirmed via the settings API (attempt $attempt/$RESTORE_MAX_ATTEMPTS)." >&2
        return 0
      fi
      echo "WARN: capability tier restore attempt $attempt/$RESTORE_MAX_ATTEMPTS to '$ORIGINAL_TIER' failed or was unconfirmed; retrying in ${RESTORE_RETRY_DELAY_S}s..." >&2
      sleep "$RESTORE_RETRY_DELAY_S"
    done
    echo "FATAL: capability tier restore to '$ORIGINAL_TIER' via the settings API failed after $RESTORE_MAX_ATTEMPTS attempts. Recover manually: node '$TARGET_LIB' set-tier \"\$(cat '$ORIGINAL_TIER_FILE')\"" >&2
    exit 1
  fi
  local restore_file
  restore_file="$(mktemp)"
  printf '%s' "$ORIGINAL_TIER_JSON" > "$restore_file"
  mv "$restore_file" "$TIER_FILE"
  if ! diff -q "$TIER_BACKUP" "$TIER_FILE" >/dev/null 2>&1; then
    echo "FATAL: capability-tier.json restore verification failed; $TIER_FILE does not match the pre-sweep backup $TIER_BACKUP" >&2
    rm -f "$TIER_BACKUP"
    exit 1
  fi
  # Only now — after the byte-for-byte verify — is the local restore confirmed.
  TIER_RESTORED=1
  rm -f "$TIER_BACKUP"
  echo "capability-tier.json restored and verified against pre-sweep backup." >&2
}

# Restore runs once on any exit. INT/TERM handlers exit with the conventional
# 128+signal code, which triggers the EXIT trap — so Ctrl-C (SIGINT) and kill
# (SIGTERM) both restore and verify the tier before the process dies.
trap restore_tier EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set_tier() {
  local tier="$1"
  if [[ "$TARGET" == "kube" ]]; then
    # PATCH the settings API and confirm the hot-reload before returning; a flip
    # that is not confirmed exits non-zero and aborts the sweep.
    node "$TARGET_LIB" set-tier "$tier" >/dev/null
    return
  fi
  local tmp
  tmp="$(mktemp)"
  jq --arg tier "$tier" '.tier = $tier' "$TIER_FILE" > "$tmp"
  mv "$tmp" "$TIER_FILE"
}

restart_runtime() {
  # kube hot-reloads the tier on the persisted settings change — no redeploy and
  # no runtime restart. Only the local split runtime is restarted between tiers.
  if [[ "$TARGET" == "kube" ]]; then
    return 0
  fi
  "$RESTART_SCRIPT" >/dev/null
}

run_phase() {
  local tier="$1"
  local phase="$2"
  local label="$3"
  local case_ids="${4:-}"
  local output="$MATRIX_DIR/live-system-shakedown.${label}.json"
  LAST_PHASE_OUTPUT="$output"

  # run_phase runs under `run_phase ... || status=$?` in run_phase_or_abort,
  # which suppresses `set -e` for everything inside this function. An unconfirmed
  # forward flip (or a failed restart) MUST still abort the phase so no case ever
  # runs against the WRONG tier — make it explicit with `|| return $?` instead of
  # relying on set -e. The non-zero return propagates to run_phase_or_abort, which
  # marks the remaining tiers aborted and lets the exit-trap revert fire.
  set_tier "$tier" || return $?
  restart_runtime || return $?

  PSFN_SHAKEDOWN_PHASE="$phase" \
  PSFN_CAPABILITY_TIER_EXPECTED="$tier" \
  PSFN_CASE_IDS="$case_ids" \
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
  ? payload.results.find((result) => result?.caseStatus === 'matrix_aborted')
  : null;
if (payload.harnessStatus === 'matrix_aborted') {
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

S10_PRESENCE_CASES="s10_places_placeless,s10_mindspace_virtual,s10_places_physical,s10_mindspace_physical_precedence"
NURSERY_CASES="${PSFN_NURSERY_CASES:-l0_baseline,docs_audit,prompt_stack,contact_sessions,concern_cycle,heartbeat_policy,values_list,repo_read,analysis_workbench_large_evidence,analysis_workbench_simple_math_avoidance,analysis_workbench_memory_lookup_avoidance,scratchpad_roundtrip,memory_write_private,memory_recall_public,memory_recall_semi_private,agent_feedback,tool_discovery,fs_catalog,persona_update_guard,issue_read_sync,model_lane_attribution,backup_encryption_roundtrip,${S10_PRESENCE_CASES},s10_hub_identity_presence_follow,s10_cogsec_document_quarantine,s10_cogsec_satellite_document_quarantine,s10_temporal_stamp_strip,s10_sse_first_chunk,capability_refusal_matrix}"
APPRENTICE_CASES="${PSFN_APPRENTICE_CASES:-contact_mutation,contact_trust_preview,values_add_update,memory_write_patch,issue_create_update,image_analyze,image_create,image_edit,selfie_create,spawn_subagent,notify_operator,schedule_template_listing,heartbeat_mutation,north_star_cycle,prompt_mutation_cycle,prompt_toggle_cycle,promoted_tools_cycle,session_switching,focus_cycle,skill_manage,orient_append,memory_import_batch,memory_redact,web_fetch,${S10_PRESENCE_CASES},s10_world_read_telemetry,capability_refusal_matrix}"
AUTONOMOUS_CASES="${PSFN_AUTONOMOUS_CASES:-memory_delete_restore,issue_close_cycle,${S10_PRESENCE_CASES},capability_refusal_matrix}"

run_phase_or_abort nursery coverage nursery "$NURSERY_CASES" apprentice autonomous
run_phase_or_abort apprentice coverage apprentice "$APPRENTICE_CASES" autonomous
run_phase_or_abort autonomous autonomous autonomous "$AUTONOMOUS_CASES"

printf '%s\n' "$MATRIX_DIR"
