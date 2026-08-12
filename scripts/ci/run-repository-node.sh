#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 )); then
  printf 'usage: %s <repository-root> <script> [args...]\n' "$0" >&2
  exit 2
fi

repository_root="$1"
shift
version_file="$repository_root/.node-version"

if [[ ! -r "$version_file" ]]; then
  printf 'Repository Node version file is missing: %s\n' "$version_file" >&2
  exit 1
fi

IFS= read -r required_version < "$version_file"
if [[ ! "$required_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'Repository Node version is invalid: %s\n' "$required_version" >&2
  exit 1
fi

run_if_matching() {
  local candidate="$1"
  local actual_version
  shift

  [[ -x "$candidate" ]] || return 1
  actual_version="$("$candidate" --version 2>/dev/null || true)"
  [[ "$actual_version" == "v$required_version" ]] || return 1
  exec "$candidate" "$@"
}

ambient_node="$(command -v node || true)"
if [[ -n "$ambient_node" ]]; then
  run_if_matching "$ambient_node" "$@" || true
fi

nvm_root="${NVM_DIR:-}"
if [[ -z "$nvm_root" && -n "${HOME:-}" ]]; then
  nvm_root="$HOME/.nvm"
fi
if [[ -n "$nvm_root" ]]; then
  run_if_matching "$nvm_root/versions/node/v$required_version/bin/node" "$@" || true
fi

mise_data_root="${MISE_DATA_DIR:-}"
if [[ -z "$mise_data_root" && -n "${XDG_DATA_HOME:-}" ]]; then
  mise_data_root="$XDG_DATA_HOME/mise"
elif [[ -z "$mise_data_root" && -n "${HOME:-}" ]]; then
  mise_data_root="$HOME/.local/share/mise"
fi
if [[ -n "$mise_data_root" ]]; then
  run_if_matching "$mise_data_root/installs/node/$required_version/bin/node" "$@" || true
fi

ambient_version='unavailable'
if [[ -n "$ambient_node" ]]; then
  ambient_version="$("$ambient_node" --version 2>/dev/null || printf 'unhealthy')"
fi
printf 'Node %s is required by %s; ambient node is %s. Install it with `nvm install %s` or another .node-version-compatible manager.\n' \
  "$required_version" "$version_file" "$ambient_version" "$required_version" >&2
exit 1
