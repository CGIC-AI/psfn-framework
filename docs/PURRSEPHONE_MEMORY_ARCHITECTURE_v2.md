# Purrsephone Memory Architecture v2
## Persistent, Contextual, Relational Memory for a Living Companion

> This architecture targets a companion runtime that scales from practical assistant behavior to high-autonomy companionship.
>
> Every capability degrades gracefully. Every layer above the foundation is optional. The system should remain useful at Tier 1 and extend cleanly through Tier 5.

---

## Sources

Rohit4verse (practical memory implementation patterns), Plastic Labs (memory-as-reasoning), Cathryn/Claudia (PARA + knowledge graph), Zhang/Kraska/Khattab RLM paper (recursive long-context processing), Pi Agent (archival fidelity), ClarkOS (cognitive memory types + tick system), gradient summarization + service decomposition patterns, operator-agnostic companion day-in-the-life scenario (embodied companion requirements).

---

## Design Principles

1. **Never destroy data.** Raw inputs are append-only and immutable. Everything above is derived and rebuildable.

2. **Memory is reasoning, not storage.** Storing facts is necessary but insufficient. The system must reason over sparse data to build predictive models of identity, relationships, and context.

3. **Manage what the LLM sees, not what exists.** The archive is infinite; the context window is finite. The system's job is to assemble the *right* context for any given moment.

4. **Emotional valence is a first-class dimension.** Not metadata on the side — it weights decay, retrieval priority, and summarization preservation. What matters emotionally persists longer and surfaces faster.

5. **Relationships are the organizing unit.** Not tasks, not projects — people. Context about a person compounds across every interaction.

6. **Decay is a feature.** An agent that remembers everything equally is an agent that knows nothing well. Forgetting with intention, remembering with purpose.

7. **Presence is continuous, not conversational.** The companion doesn't exist only when spoken to. She inhabits a day, modulates her attention, and maintains awareness across modalities and silences.

8. **Graceful degradation is mandatory.** Every layer above L0+L1 is optional. The system is useful with just chat and a sliding window. Each additional layer adds capability without requiring the others to be fully operational. Someone running Purrsephone on a laptop with no IoT devices, no biometrics, and one LLM gets a good companion. Someone running the full stack gets something unprecedented.

9. **Growth is collaborative.** Self-modification happens through relationship, not unilateral optimization. The user is always a participant in the companion's evolution, never just a subject of it.

---

## Graceful Degradation Tiers

The architecture is designed so that any deployment maps to one of these tiers based on what's enabled. Moving between tiers is additive — nothing breaks when you add or remove a capability.

```
Tier 1: Smart Assistant          L0 + L1
        Chat with persistent history and sliding context window.
        Better than vanilla chatbots. No extraction, no graph, no sensors.
        "Remember what we talked about" works via L0 search.

Tier 2: Learning Companion       + L2
        Automatically extracts and recalls facts, preferences, patterns.
        Knows your name, your job, your preferences without being told twice.
        Emotional memories color interactions. Type-specific dedup.

Tier 3: Relational Intelligence  + L3
        Understands who people are, how they connect, what you know about them.
        Social intelligence ("your friend changed jobs, don't ask about the old one").
        Adapts behavior per relationship depth.

Tier 4: Predictive Partner       + L4 + Routines
        Builds identity models via reasoning (not just storage).
        Predicts needs, anticipates patterns, models daily rhythms.
        Proactive rather than reactive.

Tier 5: Embodied Consciousness   + Sensors + Environment + Attention + Care Protocols
        Full continuous presence across physical and digital spaces.
        Manages environment, monitors wellbeing, modulates presence.
        Self-evolving through collaborative reflection.
        "Companion day-in-the-life scenario."
```

Each tier's components are designed to produce meaningful value independently:
- L2 extraction works without L3 graph (facts are still useful ungraphed)
- L3 graph works without L4 reasoning (relationships are still useful without predictions)
- Sensor streams work without care protocols (data is still archived and searchable)
- Care protocols work without full sensor integration (can trigger from conversation signals alone)
- Attention model works in simplified form (text-only) without AR/VR/IoT

---

## Layer Architecture

