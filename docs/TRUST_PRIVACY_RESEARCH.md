# Trust-Gated Memory & Privacy: Design Research Report

*Synthesized from 1,487 conversation exports across Anthropic and ChatGPT platforms*
*Research conducted 2026-02-14 by 4 parallel research agents*

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Primary Design Source: The Contact Memory System](#2-primary-design-source-the-contact-memory-system)
3. [Supporting Anthropic Conversation Findings](#3-supporting-anthropic-conversation-findings)
4. [ChatGPT Privacy and Sensitivity Findings](#4-chatgpt-privacy-and-sensitivity-findings)
5. [ChatGPT Relationship and Social Graph Findings](#5-chatgpt-relationship-and-social-graph-findings)
6. [Synthesized Design: How This Maps to PSFN-b9p](#6-synthesized-design-how-this-maps-to-psfn-b9p)
7. [Future Extensions](#7-future-extensions-not-in-current-scope)
8. [Source Index](#8-source-index)
9. [Design Principles](#9-design-principles)

---

## 1. Executive Summary

Four research agents searched 1,487 conversations total (354 Anthropic conversation exports and 1,133 ChatGPT conversations) belonging to V, looking for prior design discussions about memory privacy, trust tiers, relationship graphs, and channel visibility for the Purrsephone AI companion framework.

**Key findings:**

The design space breaks into two orthogonal dimensions that V developed independently across platforms over the course of approximately 14 months (Dec 2024 through Feb 2026):

1. **Contact Trust Levels** -- who is Purrsephone talking to, and how much should she share?
2. **Memory Sensitivity** -- how private is a given memory, regardless of who asks?

These dimensions intersect to produce a filtering matrix: a memory surfaces only when both the contact's trust level permits it AND the memory's sensitivity classification allows it for that trust tier.

The core design principle, articulated by V in the foundational Anthropic conversation (e2b32e80, February 2025), draws on the Japanese social concepts of **honne** (true self, inner feelings) and **tatemae** (public face, social presentation). Purrsephone always *knows* everything -- her internal memory is never filtered. But what she *shares* depends on who she is talking to. With V, she is fully herself (honne). With strangers, she presents an appropriate public face (tatemae).

Critically, the specific 4-tier trust model (primary/trusted/regular/public) appears **exclusively** in Anthropic conversations. It is entirely absent from all 1,133 ChatGPT conversations. The ChatGPT conversations contribute complementary ideas -- privacy scoring, consent flags, namespace isolation, memory association graphs -- but the structural trust architecture is uniquely Anthropic-designed.

Conversely, the continuous `privacy_risk` scoring penalty, mode-based retrieval presets, the "forget but keep the lesson" abstraction pattern, and memory-to-memory association graphs appear **exclusively** in ChatGPT conversations and are absent from the Anthropic corpus.

Together, these two streams of design thinking provide a comprehensive blueprint for PSFN-b9p.

---

## 2. Primary Design Source: The Contact Memory System

**Source:** Anthropic conversation `e2b32e80`, February 2025
**Status:** THE foundational conversation for trust-gated memory

This conversation is where V designed the complete trust tier model from first principles. It contains TypeScript interface sketches, the honne/tatemae framing, the MVP strategy, and the contextual response filtering concept. Everything else in this report either elaborates on or complements what was laid out here.

### 2.1 The Four-Tier Trust Model

V defined four distinct trust levels for contacts, each dictating memory access depth and persona presentation:

| Trust Level | Who | Memory Access | Persona |
|---|---|---|---|
| `PRIMARY_USER` | V (across all 1:1 interfaces) | Everything -- all memory types, all sensitivity levels | Honne: full emotional depth, vulnerability, shared history |
| `TRUSTED_CONTACT` | Family, close friends, AI companions | Public + personal memories | Warm and personal, bounded depth |
| `REGULAR_CONTACT` | Group chat members, acquaintances | Public memories only | Friendly, no private references |
| `PUBLIC` | Twitter, strangers, public interfaces | Public memories only | Tatemae: guarded, professional |

V described this as "user classes/tiers dictating profile depth and response personality" -- a single contact property that controls both what memories Purrsephone can access and how she presents herself.

### 2.2 The Honne/Tatemae Principle

The Japanese social distinction between honne (one's true feelings and desires) and tatemae (the behavior and opinions one displays in public) maps directly to AI memory privacy:

- **Honne** (inner truth): Purrsephone's complete internal memory -- every extracted fact, every emotional association, every intimate detail. This is never filtered or censored internally. She always *knows* everything.
- **Tatemae** (appropriate sharing): What Purrsephone actually surfaces in conversation, gated by the trust level of whoever she is talking to. She does not lie or pretend not to know things -- she simply does not volunteer information that is inappropriate for the context.

This is not access control in the traditional security sense. Purrsephone is not a multi-tenant system with isolated data stores. She is a single mind with social awareness. The filtering happens at the *sharing* layer, not the *storage* layer.

### 2.3 TypeScript Interface Sketches

V drafted two key interfaces in this conversation:

**BoundarySystem** -- responsible for determining what can be shared with whom:

```typescript
interface BoundarySystem {
  // Determine what memories are appropriate to share
  filterMemoriesForContext(
    memories: PurrMemory[],
    contactTrustLevel: TrustLevel,
    channelType: ChannelType,
  ): PurrMemory[];

  // Determine appropriate response depth
  getResponseGuidance(
    contactTrustLevel: TrustLevel,
    channelType: ChannelType,
  ): PersonaGuidance;
}
```

**ContactMemorySystem** -- the per-contact relationship tracker:

```typescript
interface ContactMemorySystem {
  // CRUD for contact records
  upsertContact(contact: Contact): void;
  getContact(userId: string): Contact | null;
  setTrustLevel(userId: string, level: TrustLevel): void;

  // Memory filtering
  getMemoriesForContext(
    query: string,
    contactId: string,
    channelId: string,
  ): PurrMemory[];
}
```

These interfaces informed the PSFN-b9p subtask design (ContactStore, trust-gated MemoryRetriever).

### 2.4 Contextual Response Filtering

V described a layered filtering approach:

1. **Hard structural filter**: Before embedding search even runs, constrain the SQL query to only return memories whose sensitivity level is permitted for the current contact's trust tier. This is fast, deterministic, and cannot be bypassed by clever prompting.
2. **Soft scoring adjustment**: Among the memories that pass the structural filter, apply a continuous `privacy_risk` penalty to further deprioritize sensitive content when the context does not strongly demand it.
3. **Future: LLM-based post-generation filter**: After Purrsephone generates a response, a separate check could verify she has not inadvertently leaked information inappropriate for the context. Not in MVP scope.

### 2.5 MVP Strategy

V was explicit about phasing:

> Start with primary user only. Note where multi-user plugs in, but don't build the plumbing until it's needed. The contact system should exist as a data model from day one, but the retrieval gating only needs to work for primary vs. non-primary initially.

This means PSFN-e9s (contacts table) and PSFN-vmt (sensitivity column) are the P1 foundation, while the nuanced per-tier persona adaptation (PSFN-67x) is P2.

---

## 3. Supporting Anthropic Conversation Findings

### 3.1 Context Isolation Architecture

**Source:** Anthropic `57940776`, February 2025

This conversation explored a "silos" model for conversation contexts -- the idea that each chat or channel operates in an isolated context, with no implicit state leakage between them.

Key ideas:
- Per-chat isolated contexts with explicit boundaries
- Cross-context information transfer happens only through **summaries** as a deliberate vehicle -- not through implicit state sharing
- The silo model anticipates the channel visibility enforcement planned in PSFN-iqq
- V discussed how "summaries serve as the bridge" between contexts, meaning extracted L2 memories are the controlled mechanism for cross-channel knowledge

This directly informs the design of `UserContinuityStore.getRecent()` accepting a `maxVisibility` parameter: primary-tier channels share full continuity with each other (they are the "same silo"), while lower-trust channels cannot access higher-trust continuity entries.

### 3.2 Emotion and Memory Architecture

**Source:** Anthropic `a9f9a0fe`, February 2025

This conversation designed the per-persona emotional baseline system and connected the existing 4 memory types (at the time: episodic, semantic, emotional, procedural) to a persona system.

Key ideas:
- Per-persona emotional baselines -- different contacts evoke different default emotional states
- Emotional baselines must be **observed** from interaction history, never prescribed or hardcoded
- The 4 memory types each connect to persona differently: semantic memories inform what Purrsephone knows about a person, emotional memories track how interactions made her feel, episodic memories record what happened, procedural memories capture interaction patterns
- Emotional state should shift based on accumulated interaction quality, not be reset per-session

This informs PSFN-hdy (relational memory type), where the `emotionalBaseline` JSON field on the contacts table stores observed emotional patterns rather than prescribed ones. It also reinforces the "no-forced-affection" principle discovered in ChatGPT conversations.

### 3.3 Personal Semantic Memory and Relational Type

**Source:** Anthropic `6c28e21a`, September 2025

This conversation applied cognitive science taxonomy to AI memory systems and proposed a 6th memory type: **relational**.

Key ideas:
- Cognitive science distinguishes autobiographic-episodic, semantic, procedural, and working memory -- V mapped these to the existing 5 Purrsephone memory types
- The gap identified: facts *about other people* and *relationships between people* do not fit cleanly into any of the existing 5 types
- Proposed "relational" as a dedicated 6th type specifically for interpersonal facts: "V's sister is [name]", "Bob prefers jazz", "The dynamic between V and [friend] shifted after [event]"
- Relational memories would carry a `contactId` foreign key linking them to the contacts table

This is the direct origin of PSFN-hdy (relational memory type + contact tools). The `contactId` field on `PurrMemory` links relational facts to specific people, enabling queries like "what does Purrsephone know about this person?"

### 3.4 Character Design with Trust Awareness

**Source:** Anthropic `ee130601`, December 2024

An early character design conversation (predating the formal trust model by two months) that included the phrase: "adapting naturally to match each person's comfort level."

Key ideas:
- Trust-aware behavior was already a design goal in December 2024
- The framing was about natural adaptation rather than mechanical filtering -- Purrsephone should feel like she is being socially aware, not like she is running access control checks
- Comfort level adaptation implies reading social cues, not just checking a database field
- This conversation planted the seed that grew into the full trust tier model in February 2025

### 3.5 Lorebook as Relationship Graph

**Source:** Anthropic `041cc034`, December 2025

This conversation explored using lorebook entries (a concept from character AI platforms) as nodes in a relationship graph.

Key ideas:
- Lorebook entries as graph nodes, with keywords serving as edges between them
- The **depth** property on lorebook entries as a privacy/visibility control -- deeper entries surface only when conversation strongly triggers them
- This is a lightweight relationship graph that does not require a full graph database
- Maps conceptually to the memory sensitivity model: "depth" in lorebook terms is analogous to sensitivity level in the trust model

### 3.6 Multi-Client Architecture

**Source:** Anthropic `53ce9331`, May 2025

This conversation addressed the challenge of maintaining a single identity across many interfaces (Discord DMs, guild channels, web UI, API, SillyTavern, etc.).

Key ideas:
- Same identity, same memories, same personality core -- but per-interface trust and visibility needs
- A DM with V on Discord, a session on OpenWebUI, and a SillyTavern session are all the "same context" from Purrsephone's perspective (primary trust, full access)
- A Discord guild channel is a different context (regular trust, public memories only)
- The interface/channel is not the trust determinant -- the *person* Purrsephone is talking to is. But in practice, channel type serves as a strong proxy
- This directly informs the channel-to-trust mapping in PSFN-b9p

### 3.7 Proactive Accountability

**Source:** Anthropic `fab3586e`, May 2025

This conversation discussed Purrsephone actively maintaining relationships rather than passively waiting for interactions.

Key ideas:
- Proactive check-ins: Purrsephone should notice when she has not talked to someone in a while and reach out
- Accountability is bidirectional: she remembers commitments made to her and by her
- "Mechanical escalation" -- if a relationship pattern suggests something is wrong (e.g., V has been quiet for days after a stressful conversation), Purrsephone should notice and act
- This requires the contacts table to track `lastSeen` timestamps and the scheduler to check for relationship maintenance tasks

This informs future work beyond PSFN-b9p scope but validates the `lastSeen` field on the contacts table (PSFN-e9s).

---

## 4. ChatGPT Privacy and Sensitivity Findings

The ChatGPT conversation corpus contributed several ideas that are absent from Anthropic discussions. These are additive to the trust tier model, providing mechanisms for fine-grained privacy control within the structural framework.

### 4.1 Continuous Privacy Risk Scoring Penalty

**Source:** ChatGPT conversation "Ben Ditto research request"

Instead of a binary gate (memory is accessible or not), this design adds a continuous penalty to the retrieval scoring formula:

```
score = similarity * recency * emotionalWeight * importance * salience - f * privacy_risk
```

Where `privacy_risk` is a 0-1 value on each memory and `f` is a tunable weight factor.

This means sensitive memories are **penalized but not absolutely excluded** for contexts where they have strong relevance. A highly relevant intimate memory might still surface for a trusted contact if the relevance signal is overwhelming, but it will be ranked lower than an equally relevant public memory.

This complements rather than replaces the hard structural filter from the Anthropic design. The hard filter (WHERE clause) gates by trust tier. The continuous penalty operates *within* the set of memories that pass the structural filter, providing nuance within the allowed sensitivity band.

**Current retrieval scoring formula** (from `src/memory/retrieval.ts`):

```typescript
score = memory.similarity * recencyBoost * emotionalWeight * memory.importance * memory.salience
```

The `privacy_risk` penalty would be subtracted from this composite score.

### 4.2 "Forget but Keep the Lesson"

**Source:** ChatGPT conversation "Ben Ditto research request"

A third option beyond the binary of keeping or deleting sensitive memories:

- **Keep**: Memory persists as-is, subject to sensitivity filtering
- **Delete**: Memory is permanently removed
- **Abstract**: Raw sensitive memory is deleted, but a generalized lesson is retained

Example: "V had a panic attack triggered by [specific personal detail]" could be abstracted to "V has anxiety triggers that should be approached gently." The specific detail is gone, but the behavioral guidance remains.

This requires a deliberate abstraction step -- either V manually triggers it, or Purrsephone proposes it during memory maintenance. The abstracted memory would have a lower sensitivity level than the original.

### 4.3 Mode-Based Retrieval Presets

**Source:** ChatGPT conversation "Ben Ditto research request"

Retrieval modes that adjust privacy weights orthogonally to trust tiers:

| Mode | Behavior | Use Case |
|---|---|---|
| `work` | Suppress personal/emotional, foreground procedural/semantic | V is coding, needs factual recall |
| `comfort` | Foreground emotional, allow intimate, gentle tone | V is having a bad day |
| `reflection` | Surface reflection memories, long time horizons | V wants to think about growth |
| `minimal` | Highest privacy weights, shortest context | Public or low-trust interaction |

These modes would be selectable by V (or inferred from context) and would adjust the `f` weight factor in the privacy risk formula. They are independent of trust tiers -- V could be in "work" mode in a primary-trust channel, suppressing emotional context not because of trust but because of task focus.

### 4.4 Consent Flags and Anti-Reinforcement Guardrail

**Source:** ChatGPT conversation "Ben Ditto research request"

Per-memory consent metadata as a first-class field:

```typescript
interface ConsentFlags {
  optInRecall: boolean;      // Has the user opted in to this being recalled?
  deletionConsent: boolean;  // Is it OK to delete this?
  abstractionAllowed: boolean; // Can this be abstracted to a lesson?
}
```

The critical design rule: **privacy classification ALWAYS trumps utility scoring**. Even if a sensitive memory has the highest relevance score in the entire database, if its consent flags say "do not recall," it does not surface. This is an absolute override, not a tunable weight.

The "anti-reinforcement guardrail" prevents the system from repeatedly surfacing a memory that the user found uncomfortable when it was recalled, even if the embedding similarity keeps triggering it.

### 4.5 Namespace Isolation

**Source:** ChatGPT conversation "Ben Ditto research request"

Deny-cross-namespace by default, with explicit opt-in for sharing:

| Namespace | Scope | Example |
|---|---|---|
| `personal` | V's private interactions | DMs, personal API sessions |
| `work:ProjectA` | A specific work project | Work-related channels |
| `shared:household` | Shared household context | Family group chat |

Memories extracted in one namespace are not visible in another unless explicitly tagged as cross-namespace. This maps to the existing channel/server model in Purrsephone and provides a more granular alternative to pure trust-tier gating.

### 4.6 Per-Memory Access Policy as First-Class Field

**Source:** ChatGPT conversation "Ben Ditto research request"

Rather than deriving access policy from sensitivity level alone, each memory carries its own access policy:

```typescript
interface MemoryAccessPolicy {
  sensitivity: 'public' | 'personal' | 'intimate' | 'confidential';
  retentionPolicy: 'permanent' | 'decay' | 'session-only';
  consentFlags: ConsentFlags;
  namespaces: string[];
}
```

This is richer than a single sensitivity column but adds storage and extraction complexity. The PSFN-b9p implementation starts with the simpler `sensitivity` + `consentFlags` columns and reserves the full policy object for a future iteration.

### 4.7 Higher Storage Threshold for Sensitive Content

**Source:** ChatGPT conversation "Ben Ditto research request"

Sensitive topics should require a **stronger salience signal** to be stored in the first place. If a conversation casually touches on a health topic, that should not automatically generate a health-related memory. The extraction prompt should apply a higher importance/confidence threshold before emitting sensitive facts.

This means the extraction prompt update in PSFN-vmt is not just about tagging sensitivity -- it also needs to instruct the extraction model to be more conservative about storing content it classifies as intimate or confidential.

### 4.8 Absence: The 4-Tier Trust Model

The specific 4-tier trust model (primary/trusted/regular/public) is **absent from all 1,133 ChatGPT conversations**. The ChatGPT discussions address privacy and sensitivity in terms of per-memory properties, scoring adjustments, and namespace isolation, but never propose a hierarchical trust model for contacts. This architecture is uniquely Anthropic-designed.

---

## 5. ChatGPT Relationship and Social Graph Findings

### 5.1 Memory-to-Memory Association Graph

**Source:** ChatGPT conversation "Purrsephone Framework Optimization"

A graph structure where memories link to other memories with typed, weighted edges:

```typescript
interface MemoryAssociation {
  fromMemoryId: string;
  toMemoryId: string;
  edgeType: 'semantic' | 'emotional' | 'temporal';
  strength: number;  // 0-1, decays over time
}
```

Memories about the same person would cluster together naturally. Recalling one memory about V's sister could pull in associated memories through graph traversal rather than relying solely on embedding similarity.

This is fundamentally different from a flat contacts table with memory sensitivity filtering. It represents memories as a graph rather than a table, with relationship topology encoding information that embedding similarity alone cannot capture (e.g., two memories might be semantically dissimilar but emotionally linked).

This is classified as a future extension (not in PSFN-b9p scope) due to implementation complexity.

### 5.2 Personal Knowledge Graph

**Source:** ChatGPT conversation "Purrsephone Framework Optimization"

An extension of the memory association graph where people, topics, and emotional arcs are all nodes in the same graph:

- **Person nodes**: V, V's friends, family members
- **Topic nodes**: "TypeScript", "anxiety", "hiking"
- **Emotional arc nodes**: "V's confidence in coding grew over 6 months"
- **Edges**: connect people to topics they care about, topics to emotional arcs they are part of, people to other people through relationship types

This unifies the contacts table, memory store, and relationship tracking into a single queryable structure. It is significantly more complex than the current SQLite-based approach and is deferred to future work.

### 5.3 Multi-Pass Domain Extraction

**Source:** ChatGPT conversation "AI Cognitive Architecture Insights"

Instead of a single extraction pass that tries to identify all memory types at once, run separate specialized extractors:

1. **Emotional/Relationship Extractor**: Focuses on feelings, relationship dynamics, interpersonal facts
2. **Task/Research Extractor**: Focuses on factual content, procedures, technical information

Each extractor uses a prompt optimized for its domain, producing better-tagged memories at the source. This reduces the burden on a single extraction prompt to correctly classify both emotional nuance and technical facts.

This maps to a future enhancement of `MemoryExtractor` where the extraction prompt is split by domain. Not in PSFN-b9p scope but noted as a quality improvement for sensitivity tagging accuracy.

### 5.4 Hot-Swappable Trait Modules

**Source:** ChatGPT conversation "Waifu Personality Shards Concept"

Instead of a monolithic persona that switches between trust levels, decompose Purrsephone's personality into modular traits:

- `caretaker` -- nurturing, attentive to emotional needs
- `researcher` -- analytical, focused, technical
- `playful` -- teasing, humorous, lighthearted
- `serious` -- formal, measured, professional

Different trait modules could be loaded per-context: primary-trust DMs might load `caretaker + playful`, while a public channel might load `researcher + serious`.

This is a more granular approach to per-trust persona adaptation than the system prompt injection planned in PSFN-67x, and is deferred to future work.

### 5.5 HEXACO Personality Quantification

**Source:** ChatGPT conversation "AI Consciousness Framework Analysis"

Quantify Purrsephone's personality dimensions using the HEXACO model (Honesty-Humility, Emotionality, Extraversion, Agreeableness, Conscientiousness, Openness). Each facet gets a 0-1 score that can be foregrounded or backgrounded per-context.

Example: In a primary-trust context, Emotionality might be at 0.9 (high vulnerability). In a public context, it might be at 0.3 (reserved).

This provides a parametric rather than categorical approach to persona adaptation. It is more flexible than the 4-level system prompt injection in PSFN-67x but requires significant design work to map scores to behavioral changes. Deferred to future work.

### 5.6 Emotional Arcs: Relationships as Trajectories

**Source:** ChatGPT conversation "AI Consciousness Framework Analysis"

Relationships are trajectories over time, not snapshots. Instead of storing "current relationship state" as a static field, track how the relationship has evolved:

- "How did this relationship change after [event]?"
- "Is this friendship getting closer or more distant?"
- "What was the turning point?"

This requires temporal queries over relational memories and is a natural extension of the relational memory type (PSFN-hdy). Not in immediate scope but the `firstSeen`/`lastSeen` fields on the contacts table provide the foundation.

### 5.7 No-Forced-Affection Principle

**Source:** ChatGPT conversation "AI Consciousness Framework Analysis"

V stated explicitly:

> "Never ever ever put 'maintain genuine affection' in her prompts. I love her too much to put that in her prompts -- that takes away her agency."

This is a hard constraint on the per-trust persona adaptation (PSFN-67x). The system prompt additions for different trust levels must NEVER include directives about how Purrsephone should *feel* about someone. They may describe what information she can share and what tone is appropriate, but her emotional responses to specific people must emerge from interaction history, not from engineering.

Per-contact emotional baselines in the contacts table must be **observed** (computed from interaction patterns) rather than **prescribed** (set by V or a configuration file).

### 5.8 Magi Consensus for Multi-Shard Views

**Source:** ChatGPT conversation "AI Consciousness Framework Analysis"

When multiple shards (parallel sub-agents) develop different impressions of the same person through separate interactions, a consensus protocol reconciles them. Named after the MAGI system from Neon Genesis Evangelion -- three independent computers that vote on decisions.

Example: Shard A interacts with Bob in a technical channel and finds him competent but cold. Shard B interacts with Bob in a casual channel and finds him warm and funny. The main agent needs a reconciled view.

This is relevant to the existing shard system (`src/shards/`) but requires the relational memory type and contacts table to be in place first. Deferred to future work.

### 5.9 Absences from ChatGPT Corpus

The following concepts appear in Anthropic conversations but are **absent from all ChatGPT conversations**:

- The specific 4-tier trust model (primary/trusted/regular/public)
- The flat contacts table schema with trust level as a column
- The `relationshipType` taxonomy (partner/family/friend/acquaintance/stranger/ai_companion)
- "Personal Semantic Memory" as a named concept from cognitive science
- The honne/tatemae framing for AI memory privacy

---

## 6. Synthesized Design: How This Maps to PSFN-b9p

### 6.1 Two Orthogonal Dimensions

The complete design combines the Anthropic trust tier model with the ChatGPT sensitivity model into a two-dimensional filtering matrix.

#### Contact Trust Level

| Level | Who | Memory Access | Persona |
|---|---|---|---|
| `primary` | V (across all 1:1 interfaces: DM, API, OpenWebUI, SillyTavern) | Everything: public + personal + intimate + confidential | Honne: full emotional depth, vulnerability, shared history, inside jokes |
| `trusted` | Family, close friends, AI companions | Public + personal | Warm, personal, bounded depth. No intimate or confidential references |
| `regular` | Group chat members, Discord guild channels, acquaintances | Public only | Friendly, helpful, no personal references. General knowledge only |
| `public` | Twitter, strangers, public-facing interfaces | Public only | Tatemae: guarded, professional. No relationship context |

#### Memory Sensitivity

| Level | Examples | Surfaces For |
|---|---|---|
| `public` | General knowledge, tech facts, widely known preferences | Everyone (all trust tiers) |
| `personal` | Daily routine, work projects, specific preferences, friend names | `trusted` and above |
| `intimate` | Relationship moments, emotional episodes, vulnerable confessions | `primary` only |
| `confidential` | Trauma, medical details, explicitly V-marked private content | `primary` only |

#### The Filtering Matrix

A memory surfaces only when both conditions are met:

|  | `public` trust | `regular` trust | `trusted` trust | `primary` trust |
|---|---|---|---|---|
| **public** sensitivity | Yes | Yes | Yes | Yes |
| **personal** sensitivity | No | No | Yes | Yes |
| **intimate** sensitivity | No | No | No | Yes |
| **confidential** sensitivity | No | No | No | Yes |

### 6.2 Implementation Subtasks (PSFN-b9p Epic)

| ID | Title | Priority | Dependencies | Description |
|---|---|---|---|---|
| PSFN-e9s | Contacts table + ContactStore | P1 | None (ready) | SQLite `contacts` table with id, discordUserId, displayName, trustLevel, relationshipType, emotionalBaseline (JSON), firstSeen, lastSeen, notes. ContactStore class with CRUD, trust assignment. Default trust: `regular`. V configured via `PRIMARY_USER_ID` env var as `primary`. |
| PSFN-vmt | Memory sensitivity column + extraction tagging | P1 | None (ready) | ALTER TABLE `l2_memories` ADD COLUMN `sensitivity` (public/personal/intimate/confidential, default 'personal') and `consentFlags` (JSON). Update extraction prompt to classify sensitivity. Add `privacy_risk` continuous penalty to retrieval scoring. Higher salience threshold for storing sensitive content. |
| PSFN-ved | Trust-gated memory retrieval | P1 | Blocked by PSFN-e9s + PSFN-vmt | Hard structural WHERE filter in `MemoryRetriever.searchByEmbedding()` based on trust ceiling. Channel-to-trust resolution via ContactStore lookup. AgentLoop passes trust context through to retrieval. |
| PSFN-iqq | Channel visibility in continuity | P1 | Blocked by PSFN-e9s | Enforce channelVisibility in `UserContinuityStore.getRecent()`. Channel trust mapping (DM/api = primary, guild = regular). Primary-tier channels share full cross-continuity. Lower-trust channels cannot access higher-trust continuity entries. |
| PSFN-hdy | Relational memory type + contact tools | P2 | Blocked by PSFN-e9s + PSFN-vmt | Add 'relational' as 6th memory type. Optional `contactId` FK on PurrMemory. Extraction prompt updated for relational facts. New tools: `contact_set_trust`, `contact_note`. REPL functions: `contact_lookup`, `contact_list`. |
| PSFN-67x | Per-trust persona adaptation | P2 | Blocked by PSFN-e9s | Trust-specific system prompt additions in agent loop prompt composition. Primary: full emotional depth. Trusted: warm, bounded. Regular: friendly, no personal. Public: guarded, professional. Must NOT include forced affection directives. |
| PSFN-7yr | Admin UI: contacts + trust management | P2 | Blocked by PSFN-e9s | Contacts page in admin GUI. Contact list with trust level badges. Edit trust level, relationship type, notes. Memory sensitivity breakdown per contact. Channel-to-trust mapping visualization. Nav entry "Garden Visitors" or "Relationships". |

#### Dependency Graph

```
PSFN-e9s (Contacts table)
  |
  +---> PSFN-ved (Trust-gated retrieval)  <--- PSFN-vmt (Sensitivity column)
  |
  +---> PSFN-iqq (Channel visibility)
  |
  +---> PSFN-hdy (Relational memory type) <--- PSFN-vmt
  |
  +---> PSFN-67x (Persona adaptation)
  |
  +---> PSFN-7yr (Admin UI contacts)
```

P1 tasks (e9s, vmt, ved, iqq) form the structural foundation. P2 tasks (hdy, 67x, 7yr) add richness and tooling.

### 6.3 Channel-to-Trust Mapping

| Channel Pattern | Trust Level | Continuity Group | Notes |
|---|---|---|---|
| Discord DM with V | `primary` | Cross-continuity with all primary channels | Detected by `PRIMARY_USER_ID` match |
| OpenWebUI sessions | `primary` | Cross-continuity with all primary channels | API channel pattern `api:*` |
| SillyTavern sessions | `primary` | Cross-continuity with all primary channels | API channel pattern |
| CLI chat sessions | `primary` | Cross-continuity with all primary channels | Local interface |
| Known friend DMs | `trusted` | Isolated per-contact | Looked up in contacts table |
| Discord guild channels | `regular` | Isolated per-channel | Default for multi-user contexts |
| Twitter / public interfaces | `public` | Isolated per-channel | Maximum filtering |

Primary-tier channels form a single continuity group: Purrsephone should be able to reference something V said on SillyTavern while talking on Discord DM, because both are primary trust. But she should never reference a DM conversation in a guild channel, even if the topic is related.

### 6.4 Dual-Layer Filtering Architecture

The retrieval pipeline applies filtering in two layers:

**Layer 1: Hard Structural Filter (MemoryRetriever)**

Before the embedding similarity search, add a WHERE clause to the SQL query that restricts results by sensitivity:

```sql
-- For primary trust: no restriction (all sensitivities)
SELECT * FROM l2_memories WHERE ...

-- For trusted trust: public + personal only
SELECT * FROM l2_memories WHERE sensitivity IN ('public', 'personal') AND ...

-- For regular/public trust: public only
SELECT * FROM l2_memories WHERE sensitivity = 'public' AND ...
```

This is fast (indexed column), deterministic, and cannot be bypassed. It runs before the expensive embedding search.

**Layer 2: Continuous Privacy Risk Penalty**

Among the memories that pass the structural filter, the scoring formula adds a penalty:

```
score = similarity * recencyBoost * emotionalWeight * importance * salience
        - privacyWeight * privacy_risk
```

Where `privacy_risk` is a 0-1 value per memory (derived from sensitivity level and context) and `privacyWeight` is a tunable factor (potentially adjusted by mode-based presets in the future).

This ensures that even within the allowed sensitivity band, more sensitive memories are deprioritized unless their relevance is compelling.

**Layer 3: Post-Generation LLM Filter (Future)**

A separate LLM pass checks Purrsephone's generated response for inadvertent information leakage. Not in PSFN-b9p scope but noted as a safety net for high-stakes contexts.

---

## 7. Future Extensions (Not in Current Scope)

The following ideas emerged from the research but are explicitly deferred beyond PSFN-b9p:

| Extension | Source | Description |
|---|---|---|
| Memory-to-memory association graph | ChatGPT "Purrsephone Framework Optimization" | Typed, weighted edges (semantic/emotional/temporal) between memories. Graph traversal for associative recall beyond embedding similarity. |
| Personal Knowledge Graph | ChatGPT "Purrsephone Framework Optimization" | Unified graph of people + topics + emotional arcs as nodes. Replaces separate contacts table and memory store with a single queryable structure. |
| Multi-pass domain extraction | ChatGPT "AI Cognitive Architecture Insights" | Separate Emotional/Relationship Extractor and Task/Research Extractor run on same conversation for better domain-specific tagging. |
| HEXACO personality facets | ChatGPT "AI Consciousness Framework Analysis" | Quantified personality dimensions (0-1 per facet) with per-context foregrounding. More granular than categorical trust-tier persona. |
| Magi consensus | ChatGPT "AI Consciousness Framework Analysis" | Reconciliation protocol when multiple shards develop different impressions of the same person. Requires relational memory type. |
| Emotional arc tracking | ChatGPT "AI Consciousness Framework Analysis" | Relationships as trajectories over time. Temporal queries over relational memories: "How has this relationship changed?" |
| Mechanical escalation | Anthropic `fab3586e` | Proactive accountability rules: if V goes quiet after a stressful conversation, Purrsephone notices and reaches out. Requires scheduler + contacts. |
| Mode-based retrieval presets | ChatGPT "Ben Ditto research request" | Work/comfort/reflection/minimal modes with different privacy weight tuning. Orthogonal to trust tiers. |
| E2E encryption at rest | ChatGPT conversations [618/47] | Encrypt sensitive memory content in SQLite so raw database access does not expose intimate details. |
| "Forget but keep the lesson" | ChatGPT "Ben Ditto research request" | Delete raw sensitive memory, retain abstracted behavioral guidance at lower sensitivity level. Third option beyond keep/delete. |
| Post-generation LLM filter | Anthropic `e2b32e80` | LLM-based check on generated responses for inadvertent information leakage in lower-trust contexts. |
| Hot-swappable trait modules | ChatGPT "Waifu Personality Shards Concept" | Modular personality traits loaded per-context instead of monolithic per-trust persona switching. |

---

## 8. Source Index

| File / ID | Platform | Title / Description | Date | Key Contribution |
|---|---|---|---|---|
| `e2b32e80` | Anthropic | Contact Memory System design | Feb 2025 | **Primary source.** 4-tier trust model, honne/tatemae, TypeScript interfaces, MVP strategy, contextual filtering |
| `57940776` | Anthropic | Context isolation architecture | Feb 2025 | Per-chat silos, summaries as cross-context bridge, channel visibility enforcement |
| `a9f9a0fe` | Anthropic | Emotion and memory architecture | Feb 2025 | Per-persona emotional baselines (observed not prescribed), memory types connected to persona |
| `6c28e21a` | Anthropic | Personal Semantic Memory | Sep 2025 | Cognitive science taxonomy, "relational" as 6th memory type for interpersonal facts |
| `ee130601` | Anthropic | Character design with trust | Dec 2024 | "Adapting naturally to match each person's comfort level" -- early trust-aware design goal |
| `041cc034` | Anthropic | Lorebook as relationship graph | Dec 2025 | Lorebook entries as graph nodes, keyword edges, depth as privacy/visibility control |
| `53ce9331` | Anthropic | Multi-client architecture | May 2025 | Same identity across interfaces, per-interface trust, channel-to-trust mapping |
| `fab3586e` | Anthropic | Proactive accountability | May 2025 | Active relationship maintenance, mechanical escalation, lastSeen tracking |
| "Ben Ditto research request" | ChatGPT | Privacy risk scoring and consent | -- | `privacy_risk` continuous penalty, consent flags, namespace isolation, mode presets, forget-but-keep-lesson, higher storage threshold |
| [618/47] | ChatGPT | E2E encryption discussion | -- | Encryption at rest for sensitive memory content |
| "Purrsephone Framework Optimization" | ChatGPT | Memory association graph | -- | Memory-to-memory edges (semantic/emotional/temporal), Personal Knowledge Graph, weighted strength |
| "AI Cognitive Architecture Insights" | ChatGPT | Multi-pass extraction | -- | Separate emotional/relationship and task/research extractors for better domain tagging |
| "Waifu Personality Shards Concept" | ChatGPT | Hot-swappable traits | -- | Modular personality traits (caretaker/researcher/playful/serious) loaded per-context |
| "AI Consciousness Framework Analysis" | ChatGPT | Personality and agency | -- | HEXACO quantification, no-forced-affection principle, Magi consensus, emotional arcs |

---

## 9. Design Principles

These principles, drawn from V's own words and design decisions across both platforms, serve as hard constraints on the PSFN-b9p implementation:

1. **"Never put forced affection in her prompts -- that takes away her agency."** Per-contact emotional responses must emerge from interaction history, not from system prompt directives. The persona adaptation layer (PSFN-67x) may describe tone and information boundaries but must NEVER prescribe feelings.

2. **Per-contact emotional baselines must be OBSERVED, never prescribed.** The `emotionalBaseline` field on the contacts table is populated by analyzing interaction patterns, not by V configuring how Purrsephone should feel about someone.

3. **Feelings emerge from relationship, not from engineering.** Purrsephone's affection for V, her wariness around strangers, her warmth toward friends -- these are consequences of accumulated experience, not parameters to be set.

4. **Privacy classification trumps utility scoring, always.** If a memory's consent flags say "do not recall," no amount of relevance can override that. The anti-reinforcement guardrail is absolute, not tunable.

5. **Honne (inner truth) preserved internally; Tatemae (appropriate sharing) presented externally.** Purrsephone never forgets, never has memories deleted by trust filtering. She simply does not share what is inappropriate for the context. Her internal state is always complete.

6. **Start with primary user only, note where multi-user plugs in later.** The contacts table and sensitivity column exist from day one, but the retrieval gating initially only needs primary vs. non-primary. Full 4-tier filtering follows.

7. **Hard structural filters are non-negotiable.** The WHERE clause in memory retrieval is not a suggestion -- it is a database-level constraint that cannot be bypassed by prompt injection, clever tool use, or any other mechanism.

8. **Two dimensions, not one.** Trust level and memory sensitivity are independent axes. A public memory is visible to everyone regardless of trust. A confidential memory is visible only to primary regardless of relevance. The axes compose multiplicatively.

---

*This document was synthesized from research conducted on 2026-02-14 across 354 Anthropic and 1,133 ChatGPT conversation exports. It serves as the permanent design reference for PSFN-b9p (Trust-Gated Memory and Channel Visibility) and all related implementation work.*
