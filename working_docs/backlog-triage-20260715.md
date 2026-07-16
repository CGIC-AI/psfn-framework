# Backlog Triage — 2026-07-15 full-tracker sweep

21 parallel Opus reconciliation agents over every active bead (330 open, 11 in_progress, 3 blocked-status, 21 deferred), per the orchestration-process reconciliation rules: full bead read, git/source verification, no batch-grep inference. Raw per-bead tables live in the session accumulator; this is the durable synthesis.

## Numbers

- **Closed this session: 30** (open 330 → 312, in_progress 11 → 3, closed 2440 → 2470).
  - Implementation wave: 2z12.10 (salience decay cadence, shipped on feat/fleet-efficiency).
  - Agent-verified shipped-on-main: vinz.20, vinz.26, vinz.27, b9kb, 2gxw, r037, pwzk, PSFN-z80i, b5m.2.
  - Operator gate-kill directive (pre-this-week live-validation/acceptance gates; live system running without noted issues): cquq, 27ut, kz0i, 9soj, vi2i, vinz.30, 7ang.5, efc2, tsyo, 0zd9.
  - Refuted/superseded/obsolete: ecr5, hgw3.9, 57m, r7tv, 032j, 814h, jmnr, 1z6.5.
- **Remaining in_progress (3, all verified genuinely active):** 2z12.4 (journal rotation, real work on origin/work/fleet-efficiency-journal-rotation, needs remediation + integration), 6kr8 (ops, blocked by 343f + hardware), upx0.21 (god-file split: heartbeat-template-runtime 1357 vs ~800 target; regrowth: substrate-agent.ts 1593, session/manager.ts 1492).

## Quick-win dispatch queue (verified open, bounded, Codex @ high)

Ranked; top of queue first. (~55 total catalogued in agent tables; this is the cream.)

| # | Bead | What | Why first |
|---|------|------|-----------|
| 1 | w8xs | Add `psfn_restore_verify` DB to postgres-init SQL | P1 — 6-hourly backups failing NOW; one line |
| 2 | b30 | Re-inject WORKSPACE_PATH in installed systemd unit | P1 — reinstall bricks startup (fail-closed hazard) |
| 3 | pdjd | Trust-aware retrieval access predicates | P1 memory-access bug, single file + tests |
| 4 | vj0w | Hydration failures currently fail-open (warn+proceed) | Live fail-open bug, startup wiring |
| 5 | w05a.10 | channelPrivacy/routingSource for terminal+api observer dispatch | P1, experiment window closes 07-20 |
| 6 | ybzz | routedContactId fallback in social-graph builders | Confirmed live bug, 2 sites + tests |
| 7 | w3rr | Journal/vault publish uses UTC day boundary | Confirmed bug, route through activeTimezone |
| 8 | f7pv | Channel-index equals-guard compares volatile fields (rewrites every append) | P1 perf, self-defeating guard |
| 9 | 189d | Remove concern-softening shim, gentle source prompts, cap reflections | P1 welfare/prompt quality |
| 10 | dtym | Dream pass: worker-lane routing + feed transcript spanRefs | Live behavior bug |
| 11 | tlnd | Mirror notes chrono interleave + channel-pair gate | Live behavior bug |
| 12 | svus | install-psfn-service.test.ts hangs (reproduced live) | Unblocks full-suite runs |
| 13 | ge7g | Helm missing NTFY_BASE_URL/NTFY_TOPIC (partial-fix trap) | notify tool dead in kube |
| 14 | h7g9.1 | Residual runtime smoke + telemetry evidence for shipped retry | Cheapest close-out |
| 15 | auiu | Port tooldefs-sidecar pattern to static prefix (base on origin/main!) | hgw3 tail, unblocks prompt-cache work |

