#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-${ROOT_DIR}/.artifacts/ts-hub}"
PID_FILE="${PID_FILE:-${LOG_DIR}/ts-hub.pid}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/ts-hub.log}"

mkdir -p "${LOG_DIR}"

if [[ -f "${PID_FILE}" ]]; then
  existing_pid="$(cat "${PID_FILE}")"
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" >/dev/null 2>&1; then
    echo "TS hub already running: pid=${existing_pid} log=${LOG_FILE}"
    exit 0
  fi
fi

(
  cd "${ROOT_DIR}"
  # Run the hub under a detached shell so it keeps running after this script exits.
  setsid bash -lc "cd \"${ROOT_DIR}\" && exec npm run hub:ts" >"${LOG_FILE}" 2>&1 </dev/null &
  echo $! > "${PID_FILE}"
)

echo "Started TS hub: pid=$(cat "${PID_FILE}") log=${LOG_FILE}"
