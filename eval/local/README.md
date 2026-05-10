# Local Dense Eval Targets

This directory is the repo-owned setup surface for local dense-model eval work. It keeps launch profiles, probe scripts, and verification notes under `eval/local/*` without touching runtime code.

## Why These Targets

The primary dense targets in this bead now match the evaluation plan directly:

- `Qwen/Qwen3.5-9B`
- `Qwen/Qwen3.5-27B`
- `google/gemma-4-31B-it`

`Qwen/Qwen3.5-*` gives a smaller and a larger dense baseline from the same family, while `gemma-4-31B-it` provides the cross-family dense comparator the downstream RepE work needs. The llama.cpp path stays first-class for cheap local logprob sweeps, but Gemma's GGUF path is documented as a local mirrored artifact rather than a public Hugging Face repo dependency.

## Layout

- `profiles/*.env`: launch profiles for each backend/model pair.
- `scripts/launch-vllm.sh`: canonical vLLM launch entrypoint for dense HF checkpoints.
- `scripts/launch-llamacpp.sh`: canonical llama.cpp launch entrypoint for GGUF checkpoints.
- `scripts/probe-logprobs.sh`: backend-aware logprob probe for local endpoints.
- `scripts/probe-hidden-states.sh`: hidden-state probe for dense local profiles. Profiles choose an explicit probe backend with `HIDDEN_STATE_PROBE_BACKEND`.
- `scripts/validate-profiles.sh`: syntax and profile validation for rerunnable assets.

## Quick Start

### 1. Validate the checked-in assets

```bash
npm run eval:local:validate
```

### 2. Launch a logprob path with llama.cpp

```bash
npm run eval:local:llamacpp -- qwen35-9b-q4km-llamacpp
```

In another terminal:

```bash
npm run eval:local:probe:logprobs -- qwen35-9b-q4km-llamacpp
```

### 3. Launch a dense HF checkpoint with vLLM

```bash
npm run eval:local:vllm -- qwen35-9b-vllm
```

For hidden-state extraction:

```bash
python3 -m venv .venv-eval-hidden
.venv-eval-hidden/bin/python -m pip install -r eval/local/requirements-hidden.txt
npm run eval:local:probe:hidden -- qwen35-9b-vllm
```

`qwen35-9b-vllm` delegates this probe to `qwen3-06b-vllm` through `HIDDEN_STATE_PROBE_FALLBACK_PROFILE`. The command prints both the requested and effective profiles so the Qwen3.5 compatibility boundary is visible in probe output.

## Target Matrix

The memory numbers below are operator guidance, not hard guarantees. They are inferred from parameter count, quantization width, and normal backend overhead. Keep at least 15-25% headroom above the estimate before adding large batch sizes or long-context runs.

| Target | Canonical backend | Official source | Native context | Default served context in this repo | Quant / dtype guidance | Approx accelerator memory |
| --- | --- | --- | --- | --- | --- | --- |
| `Qwen/Qwen3.5-9B` | vLLM for dense serving and hidden-state work; llama.cpp for cheap logprob sweeps | Dense HF + official GGUF | 32,768 native, 131,072 with YaRN | `32768` in vLLM, `16384` in llama.cpp | `bfloat16` in vLLM; `Q4_K_M` default in llama.cpp; move to `Q6_K` if score deltas are tight | vLLM `bf16`: ~18-24 GB. llama.cpp `Q4_K_M`: ~7-9 GB plus KV cache. |
| `Qwen/Qwen3.5-27B` | vLLM for the larger dense Qwen baseline; llama.cpp for lower-cost logprob sweeps | Dense HF + official GGUF | 32,768 native, 131,072 with YaRN | `32768` in vLLM, `16384` in llama.cpp | `bfloat16` in vLLM with tensor parallel; `Q4_K_M` default in llama.cpp | vLLM `bf16`: ~48-60 GB, so the profile assumes both 4090s. llama.cpp `Q4_K_M`: ~18-22 GB plus KV cache. |
| `google/gemma-4-31B-it` | vLLM for dense serving; llama.cpp only if a local mirrored GGUF is available | Dense HF; local mirrored GGUF for llama.cpp | 32,768 native | `16384` in vLLM and llama.cpp for conservative bring-up | `bfloat16` in vLLM; `Q4_K_M` if you mirror a GGUF locally | vLLM `bf16`: ~56-70 GB, so treat this as a multi-GPU or quantized path. llama.cpp `Q4_K_M`: ~20-24 GB plus KV cache. |

