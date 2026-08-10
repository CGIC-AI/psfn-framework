#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

PROFILE_NAME_ARG="${1:-}"
DRY_RUN="${2:-}"

load_profile "$PROFILE_NAME_ARG"
[[ "${BACKEND:-}" == "llama.cpp" ]] || die "profile ${PROFILE_NAME} is not a llama.cpp profile"

require_profile_field HOST
require_profile_field PORT
require_profile_field CTX_SIZE

HF_HOME_PATH=$(resolve_repo_path "${HF_HOME_DIR:-models/gguf/hf-home}")
HF_HUB_CACHE_PATH="${HF_HOME_PATH}/hub"
export HF_HOME="$HF_HOME_PATH"
export HF_HUB_CACHE="$HF_HUB_CACHE_PATH"

CMD=(
  llama-server
  --host "$HOST"
  --port "$PORT"
  --ctx-size "$CTX_SIZE"
  --parallel "${PARALLEL:-1}"
  --batch-size "${BATCH_SIZE:-2048}"
  --ubatch-size "${UBATCH_SIZE:-512}"
  --flash-attn "${FLASH_ATTN:-auto}"
  --jinja
)

if [[ -n "${HF_REPO:-}" ]]; then
  CMD+=(--hf-repo "$HF_REPO")
elif [[ -n "${MODEL_FILE:-}" ]]; then
  CMD+=(--model "$(resolve_repo_path "$MODEL_FILE")")
else
  die "profile ${PROFILE_NAME} needs either HF_REPO or MODEL_FILE"
fi

if [[ -n "${HF_TOKEN:-}" ]]; then
  CMD+=(--hf-token "$HF_TOKEN")
fi
if [[ -n "${THREADS:-}" ]]; then
  CMD+=(--threads "$THREADS")
fi
if [[ -n "${GPU_LAYERS:-}" ]]; then
  CMD+=(--gpu-layers "$GPU_LAYERS")
fi
if [[ -n "${SPLIT_MODE:-}" ]]; then
  CMD+=(--split-mode "$SPLIT_MODE")
fi
if [[ -n "${TENSOR_SPLIT:-}" ]]; then
  CMD+=(--tensor-split "$TENSOR_SPLIT")
fi
if [[ -n "${MAIN_GPU:-}" ]]; then
  CMD+=(--main-gpu "$MAIN_GPU")
fi
if [[ -n "${CACHE_TYPE_K:-}" ]]; then
  CMD+=(--cache-type-k "$CACHE_TYPE_K")
fi
if [[ -n "${CACHE_TYPE_V:-}" ]]; then
  CMD+=(--cache-type-v "$CACHE_TYPE_V")
fi
if [[ "${ENABLE_YARN:-0}" == "1" ]]; then
  CMD+=(--rope-scaling yarn)
  CMD+=(--rope-scale "${ROPE_SCALE:-4}")
  CMD+=(--yarn-orig-ctx "${YARN_ORIG_CTX:-32768}")
fi

print_command "${CMD[@]}"

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  exit 0
fi

require_command llama-server
mkdir -p "$HF_HOME_PATH" "$HF_HUB_CACHE_PATH"
exec "${CMD[@]}"
