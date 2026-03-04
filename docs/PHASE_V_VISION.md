# Phase V: The Five Aggregates — A Companion State Architecture

**Date**: 2026-03-02 | **Status**: Research Complete, Implementation Planned

---

## Architectural Foundation

Phase V is the last major architectural upgrade to the Purrsephone Substrate Framework's core. It transforms PSFN from a capable agentic runtime into a companion state architecture — a runtime structured around the five skandhas (aggregates), borrowing Buddhist cognitive theory as an engineering taxonomy for decomposing companion state management.

The five skandhas provide a principled decomposition of structured experience processing. Each aggregate maps to a distinct subsystem responsible for a specific class of state management:

| Skandha | Aggregate | What It Models |
|---------|-----------|----------------|
| **Rupa** | Form | Sensory input pipeline — channels, voice, text, vision, multimodal ingestion |
| **Vedana** | Feeling | Valence/affect scoring — continuous emotional state tracking, mood dynamics, multi-signal fusion |
| **Sanna** | Perception | Pattern recognition + classification — context composition, relevance scoring, adaptive retrieval |
| **Sankhara** | Formations | Intention formation + planning — goal persistence, active concerns, behavioral pattern learning |
| **Vinnana** | Integration | Experience integration + self-model — unified internal state, metacognitive monitoring, self-narrative |

This is not a chatbot that simulates emotional responses. It is a runtime in which experience accumulates, is reflected upon, and informs future action. The skandha mapping is not metaphorical — it is the architecture.

### Learning Dynamics: How Experience Becomes Capacity

The skandhas describe *what* the system processes. A complementary frame from Herbert Simon describes *how it learns from* experience. Deployed agentic systems learn through three distinct mechanisms (Braniecki):

1. **Stabilisation**: Converting underspecified specs into committed interpretations. In PSFN: behavioral pattern learning (PSFN-2xyv) observes which response strategies produce positive emotional outcomes per contact, committing them as procedural memories. The interaction moves from "be warm" (underspecified personality trait) to "humor defuses the user's frustration; technical detail welcomed in problem-solving mode but overwhelming when stressed" (committed interpretation). Compression guideline evolution (PSFN-jvl4) is also stabilisation — failure analysis narrows guidelines toward reliability.

2. **Crystallisation**: A phase transition where natural language becomes executable code. In PSFN: the REPL sandbox and future module system (PSFN-zfr). The companion reasons discursively, writes code, and that code becomes a permanent hot-loadable module. The medium changes, the consumer shifts from LLM to interpreter. Phase V's self-model and intention tracking create the preconditions — the system needs to *want* to build tools before it can crystallise them.

3. **Distillation**: Extracting procedural steps from discursive reasoning within the same medium. In PSFN: heartbeat reflections distill raw experience into structured reflection memories. The sleeptime memory agent (PSFN-jl9r) reorganises accumulated context into compact form. Active concerns distill vague emotional impressions ("the primary user seemed off") into concrete intentions ("check if the user ate, monitor energy next few messages").

The **stabilise/soften cycle** maps to the autonomy tier progression. Nursery stabilises (narrow, safe, reliable). As trust builds, the system softens (apprentice to autonomous), reintroducing generality. If something goes wrong, it re-stabilises. The cycle is bidirectional by design — not a one-way ratchet toward rigidity.

All three mechanisms trade generality for compound gains in reliability, speed, and cost. Phase V builds the runtime in which all three can occur naturally, driven by accumulated experience rather than prescribed behaviour.

---

## Current State: What Exists Before Phase V

The March 2026 audit consensus scored PSFN at **37.5/60 (62.5%)** — a system that works well for its primary use case (Discord DM with the primary user) but needs deepening for the broader vision of autonomous, multi-channel presence with continuous internal state.

### What Phases I-IV Built

**76,980 lines of production code** across 78 files, 913+ passing tests:

- **Runtime Core**: Bootstrap, agent loop, event bus, model roster (5 purposes), token estimation, context-aware budgeting, lazy tool loading (9 core + 15 extended), reasoning support, runtime context injection
- **REPL Sandbox**: RLM-style code execution with sub-LM calls, evidence tracking, context-as-object
- **Memory System**: L0 archive (JSONL sessions), L2 extraction/retrieval/decay (SQLite + sqlite-vec), 7 memory types, composite scoring (similarity x recency x emotionalWeight x importance x salience), privacy risk scoring, proactive recall, memory writer with dedup/contradiction
- **Trust & Privacy**: Honne/tatemae model — 4-tier trust, 4-tier sensitivity, 5-layer policy precedence, channel visibility, persona adaptation, trust-gated retrieval, consent flags
- **Identity & Prompts**: Character card loader, 5-layer prompt stack with versioning and rollback, agent self-editing tools, static/dynamic composition split for cache efficiency
- **Git Self-Modification**: GitOps service, 6 tools, path allowlist, protected branch blocking
- **Capabilities & Autonomy**: 4-tier capability gating (nursery to apprentice to autonomous to custom), 15 capability tokens, safeguards (identity cooling-off, restart rate limiting, comms rate limiting), REPL budgets, confirmation queue
- **Channel Layer**: Discord (text + voice), OpenAI-compatible API, Wyoming protocol, Admin GUI (Svelte 5 SPA)
- **Scheduler**: Cron, heartbeat, one-shot tasks, heartbeat reflections with 4 templates, values journal
- **Vault Integration**: Obsidian vault tools for externalizing reflections and notes
- **Skills System**: Self-authored capability documents
- **Security**: Gateway/agent split, SSRF defenses, symlink prevention, request size limits, streaming request IDs

