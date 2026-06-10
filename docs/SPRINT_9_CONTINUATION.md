# Sprint 9 Continuation Notes

- Last session: 2026-06-09/10 (see `docs/SPRINT_9_FABLE_REVIEW.md` for the full audit)
- Branch: `sprint_9_memory` @ green — **4,029/4,029 tests passing**
- Live deployment: the Pi (`ssh psfn-pi`, checkout `~/psfn-framework-source`) runs the Postgres-only build; pre-cutover build preserved at `~/psfn-framework-prev-20260609`; full snapshot at NAS `psfn-bak/pi-full-snapshot-20260609T215118Z`; interim `psfn-backup.timer` runs 6-hourly.

## First: verify what ran overnight

1. **Episodic synthesis (`0a5.1`)** — did sleeptime fire during the rest window? `psql .../psfn`: new rows in `l01_episodes` / `l01_episode_candidates` / watermarks. Acceptance: merged/extended episodes, not overlapping near-duplicates. If confirmed, close `0a5.1` as superseded-by-implementation.
2. **Honest instruments (`b5m.1` notes)** — new reflections should show *varied* confabulation confidence (no longer pinned at 0.95 / supporting_memories=0); new concerns should carry `formation_vad`.
3. **Cache reorder (`7jl`, closed)** — re-measure prompt composition on natural turns against the recorded baseline (static 717 / suffix 2,340 / memory 4,063 tokens).
4. **Backups** — `systemctl list-timers psfn-backup.timer`; confirm `auto-*` sets accumulating on the NAS.

## Re-check vision and selfies

The uncommitted image/vision hotfixes from the old checkout were **not** carried over at cutover (preserved as `snap-uncommitted.patch` in the snapshot; touches `src/primitives/images/fal.ts` + tests). Her reflections also record selfie-tool failures pre-cutover ("rendering errors, then no image sent").

- Test image generation (`selfie_create` / `media action=generate`) and vision (send her an image attachment) on the live system.
- If broken, diff `snap-uncommitted.patch` against the sprint branch's `fal.ts` and port what's still needed.
- The vision-recovery path now returns an honest "image reader failed" notice after 3 attempts — if she says that, the reader/pipeline is failing, not the model.

## Then: work order

1. `0a5.2` sleep-cycle thematic consolidation → `0a5.3` arcs → `0a5.4` dream pass (mandatory, window 02:00–08:00 operator-local)
2. `zn9.1` in-app Postgres backup + `zn9.2` companion file tree → `zn9.3` restore verification (then remove the interim timer)
3. `1xb.1` Discord DM egress (minimal change — adapter rebuild is coming) → `1xb.3` weighted thoughts → `1xb.2` outbox initiation
4. `75f.1` values feedback loop, `b5m.5` whispers (only after the shipped authorship guard semantics — self-attributed, never user-role)
5. `isi.1` MI contact flagging unblocks the fatigue chain (needed before Artemis returns)

## Standing constraints

- Self-modification stays human-in-the-loop, append/diff-only (incident history).
- Internal messages must never enter context as partner speech — guard is live (`session.authorship_guard.retagged` telemetry in Garden); new metacognitive systems must carry provenance.
- Affect-dial removal from `runtime.self` layer content is an **operator decision** (persisted persona presentation), not a code default.
- Do not re-bead the lost sprint-9 creative-tools plan (music/video gen, video understanding) — it returns with the repaired server.
