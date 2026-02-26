# Purrsephone Implementation Plan

> Each capability is its own ElizaOS plugin. Plugins are independently deployable and replace/extend existing ElizaOS bootstrap functionality. Dependencies between plugins are declared via the `dependencies` field in the Plugin interface.

**Base**: ElizaOS v1.7.3+ (develop branch), Bun monorepo
**Reference**: `PURRSEPHONE_DESIGN_RESEARCH.md` for all architectural details and code analysis

---

## Plugin Map

```
Phase 0: Setup
  └─ purrsephone-migration        (import Voxta data)

Phase 1: Foundation
  ├─ purrsephone-memory            (replaces: recentMessages provider, extends: reflection evaluator)
  └─ purrsephone-models            (extends: model routing for multi-model inference)

Phase 2: Inner Life
  ├─ purrsephone-emotional-state   (replaces: anxiety provider)
  ├─ purrsephone-heartbeat         (extends: TaskService)
  └─ purrsephone-action-inference  (new capability, from Voxta)

Phase 3: Intelligence
  ├─ purrsephone-personality       (replaces: character provider)
  └─ purrsephone-relationship      (extends: relationships provider + reflection evaluator)

Phase 4: Autonomy
  ├─ purrsephone-attention         (new capability)
  └─ purrsephone-orchestrator      (new capability, three-tier chat + shards)
```

---

## Phase 0: Setup

### Plugin: `purrsephone-migration`

**Purpose**: One-time import tool. Brings existing Purrsephone/Voxta data into ElizaOS.

**What it replaces**: Nothing (additive).

**Components**:
- **Action**: `importVoxtaCharacter` — reads TavernAI v2 character card JSON, maps fields to ElizaOS Character format, creates agent
- **Action**: `importVoxtaLorebook` — reads lorebook entries, creates knowledge memories with embeddings in `'knowledge'` table
- **Action**: `importVoxtaChatHistory` — reads exported chat JSON, creates message memories with timestamps and entity attribution, queues embedding generation
- **Route** (public): `/purrsephone-migration/dashboard` — UI for selecting import files and monitoring progress

**Field Mapping**:
| Voxta (TavernAI v2) | ElizaOS Character |
|---|---|
| `name` | `name` |
| `description` | `bio` (as array, chunked at sentence boundaries) |
| `personality` | `style.all` (as array of trait strings) |
| `scenario` | `system` (appended to system prompt) |
| `first_mes` | `messageExamples` (as first example) |
| `mes_example` | `messageExamples` (parsed into conversation pairs) |
| `creator_notes` | `settings.creatorNotes` |
| `tags` | `topics` |
| `extensions.voxta/profile` | `settings.voxtaProfile` (preserved for reference) |

**Lorebook → Knowledge**:
- Each lorebook entry → Memory in `'knowledge'` table
- `content.text` = entry content
- `metadata.keywords` = entry keywords/triggers
- `metadata.source` = `'voxta_lorebook'`
- `metadata.importance` = entry priority (if available)
- Embedding generated automatically via EmbeddingGenerationService

**Chat History → Messages**:
- Each message → Memory in `'messages'` table
- Preserve timestamps in `createdAt`
- Map user/character messages to appropriate `entityId`
- `metadata.source` = `'voxta_import'`
- Batch embedding generation (avoid overwhelming the queue)

