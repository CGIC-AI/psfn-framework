#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_DEFAULT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UNIT_TEMPLATE_PATH="${SCRIPT_DIR}/psfn.service.template"

SERVICE_USER="psfn"
SERVICE_GROUP="psfn"
SERVICE_HOME="/var/lib/psfn"
APP_ROOT="/var/lib/psfn/app"
RUNTIME_ROOT="/var/lib/psfn/runtime"
ENV_FILE="/etc/psfn/psfn.env"
UNIT_FILE="/etc/systemd/system/psfn.service"
SOURCE_REPO_ROOT="${REPO_ROOT_DEFAULT}"
ENV_SOURCE="${REPO_ROOT_DEFAULT}/.env"
LEGACY_DATA_DIR="${REPO_ROOT_DEFAULT}/data"
ENV_SOURCE_EXPLICIT=0
LEGACY_DATA_DIR_EXPLICIT=0
SERVICE_MODE="yolo"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
STAGING_ROOT=""
DRY_RUN=0
ENABLE_SERVICE=0
MIGRATE_DATA=0

RUNTIME_SUBDIRS=(
  "system-data"
  "companion-data"
  "workspace"
  "logs"
  "tmp"
  "backups"
)

ENV_FILTER_PATTERN='^(export[[:space:]]+)?(DATA_DIR|SYSTEM_DATA_DIR|COMPANION_DATA_DIR|WORKSPACE_PATH|PSFN_LOGS_DIR|PSFN_TEMP_DIR|BACKUP_ROOT_DIR|PSFN_RUNTIME_ROOT|PSFN_RUNTIME_LAYOUT_MODE|PSFN_RUNTIME_MODE|GATEWAY_SOCKET|MODULE_REGISTRY_PATH|NRC_VAD_LEXICON_PATH|PSFN_SKIP_DOTENV|DATABASE_PATH|AUDIT_DB_PATH|PATH|HOME)='

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Provision a dedicated psfn system-account deployment with:
- a service-owned app checkout
- a bundled node binary outside the operator home directory
- a production runtime root
- a systemd service unit

Options:
  --source-repo-root <path>  Source checkout to deploy (default: ${SOURCE_REPO_ROOT})
  --service-user <name>      Service user to create/use (default: ${SERVICE_USER})
  --service-group <name>     Service group to create/use (default: ${SERVICE_GROUP})
  --service-home <path>      Service home directory (default: ${SERVICE_HOME})
  --app-root <path>          Service-owned app checkout destination (default: ${APP_ROOT})
  --runtime-root <path>      Production runtime root (default: ${RUNTIME_ROOT})
  --env-source <path>        Source .env file to copy/filter (default: ${ENV_SOURCE})
  --env-file <path>          Destination systemd env file (default: ${ENV_FILE})
  --unit-file <path>         Destination systemd unit file (default: ${UNIT_FILE})
  --legacy-data-dir <path>   Legacy shared data root for cutover (default: ${LEGACY_DATA_DIR})
  --node-bin <path>          Node binary to bundle into the app root (default: autodetect)
  --mode <split|yolo>        Runtime mode for the service (default: ${SERVICE_MODE})
  --migrate-data             Apply persistence cutover into the production runtime root
  --enable                   Run systemctl daemon-reload and enable --now the unit
  --staging-root <path>      Write all default system paths under a staging prefix for dry runs/validation
  --dry-run                  Print the resolved plan without mutating the filesystem
  -h, --help                 Show this help text
EOF
}

log() {
  printf '[psfn-install] %s\n' "$*"
}

