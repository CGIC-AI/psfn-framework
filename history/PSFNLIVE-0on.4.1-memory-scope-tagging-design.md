# PSFNLIVE-0on.4.1: Canonical Memory Scope And Tagging Model

## Status

- Bead alias: `PSFNLIVE-0on.4.1`
- Branch: `bead-0on-4-1`
- Date: `2026-03-25`
- Type: decision artifact

## Why This Exists

The current memory stack already has multiple layers, but they are only partially named:

- L0 transcript and session history live in `src/session/*`.
- L1 live context is assembled from recent entries, compaction summaries, cross-channel continuity, and focus knowledge in `src/session/manager/context-builder.ts`.
- L2 durable memory lives in `src/memory/store.ts` and is retrieved through `src/memory/retrieval.ts`.
- North star items are separate durable goals in `src/north-star/store.ts`.
- Shard context packs are ephemeral worker inputs in `src/shards/types.ts` and `src/shards/manager.ts`.

Today, scope is mostly implicit:

- memory has `tags` plus `contact_id`
- focus sessions have a freeform `scope` string and stored focus knowledge blocks
- north-star has a fixed `shared | companion` scope
- shard context has `purpose: shard_context` and a plain task string

That is enough to ship a system, but not enough to keep project scope, north-star alignment, task workers, and long-lived shards from collapsing into the same vague bucket. This bead defines the canonical contract so the implementation beads can build on one model.

## Current Constraints From The Code

- `l2_memories` currently has `tags TEXT`, `provenance_refs TEXT`, and `contact_id TEXT`, but no dedicated project or shard scope column in [`src/memory/store.ts`](/mnt/samesung/ai/psfn-live-mi-0on41/src/memory/store.ts).
- Memory writes already normalize tags and upgrade durable writes with the `durable` tag in [`src/memory/writer.ts`](/mnt/samesung/ai/psfn-live-mi-0on41/src/memory/writer.ts).
- Retrieval already filters by trust, disclosure, contact scope, sensitivity, and tag-driven heuristics in [`src/memory/retrieval.ts`](/mnt/samesung/ai/psfn-live-mi-0on41/src/memory/retrieval.ts).
- Focus sessions already carry a normalized `scope` string and persisted knowledge blocks in [`src/session/focus-knowledge.ts`](/mnt/samesung/ai/psfn-live-mi-0on41/src/session/focus-knowledge.ts) and [`src/session/manager.ts`](/mnt/samesung/ai/psfn-live-mi-0on41/src/session/manager.ts).
- Shards already consume a task-scoped context pack with a `purpose` and `memoryBlock` in [`src/shards/types.ts`](/mnt/samesung/ai/psfn-live-mi-0on41/src/shards/types.ts).
- North-star items already use a structured store with fixed scopes in [`src/north-star/store.ts`](/mnt/samesung/ai/psfn-live-mi-0on41/src/north-star/store.ts).

## Decision

Memory scope must be modeled as a structured attachment, not as an ad hoc tag convention.

Tags remain useful, but they are not the source of truth for scope.

The canonical model has three parts:

1. `scopeRef`: stable ownership context for the memory.
2. `scopeTags`: durable query tags that survive compaction and retrieval.
3. `runtimeTags`: ephemeral labels used only for a turn, a focus session, a worker, or a shard lifecycle.

## Canonical Scope Types

The system should recognize these first-class scope families:

- `conversation`
- `contact`
- `project`
- `north_star`
- `task_worker`
- `shard`
- `system`

These are not all stored the same way.

- `contact` and `north_star` are durable identity scopes.
- `project` is the user-facing coordination scope for a focused piece of work.
- `task_worker` is short-lived work under a few hours.
- `shard` is long-lived work that may persist for days or weeks.
- `conversation` is the live chat/session scope.
- `system` is reserved for administrative and runtime-owned memory.

## Tag Model

### Durable tags

Durable tags are allowed to persist into L2 memory and can participate in retrieval, compaction, and reuse across sessions.

Examples:

- `durable`
- `core_profile`
- `core_relationship`
- `relationship_core`
- `project:<project-id>`
- `north_star:<item-id>`
- `contact:<contact-id>`
- `scope:<normalized-scope-id>`
- `focus:<focus-id>` when the focus is intentionally preserved as durable knowledge

Durable tags must be:

- normalized to lowercase
- deduplicated
- stable across replays
- compatible with retrieval heuristics

### Runtime-only tags

Runtime-only tags are allowed for orchestration, but they must not become durable memory identity.

Examples:

- `turn:<turn-id>`
- `request:<request-id>`
- `focus_session:<focus-id>`
- `worker:<worker-id>`
- `shard:<shard-id>`
- `pending`
- `candidate`
- `transient`
- `provisional`

Runtime-only tags are allowed in L0/L1 artifacts and in worker context packs, but they should not be treated as durable memory descriptors when L2 is written.

## Layer Contract

### L0

L0 is the raw transcript and journal layer.

- It captures what was actually said or observed.
- It may include runtime-only tags for diagnostics and compaction.
- It should not be treated as durable memory just because it is present in transcript.

### L1

L1 is live context composition.

- It can combine recent transcript, compaction summaries, focus knowledge, continuity, and scoped memory selections.
- It is the right place to resolve a project scope into concrete retrieval filters.
- It may promote runtime tags into stable request-scoped selectors for the current turn.

### L2

L2 is durable memory.

- It stores the long-lived memory payload.
- It should only keep durable scope tags and stable ownership references.
- It should not depend on transient worker or turn identifiers for meaning.

## Focus Session Extension

The current focus-session primitive is the correct starting point for project scope.

Existing behavior:

- a focus session is started with a freeform `scope`
- focus knowledge is appended as a channel-scoped block
- compaction ranges can remove the raw transcript from L1 while keeping distilled knowledge

This design keeps that flow and narrows it:

- `scope` becomes the human-readable project descriptor.
- focus completion should emit a durable `scopeRef` or equivalent structured marker in future implementation beads.
- focus knowledge blocks should become the bridge between live project work and durable project memory.
- project scope tags should be attached to any memory that is intentionally preserved beyond the session.

Practical rule:

- if the information is only useful while the task is active, keep it runtime-only
- if the information should survive compaction and re-entry, promote it to a durable project tag

## North Star Integration

North-star items are not just another tag.

They are a separate durable alignment layer and should act as a retrieval bias rather than a noisy freeform label.

Recommended behavior:

- `north_star:<item-id>` is a durable tag on memories that materially support that goal.
- L1 context may pull a north-star summary into the live turn when the current work is aligned.
- L2 retrieval should use the north-star tag as an anchor for memory selection, not as a blunt global filter.

This preserves the distinction between:

- a project the user is actively working on
- a north-star item the system is tracking as a persistent directive

## Task Worker And Shard Contract

Short-lived task workers and long-lived shards should not receive the same context shape.

### Task workers

Task workers are under a few hours.

- They should receive a project-scoped memory pack.
- They should inherit the project scope and any relevant north-star tags.
- They should not receive the full durable memory surface unless it is directly relevant.

### Shards

Shards are long-lived work units.

- They should receive a narrower, explicitly tagged context pack.
- They should consume durable project and north-star memory, plus any shard-specific runtime tags needed for the current work.
- Their output should be taggable back into the project scope without polluting the primary conversational self.

This distinction matters because the same memory can be relevant to a few-hour task without being appropriate for a weeks-long shard, and vice versa.

## Compatibility And Migration

This bead does not require a destructive migration.

The compatibility rule is:

- existing `tags` remain valid
- new structured scope metadata is additive
- old tags must continue to read correctly
- writes should normalize into the new model without breaking old data

Implementation constraints for future beads:

- do not rename or remove `tags` from `l2_memories`
- do not assume every memory already has a structured scope ref
- preserve `contact_id` as the current hard link to contact-centric memories
- treat `core_profile`, `core_relationship`, and `relationship_core` as durable legacy tags
- treat focus knowledge and north-star stores as existing producers of scope context, not as legacy dead ends

## What Future Beads Need To Build

1. A scope resolver that can map project, north-star, contact, worker, and shard identifiers into a normalized `scopeRef`.
2. A tag classifier that separates durable tags from runtime-only tags at write time.
3. Retrieval filters that can bias by project and north-star scope without turning scope into a hard global gate.
4. Worker context assembly that passes project scope cleanly to short-lived tasks and shards.
5. Admin and inspection surfaces that show why a memory is attached to a scope.

## Open Design Notes

- `scopeRef` can be represented as a structured field, a side table, or both, but it must become canonical somewhere before the UI and retrieval layers depend on it.
- The exact on-disk shape for project and shard scope is still open, but the semantics above are not.
- Cross-channel continuity should remain a live context concern, not a durable memory scope by default.

## Bottom Line

Use tags for selection and promotion. Use structured scope for meaning.

That keeps the system fast enough to build on now, while giving later implementation beads a stable contract for project memory, north-star alignment, worker scoping, and long-lived shards.