## Backend Guidance

### vLLM

Use vLLM whenever you need dense HF checkpoints or OpenAI-compatible serving. The checked-in launch profiles target `32k` context for the Qwen paths and `16k` for Gemma to keep the initial bring-up within realistic workstation limits.

Hidden-state extraction is profile-owned instead of inferred from the serving backend. Qwen3.5 dense profiles declare an explicit fallback because the pinned stable Transformers stack does not recognize `model_type=qwen3_5`, and the vLLM `extract_hidden_states` KV-transfer example is an internal/speculative path rather than a stable compatibility contract for these models. Keep `vllm-kv-transfer` only for profiles where that exact vLLM hidden-state path has been verified.

For Qwen3.5, keep `ENABLE_REASONING=0` in eval runs unless the scenario explicitly measures chain-of-thought behavior. Hidden-state comparisons and calibration sweeps are easier to interpret in non-thinking mode.

For larger targets such as `Qwen/Qwen3.5-27B` and `google/gemma-4-31B-it`, treat the checked-in profiles as launch templates. They assume either both 4090s or an operator-supplied quantized checkpoint. The repo keeps the launch contract here, but does not pretend the current workstation can verify those paths without the missing Python stack and model weights.

### llama.cpp

Use llama.cpp for logprob-only or completion-probability sweeps where GGUF startup speed and lower memory pressure matter more than hidden-state access. The checked-in profiles default to `Q4_K_M` because it is the best cost/perf balance for broad reruns, but `Q5_K_M` or `Q6_K` is the safer choice if eval score deltas are small enough that quantization noise could matter.

The scripts prefer `--hf-repo` for the official Qwen GGUF releases so the model source stays explicit and rerunnable. Gemma's llama.cpp profile is intentionally wired to `MODEL_FILE=...` because the repo cannot assume a public official GGUF route; mirror the chosen GGUF into `models/gguf/google/` and keep the binary out of git.

The launcher exports `HF_HOME` and `HF_HUB_CACHE` under `models/gguf/hf-home` so llama.cpp validation does not depend on whatever shared Hugging Face cache happens to exist on the workstation.

## Verification Notes

The checked-in assets are meant to be rerunnable and fail loud when the workstation is missing the local-model stack. On this machine today:

- `llama-server` is installed and the llama.cpp launch/probe path is runnable once weights are present.
- `python3` is installed.
- The Python hidden-state stack is repo-owned in `eval/local/requirements-hidden.txt`. If it is not installed, `npm run eval:local:probe:hidden -- qwen35-9b-vllm` stops with the pinned install command instead of a hidden failure.
- `npm run eval:local:validate` is the minimum repo-owned gate for these profiles before live model checks.

Use the probe scripts only after the relevant backend and weights are actually available locally.

If the live probes fail because weights are missing, treat that as an environment blocker, not a repo-asset failure. The checked-in scripts are still the canonical setup path.

## Sources

- Qwen3.5-9B dense card: <https://huggingface.co/Qwen/Qwen3.5-9B>
- Qwen3.5-9B GGUF card: <https://huggingface.co/Qwen/Qwen3.5-9B-GGUF>
- Qwen3.5-27B dense card: <https://huggingface.co/Qwen/Qwen3.5-27B>
- Qwen3.5-27B GGUF card: <https://huggingface.co/Qwen/Qwen3.5-27B-GGUF>
- Gemma 4 31B IT dense card: <https://huggingface.co/google/gemma-4-31B-it>
- vLLM OpenAI-compatible server docs: <https://docs.vllm.ai/en/stable/serving/openai_compatible_server/>
- vLLM pooling models docs: <https://docs.vllm.ai/en/stable/models/pooling_models/>
- vLLM hidden-state example: <https://github.com/vllm-project/vllm/blob/main/examples/offline_inference/extract_hidden_states.py>
- llama.cpp server README: <https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md>