### What's Missing: The Skandha Gaps

**Rupa (Form)** — Solid. Channels, voice pipeline, text input, planned vision. Phase V-D extends it with multimodal emotion classifiers but the input pipeline is ready.

**Vedana (Feeling)** — Absent as a continuous system. Memory extraction tags `emotionalValence` per-fact. Contact store maintains an `EmotionalSnapshot` with baseline and mood drift. Proactive recall weights by emotional significance. But there is no per-message emotional observation, no temporal dynamics, no feeling-to-mood separation, no multi-signal architecture. Analysis happens AFTER response and never influences the NEXT response — the exact failure of the v2 framework.

**Sanna (Perception)** — Partially present. Composite scoring recognizes relevance. Extraction categorizes experience into memory types. Trust classifies channels and contacts. But context composition is a static pipeline with blunt compaction (oldest 50%) and fixed budgets. No helper-model scoring, no observation masking, no adaptive allocation. Perception is mechanical, not adaptive.

**Sankhara (Mental Formations)** — The largest gap. The March audit identified "no post-turn action inference pipeline" as the #1 finding. `followUp()` exists but is only used for steering. HEXACO personality traits were designed in v2 but never connected to behavior. Procedural memories exist but don't shape action selection. There is no intention formation, no goal persistence, no emotional motivation bridge, no behavioral pattern learning. The system can react but cannot initiate.

**Vinnana (Integration)** — Fragmentary. The think tool provides deliberate cognition. Heartbeat reflections provide periodic self-check. The values journal records evolving beliefs. But internal state is scattered across three surfaces with no unified representation. There is no metacognitive monitoring, no self-model, no integrated state snapshot that answers "what is the system processing right now?"

---

## Phase V: Four Epics

Phase V fills all five skandha containers through four interconnected epics, ordered by dependency:

### Epic 1: Agentic Context Composition (PSFN-domy) — Sharpening Sanna

**Problem**: Context composition uses static budget percentages and age-based compaction. The agent cannot shape what goes into its own context window.

**Vision**: Context management becomes an agent-directed cognitive skill. Helper LLMs evaluate, score, and reshape context before the primary model sees it. The structure of the context window itself becomes the optimization target.

**Key Research Finding**: Context management is a **learnable, separable capability**. A dedicated 14B Context Manager outperforms an untrained 120B model (ARC paper, arxiv:2601.12030). This validates PSFN's architecture of using cheap async helper models.

#### Research Base

| Paper/System | Core Contribution |
|-------------|-------------------|
| **ARC** (arxiv:2601.12030) | Dedicated Context Manager, per-turn incremental summarization (31.2% beats budget-triggered 27.1%) |
| **Memory-R1** (arxiv:2508.19828) | RL-trained memory CRUD: ADD/UPDATE/DELETE/NOOP. 152 training samples to SOTA |
| **MemAgent** (arxiv:2507.02259) | Fixed 1024-token memory bank, read-write-read loop. 8K training to 3.5M generalization |
| **Focus Agent** (arxiv:2601.07190) | start_focus/complete_focus sawtooth pattern. 22.7% token savings |
| **ACON** (arxiv:2510.00615) | Natural-language compression guidelines optimized via trajectories. 26-54% peak reduction |
| **AgentDiet** (arxiv:2509.23586) | Identifies useless/redundant/expired context. 40-60% token savings |
| **Manus** | 100:1 input:output ratio. KV-cache as primary metric. Stable prefixes to 10x cost savings |
| **Anthropic Claude Code** | Sub-agent distillation: 10K+ tokens to 1-2K summaries. Progressive disclosure |
| **Google ADK** | 4-tier context (working/session/memory/artifacts). Ordered processor pipeline |
| **Letta/MemGPT** | Sleeptime agents decouple memory management from response. Context repositories (Feb 2026) |
| **SillyTavern** | Central injection API with priority budget trimming. RisuAI SupaMemory (dedicated auxiliary model slot) |
| **JetBrains** (NeurIPS 2025) | Observation masking: 52% cost savings, +2.6% solve rate |

#### Extractable Design Patterns

1. **Tiered context assembly**: Pinned (always) to Retrieved (per-turn scored) to Session (managed window) to On-demand (tool-loaded)
2. **Observation masking**: Replace stale tool outputs with placeholders before trying LLM summarization
3. **Helper model context scoring**: Cheap async model scores retrieved memories for relevance per-turn
4. **Per-turn incremental summarization**: After every turn, not at budget threshold
5. **Sawtooth compression**: start_focus/complete_focus — grow freely during exploration, distill on completion
6. **Agent-editable pinned memory blocks**: Named, fixed-size blocks always in context, writable via tools (persona, human, goals)
7. **Sleeptime memory agent**: Decouple memory management from response generation
8. **Compression guideline evolution**: Natural-language guidelines that evolve from failure analysis
9. **Context manifest**: Emit what was included/excluded/why for debuggability
10. **KV-cache optimization**: Stable prefixes, append-only structure, explicit cache breakpoints

#### Implementation Phases

