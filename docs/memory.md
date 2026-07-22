# Memory

PSFN memory is not a single store. The runtime combines an append-only lived
session archive, typed long-term memories, continuity artifacts, contact state,
and a few small high-priority ledgers.

Last updated: 2026-07-22.

## Layers That Exist Today

### L0: Session archive

- Per-channel append-only JSONL in `sessions/`
- Built by `SessionStore` and assembled by `SessionManager`
- Remains the canonical turn history
- The archive seam should be `SessionArchivePort`; DB mirrors and searches belong behind projection/search ports, not as alternate archive truth.

### L0.1: Episodic landmarks

- Stored in PostgreSQL through the runtime episodic store tables `l01_episodes`, `l01_episode_spans`, `l01_episode_arcs`, lineage, review, candidate, watermark, and message-claim tables
- Represents bounded lived episodes with L0 span/artifact provenance, salience, affect, themes, participants, thread IDs, and channel IDs
- Candidate episodes are created by the gated episode-synthesis lane (timer-or-turn-threshold trigger plus a deterministic relevance gate; see "Background memory lanes" below); nightly rest-window sleeptime work consolidates and refines them
- Allows multiple episodes per day; a long-running theme is a graph of linked episodes, not one large aggregate record
- **Topic-thread identity (apq0).** An episode's `threadId` is a TOPIC thread, not a channel/session. Each new episode seeds its own singleton thread (`threadId = episode.id`); arc formation then unions arc-linked episodes onto the connected component's representative (the lexicographically-smallest episode id), materialized into the `l01_episodes.thread_id` column. This is deterministic and order-independent — an incremental min-merge and a global union-find over the same arc set converge on the same representative — so a later full recompute (historical repair) reproduces the live assignment. Keying `threadId` to the session id (the pre-apq0 behavior) is what produced the unbounded per-channel mega-thread; the processing-synthesis watermark stays session-keyed (it is a per-session cursor, decoupled from thread identity). A single merge's write amplification is bounded by a safety cap (`maxThreadEpisodes`, default 500); an oversize losing thread is left unmerged fail-safe and surfaced through a typed thread-assignment event, never silently mis-threaded.
- Hard message claiming: each episode claims its source messages in `l01_episode_message_claims`, and a partial unique index guarantees at most one live episode per source message. Daytime synthesis drops actively claimed messages from its input before grouping, so overlapping passes can never re-process the same turns. Nightly consolidation is the only process allowed to restructure claims, via `transferEpisodeMessageClaims`: claims move to the consolidated episode and the covered candidates are marked superseded (hidden from live queries, never deleted, claim history retained). The >50% span-overlap merge heuristic remains as defense in depth for pre-claiming data.
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
- The storage contract stays async-safe at the port level so tests and repair utilities can exercise active adapters without leaking storage details into callers.
- The supported memory path stores embeddings in `l2_memories.embedding` via `pgvector` and performs database-side similarity search. Missing `pgvector` support is a fail-closed startup error, not a silent fallback to app-side array scanning.
- SQLite and sqlite-vec implementations, dependencies, and migration readers are removed. Tests use Postgres fixtures or focused port-backed fakes.

### Parallel memory/state artifacts

- `contacts/` continuity files
- reflection ledger entries under `notes/reflections/journal.jsonl`
- append-only daily reflection records under `notes/reflections/daily/`
- append-only long-process reflection logs under `notes/reflections/process-logs/`
- active orientation persisted in `core_memory.json`
- contact profiles, social graph state, concerns, intentions, internal state, and follow-ups in PostgreSQL stores
- scratchpad mirror at `notes/scratchpad.json`
- memory mutation ledger at `notes/memories.jsonl`

The model-facing **personal journal** is separate: it contains companion-authored
Markdown under `WORKSPACE_PATH/journal/`. A reflection publication copied there
is a mirror of the runtime reflection ledger, not its replacement. Do not call
L0 or generic audit logs "the journal."

## Persistence Authority And Restore

Which layer is canonical for what, and what restores it, is decided in
[`memory-persistence-authority.md`](./memory-persistence-authority.md)
(bead `upx0.11`, operator decision 2026-07-10). The short version:

