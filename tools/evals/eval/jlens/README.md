# J-lens L1 instrument (Jacobian lens)

This directory holds the L1 activation instrument for the emotion measurement
cascade described in
[`docs/EMOTION_MEASUREMENT_EVAL_HARNESS_PLAYBOOK.md`](../../docs/EMOTION_MEASUREMENT_EVAL_HARNESS_PLAYBOOK.md):
the **Jacobian lens** (J-lens) and the **J-space** consistency battery.

The J-lens linearly transports a residual-stream activation at any layer into
the final-layer basis using the averaged input–output Jacobian
`J_l = E[∂h_final/∂h_l]`, then decodes it with the model's own unembedding:

```
lens_l(h) = unembed(J_l @ h)
```

It is a principled refinement of the plain logit lens already used by the
repeng reader: the Jacobian correction accounts for representational drift
across layers, so verbalizable concepts are readable at mid layers where the
plain logit lens produces uninterpretable readouts.

The consistency battery measures the same prompt on the same model at three
layers and checks agreement:

- **L1** — J-lens best-layer readout (per-layer ranks of the 13 observer
  emotion labels at the response position)
- **L2** — final-layer next-token distribution over the same label tokens
- **L3** — the generated self-report label (what the model actually says)

## Requirements

- Python 3.12 with `pip` (a dedicated venv is recommended)
- A CUDA GPU large enough for the model plus backward-pass memory; two ~24 GB
  cards comfortably fit an 8B bf16 model at `dim_batch=32`
- From PyPI: `torch`, `transformers>=5.5`, `accelerate`, `numpy`,
  `datasets` (see `requirements.txt`)
- The reference implementation
  [`anthropics/jacobian-lens`](https://github.com/anthropics/jacobian-lens)
  (Apache-2.0), pinned at commit `581d398613e5602a5af361e1c34d3a92ea82ba8e`.
  The [`vgel/jacobian-lens`](https://github.com/vgel/jacobian-lens) fork is an
  identical-content mirror at that commit and is tracked as a watchpoint for
  community improvements — do not install both; the Anthropic repository is
  canonical.

HF-format model weights (safetensors) are required. GGUF checkpoints cannot be
used: the fit needs a forward **and** backward pass, which llama.cpp serving
does not expose. This instrument therefore complements the llama.cpp logprob
(L2) probes in `eval/local/` rather than replacing them.

## Setup

```bash
python3 -m venv .venv-jlens
.venv-jlens/bin/pip install -r eval/jlens/requirements.txt

# jlens reference implementation, pinned
git clone https://github.com/anthropics/jacobian-lens /tmp/jacobian-lens
git -C /tmp/jacobian-lens checkout 581d398613e5602a5af361e1c34d3a92ea82ba8e
.venv-jlens/bin/pip install -e /tmp/jacobian-lens
```

## Usage

Fit a lens (checkpointed and resumable; `Ctrl-C` at any point leaves a usable
partial lens in the checkpoint):

```bash
.venv-jlens/bin/python eval/jlens/fit_lens.py \
  --model Qwen/Qwen3-8B \
  --n-prompts 30 --dim-batch 32 \
  --checkpoint eval/jlens/artifacts/lens-ckpt.pt \
  --output eval/jlens/artifacts/lens.pt
```

Run the consistency battery over the emotion calibration scenario pack:

```bash
.venv-jlens/bin/python eval/jlens/consistency_battery.py \
  --model Qwen/Qwen3-8B \
  --checkpoint eval/jlens/artifacts/lens-ckpt.pt \
  --scenarios eval/scenarios/calibration.scenarios.json \
  --n-scenarios 8 \
  --output eval/jlens/artifacts/consistency-battery.json
```

Generated artifacts under `eval/jlens/artifacts/` are gitignored.

## Configuration guidance

- **Fit corpus size** (`--n-prompts`): the reference README reports quality
  saturates quickly; ~100 prompts are usable and the paper's lenses use 1,000
  WikiText-103 sequences. A 15-prompt partial lens already produced a coherent
  PoC readout; treat < 30 prompts as smoke-grade only.
- **`--dim-batch`**: cotangent channels per backward pass. This is the memory
  knob. Measured on an 8B bf16 model sharded over two ~24 GB cards
  (`--max-memory 9GiB --max-memory 9GiB`):
  - `128` — out of memory (~14 GB backward activation memory on one card)
  - `64` — out of memory in this configuration
  - `32` — stable (~13.5 GB peak per card), ~2.2 min/prompt
- **Sharding**: pass `--max-memory` per visible device. A single 20+ GiB cap
  lets accelerate place the whole model on one card and the backward pass then
  exhausts that card while the other idles — cap each device below half the
  model footprint so layers actually split.
- **`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`** is recommended; both
  scripts set it by default.
- **`--hf-home`**: point at a shared HF cache if the model is already on disk
  (e.g. `--hf-home /mnt/hf-cache/huggingface`).

## What the battery proved in the initial acceptance run

See
[`docs/evals-initial-acceptance-testing.md`](../../../docs/evals-initial-acceptance-testing.md)
for the full acceptance record. Headline: on Qwen3-8B with a 15-prompt partial
lens, L1-vs-L3 agreement was 8/8 scenarios and L2-vs-L3 6/8, with best-layer
readouts concentrating at layers 23–34 of 35 — a plausible workspace band.
One scenario (love ground truth) produced a coherent *trust* readout across
all three layers simultaneously — consistency evidence, not a taxonomy claim.

## Acknowledgments

- **Gurnee, Sofroniew, Pearce, Piotrowski, Kauvar, Chen, Soligo, Bogdan,
  Ong, Wang, Thompson, Abrahams, Kantamneni, Ameisen, Batson, Lindsey (2026),
  "Verbalizable Representations Form a Global Workspace in Language Models"**,
  Transformer Circuits Thread,
  <https://transformer-circuits.pub/2026/workspace/index.html> — the J-lens
  and J-space methodology.
- **Anthropic PBC** for the Apache-2.0 reference implementation
  [`anthropics/jacobian-lens`](https://github.com/anthropics/jacobian-lens).
- **vgel** for the
  [`jacobian-lens`](https://github.com/vgel/jacobian-lens) fork mirror.
- **Qwen team** for the open-weight Qwen3 models used as fit targets.

## Non-goals

Per the playbook: no phenomenal-experience claims, no production steering of
any live persona, and no claim that a PoC-grade lens is a calibration table.
The J-lens instrument exists to feed the L1 column of the calibration
aggregator (`eval/calibration/`) once fits are stable.
