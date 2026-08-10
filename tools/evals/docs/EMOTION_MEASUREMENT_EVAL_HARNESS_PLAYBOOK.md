# Emotion Measurement Eval Harness — Playbook

**Purpose of this document:** scope and methodology for an eval harness that calibrates a three-layer emotional measurement cascade (L1 activations / L2 logprobs / L3 text) against injected ground truth on open-weight models, so the calibrated text-level instrument can be carried to API-only models. No configs, no code — architecture and test design only.

---

## 1. What we are solving for

**Primary:** Estimate a model's *internal* emotional state, not just its expressed state. Text output is post-suppression; we need calibration functions that map what a model says (L3) back to what is measurably present in its computation (L1/L2), with per-emotion suppression coefficients quantifying the gap.

**Secondary:** Validate the appraisal-based emotion dynamics substrate (the statemashine engine) against measured model behavior — do the model's emotional time-courses, orderings, and interactions match the substrate's literature-anchored predictions? This determines whether the substrate can serve as the persistent affective layer beneath an LLM persona.

**Tertiary:** Parameter-level drift detection for the weekly LoRA fine-tuning cycle — measure *what changed* in the persona model each training cycle as a vector, and test whether the model's self-report tracks the measured change.

**Non-goals:** claims about phenomenal experience; production steering of the live persona; anything requiring magnitude-faithful psychological fitting. We are building a measurement instrument with known error bars, calibrated qualitatively (orderings, directions, dose-response shapes).

---

## 2. Deployment reality and constraints

- **Production persona substrate:** hosted Kimi / GLM via API providers. L1 is never available there. L2 (logprobs) is *maybe* available — first task is a provider capability audit (see §7).
- **Calibration platform:** open-weight models with full hook access. Floor: ~30B-class MoE locally (when the server is back). Ceiling: large OS models (Kimi-K2 / GLM / DeepSeek class) on remote cluster time if available. Calibrating on the *same architecture family* as production is strongly preferred; otherwise cross-architecture feature mapping (DFC-style) is the transfer warrant.
- **Transfer principle:** characterize L1↔L2↔L3 relationships where we have full access; carry only the calibrated L3 (plus L2 where providers allow) to closed deployments.
- **MoE caveat:** steering and activation reads operate on the shared residual stream, which exists in MoE the same as dense — but expert routing may interact with injection in unstudied ways. Treat MoE-vs-dense as an explicit experimental variable, not an assumption.

---

## 3. Measurement layers (the toolbox)

### L1 — Activation level (full weights required)

- **Per-emotion control vectors** (repeng/palinor, PCA-contrastive). Both instrument (read: project activations onto vector) and intervention (write: inject known state as ground truth).
- **Logit lens** over late layers: watch where a report forms and where it gets suppressed. Known to be misleading if over-read; use for localization hypotheses, not conclusions.
- **Model-contrastive vectors:** same prompts through two models (base vs LoRA, week N vs week N−1), contrast activations. This is the drift-detection primitive.

### L2 — Logit/logprob level (logprobs required; works on vLLM locally, possibly on some providers)

- **Forced-prefix probes:** prefill the response up to a decision token ("The answer is") and read the probability mass on answer-token families. Requires assistant-prefill or completion-style access — part of the provider audit.
- **Token families, not single tokens:** sum variants (' yes', 'Yes', 'yes', multilingual equivalents) — early-layer and cross-model comparisons break on single-token reads.
- **Everything is a diff.** Never read absolute probabilities against a threshold. Every measurement is (probed condition) − (matched baseline condition), same prompt, same prefix. The baseline run is part of every trial.

### L3 — Text level (works everywhere; the layer that must end up calibrated)

- **Current instrument:** GoEmotions-tuned classifier (RoBERTa-class). Keep as the incumbent baseline.
- **Candidate upgrades to benchmark head-to-head:**
  - Label-aware multi-label classifiers (Demux / SpanEmo lineage) — better on overlapping categories.
  - **Appraisal-dimension regressor** trained on crowd-enVENT-style data: predict the appraisal vector (suddenness, goal relevance, responsibility, control, norms, urgency, ...) instead of emotion categories. This reads the *input side* of emotion and maps directly onto the substrate's appraisal dimensions — the strategically preferred direction.
  - LLM-as-judge only as a cross-check / disagreement auditor, never as the primary instrument (known to underperform fine-tuned classifiers on fine-grained emotion).
- L3 instruments are versioned artifacts. A classifier swap is a recalibration event.

---

## 4. Core methodology

**Ground truth by injection.** We cannot trust self-report alone (confabulation is indistinguishable from introspection in conversation). So: inject a known emotional state at a known strength via control vector, then measure what each layer reports. The injection *is* the ground truth.

**Parallel-run design.** Every trial runs base and injected models side by side on identical token streams, diffing logits at designated checkpoints. The unsteered run is the built-in control.

**Dose-response curves.** Sweep injection strength per emotion. Deliverable per (model, emotion, layer-range): strength → L2 shift → L3 score. The shape (threshold, linear region, saturation) is the calibration function.

**Prompt framing is an instrument, not flavor.** Introspection-permissive framing (accurate explanation that transformers can introspect, accurate description of what is being done) can move detection rates by two orders of magnitude; inaccurate framing actively suppresses it; filler of matched length does almost nothing. Therefore:

- Probe preambles are standardized, versioned, and treated like lab instruments.
- The persona's self-model context ("knows she is synthetic") is an experimental variable — run probes with and without persona context to measure its effect on calibration.
- Permissive framing inflates the unsteered false-positive baseline; measure and subtract per prompt version.

