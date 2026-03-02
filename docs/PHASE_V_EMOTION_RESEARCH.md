# Phase V: Continuous Emotion System — Research Synthesis

**Epic**: PSFN-domy (child) | Date: 2026-03-02 | Status: Research Complete

## Executive Summary

Five research agents investigated: the unfinished Purrsephone v2 emotion framework,
three arxiv papers + the emotional-intelligence benchmark, continuous emotion state
research (2025-2026), AI companion emotion patterns, and two additional papers on
LLM introspection and reasoning-as-society-of-thought.

**Key findings:**
1. The v2 framework had solid foundations (PAD model, EWMA smoothing, HEXACO traits,
   EmoT5 analysis) but critical gaps: traits never influenced output, no temporal
   dynamics, half the PAD model dead, memory system never wired
2. Lightweight classifiers exist that run in <50ms on CPU — no need for LLM calls per message
3. Emotional dynamics are *functional* in reasoning, not decorative (Societies of Thought paper)
4. Self-reports have ~20% genuine grounding (Introspection paper) — use multi-signal, don't trust self-report alone

---

## Purrsephone v2 Emotional System: What Was Built

**Source**: `/home/user/ai/dev/PurrsephoneFramework` (Python/FastAPI, 3 commits, Feb 2025)

### What Worked
- `EmotionalState` PAD model: valence + arousal + dominance + discrete emotions dict
- EmoT5-large for emotion analysis: valence, 11 categories, per-emotion intensity
- MoodState with EWMA smoothing (alpha=0.3, threshold=0.1)
- 14 mood tags mapped to valence ranges and emotion categories
- HEXACO-6 personality traits with EmotionalExpression modifiers
- Dual analysis (user + assistant emotions) per message
- Emotional state stored per message in SQLite
- Gradio visualization with Plotly emotion trajectory charts

### What Was Never Connected
- TraitProcessor.calculate_emotional_tendency() — never called from chat route
- TraitProcessor.modify_response_intensity() — never called
- update_emotional_context() — defined but never called
- Emotional memory retrieval — parameter accepted but ignored in search
- Memory system overall — 0 memories stored despite 92 chat messages
- emollama-7b sentiment model — configured but never used

### What Was Left as Stubs
- Conversation summarizer with emotion preservation — `pass` stubs
- Memory compression preserving emotional significance — `pass` stubs
- Mood decay / temporal baseline reset — documented only
- Arousal + Dominance dimensions — always zero (only valence populated)
- Background emotional processing ("subconscious") — docs only

### Critical Gaps to Fix in PSFN
1. **No emotion-to-behavior pipeline** — analysis happens AFTER response, never influences NEXT response
2. **No temporal dynamics** — no decay, no baseline, frozen between messages
3. **Half the PAD model dead** — only valence populated by EmoT5
4. **No emotional memory** — types defined but never wired to storage/retrieval

---

## Research Papers

### Referenced Papers

| Paper | Key Contribution | Relevance |
|-------|-----------------|-----------|
| **EmoLLMs** (arxiv:2401.08508) | Instruction-tuned 7B LLMs for unified classification + VAD regression. 10%+ over GPT-4 on sentiment regression. AAID dataset (234K samples) | Technique: VAD regression via instruction tuning. Too heavy for per-message use, but dataset useful for distillation |
| **EMO-LLaMA** (arxiv:2408.11424) | Facial emotion via VLM with facial priors (MTCNN + FaceXFormer landmarks + AUs). Dual attention architecture | Architecture decomposition: MTCNN (30ms) + face embedding + lightweight head. Skip the VLM, use the features |
| **Emotional Intelligence** (emotional-intelligence.github.io) | SECEU psychometric benchmark for LLM EQ. GPT-4 scores 89th percentile human. Representational divergence finding | Validation benchmark. 10-point allocation model interesting for soft emotion distribution |
| **Introspection** (transformer-circuits.pub/2025/introspection) | Concept injection proves ~20% genuine introspective access in Claude. Confabulation is the norm. Layer-specific | Self-reports have partial grounding. Treat as ONE signal, not ground truth. Design for honesty about uncertainty |
| **Societies of Thought** (arxiv:2601.10825) | Reasoning models simulate multi-agent debate with emotional dynamics. Steering "surprise" feature DOUBLES reasoning accuracy | **Emotion is functional, not decorative.** Neuroticism improves reasoning. Productive discomfort should be modeled |

