#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_HOST="${PI_HOST:-${1:-}}"
PI_PASSWORD="${PI_PASSWORD:-${2:-}}"
PI_USER="${PI_USER:-${3:-}}"
HUB_WS_URL="${HUB_WS_URL:-}"
DEVICE_ID="${DEVICE_ID:-}"
DEVICE_NAME="${DEVICE_NAME:-}"
CONVERSATION_ID="${CONVERSATION_ID:-}"
PI_CLIENT_CONTROL_BIND_HOST="${PI_CLIENT_CONTROL_BIND_HOST:-}"
PI_CLIENT_CONTROL_PORT="${PI_CLIENT_CONTROL_PORT:-}"
AUDIO_DEVICE_CARD="${AUDIO_DEVICE_CARD:-}"
AUDIO_INPUT_DEVICE="${AUDIO_INPUT_DEVICE:-}"
AUDIO_OUTPUT_DEVICE="${AUDIO_OUTPUT_DEVICE:-}"
AUDIO_INPUT_COMMAND="${AUDIO_INPUT_COMMAND:-}"
AUDIO_OUTPUT_COMMAND="${AUDIO_OUTPUT_COMMAND:-}"
ALSA_DUCK_CARD="${ALSA_DUCK_CARD:-}"
ALSA_DUCK_CONTROL="${ALSA_DUCK_CONTROL:-}"
ALSA_DUCK_PERCENT="${ALSA_DUCK_PERCENT:-}"
MIC_GAIN="${MIC_GAIN:-}"
VOICE_START_THRESHOLD="${VOICE_START_THRESHOLD:-}"
VOICE_CONTINUE_THRESHOLD="${VOICE_CONTINUE_THRESHOLD:-}"
VOICE_AMBIENT_START_RATIO="${VOICE_AMBIENT_START_RATIO:-}"
VOICE_INTERRUPT_RATIO="${VOICE_INTERRUPT_RATIO:-}"
VOICE_START_CHUNKS="${VOICE_START_CHUNKS:-}"
VOICE_SPEECH_RELEASE_MS="${VOICE_SPEECH_RELEASE_MS:-}"
VOICE_INITIAL_SILENCE_MS="${VOICE_INITIAL_SILENCE_MS:-}"
VOICE_END_SILENCE_MS="${VOICE_END_SILENCE_MS:-}"
VOICE_MAX_TURN_MS="${VOICE_MAX_TURN_MS:-}"
VOICE_PREROLL_CHUNKS="${VOICE_PREROLL_CHUNKS:-}"
VOICE_PREROLL_LEAD_CHUNKS="${VOICE_PREROLL_LEAD_CHUNKS:-}"

if [[ -z "${PI_HOST}" || -z "${PI_PASSWORD}" || -z "${PI_USER}" ]]; then
  echo "usage: PI_USER=<user> PI_PASSWORD=<password> $0 <pi-host> [pi-password] [pi-user]" >&2
  exit 1
fi

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    echo "missing required environment variable: ${name}" >&2
    exit 1
  fi
}

require_value HUB_WS_URL "${HUB_WS_URL}"
require_value DEVICE_ID "${DEVICE_ID}"
require_value DEVICE_NAME "${DEVICE_NAME}"

if ! command -v expect >/dev/null 2>&1; then
  echo "expect is required" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ENV_FILE="${TMP_DIR}/psfn-ts-client.env"
cat > "${ENV_FILE}" <<EOF
HUB_WS_URL=${HUB_WS_URL}
DEVICE_ID=${DEVICE_ID}
DEVICE_NAME=${DEVICE_NAME}
CONVERSATION_ID=${CONVERSATION_ID}
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}
DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-}
PULSE_SERVER=${PULSE_SERVER:-}
PULSE_COOKIE=${PULSE_COOKIE:-}
AUDIO_DEVICE_CARD=${AUDIO_DEVICE_CARD}
AUDIO_INPUT_DEVICE=${AUDIO_INPUT_DEVICE}
AUDIO_OUTPUT_DEVICE=${AUDIO_OUTPUT_DEVICE}
AUDIO_INPUT_COMMAND=${AUDIO_INPUT_COMMAND}
AUDIO_OUTPUT_COMMAND=${AUDIO_OUTPUT_COMMAND}
ALSA_DUCK_CARD=${ALSA_DUCK_CARD}
ALSA_DUCK_CONTROL=${ALSA_DUCK_CONTROL}
ALSA_DUCK_PERCENT=${ALSA_DUCK_PERCENT}
MIC_GAIN=${MIC_GAIN}
VOICE_START_THRESHOLD=${VOICE_START_THRESHOLD}
VOICE_CONTINUE_THRESHOLD=${VOICE_CONTINUE_THRESHOLD}
VOICE_AMBIENT_START_RATIO=${VOICE_AMBIENT_START_RATIO}
VOICE_INTERRUPT_RATIO=${VOICE_INTERRUPT_RATIO}
VOICE_START_CHUNKS=${VOICE_START_CHUNKS}
VOICE_SPEECH_RELEASE_MS=${VOICE_SPEECH_RELEASE_MS}
VOICE_INITIAL_SILENCE_MS=${VOICE_INITIAL_SILENCE_MS}
VOICE_END_SILENCE_MS=${VOICE_END_SILENCE_MS}
VOICE_MAX_TURN_MS=${VOICE_MAX_TURN_MS}
VOICE_PREROLL_CHUNKS=${VOICE_PREROLL_CHUNKS}
VOICE_PREROLL_LEAD_CHUNKS=${VOICE_PREROLL_LEAD_CHUNKS}
EOF