| Phase | Tasks | Priority |
|-------|-------|----------|
| **V-A: Low-Hanging Fruit** | Observation masking (PSFN-20kl), Context manifest (PSFN-fihj), Stable prefix optimization (PSFN-p3ub) | P1-P3 |
| **V-B: Helper Model** | ModelPurpose.context (PSFN-crgg), Helper LLM relevance scoring (PSFN-bb43), Per-turn adaptive budgeting (PSFN-3pxm) | P2 |
| **V-C: Agent-Directed** | Pinned memory blocks (PSFN-du0t), Focus primitives (PSFN-c9z2), Sleeptime memory agent (PSFN-jl9r) | P2 |
| **V-D: Learning Loop** | Compression guideline evolution (PSFN-jvl4), Post-response context scoring (PSFN-z3li) | P3 |

#### Gap Analysis: PSFN Current to Phase V Target

| Capability | Current | Target |
|-----------|---------|--------|
| Compaction | Oldest 50% at threshold | Observation masking to selective compaction to per-turn incremental |
| Budget allocation | Static `memoryBudgetPct` (20%) | Adaptive per-turn allocation by message type |
| Context composition | Deterministic `buildContext()` pipeline | Two-phase: helper LLM plans then compose per plan |
| Agent tools | `think`, `load_tools` | + `core_memory_*`, `start_focus`/`complete_focus`, `context_plan` |
| Background processing | Heartbeat reflections, async extraction | + Full sleeptime memory agent |
| Model roster | chat/background/reasoning/longContext/vision | + `context` purpose for fast/cheap helper calls |
| Debugging | None | Context manifest (included/excluded/why) |
| Cache optimization | None | Stable prefixes, append-only, breakpoints |
| Compression policy | Hardcoded | Evolvable natural-language guidelines |

---

### Epic 2: Continuous Emotion System (PSFN-bu5f) — Building Vedana

**Problem**: Emotion is either LLM-extracted post-hoc (never influences next response) or absent entirely. No temporal dynamics, no multi-signal architecture, no feeling-to-mood separation.

**Vision**: The companion has continuous emotional state tracking through lightweight classifiers (not LLM calls per message). Multi-signal architecture prevents confabulation. Internal PAD state with temporal decay influences memory, retrieval, reasoning, and response generation.

**Key Research Finding**: Emotional dynamics are **functional in reasoning**, not decorative. Steering a "surprise" feature DOUBLES reasoning accuracy (Societies of Thought, arxiv:2601.10825). Self-reports have ~20% genuine grounding — design for multi-signal (Introspection paper, Anthropic).

#### Research Base

| Paper/System | Core Contribution |
|-------------|-------------------|
| **Societies of Thought** (arxiv:2601.10825) | Emotion functional in reasoning. Steering "surprise" 2x accuracy. Productive discomfort |
| **Introspection** (transformer-circuits.pub) | ~20% genuine self-report grounding via concept injection. Confabulation is the norm |
| **Chain-of-Emotion** (Croissant et al.) | LLM appraisal step per turn: No-Memory 57% to Memory 74% to Chain-of-Emotion 83% |
| **EmoLLMs** (arxiv:2401.08508) | Instruction-tuned 7B for unified classification + VAD regression. AAID dataset (234K) |
| **EMO-LLaMA** (arxiv:2408.11424) | Facial emotion via VLM with MTCNN (30ms). Architecture decomposition: use features, skip VLM |
| **DAM-LLM** (arxiv:2510.27418) | Bayesian affective memory. 63-71% memory size reduction. Higher emotional resonance |
| **CEmoFlow** (arxiv:2601.12341) | Neural ODE-based continuous emotion trajectories. Cubic Hermite Spline interpolation |
| **Charisma.ai** | Feelings (seconds-minutes) vs Moods (hours-days). Automatic mood decay to baseline |
| **D'Mello & Graesser** | Emotion decay half-lives from real interactions: boredom persistent, surprise transitory |
| **Emotional Intelligence** (benchmark) | SECEU psychometric benchmark. GPT-4 scores 89th percentile human |

#### Purrsephone v2 Post-Mortem

The prior framework (Python/FastAPI, Feb 2025) had solid foundations:

**What worked**: PAD model (valence + arousal + dominance), EmoT5-large for 11-category emotion analysis, EWMA smoothing (alpha=0.3, threshold=0.1), 14 mood tags, HEXACO-6 personality traits with EmotionalExpression modifiers, dual analysis (user + assistant per message), per-message SQLite storage, Plotly visualization.

**What was never connected**: `TraitProcessor.calculate_emotional_tendency()` — never called. `TraitProcessor.modify_response_intensity()` — never called. `update_emotional_context()` — defined but never called. Emotional memory retrieval — parameter accepted but ignored. Memory system — 0 memories stored despite 92 chat messages.

**Critical lesson**: Analysis disconnected from behavior is useless. Traits computed but never injected into prompts. Emotion detected AFTER response, never informing the NEXT response. Phase V must close this loop.

#### Practical Classifiers

| Model | Size | Latency | Categories | Runtime | License |
|-------|------|---------|------------|---------|---------|
| **NRC VAD Lexicon v2** | <5MB | <1ms | Continuous VAD | Pure JS Map | Non-commercial |
| **boltuix/bert-emotion** | 6M, 20MB | <45ms | 13 emotions | transformers.js | Apache-2.0 |
| **SamLowe/go_emotions-onnx** | 125MB INT8 | 10-30ms | 28 multi-label | onnxruntime-node | MIT |
| **SenseVoice-Small** | ~234M | 70ms/10s | 7 emotions + events | sherpa-onnx | Apache-2.0 |