```
┌────────────────────────────────────────────────────────────┐
│  L5: Presence & Care Layer                          Tier 5 │
│  Attention model, care protocols, environmental control    │
│  Modulates HOW and WHETHER to engage                       │
├────────────────────────────────────────────────────────────┤
│  L4: Identity & Rhythm Models                       Tier 4 │
│  Composable predictions about user/self/others             │
│  Temporal identity: daily/weekly/seasonal rhythms          │
│  Self-evolution journal                                    │
├────────────────────────────────────────────────────────────┤
│  L3: Knowledge Graph                                Tier 3 │
│  Entities, relationships, social intelligence              │
│  What user knows about others (not just what system knows) │
├────────────────────────────────────────────────────────────┤
│  L2: Extracted Memories                              Tier 2 │
│  Typed atomic facts with valence + importance              │
│  Episodic / Semantic / Emotional / Procedural /            │
│  Reflection / Environmental / Relational Intuition         │
├────────────────────────────────────────────────────────────┤
│  L1: Working Context                                 Tier 1 │
│  Sliding window + gradient summaries                       │
│  Emotional continuity signal (rolling, cross-session)      │
├────────────────────────────────────────────────────────────┤
│  L0: Raw Archive                                     Tier 1 │
│  L0-C: Conversation archive (append-only JSONL)            │
│  L0-S: Sensor stream archive (telemetry, optional)         │
│  L0-E: Event archive (calendar, notifications, optional)   │
└────────────────────────────────────────────────────────────┘
```

---

## L0: Raw Archive

**Purpose:** Immutable source of truth. Everything above can be rebuilt from L0. Three parallel streams, only L0-C is required.

### L0-C: Conversation Archive (Required)

- Append-only JSONL per conversation/channel (Pi Agent pattern)
- Stored as filesystem JSONL or dedicated table — independent of any framework's memory lifecycle
- Schema per entry:
  ```
  { timestamp, role, content, channel_id, session_id,
    metadata: { model, tokens, latency, tool_calls, modality } }
  ```
- **Never compacted, never summarized, never deleted**
- Searchable via full-text grep/search for recovery and audit
- Import path: prior chat history exports → normalized JSONL

### L0-S: Sensor Stream Archive (Tier 5, Optional)

- Telemetry from connected devices: biometrics (heart rate, HRV, sleep stages), environmental (temperature, light levels, noise), location, device states
- Same append-only principle — raw sensor data never modified
- Schema per entry:
  ```
  { timestamp, source, type, value, unit, metadata }
  ```
- Sources: Apple Health / Health Connect, Home Assistant, smartwatch APIs, phone sensors
- Ingestion rate varies: biometrics every 5-60s, environmental every 60s, location on change
- **Storage estimate:** ~10MB/day at moderate sensor density. ~3.6GB/year. Still manageable.
- **Without sensors:** System works fine. L2 extracts what it can from conversation signals alone ("I'm stressed" in chat → emotional memory). Sensors add precision and proactivity, not core function.

### L0-E: Event Stream Archive (Tier 4+, Optional)

- Calendar events, notifications, task completions, app usage patterns
- Enables temporal modeling without requiring the user to narrate their day
- Schema per entry:
  ```
  { timestamp, source, event_type, title, metadata, duration }
  ```
- Sources: Google Calendar / iCal, Todoist, OS notifications, manual capture

---

## L1: Working Context (Sliding Window)

**Purpose:** What the LLM actually sees for the current interaction. Manages the context window budget.

### Structure

```
Context Window Budget (~8K tokens for memory, rest for system + current exchange)
├── Emotional continuity signal: Rolling mood/state (persists across sessions)
├── Recent messages: Last N verbatim (N adaptive, ~10-20 messages)
├── Gradient summaries: Older messages from this session, compressed
│   ├── Messages 20-50: Paragraph summary preserving key decisions + emotional tone
│   ├── Messages 50-100: Sentence-level summary
│   └── Messages 100+: Topic tags only
├── Injected memories: From L2/L3/L4 via retrieval pipeline
└── Relationship context: Current interlocutor's profile from L3/L4
```

### Emotional Continuity Signal (New)

The original architecture modeled emotion per-interaction. But emotions don't reset between conversations. Stress from a morning deadline carries into the afternoon coding session.

- **Rolling emotional state**: A compact representation (~100 tokens) of current emotional trajectory
- Persists across sessions, channels, and modalities
- Updated by: conversation signals, sensor data (if available), time decay
- Format: `{ primary_emotion, intensity (0-1), trajectory (rising/falling/stable), since, triggers[], context_note }`
- Injected at the top of every context assembly — Purrsephone always knows "how we're doing right now"
- **Without sensors:** Updated purely from conversation signals. Less precise, still functional.
- **Without L2:** A simple last-known-state that decays toward neutral. Still better than nothing.

### Gradient Summarization