fail() {
  printf '[psfn-install] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local command_name
  for command_name in "$@"; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      fail "Required command not found: ${command_name}"
    fi
  done
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

is_default_path() {
  [ "$1" = "$2" ]
}

stage_default_path() {
  local current_value="$1"
  local default_value="$2"
  if [ -z "${STAGING_ROOT}" ] || ! is_default_path "${current_value}" "${default_value}"; then
    printf '%s\n' "${current_value}"
    return 0
  fi
  printf '%s%s\n' "${STAGING_ROOT}" "${default_value}"
}

resolve_paths() {
  if [ "${ENV_SOURCE_EXPLICIT}" -eq 0 ]; then
    ENV_SOURCE="${SOURCE_REPO_ROOT}/.env"
  fi
  if [ "${LEGACY_DATA_DIR_EXPLICIT}" -eq 0 ]; then
    LEGACY_DATA_DIR="${SOURCE_REPO_ROOT}/data"
  fi

  SERVICE_HOME="$(stage_default_path "${SERVICE_HOME}" "/var/lib/psfn")"
  APP_ROOT="$(stage_default_path "${APP_ROOT}" "/var/lib/psfn/app")"
  RUNTIME_ROOT="$(stage_default_path "${RUNTIME_ROOT}" "/var/lib/psfn/runtime")"
  ENV_FILE="$(stage_default_path "${ENV_FILE}" "/etc/psfn/psfn.env")"
  UNIT_FILE="$(stage_default_path "${UNIT_FILE}" "/etc/systemd/system/psfn.service")"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --source-repo-root)
        SOURCE_REPO_ROOT="$2"
        shift 2
        ;;
      --service-user)
        SERVICE_USER="$2"
        shift 2
        ;;
      --service-group)
        SERVICE_GROUP="$2"
        shift 2
        ;;
      --service-home)
        SERVICE_HOME="$2"
        shift 2
        ;;
      --app-root)
        APP_ROOT="$2"
        shift 2
        ;;
      --runtime-root)
        RUNTIME_ROOT="$2"
        shift 2
        ;;
      --env-source)
        ENV_SOURCE="$2"
        ENV_SOURCE_EXPLICIT=1
        shift 2
        ;;
      --env-file)
        ENV_FILE="$2"
        shift 2
        ;;
      --unit-file)
        UNIT_FILE="$2"
        shift 2
        ;;
      --legacy-data-dir)
        LEGACY_DATA_DIR="$2"
        LEGACY_DATA_DIR_EXPLICIT=1
        shift 2
        ;;
      --node-bin)
        NODE_BIN="$2"
        shift 2
        ;;
      --mode)
        SERVICE_MODE="$2"
        shift 2
        ;;
      --migrate-data)
        MIGRATE_DATA=1
        shift
        ;;
      --enable)
        ENABLE_SERVICE=1
        shift
        ;;
      --staging-root)
        STAGING_ROOT="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done
}

assert_valid_mode() {
  case "${SERVICE_MODE}" in
    split|yolo)
      return 0
      ;;
    *)
      fail "Unsupported --mode value: ${SERVICE_MODE}"
      ;;
  esac
}

assert_source_tree() {
  [ -d "${SOURCE_REPO_ROOT}" ] || fail "Source repo root does not exist: ${SOURCE_REPO_ROOT}"
  [ -f "${SOURCE_REPO_ROOT}/package.json" ] || fail "Source repo root is missing package.json: ${SOURCE_REPO_ROOT}"
  [ -f "${SOURCE_REPO_ROOT}/scripts/start-gateway-agent.sh" ] || fail "Source repo root is missing scripts/start-gateway-agent.sh"
  [ -f "${SOURCE_REPO_ROOT}/node_modules/.bin/tsx" ] || fail "Source repo root is missing node_modules/.bin/tsx"
  git -C "${SOURCE_REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Source repo root is not a git work tree: ${SOURCE_REPO_ROOT}"
}

assert_node_bin() {
  [ -n "${NODE_BIN}" ] || fail "Unable to resolve a node binary; pass --node-bin explicitly"
  [ -x "${NODE_BIN}" ] || fail "Node binary is not executable: ${NODE_BIN}"
}

ensure_parent_dirs() {
  mkdir -p "$(dirname "${ENV_FILE}")"
  mkdir -p "$(dirname "${UNIT_FILE}")"
  mkdir -p "${SERVICE_HOME}"
}

ensure_system_account() {
  if [ -n "${STAGING_ROOT}" ]; then
    return 0
  fi

  if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    log "Creating system group ${SERVICE_GROUP}"
    groupadd --system "${SERVICE_GROUP}"
  fi

  if ! getent passwd "${SERVICE_USER}" >/dev/null 2>&1; then
    log "Creating system user ${SERVICE_USER}"
    useradd \
      --system \
      --gid "${SERVICE_GROUP}" \
      --home-dir "${SERVICE_HOME}" \
      --create-home \
      --shell /usr/sbin/nologin \
      "${SERVICE_USER}"
  fi
}