if [[ -n "${PI_CLIENT_CONTROL_BIND_HOST}" || -n "${PI_CLIENT_CONTROL_PORT}" ]]; then
  require_value PI_CLIENT_CONTROL_BIND_HOST "${PI_CLIENT_CONTROL_BIND_HOST}"
  require_value PI_CLIENT_CONTROL_PORT "${PI_CLIENT_CONTROL_PORT}"
  cat >> "${ENV_FILE}" <<EOF
PI_CLIENT_CONTROL_BIND_HOST=${PI_CLIENT_CONTROL_BIND_HOST}
PI_CLIENT_CONTROL_PORT=${PI_CLIENT_CONTROL_PORT}
EOF
fi

if [[ -n "${AMICA_BRIDGE_URL}" || -n "${AMICA_BRIDGE_TOKEN}" || -n "${AMICA_BRIDGE_OWNER_MODE}" || -n "${AMICA_BRIDGE_TIMEOUT_MS}" ]]; then
  require_value AMICA_BRIDGE_URL "${AMICA_BRIDGE_URL}"
  require_value AMICA_BRIDGE_TOKEN "${AMICA_BRIDGE_TOKEN}"
  cat >> "${ENV_FILE}" <<EOF
AMICA_BRIDGE_URL=${AMICA_BRIDGE_URL}
AMICA_BRIDGE_TOKEN=${AMICA_BRIDGE_TOKEN}
AMICA_BRIDGE_OWNER_MODE=${AMICA_BRIDGE_OWNER_MODE}
AMICA_BRIDGE_TIMEOUT_MS=${AMICA_BRIDGE_TIMEOUT_MS}
EOF
fi

expect_ssh() {
  local remote_cmd="$1"
  local remote_b64
  remote_b64="$(printf '%s' "${remote_cmd}" | base64 | tr -d '\n')"
  EXPECT_PASSWORD="${PI_PASSWORD}" \
  EXPECT_PI_USER="${PI_USER}" \
  EXPECT_PI_HOST="${PI_HOST}" \
  EXPECT_REMOTE_B64="${remote_b64}" \
  expect <<'EOF'
set timeout 600
set password $env(EXPECT_PASSWORD)
set user $env(EXPECT_PI_USER)
set host $env(EXPECT_PI_HOST)
set remote_b64 $env(EXPECT_REMOTE_B64)
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${user}@${host} "printf %s ${remote_b64} | base64 -d | bash"
expect {
    -re ".*assword:" { send "${password}\r"; exp_continue }
    eof
}
EOF
}

expect_scp() {
  local joined=""
  local arg
  for arg in "$@"; do
    joined+="${arg}"$'\x1f'
  done
  EXPECT_PASSWORD="${PI_PASSWORD}" \
  EXPECT_SCP_ARGS="${joined}" \
  expect <<'EOF'
set timeout 600
set password $env(EXPECT_PASSWORD)
set raw_args $env(EXPECT_SCP_ARGS)
set args [lrange [split $raw_args "\u001f"] 0 end-1]
eval spawn [list scp -r -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null] $args
expect {
    -re ".*assword:" { send "${password}\r"; exp_continue }
    eof
}
EOF
}

REMOTE_DIR="/home/${PI_USER}/psfn-ts-client"

expect_ssh "mkdir -p ${REMOTE_DIR}/src ${REMOTE_DIR}/client/ts_realtime"
expect_scp \
  "${ROOT_DIR}/package.json" \
  "${ROOT_DIR}/package-lock.json" \
  "${ROOT_DIR}/tsconfig.json" \
  "${ROOT_DIR}/client/ts_realtime/pi-ts-client.service" \
  "${ENV_FILE}" \
  "${PI_USER}@${PI_HOST}:${REMOTE_DIR}/"
expect_scp \
  "${ROOT_DIR}/src/ts" \
  "${PI_USER}@${PI_HOST}:${REMOTE_DIR}/src/"

REMOTE_SCRIPT="$(cat <<EOF
set -e
cd ${REMOTE_DIR}
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '${PI_PASSWORD}' | sudo -S apt-get update
  printf '%s\n' '${PI_PASSWORD}' | sudo -S apt-get install -y nodejs npm ffmpeg alsa-utils
fi
npm install
printf '%s\n' '${PI_PASSWORD}' | sudo -S install -m 0644 ${REMOTE_DIR}/pi-ts-client.service /etc/systemd/system/psfn-ts-client.service
printf '%s\n' '${PI_PASSWORD}' | sudo -S sed -i 's/%i/${PI_USER}/g' /etc/systemd/system/psfn-ts-client.service
printf '%s\n' '${PI_PASSWORD}' | sudo -S install -m 0644 ${REMOTE_DIR}/psfn-ts-client.env /etc/psfn-ts-client.env
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl daemon-reload
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl disable --now linux-voice-assistant.service || true
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl enable psfn-ts-client.service
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl restart psfn-ts-client.service
systemctl is-active psfn-ts-client.service
EOF
)"

expect_ssh "${REMOTE_SCRIPT}"
