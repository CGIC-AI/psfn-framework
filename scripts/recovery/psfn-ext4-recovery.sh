#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TIMESTAMP_DEFAULT="$(date '+%Y%m%dT%H%M%S')"

REPO_ROOT="${REPO_ROOT_DEFAULT}"
LIVE_DATA_DIR="${REPO_ROOT_DEFAULT}/data"
RECOVERY_ROOT="$(cd "${REPO_ROOT_DEFAULT}/.." && pwd)/recovery-${TIMESTAMP_DEFAULT}"
DEVICE=""
SNAPSHOT_ONLY=0
SKIP_SNAPSHOT=0
DRY_RUN=0
MIN_CANDIDATE_SIZE_BYTES=$((1024 * 1024))
MAX_CANDIDATES=200
declare -a REQUESTED_INODES=()

log() {
  printf '[recovery] %s\n' "$*"
}

fail() {
  printf '[recovery] error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Recover live psfn data in two stages:
1. Snapshot the current psfn-live data tree into a separate recovery root.
2. Optionally scan the backing ext4 block device with debugfs and dump deleted inode candidates.

This script never writes into the live data tree.

Options:
  --repo-root <path>              Repo root to inspect (default: ${REPO_ROOT})
  --live-data-dir <path>          Live data directory (default: ${LIVE_DATA_DIR})
  --recovery-root <path>          Recovery output root (default: ${RECOVERY_ROOT})
  --device <path>                 ext4 block device for debugfs scan
  --snapshot-only                 Copy live artifacts only; skip debugfs deleted-file recovery
  --skip-snapshot                 Skip live artifact copy stage
  --min-candidate-size-bytes <n>  Minimum deleted inode size to dump (default: ${MIN_CANDIDATE_SIZE_BYTES})
  --max-candidates <n>            Maximum auto-selected deleted inodes to dump (default: ${MAX_CANDIDATES})
  --inode <n>                     Dump a specific deleted inode; may be repeated
  --dry-run                       Print planned actions without writing output
  -h, --help                      Show this help text

Examples:
  $(basename "$0") --snapshot-only
  sudo $(basename "$0") --device /dev/nvme0n1p1
  sudo $(basename "$0") --device /dev/nvme0n1p1 --inode 123456 --inode 123789
EOF
}

require_command() {
  local command_name
  for command_name in "$@"; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      fail "Required command not found: ${command_name}"
    fi
  done
}

run_cmd() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

append_manifest_line() {
  local manifest_path="$1"
  shift
  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi
  printf '%b\n' "$*" >>"${manifest_path}"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo-root)
        REPO_ROOT="$2"
        shift 2
        ;;
      --live-data-dir)
        LIVE_DATA_DIR="$2"
        shift 2
        ;;
      --recovery-root)
        RECOVERY_ROOT="$2"
        shift 2
        ;;
      --device)
        DEVICE="$2"
        shift 2
        ;;
      --snapshot-only)
        SNAPSHOT_ONLY=1
        shift
        ;;
      --skip-snapshot)
        SKIP_SNAPSHOT=1
        shift
        ;;
      --min-candidate-size-bytes)
        MIN_CANDIDATE_SIZE_BYTES="$2"
        shift 2
        ;;
      --max-candidates)
        MAX_CANDIDATES="$2"
        shift 2
        ;;
      --inode)
        REQUESTED_INODES+=("$2")
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done
}

