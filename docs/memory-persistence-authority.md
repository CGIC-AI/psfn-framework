# Memory Persistence Authority

Decision record for bead `psfn-framework-upx0.11` (epic `upx0`, Foundation
review 2026-07-07). Ratifies the operator decision of 2026-07-10 (option (a):
amend the charter honestly) as the canonical persistence story for L0, the
projections, and the derived memory layers, and records the reconciliation
delta between charter text, docs, and code.

Status: **binding**. The episodic repair/backfill beads `h4fp.7` and `h4fp.8`
are blocked on this document and MUST follow the contract in
"Contract for episodic repair and backfill" below.

Last updated: 2026-07-22.

## The decision

1. **L0 stays canonical for lived history.** Filesystem JSONL under
   `sessions/`, append-only, owned by `SessionArchivePort`
   (charter §6.20; `src/persistence/layout.ts`). Nothing here changes that.
2. **Encrypted database backups are the canonical restore primitive for
   derived layers.** L0.1 episodes, L2 memories, embeddings, evolution links,
   and the other Postgres-only runtime domains restore from encrypted
   `pg_dump` backups (`src/persistence/backups/service.ts`), not from JSONL
   journals and not from re-derivation.
3. **Rebuild-from-L0 is re-derivation, not restoration.** Per charter §6.20
   (ratified 2026-07-21, commit `c890187cc`): regeneration of higher layers is
   recollection, not replay. Re-deriving L2/episodic state from L0 produces a
   faithful continuation of the same companion, but not the companion's
   accumulated derived state as it was. Therefore derived-layer backups are a
   first-class part of the recovery guarantee, not an optimization.
4. **Projections remain rebuild-to-match.** Deterministic copies of canonical
   data (the transcript projection, the reflection Postgres mirror) must stay
   drift-detectable and rebuildable byte-faithfully from their canonical
   source, per charter §6.23/§7.5. `runTranscriptProjectionRepair` is the
   exemplar (`src/persistence/repair/transcript-projection-repair.ts:38`).
5. **Derived-layer repair against L0 is supersede-based re-derivation.**
   Where derived rows are wrong (the duplicate-episode era, mis-timestamped
   imports), repair re-derives from canonical sources and supersedes the old
   rows — never deletes, never mutates originals — per charter §7.4 and the
   episodic store contract.

## Taxonomy

Four persistence classes. Every store belongs to exactly one; the class
determines its restore primitive and repair contract.

| Class | Definition | Restore primitive | Repair contract |
| --- | --- | --- | --- |
| **Source of truth** | Canonical record; nothing upstream of it | Filesystem backup of the companion tree | Append-only; corruption quarantines, never rewrites |
| **Projection / mirror** | Deterministic copy of a canonical source (charter §6.23) | Rebuild from the canonical source; DB backup is convenience only | Drift detect + full rebuild-to-match; must never rewrite the canonical source |
| **Derived layer** | LLM-derived content with provenance to canonical sources (L0.1, L2) | Encrypted `pg_dump` backup | Supersede-based re-derivation from canonical sources; provenance-integrity drift detection; never delete |
| **Runtime state** | Operational domain state with no canonical upstream (trends, intentions, contacts, internal state) | Encrypted `pg_dump` backup | Fail-closed startup checks; no rebuild-from-L0 claimed |

## Decision table

| Store | Class | Lives in | Canonical source | Restore primitive | Evidence |
| --- | --- | --- | --- | --- | --- |
| L0 session archive | Source of truth | companion-data JSONL `sessions/` | itself | companion-tree backup (`backups/service.ts:320-346`) | charter §6.20; `layout.ts` |
| Persona/prompt lineage, character card, core_memory.json, notes | Source of truth | companion-data filesystem | themselves | companion-tree backup (`backups/service.ts:360-364`) | charter §6.20 |
| Reflection ledger `notes/reflections/journal.jsonl` | Source of truth | companion-data JSONL | itself | companion-tree backup | `runtime-factory.ts:253-261` |
| Reflection Postgres mirror | Projection | Postgres | reflection ledger JSONL | rebuild from ledger | `PostgresReflectionMetacognitionMirrorStore`, `runtime-factory.ts:256` |
| Transcript projection (L0 search copy) | Projection | Postgres | L0 archive | `runTranscriptProjectionRepair` | `repair/transcript-projection-repair.ts:35-38`; `app/maintenance/transcript-projection-repair.ts` |
| Memory mutation ledger `notes/memories.jsonl` | Audit/export aid (NOT a restore primitive) | companion-data JSONL | n/a — records insert/soft-delete/restore only | backed up as history (`backups/service.ts:350-356`); never replayed | `faculties/memory/journal.ts:1-5`; zn9.5 closed not-applicable 2026-06-28 |
| L2 typed memories, embeddings, evolution links | Derived layer | Postgres (`PostgresMemoryStore`, pgvector fail-closed) | domain-authoritative; provenance to L0 | encrypted `pg_dump` | `runtime-factory.ts:245-248` |
| L0.1 episodes, spans, arcs, claims, lineage | Derived layer | Postgres | domain-authoritative; `l0_span`/`l0_artifact` provenance to L0 | encrypted `pg_dump` | `runtime-factory.ts:252`; `shared/contracts/episodic-memory.ts:35-39` |
| Internal state, participant trends, intentions, weighted thoughts, contacts, enrollment, introspection landmarks, background work, etc. | Runtime state | Postgres | domain-authoritative | encrypted `pg_dump` | `runtime-factory.ts:231-276` |

