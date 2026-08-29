#!/usr/bin/env python3
"""Fit a Jacobian lens (J-lens) on an HF-format causal LM.

L1 instrument for the emotion measurement cascade: computes the averaged
input-output Jacobians J_l = E[d h_final / d h_l] over a generic text corpus
(WikiText-103) using the pinned reference implementation
(anthropics/jacobian-lens @ 581d3986, Apache-2.0).

The fit is checkpointed per prompt and resumable; interrupting at any point
leaves a partial lens usable by consistency_battery.py via --checkpoint.
See eval/jlens/README.md for configuration and memory guidance.
"""
from __future__ import annotations

import argparse
import os
import time

# Match the reference implementation's allocator guidance; avoids
# fragmentation-driven OOM during the backward sweep.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="HF model id (safetensors)")
    parser.add_argument(
        "--n-prompts", type=int, default=30,
        help="WikiText prompts to average over (smoke-grade <30; ~100 usable; 1000 saturating)",
    )
    parser.add_argument(
        "--dim-batch", type=int, default=32,
        help="cotangent channels per backward pass; the memory knob (32 is stable for 8B on 2x24GB)",
    )
    parser.add_argument(
        "--max-memory", action="append", default=None, metavar="SPEC",
        help="per-device accelerate cap, repeatable and ordered, e.g. --max-memory 9GiB --max-memory 9GiB; "
        "cap each device below half the model footprint so layers actually shard",
    )
    parser.add_argument("--checkpoint", required=True, help="resumable fit checkpoint path")
    parser.add_argument("--output", required=True, help="where to save the finished lens")
    parser.add_argument("--hf-home", default=None, help="HF_HOME override (shared cache location)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.hf_home:
        os.environ["HF_HOME"] = args.hf_home

    import jlens
    import torch
    import transformers
    from jlens.examples import load_wikitext_prompts

    max_memory = None
    if args.max_memory:
        max_memory = {i: spec for i, spec in enumerate(args.max_memory)}

    print(f"[fit] loading {args.model} (bf16, sharded)", flush=True)
    hf = transformers.AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="auto",
        **({"max_memory": max_memory} if max_memory else {}),
    )
    tok = transformers.AutoTokenizer.from_pretrained(args.model)
    model = jlens.from_hf(hf, tok)

    prompts = load_wikitext_prompts(args.n_prompts)
    print(f"[fit] {len(prompts)} wikitext prompts, dim_batch={args.dim_batch}", flush=True)
    t0 = time.time()
    lens = jlens.fit(
        model,
        prompts,
        dim_batch=args.dim_batch,
        checkpoint_path=args.checkpoint,
    )
    lens.save(args.output)
    print(f"[fit] done in {time.time() - t0:.0f}s; lens saved to {args.output}", flush=True)


if __name__ == "__main__":
    main()
