# Memory

PSFN memory is not a single store. The runtime combines append-only session history, typed long-term memories, continuity artifacts, contact state, and a few small high-priority ledgers.

## Layers That Exist Today

### L0: Session history

- Per-channel append-only JSONL in `sessions/`
- Built by `SessionStore` and assembled by `SessionManager`
- Remains the canonical turn history
- The archive seam should be `SessionArchivePort`; DB mirrors and searches belong behind projection/search ports, not as alternate archive truth.

### L0.1: Episodic landmarks

- Stored in SQLite through `EpisodicStore` tables `l01_episodes` and `l01_episode_arcs`
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

- Stored in SQLite through `MemoryStore`
- Embedded with the configured embeddings provider and indexed with `sqlite-vec`
- Retrieved by `MemoryRetriever`
- Written through `MemoryWriter` and `MemoryExtractor`
- The storage contract stays async-safe at the port level so SQLite and PostgreSQL share the same `MemoryStorePort` surface.
- The supported PostgreSQL memory path stores embeddings in `l2_memories.embedding` via `pgvector` and performs database-side similarity search. Missing `pgvector` support is a fail-closed startup error, not a silent fallback to app-side array scanning.
- Backends may optimize the internal implementation differently, but the caller contract must not assume SQLite-specific transaction or vector-index behavior.

### Parallel memory/state artifacts

- `contacts/` continuity files
- reflection journal entries under `notes/reflections/journal.jsonl`
- append-only daily reflection journals under `notes/reflections/daily/`
- append-only long-process reflection logs under `notes/reflections/process-logs/`
- active orientation persisted in `core_memory.json`
- contact profiles and social graph state in SQLite/contact stores
- scratchpad mirror at `notes/scratchpad.json`
- memory mutation journal at `notes/memories.jsonl`

## Orientation, Long-Term Memory, And Scratchpad

- `orient` is the model-facing surface for active orientation: persona, human, and goals blocks kept hot in context.
- Orientation storage intentionally remains on legacy `core_memory.json` paths for now; the runtime rename is model-facing rather than a persistence migration.
- Long-term memory lives in the typed `memory` store and is retrieved selectively; it is not the same thing as active orientation.
- `scratchpad` remains an explicit ephemeral workspace for bulky temporary material and working notes, not canonical memory.
- Ephemeral scratchpad notes and managed temp artifacts now follow an explicit retention policy from `scheduler.json`. Durable artifacts promoted into the research library are exempt from lifecycle cleanup.

### Scratchpad

Scratchpad is a separate semantic surface, not a subtype of long-term memory.

- Lives in SQLite `scratchpad_entries` with an optional mirror at `notes/scratchpad.json`
- Holds temporary long-context notes, excerpts, rolling summaries, and working hypotheses for large source material
- Is bounded and intentionally ephemeral; it helps the current work, not durable recall
- Must stay distinct from `orient`, which is active canon, and from typed long-term `memory`, which is durable retrieval state
- Should be promoted only when the content stabilizes:
  - stable facts or relational knowledge go to `memory`
  - durable operator-authored notes or artifacts go to repo docs or `vault`
  - active self-orientation belongs in `orient`

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
- `src/faculties/memory/writer.ts`
- `src/faculties/memory/extraction.ts`
- `src/faculties/memory/retrieval.ts`
- `src/faculties/memory/episodic/store.ts`
- `src/faculties/memory/episodic/synthesis.ts`
- `src/faculties/memory/retrieval/episodic.ts`
- `src/app/startup/composition/composition.ts`
