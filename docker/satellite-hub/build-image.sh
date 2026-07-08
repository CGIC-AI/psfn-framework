#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_dir="${SATELLITE_HUB_SOURCE:-${1:-/home/ada/psfn-framework/PSFN-Satellite-Hub}}"
repository="${SATELLITE_HUB_IMAGE_REPOSITORY:-localhost/psfn-satellite-hub}"
platform="${SATELLITE_HUB_PLATFORM:-linux/amd64}"
required_ref="${SATELLITE_HUB_SOURCE_REF:-}"

if [[ ! -d "${source_dir}" ]]; then
  echo "Satellite hub source directory not found: ${source_dir}" >&2
  exit 1
fi

if [[ ! -f "${source_dir}/package-lock.json" ]]; then
  echo "Satellite hub build requires package-lock.json in ${source_dir}" >&2
  exit 1
fi

if ! git -C "${source_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Satellite hub source must be a git checkout so the image can be tied to a commit" >&2
  exit 1
fi

actual_ref="$(git -C "${source_dir}" rev-parse --verify HEAD)"

if [[ -n "${required_ref}" && "${actual_ref}" != "${required_ref}" ]]; then
  echo "Satellite hub source ref mismatch: expected ${required_ref}, found ${actual_ref}" >&2
  exit 1
fi

dirty_status="$(git -C "${source_dir}" status --short)"
if [[ -n "${dirty_status}" && "${SATELLITE_HUB_ALLOW_DIRTY:-false}" != "true" ]]; then
  echo "Satellite hub source has uncommitted changes; set SATELLITE_HUB_ALLOW_DIRTY=true only for throwaway local probes" >&2
  echo "${dirty_status}" >&2
  exit 1
fi

short_ref="${actual_ref:0:12}"
tag="${SATELLITE_HUB_IMAGE_TAG:-0.1.0-kube-${short_ref}}"

case "${tag}" in
  latest|main|main-latest)
    echo "Refusing floating satellite hub image tag: ${tag}" >&2
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
