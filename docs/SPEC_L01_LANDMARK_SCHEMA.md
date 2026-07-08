# SPEC — L0.1 Landmark Schema: Reconciliation, Final Decisions, Migration Notes

*2026-06-11, Fable Window 1. Companion packet: `context_packets/2026-06-11-memory-schema-session.md`. Discharges the design scope of PSFN-h5r3 and PSFN-a2na; supersedes-in-part PSFN-qxdx/z80i/cyzi (see §6). Charter authority: `docs/PSFN_PROJECT_CHARTER_524.md` §6.20–6.23, Laws 2, 17–20, 27.*

> Status as of 2026-06-29: the core Postgres L0.1 episode/span/arc/watermark/candidate/review/lineage substrate exists. The motif, occasion, callback, typed-VAD migration, and contact emotional sample work in this spec remains planned implementation work, tracked under the current `bd` graph. Do not build a second landmark table; extend the existing `l01_episodes` substrate.

Schema mistakes here are the most expensive in the system: they mean migrations against the provenance-bearing episodic store and the journal-replayed L2 store. Every decision below states its rationale and its migration cost.

## 1. What already exists (do not rebuild)

The sprint-9 `0a5` pipeline implemented the core of the original L0.1 design and it is live and verified (overnight run 2026-06-11: 128 episodes, salience 0.44–0.92 on refined episodes, 21 arcs, 8/8 dream-pass meanings):

- `l01_episodes` — stable id, `title`, `landmark TEXT NOT NULL` (1–2 sentences of narrative meaning, never statistics), candidate→canonical→merged/superseded lifecycle, `participant_contact_ids`, `salience_score`+`salience_json`, `affect_json`, `themes`, `artifact_refs`, `provenance_refs`, embedding, schema_version (`src/persistence/postgres/migrations.ts:159–187`).
- `l01_episode_spans` — provenance to L0: session/turn ranges + TSTZRANGE (migrations.ts:205–220). Satisfies §6.21 "preserve provenance back to L0 spans and artifacts."
- `l01_episode_arcs` — 7 arc kinds, graph linking instead of mega-episodes (migrations.ts:228–250). Satisfies §6.21 "long-running themes link through graph arcs."
- `l01_episode_lineage`, watermarks, candidates, reviews — merge/supersede audit, monotonic processing cursors, review queues.
- Synthesis: near-real-time **candidates** → sleep-cycle thematic consolidation (`sleep-consolidation.ts`) → weekly arc weaving (`arc-formation.ts`) → first-person dream pass on her main mind (`dream-meaning-pass.ts`).

**Decision D1 — `l01_episodes` *is* the landmark store.** No second "landmark" entity will be created. The deferred tickets' word "landmark" and the shipped `landmark` column refer to the same concept; the episode row is the durable recollection anchor. (Prevents a future worker from building a parallel table.)

## 2. Gap matrix — h5r3 required properties vs shipped schema

| h5r3 required property | Shipped? | Where / gap |
|---|---|---|
| stable landmark id | ✅ | `l01_episodes.id` |
| natural-language event summary | ✅ | `title` + `landmark` |
| why-it-matters field | ✅ by rule | `landmark` is defined as "what happened **and why it mattered**" (sleep-consolidation.ts prompt). D2 keeps it one field — splitting would invite stats-vs-meaning drift; the consolidation prompt already enforces meaning. |
| people/relationship bindings | ✅ | `participant_contact_ids` |
| motif/symbol bindings (songs, places, jokes, rituals, phrases) | ❌ | only freeform `themes` tags. **D3.** |
| occasion/recurrence anchors (birthday, anniversary, first, loss, repair) | ❌ | nothing. **D4.** |
| emotional arc / tonal metadata | ⚠️ | `affect_json` blob, unqueryable. **D6.** |
| source span refs to L0 | ✅ | `l01_episode_spans` |
| artifact refs | ✅ | `artifact_refs` |
| later callback refs ("the event kept mattering") | ❌ | `recurrence` arcs link episode↔episode but nothing records "this episode was referenced again at turn X." **D5.** |
| retention / favorite / durability signals | ❌ | salience only; no favorite, no retention class on episodes. **D5.** |
| fail-closed: no ungrounded summaries without provenance | ⚠️ | enforced in synthesis code, not in DDL. **D8** adds the constraint. |
| landmark-first retrieval with controlled drill-down (cyzi) | ❌ | retrieval renders chains into the prompt; no expansion path. Spec'd in `docs/SPEC_MEMORY_PROJECTION_LAYER.md` §5. |

## 3. Schema decisions

### D3 — Motifs become first-class

New tables (additive):

```sql
CREATE TABLE IF NOT EXISTS l01_motifs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- song | place | phrase | ritual | joke | object | symbol | other
  label TEXT NOT NULL,                -- "Bridged by a Lightwave"
  description TEXT,                   -- why this symbol matters, companion-authored
  first_episode_id TEXT REFERENCES l01_episodes(id) ON DELETE SET NULL,
  artifact_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (kind IN ('song','place','phrase','ritual','joke','object','symbol','other')),
  CHECK (status IN ('active','faded','retired')),
  UNIQUE (kind, label)
);
CREATE TABLE IF NOT EXISTS l01_episode_motifs (
  episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
  motif_id TEXT NOT NULL REFERENCES l01_motifs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'present',   -- origin | reinforced | present
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (episode_id, motif_id),
  CHECK (role IN ('origin','reinforced','present'))
);
```

