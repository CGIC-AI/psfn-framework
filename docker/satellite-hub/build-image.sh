#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "${script_dir}/../.." rev-parse --show-toplevel)"
source_dir="${repo_root}/apps/satellite-hub"
repository="${SATELLITE_HUB_IMAGE_REPOSITORY:-localhost/psfn-satellite-hub}"
platform="${SATELLITE_HUB_PLATFORM:-linux/amd64}"
required_ref="${SATELLITE_HUB_MONOREPO_REF:-}"

if [[ ! -f "${source_dir}/package-lock.json" ]]; then
  echo "Satellite Hub package-lock.json is missing from ${source_dir}" >&2
  exit 1
fi

actual_ref="$(git -C "${repo_root}" rev-parse --verify HEAD)"

if [[ -n "${required_ref}" && "${actual_ref}" != "${required_ref}" ]]; then
  echo "Satellite Hub monorepo ref mismatch: expected ${required_ref}, found ${actual_ref}" >&2
  exit 1
fi

dirty_status="$(
  git -C "${repo_root}" status --short --untracked-files=all -- \
    apps/satellite-hub docker/satellite-hub
)"
if [[ -n "${dirty_status}" && "${SATELLITE_HUB_ALLOW_DIRTY:-false}" != "true" ]]; then
  echo "Satellite Hub build inputs have uncommitted changes; set SATELLITE_HUB_ALLOW_DIRTY=true only for throwaway local probes" >&2
  echo "${dirty_status}" >&2
  exit 1
fi

short_ref="${actual_ref:0:12}"
tag="${SATELLITE_HUB_IMAGE_TAG:-0.1.0-kube-${short_ref}}"

case "${tag}" in
  latest|main|main-latest)
    echo "Refusing floating Satellite Hub image tag: ${tag}" >&2
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