sync_app_checkout() {
  require_command git rsync
  local source_branch
  source_branch="$(git -C "${SOURCE_REPO_ROOT}" rev-parse --abbrev-ref HEAD)"
  local source_ref
  if [ "${source_branch}" = "HEAD" ]; then
    source_ref="$(git -C "${SOURCE_REPO_ROOT}" rev-parse HEAD)"
  else
    source_ref="deploy-source/${source_branch}"
  fi

  if [ ! -d "${APP_ROOT}/.git" ]; then
    rm -rf "${APP_ROOT}"
    log "Cloning source repo into ${APP_ROOT}"
    git clone --no-hardlinks "${SOURCE_REPO_ROOT}" "${APP_ROOT}"
  else
    log "Refreshing existing app checkout at ${APP_ROOT}"
  fi

  if git -C "${APP_ROOT}" remote get-url deploy-source >/dev/null 2>&1; then
    git -C "${APP_ROOT}" remote set-url deploy-source "${SOURCE_REPO_ROOT}"
  else
    git -C "${APP_ROOT}" remote add deploy-source "${SOURCE_REPO_ROOT}"
  fi

  git -C "${APP_ROOT}" fetch --prune deploy-source
  git -C "${APP_ROOT}" checkout --force "${source_ref}" >/dev/null 2>&1 || git -C "${APP_ROOT}" checkout --force "$(git -C "${SOURCE_REPO_ROOT}" rev-parse HEAD)"

  rsync -a --delete \
    --exclude '.git' \
    --exclude '.git/' \
    --exclude '.beads/' \
    --exclude '.env' \
    --exclude 'data/' \
    --exclude 'runtime/' \
    --exclude 'logs/' \
    --exclude 'tmp/' \
    --exclude '.codex-last-message.txt' \
    "${SOURCE_REPO_ROOT}/" "${APP_ROOT}/"
}

bundle_node_binary() {
  local bundled_node_dir="${APP_ROOT}/tools/node/bin"
  mkdir -p "${bundled_node_dir}"
  install -m 0755 "${NODE_BIN}" "${bundled_node_dir}/node"
}

