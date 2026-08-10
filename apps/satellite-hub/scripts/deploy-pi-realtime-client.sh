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
MIC_SENSITIVITY_PERCENT="${MIC_SENSITIVITY_PERCENT:-}"
MIC_GAIN="${MIC_GAIN:-}"
MIC_CAPTURE_SAMPLE_RATE="${MIC_CAPTURE_SAMPLE_RATE:-}"
MIC_CAPTURE_BLOCK_SIZE="${MIC_CAPTURE_BLOCK_SIZE:-}"
MIC_INPUT_CHANNELS="${MIC_INPUT_CHANNELS:-}"
MIC_CHANNEL_STRATEGY="${MIC_CHANNEL_STRATEGY:-}"
PLAYBACK_VOLUME="${PLAYBACK_VOLUME:-}"
VOICE_START_THRESHOLD="${VOICE_START_THRESHOLD:-}"
VOICE_AMBIENT_START_RATIO="${VOICE_AMBIENT_START_RATIO:-}"
VOICE_FAST_START_RATIO="${VOICE_FAST_START_RATIO:-}"
VOICE_CONTINUE_THRESHOLD="${VOICE_CONTINUE_THRESHOLD:-}"
VOICE_INTERRUPT_RATIO="${VOICE_INTERRUPT_RATIO:-}"
VOICE_START_CHUNKS="${VOICE_START_CHUNKS:-}"
VOICE_MIN_SPEECH_CHUNKS="${VOICE_MIN_SPEECH_CHUNKS:-}"
VOICE_SPEECH_RELEASE_SECONDS="${VOICE_SPEECH_RELEASE_SECONDS:-}"
VOICE_INITIAL_SILENCE_TIMEOUT_SECONDS="${VOICE_INITIAL_SILENCE_TIMEOUT_SECONDS:-}"
VOICE_END_SILENCE_TIMEOUT_SECONDS="${VOICE_END_SILENCE_TIMEOUT_SECONDS:-}"
VOICE_MAX_TURN_SECONDS="${VOICE_MAX_TURN_SECONDS:-}"
VOICE_PREROLL_CHUNKS="${VOICE_PREROLL_CHUNKS:-}"
VOICE_PREROLL_LEAD_CHUNKS="${VOICE_PREROLL_LEAD_CHUNKS:-}"
MIC_BLOCK_SIZE="${MIC_BLOCK_SIZE:-}"
RECONNECT_DELAY_SECONDS="${RECONNECT_DELAY_SECONDS:-}"
LOG_LEVEL="${LOG_LEVEL:-}"
VOICE_IDLE_LOG_INTERVAL_SECONDS="${VOICE_IDLE_LOG_INTERVAL_SECONDS:-}"
VOICE_CANDIDATE_LOG_RATIO="${VOICE_CANDIDATE_LOG_RATIO:-}"

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

