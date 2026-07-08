# Sprint 9 Memory Notes

This document captures the memory-system follow-up from the recovery/bootstrap review and the Hy-Memory/OpenClaw inspection. It is not a proposal to import third-party code. The goal is to keep PSFN's memory architecture, then steal the useful patterns: cleaner lineage, better reconciliation, fewer noisy episodic duplicates, and real regression benchmarks.

## Current Read

Sprint 8 already has the important foundations:

- L0 append-only session history.
- L0.1 episodic landmarks with span refs, provenance refs, artifact refs, and arcs.
- L1 prompt assembly with trust/sensitivity/contact/channel gating.
- L2 typed long-term memories with provenance, scoping, soft delete, and supersession.
- Rest-window sleep-time processing.
- Withheld memory summaries so the model can know something was intentionally hidden.

The weak spots are mostly around consolidation quality:

- Episodic memory generates too many overlapping landmarks.
- L2 supersession exists, but it is not exposed as a useful evolution chain during retrieval.
- Writer reconciliation can treat related higher-confidence memories as replacements even when they are really compatible updates.
- Tests cover units, but there is no memory benchmark harness that catches personality/context regressions.

## Sprint 9 Direction

Postgres should be treated as an opportunity to tighten semantics, not just swap storage.

Useful Postgres capabilities:

- `pgvector` for semantic matching during retrieval and consolidation.
- Range overlap queries for episodic spans.
- Recursive CTEs for memory and episode lineage traversal.
- JSONB indexes for provenance, artifacts, consent flags, and scope tags.
- Transactional canonicalization so candidates can merge/replace safely.
- Better operational visibility with materialized views or diagnostic query tables.

## Episodic Memory Problem

The current `EpisodicSynthesizer` reprocesses a recent transcript window, splits by day/gap/max-entry limits, and creates a stable episode ID from the exact span and entry fingerprints.

That catches exact repeat synthesis, but it does not catch near-duplicates:

- A sliding transcript window shifts.
- A gap boundary moves.
- The same task continues across multiple synthesis runs.
- A long active task gets chunked into several adjacent "important" episodes.
- Theme extraction is lexical and can create weak overlaps.

The result is too many nearby L0.1 episodes that point to overlapping raw chat. Retrieval then sees several semi-equivalent landmarks instead of one canonical event.

## Recommended Episodic Shape

L0.1 should mean "canonical relationship/task landmarks with raw L0 spans underneath." It should not mean "every interesting transcript chunk."

### 1. Add processing watermarks

Track synthesis state per session/channel/thread:

- Last processed message or turn.
- Last processed timestamp.
- Last synthesis run ID.
- Optional lookback span for safe boundary repair.

Process new turns since the watermark, with a bounded lookback. Do not repeatedly synthesize the whole recent transcript as if it were fresh.

### 2. Separate candidates from canonical episodes

Pipeline should be:

1. Build candidate episode from new L0 spans.
2. Search recent canonical episodes in the same scope.
3. Decide create, merge, extend, split, or discard.
4. Write one canonical result.
5. Create arcs after consolidation.

Candidate episodes can be transient rows or in-memory objects. They should not all become durable L0.1 episodes.

### 3. Add overlap-aware merge checks

Before creating an episode, compare against recent canonical episodes using:

- Span overlap.
- Time proximity.
- Same session/thread/channel.
- Same participants/contact scope.
- Theme overlap.
- Embedding similarity.
- Artifact overlap.
- Active task or topic continuity.

If a candidate is similar enough, extend or merge the existing episode instead of writing a new one.

### 4. Support episode lineage

Episodes need a way to retire noisy or merged records:

- `canonical_episode_id`
- `merged_into_episode_id`
- `superseded_by_episode_id`
- `status`: `active`, `merged`, `superseded`, `archived`

Normal retrieval should prefer active canonical episodes. Debug/admin views should still be able to trace retired episodes back to raw spans.

### 5. Generate arcs after consolidation

Arcs should connect canonical episodes, not candidates. Otherwise duplicate episodes produce duplicate chains.

The contract already has richer arc kinds:

- `continuation`
- `causal`
- `contrast`
- `resolution`
- `recurrence`
- `same_theme`
- `operator_defined`

Sprint 9 should use more than `same_theme` and `continuation`. A practical first pass:

- `continuation`: same task/topic continues after a short gap.
- `resolution`: later episode closes a problem raised earlier.
- `contrast`: later episode contradicts or revises earlier state.
- `recurrence`: repeated theme across separate time windows.
- `same_theme`: fallback for related but weakly typed arcs.

## L2 Evolution Chains

