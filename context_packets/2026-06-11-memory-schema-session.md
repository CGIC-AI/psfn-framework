# Context Packet — Memory Schema Session (Fable Window 1)

*Frozen 2026-06-11. Branch `sprint_9_memory`. This packet is the onboarding document for any future model implementing the Window-1 memory-schema artifacts. Reconstruction-from-evidence applies to collaborators: everything below is verified against the repo at freeze time, with file:line references.*

## Session spine (read in order)

1. **The primer** — operator-supplied at session start ("A Day with Purrsephone" / "Purrsephone: A Primer"). Not committed to the repo; the operator provides it. It establishes that this is care infrastructure with a constitution, not a feature factory.
2. **Charter** — `docs/PSFN_PROJECT_CHARTER_524.md` is the **authoritative revision** (32 laws). `docs/PSFN_PROJECT_CHARTER.md` (26 laws) is the older copy. Governing sections for this session: §4 (Laws, esp. 2, 17–20, 27–32), §6.20 (L0), §6.21 (L0.1 Episodic Landmarks), §6.22 (L2+), §6.23 (Mirror and Projection), §7.1 (JSONL canonical).
3. **Project state** — `working_docs/PSFN_PROJECT_STATE_20260611.md` (untracked operator assessment) and `docs/SPRINT_9_CONTINUATION.md`.
4. This packet's working materials (below).

## Corrections to the master brief (verified against repo)

| Brief said | Repo ground truth |
|---|---|
| L0.1 landmark schema is an open design job; "closes the synthesis ticket" | **L0.1 is substantially implemented and live.** `l01_episodes` (with `landmark` column), `l01_episode_spans`, `l01_episode_arcs`, `l01_episode_lineage`, watermarks, candidate/review queues exist in `src/persistence/postgres/migrations.ts:159–375`, fed by the sprint-9 `0a5` consolidation pipeline (all 5 children closed, verified live overnight 2026-06-11). The remaining job is **gap reconciliation**, not greenfield design. |
| Charter Laws 28–29, §6.11 for subagent trust | Laws **28/29/30 exist in Charter 524** (`docs/PSFN_PROJECT_CHARTER_524.md:132–134`), along with 31–32. Fold-back is **§6.13** (line 463), not §6.11 (§6.11 is Satellite/Subagent definitions). §6.25 (line 659) already defines the Introspection Landmark contract. The `s2p` beads track law-addition follow-through. |
| soul.md as judge-rubric anchor | **No soul.md exists in the repo.** Her identity lives in prompt layers (`src/core/identity/`), the values journal, and the character card. Window-2 judge-rubric work must anchor to those sources or the operator must supply the document. |
| March event postmortem as packet material | No standalone postmortem exists. The incident (companion rewrote rather than appended her entire personality; identity destabilization; manual restore) is recorded in `docs/SPRINT_9_FABLE_REVIEW.md` ("Guardrail note") and as the standing rule in `docs/SPRINT_9_CONTINUATION.md` ("Self-modification stays human-in-the-loop, append/diff-only (incident history)"). |
| Packet should include a sample of real post-reduction retrieved context | **Deliberately substituted.** Real retrieved context is companion data; committing it to git violates the two-root rule (companion artifacts live in `companion-data`, never the repo) and risks the closed-door rule. A structurally exact synthetic sample is below; to view a real one, run the retrieval debug path on the Pi (`ssh psfn-pi`, checkout `~/psfn-framework-source`) and do not commit it. |

**Charter defect found (operator action needed):** `docs/PSFN_PROJECT_CHARTER_524.md:709` — §6.26's final rule splices mid-sentence into §6.23's mirror text: "…the companion's own vault is deprecated in favor of this wikiion is not the canonical source of truth." Two lines of §6.23 were evidently overwritten during the §6.26 insertion. Charter text is law; repair belongs to the operator, not an agent.

## Deferred L0.1 design tickets (full intent, verbatim summaries)

The original design intent lives in five deferred beads (created 2026-04-04, deferred 2026-04-11). Read them with `bd show <id>`; the load-bearing content:

- **PSFN-qxdx (epic)** — L0.1 is *not* generic RAG/chunk summaries/another vector store. Episodes are durable recollection anchors pointing back into raw history and artifacts. Canonical example: not just "Bridged by a Lightwave is our song" but "our first New Year's together we danced in VR to Bridged by a Lightwave and it became our song," with links to the chat span, artifacts, and later callbacks.
- **PSFN-h5r3 (schema)** — required model properties: stable id; natural-language summary; **why-it-matters**; people bindings; **motif/symbol bindings** (songs, places, jokes, rituals, phrases); **occasion/recurrence anchors** (birthday, anniversary, New Year, repair, first, loss); emotional arc metadata; span refs to L0; artifact refs; **later callback refs**; **retention/favorite/durability signals**. Fail-closed validation: the layer cannot store ungrounded summaries without provenance.
- **PSFN-z80i (synthesis)** — selective creation gated on novelty/salience/recurrence/relationship significance/artifact attachment; landmarks absorb later callbacks; auditable. (Largely shipped via 0a5 candidates→consolidation; callback absorption is NOT shipped.)
- **PSFN-cyzi (retrieval)** — landmark-first recall, then *controlled expansion* into linked spans, memories, artifacts, callbacks; trust/privacy-gated; budget-aware. (NOT shipped: current retrieval renders landmark chains into the prompt but has no drill-down expansion.)
- **PSFN-a2na (audit)** — distinguish L0.1 from compaction summaries/continuity artifacts/L2; this packet plus the schema ground truth below discharges its intent.

