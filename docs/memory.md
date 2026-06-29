# Memory

PSFN memory is not a single store. The runtime combines append-only session history, typed long-term memories, continuity artifacts, contact state, and a few small high-priority ledgers.

Last updated: 2026-06-29.

## Layers That Exist Today

### L0: Session history

- Per-channel append-only JSONL in `sessions/`
- Built by `SessionStore` and assembled by `SessionManager`
- Remains the canonical turn history
- The archive seam should be `SessionArchivePort`; DB mirrors and searches belong behind projection/search ports, not as alternate archive truth.

### L0.1: Episodic landmarks

- Stored in PostgreSQL through the runtime episodic store tables `l01_episodes`, `l01_episode_spans`, `l01_episode_arcs`, lineage, review, candidate, and watermark tables
- Represents bounded lived episodes with L0 span/artifact provenance, salience, affect, themes, participants, thread IDs, and channel IDs
- Created during configured rest/me-time windows after user inactivity by the sleeptime episodic synthesizer
- Allows multiple episodes per day; a long-running theme is a graph of linked episodes, not one large aggregate record
- Retrieved before raw span/artifact drill-down so L1 can search a scoped episode chain instead of all chats and all memories
- Exposed in Garden through the episodic memory page for episode, provenance, arc, and thread inspection
- Must stay separate from L2 typed memories and from generic transcript summary/vector caches

### L1: Active context assembly

- Built on demand by `SessionManager`
- Mixes recent session entries, continuity, prompt layers, active orientation, retrieved L2 memory, and L0.1 episodic landmarks
- Applies token budgets, temporal history bounds, compaction thresholds, focus compaction ranges, and observation masking
- Operates as a sliding active context window. It can retain a recent verbatim tail, summarize older in-window entries, and carry forward previous compaction summaries without changing L0 canonical history.

### L2: Typed long-term memories

- Stored in PostgreSQL through `PostgresMemoryStore`
- Embedded with the configured embeddings provider and indexed/searchable through `pgvector`
- Retrieved by `MemoryRetriever`
- Written through `MemoryWriter` and `MemoryExtractor`
- The storage contract stays async-safe at the port level so tests, repair utilities, and legacy migration code can exercise adapters without leaking storage details into callers.
- The supported memory path stores embeddings in `l2_memories.embedding` via `pgvector` and performs database-side similarity search. Missing `pgvector` support is a fail-closed startup error, not a silent fallback to app-side array scanning.
- SQLite/sqlite-vec code remains only for legacy migration utilities and adapter tests; it is not a runtime default.

### Parallel memory/state artifacts

- `contacts/` continuity files
- reflection journal entries under `notes/reflections/journal.jsonl`
- append-only daily reflection journals under `notes/reflections/daily/`
- append-only long-process reflection logs under `notes/reflections/process-logs/`
- active orientation persisted in `core_memory.json`
- contact profiles, social graph state, concerns, intentions, internal state, and follow-ups in PostgreSQL stores
- scratchpad mirror at `notes/scratchpad.json`
- memory mutation journal at `notes/memories.jsonl`

## Orientation, Long-Term Memory, And Scratchpad

- `orient` is the model-facing surface for active orientation: persona, human, and goals blocks kept hot in context.
- Orientation storage intentionally remains on legacy `core_memory.json` paths for now; the runtime rename is model-facing rather than a persistence migration.
- Long-term memory lives in the typed `memory` store and is retrieved selectively; it is not the same thing as active orientation.
- `scratchpad` remains an explicit ephemeral workspace for bulky temporary material and working notes, not canonical memory.
- `wiki` is the workspace-backed durable reference surface for authored notes, imported documents, curated references, and personal knowledge-base material.
- Ephemeral scratchpad notes and managed temp artifacts now follow an explicit retention policy from `scheduler.json`. Durable artifacts promoted into the research library are exempt from lifecycle cleanup.

### Scratchpad

Scratchpad is a separate semantic surface, not a subtype of long-term memory.

- Lives in runtime scratchpad storage with an optional mirror at `notes/scratchpad.json`; live runtime state is Postgres-backed where scratchpad rows are persisted through the active runtime store
- Holds temporary long-context notes, excerpts, rolling summaries, and working hypotheses for large source material
- Is bounded and intentionally ephemeral; it helps the current work, not durable recall
- Must stay distinct from `orient`, which is active canon, and from typed long-term `memory`, which is durable retrieval state
- Should be promoted only when the content stabilizes:
  - stable facts or relational knowledge go to `memory`
  - durable operator-authored notes, imported documents, and artifacts go to `wiki` or repo docs
  - active self-orientation belongs in `orient`