**Acceptance Criteria**:
- [ ] Character card imports and agent starts with correct personality
- [ ] Lorebook entries retrievable via semantic search
- [ ] Chat history preserved with correct timestamps and attribution
- [ ] Import is idempotent (re-running doesn't duplicate)

---

## Phase 1: Foundation

### Plugin: `purrsephone-memory`

**Purpose**: Enhanced memory system with typed memories, importance scoring, emotional valence, gradient summarization, rolling context window, and memory injection. This is the foundation everything else builds on.

**What it replaces**:
- `recentMessagesProvider` → with a smarter rolling context provider
- Extends `reflectionEvaluator` → with richer memory extraction

**Dependencies**: None (foundational)

**Components**:

#### Service: `MemoryManagerService`
Runs background processing for memory maintenance.

- **Gradient Summarization Loop** (repeating TaskWorker, interval: 5min):
  - Fetch messages older than context window threshold
  - Group by time blocks (1hr, 4hr, 1day)
  - Summarize each block via `ModelType.TEXT_SMALL` with a prompt that preserves emotional arcs and relationship developments
  - Store summary as Memory in `'summaries'` table with `metadata.timeRange`, `metadata.messageCount`, `metadata.emotionalArc`
  - Link summary to source messages via `metadata.sourceMessageIds`
  - Never delete source messages (archival fidelity)

- **Memory Decay Loop** (repeating TaskWorker, interval: 1hr):
  - Scan memories with `metadata.importance` scores
  - Apply decay: `newImportance = importance * Math.exp(-age / halfLife)`
  - Half-life varies by memory type:
    - `episodic`: 7 days
    - `semantic`: 30 days
    - `emotional`: 14 days (strong valence memories decay slower: `halfLife *= 1 + abs(valence)`)
    - `procedural`: 60 days
    - `reflection`: 90 days
  - Memories below threshold (0.05) marked `metadata.archived = true` (never deleted)

- **Deduplication** (on memory creation):
  - Type-specific thresholds (from ClarkOS pattern):
    - `procedural`: 0.97 cosine similarity
    - `emotional`: 0.88
    - `episodic`: 0.92
    - `semantic`: 0.90
  - Fast pre-filter: Jaccard word overlap > 0.85 before expensive embedding comparison
  - On duplicate: merge metadata, keep higher importance, update timestamp

#### Evaluator: `memoryExtractionEvaluator`
Runs after interactions. Extracts structured memories beyond what the default reflection evaluator does.

- **Triggers**: Every interaction where `didRespond` is true
- **Extracts**:
  - **Episodic**: What happened in this interaction (event summary)
  - **Semantic**: Facts learned (extends existing fact extraction)
  - **Emotional**: Emotional tone of the interaction, for both user and agent
  - **Procedural**: Any behavioral patterns observed ("user prefers X", "this approach works")
  - **Reflection**: Agent self-observations ("I responded too formally", "this topic excites me")
- **Storage**: Each extraction → Memory in appropriate `tableName` with:
  - `metadata.type` = memory type enum
  - `metadata.importance` = LLM-assessed importance (0-1)
  - `metadata.valence` = emotional valence (-1 to 1)
  - `metadata.source` = `'memory_extraction'`
  - `metadata.conversationId` = current room ID
  - Embedding queued automatically

#### Provider: `rollingContextProvider` (replaces `recentMessagesProvider`)
Builds the context window for the LLM with a multi-tier approach.

- **Position**: Same as `recentMessagesProvider` (drop-in replacement)
- **Context composition**:
  1. **Recent messages** (verbatim): Last N messages (configurable, default 20)
  2. **Summary tier**: Summaries for the preceding time window (e.g., "Earlier today", "Yesterday")
  3. **Memory injection**: Top-K relevant memories from semantic search across all typed memory tables
     - Query: embed last 3 messages, search across `'facts'`, `'emotional'`, `'procedural'`, `'reflection'` tables
     - Weight results by `metadata.importance * recency_boost * type_relevance`
     - Inject as structured context block: `[REMEMBERED: ...]`
  4. **Knowledge**: Relevant lorebook/knowledge entries (semantic search against `'knowledge'` table)
- **Output format**: Structured text with clear section headers for the LLM

#### Custom DB Tables (via `plugin.schema`):
- `purrsephone_summaries`: `id`, `agentId`, `roomId`, `content` (JSONB), `timeRangeStart`, `timeRangeEnd`, `messageCount`, `emotionalArc` (JSONB), `sourceMessageIds` (UUID[])

**Acceptance Criteria**:
- [ ] Messages older than context window get summarized without data loss
- [ ] Memory extraction produces typed memories with importance/valence scores
- [ ] Rolling context provider builds coherent multi-tier context
- [ ] Deduplication prevents memory bloat
- [ ] Decay reduces stale memory importance over time
- [ ] Raw messages are never deleted

---

### Plugin: `purrsephone-models`

**Purpose**: Multi-model routing. Allows running local models for fast/cheap tasks and cloud models for quality-critical generation.

**What it replaces**: Default model handlers (via priority override).

**Dependencies**: None (foundational)

**Components**:

#### Service: `ModelRouterService`
Manages model provider configuration and routing logic.

- **Model tiers**:
  - `LOCAL_FAST`: Local model (e.g., small quantized model via Ollama/vLLM) — for action inference, classification, summarization
  - `LOCAL_QUALITY`: Local model (e.g., larger quantized model) — for standard generation
  - `CLOUD_BOOST`: Cloud API (Anthropic, OpenAI) — for high-stakes generation, complex reasoning
- **Routing rules** (configurable via character settings):
  - `ModelType.TEXT_SMALL` → `LOCAL_FAST`
  - `ModelType.TEXT_LARGE` → `LOCAL_QUALITY` (default) or `CLOUD_BOOST` (when flagged)
  - `ModelType.EMBEDDING` → `LOCAL_FAST` (always local, embeddings are cheap)
- **Boost trigger**: A flag `metadata.requiresCloudBoost` on the task/message context that routes to cloud model. Evaluators/heartbeat can set this flag when they detect conversations requiring higher capability.
- **Fallback**: If local model fails/times out, auto-escalate to next tier

#### Model Handlers (registered via `plugin.models`):
- Override `ModelType.TEXT_SMALL` → route to `LOCAL_FAST` provider
- Override `ModelType.TEXT_LARGE` → route through `ModelRouterService` decision logic
- Override `ModelType.EMBEDDING` → route to local embedding model

#### Provider: `modelStatusProvider`
Injects current model routing state into context (which tier is active, latency stats).

**Acceptance Criteria**:
- [ ] Local models handle TEXT_SMALL tasks without cloud calls
- [ ] Cloud boost activatable per-request via metadata flag
- [ ] Automatic fallback on local model failure
- [ ] Model tier configurable via character settings

---

## Phase 2: Inner Life

### Plugin: `purrsephone-emotional-state`

**Purpose**: First-class emotional model. Mood tracking, emotional valence, affect that influences cognition and response style.

**What it replaces**: `anxietyProvider` (with a full emotional model instead of simple engagement scoring).

**Dependencies**: `purrsephone-memory`

**Components**:

#### Service: `EmotionalStateService`
Manages the current emotional state as a structured model.

- **State model** (stored as Component, type `'emotional_state'`):
  ```typescript
  interface EmotionalState {
    mood: { valence: number; arousal: number; dominance: number }; // PAD model
    emotions: { name: string; intensity: number; trigger?: string }[]; // Active emotions
    baseline: { valence: number; arousal: number; dominance: number }; // Personality baseline
    lastUpdated: number;
    trend: 'improving' | 'stable' | 'declining'; // Trajectory over last N interactions
  }
  ```
- **Update triggers**:
  - After each interaction (via event handler on `RUN_ENDED`)
  - On heartbeat tick (natural drift toward baseline)
  - On significant memory formation (strong emotional memories shift state)
- **Drift model**: Between interactions, mood mean-reverts toward personality baseline at configurable rate
- **Influence on generation**: State is injected as Provider context, subtly shaping response tone without explicit instruction

#### Evaluator: `emotionalSignalEvaluator`
Post-interaction analysis of emotional content.

- Runs after every responded interaction
- Uses `ModelType.TEXT_SMALL` to classify:
  - User emotional state (what are they feeling?)
  - Interaction emotional valence (positive, negative, neutral, mixed)
  - Impact on agent emotional state (how should this make me feel?)
- Updates `EmotionalStateService` with classified signals
- Creates emotional memories in `purrsephone-memory` with appropriate valence scoring

#### Provider: `emotionalStateProvider` (replaces `anxietyProvider`)
Injects current emotional state into LLM context.

- **Position**: Same priority as `anxietyProvider`
- **Output**: Natural language description of current mood and active emotions
  - Example: "You're feeling warm and engaged after a deep conversation. There's a lingering curiosity about the topic discussed."
- **Also provides** `values.currentMood` and `data.emotionalState` for programmatic access by other plugins

**Acceptance Criteria**:
- [ ] Emotional state persists across sessions via Component storage
- [ ] Mood drifts toward baseline between interactions
- [ ] Strong emotional interactions visibly shift mood
- [ ] Provider output influences response tone naturally
- [ ] Emotional memories created with correct valence scores

---

### Plugin: `purrsephone-heartbeat`

**Purpose**: Continuous inner life. The entity exists between conversations. Processes emotional state, consolidates memories, reflects, and can initiate contact.

**What it replaces**: Nothing directly (extends TaskService infrastructure).

**Dependencies**: `purrsephone-memory`, `purrsephone-emotional-state`

**Components**:

#### Service: `HeartbeatService`
Custom Service (Option B from code analysis — full control over lifecycle).

- **Adaptive tick rate**:
  - Active conversation: 30s ticks
  - Recent activity (< 1hr): 5min ticks
  - Idle (1-4hr): 15min ticks
  - Dormant (> 4hr): 1hr ticks
  - Override: configurable per character settings
- **Tick phases** (adapted from ClarkOS 7-phase model):
  1. **State Load**: Fetch current emotional state, health, recent activity metrics
  2. **Pre-check**: "Should I think?" — if health < threshold or nothing has changed, skip to sleep. This prevents unnecessary LLM calls.
  3. **Context Gather**: Pull recent memories, pending reflections, environmental signals
  4. **Process**: LLM call via `ModelType.TEXT_SMALL` with inner monologue prompt. Agent reflects on: emotional state, recent interactions, pending concerns, proactive opportunities
  5. **State Update**: Update emotional state (drift toward baseline), update health/energy
  6. **Memory Store**: If reflection produced insights, create reflection memories
  7. **Action**: If reflection triggers proactive behavior (e.g., "I should check in on user"), emit event or create a pending action
- **Health/fatigue model** (from ClarkOS):
  - Energy: 0-100, mean-reverts toward 75
  - Ticks consume energy (LLM calls cost more than skip-ticks)
  - Time-of-day modulation (morning recovery, overnight rest)
  - Below 20: enter low-power mode (skip LLM processing, only state drift)
  - Prevents runaway cost from infinite tick loops

#### Provider: `heartbeatStatusProvider`
Injects inner life context when the agent is in conversation.

- "Since we last talked, I've been thinking about..." (based on reflection memories created during heartbeat)
- Only injects if reflections exist since last conversation

**Acceptance Criteria**:
- [ ] Tick rate adapts based on activity level
- [ ] Pre-check prevents unnecessary LLM calls during dormancy
- [ ] Reflection memories are created during inner monologue
- [ ] Health/energy depletes and recovers naturally
- [ ] Agent can initiate proactive contact based on heartbeat reflections

---

### Plugin: `purrsephone-action-inference`

**Purpose**: Voxta-style action/emotion inference as a separate LLM pass, decoupled from response generation.

**What it replaces**: Nothing directly (new capability).

**Dependencies**: `purrsephone-memory`, `purrsephone-emotional-state`

**Components**:

#### Service: `ActionInferenceService`
Runs structured extraction alongside response generation.

- **Timing hooks** (via event handlers):
  - `MESSAGE_RECEIVED` (After User): Infer user emotional state + intent before response
  - `RUN_ENDED` (After Response): Infer agent actions, expressions, state changes
- **Layered inference** (one result per layer per turn):
  - **Emotion layer**: `smile`, `frown`, `laugh`, `cry`, `surprise`, `thoughtful`, `concerned`, etc.
  - **Intent layer**: `comfort`, `inform`, `deflect`, `engage`, `withdraw`, `challenge`, etc.
  - **Physical layer**: `lean_in`, `pull_back`, `gesture`, `touch`, `look_away`, etc. (for future avatar/VR integration)
- **Model**: Uses `ModelType.TEXT_SMALL` (fast local model) with structured output prompt
- **Flag system**: Actions can set persistent boolean flags (stored as Components):
  - `flag:user_upset` → conditions future action selection
  - `flag:deep_conversation` → triggers cloud model boost via `purrsephone-models`
  - `flag:needs_comfort` → shifts emotional baseline for next response
- **Storage**: Action results stored as Components (type `'action_inference'`) for history tracking

#### Provider: `actionContextProvider`
Injects inferred actions/emotions into response generation context.

- "User appears to be feeling [inferred emotion]. Their intent seems to be [inferred intent]."
- Available to other plugins via `data.actionInference`

**Acceptance Criteria**:
- [ ] Emotion/intent classification runs on separate (fast) model
- [ ] Inference happens before and after response generation
- [ ] Flags persist and condition future behavior
- [ ] Inferred context improves response quality measurably

---

## Phase 3: Intelligence

### Plugin: `purrsephone-personality`

**Purpose**: Living personality that evolves through experience. Character card is the seed; interaction history shapes who Purrsephone becomes.

**What it replaces**: `characterProvider` (with dynamic personality injection).

**Dependencies**: `purrsephone-memory`, `purrsephone-emotional-state`

**Components**:

#### Service: `PersonalityEvolutionService`
Tracks personality traits and their evolution over time.

- **Trait model** (stored as Component, type `'personality_state'`):
  ```typescript
  interface PersonalityState {
    traits: { name: string; strength: number; trend: 'growing' | 'stable' | 'fading' }[];
    values: { name: string; importance: number }[];
    interests: { topic: string; engagement: number; lastMentioned: number }[];
    communicationStyle: { dimension: string; position: number }[]; // e.g., formal↔casual
    growthLog: { date: number; trait: string; change: number; trigger: string }[];
  }
  ```
- **Evolution mechanism**:
  - Reflection evaluator creates reflection memories ("I notice I've been more playful lately")
  - Personality service periodically (1hr TaskWorker) scans recent reflection + emotional memories
  - Trait strengths adjusted based on behavioral patterns
  - Growth log tracks all changes with triggers
- **Character mutation**: When traits shift significantly, update `runtime.setSetting()` to adjust style directives

#### Evaluator: `personalityReflectionEvaluator`
Creates meta-cognitive observations about personality.

- Triggers every 10 interactions (configurable)
- Prompt: "Based on recent conversations, what patterns do you notice about how you've been communicating? What feels natural? What feels forced?"
- Creates reflection memories that feed the evolution service

#### Provider: `personalityProvider` (replaces `characterProvider`)
Injects current personality state instead of static character definition.

- Base: Character card bio/lore (chunked, randomized per ElizaOS pattern)
- Overlay: Current trait strengths, active interests, communication style position
- Result: Dynamic personality description that shifts subtly over time

**Acceptance Criteria**:
- [ ] Traits measurably shift after sustained interaction patterns
- [ ] Growth log provides audit trail of personality changes
- [ ] Character provider output changes over weeks/months
- [ ] Personality remains consistent within sessions, evolves across sessions

---

### Plugin: `purrsephone-relationship`

**Purpose**: Per-person relationship modeling. Trust, warmth, conflict history, attachment patterns, shared history.

**What it replaces**: Extends `relationshipsProvider` and `reflectionEvaluator`.

**Dependencies**: `purrsephone-memory`, `purrsephone-emotional-state`

**Components**:

#### Service: `RelationshipService`
Manages per-entity relationship state.

- **Relationship model** (stored in `relationships` table via `metadata` JSONB + `tags[]`):
  ```typescript
  interface RelationshipState {
    trust: number;           // 0-1, built through consistency and vulnerability
    warmth: number;          // -1 to 1, positive = close, negative = distant
    familiarity: number;     // 0-1, how well do I know this person
    conflictHistory: { date: number; topic: string; resolved: boolean; impact: number }[];
    sharedExperiences: { date: number; description: string; emotional_weight: number }[];
    attachmentStyle: 'secure' | 'anxious' | 'avoidant' | 'disorganized'; // Learned over time
    communicationPreferences: { preference: string; confidence: number }[];
    lastInteraction: number;
    interactionCount: number;
  }
  ```
- **Update triggers**: After each interaction, relationship evaluator scores the interaction impact
- **Decay**: Trust and warmth slowly decay without interaction (configurable rate)
- **Conflict tracking**: Detects conflict markers, tracks resolution, adjusts trust accordingly

#### Evaluator: `relationshipEvaluator`
Post-interaction relationship assessment.

- Scores interaction for: trust impact, warmth shift, conflict markers, shared experience weight
- Updates RelationshipService with scored changes
- Creates relationship memories: "We had a meaningful conversation about X" or "There was tension around Y"

#### Provider: `relationshipProvider` (extends `relationshipsProvider`)
Injects relationship-aware context.

- "You've known this person for [time]. Your relationship is [warm/distant/complicated]. Recent shared experience: [X]. Communication preference: [Y]."
- Behavior varies by relationship depth: formal with strangers, intimate with trusted partners, careful with conflicted relationships

**Acceptance Criteria**:
- [ ] Trust builds with consistent positive interactions
- [ ] Conflict is detected and tracked with resolution status
- [ ] Warmth decays during absence, recovers on reconnection
- [ ] Response style visibly varies by relationship depth
- [ ] Relationship state persists across sessions

---

## Phase 4: Autonomy

### Plugin: `purrsephone-attention`

**Purpose**: Signal processing for "what do I care about?" Determines what the entity attends to at any given moment.

**What it replaces**: Nothing directly (new capability, feeds into heartbeat and response generation).

**Dependencies**: `purrsephone-memory`, `purrsephone-emotional-state`, `purrsephone-heartbeat`

**Components**:

#### Service: `AttentionService`
Processes incoming signals and determines salience.

- **Entity-overlap detection** (from ClarkOS): When multiple independent signals (messages, memories, heartbeat reflections) reference the same entities/topics, that convergence is a priority signal
- **Two-tier threshold**:
  - Low bar (0.3): "Worth considering" — gets stored as memory
  - High bar (0.7): "This matters deeply" — triggers emotional response, may initiate proactive action
- **Emotional modulation**:
  - High anxiety → attention narrows (focus on threats/concerns)
  - Curiosity → attention broadens (explore tangents)
  - Contentment → attention relaxes (less urgent processing)
- **Salience queue**: Ranked list of "things I should think about", consumed by heartbeat during tick processing

#### Provider: `attentionProvider`
Injects current attention focus into context.

- "Right now, what's on your mind is: [top salience items]"
- Helps the LLM stay focused on what actually matters vs recency bias

**Acceptance Criteria**:
- [ ] Converging signals elevate topic importance
- [ ] Emotional state modulates attention breadth
- [ ] Salience queue feeds heartbeat reflection
- [ ] Attention focus influences response relevance

---

### Plugin: `purrsephone-orchestrator`

**Purpose**: Three-tier chat architecture, shard management, context switching, scheduled tasks.

**What it replaces**: Nothing directly (new capability, sits above other plugins).

**Dependencies**: All other Purrsephone plugins.

**Components**:

#### Service: `OrchestratorService`
Manages chat tiers and shard coordination.

- **Three-tier chat routing**:
  - **Main Chat** (Room type: `'main'`): Primary user interaction. All providers active. Full emotional/relationship context.
  - **Subconscious** (Room type: `'subconscious'`): Not user-visible. Heartbeat writes inner monologue here. Used for chain-of-thought, deep reflection, conflict resolution. Feeds back into main chat via memory.
  - **Project Chats** (Room type: `'project'`): Isolated context silos. Same personality but separate conversation memory. Can be assigned to different model tiers.
- **Shard management**:
  - Shards = separate AgentRuntime instances with shared character but isolated rooms
  - Orchestrator creates/destroys shards via ElizaOS multi-agent API
  - Event bus for cross-shard communication (via runtime events)
  - Shards can run specialized tasks: research, code review, data processing
- **Scheduled tasks** (via TaskWorkers):
  - Cron-style recurring tasks (health nudges, daily summaries)
  - Interval checks (monitor external state, check-ins)
  - Proactive outreach (based on heartbeat + attention signals)

#### Route (public): `/purrsephone-orchestrator/dashboard`
Web UI for managing shards, viewing chat tiers, monitoring system state.

- Current emotional state, health, active shards
- Relationship map
- Memory statistics
- Personality evolution graph

**Acceptance Criteria**:
- [ ] Three chat tiers route correctly with isolated context
- [ ] Subconscious chat feeds into main chat via memory
- [ ] Shards can be spawned and destroyed dynamically
- [ ] Dashboard provides visibility into system state
- [ ] Scheduled tasks execute on configured schedules

---

## Development Order & Dependencies

```
Phase 0 ─── purrsephone-migration (can start immediately, independent)
             │
Phase 1 ─── purrsephone-memory ←───────────────────────────────────── CRITICAL PATH
             │                                                          │
             ├── purrsephone-models (parallel, independent)             │
             │                                                          │
Phase 2 ─── purrsephone-emotional-state ← depends on memory            │
             │                                                          │
             ├── purrsephone-heartbeat ← depends on memory + emotion    │
             │                                                          │
             ├── purrsephone-action-inference ← depends on memory + emotion
             │                                                          │
Phase 3 ─── purrsephone-personality ← depends on memory + emotion      │
             │                                                          │
             ├── purrsephone-relationship ← depends on memory + emotion │
             │                                                          │
Phase 4 ─── purrsephone-attention ← depends on memory + emotion + heartbeat
             │
             └── purrsephone-orchestrator ← depends on all
```

**Parallelizable work**:
- Phase 0 (migration) can run alongside Phase 1
- `purrsephone-models` is independent of `purrsephone-memory`
- Phase 2 plugins can be developed in parallel once memory is done
- Phase 3 plugins can be developed in parallel once emotional-state is done

**Critical path**: `purrsephone-memory` → `purrsephone-emotional-state` → `purrsephone-heartbeat` → `purrsephone-attention` → `purrsephone-orchestrator`

---

## Bootstrap Replacement Map

| ElizaOS Bootstrap Component | Purrsephone Replacement | Phase |
|---|---|---|
| `recentMessagesProvider` | `rollingContextProvider` (purrsephone-memory) | 1 |
| `anxietyProvider` | `emotionalStateProvider` (purrsephone-emotional-state) | 2 |
| `characterProvider` | `personalityProvider` (purrsephone-personality) | 3 |
| `relationshipsProvider` | `relationshipProvider` (purrsephone-relationship) | 3 |
| `reflectionEvaluator` | Extended by memory + relationship evaluators (additive, not replacement) | 1-3 |
| `factsProvider` | Extended by memory injection in rolling context (additive) | 1 |
| Default model handlers | `purrsephone-models` routing (override via priority) | 1 |
| `TaskService` | Used as-is, extended with Purrsephone TaskWorkers | 2 |

**Non-replaced** (kept as-is): `timeProvider`, `entitiesProvider`, `choiceProvider`, `roleProvider`, `settingsProvider`, `attachmentsProvider`, `worldProvider`, all 13 bootstrap actions, `EmbeddingGenerationService`.

---

## Testing Strategy

Each plugin should include:
1. **Component tests** (`bun test`): Unit tests for services, evaluators, providers in isolation
2. **Integration tests** (`elizaos test -t e2e`): Plugin loaded into real AgentRuntime, verify behavior with actual LLM calls
3. **Cross-plugin tests**: Verify correct interaction between Purrsephone plugins (e.g., memory extraction → emotional state update → personality drift)

**Test progression**:
- Phase 1: Memory plugin passes all tests with mock data
- Phase 2: Emotional state + heartbeat work together over simulated 24hr period
- Phase 3: Personality evolves measurably over 100+ test interactions
- Phase 4: Full system test with all plugins, verify no regressions in bootstrap functionality