- L0 (filesystem JSONL) stays canonical for lived history; its Postgres search
  copy is a projection rebuilt from L0 (`runTranscriptProjectionRepair`).
- Derived layers (L0.1 episodes, L2 memories, embeddings, evolution links) and
  the Postgres-only runtime-state stores restore from encrypted `pg_dump`
  backups. Those backups are the canonical restore primitive, not a
  convenience.
- `notes/memories.jsonl` is an append-only audit/export aid, not a restore or
  replay primitive.
- Re-deriving L2/episodic state from L0 yields a faithful continuation, not a
  restoration (charter §6.20); derived-layer repair is supersede-based
  re-derivation with provenance intact, never deletion.

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

### Personal Knowledge Base (Wiki)

Wiki documents are stable reference knowledge, not lived memory.

- Live under `WORKSPACE_PATH/knowledge/wiki/` with document bodies and metadata stored in deterministic subtrees
- Hold durable authored notes, imported partner-vault notes, parsed documents, generated syntheses, external references, and system seeds
- Carry source class, provenance references, sensitivity, timestamps, and revision metadata
- Stay distinct from L0 transcript history, L0.1 episodic landmarks, L2 typed memory, scratchpad, journal files, and current orientation
- May link to memory/session records by provenance reference, but the wiki body does not become L0/L0.1/L2 memory by default
- Imports from Obsidian/Vault or other external sources require explicit source class and provenance and fail closed when those fields are missing

The legacy `vault`/Obsidian surface is an optional external source bridge. It is not the canonical personal long-term storage surface.

### Knowledge-Base Scopes: Personal vs Shared-World (multi-companion)

Wiki documents carry an optional scope dimension (`WikiScope`,
`src/faculties/wiki/scope.ts`). Absent means `personal` — the default for every
existing document and every companion write path, so a personal document is
byte-identical to a pre-scope document. The non-personal scope is
`shared_world:<siteId>`: world knowledge tied to a place-registry site, shared
across the companions on a cluster.

- **Personal wiki is per-companion and companion-writable.** It lives under
  that companion's canonical `WORKSPACE_PATH/knowledge/wiki/`; cluster launcher
  and gateway policy bind the same isolated root to the authenticated companion.
- **Shared-world wiki is operator-owned.** Companions read the shared scope and
  *propose* entries through the normal wiki pass; they never write it directly.
  The personal `WikiStore` rejects any non-personal write fail-closed
  (`assertPersonalScopeWrite`), and only the operator maintenance commands
  (`wiki:publish:places`, `wiki:import --scope shared`) construct the shared
  store. The caretaker layer that would autonomously dedup/rewrite/clean the
  shared wiki is described in the design notes but is not built yet.
- **Site-keyed retrieval swap.** When the multi-companion flag is on,
  `resolveWikiRetrievalPlan` (`src/faculties/wiki/retrieval.ts`) restricts a
  turn's wiki reads to `personal` plus the current site's
  `shared_world:<siteId>` scope, keyed off the companion's current site from the
  situated-place seam. Moving between areas swaps the readable shared scope
  without touching personal wiki. Flag off means unrestricted scope — behavior
  is unchanged.
- **Shared-schema chunk projection.** Shared-world pages are projected into a
  `shared_wiki_chunks` pgvector store in the `shared` Postgres schema (migration
  in `src/persistence/postgres/migrations.ts`, projection store in
  `src/faculties/wiki/shared-pgvector-projection.ts`) with a database-level
  `CHECK (scope = 'shared_world:'||site_id)` leak guard. Retrieval unions a
  companion's personal semantic matches with the shared projection matches
  (`mergeWikiSemanticMatches`) and fails closed to personal-only if the shared
  store is unavailable. Publication/import project into this store in the same
  operation — see [`docs/operations.md`](./operations.md).

