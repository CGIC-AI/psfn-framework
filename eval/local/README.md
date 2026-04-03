# Local Dense Eval Targets

This directory is the repo-owned setup surface for local dense-model eval work. It keeps launch profiles, probe scripts, and verification notes under `eval/local/*` without touching runtime code.

## Why These Targets

The primary dense targets in this bead are Qwen checkpoints with both public dense weights and official GGUF releases:

- `Qwen/Qwen3-8B`
- `Qwen/Qwen3-14B`
- `Qwen/Qwen2.5-14B-Instruct`

That choice keeps the checked-in setup rerunnable without gated model access or third-party quant repos. If the operator wants a Meta or Gemma baseline later, add it as a follow-up profile instead of widening this bead.

## Layout

- `profiles/*.env`: launch profiles for each backend/model pair.
- `scripts/launch-vllm.sh`: canonical vLLM launch entrypoint for dense HF checkpoints.
- `scripts/launch-llamacpp.sh`: canonical llama.cpp launch entrypoint for GGUF checkpoints.
- `scripts/probe-logprobs.sh`: backend-aware logprob probe for local endpoints.
- `scripts/probe-hidden-states.sh`: vLLM hidden-state probe based on the official `extract_hidden_states` example.
- `scripts/validate-profiles.sh`: syntax and profile validation for rerunnable assets.

## Quick Start

### 1. Validate the checked-in assets

```bash
npm run eval:local:validate
```

### 2. Launch a logprob path with llama.cpp

```bash
npm run eval:local:llamacpp -- qwen3-8b-q4km-llamacpp
```

In another terminal:

```bash
npm run eval:local:probe:logprobs -- qwen3-8b-q4km-llamacpp
```

### 3. Launch a dense HF checkpoint with vLLM

```bash
npm run eval:local:vllm -- qwen3-8b-vllm
```

For hidden-state extraction:

```bash
npm run eval:local:probe:hidden -- qwen3-8b-vllm
```

## Target Matrix

The memory numbers below are operator guidance, not hard guarantees. They are inferred from parameter count, quantization width, and normal backend overhead. Keep at least 15-25% headroom above the estimate before adding large batch sizes or long-context runs.

| Target | Canonical backend | Official source | Native context | Default served context in this repo | Quant / dtype guidance | Approx accelerator memory |
| --- | --- | --- | --- | --- | --- | --- |
| `Qwen/Qwen3-8B` | vLLM for dense serving and hidden-state work | Dense HF + official GGUF | 32,768 native, 131,072 with YaRN | `32768` in vLLM, `16384` in llama.cpp | `bfloat16` in vLLM; `Q4_K_M` for fast logprob sweeps; `Q6_K` if you need tighter score stability | vLLM `bf16`: ~18-24 GB. llama.cpp `Q4_K_M`: ~6-8 GB plus KV cache. |
| `Qwen/Qwen3-14B` | vLLM for stronger dense baseline | Dense HF + official GGUF | 32,768 native, 131,072 with YaRN | `32768` in vLLM, `16384` in llama.cpp | `bfloat16` or AWQ/FP8 if you already have quantized weights; `Q4_K_M` for llama.cpp | vLLM `bf16`: ~32-40 GB, so the profile shards across both 4090s. llama.cpp `Q4_K_M`: ~10-14 GB plus KV cache. |
| `Qwen/Qwen2.5-14B-Instruct` | vLLM for long-context dense eval, llama.cpp for cheap logprobs | Dense HF + official GGUF | 131,072 in dense HF, 32,768 in official GGUF | `32768` in vLLM, `16384` in llama.cpp | `bfloat16` in vLLM; `Q4_K_M` default in llama.cpp; move to `Q5_K_M` if calibration drift shows up | vLLM `bf16`: ~32-40 GB. llama.cpp `Q4_K_M`: ~10-14 GB plus KV cache. |

## Backend Guidance

### vLLM

Use vLLM whenever you need dense HF checkpoints, OpenAI-compatible serving, or hidden-state extraction. The checked-in launch profiles target `32k` context by default because that is the stable native context for Qwen3 and a lower-friction operating point for Qwen2.5 before YaRN is layered in.

For Qwen3, keep `ENABLE_REASONING=0` in eval runs unless the scenario explicitly measures chain-of-thought behavior. Hidden-state comparisons and calibration sweeps are easier to interpret in non-thinking mode.

When you truly need `128k+` context:

- Qwen3: add YaRN settings explicitly and accept the shorter-context tradeoff from static scaling.
- Qwen2.5 dense HF: use the `rope_scaling` block documented by Qwen and keep that change local to the validation environment, not committed into runtime config.

### llama.cpp

Use llama.cpp for logprob-only or completion-probability sweeps where GGUF startup speed and lower memory pressure matter more than hidden-state access. The checked-in profiles default to `Q4_K_M` because it is the best cost/perf balance for broad reruns, but `Q5_K_M` or `Q6_K` is the safer choice if eval score deltas are small enough that quantization noise could matter.

The scripts prefer `--hf-repo` for Qwen GGUF releases so the model source stays explicit and rerunnable. If you already mirrored a merged file locally, set `MODEL_FILE=...` instead of `HF_REPO`.

The launcher exports `HF_HOME` and `HF_HUB_CACHE` under `models/gguf/hf-home` so llama.cpp validation does not depend on whatever shared Hugging Face cache happens to exist on the workstation.

## Verification Notes

The checked-in assets are meant to be rerunnable and fail loud when the workstation is missing the local-model stack. On this machine today:

- `llama-server` is installed and the llama.cpp launch/probe path is runnable once weights are present.
- `vllm` and `safetensors` are not installed, so hidden-state extraction is currently an environment blocker rather than a repo-asset blocker.
- `npm run eval:local:validate` is the minimum repo-owned gate for these profiles before live model checks.

Use the probe scripts only after the relevant backend and weights are actually available locally.

If the live probes fail because weights are missing, treat that as an environment blocker, not a repo-asset failure. The checked-in scripts are still the canonical setup path.

## Sources

- Qwen3-8B dense card: <https://huggingface.co/Qwen/Qwen3-8B>
- Qwen3-8B GGUF card: <https://huggingface.co/Qwen/Qwen3-8B-GGUF>
- Qwen3-14B dense card: <https://huggingface.co/Qwen/Qwen3-14B>
- Qwen3-14B GGUF card: <https://huggingface.co/Qwen/Qwen3-14B-GGUF>
- Qwen2.5-14B-Instruct dense card: <https://huggingface.co/Qwen/Qwen2.5-14B-Instruct>
- Qwen2.5-14B-Instruct GGUF card: <https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF>
- vLLM OpenAI-compatible server docs: <https://docs.vllm.ai/en/stable/serving/openai_compatible_server/>
- vLLM pooling models docs: <https://docs.vllm.ai/en/stable/models/pooling_models/>
- vLLM hidden-state example: <https://github.com/vllm-project/vllm/blob/main/examples/offline_inference/extract_hidden_states.py>
- llama.cpp server README: <https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md>
