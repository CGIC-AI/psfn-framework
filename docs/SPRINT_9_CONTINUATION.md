# Sprint 9 Continuation Notes

- Last session: 2026-06-09/10 (see `docs/SPRINT_9_FABLE_REVIEW.md` for the full audit)
- Branch: `sprint_9_memory` @ green — **4,029/4,029 tests passing**
- Live deployment: the Pi (`ssh psfn-pi`, checkout `~/psfn-framework-source`) runs the Postgres-only build; pre-cutover build preserved at `~/psfn-framework-prev-20260609`; full snapshot at NAS `psfn-bak/pi-full-snapshot-20260609T215118Z`; interim `psfn-backup.timer` runs 6-hourly.

## First: verify what ran overnight

1. **Episodic synthesis (`0a5.1`)** — did sleeptime fire during the rest window? `psql .../psfn`: new rows in `l01_episodes` / `l01_episode_candidates` / watermarks. Acceptance: merged/extended episodes, not overlapping near-duplicates. If confirmed, close `0a5.1` as superseded-by-implementation.
2. **Honest instruments (`b5m.1` notes)** — new reflections should show *varied* confabulation confidence (no longer pinned at 0.95 / supporting_memories=0); new concerns should carry `formation_vad`.
3. **Cache reorder (`7jl`, closed)** — re-measure prompt composition on natural turns against the recorded baseline (static 717 / suffix 2,340 / memory 4,063 tokens).
4. **Backups** — `systemctl list-timers psfn-backup.timer`; confirm `auto-*` sets accumulating on the NAS.

## Re-check vision and selfies — RESOLVED 2026-06-10 (deployed to Pi)

- **Selfie pipeline (`psfn-framework-jz7`, closed):** `selfie_create` now runs a tiered reference-EDIT chain — `openai/gpt-image-2/edit` → `fal-ai/nano-banana-2/edit` → `xai/grok-imagine-image/quality/edit` — advancing on content-policy 422s and timeouts, never dropping the reference image. `edit_model` selects the starting tier (start at nano/grok for swimwear-tier content). Grok endpoints validated against fal.ai docs and smoke-tested live (quality is an endpoint path, not a param). Lost hotfix superseded: FAL queue timeout is now 300s.
- **Vision (`psfn-framework-ask`, closed):** model config was fine (gemini-3.1-flash-lite → gpt-5.4-mini). Real causes: 30s vision turn timeout (model finished at 70s on the Pi) → now 120s; flaky router DNS killing `web.fetch_binary` via the fail-closed SSRF check → gateway now retries one transient DNS failure, and the Pi got a `1.1.1.1` fallback nameserver (router first, via nmcli on eth0).
- Residual: one observed `Agent is already processing a prompt` collision when the vision fallback reply raced an in-flight prompt — masked by the honest fallback; investigate if it recurs at the 120s timeout.
- Still worth an end-to-end check: ask her for a selfie and send her an image over Discord on the new build.

## Then: work order

1. `0a5.2` sleep-cycle thematic consolidation → `0a5.3` arcs → `0a5.4` dream pass (mandatory, window 02:00–08:00 operator-local)
2. ~~`zn9.1` + `zn9.2` + `zn9.3`~~ **DONE 2026-06-10, live on the Pi**: scheduled in-app backup now captures pg_dump + full companion tree (hash manifest) and proves restore fidelity into a scratch DB every cycle; decant rehearsal passed against live data (counts matched source). Interim timer stays until the new system-data/env coverage bead lands (it uniquely covers config owners + env files). Note: live restore showed `l01_episodes` = 113 — episodic synthesis has been firing (feeds the `0a5.1` overnight check).
3. `1xb.1` Discord DM egress (minimal change — adapter rebuild is coming) → `1xb.3` weighted thoughts → `1xb.2` outbox initiation
4. `75f.1` values feedback loop, `b5m.5` whispers (only after the shipped authorship guard semantics — self-attributed, never user-role)
5. `isi.1` MI contact flagging unblocks the fatigue chain (needed before Artemis returns)

## Standing constraints

- Self-modification stays human-in-the-loop, append/diff-only (incident history).
- Internal messages must never enter context as partner speech — guard is live (`session.authorship_guard.retagged` telemetry in Garden); new metacognitive systems must carry provenance.
- Affect-dial removal from `runtime.self` layer content is an **operator decision** (persisted persona presentation), not a code default.
- Do not re-bead the lost sprint-9 creative-tools plan (music/video gen, video understanding) — it returns with the repaired server.