The Shared-world Wiki is not a general **Shared Companion Workspace**. The
latter is a future installation-governed file domain for explicitly published
collaboration artifacts and common reference material; it must never turn a
peer's personal journal, wiki, skills, or runtime state into shared data by
default. See [`docs/multi-companion.md`](./multi-companion.md#workspace-scopes-current-behavior-and-target-contract).

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

### Decay and retrieval matrix

`settings.json` owns the complete `memoryRetrievalPolicy` object. Garden exposes it in the advanced Memory section as a structured JSON object. Omitting the whole object uses the compiled defaults; if the object is present, it must contain the complete schema. Partial, unknown, or out-of-range policy data is rejected rather than merged with hidden defaults.

| Type | Half-life | Salience floor | Retrieval prior |
| --- | ---: | --- | ---: |
| emotional | 365 days | `0.25 + 0.35 * abs(valence)` | 1.3 |
| relational | 180 days | 0.5 at `abs(valence) >= 0.5`, otherwise 0.05 | 1.15 |
| boundary | 365 days | 0.5 | 1.6 |
| semantic | 120 days | 0.05 | 1.0 |
| reflection | 90 days | 0.05 | 0.9 |
| episodic | 30 days | 0.05 | 1.0 |
| procedural | 14 days | 0.05 | 0.6 casual / 1.2 task context |

Emotional persistence scales its half-life from 1x to 6x using formation intensity. Durable retention floors and multipliers still compose with the type matrix. Default retrieval floors recency at 0.35 so age orders ambient recall without burying a strong match; temporal retrieval deliberately keeps its sharp seven-day recency curve. Procedural task weighting uses only the caller-provided `taskKind`, never content inference, and active-memory cache identity includes that task kind.

Selection caps reflections and procedurals at two each per turn. Other engram types remain uncapped within the token budget. The lexical augment scans active memories in deterministic newest-first Postgres order using settings-owned page and scan bounds (defaults: 256 per page, 2,048 scanned, 12 retained), so it reaches beyond the former newest-96 window without creating an unbounded turn-time scan. Its match gate is also settings-owned: `lexicalAugment.minOverlap` (default 2 shared tokens) and `lexicalAugment.baseSimilarity` (default 0.62). The score guarantee that rescues top-similarity memories when the scored set is thin is owned by `scoreGuaranteeMinK` (default 3) and `scoreGuaranteeFloor` (default 0.01). L0.1 episodic landmark and timeline retrieval bounds are owned under `memoryRetrievalPolicy.episodic` (chain `scanLimit`/`maxChains`/`maxDepth`/`maxEpisodesPerChain`, timeline `timelineLimit`/`timelineScanLimit`/`timelineMaxDepth`/`timelineMaxEpisodesPerRoot`, plus `arcScanLimit`, `minRootMatchScore`, and `minRelatedMatchScore`), preserving the compiled defaults. Vector search continues to score the full active corpus before applying its result limit. Dedup thresholds and privacy/trust filtering are unchanged.

### Memory Presentation Profile

`memoryRetrievalPolicy` governs *selection* (which memories are chosen); `memoryPresentationProfile` governs *presentation* (how the chosen block is rendered into the companion-facing prompt). It is a separate `settings.json`-owned object, exposed in the advanced Memory section, and is versioned by `PRESENTATION_PROFILE_VERSION` (currently `1`) so an intentional default-rendering change re-records goldens on purpose rather than by accident. The default profile reproduces the historical hardcoded rendering byte-for-byte; the prompt-shape goldens pin that default.

The profile covers presentation only:

- `sectionOrder` — an exact permutation of the seven top-level prompt sections (`core_profile`, `relationship_context`, `emotional_continuity_snapshot`, `cross_session_emotional_continuity`, `memory_context_note`, `episodic_landmark_chains`, `relevant_memories`). Structural section ids never change with wording.
- `headings` — wording for the boundary, relevant, social-context, separate-people, emotional-continuity, and episodic-landmark section headings.
- `valence` — the positive/negative marker strings and their thresholds for memory lines, plus the emotional-continuity block's own thresholds.
- `recencyLabels` — the coarse age-band labels (`today`/`yesterday`/`this week` and `{n}`-templated week/month/year bands).
- `episodeCap` — the always-on episodic-landmark block's total episode cap (default 5).
- `displayCaps` — optional per-type presentation-time truncation for `emotional` and `procedural` lines (`null` = uncapped, the default; caps drop overflow after selection, never affecting which memories are selected).
- `withheldWording` — optional per-companion overrides for the withheld-memory ("memory context note") lines. A `null` field falls back to the system-owned language layer default; an override string is rendered with the same `{{token}}` substitution.

Presentation config fails closed: a malformed profile (unknown/missing key, wrong type, out-of-range number, non-permutation `sectionOrder`, or wrong `version`) is rejected loudly rather than silently defaulted. Changing the profile changes the rendered block with no code edits.

### Turn Hot Path (Active Memory Context, E5.5)

Foreground turns never block on retrieval. The turn serves the cached active-memory context and schedules a background refresh; the refreshed context lands on a later pass, so remembering something a turn late is acceptable and by design. There is no blocking legacy fallback: a memory provider wired into turn execution must expose the active-context surface or startup of the turn fails closed.

Degraded state is explicit, never silent. When a turn proceeds without a fresh active context, a typed `memory.active_context.turn_degraded` event records the reason (`not_ready` on cold start, `refresh_failed` after a failed refresh, `stale` while a refresh from an earlier pass is still in flight). Persistent refresh failure — consecutive `degraded` refresh phases for the same context key crossing the settings.json-owned `memoryRefreshFailureAlertThreshold` — raises an operator alert through the gateway's system-derived ntfy notification path; a successful refresh resets the counter and re-arms the alert.

## Trust And Privacy

Memory access is not just similarity-based.

- Trust level and channel visibility feed `evaluateMemoryPolicy`.
- Sensitivity and consent flags can block or redact retrieval.
- Boundary memories receive dedicated handling.
- Broadcast contexts use additional visibility-scope checks.
- High-intimacy memories are scoped to the canonical contact they belong to.

### Garden Admin Body Gate

The Garden admin memory API (`/api/admin/memory*`) sensitivity-gates memory bodies for the operator:

- `intimate` and `confidential` bodies are redacted by default in list, search, detail, and managed-scope views; metadata (id, type, sensitivity, scope, timestamps, salience, provenance summary) stays browsable.
- Redactions are explicit, never silent: the body is replaced by a marker naming the sensitivity level, original character count, and how to reveal.
- Access is granted by an audited per-memory reveal (`POST /api/admin/memory/<id>/reveal`) or an audited session elevation (`POST`/`DELETE`/`GET /api/admin/memory/elevation`). Both grants expire after a fixed TTL (`ADMIN_MEMORY_BODY_ACCESS_TTL_MS`, 15 minutes) and every reveal/elevation writes a `memory_access` audit entry.
- Metadata operations (supersede, bulk delete, bulk field update, scope edits, linking) do not require body access. Patching the body of a redacted memory fails closed until it is revealed or the session is elevated.
- Session transcripts and Loom per-turn retrieval views are conversation/debugging surfaces, not memory rows, and are outside this gate.

## Maintenance

The memory system is actively maintained by runtime jobs:

- salience decay
- profile synthesis refresh
- reflection writes promoted into long-term memory
- extraction marker updates
- database integrity and embedding-dimension checks at startup

### Background memory lanes (E5.2/E5.3, JSON-owned)

Background memory work is split into three lanes. Every cadence, threshold, and window is owned by `scheduler.json` (schema-guarded, fail closed on missing or invalid config); nothing is hardcoded.

Salience retrieval is cadence-independent: ranking computes effective salience lazily from each memory's `lastAccessed` timestamp, while the bundled scheduler-owned persistence sweep runs from `backgroundMaintenance.intervalMs` (default 3,600,000 ms / hourly) to enforce floors and durably refresh stored values. Compression-guideline review is a separately gated operation in that bundled heartbeat. Context compaction itself remains threshold-driven by `compactionThresholdPct`; it has no timer cadence.

**Near-turn lane (`nearTurnMemory`)** — lightweight, deterministic, zero LLM spend (the lane holds no LLM provider at all). It keeps only extraction trigger evaluation (the existing per-turn and observed-group extraction wiring), active-memory review refresh (stale-memory maintenance reviews), and concern-candidate derivation (the intention appraisal path). Cadence keys:

- `nearTurnMemory.direct.cadenceTurns` — direct/1:1 (DM) scopes keep the historical per-N-turns posture (default every 3 turns).
- `nearTurnMemory.group.minIntervalMinutes` and `nearTurnMemory.group.minNewEntries` — group/room scopes use watermark + interval batching. A group run is only eligible once at least `minNewEntries` new turns have accumulated AND at least `minIntervalMinutes` of wall-clock time has elapsed since the last run.

Direct-vs-group topology reuses the canonical group-memory classification pipeline (`groupMemory` settings, `memoryMode` direct/group/auto, channel overrides, and participant-window auto-detection) via `ObservedGroupMemoryScheduler.classifyChannelMemoryScope` — the same classifier that gates observed group extraction; there is no parallel detector. If classification fails, the lane logs the error and degrades to group batching (the compute-conservative direction). Each fire emits a `memory.near_turn.cadence` telemetry event (scope, turn count, new-entries-since-last-run, rolling per-channel `firesLastHour`), streamed to the Garden admin telemetry websocket.

**Candidate-episode synthesis lane (`episodeSynthesis`)** — the deterministic trigger gate for episode-candidate creation. The gate evaluates when the scheduler timer fires (`timerIntervalMinutes`, task `memory.episode-synthesis.timer`) OR a per-session turn threshold is reached (`turnThreshold`), whichever comes first. Two deterministic checks then run with zero LLM spend when closed:

1. Gate 1 — any new messages since the durable synthesis processing watermark? None => no-op.
2. Gate 2 — at least `minRelevantTurns` (default 10) companion-relevant turns. Relevance reuses the group-chat addressing/mention/attribution detection (`classifySessionEntryCompanionRelevance` in the extraction speaker-routing module): the companion's own turns, replies to her, direct address, and mentions count; async group traffic between other members does not. DMs count every conversational turn.

Below the minimum the lane holds and accumulates: the watermark does not advance, so the next period evaluates the whole accumulated chunk (9 relevant now => hold; 25 total next period => process as one chunk). Every evaluation — processed or skipped, with a typed reason (`no_new_messages`, `below_relevance_minimum`, `session_retired`) — emits a `memory.episode_synthesis.gate` event for the subsystem-health view. Synthesis tuning (`transcriptMessageLimit`, `maxEpisodesPerRun`, `gapSplitMinutes`, `maxEntriesPerEpisode`, `minConversationalEntries`, `minSingleEntryChars`) lives in the same block.

**Contextual topic cutting (E5.4, `episodeSynthesis.topicSegmentationEnabled`, default false)** — with the flag on, the deterministic pre-cuts (UTC day boundary, long-gap split, entry cap) stay the outer bounds, and within each gated chunk an LLM proposes contiguous topic segments via schema-bound structured output (`src/faculties/memory/episodic/topic-segmentation.ts`; same gateway-backed provider port as the other episodic passes). Turns of an unfinished trailing topic in the newest chunk are HELD BACK — not claimed, not episodized — and roll into the next pass, joining the next episode if the topic continues; the processing watermark never advances past held or unprocessed turns. Malformed segmentation output fails closed: no episode for that chunk, nothing claimed, the run stops before the watermark passes the chunk, and a typed `memory.episode_synthesis.segmentation` event (outcome `failed`) records the error; successful cuts emit the same event with outcome `segmented` plus held-back counts. `maxEpisodesPerRun` caps materialized candidates across all segments. Flag off => deterministic cutting is unchanged; flag on without a provider fails closed at construction.

**Sleeptime (rest-window scheduler lane)** — actual sleeptime: nightly scheduler-owned work, like dreaming. Sleep consolidation, arc weaving, the dream-meaning pass, and the orientation-block rewrite run ONLY from the `memory.sleeptime.rest-window` scheduler task inside the `episodicProcessing` rest window (default 00:00–09:00 plus 60 min of inactivity). No code path from turn cadence can reach them — the sleeptime agent has no turn-based inference surface and fails closed at construction without a rest-window config; unreachability is test-enforced. Heavy-pass tuning is JSON-owned: `sleepConsolidation` (`reviewWindowDays`, `refinementWindowHours`, `adjacencyGapMinutes`, `maxRefinementsPerRun`, `maxConsolidationsPerRun`), `orientationRewrite` (`minNewEntriesSinceRewrite`, `refreshAfterQuietDays`; the orient rewrite is gated on deterministic evidence of change — see "Deterministic pre-LLM gating" below), and `arcFormation` (`passIntervalDays`, `reviewWindowDays`, `minConfidence`, `maxArcsPerRun`, `maxEpisodesPerRun`). Arc weaving links CANONICAL episodes only (candidates wait for consolidation) into cross-day thematic threads; arc membership is mutable (join/leave/re-point) with a full audit trail in `l01_episode_arc_audit`, and consolidation supersession re-points arc memberships onto the consolidated episode so no arc dangles on a non-live episode. Writing an arc also materializes topic-thread identity (apq0): the two arc-linked episodes' topic threads are unioned onto the min-id representative in `l01_episodes.thread_id` (see the L0.1 "Topic-thread identity" note above), so Garden's `searchByThread`/`getThreadDetail` grouping and retrieval drill-down siblings show bounded per-topic threads instead of one per-channel bucket.

Sleep consolidation runs the candidate-then-consolidate model (m58.1). Daytime synthesis output is CANDIDATE episodes (`l01_episodes.status = 'candidate'`): fully live for retrieval — they are the only record of the day — but identifiable until a sleep cycle rules on them. The nightly pass clusters same-scope overlapping/adjacent candidates, asks a schema-bound LLM thematic grouping which candidates form one episode ("this whole stretch was us discussing X"; a mis-joined distinct-topic fragment goes to its own group), and consolidates each multi-candidate group into a new canonical episode: spans, artifacts, and provenance are unioned deterministically (every covered L0 transcript span keeps an `l0_span` provenance ref), message claims move via `transferEpisodeMessageClaims`, and the source candidates are marked superseded — never deleted, with lineage (`canonicalizes`) and candidate-decision rows recording the consolidation. Lone candidates are confirmed canonical deterministically with zero LLM spend. Malformed or failed grouping output fails closed per cluster: a typed `memory.sleep_consolidation.failure` event fires and the candidates stay untouched for the next night. LLM grouping work per run is bounded by `maxConsolidationsPerRun`. The deterministic adjacent-merge repair only touches claim-free canonical episodes (the pre-claiming historical backlog); claim-holding episodes are products of deliberate thematic consolidation and are never blindly re-merged. This is **episode consolidation**, not shard Folding.

Note: the old `scheduler.json` `sleeptime` cadence key was removed with no legacy alias; configs still carrying it fail validation with rename guidance.

### Deterministic pre-LLM gating (jpvd.4)

Recurring nondeterministic LLM passes must not fire when deterministic signals can already tell us nothing changed. A single shared primitive — `evaluateDeterministicGate` in `src/shared/gating/deterministic-gate.ts` — expresses every such gate as a pure decision over named deterministic inputs (counts since a watermark, VAD/trend deltas, keyword signal scores, elapsed time, pending-item counts): `blockWhen` hard-close pre-checks run first in order, then the gate opens if ANY opening signal fires, else closes with a reason. It returns `{ open, reason, inputs }` with zero side effects and zero LLM spend; a missing/non-finite required input fails closed. A closed gate short-circuits the pass and emits a typed `DeterministicGateEvent` (`{ lane, outcome: 'ran' | 'skipped', reason, inputs, timestamp, sessionId? }`) that the Garden subsystem-health view renders as a lane (`src/operator/garden/services/subsystem-health-service.ts`).

Per-pass gate definitions:

- **Orientation-block rewrite** (`memory.orientation_rewrite.gate`, config `scheduler.json` `orientationRewrite`) — the heaviest nightly sleeptime LLM pass. Opens on deterministic evidence of change since the last rewrite: at least `minNewEntriesSinceRewrite` new conversational turns (the snapshot `updatedAt` is the last-rewrite baseline), OR any new activity once the last rewrite is stale past `refreshAfterQuietDays` (never rewrites orientation from an empty transcript). A never-oriented companion (all orient blocks empty) fails open for its first rewrite. On quiet nights the gate closes (`no_change`) and the whole orient-plan call is skipped. Skipping is the common case.
- **Dream-meaning pass** (`memory.dream_meaning.gate`) — a cadence gate (`cadence`: skip until `passIntervalMs` elapses since the last pass) followed by an episodes gate (`no_episodes`: skip unless at least one in-window consolidated episode still lacks a meaning).
- **Sleep-consolidation refinement** (`memory.sleep_consolidation.refinement_gate`) — the bounded LLM title/landmark/theme/salience cleanup fires only when at least one in-window episode is still unrefined (`no_unrefined_episodes` when none). Thresholds already live in `scheduler.json` `sleepConsolidation`.
- **Emotion appraisal** (`emotion.appraisal.gate`) — opens on the turn cadence (`turnCadence`) OR a large enough VAD movement (`vadDeltaThreshold`, gated by trusted telemetry); closes as `no_movement`. The open reason is the trigger (`periodic` / `vad_shift`).
- **Extraction pre-LLM gate** (`src/faculties/memory/extraction/signals.ts`) — an `empty_transcript` block rule, then opens when any user turn scores meaningful OR nothing was explicit filler, else `low_signal`. Byte-identical to its pre-refactor decision; skips keep surfacing through `memory.extraction.end` telemetry.
- **Concern candidate review** (`intention.concern_candidate.gate`) — a pending-count gate (`insufficient_candidates` for ≤ 1 pending) and a turn-interval cadence trigger. `already_running` stays a concurrency guard, not a deterministic gate.

### Social-graph builder worker (E4.2, memory-agent lane)

A background job (`SocialGraphBuilderWorker`, `src/faculties/memory/social-graph/`) proposes social-graph edges from accumulated room evidence. It runs on the same background-maintenance posture as sleeptime/salience-decay (scheduler eligibility gate) and is NEVER inline in the chat path. It is purely heuristic (no LLM call, so no model charge) and reads NEW room-scoped memories since its own advisory watermark. Three evidence classes: repeated co-presence of two tracked contacts across N room sessions (→ `acquaintance`, ~0.5), overheard interactions naming two tracked people (→ typed per `inferRelationshipTypeFromFact` else acquaintance, ~0.6), and named-relationship facts like "my sister Iki" (→ fine-typed, symmetric kinds undirected/bidirectional and asymmetric kinds single-direction with the inverse table deferred to E4.3, ~0.7).

Proposals are NOT live edges: they land in a durable, file-backed proposal store (`social-graph-proposals.json` under companion-data `state/`), strictly out of the live graph until an operator accepts them in Garden (`/graph-proposals`). Acceptance writes the edge through the normal `upsertSocialRelationshipEdge` path (optionally with an operator-adjusted type); rejection persists and blocks re-proposal of the same evidence. Idempotency and rejection-blocking are keyed by an evidence-set hash, so re-running from the same watermark produces no duplicates. A proposal that conflicts with a differently-typed live edge is never auto-resolved — it lands in a `conflict` review state and the operator edge is untouched. Untracked speakers (no contact row, per E3.4) can never enter the graph. Cadence knobs are owned by `scheduler.json` under `socialGraphBuilder` (`intervalMs`, `coPresenceMinSessions`, `coPresenceWindowMinutes`, `scanMemoryLimit`). Each run emits a `memory.social_graph.builder` telemetry event (scanned / proposed / conflicts / skipped-untracked / deduped) — Law 31: results are operator-visible, never silent.

If embeddings change materially, re-embed and validate the store before trusting retrieval quality. Operational steps live in [`docs/operations.md`](./operations.md).

## Files And Code To Trust

Start here when behavior matters:

- `src/faculties/memory/types.ts`
- `src/faculties/memory/store.ts`
- `src/faculties/memory/postgres-store.ts`
- `src/faculties/memory/writer.ts`
- `src/faculties/memory/extraction.ts`
- `src/faculties/memory/retrieval.ts`
- `src/system/config/memory-retrieval-policy.ts`
- `src/faculties/memory/episodic/store.ts`
- `src/faculties/memory/episodic/postgres-store.ts`
- `src/faculties/memory/episodic/synthesis.ts`
- `src/faculties/memory/retrieval/episodic.ts`
- `src/app/startup/composition/composition.ts`
- `src/persistence/runtime-factory.ts`
