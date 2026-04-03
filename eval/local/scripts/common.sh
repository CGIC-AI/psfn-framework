#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/../../.." && pwd)
PROFILE_DIR="${SCRIPT_DIR}/../profiles"

die() {
  printf '[eval/local] %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

resolve_repo_path() {
  local candidate="${1:-}"
  [[ -n "$candidate" ]] || die "path value is required"
  if [[ "$candidate" = /* ]]; then
    printf '%s\n' "$candidate"
    return
  fi
  printf '%s/%s\n' "$REPO_ROOT" "$candidate"
}

list_profiles() {
  find "$PROFILE_DIR" -maxdepth 1 -type f -name '*.env' -printf '%f\n' \
    | sed 's/\.env$//' \
    | sort
}

load_profile() {
  local profile_name="${1:-}"
  [[ -n "$profile_name" ]] || die "profile name required. Available: $(list_profiles | tr '\n' ' ')"

  local profile_path="${PROFILE_DIR}/${profile_name}.env"
  [[ -f "$profile_path" ]] || die "unknown profile: $profile_name"

  set -a
  # shellcheck disable=SC1090
  source "$profile_path"
  set +a

  export PROFILE_NAME="$profile_name"
  export PROFILE_PATH="$profile_path"
}

require_profile_field() {
  local field_name="${1:?field name required}"
  [[ -n "${!field_name:-}" ]] || die "profile ${PROFILE_NAME:-unknown} is missing ${field_name}"
}

print_command() {
  printf '[eval/local]'
  printf ' %q' "$@"
  printf '\n'
}