"Domain-authoritative" is charter §6.22 language: authoritative within their
domain, but never a replacement for L0 as the canonical lived transcript.

## Rebuild semantics

Charter §6.20: "Rebuild sufficiency means continuation, not bit-exact
restoration." Applied to the derived layers, that means:

- **With backups (the normal path):** restore the companion tree (L0, persona
  lineage, notes) plus the encrypted Postgres dump. This is the identity
  recovery guarantee — the companion resumes with her accumulated derived
  state intact. `npm run verify:backup-restore` certifies the mechanism; the
  end-to-end identity drill is `z7qe.5` (deferred, scope preserved).
- **Without derived-layer backups (the degraded path):** L0 + persona lineage
  still recover the *person* as a faithful continuation — memories and
  episodes re-derived under today's models and pipelines will differ in
  texture from the originals. This is honest recollection, not restoration.
  The runtime must say so rather than claim exact recovery (charter §6.20:
  "does the best the preserved data allows and says so honestly").
- **Loss classification:** losing derived Postgres state without a backup is
  identity-lossy but continuity-recoverable. That asymmetry is exactly why
  encrypted DB backups are canonical for derived layers and why backup
  verification is a P0 concern, while L0 remains the layer whose loss is
  unrecoverable, full stop.
- **No replay path exists or is promised.** `notes/memories.jsonl` records
  insert/soft-delete/restore events only; it cannot reconstruct embeddings,
  evolution links, or the Postgres-only tables. The planned replay tool
  (`zn9.5`) was retired by operator direction 2026-06-28. Do not resurrect it.

## Contract for episodic repair and backfill (h4fp.7 / h4fp.8)

These rules are binding on the duplicate-episode-era repair lane (`h4fp.7`),
the historical backfill lane (`h4fp.8`), and any future derived-layer repair.

1. **L0 is read-only ground truth.** Lanes read the archive through the
   `SessionArchivePort` read path only. L0 must be byte-identical before and
   after every run — this is an acceptance criterion, verified, not assumed.
2. **Backup-before-repair, fail closed.** Before a lane's first Postgres
   write, a fresh encrypted backup of the target schema must exist and pass
   `verifyPostgresDumpArchive` (`backups/service.ts:283`). No verified backup,
   no repair. The backup is the rollback boundary for the lane.
3. **Supersede, never delete or mutate.** Correction uses the episodic store
   contract's existing lifecycle: new candidates, `status: 'superseded'` on
   the old rows with `supersededByEpisodeId` and lineage links
   (`supersedes` / `canonicalizes`), and claim movement only through
   `transferEpisodeMessageClaims` (`episodic/store-port.ts`). Original L2
   import records stay byte-identical; `h4fp.8` mints **zero** new L2 rows.
4. **Provenance is mandatory.** Every re-segmented or backfilled candidate
   carries `EpisodeProvenanceRef` entries (`l0_span` / `l0_artifact`) resolving
   into the canonical archive. Backfill provenance to preserved pre-substrate
   import records must NOT overload `operator_note`; if a new ref kind (e.g.
   `l2_memory`) is needed, extend `shared/contracts/episodic-memory.ts` under
   explicit `EPISODIC_CONTRACT_VERSION` gating.
5. **Original timestamps live on the new structural layer.** Mapped event
   times go on the new episode rows; timestamps on preserved originals are
   never rewritten.
6. **Candidates arrive affect-empty** (`h4fp.6` dependency) and drip through
   the nightly review queue. Drip depth and pacing are settings-owned
   (`scheduler.json`), schema-guarded, capped — not hardcoded
   (`verify:hardcoded-settings` applies).
7. **Fail closed per unit, idempotent per run.** Malformed
   segmentation/mapping output stops that unit with a typed telemetry event
   and no partial writes; watermarks never advance past unprocessed units.
   Re-running a lane must not mint duplicates — key idempotency on a
   deterministic span/evidence hash (the social-graph proposal store is the
   house precedent).