validate_args() {
  [ -d "${REPO_ROOT}" ] || fail "Repo root does not exist: ${REPO_ROOT}"
  [ -d "${LIVE_DATA_DIR}" ] || fail "Live data directory does not exist: ${LIVE_DATA_DIR}"

  case "${MIN_CANDIDATE_SIZE_BYTES}" in
    ''|*[!0-9]*)
      fail "--min-candidate-size-bytes must be an integer"
      ;;
  esac

  case "${MAX_CANDIDATES}" in
    ''|*[!0-9]*)
      fail "--max-candidates must be an integer"
      ;;
  esac

  if [ "${SNAPSHOT_ONLY}" -eq 1 ] && [ ${#REQUESTED_INODES[@]} -gt 0 ]; then
    fail "--snapshot-only cannot be combined with --inode"
  fi

  if [ "${SNAPSHOT_ONLY}" -eq 0 ] && [ -z "${DEVICE}" ]; then
    DEVICE="$(findmnt -no SOURCE --target "${LIVE_DATA_DIR}" 2>/dev/null || true)"
  fi
}

warn_if_runtime_active() {
  if pgrep -af 'src/app/gateway/main.ts|src/app/agent/main.ts|start-gateway-agent.sh' >/dev/null 2>&1; then
    log "warning: live runtime processes are active; deleted-file recovery works better with the service stopped"
  fi
}

prepare_recovery_layout() {
  run_cmd mkdir -p "${RECOVERY_ROOT}"
  run_cmd mkdir -p "${RECOVERY_ROOT}/live-copy"
  run_cmd mkdir -p "${RECOVERY_ROOT}/debugfs"
  run_cmd mkdir -p "${RECOVERY_ROOT}/debugfs/candidates"
  run_cmd mkdir -p "${RECOVERY_ROOT}/debugfs/inodes"
  run_cmd mkdir -p "${RECOVERY_ROOT}/debugfs/stats"
  run_cmd mkdir -p "${RECOVERY_ROOT}/logs"
}

snapshot_artifact() {
  local source_path="$1"
  local relative_target="$2"

  if [ ! -e "${source_path}" ]; then
    return 0
  fi

  local target_path="${RECOVERY_ROOT}/live-copy/${relative_target}"
  run_cmd mkdir -p "$(dirname "${target_path}")"
  run_cmd rsync -a "${source_path}" "${target_path}"
}

snapshot_live_tree() {
  local manifest_path="${RECOVERY_ROOT}/logs/live-copy-manifest.tsv"
  if [ "${DRY_RUN}" -eq 0 ]; then
    : >"${manifest_path}"
  fi

  snapshot_artifact "${LIVE_DATA_DIR}/psfn.db" "data/psfn.db"
  snapshot_artifact "${LIVE_DATA_DIR}/psfn.db-wal" "data/psfn.db-wal"
  snapshot_artifact "${LIVE_DATA_DIR}/psfn.db-shm" "data/psfn.db-shm"
  snapshot_artifact "${LIVE_DATA_DIR}/core_memory.json" "data/core_memory.json"
  snapshot_artifact "${LIVE_DATA_DIR}/sessions" "data/sessions"
  snapshot_artifact "${LIVE_DATA_DIR}/contacts/continuity" "data/contacts/continuity"
  snapshot_artifact "${LIVE_DATA_DIR}/notes/reflections" "data/notes/reflections"
  snapshot_artifact "${LIVE_DATA_DIR}/repair-backups" "data/repair-backups"
  snapshot_artifact "${LIVE_DATA_DIR}/backups" "data/backups"

  if [ "${DRY_RUN}" -eq 0 ]; then
    find "${RECOVERY_ROOT}/live-copy" -type f -printf '%P\t%s\t%TY-%Tm-%Td %TH:%TM:%TS\n' | sort >"${manifest_path}"
  fi
}

require_root_for_debugfs() {
  [ "${SNAPSHOT_ONLY}" -eq 1 ] && return 0
  [ -z "${DEVICE}" ] && fail "Unable to resolve block device; pass --device explicitly or use --snapshot-only"
  [ -b "${DEVICE}" ] || fail "Block device does not exist: ${DEVICE}"
  [ "$(id -u)" -eq 0 ] || fail "debugfs recovery requires root; rerun with sudo or use --snapshot-only"
}

capture_debugfs_lsdel() {
  local lsdel_path="${RECOVERY_ROOT}/debugfs/lsdel.txt"
  if [ "${DRY_RUN}" -eq 1 ]; then
    run_cmd debugfs -R lsdel "${DEVICE}"
    printf '%s\n' "${lsdel_path}"
    return 0
  fi
  run_cmd debugfs -R lsdel "${DEVICE}" >"${lsdel_path}" 2>"${RECOVERY_ROOT}/logs/debugfs-lsdel.stderr"
  printf '%s\n' "${lsdel_path}"
}

build_auto_candidate_list() {
  local lsdel_path="$1"
  local candidates_path="${RECOVERY_ROOT}/debugfs/deleted-candidates.tsv"

  if [ "${DRY_RUN}" -eq 1 ]; then
    log "dry-run: would parse deleted inode candidates from ${lsdel_path}"
    printf '%s\n' "${candidates_path}"
    return 0
  fi

  awk -v min_size="${MIN_CANDIDATE_SIZE_BYTES}" '
    /^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+[0-7]+[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]/ {
      inode=$1
      owner=$2
      mode=$3
      size=$4
      blocks=$5
      deleted=$6 " " $7 " " $8 " " $9 " " $10 " " $11
      if ((size + 0) >= min_size) {
        print inode "\t" owner "\t" mode "\t" size "\t" blocks "\t" deleted
      }
    }
  ' "${lsdel_path}" | {
    if [ "${MAX_CANDIDATES}" -gt 0 ]; then
      head -n "${MAX_CANDIDATES}"
    else
      cat
    fi
  } >"${candidates_path}"

  printf '%s\n' "${candidates_path}"
}