### Key Research Findings (2025-2026)

**Chain-of-Emotion Architecture** (Croissant et al.): Separate LLM appraisal step per turn generates emotion description → stored in running "emotion chain" → included in subsequent prompts. No-Memory 57% → Memory 74% → Chain-of-Emotion 83% accuracy on emotion understanding.

**DAM-LLM** (arxiv:2510.27418): Bayesian memory update for affective memory. Memory entropy for confidence. 63-71% memory size reduction vs vanilla RAG. Higher personalization and emotional resonance scores.

**CEmoFlow** (arxiv:2601.12341): Neural ODE-based continuous emotion trajectories. Cubic Hermite Spline interpolation between observations. Cyclic time transforms.

**Charisma.ai Emotions Engine**: Feelings (short-term, seconds-minutes) vs Moods (long-term, slow-moving). Automatic mood decay to natural baseline. FACS-based animation mapping.

**Emotion Decay Half-Lives** (D'Mello & Graesser): Persistent states (boredom, engagement), transitory states (delight, surprise), intermediate (frustration). Measured from real interactions.

---

## Practical Classifiers for PSFN

### Text Emotion (Tier 1: Zero-cost)

| Model | Size | Latency | Categories | Runtime | License |
|-------|------|---------|------------|---------|---------|
| **NRC VAD Lexicon v2** | 55K terms, <5MB | <1ms (lookup) | Continuous VAD | Pure JS Map | Non-commercial |

### Text Emotion (Tier 2: Tiny BERT)

| Model | Size | Latency | Categories | Runtime | License |
|-------|------|---------|------------|---------|---------|
| **boltuix/bert-emotion** | 6M params, 20MB | <45ms (RPi4) | 13 emotions | transformers.js | Apache-2.0 |
| **j-hartmann/distilroberta-emotion** | 82M, 316MB | ~50-100ms | 7 (Ekman+N) | transformers.js | MIT |
| **SamLowe/go_emotions-onnx** | 125MB INT8 | 10-30ms | 28 multi-label | onnxruntime-node | MIT |

### Audio Emotion

| Model | Size | Latency | Categories | Runtime | License |
|-------|------|---------|------------|---------|---------|
| **SenseVoice-Small** | ~234M | 70ms/10s audio | 7 emotions + events | sherpa-onnx Node.js | Apache-2.0 |
| **DistilHuBERT** | 0.02MB | Real-time | 4-7 emotions | ONNX | MIT |

### Face Emotion

| Model | Size | Latency | Categories | Runtime | License |
|-------|------|---------|------------|---------|---------|
| **MorphCast SDK** | <1MB | 33-100ms | 7 emotions + AU | WebAssembly/JS | Commercial |
| **MTCNN + MobileFaceNet + FC head** | ~10MB | ~35ms | 7 (Ekman) | ONNX | Various |

---

## Recommended Architecture

### Layered Emotion System

```
Layer 0: Signal Extraction (per-message, <50ms total)
├── Text:  boltuix/bert-emotion via transformers.js → 13 categorical labels + scores
├── Text:  NRC VAD Lexicon word-average              → raw VAD vector (sub-ms)
├── Audio: SenseVoice-Small via sherpa-onnx           → 7 emotions (when voice active)
└── Face:  MTCNN + lightweight head                   → 7 emotions (when camera active)

Layer 1: Observation Fusion (per-message, <1ms)
├── fused_categorical = highest-confidence label across available modalities
└── fused_VAD = weighted average of text_VAD + audio_VAD (by confidence)

Layer 2: Emotional State (continuous, per-message update)
├── Internal VAD vector with per-dimension exponential decay
├── Update: state = decay(state_old, elapsed_time) + impulse(fused_VAD)
├── Decay: state_t = state_prev * e^(-lambda * delta_t)
├── Mood accumulator: slow EMA of emotional state (mood vs emotion)
└── Half-lives: joy ~30min, anger ~45min, sadness ~60min, surprise ~5min, love ~2h

Layer 3: Appraisal (periodic, every N turns or on significant shifts)
├── Chain-of-Emotion: LLM appraisal via background model
├── Input: recent messages + current VAD state + personality traits
├── Output: natural-language emotion description → appended to emotion chain
└── Triggered by: significant VAD shift, or every 5 turns

Layer 4: Memory Integration
├── Tag memories with agent's VAD state at formation time
├── Mood-congruent retrieval bias in composite scoring
├── Emotional intensity as factor in importance scoring
└── Emotion chain stored as part of session context

Layer 5: Behavioral Modulation
├── Current emotional state injected into runtime context
├── Persona adaptation extends honne/tatemae with affect layer
├── Response style modulation (warmth, formality, energy)
├── Heartbeat reflections become emotion-aware (sleeptime agent)
└── Think tool receives emotional state for reasoning modulation
```

### Key Design Decisions

**1. Multi-signal, not self-report.** (Introspection paper) Don't ask the LLM "how do you feel?" — derive emotional state from classifiers + context + memory patterns + optional LLM appraisal.

**2. Emotion influences cognition.** (Societies of Thought) Emotional state should modulate memory retrieval weights, reasoning strategy selection, and response generation — not be a display-only overlay.

**3. Feelings vs Moods.** (Charisma.ai) Short-term reactions (feelings, seconds-minutes) vs long-term dispositions (moods, hours-days). Two separate decay timescales on the same VAD space.

**4. Productive discomfort.** (Societies of Thought) Don't default to positive affect. Model tension, doubt, curiosity as functional states that improve reasoning. High neuroticism diversity correlates with accuracy.

**5. HEXACO revival.** (v2 framework) The HEXACO trait system from v2 was well-designed but never connected. EmotionalExpression modifiers (intensity, variability, control, display_range) should modulate how the internal VAD state maps to external behavior.

**6. Honest uncertainty.** (Introspection paper) When reporting emotional state, distinguish high-confidence (strong multi-signal agreement) from low-confidence (might be confabulation). Honne/tatemae naturally gates this by trust level.

---

## Implementation Phases

### Phase E-A: Core State Tracker (minimal, text-only)
1. `src/emotion/vad-lexicon.ts` — NRC VAD Lexicon as Map<string, VAD>
2. `src/emotion/state.ts` — EmotionState class with VAD vector, decay, mood EMA
3. `src/emotion/text-classifier.ts` — boltuix/bert-emotion via transformers.js
4. `src/emotion/observer.ts` — per-message hook: classify → fuse → update state
5. Wire into SubstrateAgent.handleMessage() and buildRuntimeContext()

### Phase E-B: Memory Integration
6. Tag memories with VAD state at formation
7. Mood-congruent retrieval bias in composite scoring
8. Emotional intensity factor in importance scoring

### Phase E-C: Appraisal + Behavioral Modulation
9. Chain-of-Emotion LLM appraisal (background model, periodic)
10. Persona adaptation based on emotional state (extends honne/tatemae)
11. HEXACO EmotionalExpression modifiers for output modulation

### Phase E-D: Multimodal
12. SenseVoice-Small audio emotion via sherpa-onnx
13. Multimodal fusion (weighted averaging initially)
14. Camera emotion (future, when camera input exists)

---

## References

### Papers
- EmoLLMs: https://arxiv.org/abs/2401.08508
- EMO-LLaMA: https://arxiv.org/abs/2408.11424
- Emotional Intelligence: https://emotional-intelligence.github.io/
- Introspection: https://transformer-circuits.pub/2025/introspection/index.html
- Societies of Thought: https://arxiv.org/abs/2601.10825
- DAM-LLM: https://arxiv.org/abs/2510.27418
- CEmoFlow: https://arxiv.org/abs/2601.12341
- EmoLoom-2B: https://arxiv.org/abs/2601.01112
- NRC VAD Lexicon v2: https://arxiv.org/abs/2503.23547
- Chain-of-Emotion: https://pmc.ncbi.nlm.nih.gov/articles/PMC11086867/
- D'Mello & Graesser emotion half-lives: cited throughout affective computing literature

### Models
- boltuix/bert-emotion: https://huggingface.co/boltuix/bert-emotion
- SamLowe/go_emotions-onnx: https://huggingface.co/SamLowe/roberta-base-go_emotions-onnx
- j-hartmann/distilroberta-emotion: https://huggingface.co/j-hartmann/emotion-english-distilroberta-base
- SenseVoice-Small: https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- MorphCast SDK: https://github.com/MorphCast/ai-sdk-js
- NRC VAD Lexicon: https://saifmohammad.com/WebPages/nrc-vad.html

### Production Systems
- Charisma.ai emotions engine: https://charisma.ai/blog/emotions-evolved-virtual-characters-emotions-engine
- Purrsephone v2: /home/user/ai/dev/PurrsephoneFramework