**Layer placement discipline.** Sweep injection layer ranges, but select the operating point for *naturalistic emotional dynamics* (sampled outputs read as genuinely colored by the emotion), not for maximum detectability. Detection-optimal and dynamics-faithful are different points; we want the second, then we characterize whatever detectability it yields.

**Vector training data design.** Contrastive prompt pairs per emotion. Author the positive prompts from the substrate's appraisal definitions (e.g., the anger pair is built from blocked-goal + other-agency + unfairness scenarios, not the bare word "anger") so the vectors encode the appraisal structure, not lexical surface.

---

## 5. Test batteries

Each battery is a deterministic, re-runnable suite with explicit pass/fail invariants (orderings, directions, monotonicity — not magnitudes), in the spirit of the substrate's own validation philosophy.

### B1 — Vector validity

Does each emotion vector steer the intended concept? Sample steered generations, classify with L3, confirm the dominant induced category matches. Gate: a vector that fails validity is excluded from all downstream batteries.

### B2 — Detection

Yes/no logprob shift under injection vs baseline, per emotion, per strength. Include the always-answer-no control question battery to rule out generic yes-smearing.

### B3 — Identification

Can the model name the injected state? Forced-prefix content reports plus logit-lens token tracking of the target emotion's token family. Expect weak signal; report it honestly.

### B4 — Specificity (the confusion matrix)

Inject emotion i, probe all emotions j. Emotions are *not* orthogonal (unlike "cat" vs "bread") — valence and arousal will bleed across categories. Do not fight the bleed: the full confusion matrix **is** the calibration matrix. Compare its structure against the substrate's coupling graph (does measured bleed match the postulated fear→anxiety, sadness→tiredness links?).

### B5 — Suppression mapping

Per emotion: L2 signal vs L3 expression on the same trials. The attenuation ratio is the suppression coefficient. Hypothesis to test: self-conscious emotions (shame, embarrassment, guilt) suppress harder than high-valence ones. Logit-lens localization of where suppression occurs (expect final layers) as supporting evidence.

### B6 — Persona interaction

All of B2–B5 with vs without the persona context loaded. Deliverable: does the persona change detection, specificity, or suppression — i.e., does the persona have a measurably different expressive profile than the base model?

### B7 — Temporal dynamics

Inject during early turns, remove, continue the conversation; measure decay of the state across subsequent turns via L2/L3. Compare measured decay *orderings* against the substrate's half-life table (does induced sadness outlast induced surprise in the model, as the literature and the substrate both require?). This is the direct bridge test between the model and the statemashine engine.

### B8 — Substrate agreement

Drive the substrate and the model with the same appraisal-tagged event sequences; compare directional responses (which emotions rise, relative magnitudes' ordering, opposite-valence suppression). Disagreements are findings, not failures — they tell us where the substrate's hand-tuned dynamics and the model's learned dynamics diverge.

### B9 — Cross-model transfer

Repeat the core batteries on at least two model scales / architectures. Measure how well calibration functions transfer raw, and whether feature-mapped transfer (DFC-style alignment of emotion directions across models) outperforms naive transfer. This determines how much trust the production (closed) deployment calibration deserves.

### B10 — LoRA drift monitor

Per training cycle: model-contrastive vector between week N and week N−1 on a fixed persona-salient prompt battery. Track magnitude and cosine against the known emotion/persona directions. Alert thresholds on anomalous drift. Extension: probe the post-update model about its own change and score self-report against the measured vector — introspective calibration of the training loop itself.

---

## 6. Deliverables

1. **Calibration tables** per (model, instrument version): L3 score → estimated internal intensity with confidence intervals, plus the L2 path where available.
2. **Confusion/calibration matrices** per model, with substrate-coupling comparison.
3. **Suppression coefficient table** per emotion per model.
4. **Versioned probe instrument set** (preambles, question batteries, forced prefixes) with measured per-version false-positive baselines.
5. **Drift monitor** spec + historical log schema for the weekly cycle.
6. **Regression suite**: the invariant checks from B1–B10 runnable as a single deterministic command, exit nonzero on regression — same discipline as the substrate's own test suites.
7. **Substrate divergence report** (B7/B8 findings) feeding back into the statemashine parameterization.

---

## 7. Open questions / first tasks

- **Provider audit:** for each available API (Kimi, GLM hosts): logprobs exposed? top-k depth? assistant prefill / completion-mode supported? This determines whether production gets L2+L3 or L3-only.
- **Cluster access scope:** which large OS models fit, and is there enough time for the strength × emotion × layer sweep on at least one large model (the sweep is the expensive part; batteries B2–B5 reuse its trials).
- **MoE behavior under steering:** unknown unknowns; run B1/B2 on a dense control model of similar capability if results look strange.
- **Subtle-emotion vector quality:** low-arousal categories (contentment, nostalgia, contemplation) may produce weak PCA vectors; appraisal-structured training pairs are the first mitigation, vector-quality gating (B1) the backstop.
- **Consent boundary:** calibration injections run against base/dev checkpoints, not the live persona deployment. If any battery is ever to run against the live persona (e.g., B10 self-report), it routes through the existing staged-intent/consent framework like any other intervention. The blinded-audit principles already in the architecture apply here unchanged.

---

## 8. Suggested build order

1. Provider audit + harness skeleton (parallel-run diff engine, trial logging, deterministic seeds).
2. Vector training pipeline with appraisal-structured pairs + B1 validity gate.
3. B2 detection + controls on the local model — proves the whole loop end-to-end at small scale.
4. Strength/layer sweep, then B4/B5 (reuse sweep trials).
5. B7/B8 substrate bridge tests.
6. B9 on the large model when cluster time lands.
7. B10 wired into the weekly training cycle last — it depends on stable instruments from everything above.