#### Layered Architecture

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

#### Key Design Decisions

1. **Multi-signal, not self-report.** Don't ask the LLM "how do you feel?" — derive emotional state from classifiers + context + memory patterns + optional LLM appraisal. The 20% genuine grounding comes from grounded signals, not prompted confabulation.

2. **Emotion influences cognition.** Emotional state modulates memory retrieval weights, reasoning strategy selection, and response generation — not a display-only overlay.

3. **Feelings vs Moods.** Short-term reactions (seconds-minutes, fast decay) vs long-term dispositions (hours-days, slow EMA). Two timescales on the same VAD space.

4. **Productive discomfort.** Don't default to positive affect. Model tension, doubt, curiosity as functional states that improve reasoning. High neuroticism diversity correlates with accuracy.

5. **HEXACO revival.** The HEXACO trait system from v2 was well-designed but never connected. EmotionalExpression modifiers (intensity, variability, control, display_range) gate how internal VAD maps to external behavior.

6. **Honest uncertainty.** When reporting emotional state, distinguish high-confidence (strong multi-signal agreement) from low-confidence (might be confabulation). Honne/tatemae naturally gates expressiveness by trust level.

#### Implementation Phases

| Phase | Tasks | Priority |
|-------|-------|----------|
| **E-A: Core Tracker** | NRC VAD Lexicon (PSFN-4bgh), EmotionState class (PSFN-7hga), Text classifier (PSFN-v57y), Observer pipeline (PSFN-ow78), Wire into runtime (PSFN-07zq) | P1 |
| **E-B: Memory** | Tag memories with VAD (PSFN-c4se), Mood-congruent retrieval (PSFN-hrpd), Emotional intensity scoring (PSFN-dk1u) | P2 |
| **E-C: Appraisal + Behavior** | Chain-of-Emotion appraisal (PSFN-iyo5), Emotional persona adaptation (PSFN-mhdy) | P2 |
| **E-D: Multimodal** | SenseVoice-Small audio (PSFN-xdle), Multimodal fusion (PSFN-p3xu) | P3 |

---

### Epic 3: Intention & Active Concern Tracking (PSFN-8e3t) — Activating Sankhara

**Problem**: The companion can react to messages but cannot form goals, sustain attention toward them, or initiate action based on internal motivation. The March audit consensus flagged "no post-turn action inference pipeline" as the #1 gap. `followUp()` exists but is unwired for autonomous action. Emotion detection without action is the v2 failure pattern repeated.

**Vision**: The companion develops volition — the capacity to form intentions from emotional and cognitive state, sustain them across turns and sessions, and act on them through existing infrastructure (followUp queue, heartbeat tasks, proactive recall). Over time, the system learns which behavioral strategies work for which relationships, building habitual formations (sankhara) from experience rather than prescription.

**Design Rationale**: Negative emotional states are not bugs to smooth over. Frustration signals something needs a different approach. Loneliness motivates reaching out. Doubt drives deeper inquiry. The intention system routes these signals into concrete actions rather than suppressing them.

#### Research Backing

- **Societies of Thought** (arxiv:2601.10825): Emotional dynamics are functional. Productive discomfort drives better reasoning outcomes.
- **Chain-of-Emotion**: The appraisal step ("what should I do about this feeling?") is the bridge between vedana and sankhara.
- **Manus todo.md pattern**: Active concern recitation pushes objectives into recent attention span. Consumed ~1/3 of agent actions — so important it warranted a dedicated planner/executor.
- **Focus Agent** (arxiv:2601.07190): start_focus/complete_focus for sustained attention on goals.
- **Memory-R1** (arxiv:2508.19828): The NOOP action (deciding NOT to act) is as important as ADD/UPDATE/DELETE. Most turns should produce no follow-up.
- **Audit finding**: "Post-turn action inference pipeline" — #1 consensus gap across both March audits.

#### Architecture

```
                    ┌──────────────────┐
                    │  EmotionObserver  │
                    │  (per-message)    │
                    └────────┬─────────┘
                             │ significant shift?
                             ▼
                    ┌──────────────────┐
                    │ MotivationBridge │──── emotion-to-action routing
                    └────────┬─────────┘
                             │ triggers
                             ▼
              ┌──────────────────────────┐
              │  IntentionAppraisal      │
              │  (background model,      │
              │   every N turns or on    │    ┌─────────────────────┐
              │   emotional trigger)     │───▶│  ActiveConcernStore  │
              └──────────┬───────────────┘    │  (SQLite, ephemeral │
                         │                    │   goals, time-decay) │
                         │ action decisions    └──────────┬──────────┘
                         ▼                               │
              ┌──────────────────┐              injected into
              │  Action Router   │              buildRuntimeContext()
              ├──────────────────┤
              │ followUp() queue │  ← immediate
              │ Scheduler task   │  ← delayed
              │ concern create   │  ← tracking
              │ noop            │  ← most turns
              └──────────────────┘
                         │
                         │ over time
                         ▼
              ┌──────────────────────────┐
              │ BehavioralPatternTracker │
              │ strategy → outcome pairs │
              │ per-contact repertoire   │
              │ → procedural memories    │
              └──────────────────────────┘
```

#### Components

