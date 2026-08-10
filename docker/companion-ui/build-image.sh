#!/usr/bin/env bash
set -euo pipefail

# Build the companion-ui test web image from this repo's companion-ui/ source.
# Mirrors docker/satellite-hub/build-image.sh: pinned base, commit-tied tag,
# floating-tag refusal and clean-tree guard. Unlike the Hub application, the
# companion-ui source lives in THIS repo, so the build context is the repo root.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root_default="$(cd -- "${script_dir}/../.." && pwd)"
source_dir="${COMPANION_UI_SOURCE:-${1:-${repo_root_default}}}"
repository="${COMPANION_UI_IMAGE_REPOSITORY:-localhost/psfn-companion-ui}"
# The target is a Pi (arm64); override COMPANION_UI_PLATFORM=linux/amd64 for a
# local same-arch verification build.
platform="${COMPANION_UI_PLATFORM:-linux/arm64}"
required_ref="${COMPANION_UI_SOURCE_REF:-}"

if [[ ! -d "${source_dir}" ]]; then
  echo "companion-ui source directory not found: ${source_dir}" >&2
  exit 1
fi

if [[ ! -f "${source_dir}/companion-ui/package-lock.json" ]]; then
  echo "companion-ui build requires companion-ui/package-lock.json in ${source_dir}" >&2
  exit 1
fi

if ! git -C "${source_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "companion-ui source must be a git checkout so the image can be tied to a commit" >&2
  exit 1
fi

actual_ref="$(git -C "${source_dir}" rev-parse --verify HEAD)"

if [[ -n "${required_ref}" && "${actual_ref}" != "${required_ref}" ]]; then
  echo "companion-ui source ref mismatch: expected ${required_ref}, found ${actual_ref}" >&2
  exit 1
fi

dirty_status="$(git -C "${source_dir}" status --short)"
if [[ -n "${dirty_status}" && "${COMPANION_UI_ALLOW_DIRTY:-false}" != "true" ]]; then
  echo "companion-ui source has uncommitted changes; set COMPANION_UI_ALLOW_DIRTY=true only for throwaway local probes" >&2
  echo "${dirty_status}" >&2
  exit 1
fi

short_ref="${actual_ref:0:12}"
tag="${COMPANION_UI_IMAGE_TAG:-0.1.0-kube-${short_ref}}"

case "${tag}" in
  latest|main|main-latest)
    echo "Refusing floating companion-ui image tag: ${tag}" >&2
    exit 1
    ;;
esac

docker build \
  --platform "${platform}" \
  --build-arg "SOURCE_REVISION=${actual_ref}" \
  --label "org.opencontainers.image.revision=${actual_ref}" \
  -f "${script_dir}/Dockerfile" \
  -t "${repository}:${tag}" \
  "${source_dir}"

printf '%s\n' "${repository}:${tag}"
