#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

PROFILE_NAME_ARG="${1:-}"
PROMPT_TEXT="${2:-Generate one short sentence that sounds quietly hopeful.}"

load_profile "$PROFILE_NAME_ARG"
[[ "${BACKEND:-}" == "vllm" ]] || die "hidden-state probe requires a vLLM profile"
require_command python3

require_profile_field MODEL_ID
require_profile_field MODEL_CACHE
require_profile_field TENSOR_PARALLEL_SIZE
require_profile_field MAX_MODEL_LEN

MODEL_CACHE_ABS=$(resolve_repo_path "$MODEL_CACHE")
export MODEL_CACHE_ABS
mkdir -p "$MODEL_CACHE_ABS"

python3 - "$PROMPT_TEXT" <<'PY'
import importlib.util
import json
import os
import sys
import tempfile

prompt_text = sys.argv[1]

missing = [
    module_name
    for module_name in ("safetensors", "vllm")
    if importlib.util.find_spec(module_name) is None
]
if missing:
    raise SystemExit(
        "[eval/local] hidden-state probe blocked: missing Python dependencies: "
        + ", ".join(missing)
    )

from safetensors import safe_open
from vllm import LLM, SamplingParams

with tempfile.TemporaryDirectory() as tmpdirname:
    llm = LLM(
        model=os.environ["MODEL_ID"],
        tensor_parallel_size=int(os.environ["TENSOR_PARALLEL_SIZE"]),
        max_model_len=int(os.environ["MAX_MODEL_LEN"]),
        download_dir=os.environ["MODEL_CACHE_ABS"],
        trust_remote_code=os.environ.get("TRUST_REMOTE_CODE", "0") == "1",
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
        "prompt": output.prompt,
        "prompt_token_count": len(output.prompt_token_ids),
        "saved_token_count": int(token_ids.shape[0]),
        "hidden_state_shape": list(hidden_states.shape),
        "hidden_states_path": hidden_states_path,
    }, indent=2))
PY
