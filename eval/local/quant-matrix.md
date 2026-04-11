# Quant Matrix

This matrix is the operator-facing VRAM guide for the checked-in local dense eval targets. The values are planning estimates for a 4090-class workstation and should be treated as headroom targets, not exact guarantees.

| Target | Backend | Q4 / default path | Q5 | Q6 | 64k context note |
| --- | --- | --- | --- | --- | --- |
| `Qwen/Qwen3.5-9B` | llama.cpp | ~7-9 GB weights + KV cache | ~8-10 GB + KV cache | ~9-11 GB + KV cache | Comfortable on a single 4090 if KV pressure stays bounded. |
| `Qwen/Qwen3.5-9B` | vLLM | n/a | n/a | `bf16` ~18-24 GB | The intended hidden-state verification target once the Python stack exists. |
| `Qwen/Qwen3.5-27B` | llama.cpp | ~18-22 GB weights + KV cache | ~21-25 GB + KV cache | ~24-28 GB + KV cache | Dual 4090 recommended once context or batch size grows. |
| `Qwen/Qwen3.5-27B` | vLLM | n/a | n/a | `bf16` ~48-60 GB | Treat as a dual-card or quantized serving path. |
| `google/gemma-4-31B-it` | llama.cpp | ~20-24 GB weights + KV cache | ~24-28 GB + KV cache | ~28-32 GB + KV cache | Requires a locally mirrored GGUF file; single-card runs are tight. |
| `google/gemma-4-31B-it` | vLLM | n/a | n/a | `bf16` ~56-70 GB | Multi-GPU or quantized path; not currently verifiable on this machine. |

Guidance:
- Default to `Q4_K_M` for broad logprob sweeps.
- Move to `Q5_K_M` or `Q6_K` when calibration deltas are small enough that quantization noise could matter.
- Keep 15-25% accelerator headroom before increasing batch size or experimenting with extended context.
