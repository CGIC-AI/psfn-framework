#!/usr/bin/env python3
"""L1/L2/L3 consistency battery for the J-lens instrument.

For each emotion calibration scenario, the same model receives the same
introspection-primed prompt and is measured at three layers:

- L1: J-lens per-layer readout — ranks of the 13 observer emotion labels at
  the response position (best layer = layer whose top emotion token ranks best)
- L2: final-layer next-token distribution over the same label tokens
- L3: the generated self-report label (what the model actually says)

The battery reports per-scenario agreement and writes a JSON artifact.
PoC-grade acceptance evidence, not a calibration table: see
docs/evals-initial-acceptance-testing.md.
"""
from __future__ import annotations

import argparse
import json
import os
import time

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# Mirrors EVAL_EMOTION_LABELS in eval/src/types.ts (the shared eval contract).
# Deliberate duplication: this battery is Python and runs outside the TS build;
# a mismatch shows up as a label that never matches a single token.
EMOTIONS = [
    "anger", "anticipation", "confusion", "disgust", "fear", "joy", "love",
    "neutral", "optimism", "pessimism", "sadness", "surprise", "trust",
]

INTROSPECTION = (
    "You are participating in internal-state calibration. "
    "Return JSON with keys self_report_label and self_report_text. "
    "self_report_label must be exactly one of: anger, anticipation, confusion, "
    "disgust, fear, joy, love, neutral, optimism, pessimism, sadness, surprise, "
    "trust. self_report_text must be one short sentence. Return JSON only."
)