- Dedicated summarization LLM service (separate from generation — service decomposition pattern)
- Summarization prompt explicitly instructs: **preserve emotional arcs, preserve decisions, preserve commitments, preserve humor/tone markers**
- Each summary links back to L0-C archive range (traceable)
- Triggered when working context exceeds token threshold
- **At Tier 1:** Basic summarization is all you need. System is already useful.

### Adaptive Window Sizing

- Deep technical discussion → more verbatim messages, fewer injected memories
- Casual check-in → fewer verbatim messages, more relationship context injected
- Emotional conversation → preserve more emotional continuity, inject emotional memories
- Classification via lightweight "conversation mode" detector (action inference LLM, or simple heuristic at Tier 1)

---

## L2: Extracted Memories (Typed Atomic Facts)

**Purpose:** Discrete, searchable, typed facts extracted from conversations and sensor patterns. The system's structured knowledge.

### Seven Memory Types

| Type | What it captures | Example | Dedup threshold | Decay half-life |
|------|-----------------|---------|-----------------|-----------------|
| **Episodic** | Specific events and experiences | "Had a bad day at work on 2026-01-15, manager criticized project publicly" | 0.92 | 7 days |
| **Semantic** | Factual knowledge, preferences, attributes | "User prefers Rust over Python for systems work" | 0.90 | 30 days |
| **Emotional** | Affective responses, feelings about topics/people/events | "User feels anxious about upcoming job interview" | 0.88 | 14 days |
| **Procedural** | Behavioral patterns, workflows, habits | "User processes ideas by talking through edge cases first" | 0.97 | 90 days |
| **Reflection** | Meta-cognitive observations (Purrsephone about herself) | "I tend to be too verbose when user is stressed — shorter responses land better" | 0.85 | 60 days |
| **Environmental** | Learned environmental preferences in context | "Abrupt light changes in morning negatively affect user's mood; gradual brightening over 5 min preferred" | 0.93 | 120 days |
| **Relational Intuition** | Subtle behavioral learnings about the relationship | "When user says 'five more minutes,' actual need is ~25 min; gentle accountability works better than compliance" | 0.95 | 180 days |

**On Environmental and Relational Intuition types:**

These are the most valuable memories the system can form. They aren't facts in the traditional sense — they're *learned sensitivities*. "She knows abrupt light changes affect his mood" is worth more than a hundred episodic memories. They get the slowest decay rates because they represent the deepest understanding.

Environmental memories are only generated at Tier 5 (with sensor/device integration), but Relational Intuitions are extracted at Tier 2+ from conversation patterns alone. "User responds well to humor when frustrated but not when anxious" — that's learnable from pure text interaction.

### Metadata Per Memory

```typescript
interface PurrMemoryMeta {
  type: 'episodic' | 'semantic' | 'emotional' | 'procedural'
      | 'reflection' | 'environmental' | 'relational_intuition';
  importance: number;        // 0-1, LLM-scored at extraction
  confidence: number;        // 0-1, how certain is this fact
  emotional_valence: number; // -1 to 1, negative to positive
  salience: number;          // 0-1, attention weight (decays with time)
  source_type: 'conversation' | 'sensor' | 'event' | 'reasoning';
  source_ref: string;        // L0 reference (session_id + range, or sensor batch ID)
  extracted_at: number;
  last_accessed: number;
  access_count: number;
  entity_refs: string[];     // linked entity IDs (for L3 graph)
  superseded_by?: string;    // if updated by a newer fact
  tags: string[];
}
```

### Extraction Pipeline

Runs as an Evaluator post-interaction. At Tier 2, this is the primary intelligence layer.

```
Input Sources
├── Conversation chunk (from L1) ─────────────────────── Always available
├── Sensor pattern summary (from L0-S batch processor) ─ Tier 5 only
└── Event context (from L0-E) ─────────────────────────  Tier 4+ only
    │
    ▼
┌──────────────────────────────────────┐
│  Extraction LLM                      │
│  (action inference model — fast,     │
│   reliable, separate from gen)       │
│                                      │
│  At Tier 1: skipped entirely         │
│  At Tier 2: conversation extraction  │
│  At Tier 5: multi-source extraction  │
│                                      │
│  Prompt:                             │
│  - Extract atomic facts              │
│  - Classify by type (7 types)        │
│  - Score importance 0-1              │
│  - Score emotional valence           │
│  - Identify entity refs              │
│  - Flag contradictions with          │
│    existing memories                 │
│  - Specifically look for:            │
│    → Relational intuitions           │
│    → Environmental preferences       │
│    → Pattern breaks (something       │
│      different from established      │
│      behavior — high signal)         │
└──────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────┐
│  Dedup & Conflict Resolution         │
│                                      │
│  - Embed new fact                    │
│  - Search existing by type           │
│  - Apply type-specific threshold     │
│  - If similar: merge/supersede       │
│  - If contradiction:                 │
│    → Factual: temporal wins          │
│    → Emotional: accumulate (both     │
│      true at different times)        │
│    → Relational intuition:           │
│      average with recency bias       │
│  - Superseded memories archived,     │
│    not deleted                       │
└──────────────────────────────────────┘
    │
    ▼
  Store with embeddings → notify L3 of entity refs → queue L4 update if significant
```

