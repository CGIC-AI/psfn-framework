# Memory

PSFN memory is not a single store. The runtime combines append-only session history, typed long-term memories, continuity artifacts, contact state, and a few small high-priority ledgers.

## Layers That Exist Today

### L0: Session history

- Per-channel append-only JSONL in `sessions/`
- Built and compacted by `SessionStore` and `SessionManager`
- Remains the canonical turn history
- The archive seam should be `SessionArchivePort`; DB mirrors and searches belong behind projection/search ports, not as alternate archive truth.

### L1: Active context assembly

- Built on demand by `SessionManager`
- Mixes recent session entries, continuity, prompt layers, core memory, and retrieved long-term memory
- Applies token budgets, compaction thresholds, and observation masking

### L2: Typed long-term memories

- Stored in SQLite through `MemoryStore`
- Embedded with the configured embeddings provider and indexed with `sqlite-vec`
- Retrieved by `MemoryRetriever`
- Written through `MemoryWriter` and `MemoryExtractor`
- The storage contract should stay async-safe at the port level so a PostgreSQL implementation can use the same `MemoryStorePort` surface later.
- Backends may optimize the internal implementation differently, but the caller contract must not assume SQLite-specific transaction or vector-index behavior.

### Parallel memory/state artifacts

- `contacts/` continuity files
- reflection journal entries under `notes/reflections/`
- `core_memory.json`
- contact profiles and social graph state in SQLite/contact stores
- scratchpad mirror at `notes/scratchpad.json`
- memory mutation journal at `notes/memories.jsonl`

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

## Retrieval Path

`MemoryRetriever` combines multiple filters and ranking stages:

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
- reflection writes promoted into memory
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
- `src/app/startup/composition/composition.ts`