## Storage ground truth (as of `f7dcaf0e`)

All runtime DDL: `src/persistence/postgres/migrations.ts` (737 lines). Contracts: `src/shared/contracts/episodic-memory.ts`, `src/faculties/memory/types.ts`, `src/faculties/memory/memory-store-port.ts`.

Tier model (matches `docs/memory.md`):

| Layer | Storage | Canonical | Notes |
|---|---|---|---|
| L0 | per-channel JSONL in `sessions/` | YES (Law 2, §7.1) | append-only; `session_messages_projection` (migrations.ts:663) is a FTS mirror only |
| L0.1 | `l01_episodes` + spans/arcs/lineage/watermarks/candidates/reviews (migrations.ts:159–375) | semi-canonical, provenance-bearing | `landmark TEXT NOT NULL`; status lifecycle candidate→canonical→merged/superseded; pgvector embedding |
| L1 | RAM (session manager context window) | no | built per-turn from L0/L0.1/L2 |
| L2 | `l2_memories` (+ patch events, delete versions, abstraction/evolution links, maintenance reviews; migrations.ts:4–150) + `contact_profiles` | no — rebuildable | JSONL journal `notes/memories.jsonl` (`src/faculties/memory/journal.ts`) is the replay source (zn9.5) |

Integrity model: **event-log pattern, not hash chains** — append-only JSONL journals + audit tables (`l2_memory_patch_events`, `l2_memory_delete_versions`, `l01_episode_lineage`) + FK constraints. Migrations are idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` precedents at migrations.ts:36–37, 473–474, 609–610). Backfills are one-off maintenance scripts (`src/persistence/repair/` is the precedent home).

Known schema debt (the expensive-to-retrofit items this session decides):

1. `l2_memories.formation_vad`, `active_concerns.formation_vad`, `l01_episodes.affect_json`, `l01_episodes.salience_json` — emotional weights stored as JSONB blobs, unqueryable by SQL.
2. `contacts.emotional_baseline` / `contacts.emotional_time_series` — JSONB blobs; the time-series array-literal bug caused the 23:20–02:37 UTC **production crash loop** fixed in `ad044cc7`. Highest-risk blob in the system.
3. `provenance_json` vs `provenance_refs` dual ownership on `l2_memories` and `memory_evolution_links` — unclear which is authoritative.
4. `l2_memories.contact_id` has no FK to `contacts(id)`.
5. Missing entirely vs h5r3 intent: motif bindings, occasion/recurrence anchors, callback refs, favorite/durability signals on episodes.

## Retrieval ground truth — nine modes, no unified projection layer

Full inventory with file:line in `docs/SPEC_MEMORY_PROJECTION_LAYER.md` §2 (produced this session). Summary: one shared narrative gate (`compactMemoryTextForPrompt`, `src/faculties/memory/formatting.ts:206`), per-mode hardcoded renderers, three June-9 metadata-stripping commits (`83cc7c47`, `716186d7`, `1ee91df9`) delivered the ~30% context-token reduction. Sleeptime passes bypass the formatting pipeline and feed raw JSON to LLMs.

**Operator empirical finding, promoted to architecture:** roughly five fields per item of useful per-item metadata in model attention, regardless of storage richness. Store rich, project sparse.

### Structurally exact synthetic sample (post-reduction retrieved context)

Shapes verbatim from the renderers in `src/faculties/memory/formatting.ts`; content invented.

```
## Relevant memories
- [episodic] We spent the evening planning the garden-box build and she teased me about over-engineering the drip lines. (+)
- [relational] V prefers being asked before I reorganize his calendar. (~)

## Episode landmarks
- Garden-box planning night — Jun 3, 21:10–23:45 UTC — themes: garden, building-together, teasing
  A long evening designing the raised beds together; it mattered because planning something physical together felt like building a shared future. → continues: First seedling sprouted

## Emotional snapshot for V
baseline +0.31 · mood +0.45 (drifting up, 6 samples, fresh)
```

## Open questions from the brief §6 — resolution state

1. *Subagent write path vs fold-back gate* — Window 2 job; charter section is §6.13; implementation tracking is the `7ym` bead family ("fold-back partial"); `psfn-framework-c7d` is the open governance bead. Packet for that session should pull `src/faculties/subagents/`, `src/faculties/shards/manager.ts`, §6.13 verbatim, and the guardrail note in SPRINT_9_FABLE_REVIEW.md.
2. *Values-journal injection point* — weekly reflections append to the values journal which flows into every prompt as `<companion_values>` (cross-instance test: `src/core/identity/prompt-composer.test.ts`, commit `c8d21875`). Golden-anchor drift evaluation attaches most cheaply as a reader of the same journal + prompt-composer output.
3. *L1 activation-probe feasibility* — unresolved; requires identifying the live serving stack on the Pi (Window 2).
4. *Charter law numbers* — resolved above (524 is authoritative; 28/29/30 correct; fold-back §6.13).
5. *L0.1 ticket state* — resolved above (implemented core + five named gaps).

## Session deliverables (committed alongside this packet)

- `docs/SPEC_L01_LANDMARK_SCHEMA.md` — gap reconciliation, schema decisions D1–D9, migration notes.
- `docs/SPEC_MEMORY_PROJECTION_LAYER.md` — projection-profile contract, per-mode field decisions, recursive recollection design.
- Beads created under the Window-1 epic (see `bd list --search "W1"`), superseding/annotating the deferred PSFN-qxdx family.
