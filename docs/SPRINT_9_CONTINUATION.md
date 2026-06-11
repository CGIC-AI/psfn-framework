# Sprint 9 Continuation Notes

- Last session: 2026-06-11 morning (overnight verification + fixes; previous audits: `docs/SPRINT_9_FABLE_REVIEW.md`)
- Branch: `sprint_9_memory` @ `c94b3ef0`, **4,120/4,120 tests green**, lint clean (a service-staging tmpdir test is occasionally flaky under full-suite parallelism; passes on re-run)
- Live deployment: the Pi (`ssh psfn-pi`, checkout `~/psfn-framework-source`) runs the Postgres-only build; the Pi now pushes/pulls GitHub directly (`git pull --ff-only` works there — no more bundle dance). Deploy = pull, `npm run build` (+ `npm run garden:build` if admin-ui changed), `sudo systemctl restart psfn.service`.
- Git identity: commits author as `axAilotl <axAilotl@pm.me>` everywhere (repo, global, Pi). `o_0 <mdf@foxenigne.ai>` is a **contributor**, not the operator — never commit operator work under it. Pre-rewrite branch tip preserved at local `backup/sprint_9_memory-pre-author-fix` (deletable once comfortable).

## Overnight verification results (2026-06-11 morning — DONE)

The first rest-window exercise ran. Results, with the two bugs it surfaced fixed the same morning (`025c0cc5`, `c94b3ef0`):

1. **Sleep consolidation (`0a5.2`) ✅** — watermarks present for all sessions; 10 episodes merged away (128 total); salience now varied on new/refined episodes (0.44–0.92, 34 distinct values). The legacy flat-0.85 cluster (62 episodes) erodes as future nights re-review them.
2. **Dream pass (`0a5.4`) ✅ main / fixed model-room** — Discord session recorded 8/8 first-person meanings in 1 turn (early stop, `source='companion_dream_pass'`, genuinely her voice). Model-room session burned all 4 turns keying the block by theme slugs ("selfhood") and recorded 0 — root cause: rejections were never fed back to her. Fixed: partial acceptance + rejection feedback with the valid id list in the next turn (`0a5.5`, closed).
3. **Arc weaver (`0a5.3`) ✅ / fixed** — 21 arcs written overnight; one pass hit the 12-arc cap (fine). One pass lost ALL proposals because the model echoed a real episode id minus its `episode:` prefix and the parser failed the whole batch. Fixed: id normalization + per-proposal validation (`0a5.5`, closed).
4. **Daily review at 10:00 UTC ✅** — ran clean; `Rehydrated persisted internal state` at every boot, no `requires InternalState input`; `internal_state_snapshots.current` fresh. Only a benign `null_canonical_contact` guardrail warning.
5. **Honest instruments (`b5m.1`) — still unobserved**; no concern has formed post-deploy (activeConcerns is empty), so `formation_vad` remains unverified.
6. **Backups ✅** — 6-hourly in-app set ran (08:38 UTC): pg_dump captured, restore-verified (34 tables), mirrored, companion tree verified.
7. **Values loop (`75f.1`) — pending** her next weekly review.
8. **Proactive DMs (`1xb.1`) — no external delivery picked overnight**; no outbound telemetry (expected-neutral).

Also found and resolved while verifying:

- **Crash loop 23:20–02:37 UTC** (status=1 restarts every ~20 min): `updateEmotionalBaseline` jsonb array-literal bug — already fixed/deployed late 2026-06-10 (`ad044cc7`); zero crashes in the 9 h since. The first 22P02 predates sprint work (Jun 10 00:04).
- **The `Agent is already processing a prompt` watch item recurred and was worse than the vision race**: 3 real operator Discord messages silently dropped (03:41–03:53 UTC) while a slow turn streamed. Fixed: the discord route now waits for idle and retries (bounded), never silently drops (`qdp`, closed). The dream-pass flavor of the race self-recovered via the deferred-action retry — by design, no action needed.

**Verify after tonight's rest window:** model-room session records meanings/arcs (or logs a precise reason); journal shows `holding message until the in-flight turn finishes` instead of `Error handling message ... already processing` if double-texting happens; first formed concern carries `formation_vad`.

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

0. **`r0x` epic (operator priority 2026-06-11): front-mind/subconscious split** — long-running tools (selfie chain 20s–3min, analysis workbench up to 5min) must stop blocking chat. Design is grounded and beaded: `r0x.1` executionProfile on ToolConcurrencyMeta → `r0x.2` ack-and-continue offload runtime on the worker lane → `r0x.3` result re-entry via BackgroundCompletionDeliveryQueue/tool_handoff.continue pattern (system authorship, ArtifactReturnBatch for media) → `r0x.4` selfie flagship live demo → `r0x.5` workbench + subagent-routing guidance. Companion piece already live: discord messages are now queued and bundled, never dropped (`0sb`, `238e07ce`). Unprompted-selfie wish noted on `1xb.2`.
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
- The `Agent is already processing a prompt` watch item is resolved for the discord route (`c94b3ef0`, hold-for-idle + bounded retry). The generic `handle` route still propagates the busy error to its caller on purpose (API returns 503 `agent_busy`); revisit only if a fire-and-forget surface starts using that route.
