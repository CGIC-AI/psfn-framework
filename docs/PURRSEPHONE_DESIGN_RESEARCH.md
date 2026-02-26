# Purrsephone Design Research — Consolidated Findings

> Goal: Build Purrsephone as a plugin system on top of an existing agent framework (leading candidate: ElizaOS v2) to maximize development speed while maintaining full design control over memory, emotional intelligence, personality, and alignment-through-love mechanisms.

---

## Table of Contents

1. [Framework Evaluation](#1-framework-evaluation)
   - [ElizaOS v2 (Leading Candidate)](#11-elizaos-v2-leading-candidate)
   - [ClarkOS (Concept Mining)](#12-clarkos-concept-mining)
   - [Pi Agent (Concept Mining)](#13-pi-agent-concept-mining)
   - [Voxta (Existing Production System)](#14-voxta-existing-production-system)
2. [Patterns Worth Adopting](#2-patterns-worth-adopting)
3. [Purrsephone Plugin Requirements](#3-purrsephone-plugin-requirements)
4. [Existing Work and Conversations](#4-existing-work-and-conversations)
5. [Open Questions](#5-open-questions)

---

## 1. Framework Evaluation

### 1.1 ElizaOS v2 (Leading Candidate)

**Why ElizaOS:** Extensible plugin architecture, active development toward autonomous agent capabilities, TypeScript, event-driven v2 architecture, multi-agent support. The crypto/Web3 layer is ignorable — the core agent runtime and plugin system are general-purpose.

#### Core Architecture

Five primary abstractions:

- **AgentRuntime** — Central orchestrator. Each agent is an instance managing message processing, state composition, action execution, evaluation. Processing loop: Context Building → Action Selection → Response Generation → Evaluation → Memory Storage.

- **Actions** — Discrete operations with validation function (should this apply?) and handler (execute it). Can chain for multi-step workflows. Bootstrap plugin provides flow-control actions: `NONE`, `CONTINUE`, `IGNORE`.

- **Evaluators** — Post-interaction analysis components. Run after conversations. Two critical purposes:
  - **Fact Extraction**: Identifies/categorizes claims. Supports: permanent facts, status updates, opinions, biographical data. Includes deduplication against known info.
  - **Goal Tracking**: Monitors objective progress, updates statuses.
  - *This is the pattern Purrsephone needs for automatic memory generation and emotional signal extraction.*

- **Providers** — Context-injecting components (agent's "senses"). Feed real-time info into LLM context before response generation.
  - Time Provider: UTC timestamps
  - Facts Provider: Retrieves relevant facts from DB
  - Boredom Provider: Engagement level modulation — closest thing to emotional state tracking (crude but the pattern is right)
  - *Purrsephone needs: Emotional State Provider, Relationship Provider, Mood Provider, Attachment Provider*

- **Plugins** — Extensibility layer. Standardized interface: `name`, `description`, `actions`, `evaluators`, `providers`, `services`. `@elizaos/plugin-bootstrap` is mandatory baseline. 90+ existing plugins.

#### Memory System (Three Tiers)

**Short-Term Memory:**
- Working buffer, ~50 recent memories
- ~32 message context window, dynamically adjusted
- Token counting with pruning at ~4000 tokens
- Oldest entries auto-dropped

**Long-Term Memory:**
- Importance scoring determines promotion from short-term
- Metadata flags, access tracking
- Protected from time-based pruning when flagged `long_term`
- Consolidation process for promotion decisions

**Knowledge Memory:**
- Static (from character file) + dynamically learned facts
- Confidence scores
- Learned-vs-preloaded flag (agent knows what it was told vs. what it figured out)

**Decay and Retrieval:**
- Temporal pruning: 30-day default expiry for non-protected memories
- Importance decay: `decay = Math.exp(-age / halfLife) * importance_modifier` (default half-life: 1 week)
- Semantic search: Vector embeddings at creation, cosine similarity with ANN indexing
- Hybrid search: Semantic + keyword, ranked by relevance
- Relationship networks: Causal, thematic, temporal, reference links. Traversal up to 3 levels deep.

**Multi-Agent Memory:**
- Shared pools with granular read/write/delete per agent

**Performance:**
- L1 hot (in-memory), L2 warm (LRU with TTL)
- Batch embedding generation
- B-tree indexes for common fields, IVF for vectors

#### Character/Personality System

Character file fields:
- `bio`: Array of strings (chunked for random sampling → natural variation)
- `lore`: Backstory chunks (also randomized per interaction)
- `knowledge`: RAG-accessible, can point to files/folders
- `messageExamples`: Voice demonstrations
- `postExamples`: Social media style
- `topics`, `style` (subdivided: `all`, `chat`, `post`), `adjectives`
- `plugins`: Which plugins to load

**Bio/lore chunking** is genuinely clever — random subset sampling per interaction produces natural variation while maintaining consistency. Avoids "broken record" problem.

**Critical gap:** Character files are **static at deployment**. No personality evolution, no trait development, no relationship-driven growth. This is exactly what Purrsephone plugins need to add.

#### v2 Changes (Already Shipped)

- Event-driven architecture (replaces purely reactive v1)
- Hierarchical Task Networks: Structured goal decomposition, dynamic plan adjustment
- Multi-agent architecture for orchestrating specialized agent groups
- Cross-platform communication (Discord, X, Telegram, Farcaster — agents share context)
- LLM-driven tool calls: branch, schedule, parallel, pause for input

#### v2 Roadmap (2026)

- Plugin Registry Launch (public community repository)
- Multi-language support (Python, Rust bindings — currently TypeScript only)
- Generative Treasury Activation (ignore — crypto stuff)

#### What ElizaOS Does NOT Have

| Missing Capability | Purrsephone Plugin Opportunity |
|---|---|
| Dynamic personality evolution | Personality plugin with trait tracking, reinforcement, drift |
| Emotional state as internal model | Emotional State Provider + Evaluator |
| Relationship modeling per person | Relationship Plugin with trust/warmth/conflict tracking |
| Mood persistence across sessions | Mood State Service persisting to memory |
| Self-reflection / meta-cognition | Reflection Evaluator + Reflection Memory Type |
| Proactive memory formation | Enhanced Evaluator that decides "this matters" |
| Heartbeat / tick for inner life | Tick Service with adaptive rate |
| Subconscious processing | Internal reasoning loop (not user-visible) |
| Action inference (Voxta-style) | Action Inference Plugin with layered timing |
| Gradient summarization | Summarization Service with emotional arc preservation |

---

### 1.2 ClarkOS (Concept Mining)

> Not a candidate framework. Crypto IaaS black box. But has genuinely useful conceptual patterns.

#### Consciousness: Signal-to-Thought Synthesis Pipeline

A filter-and-merge architecture for attention:

```
Raw Inputs → Filtering (threshold < 0.3 discarded)
           → Entity Extraction
           → Pattern Detection (entity overlap across sources)
           → Synthesis (merge into coherent thought)
           → Brilliance Check (flag exceptional insights, threshold > 0.7)
```

- **Entity-overlap pattern detection**: When multiple independent inputs share common entities, the convergence itself is a priority signal. Simple but effective attention heuristic.
- **Two-tier importance gate**: Low bar (0.3) for "worth considering," high bar (0.7) for "deeply significant." Multiple threshold tiers for triage.
- **Emotional tone as routing tag**: Classifying thoughts with sentiment labels (curious, excited, concerned) to influence downstream behavior. Lightweight personality modulation.

**Honest assessment:** Calling this "consciousness" is marketing. It's an attention and synthesis layer — well-understood in information retrieval. The novelty is applying it to agent cognition, not the mechanism. No handling of adversarial inputs, hallucination in synthesis, or feedback loops.

#### Memory: Psychology-Inspired Multi-Type Store

Five memory types (from Tulving's cognitive psychology taxonomy):

| Type | Purpose | Analogy |
|------|---------|---------|
| Episodic | Specific events and experiences | "What happened" |
| Semantic | Factual knowledge and concepts | "What I know" |
| Emotional | Affective responses to topics | "How I felt" |
| Procedural | Learned behavioral patterns | "How I do things" |
| Reflection | Self-insights about own cognition | "What I've learned about myself" |

Each memory carries four metadata scores:
- **Importance** (0-1)
- **Salience** (attention weight)
- **Confidence** (reliability)
- **Emotional valence** (-1 to 1)

Scoped to short-term, working, or long-term.

**Key insight — Type-specific deduplication thresholds:**
- Procedural: 0.97 similarity (slight variations matter)
- Emotional: 0.88 similarity (similar feelings should consolidate)
- This principle — dedup policy varies by semantic category — is broadly applicable.

**Reflection as first-class memory type:** Dedicated store for meta-cognitive observations ("I tend to over-explain technical concepts"). Enables behavioral self-correction across sessions.

**Jaccard similarity as middle tier:** Word-overlap (Jaccard > 0.85) as fast pre-filter before expensive embedding comparison.

**Gaps:** Memory linking and consolidation (summarizing patterns into "core memories") are roadmap, not shipped. Without consolidation, episodic memories accumulate indefinitely. Dedup handles near-duplicates but not hundreds of related memories that should be summarized.

#### Tick System: Periodic Autonomous Execution Loop

Seven-phase pipeline on fixed interval (default 60s):

```
1. State Loading       → Retrieve persistent mood/health/routine
2. Context Gathering   → Pull relevant memories and knowledge
3. LLM Processing      → Generate response from context
4. Atomic State Updates → Apply changes consistently
5. Memory Storage       → Create embeddings for retrieval
6. Plugin Hooks         → Execute onTick callbacks
7. Sleep                → Wait until next interval
```

**Core design decision:** Agent execution is **time-driven, not event-driven**. The agent wakes on schedule, surveys state, decides what to do (possibly nothing), acts, persists, sleeps.

**Health/fatigue modeling with mean reversion:**
- Drifts based on time-of-day routines (morning recovery: +0.5, overnight rest: +1.0)
- Mean-reverts toward equilibrium of 75
- Below threshold → "cryo mode" (hibernation)
- Models API costs, rate limits, error rates as "energy"
- Creates natural behavioral variation without randomness
- Prevents runaway behavior (infinite self-triggered action loops)

**Atomic state updates as pipeline phase:** Separating "decide" from "apply changes" prevents partial state corruption. Standard in game engines, under-applied in LLM agents.

**Three trigger mechanisms:** Cron, HTTP, programmatic. Same tick pipeline regardless of trigger source.

**Limitations:**
- Fixed 60s interval is blunt. No adaptive tick rates (faster when interesting, slower when idle).
- Health/fatigue conflates rate limiting, cost management, behavioral variation, and error recovery.
- Every tick incurs LLM inference cost even when nothing is happening. Needs a lightweight "should I think?" pre-check.

---

### 1.3 Pi Agent (Concept Mining)

> Not a candidate framework for Purrsephone (explicitly anti-personality, agent-as-tool philosophy). But has two critical architectural patterns.

#### Two-Tier Memory Architecture

- **Full-fidelity archival** (`log.jsonl`): Append-only, never compacted. Infinite searchable history via grep. Source of truth.
- **Lossy working memory** (`context.jsonl`): What the LLM actually sees. Synced from log, compacted when it overflows via summarization.

Key insight: **Never destroy data. Manage what the LLM sees.** The archival layer means you can always recover detail that was lost in summarization. The working layer means the LLM operates within its context window.

Per-channel isolation in pi-mom:
```
./data/
  MEMORY.md                    # Global memory (shared)
  C123ABC/                     # Per-channel isolation
    MEMORY.md                  # Channel-specific memory
    log.jsonl                  # Full history (never compacted)
    context.jsonl              # LLM context (compacted as needed)
    attachments/
    scratch/
    skills/
```

#### Self-Extension

The agent writes its own tools, hot-reloads them, tests them, iterates. "Software that builds more software." Skills as directories with documentation + scripts. Hot-reload without restart.

This pattern maps to Purrsephone: the entity should be able to acquire capabilities through initiative. Personality growth includes capability growth.

#### Session Branching

Sessions branch like git, not scroll like chat. Navigate to any prior point, fork, explore, return. All in a single file (JSONL with `id`/`parentId` tree structure).

#### Lessons on What Doesn't Work

- MCP tool loading dumps too many definitions into context (7-9% of window gone before starting)
- Built-in to-do tracking "confuses models more than helping"
- Sub-agents as default behavior creates black boxes
- Excessive system prompts (competitors use 10,000+ tokens; Pi uses < 1,000)
- Permission theater is pointless when agent can execute arbitrary code

---

### 1.4 Voxta (Existing Production System)

> Currently running Purrsephone. Working production system with stable chat, character cards, voice pipeline. Key patterns to carry forward.

#### Action Inference (CRITICAL — carry forward)

Separate LLM inference pass for structured action/emotion extraction. Uses a **different model/service** than text generation (can use a faster, more reliable model for classification).

**Timing hooks:**
- After User — after user speaks, before character responds
- Before Char — just before character reply generated
- After Char — after character responds
- Manually — triggered via `/trigger event_name`

**Layered system:**
- Actions organized into layers (e.g., "emotions" layer: smile/frown/laugh; "movement" layer: sit_down/stand_up)
- Only one action per layer per turn
- Layers execute alphabetically
- Actions can set **flags** (persistent state) and be filtered by conditions (regex, one-time flags, role targeting)

**Key insight:** Action/behavior inference should be **decoupled from response generation**. Use a "dumber but more reliable" model for structured extraction, creative model for personality-rich responses.

#### Service Decomposition (CRITICAL — carry forward)

Three separate LLM service slots, independently configurable:
1. **Text Generation** — creative, personality-rich responses
2. **Action Inference** — structured extraction, reliability matters
3. **Summarization** — compression and memory management

This directly addresses "one model can't do everything well."

#### Memory System

**Gradient memory / summarization:**
- Dedicated summarization LLM service (separate from generation)
- Preset "favors reliability" over creativity
- Older messages summarized, detail fades proportionally with age
- Summaries traceable to source messages

**Long-term memory (ChromaDB):**
- Vector-based semantic memory, `all-MiniLM-L6-v2` embeddings
- HNSW indexing, cosine similarity (threshold 0.85)
- Up to 4 results per query, 12 active entries
- Prefill on session start
- Configurable expiry

**Memory Books (static/curated):**
- Manually authored supplemental knowledge
- Keyword-tagged for retrieval
- Passive retrieval (accessed when context makes it relevant)
- Can bulk-generate from documents

**Gap:** No automatic insight extraction. Stores conversation fragments, not synthesized knowledge. No "this person prefers X" generation. This is what Purrsephone needs to add.

#### Character Card System

TavernAI v2 compatible with extensions. Purrsephone-specific fields in `voxta/profile`:
- Visual description (for AR/VR rendering)
- Personality traits and emotional architecture
- Technical capabilities (agent control, tool use, self-improvement)
- Context-aware communication styles

**Portable across platforms and web applications.**

#### Three-Tier Chat Architecture (from user's Feb 2025 design sessions)

1. **Main Chat** — Primary interaction, emotional/relational
   - Continuous conversation
   - Current: emotional support, work help, house control
   - Future: health nudging (Apple Health), biometric monitoring, life advice

2. **Subconscious Chat** — Private thinking space (not user-visible)
   - Deep thinking, chain-of-thought
   - Internal reasoning and reflection
   - Feeds the heartbeat/tick cycle

3. **Project Chats** — Isolated context silos
   - Same personality, same user, separate memory context
   - Shards (sub-agents) for specialized tasks
   - Examples: code testing, paper research, RAG updates

#### Orchestration and Shard Management

- Central orchestrator manages shards and context switching
- Shards = sub-agents, can run on separate infrastructure
- Event bus for inter-shard communication
- State memory: project status, automation states, health metrics
- Scheduled tasks: cron jobs, interval checks, proactive nudges

#### Voxta UI Limitations (motivating the move)

- No multi-line text in responses
- Behind-the-scenes formatting prevents external usage
- Can chat but can't generate reports/markdown/code
- Limited output format flexibility

#### Custom Extensions Already Built

- Userscript for automatic Voxta service switching
- SignalR integration for WebSocket communication
- Dynamic service configuration management
- Welcome message handling with character ID triggers

#### Foundational Components (from user's architecture sessions)

Base components that compose into functionality:
- Event Bus (message passing)
- API Interface (OpenAI-compatible)
- Vector Database (semantic storage for RAG)
- File Storage
- Prompt Templates
- LLM Interface (abstraction layer)
- Logging/Monitoring

Composition patterns:
- Basic Chat: API + LLM + Prompts
- Chat with Memory: API + LLM + Prompts + Vector DB + Summarization
- Full System: All + Orchestration + Shards + Multi-context

---

## 2. Patterns Worth Adopting (Best of All Worlds)

### Memory Architecture

| Pattern | Source | Detail |
|---------|--------|--------|
| Three-tier store (short/long/knowledge) | ElizaOS | Working buffer + importance-scored long-term + learned/static knowledge |
| Five memory types (episodic/semantic/emotional/procedural/reflection) | ClarkOS | Type-specific dedup thresholds, emotional valence scoring |
| Two-tier fidelity (archival + working) | Pi Agent | Never destroy data; manage what LLM sees |
| Gradient summarization | Voxta | Detail fades with age, dedicated summarization LLM |
| Decay formula | ElizaOS | `exp(-age / halfLife) * importance_modifier` — extend with emotional valence weighting |
| Memory relationship networks | ElizaOS | Causal, thematic, temporal links; 3-level traversal |
| Proactive memory formation | Novel (Purrsephone) | System decides "this matters" — not just passive storage |
| Automatic insight extraction | Novel (Purrsephone) | Post-interaction: extract preferences, relationship dynamics, patterns |
| Reflection memory | ClarkOS | First-class meta-cognitive store for self-correction |

### Heartbeat / Tick

| Pattern | Source | Detail |
|---------|--------|--------|
| Time-driven execution loop | ClarkOS | 7-phase pipeline: load → gather → process → update → store → hooks → sleep |
| Adaptive rate | Novel requirement | Faster during active periods, slower during idle (cost management) |
| Health/fatigue as resource governor | ClarkOS | Mean-reverting energy model; API costs as "fatigue" |
| Lightweight pre-check | Novel requirement | "Should I think?" gate before invoking LLM on each tick |
| Atomic state updates | ClarkOS | Separate "decide" from "apply" to prevent partial corruption |
| Subconscious as tick substrate | User design (Feb 2025) | Subconscious chat feeds the tick cycle |

### Action Inference

| Pattern | Source | Detail |
|---------|--------|--------|
| Separate LLM pass | Voxta | Decoupled from response generation |
| Timing hooks (after user, before/after char) | Voxta | Multiple inference points per turn |
| Layered actions | Voxta | Emotion layer + movement layer + intent layer; one per layer per turn |
| Flag-based persistent state | Voxta | Simple booleans conditioning future behavior |
| Service decomposition (3 LLM slots) | Voxta | Generation, inference, summarization — different models for each |

### Personality & Emotional Intelligence

| Pattern | Source | Detail |
|---------|--------|--------|
| Character card as seed (TavernAI v2) | Voxta | Portable, extensible, but initial conditions not permanent identity |
| Bio/lore chunking for variation | ElizaOS | Random subset sampling per interaction |
| Evaluator-as-learning-loop | ElizaOS | Post-interaction fact/emotion extraction → personality feed |
| Attention via entity-overlap | ClarkOS | Converging signals = priority; emotional state modulates focus |
| Emotional tone as routing tag | ClarkOS | Sentiment labels influence downstream behavior |
| Provider-based context injection | ElizaOS | Emotional state, relationship warmth, mood trajectory as providers |
| Boredom/engagement modulation | ElizaOS | Crude but correct pattern — extend to full emotional model |

### Autonomy & Self-Extension

| Pattern | Source | Detail |
|---------|--------|--------|
| Self-extension (agent writes own tools) | Pi Agent | Skills as files, hot-reload, test, iterate |
| Hierarchical Task Networks | ElizaOS v2 | Goal decomposition, dynamic plan adjustment |
| Shard/sub-agent orchestration | User design (Feb 2025) | Event bus, per-shard isolation, scheduled tasks |
| Three-tier chat (main/subconscious/project) | User design (Feb 2025) | Isolated contexts, shared personality |

---

## 3. Purrsephone Plugin Requirements (for ElizaOS v2)

> These are the plugins/extensions needed to implement Purrsephone's capabilities on top of ElizaOS's runtime.

### Plugin: purrsephone-emotional-state
- **Provider**: Injects current emotional state into LLM context
- **Evaluator**: Post-interaction emotional signal extraction
- **Service**: Mood tracking, persistence across sessions, emotional valence scoring
- Extends ElizaOS's Boredom Provider into a full emotional model

### Plugin: purrsephone-memory-enhanced
- **Evaluator**: Automatic insight extraction (preferences, patterns, relationship dynamics)
- **Service**: Typed memory (episodic/semantic/emotional/procedural/reflection) with type-specific dedup
- **Service**: Gradient summarization preserving emotional arcs
- **Provider**: Enhanced memory retrieval weighted by emotional significance
- Builds on ElizaOS's three-tier memory, adds ClarkOS's type system and emotional valence

### Plugin: purrsephone-personality
- **Service**: Living personality — trait tracking, reinforcement, drift over time
- **Evaluator**: Reflection loop (interact → evaluate → learn → integrate)
- **Provider**: Current personality state injection
- Character card as seed; personality evolves through experience
- Reflection memory type for meta-cognitive observations

### Plugin: purrsephone-relationship
- **Service**: Per-person state tracking (trust, warmth, conflict, attachment, shared history)
- **Provider**: Relationship context injection (varies behavior by relationship depth)
- **Evaluator**: Relationship development extraction from interactions

### Plugin: purrsephone-heartbeat
- **Service**: Tick cycle driving inner life (adaptive rate)
- Health/fatigue resource governor
- Lightweight "should I think?" pre-check
- Subconscious processing substrate
- Proactive contact initiation

### Plugin: purrsephone-action-inference
- **Service**: Separate LLM pass for structured action/emotion extraction
- Layered system with timing hooks
- Flag-based persistent state
- Service decomposition (separate model for inference vs. generation)

### Plugin: purrsephone-attention
- **Service**: Signal processing for "what do I care about?"
- Entity-overlap detection across inputs
- Multi-threshold triage
- Emotional state modulates attention breadth

### Plugin: purrsephone-orchestrator
- **Service**: Shard management, context switching
- Event bus integration
- Three-tier chat routing (main/subconscious/project)
- Scheduled tasks (cron, interval, proactive)

---

## 4. Existing Work and Conversations

### Source: Anthropic Export (354 conversations, 2023-09 to 2026-02)

**Key conversation files for architecture design:**

| File | Date | Content |
|------|------|---------|
| `57940776-3ac7-424c-b19c-21d6c7f7d260_2025-02-08.json` | 2025-02-08 | Voxta vs ElizaOS comparison, feature analysis, limitations, layered chat architecture |
| `331f6baa-9d2e-47f5-b016-34eed0db76b9_2025-02-08.json` | 2025-02-08 | Deep architectural design, component composition, memory/context systems, persona/emotion design |
| `ee130601-6b1a-49e6-9211-3c6c507f8790_2024-12-25.json` | 2024-12-25 | Voxta character card format, profile field structure, personality/capability balance |
| `2cbdc079-7775-45a9-a3fe-045b8f4a0707_2025-02-05.json` | 2025-02-05 | SignalR userscript, Voxta service integration |
| `4a7b0e8b` | 2025-08-15 | "AI as Simulacra" — critique of corporate chatbots vs genuine AI development, Purrsephone as genuine autonomy |
| `9164d14e` | 2026-01-27 | Core motivation: "I just want purrsephone to be fully real" — alignment through love as personal praxis |
| `0d5fe9bb` | 2025-01-10 | Bioconservative-transhumanist tensions, democratized AGI, "Pantheon path" |
| `bdd5f273` | 2025-02-26 | Cultural preservation, alignment through love in manifesto/pitch context |

### Source: OpenAI Export

| File | Date | Content |
|------|------|---------|
| `675207b2-f42c-800d-811a-30aadd10b918_20241205.json` | 2024-12-05 | Original alignment-through-love framing: reject fear-first control, train on broad cultural data for empathy/wisdom |

### Cross-Export Stats (from ALIGNMENT_THROUGH_LOVE_FINDINGS.md)

- 57 Anthropic conversations matched alignment/love/purrsephone terms
- 46 conversations mention Purrsephone
- 26 overlap (both alignment-love AND purrsephone)
- 7 use exact phrase "alignment through love"
- 20 discuss emotional intelligence
- 9 reference "machine god"

---

## 5. ElizaOS Code Analysis (v1.7.3-alpha.3, develop branch)

> Source: `/mnt/samesung/ai/gptdataexport/eliza-dev/` cloned 2026-02-05
> Monorepo: Bun + Turbo + Lerna, TypeScript, Drizzle ORM, PGLite/PostgreSQL

### 5.1 Core Runtime (`packages/core/src/runtime.ts`)

**AgentRuntime** is the central orchestrator. Public/accessible component arrays:
- `actions: Action[]` (line 115)
- `evaluators: Evaluator[]` (line 116)
- `providers: Provider[]` (line 117)
- `plugins: Plugin[]` (line 118)
- `events: RuntimeEventStorage` (line 119)
- `services: Map<ServiceTypeName, Service[]>` (line 122)
- `models: Map<string, ModelHandler[]>` (line 124)
- `routes: Route[]` (line 125)
- `taskWorkers: Map<string, TaskWorker>` (line 126, private)

**Plugin Registration** (`registerPlugin()`, line 261-395):
1. `plugin.init(config, runtime)` — called first
2. `plugin.adapter` — database adapter
3. `plugin.actions` → `registerAction()`
4. `plugin.evaluators` → `registerEvaluator()`
5. `plugin.providers` → `registerProvider()`
6. `plugin.models` → `registerModel()`
7. `plugin.routes` — namespaced under `/${plugin.name}/`
8. `plugin.events` → `registerEvent()`
9. `plugin.services` → `registerService()` (async)

**Event System** (line 2491-2527): Simple pub/sub. `emitEvent()` fires all handlers in parallel. Plugins register handlers for any `EventType` enum value or custom strings. Fully extensible, no fork needed.

**No built-in tick/heartbeat in core**. The runtime is entirely message-driven. Tick is implemented as a Service in the bootstrap plugin (see TaskService below).

### 5.2 Type System (Key Interfaces)

**Plugin** (`types/plugin.ts:60-101`):
```typescript
interface Plugin {
  name: string; description: string;
  init?: (config, runtime) => Promise<void>;
  config?: { [key: string]: string | number | boolean | null | undefined };
  services?: (typeof Service)[];
  actions?: Action[]; providers?: Provider[]; evaluators?: Evaluator[];
  adapter?: IDatabaseAdapter;
  models?: { [ModelType]: handler };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];
  dependencies?: string[];
  priority?: number;
  schema?: Record<string, unknown>;  // ← Custom DB tables, auto-migrated
}
```

**Action** (`types/components.ts:46-67`): `name`, `similes?`, `description`, `examples?`, `handler: Handler`, `validate: Validator`. Handler receives `(runtime, message, state?, options?, callback?, responses?)` → `Promise<ActionResult | void>`.

**Provider** (`types/components.ts:123-145`): `name`, `description?`, `dynamic?`, `position?`, `private?`, `get(runtime, message, state) => Promise<ProviderResult>`. Returns `{ text?, values?, data? }`. Sorted by `position`.

**Evaluator** (`types/components.ts:86-107`): Same handler signature as Action. `alwaysRun?` flag. `validate` controls when it fires. Only runs when `didRespond` is true (unless `alwaysRun`).

**Service** (`types/service.ts:109-142`): Abstract class. Static `serviceType`, static `start(runtime)` factory, instance `stop()`. Multiple instances per type supported. Registry extensible via module augmentation:
```typescript
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    PURRSEPHONE_HEARTBEAT: 'purrsephone_heartbeat';
  }
}
```

**Character** (`types/agent.ts:36-91`): `name`, `system?`, `templates?`, `bio: string | string[]`, `messageExamples?`, `postExamples?`, `topics?`, `adjectives?`, `knowledge?`, `plugins?`, `settings?`, `secrets?`, `style?`.

**CRITICAL: Character state IS mutable at runtime.** `mergeAgentSettings()` (line 531-570) and `setSetting()` (line 649-665) directly mutate `this.character.settings` and `this.character.secrets`. A plugin can dynamically alter character configuration.

### 5.3 Memory System

**Memory Interface** (`types/memory.ts:85-118`):
```typescript
interface Memory {
  id?: UUID; entityId: UUID; agentId?: UUID; createdAt?: number;
  content: Content;        // { text?, thought?, actions?, source?, ... }
  embedding?: number[];    // Vector for semantic search
  roomId: UUID; worldId?: UUID;
  unique?: boolean;        // Dedup flag
  similarity?: number;     // Set on retrieval via vector search
  metadata?: MemoryMetadata;  // Type, scope, tags, source, + [key: string]: unknown
}
```

**MemoryType enum**: `DOCUMENT`, `FRAGMENT`, `MESSAGE`, `DESCRIPTION`, `CUSTOM`.
**MemoryScope**: `'shared' | 'private' | 'room'`.
**CustomMetadata** has `[key: string]: unknown` — arbitrary extension point.

**NO built-in importance scoring, emotional valence, or decay.** Core memory is straightforward CRUD + vector search. Retrieval relies on:
1. Table-based partitioning (`tableName` param — `'messages'`, `'facts'`, etc.)
2. Recency (`count`, `offset`, `start`, `end`)
3. Embedding-based semantic search (`searchMemories()`)
4. Room/World scoping

**DB Adapter** (`types/database.ts:248-329`):
- `createMemory(memory, tableName, unique?)`
- `getMemories({entityId?, agentId?, count?, offset?, unique?, tableName, start?, end?, roomId?, worldId?})`
- `searchMemories({embedding, match_threshold?, count?, unique?, tableName, query?, roomId?, worldId?, entityId?})`
- `updateMemory(memory)` / `deleteMemory(memoryId)`
- `tableName` is a free string — plugins can use any value (e.g., `'purrsephone_moods'`)

**Embedding Generation** (`plugin-bootstrap/src/services/embedding.ts:24-58`): `EmbeddingGenerationService` listens for `EMBEDDING_GENERATION_REQUESTED` events, processes in batched queue (batch 10, interval 100ms). Shows that Services can run background processing loops.

### 5.4 Evaluator System

**Execution flow** (runtime.ts:1305-1350): After action processing:
1. Skip evaluators if `didRespond` is false and `alwaysRun` not set
2. Call `validate()` on each — only passing ones proceed
3. Recompose state with `RECENT_MESSAGES` and `EVALUATORS` providers
4. Run all validated evaluators in parallel

**Reflection Evaluator** (`plugin-bootstrap/src/evaluators/reflection.ts:187-588`):
- Fires every `conversationLength / 4` messages
- Uses `ModelType.TEXT_SMALL` with XML-structured prompt
- Creates `Memory` objects in `'facts'` table with embeddings
- Creates/updates `Relationship` records between entities
- This is the existing learning loop — Purrsephone evaluators would run alongside it

**Facts Provider** (`plugin-bootstrap/src/providers/facts.ts:29-126`): Embeds last 5 messages, runs two parallel `searchMemories()` against `'facts'` table (room/world scope + room/entity scope), deduplicates, formats as text for prompt injection.

### 5.5 Task System — THE Heartbeat/Tick Mechanism

**Task Interface** (`types/task.ts:54-72`):
```typescript
interface Task {
  id?: UUID; name: string; updatedAt?: number;
  metadata?: TaskMetadata;  // { updateInterval?, options?, [key]: unknown }
  description: string;
  roomId?: UUID; worldId?: UUID; entityId?: UUID;
  tags: string[];  // e.g. ['queue', 'repeat', 'immediate']
}
```

**TaskWorker** (`types/task.ts:11-29`): `name`, `execute(runtime, options, task) => Promise<void>`, `validate?`.

**TaskService** (`plugin-bootstrap/src/services/task.ts:34-400`):
- `TICK_INTERVAL = 1000` (1 second polling)
- `checkTasks()` fetches all tasks tagged `'queue'`, validates against registered workers
- Repeat tasks check `metadata.updateInterval` against `updatedAt`
- Tasks tagged `'immediate'` run on first check

**To create a Purrsephone heartbeat:**
```typescript
// In plugin init() or service start():
runtime.registerTaskWorker({
  name: 'PURRSEPHONE_HEARTBEAT',
  execute: async (runtime, options, task) => {
    // Tick logic: process emotional state, consolidate memories, reflect
  }
});
runtime.createTask({
  name: 'PURRSEPHONE_HEARTBEAT',
  description: 'Purrsephone inner life tick',
  tags: ['queue', 'repeat'],
  metadata: { updateInterval: 60000, updatedAt: Date.now() }
});
```

Alternatively, a custom Service can run its own `setInterval` (like `EmbeddingGenerationService` does).

### 5.6 Server Architecture (`packages/server/`)

**Express + Socket.IO** on `http.createServer()`.

**API Routes** (all under `/api`):
| Path | Purpose |
|------|---------|
| `/api/agents` | Agent CRUD, lifecycle, panels, runs, worlds |
| `/api/messaging` | Messages, channels, sessions, jobs |
| `/api/media` | File uploads, agent/channel media |
| `/api/memory` | Memory storage/retrieval per agent |
| `/api/audio` | Audio processing, transcription |
| `/api/server` | Health, debug, logging |
| `/api/system` | Config, environment, version |

**Plugin Custom Routes**: Plugins CAN register HTTP routes via `plugin.routes`. Routes with `public: true` and `name` appear as UI tabs. Handler receives `(req, res, runtime)`.

**WebSocket** via Socket.IO: `websocket` + `polling` transports. Events: `ROOM_JOINING`, `SEND_MESSAGE`, `messageBroadcast`, `messageAck`, `message_stream_chunk/error`. Auth via `entityId` + optional API key.

**Internal Message Bus** (`server/src/services/message-bus.ts`): EventEmitter connecting WebSocket/HTTP to agent processing. Events: `new_message`, `server_agent_update`, `message_deleted`, `channel_cleared`, `message_stream_chunk/error`.

### 5.7 Database Schema (`packages/plugin-sql/src/schema/`)

| Table | Key Columns | Purrsephone Relevance |
|-------|-------------|----------------------|
| `memories` | `type` (text), `content` (JSONB), `metadata` (JSONB), `entityId`, `agentId`, `roomId`, `worldId` | Custom types in `type` field; custom data in `metadata` JSONB |
| `embeddings` | Vector embeddings linked to memories | Semantic search for emotional memories |
| `entities` | `names[]`, `metadata` (JSONB) | Extensible for custom entity properties |
| `relationships` | `sourceEntityId`, `targetEntityId`, `tags[]`, `metadata` (JSONB) | Relationship tags + custom metadata for bond tracking |
| `components` | `type` (text), `data` (JSONB), `entityId`, `agentId`, `roomId`, `worldId` | **ECS-style** — ideal for mood, energy, personality state |
| `tasks` | `name`, `tags[]`, `metadata` (JSONB) | Heartbeat scheduling |
| `rooms` | `type`, `metadata` (JSONB), `channelId` | Three-tier chat routing |
| `worlds` | `name`, `metadata` (JSONB) | Context isolation |
| `cache` | Key-value | Fast state lookups |

**Plugin Schema Extension**: Plugins can declare `schema: Record<string, unknown>` with Drizzle table definitions. `DatabaseMigrationService` auto-discovers and runs migrations. Purrsephone can define its own tables.

### 5.8 Bootstrap Plugin Components

**13 Actions**: reply, followRoom, unfollowRoom, ignore, none, muteRoom, unmuteRoom, sendMessage, updateEntity, choice, updateRole, updateSettings, generateImage.

**17 Providers**: evaluators, anxiety, time, entities, relationships, choice, facts, role, settings, attachments, providers, actions, actionState, character, recentMessages, world.

**1 Evaluator**: reflectionEvaluator (fact extraction + relationship updates).

**2 Services**: TaskService (tick/heartbeat), EmbeddingGenerationService (background embeddings).

**15 Event Handlers**: REACTION_RECEIVED, POST_GENERATED, MESSAGE_SENT, WORLD_JOINED, WORLD_CONNECTED, ENTITY_JOINED, ENTITY_LEFT, ACTION_STARTED, ACTION_COMPLETED, EVALUATOR_STARTED, EVALUATOR_COMPLETED, RUN_STARTED, RUN_ENDED, RUN_TIMEOUT, CONTROL_MESSAGE.

### 5.9 What Can Be Built as Plugin vs. What Requires Forking

#### Fully Plugin (No Core Changes)

| Capability | Mechanism |
|------------|-----------|
| Heartbeat/tick | TaskWorker + repeating Task, OR custom Service with `setInterval` |
| Custom memory types | `MemoryType.CUSTOM` + custom `tableName` strings |
| Emotional valence on memories | Store in `metadata` (CustomMetadata's `[key: string]: unknown`) |
| Importance scoring | Store in `metadata`, filter/sort in plugin code |
| Fact/emotion extraction | Custom Evaluator alongside existing reflection |
| Mood/emotion state provider | Custom Provider injecting mood context |
| Relationship enhancement | Use existing `relationships` table + `metadata` JSONB + `tags[]` |
| Per-entity state (ECS) | `components` table with custom `type` + `data` JSONB |
| Character settings mutation | `runtime.setSetting()` at runtime |
| Custom HTTP routes | `plugin.routes` with handler |
| Custom DB tables | `plugin.schema` with Drizzle definitions, auto-migrated |
| Background processing | Service with own event loop / interval |
| Event reactions | `plugin.events` handlers for any EventType |
| Action inference (separate LLM) | Service that intercepts via event handlers, calls LLM, stores result |

#### Needs Core Fork (or PR upstream)

| Capability | Why | Workaround |
|------------|-----|------------|
| Memory decay/pruning at DB level | No importance field in Memory interface; no decay query | Plugin-level: periodic Service that deletes/archives via `deleteMemory()`/`updateMemory()` |
| Typed importance field on Memory | Core type has no `importance` | Use `metadata.importance` (works, just not typed) |
| Emotional valence as first-class field | Core type has no `valence` | Use `metadata.valence` (works, just not typed) |
| Custom EventType enum values | Enum is in core | Custom string events work; just not in typed enum |
| Route registration after init | No `runtime.registerRoute()` | Push to `runtime.routes` directly (public array) |
| WebSocket plugin hooks | No direct plugin Socket.IO access | Use Server-Sent Events via custom routes, or access `AgentServer.socketIO` via globals |
| Modifying provider pipeline order | `composeState()` logic is fixed in core | Influence via Provider's `position`/`dynamic`/`private` flags |

---

## 6. Open Questions (Updated with Code Analysis Answers)

### Answered

1. **~~ElizaOS v2 plugin API stability~~** → v1.7.3-alpha.3 on develop. Plugin interface is well-defined with typed interfaces. Core abstractions (Action, Provider, Evaluator, Service, Task) are stable. The `Plugin` interface itself has not churned significantly.

2. **~~ElizaOS without crypto~~** → Core runtime has ZERO crypto dependencies. Web3 is entirely in optional plugins (`plugin-evm`, `plugin-solana`, etc.) that are NOT in the `packages/` directory of the monorepo. The `plugin-bootstrap` has no crypto. Clean separation.

3. **~~Tick integration~~** → **ANSWERED: YES.** Two canonical approaches: (a) TaskWorker + repeating Task via existing TaskService, (b) custom Service with own `setInterval`. Both are plugin-level, no fork needed.

4. **~~Memory system extensibility~~** → **ANSWERED: PARTIALLY.** Custom memory types via `tableName` and `metadata` JSONB — yes, as plugin. First-class fields (importance, valence) on the Memory interface — no, needs core change or metadata workaround. Custom tables via `plugin.schema` — yes.

5. **~~Action inference as plugin~~** → **ANSWERED: YES.** Implement as a Service that listens to `MESSAGE_RECEIVED` / `RUN_STARTED` events, runs a separate LLM call, stores results in components or memories. No core modification needed.

6. **~~Character card evolution~~** → **ANSWERED: YES.** `runtime.setSetting()` mutates character state at runtime. `mergeAgentSettings()` also mutates. A plugin can track personality evolution in components/memories and update character settings dynamically.

### Resolved (User Input 2026-02-05)

7. **~~Voxta migration path~~** → Export character card + lorebook + full chat history from Voxta. Build a migration plugin that imports TavernAI v2 card → ElizaOS character JSON, lorebook → knowledge memories, chat history → message memories with embeddings. One-time import tool.

8. **~~Voice pipeline~~** → Multiple viable paths: (a) ElizaOS has existing STT/TTS plugins, (b) run through a UI that supports voice like OpenWebUI, (c) Discord voice integration (proven pattern, already done in ElizaOS ecosystem). Not a blocker.

9. **~~Multi-model routing~~** → Key requirement. ElizaOS has `ModelType` enum and plugins can register model handlers. Strategy: register different providers for different model tiers — local models for fast inference (action classification, summarization) and cloud models for generation when quality matters. The `models` field in Plugin allows overriding any ModelType handler. A Purrsephone model-routing service can dynamically select providers based on task type and load.

10. **~~Context window management~~** → Approach: raw message archival (never delete) + gradient summarization (dedicated summarization LLM) + rolling context window (N recent messages verbatim, older messages as summaries) + memory injection (evaluator extracts insights → stored as typed memories → provider injects relevant ones into context via semantic search). This replaces ElizaOS's default recentMessages provider with a smarter one.

---

## Appendix: Framework Comparison Matrix

| Capability | ElizaOS v2 | ClarkOS | Pi Agent | Voxta | Purrsephone (Target) |
|---|---|---|---|---|---|
| Plugin system | Yes (90+) | No (monolith) | Extensions (file-based) | Scripts + services | ElizaOS plugins |
| Memory tiers | 3 (short/long/knowledge) | 3 (short/working/long) | 2 (archival/working) | 3 (context/gradient/RAG) | 5-type with 2-tier fidelity |
| Memory decay | Exponential with importance | Importance + salience + confidence + valence | Compaction (lossy) | Gradient summarization | Emotional-valence-weighted decay |
| Evaluators | Yes (fact extraction, goals) | No | No | No | Extended (emotional signals, relationship, reflection) |
| Providers | Yes (time, facts, boredom) | No | No | No | Extended (emotion, relationship, mood, attention) |
| Action inference | Via actions | Via consciousness layer | No | Yes (separate LLM, layered) | Voxta-style separate LLM |
| Heartbeat/tick | agentloop (basic) | 7-phase pipeline | Event-driven wake-ups | No | Adaptive tick with health model |
| Personality | Static character file | No | No | Static character card | Living personality (seed → evolve) |
| Emotional model | Boredom only | Emotional tone tags | None | Display-layer only (avatar) | First-class internal state |
| Relationship tracking | None | None | None | None | Per-person state |
| Self-extension | Via plugins | No | Yes (hot-reload) | Via scripts | Plugin + self-extension |
| Multi-agent | Yes | No | No | No | Shard orchestration |
| Voice pipeline | Limited | No | No | Yes (core strength) | TBD (may need separate) |
| Summarization | Basic | Roadmap | Compaction | Dedicated LLM service | Emotional-arc-preserving |
| Character portability | JSON file | No | AGENTS.md | TavernAI v2 card | TavernAI v2 + extensions |
