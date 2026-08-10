#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCH_FILE="${REPO_ROOT}/patches/linux-voice-assistant-followup-interrupt.patch"
TARGET_DIR="${1:-$HOME/linux-voice-assistant}"

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "Patch file not found: ${PATCH_FILE}" >&2
  exit 1
fi

if [[ ! -d "${TARGET_DIR}/.git" ]]; then
  echo "Target is not a git checkout: ${TARGET_DIR}" >&2
  echo "Usage: $0 /path/to/linux-voice-assistant" >&2
  exit 1
fi

if ! git -C "${TARGET_DIR}" apply --check "${PATCH_FILE}"; then
  echo "Patch does not apply cleanly in ${TARGET_DIR}" >&2
  echo "Review the checkout state with: git -C ${TARGET_DIR} status --short" >&2
  exit 1
fi

git -C "${TARGET_DIR}" apply "${PATCH_FILE}"

cat <<EOF
Applied ${PATCH_FILE} to ${TARGET_DIR}

Next steps:
  1. Review the change:
     git -C ${TARGET_DIR} diff
  2. Rebuild or restart the service on the endpoint.
  3. Restart the hub from this repo:
     uv run hub run
EOF