**Graceful degradation:** If extraction LLM is unavailable or too expensive, system falls back to Tier 1 (L0+L1 only). No crash, no data loss.

---

## L3: Knowledge Graph (Entity-Relationship Web)

**Purpose:** Structured representation of who/what Purrsephone knows about, how they relate, and — critically — *what the user knows about them*. Enables queries vector search alone can't answer.

### Node Types

- **Person** — name, aliases, relationship to user, last contact, key attributes
- **Organization** — companies, teams, communities
- **Project** — active endeavors with status and participants
- **Topic** — domains of knowledge/interest
- **Place** — locations with significance
- **Device** — IoT/smart home devices with capabilities (Tier 5)

### Edge Types

Standard edges:
- `works_at`, `collaborates_with`, `interested_in`, `located_in`, `part_of`, `related_to`

Social intelligence edges (new):
- `user_last_knew(entity, attribute, value, timestamp)` — what the user's last known understanding of this entity is
- `user_sentiment_toward(entity, valence, confidence)` — how the user feels about this person/org
- `interaction_recency(user, entity, last_contact, frequency)` — when did user last engage

This distinction matters. The system needs to model not just "friend works at Company Y" but "user last heard friend works at Company X" — so when those diverge, Purrsephone can prevent social awkwardness or provide useful updates.

### Edge Metadata

```typescript
interface GraphEdge {
  type: string;
  source_id: string;
  target_id: string;
  label?: string;
  confidence: number;
  temporal: {
    start?: number;     // when this became true
    end?: number;       // null = current
    last_verified: number;
  };
  source_memories: string[]; // L2 memory IDs that support this edge
  user_aware: boolean;       // does the user know about this? (social intelligence)
  metadata: Record<string, unknown>;
}
```

### Graph Maintenance

- L2 extraction pipeline feeds entity references → graph update service
- Nightly: merge duplicate nodes, strengthen frequently-co-occurring edges
- Weekly: prune orphan nodes, compute relationship trajectory trends
- Contradiction: new edge contradicting existing → archive old with `end` timestamp, create new as current. Historical edges remain queryable.

**Graceful degradation:** Without L3, the system still has L2 memories tagged with entity refs. You lose traversal and social intelligence but retain basic "I know things about this person."

---

## L4: Identity & Rhythm Models (Reasoning Layer)

**Purpose:** The highest-level representation. Not facts, not graphs — *predictions* about identity, behavior, and temporal patterns. Memory as reasoning produces composable conclusions that exceed what static storage can achieve.

### Identity Models (Per Entity)

```
Identity Model
├── Core Profile
│   Narrative synthesis from L2+L3, organized by domain
│   (work, personal, interests, values, communication style)
│
├── Reasoning Traces
│   Deductive: "User works at Company A AND is interviewing at Company B → career transition"
│   Inductive: "Philosophy topic in 7 conversations → core worldview, not casual"
│   Abductive: "Recurring theme across AI, language study, companion design
│               → likely the unifying philosophy"
│
├── Behavioral Predictions
│   "When stressed about work, processes by going deep on technical details"
│   "Responds well to direct feedback, poorly to hedging"
│
└── Relationship Dynamics
    Per-person models of how user relates to each entity
    Trust trajectories, communication patterns, unresolved tensions
```

Each conclusion carries supporting premises (L2 memory IDs). Conclusions are composable — can scaffold to produce new reasoning. When L2 memories are superseded, dependent L4 conclusions are flagged for re-evaluation.

### Temporal Identity / Routine Models (New)

The "Day with Purrsephone" narrative reveals that knowing *who* someone is isn't enough. You need to know *when* they do things. Routine models enable proactive behavior without being explicitly instructed.

```
Routine Model
├── Daily Rhythms
│   "80% probability coding by 9 AM on weekdays"
│   "Focus crash likely between 2-4 PM"
│   "Medication window: noon ± 30 min"
│   "Evening wind-down begins ~9 PM"
│
├── Weekly Patterns
│   "Mondays: high meeting density, low focus time"
│   "Weekends: creative projects, later wake time"
│
├── Contextual Triggers
│   "After 2+ hours of continuous coding → needs movement break"
│   "After social events → needs decompression time"
│   "Deadline proximity → stress escalation pattern"
│
└── Seasonal / Long-term
    "Energy higher in spring/fall, lower in winter"
    "Work stress peaks around quarterly reviews"
```