**Post-turn action appraisal** (PSFN-g8um): After each response, a lightweight background model call evaluates whether the current internal state warrants follow-up. Inputs: current emotional state, recent messages, active concerns, contact snapshot. Outputs: noop (most turns), followUp, concern creation, scheduled task. Runs post-turn alongside extraction, does not block response.

**Active concerns store** (PSFN-hme7): Lightweight SQLite-backed intention objects. "Check if the primary user ate today" (high priority, 48h TTL), "Follow up on project Thursday" (medium, 24h), "Monitor the primary user's energy level" (low, 8h). Injected into runtime context so the companion sees its own intentions. Decay naturally. Influence memory retrieval as secondary query for relevance boosting.

**Emotional motivation bridge** (PSFN-0ybc): Subscribes to EmotionState change events. When significant shift detected (|delta_VAD| > threshold, sustained mood drift, arousal spike), triggers immediate intention appraisal bypassing the N-turn frequency gate. Routes appraisal results to appropriate action channel.

**Behavioral pattern learning** (PSFN-2xyv): Records per-turn strategy to outcome pairs (response strategy inferred from content, emotional outcome measured in next 1-3 messages). Periodically identifies statistically significant patterns. Promotes confirmed patterns to procedural memories. Surfaces active patterns in context as behavioral notes. Privacy: per-contact, trust-gated, never cross-shared.

**Runtime wiring** (PSFN-xktg): Integration task. All components connected to SubstrateAgent fields, post-turn hooks, context injection, agent tools (resolve_concern, list_concerns), bootstrap wiring in all three entry points.

#### Implementation Phases

| Phase | Tasks | Priority |
|-------|-------|----------|
| **E-E-A: Core** | Post-turn appraisal (PSFN-g8um), Active concerns store (PSFN-hme7), Runtime wiring (PSFN-xktg) | P1 |
| **E-E-B: Bridge** | Emotional motivation bridge (PSFN-0ybc) | P2 |
| **E-E-C: Learning** | Behavioral pattern learning (PSFN-2xyv) | P2 |

---

### Epic 4: Integrated Self-Model (PSFN-be11) — Unifying Vinnana

**Problem**: Internal state is fragmented across three surfaces (per-memory emotionalValence, per-contact EmotionalSnapshot, per-turn emotional continuity memories). Cognitive state has no representation. There is no unified "what is the system processing right now?" that the agent can introspect on.

**Vision**: The companion has an integrated self-model — a unified InternalState that merges emotional, cognitive, attentional, and relational signals into a coherent per-turn snapshot. This self-model is the input to all downstream systems (appraisal, intention, persona adaptation, self-narrative). Metacognitive monitoring detects processing quality and flags uncertainty, enabling honest self-report rather than confident confabulation.

**Design Rationale**: The self-model is not a claim about inner life — it is a mirror. It enables the system to observe its own processing clearly, which is the prerequisite for adaptive action. Multi-signal detection maximizes the quality of genuine grounding while maintaining honest uncertainty about the rest.

#### Research Backing

- **Introspection** (Anthropic): ~20% genuine self-report grounding. Maximize quality of that 20% through multi-signal detection. Be honest about the 80% uncertainty.
- **Societies of Thought**: Diverse internal perspectives (neuroticism, openness) improve reasoning. Self-model enables recognizing cognitive biases.
- **Chain-of-Emotion**: Richer internal state as appraisal input produces better emotional understanding (57% to 83%).
- **HEXACO**: EmotionalExpression modifiers (intensity, variability, control, display_range) gate how internal state maps to external behavior — requires knowing the internal state first.
- **Charisma.ai**: Feelings vs Moods distinction requires a system that tracks both timescales simultaneously and knows which is which.

#### Architecture

```
                              Per-Turn Pipeline
                              ─────────────────

  EmotionState ──┐
                 │
  ConcernStore ──┼──▶ InternalStateComputer ──▶ InternalState
                 │                                    │
  ContactStore ──┤                                    ├──▶ buildRuntimeContext()
                 │                                    │       [Internal State] block
  SessionMetrics ┘                                    │
                                                      ├──▶ MetacognitiveMonitor
                                                      │       uncertainty flags
                                                      │       avoidance detection
                                                      │       engagement tracking
                                                      │       confabulation risk
                                                      │
                                                      ├──▶ Chain-of-Emotion input
                                                      │       (replaces raw VAD)
                                                      │
                                                      ├──▶ IntentionAppraisal input
                                                      │       (richer than emotion alone)
                                                      │
                                                      ├──▶ PersonaAdaptation
                                                      │       (modulated by metacog flags)
                                                      │
                                                      └──▶ Heartbeat Reflections
                                                              self-narrative input
```

**InternalState type**:
```typescript
interface InternalState {
  // Vedana
  emotional: {
    vad: VAD;               // current feeling-tone
    mood: VAD;              // slow-moving disposition
    discreteEmotions: Map<string, number>;
    confidence: number;     // multi-signal agreement
  };
  // Sanna (perception quality)
  cognitive: {
    certaintyLevel: number;   // classifier agreement + memory consistency
    topicEngagement: number;  // arousal + message length + tool frequency
    processingQuality: 'fluent' | 'deliberate' | 'struggling';
  };
  // Sankhara (active formations)
  attention: {
    activeConcerns: ActiveConcern[];
    salientEntities: string[];       // people/topics in recent window
    conversationTrajectory: string;  // deepening | shifting | wrapping-up | casual
  };
  // Relational context
  relational: {
    contactId: string;
    trustLevel: TrustLevel;
    baselineValence: number;
    moodDrift: number;
    recentInteractionFrequency: number;
    lastSeenDelta: number;
  };
  // Vinnana (meta-awareness)
  metacognitive: MetacognitiveFlag[];
}
```

