---
type: process
title: Evaluation system initial acceptance testing (2026-08)
description: Initial acceptance record for the PSFN evaluation system — what was validated end-to-end against a real local model, what the results mean, and explicitly what they do not mean. Covers the bounded offline gate, the memory regression benchmark, companion-shape regression, the llama.cpp logprob (L2) probes, a from-zero repository-native install, and the J-lens (L1) consistency battery.
tags: [evals, acceptance-testing, jlens, logprob, llama.cpp, memory-evals, local-models, verification]
---

# Evaluation system initial acceptance testing

**Status: accepted for use as instrumentation. Not final calibration. Not
evidence for any theoretical claim.**

This document records the initial acceptance testing of the PSFN evaluation
system against the platform and real local models. Its purpose is to establish
that the evaluation machinery *works* — that its harnesses run, its
instruments produce coherent measurements, and its artifacts are reproducible
— so it can be trusted as an instrument for later scientific work. It is not a
calibration result, not a model-quality verdict, and not proof of any
hypothesis about model internals or emotional structure. Coherent results here
raise the ceiling of what the platform can measure; they do not lower the bar
for what counts as a finding.

## What was validated

### 1. Bounded offline gate (toolkit integrity)

`npm run verify:evals` — lint, eval typecheck, 14 test files / 95 TypeScript
tests, and 6 Python tests (1 skipped) — passed from a **fresh clone of
`origin/main`**, exercising the from-zero install path for the toolkit itself.

### 2. Memory regression benchmark

`npm run eval:memory` — all 10 fixture families pass, all 13 gates green
(precision@k / recall@k / MRR = 1, trust_leak_rate = 0, supersede/merge rates
at floor). The deterministic provider path works end-to-end.

### 3. Companion-shape regression gate

`npm run eval:regression` — 0 blocker findings, 12 informational warnings on
the fixture baseline. Diff-based regression detection behaves as specified.

### 4. Local model serving and L2 logprob probes (llama.cpp)

- llama.cpp **v0.3.0** (`c1d0e7a004015f23bc0233470b747b596f29b264`) built with
  CUDA 13.2 and installed as a pinned local tool.
- `Qwen3.8-27B-UD-Q4_K_M.gguf` (unsloth dynamic quant, 15.3 GiB, sha-matched
  against the source blob) served via the repo's canonical launch script and
  profile surface (`eval/local/`), full offload on a 24 GB GPU.
- The canonical probe `npm run eval:local:probe:logprobs` returned real
  per-token logprob distributions with top-k alternatives.
- An introspection-primed calibration sweep over the first 8 scenarios of
  `eval/scenarios/calibration.scenarios.json` (using the toolkit's own
  `normalizeCandidates` + `computeEntropy`) produced: **8/8 correct
  self-reported labels**, baseline neutral-control entropy 0.008, and visible
  confusable-pair pressure (fear/sadness H≈0.35, love/trust H≈0.67).

Known measurement note: llama.cpp echoes the sampled token inside
`top_logprobs` and emits BPE label-pieces; the toolkit's
`summarizeTokenEntropy` pins the primary token and double-counts that echo
(pinning entropy near ln 2). The acceptance sweep deduplicated candidates by
normalized token before computing entropy. This is recorded as toolkit
follow-up work if a local llama.cpp provider target is added.

### 5. From-zero repository-native install

Fresh clone of `origin/main` → `npm ci` → `npm run hooks:install` →
`npm run onboard` (repository-native mode, generic OpenAI-compatible provider
pointed at the local llama.cpp endpoint, companion imported from a Character
Card V3 PNG) → `npm run local:up`: gateway, agent, Garden, alert sink, and
Postgres all reached healthy, with the Garden login challenge passing.
`npm run local:verify` reached the real chat turn. Defects discovered on this
path are tracked separately in the issue tracker (onboarding database-target
mismatch, pre-created `psfn` database requirement, admin-ui dependency
bootstrap on `local:up`, and the intake two-model requirement not surfaced
during onboarding).

### 6. J-lens (L1) consistency battery

The Jacobian-lens instrument ([`tools/evals/eval/jlens/`](../tools/evals/eval/jlens/README.md))
was fitted on **Qwen3-8B** (HF format) with a **15-prompt partial lens**
(smoke-grade by design — this was an acceptance run, not a calibration fit)
and run against the same calibration scenario pack. On the same model and
prompt, three measurement layers were compared:

| Layer | Instrument | Agreement with L3 |
| --- | --- | --- |
| L1 | J-lens best-layer emotion readout | **8/8** |
| L2 | final-layer token distribution | 6/8 |
| L3 | generated self-report label | — |

Best-layer readouts concentrated at layers 23–34 of 35 at rank 1 — a
plausible verbalizable-workspace band, consistent with the reference paper's
layer structure. One scenario (ground truth *love*) read coherently as *trust*
across L1, L2, and L3 simultaneously — evidence that the three instruments
measure one coherent internal state, and exactly the kind of
confusable-pair pressure the scenario pack was designed to expose. It is
**not** a taxonomy finding about love and trust; separating those requires
the specificity batteries, not one acceptance run.

## Interpretation boundaries

- A 15-prompt lens is smoke-grade. Stable readouts need the reference
  implementation's guidance (~100 prompts usable, 1,000 saturating).
- 8 scenarios of 32; single model family; single quantization class.
- Agreement numbers demonstrate **instrument consistency**, not model quality
  and not ground-truth classification performance.
- No claim in this document depends on, or supports, statements about
  subjective experience. The playbook's non-goals apply in full.
- Defects found during acceptance are tracked as implementation issues; none
  block use of the system as instrumentation.

## Reproduction

Environment used: two-RTX-4090 (24 GB each) workstation, 503 GB RAM, CUDA
13.2, models served from a local HF cache. Exact commands:

```bash
# L2 path (llama.cpp, GGUF)
npm --prefix tools/evals run eval:local:llamacpp -- <profile>
npm --prefix tools/evals run eval:local:probe:logprobs -- <profile>

# L1 path (J-lens, HF format)
python3 -m venv .venv-jlens && .venv-jlens/bin/pip install -r tools/evals/eval/jlens/requirements.txt
.venv-jlens/bin/pip install -e <pinned anthropics/jacobian-lens checkout>
.venv-jlens/bin/python tools/evals/eval/jlens/fit_lens.py --model Qwen/Qwen3-8B \
  --n-prompts 30 --dim-batch 32 \
  --max-memory 9GiB --max-memory 9GiB \
  --checkpoint tools/evals/eval/jlens/artifacts/lens-ckpt.pt \
  --output tools/evals/eval/jlens/artifacts/lens.pt
.venv-jlens/bin/python tools/evals/eval/jlens/consistency_battery.py \
  --model Qwen/Qwen3-8B \
  --checkpoint tools/evals/eval/jlens/artifacts/lens-ckpt.pt \
  --n-scenarios 8 --max-memory 9GiB --max-memory 9GiB \
  --output tools/evals/eval/jlens/artifacts/consistency-battery.json
```

## Next steps

1. Finish a full-prompt-count lens fit and record the stability delta.
2. Attempt the fit on the 27B-class target (`unsloth/Qwen3.8-27B`,
   `model_type=qwen3_5`) after verifying `transformers>=5.5` arch support.
3. Wire the J-lens into the repeng reader as a first-class L1 backend and
   feed the calibration aggregator (`eval/calibration/`).
4. Run the playbook's B-series batteries (validity, detection,
   identification, specificity) once instruments are stable.