### Wiki / Knowledge Base

Wiki documents are stable reference knowledge, not lived memory.

- Live under `WORKSPACE_PATH/knowledge/wiki/` with document bodies and metadata stored in deterministic subtrees
- Hold durable authored notes, imported partner-vault notes, parsed documents, generated syntheses, external references, and system seeds
- Carry source class, provenance references, sensitivity, timestamps, and revision metadata
- Stay distinct from L0 transcript history, L0.1 episodic landmarks, L2 typed memory, scratchpad, journal files, and current orientation
- May link to memory/session records by provenance reference, but the wiki body does not become L0/L0.1/L2 memory by default
- Imports from Obsidian/Vault or other external sources require explicit source class and provenance and fail closed when those fields are missing

The legacy `vault`/Obsidian surface is an optional external source bridge. It is not the canonical personal long-term storage surface.

## Memory Types

The current runtime supports seven memory types:

- `episodic`
- `semantic`
- `emotional`
- `procedural`
- `boundary`
- `reflection`
- `relational`

This is broader than the older six-type description. `boundary` is a first-class memory type and matters for trust, consent, and retrieval gating.

`episodic` as an L2 memory type is still a typed long-term memory category. It is not the same as L0.1 `l01_episodes`. L0.1 episodes are provenance-bearing landmarks and graph edges used to scope recall; L2 episodic memories are ordinary rows in the typed long-term memory store.

## Stored Memory Metadata

Each memory can carry:

- importance
- confidence
- emotional valence
- optional VAD formation state
- tags
- scope references and scope tags
- provenance refs
- sensitivity and consent flags
- retention class (`standard` or `durable`)
- optional contact binding

High-value relational memories can be promoted into durable retention automatically.

## Write Path

The current write pipeline is:

1. `MemoryExtractor` decides whether a channel turn should trigger extraction.
2. Extraction prompts run through the prompt registry and LLM orchestration.
3. Facts are parsed from XML and scored for importance, confidence, novelty, and emotional signal.
4. `MemoryWriter` performs deduplication, contradiction handling, retention normalization, and embedding write.
5. `MemoryStore` persists the row, vector, and journal/audit side effects.
6. Contact-local emotional state and profile synthesis can be refreshed from accepted writes.

Extraction can also run in crash recovery and pre-compaction paths, not only after a normal turn.

## Direct And Group Memory Modes

Long-term extraction has an explicit memory-mode contract:

- `direct` uses the normal lightweight 1:1 extraction cadence and caps.
- `group` uses group-room windowing, attribution, salience gates, write caps, profile refresh coverage, telemetry, and backfill limits.
- `auto` chooses between direct and group behavior from channel topology plus recent canonical human participants.

The canonical runtime owner for group-memory defaults is `settings.json` under `groupMemory`. The canonical channel owner for manual provider or channel overrides is `channels.json` under `discord.groupMemory`. The same knob names are used in both places: mode, participant window, trigger thresholds, chunk sizes, overlap, cooldowns, backlog limits, salience thresholds, salience reason weights, candidate-span caps, neighboring context size, low-signal skip rules, write caps, per-contact/per-subject caps, time-window write caps, backfill write caps, write-ranking weights, address-mode weights, profile refresh thresholds, telemetry visibility, and backfill limits.

Manual `memoryMode` overrides auto detection. A per-channel override can force a Discord channel to `direct` or `group` even when topology is ambiguous. Auto mode treats Discord guild channels and threads as group-capable and Discord private 1:1 conversations as direct. A group-capable channel with only one recent canonical human speaker falls back according to `groupMemory.autoDetection.fallbackModeWhenOneHuman`, which defaults to `direct`.

Recent participant detection must use a rolling window from `groupMemory.autoDetection.recentParticipantWindowMessages` and `groupMemory.autoDetection.recentParticipantWindowMs`. Historical channel activity can inform that a room is group-capable, but it must not force all future extraction into high-volume group processing forever. Companion, system, API-principal, and bot contacts are excluded from the human participant count unless explicitly configured as human-relevant or AI-companion participants.

Group mode changes memory extraction only. It must never cause an observed message to receive a reply and must not relax retrieval privacy or cross-contact memory boundaries.

