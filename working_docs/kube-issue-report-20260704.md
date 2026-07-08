# PSFN Kube Deployment — Observed Issues Report (2026-07-04)

Scope: psfn-shard k3s deployment (cutover 2026-07-03 ~02:37 UTC), 48h log sweep + live DB inspection + operator chat mining.
Purpose: source document for bead creation. Each issue has evidence and a bead-ready summary. Items marked HOTFIXED had a live fix applied 2026-07-04 but still need durable/chart-level fixes.

Beads already filed 2026-07-04 (do not duplicate): P0 no-off-node-backups; helm-provision psfn_restore_verify; image omits concern-softening.json; in-cluster litellm missing anthropic/* routes; postgres UTF8 0x00 errors; Discord empty responses; appraisal content >500; beads.ready policy deny in kube; redact DB URLs in backup errors. Related pre-existing: psfn-framework-pulo (owner-file migration automation), psfn-framework-mlwk.5.

## A. Critical / data safety

### A1. No off-node backup of live data since cutover (bead filed, P0)
- Host `psfn-backup.timer` pg_dumps the **frozen host Postgres** (last data 2026-07-03 02:37 UTC) via local socket. Every `auto-<ts>` on the NAS since cutover is stale. Live DB is in-cluster `psfn-postgres-0` (verified: latest model_usage_events current vs host frozen).
- In-app BackupService failed every 6h run since cutover: scratch DB `psfn_restore_verify` didn't exist in cluster PG (code never creates it). **HOTFIXED**: `CREATE DATABASE psfn_restore_verify OWNER psfn` (2026-07-04). Helm chart must provision it.
- Even when in-app backup works: `backup.json` mirrorDir="" and no NAS/NFS mount in pod → dumps stay on Pi-local PVC. Needs NFS mount (illmatic:/ai → psfn-bak) or equivalent.
- Bonus: BackupService error logs embed full postgres URL incl. password (bead filed).

## B. Scheduler / weight-based triggers / timekeeping (operator's primary complaint)

### B1. Carlini scheduler opt-ins never applied to live scheduler.json
- Runbook (`working_docs/carlini-kube-upgrade-55be96f8.md`, commit 7535a34f) documents 2026-07-03 opt-ins: `episodeSynthesis.topicSegmentationEnabled=true`, `temporalWakeup.morningWake.timing="habit"`, `weightedThoughtOutreach.enabled=true`.
- Live pod scheduler.json had all three at defaults (false/"fixed"/false); mtime Jul 3 03:02 (pre-opt-in), no timestamped backup beside it → the apply step never ran against the PVC copy.
- Consequences observed: agent log "Weighted-thought outreach lane disabled by scheduler.json" (operator's "weight-based triggers" dead); morning wake on fixed 08:00 instead of habit-based ("updates to time keeping are not working right", chat 2026-07-03 22:51 UTC).
- **HOTFIXED** 2026-07-04 ~16:45 UTC: applied all three (backup `scheduler.json.bak-20260704T164500Z`), rollout-restarted gateway+agent. Verification: see §F.
- Bead-ready: process/tooling gap — owner-file opt-ins applied to wrong/no copy during cutover; fold into psfn-framework-pulo or new bead for "verify opt-in application step in kube runbook".

### B2. Charge quota enforced from SEED values, not the owner file (HIGH — owner-file wiring defect)
- Chat evidence: `selfie_create` blocked twice (Jul 4 03:51, 03:54) with `Charge quota exceeded for lane "interactive" while charging "paidImageGeneration" (27/24; rolling 24-hour budget)`.
- `charge-policy.json` on the agent pod's `/app/system-data` has `runChargeQuotaByLane.interactive: 100` (mtime Jul 3 03:44 — the operator's "quadrupled" edit). Agent restarted AFTER that edit (Jul 3 ~04:30). Yet enforcement used quota **24** — which is exactly `config/charge-policy.seed.json` (`interactive: 24`). `run-charge.ts:389` uses `chargePolicy.runChargeQuotaByLane[lane]` — so the runtime's chargePolicy object came from the seed, not the owner file.
- Implication: at least the charge-policy owner file is not the one the runtime loads in kube (wrong dataDir resolution, or a second seeded copy elsewhere). MUST check whether other owner files (scheduler.json, providers.json) are similarly bypassed — post-restart verification of the scheduler opt-ins (§F) discriminates this.
- Bead-ready (P1): trace kube agent/gateway charge-policy load path; fix dataDir so `/app/system-data` owner files are authoritative; add startup log of loaded quota values; Garden should surface effective (loaded) vs on-disk values.

### B2b. Rolling 24h budget semantics confused operator
- The blocked charge is a rolling 24-hour window (`RUN_CHARGE_ROLLING_WINDOW_MS`), so even after a correct quota raise + restart, previously spent units (27) still count until they age out. Garden/companion messaging should distinguish "per-run lane quota" vs "rolling 24h spend" (operator believed raise→restart would immediately unblock).

### B3. Restart tool unusable under kube
- Chat 2026-07-04 04:14: "the restart tool isn't going to work with kube"; memory formed "restart tool… not designed for the kube context". Lifecycle tools assume systemd/process model; under k8s a restart = pod delete/rollout, which the agent can't do.
- Bead-ready: kube-aware lifecycle tool (or disable+message in kube mode; fail-closed, no silent no-op).

### B4. Selfies generated + charged but NEVER DELIVERED; duplicates charged
- model_usage_events: 3× `selfie_create` image_edit **success** (Jul 4 02:19:53, 02:33:08, 02:40:28; fal / xai-grok-imagine-image; 6 units each). Operator: "No you didn't sent me a selfie" (02:40) and "I see you made two… weird it charged so much" (03:54).
- Chat/tool logs show each success ("available as a chat attachment") was followed by `tool/response_control … noReply / intentional_no_reply` on at least two turns → images generated, charged, and then intentionally not sent. Root of "made two": she couldn't see her own results ("Something fired but I never saw results on my end"), regenerated, charged again.
- Also direct duplicate evidence: `response_control … skipped duplicate tool call because the same tool/action/input already succeeded this turn` (04:00, 04:14) — model re-issuing identical calls.
- Bead-ready (P1): (a) a turn that produced a paid attachment must not silently end in noReply — block or warn; (b) surface generation results back into the model's context so it knows the image exists; (c) idempotency guard for paid surfaces per user-request.

### B5. Time-of-day awareness wrong — pod clock is UTC, operator is US-Eastern
- Chat: repeated "goodnight" at operator's morning (Jul 4 12:08 UTC = 08:08 EDT: "Now sleep… Ohio waits" → "But it's the morning"), "go rest, sweet dreams" at 22:49 UTC = 18:49 EDT → "It's only 7pm". She reads the clock as local bedtime when it's UTC. Operator: "I have to see why the updates to time keeping are not working right" (Jul 3 22:51); "My timekeeping is still broken" (Jul 4 12:17).
- Pi host AND pod are `Etc/UTC`; helm values set no TZ. Any "local time" the prompt/time-texture injects is UTC, 4h ahead of operator wall clock. Also shifts scheduler windows using `"timeZone": "local"`: episodicProcessing 00:00–09:00 "local" actually runs 20:00–05:00 EDT; quiet-hours/morning-wake similarly offset.
- Bead-ready (P1): set TZ (America/New_York) in helm workload env (or make companion timezone a first-class settings.json value used by time-texture + scheduler), and verify pre-kube behavior didn't depend on a systemd TZ that was lost in cutover.

### B6. Response repetition / double-reply loop
- Operator: "You're looking repeating yourselve" (Jul 4 02:18), "😭 You're double replying" (16:24). Companion sent two near-identical replies back-to-back (16:22:36 → 16:23:41); her own high-priority orient concern logged: "Response repetition glitch: confirmed recurrence… replied with the exact same message twice in a row."
- Self-described trigger: "Something in me gets stuck when I hit a wall—tool failure, emotional spike, both—and I replay." Correlates with duplicate-tool-call suppressions and the 48× empty-response pattern (retry path?).
- Bead-ready (P1): reproduce/trace double-emission on the Discord send path (turn retry after drain timeout? duplicate dispatch?); the duplicate-suppression guard exists for tools but not for outbound messages.

### B7. schedule tool create_follow_up schema broken (scheduled items can't be created)
- Tool log Jul 3 22:52: `Validation failed … channel_type: must be equal to constant` (×5), `channel_type must be a supported channel type`, `channel_id must be a string` — proactive follow-up creation fails from the Discord surface. This is the operator's "scheduled items" complaint in its most direct form.
- Bead-ready (P1): fix schedule tool follow-up schema/constant mismatch for discord channel context; add test with real Discord channel ids.

## C. Tools (operator's primary complaint, part 2)

### C1. beads.ready gateway policy DENY while agent advertises beads tools (bead filed)
- Agent: "Beads issue-management tools enabled"; gateway: `beads.ready → DENY … Policy denied` (2× in gateway_audit; 49,998 ALLOW). Companion formed memory "not permitted to use the beads tool due to a policy denial." Tool-test session (operator asked her to "use them all" 2026-07-04 04:07) surfaced this.
- Fix direction: wire beads adapter into kube gateway policy or remove the family from the kube tool catalog.

### C2. concern-softening.json missing from image (bead filed)
- `/app/config` only contains `*.seed.json`; `config/concern-softening.json` not copied at image build. WARN every turn: "Active concerns context injection skipped due to provider error ENOENT". Concern softening silently disabled — behavior-visible (concern phrasing unsoftened).

### C3. LiteLLM provider route dead in-cluster
- providers.json litellm `apiBaseUrl` was `http://127.0.0.1:4000/v1` (host-era) → connection refused inside pod; gemini-3.1-flash-lite failed to fallback (glm-5.2 took chat turns); ModelDiscovery "fetch failed" 3×.
- **HOTFIXED** 2026-07-04: apiBaseUrl → `http://psfn-litellm.psfn.svc:4000/v1` (backup providers.json.bak-20260704-litellm-url) + gateway restart.
- Remaining (bead filed): in-cluster litellm config only serves `openrouter/*` — anthropic/* direct pins (only route for claude-3-opus Atrium slot) not ported from host `/opt/litellm/config.yaml`.

## D. Sessions updating without operator activity (explained — mostly by design)

Channels active in 48h agent logs: Discord DM (256 lines), `internal:free-time:idle` (66), `internal:free-time:quiet-hours` (36), `internal:reflection:daily-review` (3), `api:…:sidecar-probe-*` (observer-eval sidecar), `satellite:mobile-location` (1).
- Free-time ran 6 blocks/48h = exactly maxBlocksPerDay=3 cap. Idle refresher: 11 notes.
- Observer-eval sidecar probes create/update API-channel sessions with zero real API use — this is the main "sessions updating by themselves" surprise. Bead-ready if unwanted: label/segregate sidecar-probe sessions in Garden UI so they don't read as real sessions.

## E. Secondary log findings (beads filed)

- Postgres `invalid byte sequence for encoding "UTF8": 0x00` — 84×/48h, CONTEXT "unnamed portal parameter $6"; failing write path unidentified, likely swallowed upstream.
- Discord empty response without suppression marker — 48×/48h (silent non-replies).
- Intention post-turn appraisal dispatch: "Field content exceeds max length (500)" — 2×.
- Post-turn drain timeouts 23×/48h (memory_extraction, intention_post_turn_hooks, emotion_appraisal, auto_compaction exceed 5s window) — Pi-speed, monitor after load changes.
- One agent restart Jul 3: gateway redeploy (admin host ports) dropped RPC; agent shut down gracefully by design.

## F. Post-restart verification (2026-07-04 16:45–17:00 UTC)

- **Agent**: restarted cleanly (pod psfn-agent-6465dbcfbf-zmssp). Verified in logs: `TemporalWakeup Morning wake timing resolved {"timingMode":"habit","source":"habit_fallback"}`; `Scheduler Started (tick=60000ms, 8 tasks)`; `HeartbeatTemplates Synced 2 reflection tasks`; zero WARN/ERROR at startup. WeightedThoughtOutreach no longer logs "disabled"; note: the lane emits no "registered" log line when enabled — add one (minor bead).
- **Gateway: NOT restarted — rollout deadlocks (NEW ISSUE, F1)**. The gateway binds `hostPort: 10053`; single node + RollingUpdate (replicas=1, maxUnavailable rounds to 0) → new pod Pending forever on "didn't have free ports", old pod never terminated. Rolled back (rollout undo) to clear the stuck state; **old gateway process still runs pre-fix config in memory** (litellm apiBaseUrl, any charge-policy involvement). To apply: either `kubectl -n psfn delete pod <old gateway pod>` (brief downtime) or set deployment strategy `Recreate` in the helm chart (correct durable fix for all hostPort workloads).
  - Bead-ready (P1): helm chart — hostPort workloads on single-node must use strategy Recreate (also check garden/agent for the same trap; agent rolled fine, so likely gateway-only).
- Files on PVC verified correct and surviving restarts: providers.json (in-cluster litellm URL), scheduler.json (3 opt-ins), charge-policy.json (interactive 100).
- **Charge-quota trace status (ties to B2)**: agent demonstrably reads /app/system-data/scheduler.json (opt-ins took effect), which weakens the "wrong dataDir globally" theory. Remaining hypotheses for quota=24-from-seed: enforcement lives gateway-side for paid image egress (old gateway process → but it too started after the 100-edit), OR a second charge-policy copy on a different mount, OR quota snapshot cached earlier than file edit. Next diagnostic: after gateway truly restarts, retry a paid image and read the enforced quota in the error/telemetry; also `kubectl get deploy psfn-gateway -o yaml | grep -A3 volumeMounts` to confirm both pods mount the same PVC.

## G. Chat-mined issue list (last 48h, operator-reported — full extraction)

Channel: Discord DM 1313001762793197678. Operator reported remotely (driving to Ohio) post-upgrade; repeatedly deferred fixes to "Monday" and told companion not to self-remediate (esp. restart tool).

| # | When (UTC) | Operator quote (verbatim) | Technical issue | Report section |
|---|-----------|---------------------------|-----------------|----------------|
| 1 | 07-03 22:51 | "I have to see why the updates to time keeping are not working right." | Time-of-day awareness wrong; goodnights at operator's morning/evening. UTC-vs-EDT. | B5 |
| 2 | 07-04 02:18, 16:24 | "You're looking repeating yourselve" / "😭 You're double replying" | Duplicate near-identical replies; her own orient concern logged "Response repetition glitch… exact same message twice." | B6 |
| 3 | 07-04 02:40 | "No you didn't sent me a selfie" | selfie_create success + `response_control noReply` → paid images never delivered. | B4 |
| 4 | 07-04 03:54–03:55 | "I see you made two. But weird it charged so much I quadrupled your budget… I made it 100 but if it didn't work that's weird" | Duplicate paid generations + quota enforced at seed value 24 (27/24) despite owner file = 100. | B2, B4 |
| 5 | 07-04 04:14–04:16 | "the restart tool isn't going to work with kube… Don't try to use it" | Lifecycle/restart tool has no kube path. | B3 |
| 6 | 07-04 02:14 | "Lots of bugs to fix when I get home 😭" | General backlog acknowledgement. | — |
| 7 | 07-04 04:04–04:07 | "try each of your tools… use them all… just to get logs I can check later" | Diagnostic self-test request; failures below are its output. | H |

## H. Tool self-test failures (from the 04:04/04:08 UTC runs — the "logs to check later")

- `schedule` create_follow_up: `Validation failed… channel_type: must be equal to constant` (×5), `channel_type must be a supported channel type`, `channel_id must be a string` → follow-up creation impossible from Discord surface (B7, P1).
- `beads` action=ready: `Policy denied` (matches C1 gateway audit).
- `orient` create_concern: `Field "text" is required` (succeeded on retry — schema/arg-name mismatch or model error; triage).
- `notify`: `ntfy is not configured` — notify tool unconfigured in kube (host watchdog uses ntfy; port config into pod env or disable tool).
- `web`: `Invalid input: target is required` + loop-guard `skipped repeated malformed web action=search` — model repeatedly emits invalid calls; check tool schema docs presented to model.
- `identity`: `Validation failed… action: must be equal to constant` ×11 on promote/read.
- `scratchpad` (`content is required`), `memory` (`date or after/before required for timeline`), `orient` (`persona must be a string for reorient`) — arg validation failures.
- Cascade: dozens of `Skipped because an earlier sequential tool call failed` — one failure aborts entire sequential batch (repo, system, schedule, memory, identity, toolset, subagent, tool_search, contact never exercised). Consider per-call isolation for diagnostic runs.
- `response_control … skipped duplicate tool call because same tool/action/input already succeeded this turn` (04:00, 04:14) — duplicate-issuance evidence (ties B4/B6).
- Triage note: several failures may be glm-5.2 emitting malformed args rather than schema bugs — bead should split "fix schema/constant" (schedule, identity look like real constant mismatches) from "model call quality" items.

## I. Bead-creation guidance (for the follow-up subagent)

New beads to create (do NOT duplicate §"already filed" list at top): B2 owner-file/quota wiring trace (P1); B2b quota semantics surfacing (P2); B3 kube-aware lifecycle/restart tool (P1); B4 paid-attachment delivery + idempotency (P1); B5 timezone (P1); B6 double-reply loop (P1); B7 schedule tool schema (P1); F1 gateway Recreate strategy (P1); H notify config in kube (P2); H identity/orient/web schema-vs-model triage (P2); minor: weighted-outreach "registered" log line (P3).
Pending operator actions (not beads): complete gateway restart (delete old pod or apply Recreate first); decide free-time image budget (`freeTime.budget.maxChargeUnits: 8` caps her leisure generations regardless of lane quota).