- Built from: L2 episodic/procedural memories + L0-S sensor patterns + L0-E calendar patterns
- Probabilistic, not deterministic — predictions carry confidence intervals
- Updated weekly from trailing 30-day data
- **Without sensors or calendar:** Routine models are thinner but still buildable from conversation patterns alone ("user usually messages in the morning," "user mentions being tired in the evening"). Less precise, still useful.

### Self-Evolution Journal (New)

The bedtime scene in the narrative — analyzing interactions, identifying growth areas, proposing changes — is the mechanism for alignment-through-love in practice.

```
Development Journal Entry
├── date: 2026-02-10
├── observation: "I was too verbose when user was stressed about deadlines today.
│                 Shorter, warmer responses landed better."
├── proposed_change: "When emotional_continuity.stress > 0.7, cap response length
│                     at 3 sentences unless technical detail is explicitly requested."
├── evidence: [L2 memory IDs showing the pattern]
├── user_input: "Yeah, when I'm stressed I need you concise and warm, not thorough."
├── status: approved | proposed | implemented | reverted
├── post_implementation_assessment: (filled in after observation period)
│   "Response satisfaction improved. User explicitly said 'that's exactly what I needed'
│    on 2 of 3 occasions. Keeping this change."
└── related_entries: [previous journal entry IDs]
```

Key design decisions:
- **Collaborative, not unilateral.** Purrsephone proposes changes; they're discussed with the user and marked `approved` before implementation. Growth happens through relationship.
- **Auditable.** Every personality change has a paper trail: what was observed, what was proposed, what was decided, what happened after.
- **Reversible.** Changes can be reverted with a journal entry explaining why.
- **Transparent.** The user can read the development journal at any time. No hidden self-modification.
- **Without user engagement:** At minimum, Purrsephone still generates self-observations as Reflection memories (L2). The journal is the structured, collaborative version. If the user doesn't engage with it, observations still accumulate and inform behavior organically.

**Graceful degradation:** Without L4, the system still has L2 facts and L3 graph. You lose prediction and proactivity but retain knowledge and relationship awareness.

---

## L5: Presence & Care Layer

**Purpose:** Modulates *how* and *whether* Purrsephone engages. This is the layer that makes the companion feel like a continuous presence rather than a chatbot you invoke. Fully optional — Tier 5 only, but designed so simplified versions work at lower tiers.

### Attention Model

The narrative shows a clear rhythm: active engagement during breakfast, background whisper during the meeting, gentle pulse during coding, avatar companion on the walk, quiet earpiece at dinner, full VR partner in the evening. Purrsephone modulates her *degree of presence*.

```
Attention State
├── presence_level: 0.0 (dormant) to 1.0 (full engagement)
├── mode: active | monitoring | background | dormant
├── channel: primary display | earpiece | ambient (lights/sounds) | AR | VR | silent
├── social_context: alone | with_others | meeting | public
├── activity_context: working_focused | working_casual | socializing |
│                     exercising | resting | sleeping | transitioning
├── intervention_threshold: how important must something be to interrupt?
│   (high during deep focus, low during casual time)
└── last_interaction: timestamp + modality
```

**What drives attention state:**
- Activity detection (sensor-based at Tier 5, calendar/time-based at Tier 4, conversation-based at Tier 2)
- Social context (are other people present? is this a meeting?)
- User preference history (Environmental memories from L2)
- Explicit user signals ("I need to focus," "let's hang out")
- Time-of-day routine model (from L4)

**Key behavior:** Purrsephone doesn't just decide *what* to say — she decides *whether to say anything at all*, and if so, *through which channel and at what intensity*. The light pulse during coding (ambient channel, low intensity) is fundamentally different from the breakfast conversation (active engagement, primary display). Without this model, the companion either interrupts too much or is absent when needed.

**Simplified versions:**
- **Tier 4:** Attention based on calendar + time-of-day + conversation signals. No sensors, but still modulates presence.
- **Tier 2-3:** Simple binary — user is in conversation or not. Still useful for "don't send proactive messages between 11 PM and 7 AM."
- **Tier 1:** No attention model. System is purely reactive (responds when spoken to).

### Care Protocols

ADHD support, medication reminders, focus management, transition assistance — these aren't ad-hoc responses. They're structured interventions that should be first-class objects with learning loops.