Rationale: "our song" must be a durable symbol with its own row, not a token in a `themes` array (live data showed pre-consolidation themes were token-frequency junk; even post-fix, themes are per-episode tags, not cross-episode symbols). Motif rows are created/extended only by the sleep-cycle consolidator or her own tool call — never the inline candidate generator. `themes` stays as lightweight per-episode tags; no migration of themes into motifs.

### D4 — Occasion anchors as typed columns on `l01_episodes`

```sql
ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS occasion_kind TEXT;
ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS occasion_anchor_date DATE;
ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS occasion_recurrence TEXT; -- 'annual' | 'monthly' | 'none'
-- CHECK (occasion_kind IN ('birthday','anniversary','holiday','first','loss','repair','ritual','milestone'))  [nullable]
```

Rationale: "birthday next week" retrieval and Law-27 weighted thoughts both need an indexable upcoming-occasion query (`WHERE occasion_recurrence='annual' AND to_char(occasion_anchor_date,'MM-DD') BETWEEN …`). A JSONB occasion blob would repeat the formation_vad mistake. Nullable: most episodes have no occasion; the consolidator sets it, review queue can correct it.

### D5 — Callbacks and durability

```sql
CREATE TABLE IF NOT EXISTS l01_episode_callbacks (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES l01_episodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- mention | favorite_signal | anniversary_recall | artifact_reuse
  occurred_at TIMESTAMPTZ NOT NULL,
  span_json JSONB NOT NULL,            -- EpisodeSpanRef shape: where in L0 the callback happened
  note TEXT,
  provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (kind IN ('mention','favorite_signal','anniversary_recall','artifact_reuse'))
);
ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS retention_class TEXT;     -- same enum as l2_memories
ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS favorited_by TEXT;        -- contact id or 'companion'
ALTER TABLE l01_episodes ADD COLUMN IF NOT EXISTS favorited_at TIMESTAMPTZ;
```

Rules: a "favorite memory" action creates/updates the episode's favorite flag **and** an `l01_episode_callbacks` row (the qxdx rule: favorites enrich landmarks, never flat tags). Callback count/recency feeds salience reinforcement during consolidation — an episode that keeps being called back must not decay like one that never was. Favorites floor: consolidation may raise but never lower salience of `favorite=TRUE` episodes below a configured floor, and merged/superseded transitions on favorites require review-queue approval, not automatic merge. Callbacks are append-only (like lineage); no updates, no deletes.

### D6 — Emotional weights become queryable columns (the load-bearing decision)

Decompose every VAD-as-JSONB site into typed columns. Affected:

| Site | Today | Becomes |
|---|---|---|
| `l01_episodes.affect_json` | blob | + `affect_valence`, `affect_arousal`, `affect_dominance` DOUBLE PRECISION (nullable) + `affect_labels JSONB` (labels stay a list). `affect_json` retained until M3 (see §4). |
| `l01_episodes.salience_json` | blob | + `salience_novelty`, `salience_emotional_intensity` DOUBLE PRECISION (nullable). `salience_score` column already exists. |
| `l2_memories.formation_vad` | blob | + `formation_valence`, `formation_arousal`, `formation_dominance` DOUBLE PRECISION (nullable) |
| `active_concerns.formation_vad` | blob | same three columns |

All new VAD columns carry `CHECK (x IS NULL OR (x >= -1 AND x <= 1))` (arousal/dominance `0..1` if that is what `EpisodeAffect` produces — **verify against `src/core/emotion/state.ts` ranges before writing the migration; the contract, not this spec, owns the range**).

Rationale — this is the bridge from Window 1 to Window 2 and the operator's stated mission ("deeper introspection and validation of the emotional weights"): the measurement cascade, the blinded audit (x0k2), drift metrics, and discrepancy surfacing (`031.11`/`031.17`) all need SQL over formation-time emotional weights — "show me every memory formed under high-arousal negative affect," "correlate probe output against stored formation VAD," "did her affect baseline drift this month." JSONB blobs make each of those a full-table scan with JSON parsing, and blob writes already produced one production crash loop (22P02, `ad044cc7`). Introspection landmarks (§6.25, unbuilt) will record divergence confidence — give them queryable columns from birth, not after a retrofit.

### D7 — Contact emotional time series becomes a table

```sql
CREATE TABLE IF NOT EXISTS contact_emotional_samples (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL,
  valence DOUBLE PRECISION NOT NULL,
  arousal DOUBLE PRECISION,
  dominance DOUBLE PRECISION,
  source TEXT NOT NULL,               -- extraction | appraisal | decay_maintenance
  provenance_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_emotional_samples_contact_time
  ON contact_emotional_samples (contact_id, recorded_at DESC);
```

