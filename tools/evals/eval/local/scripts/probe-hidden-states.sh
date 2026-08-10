#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

PROFILE_NAME_ARG="${1:-}"
PROMPT_TEXT="${2:-Generate one short sentence that sounds quietly hopeful.}"
REQUESTED_PROFILE_NAME="$PROFILE_NAME_ARG"
LOCAL_VENV_PYTHON="${REPO_ROOT}/.venv-eval-hidden/bin/python"
PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" && -x "$LOCAL_VENV_PYTHON" ]]; then
  PYTHON_BIN="$LOCAL_VENV_PYTHON"
fi
PYTHON_BIN="${PYTHON_BIN:-python3}"

load_profile "$PROFILE_NAME_ARG"
if [[ -n "${HIDDEN_STATE_PROBE_FALLBACK_PROFILE:-}" ]]; then
  FALLBACK_PROFILE="$HIDDEN_STATE_PROBE_FALLBACK_PROFILE"
  FALLBACK_REASON="${HIDDEN_STATE_PROBE_FALLBACK_REASON:-profile ${PROFILE_NAME} delegates hidden-state probing to ${FALLBACK_PROFILE}}"
  printf '[eval/local] hidden-state probe fallback: requested=%s effective=%s reason=%s\n' \
    "$PROFILE_NAME" "$FALLBACK_PROFILE" "$FALLBACK_REASON" >&2
  load_profile "$FALLBACK_PROFILE"
  export HIDDEN_STATE_REQUESTED_PROFILE="$REQUESTED_PROFILE_NAME"
  export HIDDEN_STATE_EFFECTIVE_PROFILE="$PROFILE_NAME"
  export HIDDEN_STATE_FALLBACK_REASON="$FALLBACK_REASON"
else
  export HIDDEN_STATE_REQUESTED_PROFILE="$PROFILE_NAME"
  export HIDDEN_STATE_EFFECTIVE_PROFILE="$PROFILE_NAME"
  export HIDDEN_STATE_FALLBACK_REASON=""
fi
[[ "${BACKEND:-}" == "vllm" ]] || die "hidden-state probe requires a vLLM profile"
require_command "$PYTHON_BIN"

require_profile_field MODEL_ID
require_profile_field MODEL_CACHE
require_profile_field TENSOR_PARALLEL_SIZE
require_profile_field MAX_MODEL_LEN

HIDDEN_STATE_PROBE_BACKEND="${HIDDEN_STATE_PROBE_BACKEND:-vllm-kv-transfer}"
case "$HIDDEN_STATE_PROBE_BACKEND" in
  transformers-forward|vllm-kv-transfer) ;;
  *)
    die "profile ${PROFILE_NAME} uses unsupported HIDDEN_STATE_PROBE_BACKEND=${HIDDEN_STATE_PROBE_BACKEND}"
    ;;
esac

prepare_hf_cache "$MODEL_CACHE"
MODEL_CACHE_ABS="$PREPARED_HF_MODEL_CACHE"
export MODEL_CACHE_ABS
mkdir -p "$MODEL_CACHE_ABS"
export HIDDEN_STATE_PROBE_BACKEND

"$PYTHON_BIN" - "$PROMPT_TEXT" <<'PY'
import importlib.util
import json
import os
import sys
import tempfile

prompt_text = sys.argv[1]
probe_backend = os.environ["HIDDEN_STATE_PROBE_BACKEND"]

def require_modules(module_names):
    missing = [
        module_name
        for module_name in module_names
        if importlib.util.find_spec(module_name) is None
    ]
    if missing:
        raise SystemExit(
            "[eval/local] hidden-state probe blocked for "
            + probe_backend
            + ": missing Python dependencies: "
            + ", ".join(missing)
            + ". Install the pinned stack with: python3 -m pip install -r eval/local/requirements-hidden.txt"
        )


def trust_remote_code_enabled():
    return os.environ.get("TRUST_REMOTE_CODE", "0") == "1"


