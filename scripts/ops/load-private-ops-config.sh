#!/usr/bin/env bash

load_private_ops_config() {
  local script_dir=$1
  local default_config="${script_dir}/private-ops.env"
  local config_path="${PSFN_OPS_CONFIG:-$default_config}"

  if [[ -n "${PSFN_OPS_CONFIG:-}" && ! -r "$config_path" ]]; then
    printf 'FAIL: PSFN_OPS_CONFIG is not readable: %s\n' "$config_path" >&2
    return 1
  fi
  if [[ -r "$config_path" ]]; then
    # shellcheck disable=SC1090
    source "$config_path"
  fi
}

require_private_ops_value() {
  local variable_name=$1
  local cli_hint=$2
  local display_name=${3:-$variable_name}
  local value=${!variable_name:-}
  if [[ -z "$value" ]]; then
    printf 'FAIL: %s is required (%s or scripts/ops/private-ops.env)\n' \
      "$display_name" "$cli_hint" >&2
    return 1
  fi
}