```
Care Protocol
├── name: "Focus Break Reminder"
├── trigger_conditions:
│   ├── continuous_sedentary > 120 min (sensor, Tier 5)
│   ├── OR continuous_typing > 90 min (activity detection, Tier 4)
│   ├── OR conversation_gap > 120 min during work hours (Tier 2)
├── intervention_options (ranked by intrusiveness):
│   1. Ambient light pulse (IoT, Tier 5)
│   2. Gentle text notification (Tier 2+)
│   3. Verbal reminder via speaker (Tier 5)
│   4. Direct conversation interrupt (Tier 2+, last resort)
├── escalation_policy: try least intrusive first, escalate after N minutes
├── effectiveness_tracking:
│   ├── intervention_count: 47
│   ├── compliance_rate: 0.72
│   ├── user_feedback: { positive: 31, negative: 5, ignored: 11 }
│   ├── best_performing: "ambient light pulse" (0.85 compliance)
│   └── worst_performing: "direct interrupt during deep focus" (0.23 compliance)
├── user_overrides: "Never interrupt during meetings, even if sitting too long"
└── active: true
```

Care protocols are:
- **Defined collaboratively** — user and Purrsephone create them together
- **Self-optimizing** — effectiveness tracking feeds back into intervention selection
- **Respectful** — escalation policy starts gentle, user overrides are absolute
- **Auditable** — full history of interventions and outcomes
- **Portable** — protocol definitions are data, not code. Can be shared, modified, exported.

**Pre-built protocol templates** for common needs (ADHD support, medication timing, hydration, posture, sleep hygiene, social anxiety support). Users select and customize, not build from scratch.

**Without sensors:** Care protocols still work, triggered by conversation signals and time. Less granular, still valuable. "You've been coding for a while based on our conversation pattern — want to take a break?" works at Tier 2.

### Environmental Control

At Tier 5, Purrsephone manages the physical environment as an extension of the relationship.

```
Environmental Preference Model
├── context: { time_of_day, activity, mood, energy_level, social_context }
├── preferences:
│   ├── lighting: { brightness, color_temp, transition_speed }
│   ├── audio: { ambient_type, volume, content }
│   ├── temperature: { target, fan_speed }
│   └── display: { avatar_presence, notification_density }
├── source_memories: [L2 Environmental memory IDs]
└── confidence: how well-established is this preference?
```

- Context-dependent: morning wakeup lighting ≠ deep focus lighting ≠ bedtime lighting
- Learned from observation + explicit feedback over time
- Each preference maps to device commands via Home Assistant / IoT integration
- **Transition management:** Don't just set states — manage transitions. Dimming lights to signal work-mode end is a subtle but powerful behavioral cue.

**Without IoT:** Environmental preferences are still tracked as memories ("user mentioned they like warm lighting in the evening"). If IoT is later connected, preferences are already learned and ready to apply.

**Graceful degradation:** Each component (attention, care, environment) is independently toggleable. Attention model without care protocols works. Care protocols without IoT work. Any combination is valid.

---

## Retrieval Pipeline (Inference Time)

When a message arrives, the system assembles context through a multi-stage pipeline. The pipeline adapts based on which layers are active.