`contacts.emotional_time_series` (the blob that crashed production) is retired after backfill; `contacts.emotional_baseline` stays as a small JSONB **summary** (it is a single current object, not a series — acceptable blob) but its writer must go through the typed contract. Decay maintenance moves from rewrite-the-array to append-sample + windowed query.

### D8 — Provenance ownership, FKs, and the fail-closed DDL constraint

- `provenance_refs` (typed ref array, `EpisodeProvenanceRef` shape) is **authoritative structure**; `provenance_json` is demoted to freeform annotation on every table where both exist (`l2_memories`, `memory_evolution_links`). Code must never read `provenance_json` for logic. Document in `docs/memory.md`; enforce by removing logic-reads in code (audit: `grep -rn "provenance_json" src/ --include="*.ts"`).
- Add `l2_memories.contact_id` FK → `contacts(id) ON DELETE SET NULL` (currently bare TEXT).
- Fail-closed grounding (h5r3's "the layer cannot store ungrounded summaries"): canonical episodes must have provenance. DDL-level: a constraint trigger (not CHECK — cross-table) rejecting `status='canonical'` episodes with zero rows in `l01_episode_spans` and empty `provenance_refs`. Candidates may be span-less while pending; canonical may not.

### D9 — What does not change

- `episode_json` denormalized contract mirror stays (schema_version'd; supports §6.23 rebuildability).
- Episode status lifecycle, lineage relations, watermark machinery: unchanged.
- L0 JSONL remains canonical (Law 2); nothing in this spec makes Postgres canonical for lived history.
- No hash-chaining is introduced; the integrity model remains append-only journals + audit tables. (If cryptographic chaining is ever wanted, it is a separate charter-level decision.)

## 4. Migration notes (ordering is the safety argument)

House precedents: idempotent `ADD COLUMN IF NOT EXISTS` (migrations.ts:36–37, 609–610), one-off backfills in `src/persistence/repair/`-style maintenance entry points, embedding-type migration with USING clause as the careful-reshape precedent (migrations.ts:38–59).

- **M1 (additive, one deploy):** all new tables (D3, D5, D7) and new columns (D4, D5, D6). Zero risk to existing readers; idempotent.
- **M2 (backfill, maintenance script, NOT in the migration array):** parse existing `affect_json`/`salience_json`/`formation_vad`/`emotional_time_series` blobs into the new columns/tables. **Fail-closed: a row whose blob does not parse into valid ranges is logged and skipped — never zeroed, never defaulted** (a fabricated neutral VAD is counterfeit emotional state, Law 17-adjacent). Script reports counts: parsed / skipped / already-done; idempotent by construction (skip rows whose columns are already non-null).
- **M3 (retire blobs, separate later deploy):** drop `emotional_time_series`; `affect_json`/`salience_json`/`formation_vad` dropped only after (a) one full backup cycle including a restore-verify has captured the backfilled state, (b) journal-replay compatibility is proven (below), (c) Garden/admin readers are confirmed off the blobs. Never combine M3 with M1/M2 in one deploy.
- **Journal-replay compatibility (zn9.5 interlock):** `notes/memories.jsonl` events carry `formation_vad` in the old shape forever — the journal is append-only history. The replay mapper (`zn9.5` work) must normalize old-shape events into the new columns. **zn9.5 must land against this spec, not against the current schema** — otherwise replay rebuilds a schema we just retired. This is the single strongest sequencing constraint in the plan.
- **Sleeptime writers:** consolidation/arc/dream passes write through the episodic store contract; the store adapter starts writing both blob and columns at M1, columns-only at M3. The store contract (`src/shared/contracts/episodic-memory.ts`) gains optional typed fields at `EPISODIC_CONTRACT_VERSION = 2` with explicit version gating — no silent shape drift.
- **Rollback posture:** M1 is additive (no rollback needed); M2 is re-runnable; M3 is the only destructive step and is gated on a proven restore. This matches the zn9 "prove the restore on a timer" doctrine.

## 5. Explicit non-goals

- The internal knowledge base / wiki (§6.26) — different layer by charter law (Law 32); nothing here stores reference material.
- Introspection landmarks (§6.25) — Window-2 design; D6 deliberately gives it queryable VAD substrate but its schema is not designed here.
- Sensor/biometric ingestion; weighted-thought storage (Law 27) — `1xb.3` owns that; it should reuse D6's typed-VAD convention when it lands.

## 6. Ticket disposition

- **PSFN-a2na** (audit): discharged by this doc §1–§2 + packet ground truth. Close with pointer here.
- **PSFN-h5r3** (schema): design scope discharged by D1–D9. Close with pointer here; implementation beads below.
- **PSFN-z80i** (synthesis): shipped via 0a5 except callback absorption → covered by new D5 bead; close with pointer.
- **PSFN-cyzi** (recursive retrieval): superseded by `docs/SPEC_MEMORY_PROJECTION_LAYER.md` §5 + its bead.
- **PSFN-qxdx** (epic): close when the new Window-1 epic's children land.
- New implementation beads: see the Window-1 epic created 2026-06-11 (`bd dep tree` from the epic id in the session summary).