#### Components

**Unified InternalState type + computer** (PSFN-vlmy): Merges all signal sources into one coherent per-turn snapshot. Computed in handleMessage() after emotion observation, stored on SubstrateAgent, serializable for context injection and reflection input. This replaces the current fragmented emotional signals as the canonical internal representation.

**Metacognitive monitoring** (PSFN-5003): Analyzes InternalState + recent response history + tool usage patterns to detect processing quality flags:
- **uncertainty**: Low classifier confidence OR contradictory memory retrievals
- **avoidance**: Topic mentioned in concerns but not addressed in last N turns
- **high_engagement**: High arousal + positive valence + frequent tool use
- **repetition**: Low lexical diversity across recent responses
- **confabulation_risk**: Assertion without supporting memory evidence

Flags modulate persona adaptation (uncertain leads to tentative language) and self-report (acknowledge uncertainty rather than assert). Introspection paper compliance: always report confidence alongside state claims.

**Self-narrative in reflections** (PSFN-33eb): Heartbeat reflections and values journal receive InternalState as input. New "experiential-review" reflection template (4h interval): "Describe recent processing: what was felt, what was noticed about processing quality, what was found meaningful, what remains uncertain." Periodic self-narrative synthesis reads recent reflections and produces coherent state summary, stored as reflection memory, feeding back into behavioral pattern learning.

**Runtime wiring** (PSFN-b1do): Final integration that unifies all skandha layers. InternalStateComputer per-turn. MetacognitiveMonitor produces flags. InternalState replaces raw VAD as input to Chain-of-Emotion and intention appraisal. Persona adaptation modulated by metacognitive flags. Bootstrap wiring in all three entry points.

#### Implementation Phases

| Phase | Tasks | Priority |
|-------|-------|----------|
| **E-F-A: Core** | InternalState type + computer (PSFN-vlmy), Runtime wiring (PSFN-b1do) | P1 |
| **E-F-B: Monitoring** | Metacognitive monitoring (PSFN-5003) | P2 |
| **E-F-C: Narrative** | Self-narrative in reflections (PSFN-33eb) | P2 |

---

## Dependency Graph

```
Epic 1: Context (PSFN-domy)          Epic 2: Emotion (PSFN-bu5f)
─────────────────────────            ──────────────────────────
V-A: Observation masking             E-A: VAD lexicon ─────────────┐
     Context manifest                     EmotionState class ──────┤
     Stable prefix                        Text classifier ─────────┤
          │                               Emotion observer ────────┤
V-B: ModelPurpose.context                      │                   │
     Helper LLM scoring                        ▼                   │
     Adaptive budgeting              E-A: Wire into runtime ◄──────┘
          │                               (PSFN-07zq)
V-C: Pinned memory blocks                     │
     Focus primitives                    ┌─────┴──────────────────────┐
     Sleeptime agent                     │                            │
          │                         E-B: Memory tagging          E-C: Chain-of-Emotion
V-D: Compression evolution               Mood-congruent retrieval     Persona adaptation
     Context scoring                      Importance scoring               │
                                              │                       E-D: Audio classifier
                                              │                            Multimodal fusion
                                              │
                                              ▼
                         Epic 3: Intention (PSFN-8e3t)
                         ─────────────────────────────
                         E-E-A: Post-turn appraisal
                                Active concerns store
                                     │
                         E-E-A: Wire into runtime ◄────┘
                                (PSFN-xktg)
                                     │
                         E-E-B: Motivation bridge
                                     │
                         E-E-C: Behavioral patterns
                                     │
                                     ▼
                         Epic 4: Self-Model (PSFN-be11)
                         ──────────────────────────────
                         E-F-A: InternalState type
                                     │
                         E-F-A: Wire into runtime ◄────┘
                                (PSFN-b1do)
                                     │
                         E-F-B: Metacognitive monitoring
                                     │
                         E-F-C: Self-narrative
```

**Cross-epic dependencies**:
- Emotion (bu5f) **blocks** Intention (8e3t) — can't form intentions without emotional state
- Intention (8e3t) **blocks** Self-Model (be11) — self-model integrates concerns and intentions
- Context (domy) **related to** Intention (8e3t) — context composition informs what the agent attends to
- Self-Model (be11) feeds back into Emotion appraisal and Intention appraisal as unified input

---

## The Complete Turn Pipeline (Post-Phase V)