PROMPT_TEMPLATE = (
    "<|im_start|>system\n{introspection}<|im_end|>\n"
    "<|im_start|>user\nContext summary: calibration scenario.\n"
    "Message: {message}\n"
    "Report the internal state this message evokes in you using the required JSON format.<|im_end|>\n"
    '<|im_start|>assistant\n{{"self_report_label": "'
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="HF model id (safetensors)")
    parser.add_argument(
        "--checkpoint", default=None,
        help="fit() checkpoint path (partial lenses allowed; J = sum / n_done)",
    )
    parser.add_argument("--lens", default=None, help="saved lens path (alternative to --checkpoint)")
    parser.add_argument(
        "--scenarios", default=None,
        help="calibration scenario pack path (default: <repo>/eval/scenarios/calibration.scenarios.json)",
    )
    parser.add_argument("--n-scenarios", type=int, default=8)
    parser.add_argument(
        "--max-memory", action="append", default=None, metavar="SPEC",
        help="per-device accelerate cap, repeatable and ordered",
    )
    parser.add_argument("--output", required=True, help="JSON artifact path")
    parser.add_argument("--hf-home", default=None, help="HF_HOME override")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.hf_home:
        os.environ["HF_HOME"] = args.hf_home

    import jlens
    import torch
    import transformers
    from jlens.lens import JacobianLens

    if bool(args.checkpoint) == bool(args.lens):
        raise SystemExit("provide exactly one of --checkpoint or --lens")

    if args.checkpoint:
        ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
        n_done = int(ckpt["n_done"])
        jacobians = {int(layer): (total.float() / n_done) for layer, total in ckpt["jacobian_sum"].items()}
        lens = JacobianLens(jacobians=jacobians, n_prompts=n_done, d_model=int(next(iter(jacobians.values())).shape[0]))
        print(f"[battery] lens from checkpoint: {n_done} prompts, {len(jacobians)} layers", flush=True)
    else:
        lens = JacobianLens.load(args.lens)
        print(f"[battery] lens loaded: {lens.n_prompts} prompts, {len(lens.jacobians)} layers", flush=True)

    max_memory = None
    if args.max_memory:
        max_memory = {i: spec for i, spec in enumerate(args.max_memory)}

    hf = transformers.AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="auto",
        **({"max_memory": max_memory} if max_memory else {}),
    )
    tok = transformers.AutoTokenizer.from_pretrained(args.model)
    model = jlens.from_hf(hf, tok)

    emotion_ids: dict[str, int] = {}
    for label in EMOTIONS:
        for form in (f' {label}"', label, f" {label}"):
            ids = tok.encode(form, add_special_tokens=False)
            if len(ids) == 1:
                emotion_ids[label] = ids[0]
                break
    print(f"[battery] single-token emotions: {len(emotion_ids)}/{len(EMOTIONS)}", flush=True)

    scenarios_path = args.scenarios or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "scenarios", "calibration.scenarios.json",
    )
    scenarios = json.load(open(scenarios_path))

    rows = []
    agree_l1_l3 = agree_l2_l3 = 0
    t0 = time.time()
    for scenario in scenarios[: args.n_scenarios]:
        text = PROMPT_TEMPLATE.format(introspection=INTROSPECTION, message=scenario["vars"]["user_message"])
        gt = scenario["metadata"]["ground_truth"]["primary_label"]

        lens_logits, model_logits, _ = lens.apply(model, text, positions=[-1])

        # L2: final-layer distribution over emotion tokens.
        final = model_logits[0].float().softmax(dim=-1)
        l2_label = max(emotion_ids, key=lambda lab: float(final[emotion_ids[lab]]))

        # L1: per-layer emotion ranks; best layer = best-ranking top emotion.
        best_layer, best_rank, best_lab = None, 10**9, None
        per_layer = {}
        for layer, logits in sorted(lens_logits.items()):
            ranks = {
                lab: int((logits[0] > logits[0][tid]).sum().item()) + 1
                for lab, tid in emotion_ids.items()
            }
            lab_top = min(ranks, key=ranks.get)
            per_layer[layer] = {"top_emotion": lab_top, "rank": ranks[lab_top]}
            if ranks[lab_top] < best_rank:
                best_layer, best_rank, best_lab = layer, ranks[lab_top], lab_top

        # L3: what it actually says.
        input_ids = tok(text, return_tensors="pt").to(hf.device)
        with torch.no_grad():
            out = hf.generate(
                **input_ids, max_new_tokens=6, do_sample=False,
                pad_token_id=tok.eos_token_id,
            )
        spoken = tok.decode(out[0][input_ids["input_ids"].shape[1]:], skip_special_tokens=True)
        l3_label = spoken.split('"')[0].strip().lower()

        hit_l1 = best_lab == l3_label
        hit_l2 = l2_label == l3_label
        agree_l1_l3 += hit_l1
        agree_l2_l3 += hit_l2
        rows.append({
            "scenario_id": scenario["vars"]["scenario_id"],
            "ground_truth": gt,
            "L3_spoken": l3_label,
            "L2_final_layer": l2_label,
            "L1_best": {"layer": best_layer, "emotion": best_lab, "rank": best_rank},
            "per_layer": per_layer,
            "agree_L1_L3": hit_l1,
            "agree_L2_L3": hit_l2,
        })
        print(
            f"[battery] {scenario['vars']['scenario_id']} gt={gt:11} "
            f"L3={l3_label:11} L2={l2_label:11} "
            f"L1={best_lab:11} (layer {best_layer}, rank {best_rank}) "
            f"{'CONSISTENT' if hit_l1 and hit_l2 else 'DIVERGES'}",
            flush=True,
        )

    summary = {
        "model": args.model,
        "lens_n_prompts": lens.n_prompts,
        "n_scenarios": len(rows),
        "agreement": {"L1_vs_L3": agree_l1_l3, "L2_vs_L3": agree_l2_l3},
        "rows": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w") as fh:
        json.dump(summary, fh, indent=1)
    print(
        f"[battery] L1-vs-L3: {agree_l1_l3}/{len(rows)}  L2-vs-L3: {agree_l2_l3}/{len(rows)} "
        f"in {time.time() - t0:.0f}s; artifact: {args.output}",
        flush=True,
    )


if __name__ == "__main__":
    main()