Current L2 memory has `superseded_by`, but the new memory does not have a first-class structured "supersedes" relationship. Some paths encode supersession in provenance text, which is not enough for retrieval.

Sprint 9 should add first-class lineage:

- A memory can supersede one or more older memories.
- Older memories know the replacement head.
- Retrieval can expand a relevant current memory into a bounded evolution chain.
- Prompt rendering can include correction history only when useful.

Recommended structure:

- `memory_evolution_links`
  - `source_memory_id`
  - `target_memory_id`
  - `relation`: `supersedes`, `updates`, `negates`, `conflicts_with`
  - `confidence`
  - `reason`
  - `created_at`
  - provenance refs

Normal retrieval should return current active memories. A second step can expand lineage when:

- The query asks about history/change.
- The current memory has low confidence.
- The current memory replaced a high-salience memory.
- The replaced memory came from relationship/personality-critical context.

## Reconciliation Semantics

Do not treat "related and higher confidence" as enough to supersede.

Use explicit decisions:

- `ADD`: new independent memory.
- `UPDATE`: compatible refinement or detail merge.
- `SUPERSEDE`: old memory would give the wrong current answer.
- `NEGATE`: old memory is explicitly no longer true.
- `CONFLICT`: unresolved contradiction that needs review or careful retrieval.

For high-impact memory types, prefer review or explicit contradiction labels before destructive supersession:

- identity
- relational
- boundary
- emotional
- contact/profile facts

## Sleep-Time Work

Keep this inside PSFN's existing rest-window agent. Do not add a Python sidecar.

Good Sprint 9 sleep-time jobs:

- Consolidate candidate episodes into canonical episodes.
- Merge overlapping episodes.
- Classify richer episode arcs.
- Promote repeated facts into stable L2 memories.
- Detect stale or conflicting L2 memories.
- Build lightweight behavioral summaries from evidence chains.
- Queue low-confidence memory reviews instead of writing uncertain facts directly.

## Memory Benchmarks

Add a memory regression harness before making large consolidation changes.

Suggested location:

- `eval/memory/`

Minimum fixture shape:

- Seed L0 session entries.
- Seed optional existing L0.1/L2 memories.
- Run writer, retrieval, and sleep-time jobs.
- Assert selected memory IDs, withheld IDs, prompt snippets, lineage, and answer behavior.

Core benchmark families:

- Current-state change: "I moved from X to Y" answers Y, but history is available when asked.
- Compatible update: "I like tea" plus "I like green tea" does not incorrectly supersede.
- True contradiction: "I no longer work at X" retires or negates the old employment memory.
- Episodic overlap: one long recovery/bootstrap task becomes one canonical episode or a small clean chain, not six duplicates.
- Episodic paraphrase: "motherboard RMA downtime" retrieves "primary server down for RMA" even without exact lexical match.
- Privacy/trust: private memories do not leak into group contexts.
- Withheld context: prompt says relevant memory was withheld without exposing private content.
- Backup restore: HMAC/key/config restore failure is detected as degraded memory access, not silent personality drift.

Metrics:

- Retrieval precision@k, recall@k, and MRR.
- False supersede rate.
- Missed supersede rate.
- Compatible-update false positive rate.
- Episode duplicate rate.
- Episode merge precision/recall.
- Trust leak rate.
- Useful memory facts per prompt token.
- Retrieval latency.
- Sleep-time queue age and processing latency.

## Migration Notes

During the Postgres migration, avoid a pure table-for-table port. Use the migration to encode the intended memory model.

Likely new or revised tables:

- `l0_session_entries`
- `l01_episodes`
- `l01_episode_spans`
- `l01_episode_arcs`
- `l01_episode_lineage`
- `l2_memories`
- `memory_evolution_links`
- `memory_processing_watermarks`
- `memory_maintenance_reviews`
- `memory_eval_runs`

Important indexes:

- Episode scope/time indexes.
- Episode span range overlap index.
- Episode vector index.
- Memory vector index.
- Memory status/contact/scope indexes.
- Memory lineage source/target indexes.
- JSONB GIN indexes for provenance/artifacts/scope tags where needed.

## Practical Sprint Cut

Recommended order:

1. Add memory benchmarks for current behavior.
2. Add Postgres schema with watermarks, episode spans, and lineage tables.
3. Port existing behavior with compatibility tests passing.
4. Add episodic candidate-to-canonical reconciliation.
5. Add L2 evolution links and retrieval expansion.
6. Upgrade sleep-time arc classification.
7. Add dashboards/logs for duplicate episode rate and supersession decisions.

The highest-value target is reducing duplicate L0.1 episodes. That will improve continuity and personality more than adding more memory layers.