dump_inode_candidate() {
  local inode="$1"
  local size_bytes="${2:-unknown}"
  local deleted_at="${3:-unknown}"
  local dump_path="${RECOVERY_ROOT}/debugfs/candidates/inode-${inode}.bin"
  local stat_path="${RECOVERY_ROOT}/debugfs/stats/inode-${inode}.txt"
  local ncheck_path="${RECOVERY_ROOT}/debugfs/inodes/inode-${inode}.ncheck.txt"
  local strings_path="${RECOVERY_ROOT}/debugfs/inodes/inode-${inode}.strings.txt"
  local manifest_path="${RECOVERY_ROOT}/debugfs/recovered-manifest.tsv"

  if [ "${DRY_RUN}" -eq 0 ] && [ ! -f "${manifest_path}" ]; then
    printf 'inode\tsize_bytes\tdeleted_at\tsha256\tfile_type\tdump_path\n' >"${manifest_path}"
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    run_cmd debugfs -R "stat <${inode}>" "${DEVICE}"
    run_cmd debugfs -R "ncheck ${inode}" "${DEVICE}"
    run_cmd debugfs -R "dump <${inode}> ${dump_path}" "${DEVICE}"
    return 0
  fi

  run_cmd debugfs -R "stat <${inode}>" "${DEVICE}" >"${stat_path}" 2>"${RECOVERY_ROOT}/logs/inode-${inode}.stat.stderr"
  run_cmd debugfs -R "ncheck ${inode}" "${DEVICE}" >"${ncheck_path}" 2>"${RECOVERY_ROOT}/logs/inode-${inode}.ncheck.stderr" || true
  run_cmd debugfs -R "dump <${inode}> ${dump_path}" "${DEVICE}" >"${RECOVERY_ROOT}/logs/inode-${inode}.dump.stdout" 2>"${RECOVERY_ROOT}/logs/inode-${inode}.dump.stderr"

  strings -a -n 8 "${dump_path}" | grep -E 'SQLite format 3|l2_memories|contact_profiles|session_messages_index|psfn|jsonl|reflection|continuity' \
    >"${strings_path}" 2>/dev/null || true

  local file_type
  file_type="$(file -b "${dump_path}")"

  local sha256
  sha256="$(sha256sum "${dump_path}" | awk '{print $1}')"

  append_manifest_line "${manifest_path}" "${inode}\t${size_bytes}\t${deleted_at}\t${sha256}\t${file_type}\t${dump_path}"
}

recover_requested_inodes() {
  local inode
  for inode in "${REQUESTED_INODES[@]}"; do
    dump_inode_candidate "${inode}" "requested" "requested"
  done
}

recover_auto_candidates() {
  local candidates_path="$1"
  local line inode size_bytes deleted_at

  while IFS=$'\t' read -r inode _owner _mode size_bytes _blocks deleted_at; do
    [ -n "${inode}" ] || continue
    dump_inode_candidate "${inode}" "${size_bytes}" "${deleted_at}"
  done <"${candidates_path}"
}

main() {
  parse_args "$@"
  validate_args
  warn_if_runtime_active

  require_command rsync findmnt file sha256sum strings
  if [ "${SNAPSHOT_ONLY}" -eq 0 ]; then
    require_command debugfs awk grep head
    require_root_for_debugfs
  fi

  prepare_recovery_layout

  log "repo root: ${REPO_ROOT}"
  log "live data dir: ${LIVE_DATA_DIR}"
  log "recovery root: ${RECOVERY_ROOT}"

  if [ "${SKIP_SNAPSHOT}" -eq 0 ]; then
    log "snapshotting live data artifacts"
    snapshot_live_tree
  else
    log "skipping live artifact snapshot stage"
  fi

  if [ "${SNAPSHOT_ONLY}" -eq 1 ]; then
    log "snapshot-only mode complete"
    return 0
  fi

  log "debugfs device: ${DEVICE}"
  local lsdel_path
  lsdel_path="$(capture_debugfs_lsdel)"
  log "captured deleted inode list: ${lsdel_path}"

  if [ ${#REQUESTED_INODES[@]} -gt 0 ]; then
    log "recovering requested inodes: ${REQUESTED_INODES[*]}"
    recover_requested_inodes
    return 0
  fi

  local candidates_path
  candidates_path="$(build_auto_candidate_list "${lsdel_path}")"
  log "auto-selected deleted inode list: ${candidates_path}"

  if [ "${DRY_RUN}" -eq 0 ] && [ ! -s "${candidates_path}" ]; then
    log "no deleted inode candidates met the current size filter"
    return 0
  fi

  recover_auto_candidates "${candidates_path}"
  log "recovery artifacts written under ${RECOVERY_ROOT}/debugfs"
}

main "$@"