ENV_FILE="${TMP_DIR}/psfn-realtime-client.env"
cat > "${ENV_FILE}" <<EOF
HUB_WS_URL=${HUB_WS_URL}
DEVICE_ID=${DEVICE_ID}
DEVICE_NAME=${DEVICE_NAME}
CONVERSATION_ID=${CONVERSATION_ID}
MIC_SENSITIVITY_PERCENT=${MIC_SENSITIVITY_PERCENT}
MIC_GAIN=${MIC_GAIN}
MIC_CAPTURE_SAMPLE_RATE=${MIC_CAPTURE_SAMPLE_RATE}
MIC_CAPTURE_BLOCK_SIZE=${MIC_CAPTURE_BLOCK_SIZE}
MIC_INPUT_CHANNELS=${MIC_INPUT_CHANNELS}
MIC_CHANNEL_STRATEGY=${MIC_CHANNEL_STRATEGY}
PLAYBACK_VOLUME=${PLAYBACK_VOLUME}
VOICE_START_THRESHOLD=${VOICE_START_THRESHOLD}
VOICE_AMBIENT_START_RATIO=${VOICE_AMBIENT_START_RATIO}
VOICE_FAST_START_RATIO=${VOICE_FAST_START_RATIO}
VOICE_CONTINUE_THRESHOLD=${VOICE_CONTINUE_THRESHOLD}
VOICE_INTERRUPT_RATIO=${VOICE_INTERRUPT_RATIO}
VOICE_START_CHUNKS=${VOICE_START_CHUNKS}
VOICE_MIN_SPEECH_CHUNKS=${VOICE_MIN_SPEECH_CHUNKS}
VOICE_SPEECH_RELEASE_SECONDS=${VOICE_SPEECH_RELEASE_SECONDS}
VOICE_INITIAL_SILENCE_TIMEOUT_SECONDS=${VOICE_INITIAL_SILENCE_TIMEOUT_SECONDS}
VOICE_END_SILENCE_TIMEOUT_SECONDS=${VOICE_END_SILENCE_TIMEOUT_SECONDS}
VOICE_MAX_TURN_SECONDS=${VOICE_MAX_TURN_SECONDS}
VOICE_PREROLL_CHUNKS=${VOICE_PREROLL_CHUNKS}
VOICE_PREROLL_LEAD_CHUNKS=${VOICE_PREROLL_LEAD_CHUNKS}
MIC_BLOCK_SIZE=${MIC_BLOCK_SIZE}
RECONNECT_DELAY_SECONDS=${RECONNECT_DELAY_SECONDS}
LOG_LEVEL=${LOG_LEVEL}
VOICE_IDLE_LOG_INTERVAL_SECONDS=${VOICE_IDLE_LOG_INTERVAL_SECONDS}
VOICE_CANDIDATE_LOG_RATIO=${VOICE_CANDIDATE_LOG_RATIO}
EOF

expect_ssh() {
  local remote_cmd="$1"
  local remote_b64
  remote_b64="$(printf '%s' "${remote_cmd}" | base64 | tr -d '\n')"
  EXPECT_PASSWORD="${PI_PASSWORD}" \
  EXPECT_PI_USER="${PI_USER}" \
  EXPECT_PI_HOST="${PI_HOST}" \
  EXPECT_REMOTE_B64="${remote_b64}" \
  expect <<'EOF'
set timeout 240
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
set timeout 240
set password $env(EXPECT_PASSWORD)
set raw_args $env(EXPECT_SCP_ARGS)
set args [lrange [split $raw_args "\u001f"] 0 end-1]
eval spawn [list scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null] $args

expect {
    -re ".*assword:" { send "${password}\r"; exp_continue }
    eof
}
EOF
}

REMOTE_DIR="/home/${PI_USER}/psfn-realtime-client"

expect_ssh "mkdir -p ${REMOTE_DIR}"
expect_scp \
  "${ROOT_DIR}/client/pi_realtime/client.py" \
  "${ROOT_DIR}/client/pi_realtime/client.env.example" \
  "${ROOT_DIR}/client/pi_realtime/pi-realtime-client.service" \
  "${ENV_FILE}" \
  "${PI_USER}@${PI_HOST}:${REMOTE_DIR}/"

REMOTE_SCRIPT="$(cat <<EOF
set -e
/home/${PI_USER}/linux-voice-assistant/.venv/bin/pip install websockets
printf '%s\n' '${PI_PASSWORD}' | sudo -S install -m 0644 ${REMOTE_DIR}/pi-realtime-client.service /etc/systemd/system/psfn-realtime-client.service
printf '%s\n' '${PI_PASSWORD}' | sudo -S install -m 0644 ${REMOTE_DIR}/psfn-realtime-client.env /etc/psfn-realtime-client.env
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl daemon-reload
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl disable --now linux-voice-assistant.service || true
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl enable psfn-realtime-client.service
printf '%s\n' '${PI_PASSWORD}' | sudo -S systemctl restart psfn-realtime-client.service
systemctl is-enabled linux-voice-assistant.service || true
systemctl is-active linux-voice-assistant.service || true
systemctl is-enabled psfn-realtime-client.service
systemctl is-active psfn-realtime-client.service
EOF
)"

expect_ssh "${REMOTE_SCRIPT}"