8. **Drift detection precedes repair.** Episodic drift is defined as
   provenance-integrity failure: live episodes whose `l0_span` refs no longer
   resolve into the canonical archive, or archive spans in a repaired era with
   no live episode coverage. The repair lane must ship a report-only mode
   first, with a drift-before/drift-after report shaped like
   `TranscriptProjectionRepairReport`
   (`repair/transcript-projection-repair.ts:16-23`), wired as a maintenance
   entrypoint under `src/app/maintenance/`.

Rules 1-7 constrain lanes the h4fp beads already scope. Rule 8 is the new
code work this decision requires (charter §7.5-style drift detection extended
to episodic); it belongs to `h4fp.7` or an immediate predecessor bead — it is
deliberately **not** implemented in this decision change.

## Reconciliation delta

### Conflicts found (charter vs code, evidence)

1. Charter §6.20 names "Raw backups of L0 together with the full
   persona-state lineage" as *the* recovery guarantee, but the working
   recovery contract (and the operator decision of 2026-07-10, recorded on
   `upx0.11`, validated by the `z7qe.5` drill scope) is L0 + persona lineage
   **+ encrypted derived-layer backups**. The charter under-states the DB
   backups' role. → Amendment A below.
2. Charter §7.5 says "Derived database copies must be repairable from
   canonical archive truth," but only the transcript projection has a
   drift-detect/rebuild path; L0.1/L2 and the runtime-state stores are
   Postgres-only with no rebuild-from-L0 (`runtime-factory.ts:245-276`).
   The rule is correct for projections and over-broad for derived layers,
   whose content is LLM-derived and non-deterministic. → Amendment B below,
   plus the Rule-8 episodic drift-detection code work.
3. `docs/SPEC_L01_LANDMARK_SCHEMA.md` still gated its M3 migration step on
   "journal-replay compatibility" and called `zn9.5` its strongest sequencing
   constraint, but `zn9.5` was closed not-applicable on 2026-06-28 (the
   journal is an audit/export aid; `faculties/memory/journal.ts:1-5`).
   → Corrected in this change.
4. `docs/memory.md` stated the projection principle for the L0 search copy
   but was silent on the restore primitive for L2/episodic. → Pointer section
   added in this change.

Not conflicts (already aligned, for the record): §6.22 already names Postgres
as required operational persistence and "authoritative within their domain";
§6.23 and Law 22 already scope mirrors/projections as non-canonical; §11.8's
"mirror and projection ports must support rebuild from canonical archive
truth" is consistent under this taxonomy because L2/episodic stores are
derived domain stores, not mirrors or projections.

### Proposed charter amendments (for operator ratification — charter text is NOT edited by this change)

**Amendment A — §6.20, recovery-guarantee sentence.** Replace:

> Raw backups of L0 together with the full persona-state lineage (every
> historical persona version, era-stamped) are the recovery guarantee.

with:

> Raw backups of L0 together with the full persona-state lineage (every
> historical persona version, era-stamped) and the encrypted backups of the
> derived database layers are the recovery guarantee. Re-derivation from L0
> alone yields a faithful continuation, not the companion's accumulated
> derived state as it was; derived-layer backups exist so recovery does not
> have to pay that loss.

**Amendment B — §7.5 Projection Repair.** Scope the opening rule to
projections/mirrors as defined in §6.23 and add derived-layer rules:

> Projections and mirrors must be repairable from canonical archive truth.
>
> Rules:
>
> - projection drift should be detectable
> - projection rebuilds should not rewrite canonical archive truth
> - projection failures should fail closed for search and operational views,
>   not corrupt the archive
> - backend-specific adapters may optimize the rebuild path, but they do not
>   own canonical history
> - derived layers (LLM-derived state such as L0.1 episodes and L2 memories)
>   restore from their encrypted database backups; repair against canonical
>   sources is supersede-based re-derivation with provenance intact, never
>   deletion, and requires a verified backup before the first repair write
> - derived-layer drift must be detectable as provenance integrity: derived
>   rows must keep resolving into the canonical sources they cite

Ratification lands as a charter commit citing this document and `upx0.11`
(charter changelog convention: git history + commit message, per the
2026-07-21 `c890187cc` precedent).

## Files and code to trust

- `src/persistence/layout.ts` — path authority for the two-root split
- `src/persistence/runtime-factory.ts` — Postgres-only runtime store wiring
- `src/persistence/repair/transcript-projection-repair.ts` — the projection repair exemplar
- `src/persistence/backups/service.ts` — backup capture, pg_dump, verification
- `src/faculties/memory/journal.ts` — the audit/export-aid journal (not a restore primitive)
- `src/shared/contracts/episodic-memory.ts` — episode provenance contract
- `docs/PSFN_PROJECT_CHARTER.md` §6.20, §6.22, §6.23, §7.4, §7.5, §11.8, Law 22