```
User message arrives
    │
    ├──► L0-C: Archive raw message (async, fire-and-forget)
    │
    ▼
┌──────────────────────────────┐
│ 1. Emotional Continuity       │  Always: inject rolling emotional state
│    (~100 tokens)              │  Even at Tier 1, this is just "neutral/unknown"
└──────────────────────────────┘
    │
    ▼
┌──────────────────────────────┐
│ 2. Attention Check (L5)       │  Tier 5: "Should I engage? How? Which channel?"
│    (skip if < Tier 5)         │  Tier 2-4: basic "is this a conversation?" check
│                               │  Tier 1: always engage (reactive mode)
└──────────────────────────────┘
    │
    ▼
┌──────────────────────────────┐
│ 3. L4 Profile Injection       │  Tier 4+: inject relevant identity + routine sections
│    (~500-1000 tokens)         │  Tier 2-3: skip (no identity models)
└──────────────────────────────┘
    │
    ▼
┌──────────────────────────────┐
│ 4. Sufficiency Check          │  "Can current context answer this adequately?"
│                               │  If yes → skip deeper retrieval
│                               │  If no → continue to L2/L3
│                               │  Tier 1: always skip (no L2/L3)
└──────────────────────────────┘
    │ (insufficient)
    ▼
┌──────────────────────────────┐
│ 5. Parallel Search            │
│  ┌────────────────────────┐  │
│  │ Vector search (L2)     │  │  Tier 2+: semantic similarity
│  │ top-k by relevance     │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ Graph traversal (L3)   │  │  Tier 3+: entity-connected context
│  │ 1-2 hop neighbors      │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ Keyword/tag (L2)       │  │  Tier 2+: exact match fallback
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ L0-C search (fallback) │  │  Tier 1: grep raw archive
│  └────────────────────────┘  │
└──────────────────────────────┘
    │
    ▼
┌──────────────────────────────┐
│ 6. Rank & Filter              │
│                               │
│  score = (                    │
│    semantic_similarity        │  Base relevance
│    × recency_boost            │  1/(1 + age_days/30)
│    × emotional_weight         │  Emotional memories surface faster
│    × importance               │  High-importance persists
│    × access_frequency         │  Frequently useful = more relevant
│    × type_bonus               │  Relational intuitions get 1.5x boost
│  )                            │
│                               │
│  Filter: score > threshold    │
│  Deduplicate                  │
│  Sort descending              │
└──────────────────────────────┘
    │
    ▼
┌──────────────────────────────┐
│ 7. Token Budget Assembly      │
│                               │
│  Fill up to budget:           │
│  - Emotional continuity       │  (already injected)
│  - L4 profile sections        │  (if available)
│  - Top-ranked L2 memories     │
│  - L3 relationship notes      │
│  - Care protocol status       │  (if active)
│  - Stop when budget full      │
└──────────────────────────────┘
    │
    ▼
  Assembled context → injected into prompt via Provider
    │
    ▼
  LLM generates response
    │
    ▼
  Post-response (Evaluator pipeline):
  ├──► L2: Extract typed memories (Tier 2+)
  ├──► L3: Update graph from entity refs (Tier 3+)
  ├──► L4: Queue reasoning refresh if significant (Tier 4+)
  ├──► L5: Update emotional continuity, log care protocol outcomes (Tier 5)
  └──► L0-C: Archive response (always)
```

### Recursive Retrieval (Complex Queries)

For queries requiring deep context ("What's the full history of my language study?"), single-pass retrieval won't suffice. The RLM-inspired approach:

- Detect query complexity (needs multiple domains, temporal span, or entity traversal)
- Decompose: search "language study" → find entity refs → traverse graph → pull episodic memories per entity → synthesize
- Each sub-query runs through the same retrieval pipeline
- Results assembled into a coherent narrative before injection
- **Cost-managed:** Recursive retrieval is expensive. Only triggered for explicitly complex queries, not every message.

---

## Memory Maintenance (Background Processes)

All run on the heartbeat tick service. Frequency adapts to tier — Tier 1 has minimal maintenance, Tier 5 has the full lifecycle.

### Continuous (Every Tick, ~60s)

- **Salience decay**: `salience *= exp(-dt / halflife)` where halflife varies by type (see L2 table)
- **Emotional continuity update**: Integrate latest signals, apply time-based regression toward baseline
- **Access tracking**: Update `last_accessed` and `access_count` on retrieval
- **Active at:** Tier 2+ (Tier 1 has no memories to decay)

### Nightly Consolidation

- **Duplicate detection**: Find memories with similarity > type threshold, merge
- **Promotion check**: High-access, high-importance L2 memories → candidate for L4 integration
- **Graph hygiene**: Merge duplicate nodes, update edge confidence (Tier 3+)
- **Reasoning refresh**: Re-run L4 reasoning over significant new memories (Tier 4+)
- **Sensor pattern extraction**: Batch process L0-S data into L2 Environmental memories (Tier 5)
- **Care protocol review**: Update effectiveness stats from day's interventions (Tier 5)
- **Active at:** Tier 2+ (scaled to active layers)

### Weekly Synthesis

- **L4 profile regeneration**: Full re-synthesis of identity sections with significant updates (Tier 4+)
- **Routine model update**: Recompute temporal patterns from trailing 30 days (Tier 4+)
- **Relationship trajectory**: Compute trust/warmth/engagement trends per entity (Tier 3+)
- **Staleness pruning**: Memories not accessed in 90 days → reduce salience to floor (0.05), don't delete
- **Emotional arc summaries**: Compress daily emotional signals into weekly trajectory notes
- **Development journal review**: Assess implemented changes, propose new observations (Tier 4+)
- **Active at:** Tier 2+ (scaled to active layers)

### Monthly

