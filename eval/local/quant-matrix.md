# Quant Matrix

This matrix is the operator-facing VRAM guide for the checked-in local dense eval targets. The values are planning estimates for a 4090-class workstation and should be treated as headroom targets, not exact guarantees.

| Target | Backend | Q4 / default path | Q5 | Q6 | 64k context note |
| --- | --- | --- | --- | --- | --- |
| `Qwen/Qwen3-8B` | llama.cpp | ~6-8 GB weights + KV cache | ~7-9 GB + KV cache | ~8-10 GB + KV cache | Comfortable on a single 4090 if KV pressure stays bounded. |
| `Qwen/Qwen3-8B` | vLLM | n/a | n/a | `bf16` ~18-24 GB | Fits on one 4090 with conservative batch size. |
| `Qwen/Qwen3-14B` | llama.cpp | ~10-14 GB weights + KV cache | ~12-16 GB + KV cache | ~14-18 GB + KV cache | Single-card possible for narrow runs; dual-card safer once KV grows. |
| `Qwen/Qwen3-14B` | vLLM | n/a | n/a | `bf16` ~32-40 GB | Dual 4090 tensor-parallel profile is the intended path. |
| `Qwen/Qwen2.5-14B-Instruct` | llama.cpp | ~10-14 GB weights + KV cache | ~12-16 GB + KV cache | ~14-18 GB + KV cache | Native GGUF context is smaller than dense HF; extend carefully. |
| `Qwen/Qwen2.5-14B-Instruct` | vLLM | n/a | n/a | `bf16` ~32-40 GB | Dual-card tensor-parallel profile is the intended dense path. |

Guidance:
- Default to `Q4_K_M` for broad logprob sweeps.
- Move to `Q5_K_M` or `Q6_K` when calibration deltas are small enough that quantization noise could matter.
- Keep 15-25% accelerator headroom before increasing batch size or experimenting with extended context.