### Group-Memory Settings

All group-memory knobs are JSON-owned. Defaults live in `settings.json` under `groupMemory`; channel overrides live in `channels.json` under `discord.groupMemory`. Operators should tune those owner files, not code, and then use Garden diagnostics to confirm the resolved per-channel values.

Top-level settings:

- `enabled`: enables the group-memory subsystem.
- `memoryMode`: default mode, one of `direct`, `group`, or `auto`.

Auto-detection settings:

- `autoDetection.recentParticipantWindowMessages`: how many recent messages to scan for participant classification.
- `autoDetection.recentParticipantWindowMs`: time window for the same participant scan.
- `autoDetection.minDistinctHumanContacts`: human participant count required for `auto` group classification.
- `autoDetection.groupCapableChannelTypes`: provider channel types that may be group rooms.
- `autoDetection.fallbackModeWhenOneHuman`: direct or group behavior when a group-capable room has one recent human.
- `autoDetection.excludeCompanionContact`, `excludeSystemContacts`, `excludeApiPrincipals`, `excludeBotContacts`, `includeAiCompanions`: participant filters for the classification window.

Online extraction settings:

- `onlineExtraction.observedMessageTriggerCount`: unread observed-message count that can trigger group extraction.
- `onlineExtraction.observedTimeTriggerMs`: max wait before a time-triggered extraction may run.
- `onlineExtraction.maxMessagesPerChunk`: live chunk size for one extraction range.
- `onlineExtraction.maxEstimatedTokensPerChunk`: token ceiling for a chunk.
- `onlineExtraction.chunkOverlapMessages`: context overlap between chunks.
- `onlineExtraction.cooldownMs`: per-channel cooldown after scheduling extraction.
- `onlineExtraction.backlogLagTriggerMessages`: unread lag that can force backlog catch-up.
- `onlineExtraction.maxBacklogChunksPerRun`: max online chunks per run.

Normal live group windows should be tuned to room velocity. The default shape is deliberately in the 50-100 message range (`observedMessageTriggerCount` defaults to 50, `maxMessagesPerChunk` to 75, and backlog lag to 100). Large historical rooms must be handled by bounded backfill, not by making the live hot path consume one fixed giant batch.

Salience settings:

- `salience.minImportance`, `minConfidence`, `minNovelty`: write gates applied after extraction.
- `salience.minCandidateScore`: pre-LLM candidate threshold for group ranges.
- `salience.maxCandidateSpansPerChunk`: max candidate spans selected per chunk.
- `salience.neighboringContextMessages`: neighboring messages included around selected candidates.
- `salience.reasonWeights.companionMention`, `directAddress`, `participantFact`, `explicitPreference`, `relationshipClaim`, `boundarySafety`, `commitment`, `emotionalEvent`, `durablePlan`: score weights for durable group signals.
- `salience.lowSignalRules.enabled`, `shortMessageMaxChars`, `repeatWindowMessages`, `repeatThreshold`, `lowInformationPenalty`: filters for chatter and repeated low-information messages.

Write-cap settings:

- `writeCaps.maxWritesPerRun`, `maxWritesPerChunk`, `maxWritesPerContact`, `maxWritesPerSubject`: group write ceilings.
- `writeCaps.maxLowSalienceWritesPerRun`: cap for lower-salience accepted facts.
- `writeCaps.maxWritesPerBackfillRun`: separate catch-up/backfill write ceiling.
- `writeCaps.maxWritesPerTimeWindow` and `timeWindowMs`: rolling write ceiling.
- `writeCaps.lowSalienceThreshold`: threshold used by the low-salience cap.
- `writeCaps.rankingWeights.importance`, `novelty`, `confidence`, `addressMode`, `relationshipRelevance`, `emotionalIntensity`, `perContactCoverage`: candidate ranking weights.
- `writeCaps.addressModeWeights.directToCompanion`, `mentionOfCompanion`, `replyToUser`, `overheardRoomContext`, `systemApi`: ranking weights for how the message reached the companion.

Profile, telemetry, and backfill settings:

- `profileRefresh.enabled`, `minAcceptedWritesPerContact`, `minSourceMemories`, `cooldownMs`: profile refresh coverage and throttling.
- `telemetry.enabled`, `exposeGardenDiagnostics`, `maxDiagnosticMemoryScan`: group-memory telemetry and Garden diagnostic exposure.
- `backfill.maxMessagesPerRun`, `maxChunksPerRun`, `maxLlmCallsPerRun`, `cooldownMs`: operator backfill ceilings.