resolve_legacy_database_basename() {
  if [ -f "${ENV_SOURCE}" ]; then
    local configured_database_path
    configured_database_path="$(
      ENV_SOURCE_PATH="${ENV_SOURCE}" bash -lc '
        set -euo pipefail
        DATABASE_PATH=""
        set -a
        # shellcheck disable=SC1090
        source "${ENV_SOURCE_PATH}"
        set +a
        printf "%s" "${DATABASE_PATH:-}"
      ' 2>/dev/null || true
    )"
    if [ -n "${configured_database_path}" ]; then
      basename "${configured_database_path}"
      return 0
    fi
  fi

  local previous_nullglob
  previous_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  local candidates=()
  local candidate
  for candidate in "${LEGACY_DATA_DIR}"/*.db; do
    local base_name
    base_name="$(basename "${candidate}")"
    if [ "${base_name}" = "gateway-audit.db" ]; then
      continue
    fi
    candidates+=("${base_name}")
  done
  if [ -n "${previous_nullglob}" ]; then
    eval "${previous_nullglob}"
  else
    shopt -u nullglob
  fi

  if [ "${#candidates[@]}" -eq 1 ]; then
    printf '%s\n' "${candidates[0]}"
    return 0
  fi

  printf '%s\n' "companion.db"
}

write_env_file() {
  mkdir -p "$(dirname "${ENV_FILE}")"
  {
    printf '# Generated by %s\n' "$(basename "$0")"
    printf '# Service-specific runtime layout wiring is injected by systemd.\n'
    if [ -f "${ENV_SOURCE}" ]; then
      grep -Ev "${ENV_FILTER_PATTERN}" "${ENV_SOURCE}" || true
    fi
  } > "${ENV_FILE}"
}

create_runtime_dirs() {
  mkdir -p "${RUNTIME_ROOT}"
  local subdir
  for subdir in "${RUNTIME_SUBDIRS[@]}"; do
    mkdir -p "${RUNTIME_ROOT}/${subdir}"
  done
}

render_unit_file() {
  local bundled_node_bin="${APP_ROOT}/tools/node/bin/node"
  local bundled_node_dir
  bundled_node_dir="$(dirname "${bundled_node_bin}")"

  sed \
    -e "s/__APP_ROOT__/$(escape_sed_replacement "${APP_ROOT}")/g" \
    -e "s/__RUNTIME_ROOT__/$(escape_sed_replacement "${RUNTIME_ROOT}")/g" \
    -e "s/__SERVICE_USER__/$(escape_sed_replacement "${SERVICE_USER}")/g" \
    -e "s/__SERVICE_GROUP__/$(escape_sed_replacement "${SERVICE_GROUP}")/g" \
    -e "s/__SERVICE_HOME__/$(escape_sed_replacement "${SERVICE_HOME}")/g" \
    -e "s/__SERVICE_MODE__/$(escape_sed_replacement "${SERVICE_MODE}")/g" \
    -e "s/__ENV_FILE__/$(escape_sed_replacement "${ENV_FILE}")/g" \
    -e "s/__NODE_BIN__/$(escape_sed_replacement "${bundled_node_bin}")/g" \
    -e "s/__NODE_PATH__/$(escape_sed_replacement "${bundled_node_dir}")/g" \
    "${UNIT_TEMPLATE_PATH}" > "${UNIT_FILE}"
}

validate_rendered_unit() {
  require_command systemd-analyze
  systemd-analyze verify "${UNIT_FILE}"
}

run_cutover() {
  local bundled_node_bin="${APP_ROOT}/tools/node/bin/node"
  local legacy_database_basename
  legacy_database_basename="$(resolve_legacy_database_basename)"
  log "Applying persistence cutover from ${LEGACY_DATA_DIR} into ${RUNTIME_ROOT}"
  (
    cd "${APP_ROOT}"
    env -u DATA_DIR \
      PSFN_RUNTIME_LAYOUT_MODE=production \
      PSFN_RUNTIME_ROOT="${RUNTIME_ROOT}" \
      SYSTEM_DATA_DIR="${RUNTIME_ROOT}/system-data" \
      COMPANION_DATA_DIR="${RUNTIME_ROOT}/companion-data" \
      DATABASE_PATH="${RUNTIME_ROOT}/companion-data/${legacy_database_basename}" \
      "${bundled_node_bin}" ./node_modules/.bin/tsx ./src/app/maintenance/migrate-persistence-layout.ts --apply --legacy-data-dir "${LEGACY_DATA_DIR}"
  )
}

apply_ownership() {
  if [ -n "${STAGING_ROOT}" ]; then
    return 0
  fi

  chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${SERVICE_HOME}"
  chown -R root:"${SERVICE_GROUP}" "$(dirname "${ENV_FILE}")"
  chown root:"${SERVICE_GROUP}" "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
}

enable_system_service() {
  if [ -n "${STAGING_ROOT}" ] || [ "${ENABLE_SERVICE}" -eq 0 ]; then
    return 0
  fi

  systemctl daemon-reload
  systemctl enable --now "$(basename "${UNIT_FILE}")"
}

print_plan() {
  cat <<EOF
service_user=${SERVICE_USER}
service_group=${SERVICE_GROUP}
service_home=${SERVICE_HOME}
source_repo_root=${SOURCE_REPO_ROOT}
app_root=${APP_ROOT}
runtime_root=${RUNTIME_ROOT}
env_source=${ENV_SOURCE}
env_file=${ENV_FILE}
unit_file=${UNIT_FILE}
node_bin=${NODE_BIN}
service_mode=${SERVICE_MODE}
legacy_data_dir=${LEGACY_DATA_DIR}
staging_root=${STAGING_ROOT:-<none>}
migrate_data=${MIGRATE_DATA}
enable_service=${ENABLE_SERVICE}
dry_run=${DRY_RUN}
EOF
}

main() {
  parse_args "$@"
  resolve_paths
  assert_valid_mode
  require_command sed grep mkdir install
  assert_source_tree
  assert_node_bin

  if [ "${DRY_RUN}" -eq 0 ] && [ -z "${STAGING_ROOT}" ] && [ "${EUID}" -ne 0 ]; then
    fail "Actual installation requires root. Use --dry-run or --staging-root for non-privileged validation."
  fi

  print_plan
  if [ "${DRY_RUN}" -eq 1 ]; then
    exit 0
  fi

  ensure_parent_dirs
  ensure_system_account
  sync_app_checkout
  bundle_node_binary
  write_env_file
  create_runtime_dirs
  render_unit_file
  validate_rendered_unit
  if [ "${MIGRATE_DATA}" -eq 1 ]; then
    run_cutover
  fi
  apply_ownership
  enable_system_service
}

main "$@"
