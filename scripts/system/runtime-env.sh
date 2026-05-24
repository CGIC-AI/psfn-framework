#!/usr/bin/env bash

psfn_normalize_layout_mode() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

psfn_is_production_layout_mode() {
  case "$(psfn_normalize_layout_mode "${1:-}")" in
    production|prod|live)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

psfn_resolve_runtime_workspace_path() {
  if [ -n "${WORKSPACE_PATH:-}" ]; then
    printf '%s\n' "${WORKSPACE_PATH}"
    return 0
  fi

  local runtime_root="${PSFN_RUNTIME_ROOT:-}"
  if psfn_is_production_layout_mode "${PSFN_RUNTIME_LAYOUT_MODE:-}"; then
    if [ -n "${runtime_root}" ]; then
      printf '%s\n' "${runtime_root%/}/workspace"
    else
      printf '%s\n' "./runtime/production/workspace"
    fi
    return 0
  fi

  if [ -n "${DATA_DIR:-}" ] && [ -z "${SYSTEM_DATA_DIR:-}" ] && [ -z "${COMPANION_DATA_DIR:-}" ]; then
    if [ -n "${runtime_root}" ] && [ "${runtime_root}" != "." ]; then
      printf '%s\n' "${runtime_root%/}/workspace"
    else
      printf '%s\n' "./workspace"
    fi
    return 0
  fi

  if [ -n "${runtime_root}" ] && [ "${runtime_root}" != "." ]; then
    printf '%s\n' "${runtime_root%/}/workspace"
  else
    printf '%s\n' "./workspace"
  fi
}

psfn_resolve_companion_data_dir() {
  if [ -n "${COMPANION_DATA_DIR:-}" ]; then
    printf '%s\n' "${COMPANION_DATA_DIR}"
    return 0
  fi

  if [ -n "${DATA_DIR:-}" ]; then
    printf '%s\n' "${DATA_DIR}"
    return 0
  fi

  local runtime_root="${PSFN_RUNTIME_ROOT:-}"
  if psfn_is_production_layout_mode "${PSFN_RUNTIME_LAYOUT_MODE:-}"; then
    if [ -n "${runtime_root}" ]; then
      printf '%s\n' "${runtime_root%/}/companion-data"
    else
      printf '%s\n' "./runtime/production/companion-data"
    fi
    return 0
  fi

  if [ -n "${runtime_root}" ] && [ "${runtime_root}" != "." ]; then
    printf '%s\n' "${runtime_root%/}/companion"
  else
    printf '%s\n' "./companion"
  fi
}

psfn_resolve_system_data_dir() {
  if [ -n "${SYSTEM_DATA_DIR:-}" ]; then
    printf '%s\n' "${SYSTEM_DATA_DIR}"
    return 0
  fi

  if [ -n "${DATA_DIR:-}" ]; then
    printf '%s\n' "${DATA_DIR}"
    return 0
  fi

  local runtime_root="${PSFN_RUNTIME_ROOT:-}"
  if psfn_is_production_layout_mode "${PSFN_RUNTIME_LAYOUT_MODE:-}"; then
    if [ -n "${runtime_root}" ]; then
      printf '%s\n' "${runtime_root%/}/system-data"
    else
      printf '%s\n' "./runtime/production/system-data"
    fi
    return 0
  fi

  if [ -n "${runtime_root}" ] && [ "${runtime_root}" != "." ]; then
    printf '%s\n' "${runtime_root%/}/data"
  else
    printf '%s\n' "./data"
  fi
}

psfn_first_existing_file() {
  local candidate
  for candidate in "$@"; do
    if [ -n "${candidate}" ] && [ -f "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

psfn_source_dotenv_preserving_existing_env() {
  local dotenv_file="${1:-}"
  if [ -z "${dotenv_file}" ] || [ ! -f "${dotenv_file}" ]; then
    return 0
  fi

  local -A existing_env=()
  local entry name value
  while IFS= read -r -d '' entry; do
    name="${entry%%=*}"
    value="${entry#*=}"
    existing_env["${name}"]="${value}"
  done < <(env -0)

  set -a
  # shellcheck disable=SC1090
  source "${dotenv_file}"
  set +a

  for name in "${!existing_env[@]}"; do
    printf -v "${name}" '%s' "${existing_env[${name}]}"
    export "${name}"
  done
}

psfn_detect_module_registry_path() {
  local workspace_path companion_data_dir
  workspace_path="$(psfn_resolve_runtime_workspace_path)"
  companion_data_dir="$(psfn_resolve_companion_data_dir)"

  local candidates=(
    "./modules/repl-registry.json"
    "./companion/modules/repl-registry.json"
    "./psfn/modules/repl-registry.json"
    "${companion_data_dir%/}/modules/repl-registry.json"
    "${workspace_path%/}/psfn/modules/repl-registry.json"
    "${workspace_path%/}/modules/repl-registry.json"
  )

  local previous_nullglob
  previous_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  local candidate
  for candidate in "${workspace_path%/}"/*/modules/repl-registry.json; do
    candidates+=("${candidate}")
  done
  if [ -n "${previous_nullglob}" ]; then
    eval "${previous_nullglob}"
  else
    shopt -u nullglob
  fi

  psfn_first_existing_file "${candidates[@]}"
}

psfn_detect_vad_lexicon_path() {
  local system_data_dir
  system_data_dir="$(psfn_resolve_system_data_dir)"

  psfn_first_existing_file \
    "./companion/emotion/nrc-vad-lexicon-v2.tsv" \
    "./psfn/emotion/nrc-vad-lexicon-v2.tsv" \
    "${system_data_dir%/}/emotion/nrc-vad-lexicon-v2.tsv"
}

psfn_export_default_module_registry_path() {
  if [ -n "${MODULE_REGISTRY_PATH:-}" ]; then
    return 0
  fi

  local detected_path
  detected_path="$(psfn_detect_module_registry_path || true)"
  if [ -z "${detected_path}" ]; then
    export MODULE_REGISTRY_PATH="modules/repl-registry.json"
    echo "[launcher] MODULE_REGISTRY_PATH not set; defaulting to ${MODULE_REGISTRY_PATH}"
    return 0
  fi

  export MODULE_REGISTRY_PATH="${detected_path}"
  echo "[launcher] MODULE_REGISTRY_PATH not set; defaulting to ${MODULE_REGISTRY_PATH}"
}

psfn_export_default_vad_lexicon_path() {
  if [ -n "${NRC_VAD_LEXICON_PATH:-}" ]; then
    return 0
  fi

  local detected_path
  detected_path="$(psfn_detect_vad_lexicon_path || true)"
  if [ -z "${detected_path}" ]; then
    return 0
  fi

  export NRC_VAD_LEXICON_PATH="${detected_path}"
  echo "[launcher] NRC_VAD_LEXICON_PATH not set; defaulting to ${NRC_VAD_LEXICON_PATH}"
}
