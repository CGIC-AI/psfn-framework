#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

PROFILE_NAME_ARG="${1:-}"
DRY_RUN="${2:-}"

load_profile "$PROFILE_NAME_ARG"
[[ "${BACKEND:-}" == "vllm" ]] || die "profile ${PROFILE_NAME} is not a vLLM profile"

require_profile_field MODEL_ID
require_profile_field HOST
require_profile_field PORT
require_profile_field MODEL_CACHE
require_profile_field MAX_MODEL_LEN

MODEL_CACHE_ABS=$(resolve_repo_path "$MODEL_CACHE")

CMD=(
  vllm
  serve
  "$MODEL_ID"
  --host "$HOST"
  --port "$PORT"
  --download-dir "$MODEL_CACHE_ABS"
  --max-model-len "$MAX_MODEL_LEN"
)

if [[ -n "${DTYPE:-}" ]]; then
  CMD+=(--dtype "$DTYPE")
fi
if [[ -n "${GPU_MEMORY_UTILIZATION:-}" ]]; then
  CMD+=(--gpu-memory-utilization "$GPU_MEMORY_UTILIZATION")
fi
if [[ -n "${MAX_NUM_SEQS:-}" ]]; then
  CMD+=(--max-num-seqs "$MAX_NUM_SEQS")
fi
if [[ -n "${TENSOR_PARALLEL_SIZE:-}" ]]; then
  CMD+=(--tensor-parallel-size "$TENSOR_PARALLEL_SIZE")
fi
if [[ "${TRUST_REMOTE_CODE:-0}" == "1" ]]; then
  CMD+=(--trust-remote-code)
fi
if [[ "${ENABLE_REASONING:-0}" == "1" ]]; then
  CMD+=(--enable-reasoning --reasoning-parser "${REASONING_PARSER:-deepseek_r1}")
fi

print_command "${CMD[@]}"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  exit 0
fi

require_command vllm
mkdir -p "$MODEL_CACHE_ABS"
exec "${CMD[@]}"
