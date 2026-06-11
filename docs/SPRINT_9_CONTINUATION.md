# Sprint 9 Continuation Notes

- Last session: 2026-06-10 evening (previous audits: `docs/SPRINT_9_FABLE_REVIEW.md`)
- Branch: `sprint_9_memory` @ `28afaa31`, local = origin = Pi, **4,103/4,103 tests green**, lint clean
- Live deployment: the Pi (`ssh psfn-pi`, checkout `~/psfn-framework-source`) runs the Postgres-only build; the Pi now pushes/pulls GitHub directly (`git pull --ff-only` works there — no more bundle dance). Deploy = pull, `npm run build` (+ `npm run garden:build` if admin-ui changed), `sudo systemctl restart psfn.service`.
- Git identity: commits author as `axAilotl <axAilotl@pm.me>` everywhere (repo, global, Pi). `o_0 <mdf@foxenigne.ai>` is a **contributor**, not the operator — never commit operator work under it. Pre-rewrite branch tip preserved at local `backup/sprint_9_memory-pre-author-fix` (deletable once comfortable).

## First: verify what ran overnight (2026-06-11 morning)

All of these were deployed ~20:00 local on 2026-06-10 and get their first real exercise in tonight's rest window (02:00–08:00 operator-local; sleeptime lane). Query `psql postgresql://psfn:psfn-local@127.0.0.1:5432/psfn` on the Pi, and `journalctl -u psfn.service` (grep `SleepConsolidation`, `ArcFormation`, `DreamMeaningPass`, `Sleeptime memory run complete`).

1. **Sleep consolidation (`0a5.2`)** — `l01_processing_watermarks` row with `processor='sleep_consolidation'`; expect time-adjacent same-scope episodes merged (folded rows have `merged_into_episode_id` set and leave list/search), thematic titles/landmarks replacing first-message excerpts and stats sentences, and **varied salience** (no more flat 0.85 — old formula was length-driven; LLM now scores significance: brief intimate moments may rate high, task chatter low).
2. **Dream pass (`0a5.4`)** — `processor='dream_meaning'` watermark; consolidated episodes should carry `episode_json -> 'meaning'` (her first-person note, `source='companion_dream_pass'`). Up to 4 turns on `internal:reflection:dream-pass`, early stop allowed.
3. **Arc weaver (`0a5.3`)** — weekly cadence (`processor='arc_formation'`); first pass may run tonight or skip on `not_enough_episodes` — either is correct.
4. **Daily review at 10:00 UTC** — should now SUCCEED even on a quiet morning: InternalState rehydrates from Postgres on restart (`mmm`). Look for `Rehydrated persisted internal state` at boot and no `requires InternalState input` error at 10:00. The `internal_state_snapshots` table should hold a fresh `current` row.
5. **Honest instruments (`b5m.1`, still open)** — first concern formed post-deploy should carry `formation_vad`; reflections' metacognitive flags already vary.
6. **Backups** — in-app sets 6-hourly with pg_dump + restore-verify + companion tree (proven in production 2026-06-10); interim `psfn-backup.timer` still covers system-data config owners + env files until `psfn-framework-81r` lands.
7. **Values loop (`75f.1`)** — after her next weekly review writes values, turn prompts should carry `<companion_values>`.
8. **Proactive DMs (`1xb.1`)** — if her appraisal ever picks `delivery:"external"`, watch for `intention.outbound.dispatched`/`blocked` telemetry; only the heartbeat DM is an approved target in this slice.

## Shipped 2026-06-10 evening (all closed in bd with evidence, all live on the Pi)