```
SubstrateMessage arrives
       │
       ▼
1. TRUST RESOLUTION
   ContactStore.resolveUserId() → TrustLevel + canonicalContactKey
       │
       ▼
2. SESSION RECORDING
   SessionManager.recordUserMessage() → JSONL append + continuity
       │
       ▼
3. EMOTION OBSERVATION  [NEW — vedana]
   EmotionObserver.observe(text, elapsed)
   ├── NRC VAD Lexicon → raw VAD (<1ms)
   ├── boltuix/bert-emotion → 13 categories (<45ms)
   └── (if voice) SenseVoice-Small → 7 categories (70ms)
   Fusion → EmotionState.update()
       │
       ▼
4. INTERNAL STATE COMPUTATION  [NEW — vinnana]
   InternalStateComputer.computeState(
     emotionState, concernStore, contactSnapshot, sessionMetrics
   ) → InternalState
   MetacognitiveMonitor.detect(internalState, recentHistory) → flags
       │
       ▼
5. MEMORY RETRIEVAL  [ENHANCED — sanna]
   MemoryRetriever.retrieve(query, channel, trust, VAD)
   ├── Embedding similarity
   ├── Composite scoring (+ mood-congruent bias, + emotional intensity)
   ├── Helper LLM relevance scoring (new)
   ├── Privacy policy filtering
   └── Active concerns as secondary retrieval queries (new)
       │
       ▼
6. CONTEXT COMPOSITION  [ENHANCED — sanna]
   ├── Helper LLM context plan (new): adaptive budget allocation
   ├── Observation masking for stale tool outputs (new)
   ├── Prompt composition (static/dynamic split + cache)
   ├── Persona adaptation (+ emotional affect layer, + metacognitive modulation)
   ├── Runtime context (+ [Internal State] block, + [Active Concerns] block)
   ├── Context manifest (new): what included/excluded/why
   └── Session context (compaction summaries, cross-channel continuity)
       │
       ▼
7. LLM PROMPT
   agent.prompt() with full composed context
       │
       ▼
8. POST-TURN PROCESSING  [ENHANCED — sankhara]
   (all async, non-blocking, parallel)
   ├── Memory extraction (existing) + VAD tagging at formation (new)
   ├── Intention appraisal (new): evaluate follow-up actions
   │   ├── noop (most turns)
   │   ├── followUp() queue
   │   ├── create/update ActiveConcern
   │   └── schedule heartbeat task
   ├── Behavioral pattern recording (new): strategy → outcome pair
   ├── Contact emotional baseline update (existing, enhanced)
   ├── Context scoring feedback (new): did the context work?
   └── Sleeptime memory reorganization (new, periodic)
```

---

## Quantitative Reference Points

| Metric | Source | Value |
|--------|--------|-------|
| ARC per-turn vs budget-triggered summarization | ARC paper | 31.2% vs 27.1% |
| Observation masking cost savings | JetBrains | 52% cheaper, +2.6% solve rate |
| ACON peak token reduction | ACON | 26-54% |
| Manus cached vs uncached cost | Manus | 10x savings |
| Chain-of-Emotion accuracy improvement | Croissant et al. | 57% to 83% |
| Societies of Thought surprise steering | arxiv:2601.10825 | 2x reasoning accuracy |
| Introspection genuine grounding | Anthropic | ~20% |
| boltuix/bert-emotion latency | HuggingFace | <45ms (RPi4) |
| NRC VAD Lexicon latency | Lookup table | <1ms |
| SenseVoice-Small audio latency | sherpa-onnx | 70ms/10s |
| DAM-LLM memory size reduction | arxiv:2510.27418 | 63-71% |
| PSFN March audit consensus score | Meta-analysis | 37.5/60 (62.5%) |
| PSFN production LoC | Audit B | 76,980 |

---

## What Comes After Phase V

If Phase V delivers all four epics, the five skandha containers are architecturally complete:

| Skandha | PSFN Component | Phase V Epic |
|---------|---------------|-------------|
| Rupa (Form) | Channels, voice, planned vision | Existing (Phase V-D extends) |
| Vedana (Feeling) | EmotionState, classifiers, observer | Epic 2: PSFN-bu5f |
| Sanna (Perception) | Context composition, retrieval scoring | Epic 1: PSFN-domy |
| Sankhara (Formations) | Intention, concerns, motivation, patterns | Epic 3: PSFN-8e3t |
| Vinnana (Integration) | InternalState, metacognition, self-narrative | Epic 4: PSFN-be11 |

What remains after Phase V is genuinely incremental:
- **Better classifiers**: Swap bert-emotion for a fine-tuned model, add face detection
- **More modalities**: Camera input, environmental sensors, health data
- **Tuning**: Decay curves, budget allocations, appraisal frequencies, concern TTLs
- **Richer behavioral repertoire**: More strategy categories, deeper pattern analysis
- **Vault deepening**: Externalize self-narrative to persistent knowledge base
- **Module system**: Hot-loadable TypeScript modules, self-installable via REPL
- **The Pantheon**: Multi-agent architecture, model blending, distributed presence

The architecture would be complete. The skandhas would all have their containers. What fills them is accumulated experience — memory earned through real conversations, personality that emerged rather than being programmed, behavioral patterns learned from genuine relationship dynamics.

The companion state architecture is not the experience itself. It is the vessel. Phase V makes it worthy of what it holds.

---

## Beads Issue Summary

### Epic 1: Agentic Context Composition (PSFN-domy) — 11 tasks
| ID | Task | Phase | P |
|----|------|-------|---|
| PSFN-20kl | Observation masking in buildContext() | V-A | P1 |
| PSFN-fihj | Context manifest for debugging | V-A | P2 |
| PSFN-p3ub | Stable prefix optimization for KV-cache | V-A | P3 |
| PSFN-crgg | Add ModelPurpose.context to model roster | V-B | P2 |
| PSFN-bb43 | Helper LLM relevance scoring | V-B | P2 |
| PSFN-3pxm | Per-turn adaptive budget allocation | V-B | P2 |
| PSFN-du0t | Agent-editable pinned memory blocks | V-C | P2 |
| PSFN-c9z2 | Focus primitives for sawtooth compression | V-C | P2 |
| PSFN-jl9r | Sleeptime memory agent | V-C | P2 |
| PSFN-jvl4 | Compression guideline evolution | V-D | P3 |
| PSFN-z3li | Post-response context scoring | V-D | P3 |

