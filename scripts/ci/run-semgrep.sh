#!/usr/bin/env bash
set -euo pipefail

readonly SEMGREP_IMAGE='semgrep/semgrep:1.170.0@sha256:f42392ee2c00f0de06702135e0e20415f481935900790fbe37aa778591be3999'
readonly SEMGREP_CONFIG='config/semgrep'

mode="${1:-full}"
baseline_commit="${2:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
git_common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"

docker_args=(
  run
  --rm
  --user "$(id -u):$(id -g)"
  --env HOME=/tmp/semgrep-home
  --env XDG_CACHE_HOME=/tmp/semgrep-cache
  --env SEMGREP_ENABLE_VERSION_CHECK=0
  --env SEMGREP_SEND_METRICS=off
  --env GIT_CONFIG_COUNT=1
  --env GIT_CONFIG_KEY_0=safe.directory
  --env "GIT_CONFIG_VALUE_0=$repo_root"
  --volume "$repo_root:$repo_root"
  --workdir "$repo_root"
)

if [[ "$git_common_dir" != "$repo_root/.git" ]]; then
  docker_args+=(--volume "$git_common_dir:$git_common_dir")
fi

case "$mode" in
  test)
    semgrep_args=(
      semgrep
      test
      config/semgrep
    )
    ;;
  full | diff)
    semgrep_args=(
      semgrep
      scan
      --config "$SEMGREP_CONFIG"
      --metrics=off
      --error
      --exclude '**/*.test.*'
      --exclude '**/*.spec.*'
      --exclude 'src/test-support/**'
      --exclude 'src/app/e2e/**'
    )
    if [[ "$mode" == 'diff' ]]; then
      if [[ -z "$baseline_commit" ]]; then
        echo 'usage: scripts/ci/run-semgrep.sh diff <baseline-commit>' >&2
        exit 2
      fi
      semgrep_args+=(--baseline-commit "$baseline_commit")
    fi
    if [[ -n "${SEMGREP_SARIF_OUTPUT:-}" ]]; then
      semgrep_args+=(--sarif-output "$SEMGREP_SARIF_OUTPUT")
    fi
    semgrep_args+=(src scripts admin-ui/src companion-ui/src)
    ;;
  *)
    echo "unknown Semgrep mode: $mode (expected test, full, or diff)" >&2
    exit 2
    ;;
esac

exec docker "${docker_args[@]}" "$SEMGREP_IMAGE" "${semgrep_args[@]}"