Then: dcnu, i3yx (prompt diet pair), 2z12.11, em6z, la3m, yszc, upx0.14, upx0.15, upx0.16, upx0.18, 6vfh, cf5y, ol0b, zet.4, 2x37.8, 2x37.9, 75ci, p6cj, fgm4, z7qe.6, 4r0.12, upx0.13, w9hj.4, dn05, q19, 1knm, dvzq (coord mmo9.3), g59z, wq8o, vvf.4, 6ahp, 8wf5, c1dh, edtz, l3qv, v71n, v83d.6, v83d.3, adwu, m37y, dri6, jea9, n2z6, u7sv, e7s0, o968 (dedup w/ upx0.4), 36dm, dlbs, zfqg, 6i7c, 2lw8, ys51, j8gv, hr1q, engc, z5vd, 2oex, 6tpc, w05a.6 (doc), brev (doc), opl1.16 (doc), upx0.2 (git hygiene — note working_docs/ tracked and carries sensitive infra docs), c5wf (dep bumps), nudf, w05a.12, dnll.4 (land w/ b9kb-sibling nljc), u8iv (file has concurrent-session drift — coordinate), 7grh (waits kz0i's fix live), 7toj (gated 2x37.9), ay2o (needs self-containment ruling), qz9e (branch-scoped to feat/icp-autonomy), fkyu (private-cluster-host chart), t5z7.9, zl7f (needs SSH), vinz.24, vinz.32, v83d.4, b0yl.7 (decision deliverable).

## Operator decisions needed (blocking specific beads)

1. **upx0.1** — license pick (bead suggests Apache-2.0) before LICENSE lands.
2. **upx0.22** — doc-comment vs gate for the one ungated scheduled turn.
3. **vbow** — empty description; scope the Garden concerns page before dispatch.
4. **x0k2.\* (6 children)** — superseded by the introspection faculty on `feat/introspection-landmarks` (~5,500 lines, UNMERGED). Closing them leaves the branch merge tracker-invisible: an integration bead must exist first.
5. **Merge candidates:** 2nu6 ↔ liql (same template-artifact root cause); sj4i ↔ 2nu6 + lghd (same empty-reply cluster).
6. **98xm** — hollowed epic: reparent lone open child 98xm.5 (suggest under 7ym.8), then close the shell.
7. **awfr / lq1f / mpwv / fr03 / 2tlk / ael8 / gjhk** — operator-only or live-ops (flag flips, Discord portal intents, remote ref deletion, physical reboot, PVC surgery).

## Epic map (the big rocks, after the small stuff clears)

- **m14v** (P1) — memory decay/weight matrix, operator-approved design, zero code. Highest-value single bead; touches same files as shipped 2z12.10 anchor work — sequence deliberately.
- **lghd** (P1) — re-prompt loop → agent_busy outage; 5 dependents; merge-triage with sj4i/2nu6 first.
- **343f** (P1) — empty assistant message on live; signature still on main; blocks 6kr8.
- **opl1** (fleet SSO) — 16 children, completely unstarted; foundational chain opl1.1 → .2 → .3 → .5/.6 → .7 → rest.
- **b0yl** (tool-calling reliability) — b0yl.2 catalog decision gates .5/.6; b0yl.1 desc rewrite parallel.
- **mmo9** (perf waves) — mmo9.2 instrumentation unblocked now; gates waves 2-5.
- **2z12 remainder** — 2z12.4 integration (work exists), .11 (quick-win), .12 (bundled-tick redesign).
- **hgw3 tail** — auiu, jsi9, 9ree, hgw3.5 (Redis tail), then v83d Loom rework unblocks.
- **x5rt** (kube self-management) — x5rt.4 RBAC substrate gates .5/.6/.8; .7's gate script already live-proven, reframe bead.
- **dnll** (per-companion config) — dnll.1 mechanism, then .2/.3, decision bead .5.
- **zet** (settings migration) — .2/.3/.6/.7 + new zet.4 scan.

## DEFER

- **S10 lanes** — vinz (locations, vinz.29 needs operator latent-room decision), 7ang (PWA embodiment: 7ang.1 first buildable), w9hj (app: live deploy + 8ora channelType), s10mc (.2.1 tenancy boundary gates g44z cutover).
- **upx0 foundation** — 17 (shell broker), .21 (god-files + regrowth), .4 (97-file dedication sweep), .5 (history rewrite, blocked on .2).

## Notable finds (report-only)

- `bd list` silently truncates at 50 — filed nothing per protocol, but a robot-mode list that lies about totals deserves a fix bead.
- lk0a: identity-literal scan fails on main with 88 findings — real, untracked-by-CI debt; blocks hygiene gates (was blocking ecr5's acceptance).
- upx0.9's "dead code" premise is stale (research-library now imported by artifact-lifecycle) — re-scope before any delete.
- fvl9 blocked until fix/9n6g-authorship-integrity merges (its second corrective path lives only there); fpiu has the same active-lane caveat.
- nrcz's prior work is stranded on bead/heartbeat-rename while 79 files drift on main — revive soon or it rots.
- z7qe.1 (SQLite removal) is much larger than framed: 105 refs, 2 runtime deps still live.
- Deferred-lane audit suggests dlk/1s7 may be false-closed (D3/D4/D5 episodic durability spec'd but absent from migrations) — worth a compliance check.
- Local main checkout has diverged from origin/main (local-only kube commits; origin PR#42/#43 not pulled) — pull before basing anything on local main.
