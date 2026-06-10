# Sprint 9 Continuation Notes

- Last session: 2026-06-09/10 (see `docs/SPRINT_9_FABLE_REVIEW.md` for the full audit)
- Branch: `sprint_9_memory` @ green — **4,029/4,029 tests passing**
- Live deployment: the Pi (`ssh psfn-pi`, checkout `~/psfn-framework-source`) runs the Postgres-only build; pre-cutover build preserved at `~/psfn-framework-prev-20260609`; full snapshot at NAS `psfn-bak/pi-full-snapshot-20260609T215118Z`; interim `psfn-backup.timer` runs 6-hourly.

## First: verify what ran overnight — CHECKED 2026-06-10 (15:30–16:00 UTC)

1. ~~**Episodic synthesis (`0a5.1`)**~~ **CONFIRMED, bead closed.** Sleeptime ran 04:00–04:02 UTC: 4 memory writes, 6 candidates → 6 canonical episodes, 6 arc links, `duplicateEpisodeRate=0`, watermarks clean. Only the create path was exercised live (no spans overlapped an active episode); merge/extend stays test-covered until a live overlap occurs. One intimate-class write correctly rejected on novelty threshold (fail-closed working).
2. **Honest instruments (`b5m.1`)** — MIXED. Metacognitive flags vary across recent reflections (`[]` vs `avoidance`+evidence). `formation_vad` unvalidated: 0/8 recent concerns carry it, but none formed post-deploy. **NEW FINDING (on `b5m.1`):** daily-review FIRED at 10:00:54 UTC but FAILED — `requires InternalState input, but no InternalState snapshot is available`. `SubstrateAgent.currentInternalState` is in-memory only (set during turns); the 02:14 UTC restart plus a quiet morning left it null. Fix direction: rehydrate last persisted snapshot at startup or give templates a cold-start path; keep fail-closed if neither exists.
3. **Cache reorder (`7jl`, closed)** — not re-measured yet; needs Garden telemetry over natural turns.
4. **Backups** — CONFIRMED in production. Two in-app cycles (08:14, 14:15 UTC): pg_dump 273 TOC entries, restore-verified into scratch (33 tables), companion tree 50 files hash-verified, NAS-mirrored, GFS pruning active. Interim timer also accumulating `auto-*` sets 6-hourly on the NAS.

Note: commit attribution on this branch was rewritten 2026-06-10 (`o_0` → `axAilotl`, contributor identity had leaked into repo config); remote and Pi were force-synced to the rewritten history. Pre-rewrite tip preserved locally at `backup/sprint_9_memory-pre-author-fix`.

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