Group extraction preserves attribution separately from ownership. Accepted group memories can carry source speaker/contact, subject contact, trigger contact, address mode, source message IDs, source span, and conversation scope. Ambiguous mixed-speaker facts fail closed. A participant being in the same room does not grant them access to another participant's private memories during retrieval.

## Compaction And Carry-Forward

Compaction is context-window maintenance, not a replacement memory layer.

- L0 session JSONL remains canonical. Compaction changes what is carried into L1 context; it does not delete or rewrite the source archive.
- Between turns, `SessionManager.scheduleAutoCompactionBetweenTurns()` can queue background compaction after a turn. Foreground context assembly reports pending compaction and normally runs in deferred mode.
- When compaction runs, the oldest half of the selected recent context is summarized, the newer half remains available as recent verbatim history, and the summary is stored with source-hash and preservation metadata.
- Before compaction summarizes entries, the memory extractor gets a pre-compaction flush opportunity so salient facts are not lost before the active window shrinks.
- Stored compaction summaries are wrapped as untrusted context before prompt injection. The model must treat them as derived carry-forward notes, not authoritative transcript text.
- Focus knowledge can mark ranges already distilled into project context so those ranges do not keep consuming the active window.
- L0.1 episodic synthesis is separate rest-window work. It creates bounded episode landmarks with provenance and graph links; compaction summaries do not become episodes automatically.

The open design boundary is richer L1/L2 integration: future work can let contextual memory agents traverse an L0.1 chain and then selectively expand L0 spans, artifacts, or L2 memories. That expansion must stay bounded, provenance-preserving, and trust-gated.

The richer projection specs in [`SPEC_L01_LANDMARK_SCHEMA.md`](./SPEC_L01_LANDMARK_SCHEMA.md) and [`SPEC_MEMORY_PROJECTION_LAYER.md`](./SPEC_MEMORY_PROJECTION_LAYER.md) are design contracts for additional motif, occasion, callback, and declarative projection work. They do not mean those tables or the `recall_expand` tool are fully implemented today.

## Retrieval Path

`MemoryRetriever` combines multiple filters and ranking stages:

- L0.1 episodic landmark-chain search
- semantic vector search
- lexical fallback when semantic candidates miss
- privacy and trust-policy filtering
- contact-scope enforcement for high-intimacy memories
- contradiction and evidence weighting
- emotional continuity injection
- contact profile inclusion
- optional compositional reranking when policy and runtime allow it

The searchable copy of L0 should be treated as a projection that can be rebuilt from canonical archive truth if drift or corruption is detected.

When memories are withheld, the retriever can return withheld summaries instead of silently dropping context.

Episodic retrieval is landmark-first. A cue such as a wedding cake question should select the cake/bakery episode chain and its raw references, not the entire wedding-planning history and not one giant wedding memory. If no episodic landmarks match, normal L2 retrieval behavior remains intact.

## Trust And Privacy

Memory access is not just similarity-based.

- Trust level and channel visibility feed `evaluateMemoryPolicy`.
- Sensitivity and consent flags can block or redact retrieval.
- Boundary memories receive dedicated handling.
- Broadcast contexts use additional visibility-scope checks.
- High-intimacy memories are scoped to the canonical contact they belong to.

## Maintenance

The memory system is actively maintained by runtime jobs:

- salience decay
- profile synthesis refresh
- reflection writes promoted into long-term memory
- extraction marker updates
- database integrity and embedding-dimension checks at startup

If embeddings change materially, re-embed and validate the store before trusting retrieval quality. Operational steps live in [`docs/operations.md`](./operations.md).

## Files And Code To Trust

Start here when behavior matters:

- `src/faculties/memory/types.ts`
- `src/faculties/memory/store.ts`
- `src/faculties/memory/postgres-store.ts`
- `src/faculties/memory/writer.ts`
- `src/faculties/memory/extraction.ts`
- `src/faculties/memory/retrieval.ts`
- `src/faculties/memory/episodic/store.ts`
- `src/faculties/memory/episodic/postgres-store.ts`
- `src/faculties/memory/episodic/synthesis.ts`
- `src/faculties/memory/retrieval/episodic.ts`
- `src/app/startup/composition/composition.ts`
- `src/persistence/runtime-factory.ts`