def run_transformers_forward_probe():
    require_modules(("accelerate", "torch", "transformers"))

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dtype_by_name = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
        "half": torch.float16,
    }
    dtype_name = os.environ.get("DTYPE", "bfloat16")
    torch_dtype = dtype_by_name.get(dtype_name)
    if torch_dtype is None:
        raise SystemExit(f"[eval/local] hidden-state probe blocked: unsupported DTYPE={dtype_name}")

    tokenizer = AutoTokenizer.from_pretrained(
        os.environ["MODEL_ID"],
        cache_dir=os.environ["MODEL_CACHE_ABS"],
        trust_remote_code=trust_remote_code_enabled(),
    )
    model = AutoModelForCausalLM.from_pretrained(
        os.environ["MODEL_ID"],
        cache_dir=os.environ["MODEL_CACHE_ABS"],
        dtype=torch_dtype,
        device_map="auto",
        trust_remote_code=trust_remote_code_enabled(),
        low_cpu_mem_usage=True,
    )
    model.eval()

    inputs = tokenizer(prompt_text, return_tensors="pt")
    inputs = {name: value.to(model.device) for name, value in inputs.items()}

    with torch.inference_mode():
        outputs = model(**inputs, output_hidden_states=True, use_cache=False)

    hidden_states = outputs.hidden_states
    if not hidden_states:
        raise SystemExit("[eval/local] hidden-state probe failed: Transformers returned no hidden states")

    last_hidden_state = hidden_states[-1]
    print(json.dumps({
        "model": os.environ["MODEL_ID"],
        "requested_profile": os.environ["HIDDEN_STATE_REQUESTED_PROFILE"],
        "effective_profile": os.environ["HIDDEN_STATE_EFFECTIVE_PROFILE"],
        "fallback_reason": os.environ["HIDDEN_STATE_FALLBACK_REASON"],
        "probe_backend": probe_backend,
        "prompt": prompt_text,
        "prompt_token_count": int(inputs["input_ids"].shape[-1]),
        "hidden_layer_count": len(hidden_states),
        "hidden_state_shape": list(last_hidden_state.shape),
        "device": str(model.device),
        "dtype": str(last_hidden_state.dtype),
    }, indent=2))


def run_vllm_kv_transfer_probe():
    require_modules(("safetensors", "vllm"))

    from safetensors import safe_open
    from vllm import LLM, SamplingParams

    with tempfile.TemporaryDirectory() as tmpdirname:
        llm = LLM(
            model=os.environ["MODEL_ID"],
            tensor_parallel_size=int(os.environ["TENSOR_PARALLEL_SIZE"]),
            max_model_len=int(os.environ["MAX_MODEL_LEN"]),
            download_dir=os.environ["MODEL_CACHE_ABS"],
            trust_remote_code=trust_remote_code_enabled(),
            speculative_config={
                "method": "extract_hidden_states",
                "num_speculative_tokens": 1,
                "draft_model_config": {
                    "hf_config": {
                        "eagle_aux_hidden_state_layer_ids": [1, 2, 3, 4],
                    }
                },
            },
            kv_transfer_config={
                "kv_connector": "ExampleHiddenStatesConnector",
                "kv_role": "kv_producer",
                "kv_connector_extra_config": {
                    "shared_storage_path": tmpdirname,
                },
            },
        )

        outputs = llm.generate([prompt_text], SamplingParams(max_tokens=1))
        output = outputs[0]
        hidden_states_path = output.kv_transfer_params.get("hidden_states_path")
        if hidden_states_path is None:
            raise SystemExit("[eval/local] hidden-state probe failed: vLLM returned no hidden state artifact")

        with safe_open(hidden_states_path, framework="pt") as handle:
            token_ids = handle.get_tensor("token_ids")
            hidden_states = handle.get_tensor("hidden_states")

        print(json.dumps({
            "model": os.environ["MODEL_ID"],
            "requested_profile": os.environ["HIDDEN_STATE_REQUESTED_PROFILE"],
            "effective_profile": os.environ["HIDDEN_STATE_EFFECTIVE_PROFILE"],
            "fallback_reason": os.environ["HIDDEN_STATE_FALLBACK_REASON"],
            "probe_backend": probe_backend,
            "prompt": output.prompt,
            "prompt_token_count": len(output.prompt_token_ids),
            "saved_token_count": int(token_ids.shape[0]),
            "hidden_state_shape": list(hidden_states.shape),
            "hidden_states_path": hidden_states_path,
        }, indent=2))


if probe_backend == "transformers-forward":
    run_transformers_forward_probe()
elif probe_backend == "vllm-kv-transfer":
    run_vllm_kv_transfer_probe()
else:
    raise SystemExit(f"[eval/local] hidden-state probe blocked: unsupported backend {probe_backend}")
PY