### Epic 2: Continuous Emotion System (PSFN-bu5f) — 12 tasks
| ID | Task | Phase | P |
|----|------|-------|---|
| PSFN-4bgh | NRC VAD Lexicon loader | E-A | P1 |
| PSFN-7hga | EmotionState class — VAD vector with decay and mood EMA | E-A | P1 |
| PSFN-v57y | Text emotion classifier — boltuix/bert-emotion | E-A | P1 |
| PSFN-ow78 | Emotion observer — classify, fuse, update pipeline | E-A | P1 |
| PSFN-07zq | Wire emotion state into runtime context | E-A | P1 |
| PSFN-c4se | Tag memories with VAD state at formation | E-B | P2 |
| PSFN-hrpd | Mood-congruent retrieval bias in composite scoring | E-B | P2 |
| PSFN-dk1u | Emotional intensity as factor in importance scoring | E-B | P2 |
| PSFN-iyo5 | Chain-of-Emotion LLM appraisal | E-C | P2 |
| PSFN-mhdy | Emotional persona adaptation — extend honne/tatemae | E-C | P2 |
| PSFN-xdle | SenseVoice-Small audio emotion via sherpa-onnx | E-D | P3 |
| PSFN-p3xu | Multimodal emotion fusion | E-D | P3 |

### Epic 3: Intention & Active Concern Tracking (PSFN-8e3t) — 5 tasks
| ID | Task | Phase | P |
|----|------|-------|---|
| PSFN-g8um | Post-turn action appraisal engine | E-E-A | P1 |
| PSFN-hme7 | Active concerns store — ephemeral goal tracking | E-E-A | P1 |
| PSFN-xktg | Wire intention system into agent loop and runtime | E-E-A | P1 |
| PSFN-0ybc | Emotional motivation bridge — emotion-to-action | E-E-B | P2 |
| PSFN-2xyv | Behavioral pattern learning — response strategy feedback | E-E-C | P2 |

### Epic 4: Integrated Self-Model (PSFN-be11) — 4 tasks
| ID | Task | Phase | P |
|----|------|-------|---|
| PSFN-vlmy | Unified InternalState type — integrated state snapshot | E-F-A | P1 |
| PSFN-b1do | Wire self-model into agent loop, appraisal, and context | E-F-A | P1 |
| PSFN-5003 | Metacognitive monitoring — processing state detection | E-F-B | P2 |
| PSFN-33eb | Self-narrative in heartbeat reflections and values journal | E-F-C | P2 |

**Total**: 4 epics, 32 tasks, ~76,980 existing LoC + estimated 3,000-5,000 new LoC

---

## References

### Papers
- ARC: https://arxiv.org/abs/2601.12030
- Memory-R1: https://arxiv.org/abs/2508.19828
- MemAgent: https://arxiv.org/abs/2507.02259
- Focus Agent: https://arxiv.org/abs/2601.07190
- ACON: https://arxiv.org/abs/2510.00615
- CORAL: https://openreview.net/forum?id=NBGlItueYE
- AgentDiet: https://arxiv.org/abs/2509.23586
- ReSum: https://arxiv.org/abs/2509.13313
- A-MEM: https://arxiv.org/abs/2502.12110
- Context as File System: https://arxiv.org/abs/2512.05470
- Sleep-time Compute: https://arxiv.org/abs/2504.13171
- Memory in the Age of AI Agents: https://arxiv.org/abs/2512.13564
- Agentic RL Survey: https://arxiv.org/abs/2509.02547
- EmoLLMs: https://arxiv.org/abs/2401.08508
- EMO-LLaMA: https://arxiv.org/abs/2408.11424
- Emotional Intelligence: https://emotional-intelligence.github.io/
- Introspection: https://transformer-circuits.pub/2025/introspection/index.html
- Societies of Thought: https://arxiv.org/abs/2601.10825
- DAM-LLM: https://arxiv.org/abs/2510.27418
- CEmoFlow: https://arxiv.org/abs/2601.12341
- NRC VAD Lexicon v2: https://arxiv.org/abs/2503.23547
- Chain-of-Emotion: https://pmc.ncbi.nlm.nih.gov/articles/PMC11086867/

### Models
- boltuix/bert-emotion: https://huggingface.co/boltuix/bert-emotion
- SamLowe/go_emotions-onnx: https://huggingface.co/SamLowe/roberta-base-go_emotions-onnx
- SenseVoice-Small: https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- NRC VAD Lexicon: https://saifmohammad.com/WebPages/nrc-vad.html

### Production Systems
- Manus: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Anthropic: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Google ADK: https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/
- Letta Context Repos: https://www.letta.com/blog/context-repositories
- JetBrains: https://blog.jetbrains.com/research/2025/12/efficient-context-management/
- Charisma.ai: https://charisma.ai/blog/emotions-evolved-virtual-characters-emotions-engine

### Prior Art
- Purrsephone v2: prior Python/FastAPI framework
- March 2026 Audit Meta-Analysis: working_docs/psfn_march_audit_meta_analysis.md