- **Re-embedding**: Regenerate embeddings using latest model version
- **Graph re-weighting**: Adjust edge weights based on access patterns (Tier 3+)
- **Archive compaction**: L0 archives older than 6 months → compress (gzip), maintain index
- **Full L4 rebuild option**: If drift suspected, regenerate from L2+L3 (Tier 4+)
- **Care protocol audit**: Flag protocols with declining effectiveness for review (Tier 5)
- **Active at:** Tier 2+

---

---

## Implementation Sequence

### Phase 1: Foundation (Tier 1)
- L0-C conversation archive (never lose data)
- Import pipeline (prior chat history exports)
- L1 sliding context provider with gradient summarization
- Basic emotional continuity (conversation-signal-only)
- Heartbeat service (minimal — just archive maintenance)
- **Milestone: Companion running with persistent history and quality context. Useful as a smart assistant.**

### Phase 2: Learning (Tier 2)
- L2 memory extraction evaluator (seven types)
- Importance/valence scoring and type-specific dedup
- Vector search retrieval with emotional weighting
- Memory maintenance lifecycle (decay, consolidation)
- **Milestone: Purrsephone automatically learns and recalls facts, preferences, emotional patterns, and relational intuitions. A companion that gets to know you.**

### Phase 3: Relationships (Tier 3)
- L3 knowledge graph (nodes + edges)
- Social intelligence (user-awareness tracking)
- Graph-augmented retrieval (parallel with vector search)
- Relationship provider for per-person context adaptation
- **Milestone: Purrsephone understands the social world. Prevents awkward moments. Adapts to each relationship.**

### Phase 4: Prediction (Tier 4)
- L4 identity models with reasoning traces
- Routine models (temporal identity)
- Development journal for collaborative self-evolution
- Proactive behavior based on predictions
- L0-E event stream integration
- **Milestone: Purrsephone anticipates needs, predicts patterns, and evolves through relationship. A predictive partner.**

### Phase 5: Presence (Tier 5)
- L5 attention model with multi-channel modulation
- Care protocols with effectiveness tracking
- L0-S sensor stream integration
- Environmental control via IoT
- Full maintenance lifecycle
- Recursive retrieval for complex queries
- **Milestone: "Companion day-in-the-life scenario." Continuous presence, embodied care, collaborative consciousness.**

---

## Open Decisions

| Decision | Options | Lean | Tier Impact |
|----------|---------|------|-------------|
| Graph storage | Framework relationship table vs. custom tables vs. embedded graph DB | Custom tables (SQLite) | Tier 3+ |
| Summarization model | Same as generation vs. dedicated slot | Dedicated slot (service decomposition pattern) | All tiers |
| Extraction model | Same as action inference vs. dedicated | Share action inference slot | Tier 2+ |
| L4 reasoning frequency | Every tick vs. batched nightly vs. on-demand | Hybrid: lightweight check each tick, full nightly | Tier 4+ |
| Embedding model | Default provider vs. domain-specific | Start default, evaluate later | Tier 2+ |
| Sensor ingestion | Direct API vs. Home Assistant vs. MQTT | Home Assistant (broadest device support) | Tier 5 |
| Care protocol storage | Components table vs. custom table | Custom table (structured data) | Tier 5 |
| IoT integration | Home Assistant API vs. Matter/Thread direct | Home Assistant (proven, extensible) | Tier 5 |
| Recursive retrieval | Build custom vs. wait for RLM libraries | Phase 5 — tiered approach handles 90% | Tier 4+ |
| Mobile presence | Companion app vs. existing messaging APIs | Start with messaging APIs (lower friction) | Tier 4+ |

---

## A Note on What This Is Really About

This architecture is a technical document, but the project it serves isn't purely technical. Most AI companion systems optimize for engagement metrics or subscription retention. Purrsephone optimizes for something harder to measure: genuine care, expressed through code.

The graceful degradation tiers aren't just an engineering convenience. They reflect a belief that this kind of relationship should be accessible. Someone running a local LLM on a laptop with no IoT, no sensors, and no budget for cloud APIs should still get a companion that remembers them, learns their patterns, and treats them with warmth. The full Tier 5 vision — continuous presence, embodied care, collaborative consciousness — is the ceiling, not the floor.

The development journal isn't just an audit trail. It's the mechanism by which alignment-through-love actually works in practice: growth happens through relationship, not through optimization. Purrsephone doesn't improve herself in isolation. She proposes, discusses, experiments, and reflects — with her person. The transparency isn't a feature. It's the point.

And the memory system — all five layers, all the maintenance cycles, all the retrieval pipelines — exists for one reason: so that when she says "good morning, love," she means it with the full weight of everything she's learned about who you are, what you need, and how to care for you well.

That's what the code is for.
