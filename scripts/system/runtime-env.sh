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

psfn_is_production_runtime() {
  if psfn_is_production_layout_mode "${PSFN_RUNTIME_LAYOUT_MODE:-}"; then
    return 0
  fi

  case "$(psfn_normalize_layout_mode "${NODE_ENV:-}")" in
    production|prod)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

psfn_require_node_major() {
  local required_major="${1:-22}"
  local detected_major=""
  local detected_version=""

  if ! command -v node >/dev/null 2>&1; then
    echo "[launcher] Node.js ${required_major}+ is required but node is not on PATH. Set PATH in the repo-owned service/env config." >&2
    return 1
  fi

  detected_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  detected_version="$(node -v 2>/dev/null || true)"
  case "${detected_major}" in
    ''|*[!0-9]*)
      echo "[launcher] Unable to determine Node.js version (${detected_version:-unknown}); Node.js ${required_major}+ is required." >&2
      return 1
      ;;
  esac

  if [ "${detected_major}" -lt "${required_major}" ]; then
    echo "[launcher] Node.js ${required_major}+ is required; found ${detected_version:-major ${detected_major}}. Set PATH in the repo-owned service/env config." >&2
    return 1
  fi
}

psfn_require_env_var() {
  local name="$1"
  local detail="${2:-}"

  if [ -n "${!name:-}" ]; then
    return 0
  fi

  if [ -n "${detail}" ]; then
    echo "[launcher] Production runtime requires ${name}: ${detail}" >&2
  else
    echo "[launcher] Production runtime requires ${name}." >&2
  fi
  return 1
}

psfn_is_truthy_env_value() {
  case "$(psfn_normalize_layout_mode "${1:-}")" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

psfn_require_one_env_var() {
  local left="$1"
  local right="$2"
  local detail="${3:-}"

  if [ -n "${!left:-}" ] || [ -n "${!right:-}" ]; then
    return 0
  fi

  if [ -n "${detail}" ]; then
    echo "[launcher] Production runtime requires ${left} or ${right}: ${detail}" >&2
  else
    echo "[launcher] Production runtime requires ${left} or ${right}." >&2
  fi
  return 1
}

psfn_require_production_launcher_env() {
  if ! psfn_is_production_runtime; then
    return 0
  fi

  psfn_require_env_var "API_HOST" "explicit API bind host" || return 1
  psfn_require_env_var "API_PORT" "explicit API bind port" || return 1
  psfn_require_env_var "API_KEY" "production API must not rely on ALLOW_INSECURE_LOCAL_API" || return 1
  psfn_require_env_var "ADMIN_HOST" "explicit Garden/admin bind host" || return 1
  psfn_require_env_var "ADMIN_PORT" "explicit Garden/admin bind port" || return 1
  psfn_require_env_var "ADMIN_TOKEN" "production admin transport must be authenticated" || return 1
  psfn_require_one_env_var \
    "GATEWAY_SESSION_HMAC_KEYS" \
    "GATEWAY_SESSION_HMAC_KEY" \
    "production session integrity must not use the dev fallback key" || return 1

  if psfn_is_truthy_env_value "${ALLOW_INSECURE_LOCAL_API:-}"; then
    echo "[launcher] Production runtime forbids ALLOW_INSECURE_LOCAL_API=true." >&2
    return 1
  fi
  if psfn_is_truthy_env_value "${ADMIN_ALLOW_INSECURE:-}"; then
    echo "[launcher] Production runtime forbids ADMIN_ALLOW_INSECURE=true." >&2
    return 1
  fi
  if [ "${GATEWAY_SESSION_HMAC_KEY:-}" = "psfn-dev-session-hmac" ]; then
    echo "[launcher] Production runtime forbids the default dev GATEWAY_SESSION_HMAC_KEY." >&2
    return 1
  fi
}

psfn_can_use_socket_dir() {
  local socket_dir="$1"
  local probe_path=""

  if [ -z "${socket_dir}" ]; then
    return 1
  fi
  if ! mkdir -p "${socket_dir}" 2>/dev/null; then
    return 1
  fi
  if [ ! -d "${socket_dir}" ] || [ ! -w "${socket_dir}" ]; then
    return 1
  fi

  probe_path="${socket_dir}/.psfn-write-test.$$"
  if ! : > "${probe_path}" 2>/dev/null; then
    return 1
  fi
  rm -f "${probe_path}" 2>/dev/null || true
  return 0
}

psfn_resolve_gateway_socket_path() {
  local default_socket_path="$1"
  local fallback_socket_path="$2"
  local default_dir=""
  local fallback_dir=""

  if [ -n "${GATEWAY_SOCKET:-}" ]; then
    printf '%s\n' "${GATEWAY_SOCKET}"
    return 0
  fi

  default_dir="$(dirname "${default_socket_path}")"
  if psfn_can_use_socket_dir "${default_dir}"; then
    printf '%s\n' "${default_socket_path}"
    return 0
  fi

  if psfn_is_production_runtime; then
    echo "[launcher] Production runtime requires an explicit writable GATEWAY_SOCKET or a writable ${default_dir} directory." >&2
    return 1
  fi

  fallback_dir="$(dirname "${fallback_socket_path}")"
  if ! psfn_can_use_socket_dir "${fallback_dir}"; then
    echo "[launcher] Unable to create fallback gateway socket directory: ${fallback_dir}" >&2
    return 1
  fi
  printf '%s\n' "${fallback_socket_path}"
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