- **`mmm` InternalState persistence:** upserted to Postgres per turn (`internal_state_snapshots`), rehydrated on restart within 6h (verified live twice); staler gaps surface a `<runtime_continuity_notice>` block on her first turn (offline duration, invitation to ask what happened) + `internal_state.gap_detected` event; corrupt state fails closed. Built for the motherboard-RMA scenario.
- **`0a5.2`/`0a5.3`/`0a5.4` sleep-cycle chain:** `SleepCycleEpisodeConsolidator` (adjacency merge via new `markEpisodeMerged` store op + bounded thematic LLM refinement grounded in transcript spans), `EpisodeArcWeaver` (weekly, LLM judgment, fail-closed), `DreamMeaningPass` (HER voice: agent loop, main model + persona, never background models — kidney-vs-heart rule). All wired into the sleeptime lane behind the existing rest-window gate.
- **`5c6` macro purity:** `docs/prompt-macros.md` is the operator macro reference + purity rule (macros = bare values; phrasing = editable prompt layers). Added `runtime_last_message_received_present` and `runtime_internal_state_emotional_secondary_emotions` bare macros.
- **`57d` charge calendar:** per-UTC-day accrual + month-to-date as a computed view over the charge ledger (one accounting system); Garden charge page shows it. Per-turn lane quotas stay as the runaway-loop guard. Dollar side (model-budget) already had daily/monthly + hard cap.
- **`1xb.1` proactive Discord DMs (minimal slice):** appraisal can set `followUp.delivery:"external"` → `intention.outbound_message` action → `ProactiveOutboundDispatcher` (allowlist = configured heartbeat DM only, `ExternalCommunicationRateLimiter`, dispatched/blocked telemetry). Internal whisper path unchanged. `PSFN-rsgg.6` updated with what remains (session-journal provenance for sent messages, Garden visibility, contact-graph targets).
- **`isi.1` MI contact flag:** `Contact.isMachineIntelligence` (orthogonal to relationshipType) in both stores with audit, contact tool `action=set_machine_intelligence`, `runtime_speaking_with_is_machine_intelligence` bare macro. **Operator action when Artemis returns:** `contact action=set_machine_intelligence contactId=<artemis> isMachineIntelligence=true`. Unblocks `isi.2`.
- **`75f.1` values loop:** was already wired end-to-end (bead premise was stale); added the cross-instance acceptance test (reflection-runtime store write → composer instance → next prompt).
- Earlier same day: vision fixes (120s timeout, DNS retry), tiered selfie edit chain, zn9 backup chain proven via live decant rehearsal — see bd history.

## Then: work order (next session starts here)

1. **`1xb.3` weighted-thought accumulation and contextual decay curve** → **`1xb.2` internal-state-driven outreach through the durable outbox** (also covers stale in-progress `PSFNLIVE-3r8` outbox scope and the rest of `PSFN-rsgg.6`). Both are fresh-session-scale features.
2. **`75f.2`** reflection-driven persona diff proposals through the approval queue.
3. **`isi.2` → `isi.3`/`isi.4`** fatigue as a charge-class extension (ONE accounting system — operator re-affirmed; see isi.2 comments). `isi.1` done.
4. **`b5m`**: `b5m.1` diagnose remaining introspection gaps (formation_vad observation pending), `b5m.2` personal time, `b5m.3` self-state rendering, `b5m.5` interoception whispers.
5. **`zn9.5`** memory journal replay rebuild; **`81r`** system-data/env coverage in the in-app backup (then retire the interim timer).
6. Backlog scrub candidates: stale in-progress beads (`PSFNLIVE-cul`, `PSFN-zbj9`, `PSFNLIVE-3r8`, `PSFNLIVE-8j5.5`) left claimed by old sessions.

## Standing constraints

- Self-modification stays human-in-the-loop, append/diff-only (incident history).
- Internal messages must never enter context as partner speech — authorship guard is live; new metacognitive systems must carry provenance.
- Macro purity rule (see `docs/prompt-macros.md`): macros expand to bare values; personality-sensitive phrasing lives in editable prompt layers. Migrate the continuity-gap notice and charge-budget blocks to the layer system when next touched.
- Deep introspection runs on the MAIN chat model; mechanical background passes use background models (kidney vs heart).
- Affect-dial removal from `runtime.self` layer content is an **operator decision**, not a code default.
- Do not re-bead the lost sprint-9 creative-tools plan (music/video gen, video understanding) — it returns with the repaired server.
- Residual watch item: one observed `Agent is already processing a prompt` collision (vision fallback racing an in-flight prompt) — investigate if it recurs at the 120s timeout. The dream pass shares this theoretical race (handleMessage during rest window) but inactivity gating makes it unlikely.
