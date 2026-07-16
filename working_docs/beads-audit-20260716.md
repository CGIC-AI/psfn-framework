# Beads Audit — 2026-07-16 (two-pass, corrected)

**Audited against:** main, starting at `402b3ba53e`; HEAD moved to `de2ad7331b` mid-audit when PR #89 (opl1-dnll-completion) merged. Closes exported and pushed in `fb94882adc`.

**Method:** Pass 1 — 11 parallel agents over all 272 open/blocked beads, evidence-first grading, plus an adversarial verifier over every close claim. Pass 1's bias (demanding bead-tagged commits, never cross-referencing closed beads) was caught by the operator (l73i was long-fixed). Pass 2 — 11 agents re-checked all 258 survivors with the burden inverted (a bug bead stays open only if the defect is locatable at a current file:line; fixes hunted across the 1,034 beads closed since 07-01 and across subsystem rewrites), plus two deep-dive agents on the operator-flagged clusters (old Hermes/Codex backlog; helm/owner-migration/guidance). The 28 in-progress beads (opl1/dut9/9syj/0ggv lanes, remote agent syncing via issues.jsonl) were excluded throughout.

## Outcome

| | count |
|---|---|
| Audited (open + blocked) | 272 |
| **Closed, wave 1** (verified twice) | **15** |
| **Closed, wave 2** (inverse pass + deep dives) | **23** |
| **Deleted** (pre-standard 2-line junk epics: `vvf`, `i72`; substantive children kept) | **2** |
| Rescope candidates (half-done under other IDs) | ~19 |
| Genuinely still open | ~195 |
| Open count before → after | 271 → 233 |

Every close reason in bd carries its evidence (commit/file:line/superseding bead).

## 1. Closed — wave 1 (15)

y6q1 (memory maintenance review queue landed), lpro (K3s epic, stale BLOCKED), h5zn (backup credential redaction), ix5b (lint clean), vinz.4 (places→wiki publication), mmo9.7 (LLMWorkSpec epic 8/8), fgm4 (shared isRecord), engc (fixed under 2rno), qz9e (admin-ui check clean), 28pd (import cycle gone), ctm5/xo9m/6nje (P1 hygiene scanners all green at HEAD), l73i (operator-confirmed: pi-ai updated, tool system rewritten), 1z6.3 (operator: external shakedown repo dropped for internal docs).

## 2. Closed — wave 2 (23)

**Fixed/landed under other work:** svus (installer test passes post-PR #55), m82u (owner-file migration framework is real: 11-file `system-owner-fleet-migration*.ts`, Helm pre-upgrade hook, digest-approval CLI, crash-atomic recovery — pass 1's "one-off shims" verdict was wrong), 98r (ContactProfileArtifact/contact_profiles), PSFNLIVE-gkr (Garden telemetry = live event-bus inspector + file-log diagnostics), v71n (charge-budget page under 3e9g), 24o5 (hgw3 session-read coherence), w05a.12 (superseded by dnll.1 per-companion overlay), d5zx (all 6 named tests green), c5wf (npm audit cleared under ewnb), jea9 (revision label stamped + auto-verified in `kube-post-rollout-validation.ts`), lk0a (identity-literal debt cleared), em6z (SQLite reconcile source deleted; Postgres mergeContacts covers it), ipw1 (premise refuted by ybzz).

**Capability existed under different vocabulary (deep-dive finds):** 7ym.4 (subagent lifecycle + completion-handoff mailbox at `faculty.ts:747-811`), 7ym.6 (delegation limits/depth-cap/cancel enforced), 1z6.1 (all 6 security regression categories exist as scattered test files), 98xm.5 (unified `subagent` tool covers shard lifecycle; upx0.10 removed the separate surface deliberately), o9de (credential vault + OpenBao + file/fd delivery).

**Premise retired:** dvzq (adaptive next-wake killed the 60s-ceiling premise), 7ym.8.1/.2/.4 (shard goal-mode design retired per 7ym.8.3 precedent; budgets superseded by mmo9.7/lghd). Epic mmo9 (all children done).

**Left open on purpose:** 7ym.8 epic stays open holding `zkwr` — the live successor design (operator's 07-14 goal-document/threshold-compaction intent, "design before build"). w9hj epic stays open: the close guard caught 3 genuinely-open children (8ora P1, w9hj.3, w9hj.4) that pass 2 had over-credited.

## 3. Rescope instead of keep-as-written (~19, biggest slivers)

- **7ym.2/.3/.5, i72.3, s2p.5, c7d, 031.15** — half landed under the two-worker-family rewrite; remaining slivers: extensible hook seam, lifecycle audit, shard heartbeat, partner-push notification, memory-write governance, lineage/embodiment scoring. See `deep-hermes-codex` appendix for exact file:line of what exists.
- **i72.2** — skill create/update exists; only the security scanner remains.
- **pulo** — pre-scale migration job exists (`owner-migration-upgrade.yaml`); remaining: `backup.json` migration + model-cache readiness gate (go_emotions/MiniLM).
- **n2z6** — `extractedAt` plumbing exists in writer; import tool schema + backfill still missing.
- **dtym** — dream pass routes through agent loop now; "summary-of-a-summary" prompt diet still untouched.
- **hrlg** — delivery-checkpoint extraction exists; flagged functions still in `gateway-message-handlers.ts`.
- **dsd5** — **operator instruction: port `setup-local-artemis-shakedown.sh` to main** (currently only on `origin/ops/artemis-helm-shakedown`); rescope to the port + repair.
- **wq8o, vbow** — valid Garden features with empty descriptions; need description backfill, not deletion.

## 4. Lane-owned — not touched here (remote agent, syncs via issues.jsonl)

dut9 epic + dut9.2/.3, opl1.5.3.1 are **merged in main via PR #89** but left open for the lane owner to close in its own export. opl1.13/.14 likewise appear covered by opl1.17 (`944ff97c41`) — flag to the lane owner. The opl1.6.x fleet-SSO layer is confirmed unbuilt (next wave). New branch `work/opl1-dnll-opl1-5-3-2-contact-ledger` appeared during the audit — lane is actively moving.

## 5. Needs a human call

- **7ym.7 and 7ym.8.3 may be false-closed** (deep dive): no reviewer-role subagent exists; shards have no `consecutive_blocked_turns` detector. Worth a spot check the other direction.
- **g44z is not just deploy-blocked:** Helm `workloads.yaml` (166/355/495) mounts every companion's workspace at the same path with no per-companion subPath — a real code gap that deserves its own implementation bead.
- **b5m epic** — done except frozen child b5m.5; close-or-defer is an operator call.
- **8ora (P1)** — channel-privacy infra + `satellite_hub` channelType may partially satisfy it; needs a live sidecar-turn check.
- **2tlk** — remote-branch cleanup consistent with having been run, but end-state unverifiable after origin churn.

## 6. The real remaining backlog (confirmed at current file:line)

- **Bugs that survived every rewrite:** fpiu (reply overwritten by canned image correction, `turn-execution-runtime.ts:1487`), ervg (cross-channel CogSec leak, moved file, same line), sm9l (no tombstone gating), x6ig (ALS session-resolution design), mcf5/5fa3 (weak/non-atomic subject authorization), x5rt.11 (`fromHelmRevision` omitted), 7grh, 2tli, 36dm, ktvo, hcwu, g59z, 8l9c, dq9c, yszc, e7s0, 68ou, adwu, zfqg, 2x37.8/.9, o968 (real-name fixtures), 917v (orchestrator grew 718→1116 LOC).
- **Docs/ops:** brev (operations.md still calls host `psfn.service` authoritative), wckv, nrcz (heartbeat→reflection rename, 207+ files, branch never merged — operator re-confirmed intent).
- **Unbuilt epics:** v83d Loom rework (7 beads, all defects intact), 65rk shakedown harness, opl1.6.x fleet-SSO layer, 7ang PWA features, s10d1–6 deferred designs, vinz remainder (esp. vinz.29 Garden mapping + committed "latent space" literal).
- **Live-ops gates (not closable from code):** ael8 (Pi reboot), c1tv, awfr, 9hyv (soak/billing), fbfe, w05a.13, gjhk, 2a01/t2cg/dn05 (need live repro/baselines).
- **Hermes/Codex genuinely-absent slivers:** extensible hooks, clarify tool, Discord flood control, WorkspaceCheckpointPort, skills security scanner (now standalone after junk-epic deletion).

## 7. Process record

Pass 1 under-closed by design: it demanded bead-tagged commits and never consulted the closed-bead set, so work that landed under other IDs (engc→2rno pattern) or post-rewrite vocabulary (7ym.4 mailboxes) read as "still valid." The operator caught it via l73i. Pass 2 inverted the burden and cross-referenced 1,034 closed beads; the deep dives mapped current architecture before grading. Residual known bias: pass 2 could still under-close live-ops beads (unverifiable from the repo), and the audit straddled a mid-flight HEAD move (early batches graded `402b3ba53e`, late ones `de2ad7331b`).

Appendices with full per-bead tables follow: pass-2 recheck tables, deep-dive reports, pass-1 close verification.

## Appendix A — pass-2 recheck tables
# Second-pass (inverse) bead audit — batch 00

Mandate: try to prove each bead OVERTAKEN. Verified every claim against CURRENT main code (file:line) and the closed-bead digest. Result: this batch is mostly genuine open work — the mid-July subsystem rewrite (mmo9.7 typed workspec, lghd bounded parent-turn continuation, 98xm charge budgets, upx0.10 shard-control-plane removal) delivered *adjacent* capabilities, not the specific Hermes/Codex patterns these beads describe. Several beads are PARTIALLY overtaken (a half landed under other IDs) and are flagged for rescope.

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|---|---|---|---|
| psfn-framework-4r0 | P2 | STILL_OPEN | Epic; 18/19 children closed, sole open child 4r0.12 confirmed still-defective. Epic is a live container, not overtaken. |
| psfn-framework-i72 | P2 | STILL_OPEN | Epic; all 3 open children (i72.1 ABSENT, i72.2 scanner-half ABSENT, i72.3 ABSENT) confirmed genuinely absent in current code. |
| psfn-framework-i72.1 | P2 | STILL_OPEN | No WorkspaceCheckpointPort / shadow-git / GIT_DIR / fs action=rollback / workspaceCheckpointExcludes anywhere in src. 98xm "checkpoint" (subagents/types.ts:69 SubagentCheckpoint) is a result-content+budget snapshot, NOT filesystem snapshots — distinct feature. |
| psfn-framework-i72.2 | P2 | STILL_OPEN (partial-overtake) | Skill create/update NOW exists (faculties/skills/tools.ts:364, runtime.ts:165) — that half landed. But the bead's core ask (SkillsGuard security scanner for injection/exfil/destructive content + skill.suggestion event) is ABSENT: zero SkillsGuard/scanSkillContent matches; only scanSkillRoots (fs enumeration). Rescope to scanner-only. |
| psfn-framework-i72.3 | P2 | STILL_OPEN | No activity-heartbeat emitter. Shards have a watchdog only (manager.ts:1026 touchShardHeartbeat, 1035 refreshShardHealth evicts stale) — opposite direction; subagents have no heartbeat; no subagent.activity events; no active-subagent-aware gateway session timeout. |
| psfn-framework-vvf | P2 | STILL_OPEN | Epic; open children vvf.2/vvf.4/vvf.5 all confirmed ABSENT. |
| psfn-framework-vvf.2 | P2 | STILL_OPEN | No user-extensible hook registry: zero hookRegistry/HOOK.yaml/registerHook/WORKSPACE-hooks-loader in src. Only hardcoded EventBus listeners (e.g. discord/adapter.ts:1077). |
| psfn-framework-vvf.4 | P2 | STILL_OPEN (minor progress) | Typing failures now debug-logged (discord/adapter.ts:1045 logTypingFailure) instead of fully silent, but the specified flood-control (count N consecutive sendTyping failures → clearInterval → re-arm) is ABSENT: no strike/consecutive/floodControl counter (startTyping at 1028-1043). |
| psfn-framework-vvf.5 | P2 | STILL_OPEN | No structured clarify tool: NotifyAction = brief\|send\|approval_request only (core/tools/ntfy.ts:46), switch throws on others (:267). No {question,choices[]}, no Discord buttons / Telegram numbered lists. |
| psfn-framework-1z6.1 | P2 | STILL_OPEN (largely covered) | 4/6 areas now have regression tests: SSRF (boundary/gateway/url-policy.test.ts + DnsResolver rebinding), shell sandbox/PATH (boundary/sandbox/execution/shell-runner.test.ts symlink-swap :71), path traversal (shared/utils/contained-file.test.ts), sensitivity gating (system/trust/privacy-regression.test.ts, envelope-gating.test.ts). GAPS: per-lane gateway rate-limit regression (none found) and web-content-injection regression (none). No consolidated tests/security/ dir. Rescope to the 2 uncovered areas. |
| psfn-framework-1z6.3 | P2 | UNCERTAIN | Target is an EXTERNAL repo (/mnt/ai/PSFN-TEST/psfn-shakedown/artifacts/harness-assertions/) not mounted on this machine — cannot verify. Parent 7dvz closed 2026-07-15 but explicitly left 1z6.3 open. Resolve by inspecting the shakedown repo on the test host. |
| psfn-framework-031 | P2 | STILL_OPEN | Epic; 14/17 closed; open 031.11 (ABSENT) + 031.15 (deeper ask ABSENT) confirmed. |
| psfn-framework-4r0.12 | P2 | STILL_OPEN | `grep -rn "Model<any>" src/` = 19 occurrences (grew from the 2026-06-28 count of 18). The 3 cited fns still Model<any>: primitives/llm/models.ts:111 supportsOpenAIDeveloperRole, :138 resolveOpenAITransport, :145 resolveSystemRoleCapabilityMetadata. Also stream-adapter.ts (10), client.ts (3), vision-reviewer.ts (2), model-runtime.ts (1). z2uk.5/5q8e.4/b0yl did not touch them. |
| psfn-framework-s2p.5 | P2 | STILL_OPEN (partial-overtake) | Internal completion-handoff exists with privacy gating + partner-deferred wording + rate cap (core/agent/completion-handoff.ts:118-122 partnerNotification='policy_gated_companion_authored', completion-notices.ts:24 MAX_NOTICES_PER_CHANNEL=8). But bead's acceptance unmet: no partner-facing notify/gateway push on completion, and no Garden panel showing task lifecycle + notification sent/skipped/denied (grep of operator/garden empty). |
| psfn-framework-031.11 | P2 | STILL_OPEN | No emotional-discrepancy detection/surfacing: zero discrepancy/divergence/mixed-state/conflicting-emotion logic in core/self-model/state.ts, core/emotion/state.ts, scheduler heartbeat. Raw multi-signal snapshots exist (emotion/acac.ts, appraisal-state.ts) but nothing compares signals or renders mixed-state notes/reflection/journal. |
| psfn-framework-031.15 | P2 | STILL_OPEN (partial-overtake) | Persistent gallery (dep PSFN-eg2c) DONE and rich: favorite/tags/meaningfulMoment/companionNoteRefs (garden/services/images-service.ts:233,256,260,181; generated-media.ts:344). But deeper 031.15 ask ABSENT: no visual-autobiography records w/ emotional context+memory lineage, no reference lineage (reference-store.ts:27-63 has no promot*/derivedFrom/previousRef), no embodiment-consistency score (zero embodiment/sameMe/driftScore in primitives/images), no gallery→reference promotion w/ audit/rollback. Rescope to lineage+embodiment. |
| psfn-framework-7ym | P2 | STILL_OPEN | Epic; open children 7ym.2/.3/.4/.5/.6/.8 — most confirmed absent/partial below. (Closed siblings 7ym.1, 7ym.7 done/folded.) |
| psfn-framework-7ym.2 | P2 | STILL_OPEN | No role parameter on subagent tool (faculties/subagents/tools.ts:15-70 params have no role); no SubagentRole/roleProfile/researcher/reviewer configs; routing is free-form capability tokens (faculty.ts:220-233), not role profiles; no unknown-role fail-closed. |
| psfn-framework-7ym.3 | P2 | STILL_OPEN | Only allow/deny gating exists (substrate-agent/tool-runtime-facade.ts:1185-1187,1261-1263; system/capabilities/safeguards.ts:337-394). Zero preToolUse/beforeTool/toolInterceptor; nothing can MODIFY tool args or INJECT context (no non-test modified_input/additional_context). Blocked also by open dep vvf.2. |
| psfn-framework-7ym.4 | P2 | STILL_OPEN (partial-overtake) | Status-lifecycle + honest partial-outcome HALF landed under mmo9.7.7 (subagents/types.ts:6 SubagentTaskLifecycleState, :19 SubagentOutcome completed\|blocked\|cancelled\|budget_limited, :84 SubagentPartialResult). But parent MAILBOX / idle-drain / trigger_turn is ABSENT — terminal delivery is via CompletionNoticeBuffer rendered into next turn (completion-notices.ts, prompt-assembly.ts:571-580), not an enqueue+trigger_turn mailbox. Rescope to mailbox/trigger_turn. |
| psfn-framework-7ym.5 | P2 | STILL_OPEN | No subagent:start/subagent:stop hookable events; only one-way audit emission (faculty.ts:249 audit append, manager.ts:1159 installAuditHooks listens to agent.tool.start/end for heartbeat). Nothing can block-spawn/inject-context. Blocked also by open dep vvf.2. |
| psfn-framework-7ym.6 | P2 | STILL_OPEN (partial-overtake) | Max-concurrency ENFORCED (faculty.ts:205-215 default 8; manager.ts:468-480 default 5; owner-file subagentMaxConcurrent/shardMaxConcurrent) and interrupt/partial semantics PRESENT (faculty.ts:332 cancel, finalizeCancelled preserving partial). But max-DEPTH guard ABSENT (re-spawn blocked via BLOCKED_SUBAGENT_TOOL_NAMES faculty.ts:72-86, not a depth counter) and delegation usage-hint context block ABSENT. Rescope to depth+usage-hint. |
| psfn-framework-7ym.8 | P2 | STILL_OPEN (approach partly reframed) | Epic; sibling 7ym.8.3 CLOSED as "superseded by lghd... retired this speculative shard-only design," and upx0.10 removed the model-facing shard control plane, so the goal-mode framing shifted toward bounded parent-turn continuation (lghd). But ShardManager multi-turn loop still exists and children 7ym.8.1/.2/.4 + 98xm.5 (shard lifecycle tool) + zkwr remain open — not fully obsolete. Operator may want to retire on the 7ym.8.3 precedent. |
| psfn-framework-7ym.8.1 | P2 | STILL_OPEN (retire-candidate) | Shard auto-continuation loop is ABSENT: ShardManager.executeShard is a fixed `for(turn<maxTurns)` loop that breaks when maxTurns===1 (manager.ts:621-716); no maybeAutoContinueShard / post-turn continuation decision; comment at :713-715 is aspirational. Capability genuinely absent → open. BUT its same-epic sibling 7ym.8.3 was retired as superseded by lghd; the same shard-only-autonomy premise applies here — flag to operator for possible OBSOLETE closure alongside the epic. |

## Summary
This inverse pass did NOT confirm the "systematically fixed long ago" hypothesis for batch 00. The rewritten subsystems (subagents/shards/scheduler/background-work) delivered typed LLMWorkSpec, honest partial-result/budget_limited outcomes, charge-lane budgets, completion-handoff foldback, and bounded parent-turn continuation — but the *named Hermes/Codex features* in these beads (user hooks, pre-tool interception, clarify tool, flood control, skills security scanner, subagent role profiles, subagent lifecycle hooks, parent mailbox/trigger_turn, shard auto-continuation, fs WorkspaceCheckpointPort, delegation depth guard, activity heartbeat, emotional-discrepancy surfacing, visual-autobiography lineage, Model<any> cleanup) are still genuinely absent.

Partial-overtakes worth rescoping (half landed under other IDs): 7ym.4 (lifecycle/partial-results ← mmo9.7.7), 7ym.6 (concurrency/interrupt), i72.2 (skill creation), 031.15 (gallery ← eg2c), 1z6.1 (4/6 security areas), s2p.5 (internal handoff).
# Second-pass (inverse) bead audit — batch rb-01

Repo: /home/ada/psfn-framework (main @ 402b3ba53e, 2026-07-16). Goal: try to prove each bead OVERTAKEN/OBSOLETE.

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|---|---|---|---|
| psfn-framework-7ym.8.2 | P2 | OBSOLETE | Premise (parallel shard-only budget ledger) canonically rejected: 98xm.1 (WorkerBudgetGovernor) closed "no parallel governor ledger," superseded by mmo9.7 (charge/token admission) + lghd (bounded termination); sibling 7ym.8.3 retired as speculative. Budget lives as subagent `budget_limited` (src/faculties/subagents/faculty.ts:447-461); ShardConfig has only maxTurns; long-horizon goal-mode shards unbuilt (98xm.5 open, shards ephemeral). |
| psfn-framework-7ym.8.4 | P2 | OBSOLETE | Derives from working_docs/SHARD_AUTONOMY.md Pattern 4 — source doc deleted. Goal-mode long-horizon shards don't exist (98xm.5 open; ShardConfig maxTurns default 1). Shard-output governance instead delivered as fold-review/merge-review gate (src/faculties/shards/output-review.ts:151; upx0.7 closed 7/14), not the evidence-per-requirement audit turn. |
| PSFNLIVE-gkr | P2 | OVERTAKEN | Garden telemetry page is a live event-bus inspector with Live/Audit tabs + filtering (admin-ui/src/routes/telemetry/LazyPageContent.svelte:32-107) fed by live stream (src/operator/garden/server-telemetry-transport.ts:184) + correlation + GardenEventFilter; runtime log query delivered by x5rt.2 (closed 7/6) via /api/admin/diagnostics includeFileLogs (api-routes.ts:572, runtime-diagnostics.ts:91). |
| psfn-framework-b5m | P2 | OVERTAKEN | Epic children closed; both goals delivered — introspection-firing diagnosis b5m.1 (closed), personal/rest time b5m.2 (closed 7/15), plus b5m.3/16k/mmm/b5m.4 closed. Remains only for b5m.5 (real-time interoception) which is FROZEN/deferred, not active scope. |
| psfn-framework-c7d | P2 | STILL_OPEN | Defect survives faculty rewrite: live core memoryProvider injected into subagent loop (src/faculties/subagents/faculty.ts:398-399); `memory` write tool (registry.ts:279,286) NOT in BLOCKED_SUBAGENT_TOOL_NAMES (faculty.ts:71-86) → unreviewed subagent writes; no type-scoped/fold-review governance for subagents. Fold-review added for shards (upx0.7) but not subagents. |
| psfn-framework-9j6 | P2 | STILL_OPEN | eslint.config.js enables only @typescript-eslint/no-unused-vars + no-unnecessary-condition; no recommended-type-checked config, no no-floating-promises / no-misused-promises / require-await anywhere. |
| psfn-framework-q19 | P3 | STILL_OPEN | `'legacy'` mode literal unchanged: src/faculties/memory/extraction/types.ts:82 (`compositionalMode: 'legacy' \| 'chunk_compose'`), set at orchestrator.ts:382,429; no rename/gating commit; closed digest has zero compositional/chunk_compose hits. |
| psfn-framework-98r | P3 | OVERTAKEN | Centralized per-contact dossier exists: ContactProfileArtifact (memory-store-port.ts:31), `contact_profiles` table, refreshContactProfile (extraction/profile-synthesis.ts:73) synthesizes from attributed memories w/ provenance, surfaced at turn time (retrieval/turn-snapshot.ts:158) + access-gating; built under closed 4caj.10, qs83.45, qs83.28, 2k8j. |
| psfn-framework-6l1 | P3 | STILL_OPEN | Two of three halves overtaken (description clarity b0yl.1 PR#67; usage inventory b0yl.5) — bead's own 7/14 note concedes this — but residual unique scope absent: per-model tool-calling format survey, reframe-tools-as-skills, operator-participatory audit session. |
| psfn-framework-o9de | P3 | STILL_OPEN | No ESO: `grep ExternalSecret\|SecretStore\|ClusterSecretStore` empty; k8s/base/secrets.yaml still plain Opaque; vault resolves env (credential-presence.ts, bootstrap-input.ts:322). Closed aj6s/upx0.6/5s70/x5rt.10 hardened the seam but no ESO+backend; bead "awaits backend pick." |
| psfn-framework-f170 | P2 | STILL_OPEN | No settings-owned image defaults: grep imageDefaults/imageProvider/falCreateModel/selfieEditModel in config/settings/contracts = empty. Defaults still code-defined via IMAGE_MODEL_CATALOG (primitives/images/model-catalog.ts:76) + FAL_CREATE_MODELS/SELFIE_EDIT_MODEL_CHAIN (images/types.ts, tools.ts:46). Closed qs83.103/3v0 don't add owner-file defaults. |
| psfn-framework-isi.7 | P3 | STILL_OPEN | Human-attention-pressure boundary not built; shipped fatigue recentHumanParticipation/relationshipPressure runs opposite way (human presence sustains MI responses; human turns fatigue-free — fatigue/two-companion-loop.test.ts:220, policy.ts:52). Parent isi closed (dep met) but the extension itself unimplemented. |
| psfn-framework-917v | P2 | STILL_OPEN | runExtractionOrchestration still one monolith: src/faculties/memory/extraction/orchestrator.ts:320-1032 (~712-line fn; file 718→1116 LOC). Sibling stage files predate the bead; no closed bead split this fn — acceptance unmet. |
| psfn-framework-w9hj | P2 | OVERTAKEN | All 12 children CLOSED (1k5/ckm/o14/qa4/3eh/wjr/or2/6fv/vvz/8mu/w9hj.1/w9hj.2); companion-ui/ app exists and is deployed live (u24q closed 7/13 fixed its service-worker on deploy). Epic rollup complete. |
| psfn-framework-of5w | P2 | STILL_OPEN | Reverse import intact: admin-ui/src/lib/settings-garden-contract.ts:1 re-exports ../../../src/shared/contracts/...; backend still reaches into admin-ui (settings-contract-guard.test.ts:3 +3 files); verify:repository-hygiene has no admin-ui→src check. All acceptance criteria unmet. |
| psfn-framework-hrui | P2 | STILL_OPEN | Only CVE/advisory half shipped (htm9.17 → scripts/verify-supply-chain.ts, OSV.dev) which hrui explicitly excludes. No attack-pattern PR-diff scanner (.pth/base64/install-script); no .github/workflows at all, no Socket/Semgrep. Specific ask absent. |
| psfn-framework-98xm.5 | P2 | UNCERTAIN | Capability absent — no `shard` tool registered (registry.ts, composition grep empty). But upx0.10 (P1, CLOSED 7/14, commit b3946dbd) deleted the documented future shard surface this bead was framed to realize. Parent 7ym.8 still OPEN → needs operator call on whether tool is still wanted. |
| psfn-framework-l3qv | P3 | STILL_OPEN | admin-ui/src/routes/action-pipe/+page.svelte still single 466-LOC route (bead cited ~467); no extracted components in that dir; last commit 627386620d added outreach provenance, not a split. |
| psfn-framework-8wf5 | P2 | STILL_OPEN | `npx fallow --format json` still emits unresolved specifier ../../data/ops/continuity-watchdog-state.json for scripts/ops/continuity-watchdog-healthcheck.mjs:16; JSON still absent; no fixture/doc/.fallowrc exclusion added — acceptance unmet. |
| psfn-framework-m82u | P1 | OVERTAKEN | Owner-file migration framework built under yg2s + closed yooi/dut9.*/bxso/r11o/mkhl/7x37/kl7y.4: src/persistence/system-owner-fleet-migration*.ts (preflight, digests, fsync atomic, receipts, crash-recoverable rollback) + scheduler-owner-migration.ts migrateLegacySchedulerOwner wired at startup (commit 97fbe9b) + docs/specifications.md:29 Live Alpha Migration Boundary. |
| psfn-framework-jhqb | P1 | STILL_OPEN | src/core/agent/tool-surface/registry.ts:327 — `session` still exposes search/grep/start_focus/complete_focus; no chat_history/focus_work tool anywhere in src/. Split never done. |
| psfn-framework-em6z | P2 | OBSOLETE | reconcileSocialGraphConsistency, sqlite mergeSocialGraphForContacts, src/core/contacts/store/social-graph.ts all deleted in commit 7582ef46fe (z7qe.1.1, SQLite retired, Postgres-only) — function to "port" gone; Postgres mergeContacts (crud-operations.ts:539) rewrites both edge directions inline + dedups. Re-file fresh if a merge orphan is demonstrated. |
| psfn-framework-z5vd | P3 | STILL_OPEN | retrieveProactiveRecall declared src/core/agent/contracts.ts:169, impl src/faculties/memory/retrieval.ts:1634; only callers are retrieval.test.ts — no runtime/Garden/tool caller. Still dead wiring. |
| psfn-framework-6tpc | P3 | STILL_OPEN | src/channels/telegram/adapter.ts:722 still `if (message.from.is_bot) return;` dropping all bot authors; allowlist is allowedUsers gating only — no allowedBotUserIds nor observed-MI path for Telegram bots. |
# Second-pass bead audit — batch rb-02 (main @ 402b3ba53e, 2026-07-16)

Mandate: try to prove each bead OVERTAKEN. Verdicts below are evidence-cited against current main.

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|----|---|-------|-----------------------------------------------|
| psfn-framework-hcwu | P3 | STILL_OPEN | `src/app/agent/concern-route-wiring.ts:26-28` + handler map (38-41) — only `north_star` + `introspection` wired; `reminder`/`schedule`/`project` explicitly still have NO handler and fail closed. Exactly the bead's ask, not built. |
| psfn-framework-t2cg | P2 | UNCERTAIN | No code-owned fix commit; investigation deliverable (fallback-latency baseline) never produced (bead comment 07-12). Provider config has since changed (c1tv 07-15: ChatGPTN + z-ai/glm local added), but no baseline captured. Needs live traffic measurement. |
| psfn-framework-pulo | P1 | STILL_OPEN | Depends on `psfn-framework-m82u` (owner-file migration framework) which is still OPEN. Partial only: `src/system/config/scheduler-owner-migration.ts` + yg2s Helm startup migrations exist, but the unified pre-scale command and model-cache seeding (go_emotions/MiniLM) are not delivered. |
| psfn-framework-ael8 | P2 | STILL_OPEN | Bead comment 07-15 live check: psfn-shard uptime 12d continuous, host booted ~1h BEFORE bead was filed; approved-maintenance reboot never occurred. Validation is inherently pending a reboot. |
| psfn-framework-c1tv | P1 | STILL_OPEN | Bead comment 07-15 read-only live check: `psfn-litellm-config` configmap has no `anthropic/*` route; deployment env has no `ANTHROPIC_API_KEY`. Both still missing. |
| psfn-framework-dn05 | P2 | UNCERTAIN | No app-side NUL/0x00 sanitization added on write paths (only `UNSAFE_TEXT` reject regex on Garden read-query routes: `charge-cost-query.ts:24`, `model-usage-query.ts:86`). No commit references the fix. Exact `$6` statement not locatable without live `log_statement`. |
| psfn-framework-e7s0 | P2 | STILL_OPEN | Agent unconditionally registers beads tools and logs "enabled" at `src/app/agent/main.ts:783-785`, independent of gateway policy which conditionally denies at `src/boundary/gateway/policy.ts:336` (`if (!beadsPolicy?.enabled) deny`). The advertise-vs-deny mismatch is structurally intact. |
| psfn-framework-ktvo | P2 | STILL_OPEN | Producer `src/core/intention/appraisal/action-translation.ts:149` sets `content = followUp.content.trim()` with NO 500-char truncation; consumer still throws at pending-follow-up create (`postgres-adapters/appraisal-trace-adapter.ts:155` / `shared.ts:143`, MAX 500). Warn handler still live at `heartbeat-post-turn-runtime.ts:683`. |
| psfn-framework-v71n | P2 | OVERTAKEN | admin-ui charge-budget page built (commit `be2d151b88`, bead `psfn-framework-3e9g`): `admin-ui/src/routes/charge-budget/LazyPageContent.svelte:214,492,705-706` surfaces per-lane rolling-24h spend and explicitly distinguishes per-run vs rolling window ("each run also uses the same quota as a runaway guard"). Residual: companion-facing block wording. |
| psfn-framework-ge7g | P2 | STILL_OPEN | Only Garden health reporting added (`src/operator/garden/tool-health-provider.ts:113-130`, `runtime-health.ts:130-153` report "ntfy not configured"). The bead's ask — gate the notify TOOL in kube so it doesn't surface "ntfy is not configured" at call time — is not evidenced in tool registration. |
| psfn-framework-c1dh | P2 | STILL_OPEN | Triage classification deliverable never produced (bead note 07-12; only incidental nrin closed). Underlying tool-schema failures partly addressed by b0yl / nrin waves, but the per-failure classification + per-call-isolation recommendation was not done. |
| psfn-framework-yszc | P3 | STILL_OPEN | `src/core/scheduler/weighted-thought-outreach-lane.ts` logs only when DISABLED (line 53); the enabled-path registration (line 62) emits no "registered"/started log. Exact defect intact. |
| psfn-framework-8l9c | P2 | STILL_OPEN | Follow-up drain still at end-of-run continuation: `src/core/agent/scheduled-agent-loop.ts:198-214` drains queued follow-ups after the do-while loop and `continue`s as continuation steps. No run-START drain / pre-reply whisper injection. (ay73 boundary present, but 8l9c's architectural move was not done.) |
| psfn-framework-7jap | P3 | UNCERTAIN | `docs/architecture-diagram.mmd` updated 2026-07-08 (past the bead's 06-29 baseline), but the full sweep across specifications.md/operations.md/tool-surface.md/context-envelope.md/attribution.md + new mermaid diagrams is not confirmed complete. Subjective doc-drift task. |
| psfn-framework-awfr | P2 | STILL_OPEN | Bead comment 07-15 live check: `wikiRetrievalEnabled=false`, `adaptiveContextBudgetsEnabled=false`, `compositionalPolicy.enabled=false` all still disabled; decide+flip+smoke not performed. |
| psfn-framework-x5rt | P1 | STILL_OPEN | Epic 12/14 complete; children `awfr` and `x5rt.11` (manual-rollback ledger gap) still open. |
| psfn-framework-w05a | P1 | STILL_OPEN | Live experiment epic, 5/13 complete; validation children (.7/.8/.9) unlock 2026-07-20; window still open per 07-11 midpoint checkup. |
| psfn-framework-w05a.5 | P2 | STILL_OPEN | Operator 07-11 note: retention on new rows applied (~90d), but "archival (w05a.5) still open" — scheduled JSONL export to NFS backup target not landed. |
| psfn-framework-w05a.6 | P2 | STILL_OPEN | `docs/observer-eval-sidecar.md` does not exist; no sidecar doc page found. Deliverable absent. |
| psfn-framework-dq9c | P2 | STILL_OPEN | `src/system/lifecycle/notifications.ts:344` `notifyReady()` sends "I'm back~" with no image-tag dedupe marker / suppression window. No dedupe logic exists. |
| psfn-framework-nrcz | P3 | STILL_OPEN | Rename not done: 218 src files still reference "heartbeat"; `heartbeat-runtime.ts`, `heartbeat-post-turn-runtime.ts` etc. still present. Recent closed beads bbzq/b9kb (07-16/07-15) still use the name. Rename branch never merged. |
| psfn-framework-80rx | P2 | STILL_OPEN | No Carlini/miniforum01 off-node backup script exists (only `scripts/public-sanitize-check.mjs` matches). SSH-dependent operational task not built. |
| psfn-framework-68ou | P2 | STILL_OPEN | `session-integrity-repair.ts` not in `tsup.config.ts` entry (only 4 other maintenance CLIs are); `package.json:42` still `tsx src/app/maintenance/session-integrity-repair.ts` — unreachable in prod image (no tsx). Re-signing capability now exists (`src/persistence/repair/integrity-repair.ts` imports signJournalEntry) but in-pod command remains broken. |
| psfn-framework-g59z | P2 | STILL_OPEN | `src/persistence/sessions/store/journal-runtime.ts:184,196` still applies `wrapUnverifiedHistory()` per entry; no contiguous-run collapse logic anywhere. Test `store-bounded-reads.test.ts:188` still asserts every entry wrapped. |
# Batch rb-03 — second-pass (prove-overtaken) recheck

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|----|---|-------|-----------------------------------------------|
| psfn-framework-dri6 | P2 | STILL_OPEN | No `--build-remote` mode exists in scripts/ops/ship-kube-update.sh (grep finds none); script still local-build + scp. Feature absent. |
| psfn-framework-m37y | P3 | STILL_OPEN | No reaper for `kube-rollout-validation-*` channels; validate-kube-rollout.sh:883 only creates runIds, src/app/maintenance/ has no channel-reaper command. Confirmed absent. |
| psfn-framework-adwu | P2 | STILL_OPEN | Defect intact: scripts/ops/ship-kube-update.sh:187-189 still `LIVE_HASH=$(rkubectl exec ... 2>/dev/null ... \|\| true)` then `[[ -z "$LIVE_HASH" ]]` -> "pre-hash image". No retry/backoff, exec-failure still conflated with file-absent. |
| psfn-framework-2nu6 | P2 | STILL_OPEN | Serving-stack (vLLM chat-template on Carlini 192.168.1.43:8000) config bug, not PSFN code. Operator live-checked 2026-07-15: template artifact still firing, litellm route unchanged. |
| psfn-framework-2oex | P2 | STILL_OPEN | Journal->core done (commit 7fc6d1b4), but vault tool still unwired: createVaultTool/wireVaultRuntime (src/boundary/integrations/vault/runtime-wiring.ts) have zero src/app callers (only tests + canonical-tool-catalog.test-support.ts). Acceptance "no implemented-but-unwired note tools remain" unmet. |
| psfn-framework-lq1f | P3 | STILL_OPEN | Operator-gated config flip; live-checked 2026-07-15: no wikiRetrieval* key in fleet settings.json, resolves default false (src/shared/context-budget.ts:88). Not enabled anywhere. |
| psfn-framework-d5zx | P2 | OVERTAKEN | All 6 named failing tests now PASS (turn-execution-runtime.test.ts moved to substrate-agent/, session/manager.test.ts, extraction.test.ts, shards/manager.test.ts, prompts-service.test.ts x2 — verified green). `npm run lint` exit=0, 0 errors. no-reply-tool.ts:95 rewritten around bead gu8m (old always-false comparison gone). |
| psfn-framework-vinz | P1 | STILL_OPEN | Epic, 22/33 children complete; open children (vinz.3/.19/.21/.22/.23/.24/.28/.29/.32) remain. Parent stays open. |
| psfn-framework-vinz.3 | P2 | UNCERTAIN | Model + tooling shipped via closed siblings: PlaceKind 'virtual' + virtual_object/backend 'vr' (src/shared/contracts/places-registry.ts:27,66), world tool list/perceive/control/move (src/boundary/integrations/world/tools.ts), situated block, virtual-room-follow.ts. Unclear whether control routes to 'vr' backend (tools.ts:30 documents control as HA-service) or a discrete MUD-over-Discord testbed was stood up. Resolve: confirm world control accepts virtual_object affordances end-to-end over Discord. |
| psfn-framework-vinz.19 | P1 | STILL_OPEN | docs/world.md and docs/locations.md absent; e2e-test.ts does not drive satellite->situated->world perceive/control (only shared-world schema provisioning + embeddings). Matches 2026-07-13 audit, code unchanged. |
| psfn-framework-vinz.21 | P2 | STILL_OPEN | Grep for placeId-keyed concern/reminder model returns empty; no deterministic eligible/unfired/recently-fired presence gate, no owner-only Garden editor. Confirmed absent. |
| psfn-framework-vinz.22 | P3 | STILL_OPEN | Stretch drag-drop world-mapping editor not built; admin-ui/src/routes/places/+page.svelte is a read/derive view (twinKey naming derivation), no visual arrange/persist-to-places.json. |
| psfn-framework-vinz.23 | P3 | STILL_OPEN | No inbound HA state stream: getStates is on-demand only (world tool perceive, vinz.8/.9). Grep of src/core/scheduler + src/app/agent finds no HA state poll/websocket subscriber injecting perception. |
| psfn-framework-vinz.24 | P3 | STILL_OPEN | physicalLastSeen/presentInPlace absent from src/core/contacts/types.ts and repo-wide (grep empty). Confirmed absent. |
| psfn-framework-s10d1 | P3 | STILL_OPEN | Deferred future-idea cross-cluster trust design; operator updated 2026-07-15 to own remaining transport/identity/revocation/consent design (8pyl closed only the side-channel chat protocol). Not built. |
| psfn-framework-s10d3 | P3 | STILL_OPEN | Consciously-cut future feature (cross-cluster world sync); revisit after s10mc.5. Not built. |
| psfn-framework-s10d4 | P3 | STILL_OPEN | Deferred management-capability tier above autonomy; depends on s10mc.3. Not built. |
| psfn-framework-s10d5 | P3 | STILL_OPEN | Detailed caretaker-system design deliverable; minimal caretaker shipped piecemeal (s10mc.5; closed 6b07 wired a bounded cleanup runner 2026-07-16) but the full design (dedup/rebalance/cadence/deterministic-vs-LLM/placement) not produced. |
| psfn-framework-s10d6 | P3 | STILL_OPEN | Deferred voice subsystem rewrite; current Wyoming approach still in place. Not built. |
| psfn-framework-vinz.28 | P2 | STILL_OPEN | Wiki UI added a "Personal projects" tag-filtered section (admin-ui/src/routes/wiki/+page.svelte:40,185) but NOT the personal-vs-world scope grouping/filter/nav-split. Related v26r ("Garden UI has no Personal/World tabs") still OPEN. |
| psfn-framework-vinz.29 | P1 | STILL_OPEN | Core classification shipped, but Garden acceptance unmet (unchanged since 2026-07-14 recon): places-service.ts does not expose mirrorsPlaceId; admin-ui/src/routes/places/+page.svelte:30-33 still derives twins from latent_/virtual_ naming; committed literal "virtual places live in the latent space" at +page.svelte:148 violates the display-name-in-companion-data-only rule. |
| psfn-framework-vinz.32 | P2 | STILL_OPEN | /rooms and /satellites pages exist but contain no places/virtual-spaces cross-links (grep for places/`/places` empty on both +page.svelte). Confirmed absent. |
| psfn-framework-zfqg | P2 | STILL_OPEN | Direct model-room empty still terminal: src/channels/api/agent-backend.ts:606-607 `if (!response.content ...) return this.fail(502,'model_error','...returned empty content')`. No retry-once, no transient classification, no tests for transient-then-success. (Marginal: message is now specific, but retry/transient-tests absent.) |
| psfn-framework-c5wf | P2 | OVERTAKEN | Closed bead psfn-framework-ewnb (2026-07-16, commits d10fd431/a33f887c, merged 151bac15) pinned the same dev-dep graph (vitest/vite/flatted/picomatch/postcss/esbuild). Live `npm audit --omit=dev` = 0; full audit = 1 low only (no critical/high/moderate). c5wf acceptance met. |
# Batch rb-04 re-check (inverse audit: try to prove OVERTAKEN) — main @ de2ad7331b

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|----|---|-------|------------------------------------------------|
| psfn-framework-fief | P1 | STILL_OPEN | deploy/helm/psfn/templates/workloads.yaml:205 renders a single `-agent` Deployment (replicas:1, Recreate), NO per-companion `range`; PSFN_MULTI_COMPANION appears only in the owner-migration Job, not the agent workload. gr0g close reason (2026-07-14) explicitly names "psfn-framework-fief for first-class fleet chart ownership" as the remaining follow-up. Fleet auth/owner-migration work (2k3f, pi7f, s10mc.4, yg2s) landed but chart still does not render the follower-agent topology. |
| psfn-framework-jea9 | P2 | OVERTAKEN | scripts/ops/ship-kube-update.sh:144 stamps `--label org.opencontainers.image.revision=${FULL_SHA}`; src/system/lifecycle/kube-post-rollout-validation.ts:210-212 validates `imageRevisionLabel` as an exact 40-char git revision; test at src/system/lifecycle/kube-post-rollout-validation-store.test.ts:22. All three acceptance criteria met. |
| psfn-framework-zl7f | P2 | STILL_OPEN | Live-server-state + docs bead. Operator's own 2026-07-15 comment on the bead: package-lock.json drift is resolved and tree clean, BUT checkout still on sprint_9_memory (57 behind main) and the acceptance-criteria documentation/contract reconciliation (role of /home/psfn/psfn-framework-source in kube deploys) "is not verifiably done." Left OPEN by operator. |
| psfn-framework-lk0a | P2 | OVERTAKEN | `npm run verify:identity-literals` now PASSES on main (exit 0: "Identity-literal scan passed. Scanned 1724 files, 602 allowlisted hits"). Debt cleared by closed beads da39, aaty, 4tt0 (all 2026-07-16). |
| psfn-framework-fptm | P3 | STILL_OPEN | src/boundary/gateway/server.ts:1491 `enforceCompanionFrameIdentity` and :2275 `identifyConnection` are still inline GatewayServer private methods (called at :1372 and :582). Bead asks GatewayServer to delegate identify/frame authorization to focused modules; it does not. (Some auth logic moved into fleet-authorization-context.ts/companion-auth.ts, but the two flagged functions were not extracted; file grew to 2725 lines.) |
| psfn-framework-hrlg | P3 | UNCERTAIN | The delivery-checkpoint/outcome extraction the bead requested DOES now exist: src/app/agent/discord-reply-delivery.ts (`DiscordDeliveryCheckpoint`, checkpoint registry) and companion-reply-delivery-recovery.ts. But processMessage (gateway-message-handlers.ts:542) and pumpDiscordQueue (:381) remain inline (file 1167 lines). Whether the flagged functions dropped below Fallow critical thresholds needs a Fallow complexity run on current main to resolve. |
| psfn-framework-w9hj.3 | P3 | STILL_OPEN | companion-ui/src/lib/stream/hub-stream.ts:575 `classifyPreviewError(message: string)` still regex-matches error wording (`/(denied|deny|forbidden|not authorized|unauthorized|access)/`, :577-581), called at :528. `artifact.preview.error` still carries only `message`, no structured `code` field (framing.ts:57, no code enum). Exact fragile coupling the bead targets is present. |
| psfn-framework-zlon | P1 | STILL_OPEN | deploy/helm/psfn/templates/certificates.yaml:22-23 CA Certificate uses the SAME `.Values.certificates.duration`/`.renewBefore` as every leaf (:51-52, :74-75, :92-93, :115-116, :142-143) — no independent CA lifetime/overlap. No TLS reload/watch in src/boundary/gateway/transport.ts or src/operator/garden/transport-server.ts (grep for watch/reload/SIGHUP empty). Core defect intact. |
| psfn-framework-edtz | P2 | STILL_OPEN | scripts/ops/ship-kube-update.sh:283 still `sudo git -C ... reset --hard FETCH_HEAD`, no inline `-c safe.directory` override, no `merge --ff-only`, and bundle `rm -f` runs only in the success chain (not on failure). Every defect the bead names is present. |
| psfn-framework-e43c | P3 | STILL_OPEN | docker/Dockerfile.gateway still exists and copies no `config/intake-l1-rules.json` (only package/dist/node_modules COPYs at :14-40); still referenced by k8s/README.md:52. Neither retired nor brought to parity. |
| psfn-framework-vbow | P3 | STILL_OPEN | admin-ui/src/lib/components/garden/ActiveConcernsCard.svelte:58 still links to `/cognitive-security/drift` ("Open Drift Review"); no dedicated concerns route exists under admin-ui/src/routes/ (concerns only appear as a reflection-journal tab in values/+page.svelte). Exact "card links to cogsec drift" complaint holds. |
| psfn-framework-wq8o | P3 | STILL_OPEN | No dedicated Analysis Workbench traces route in admin-ui/src/routes/. Traces now render as an inline dashboard table (routes/+page.svelte:387-403) with no drill-down link/home page. The requested Garden home page for traces does not exist. |
| psfn-framework-2tlk | P2 | UNCERTAIN | Operator-run remote-branch deletion. `git ls-remote --heads origin` = 78 heads, all new-work branches; NONE of the bead's delete-set (or even most keep-set) archived branches remain, which is consistent with the cleanup having run — but I cannot verify the exact operator-run command executed nor that the acceptance state ("exactly eight keep refs") was ever reached, since the remote has since churned with new work. Live-ops action outside repo evidence. |
| psfn-framework-w9hj.4 | P3 | STILL_OPEN | companion-ui/src/lib/api/client.ts:1 and companion-ui/src/lib/protocol/framing.ts:1 both still `import { isObjectRecord } from '../../../../src/shared/utils/types.js'`. The standalone-boundary violation is verbatim present. |
| psfn-framework-mmo9 | P1 | OVERTAKEN | All 8 wave children now closed — the last open child, mmo9.7 (Typed LLM admission/welfare economy), is CLOSED as of 2026-07-16 (memory: PR #84). Epic acceptance "all wave children closed with evidence" satisfied; remaining is epic closure, not open work. |
| psfn-framework-0ggv | P1 | STILL_OPEN | Only 1/5 children closed (0ggv.2). 0ggv.1/.3/.4/.5 are IN_PROGRESS, not closed. Epic acceptance requires all children closed WITH live psfn-shard validation of experiential self-memory across days — not achieved. |
| psfn-framework-7ang | P2 | STILL_OPEN | 2/9 children closed (touch: 7ang.4, 7ang.5). The emotion/sprite/avatar/voice/GPS features (7ang.1,.2,.3,.6,.7,.8,.9) are all absent (see rows below). Active multi-repo feature epic. |
| psfn-framework-7ang.1 | P2 | STILL_OPEN | src/shared/contracts/companion-relay.ts:23-28 COMPANION_EVENT_KINDS is still exactly ['approval.requested','approval.resolved','artifact.created','tool.activity'] — no 'emotion.snapshot'; no CompanionEmotionSnapshot / companion.emotion topic anywhere in src/shared or backplane/companion-relay. |
| psfn-framework-7ang.2 | P2 | STILL_OPEN | Hub-repo bead (~/PSFN-Satellite-Hub, external — not in this checkout). End-to-end absent: its dependency 7ang.1 (PSFN emitting emotion.snapshot) is unimplemented, so no emotion frame can reach the hub relay. |
| psfn-framework-7ang.3 | P2 | STILL_OPEN | companion-ui/src/ui/types.ts:15-20 SpriteState is still the 6 operational states ('attentive|speaking|listening|thinking|tool_use|error'); no VAD/emotional base layer, tool_use undifferentiated. |
| psfn-framework-7ang.6 | P2 | STILL_OPEN | No full-screen avatar view / view-switcher / hit regions in companion-ui — only a small `AvatarMark` sprite in thread-view (companion-sprite.tsx:46). The large-sprite interaction surface does not exist. |
| psfn-framework-7ang.7 | P2 | STILL_OPEN | companion-ui/src/ui/composer-controller.ts:36 audio capture still fail-closed ("Browser audio capture is not wired to the hub yet"); no getUserMedia/AudioWorklet/lipsync in companion-ui/src. |
| psfn-framework-7ang.8 | P2 | STILL_OPEN | No `navigator.geolocation`/`watchPosition`/`device.location` anywhere in companion-ui/src (grep empty). Mobile GPS feed unimplemented. |
| psfn-framework-7ang.9 | P2 | STILL_OPEN | Sprite is still CSS spans (companion-ui/src/ui/companion-sprite.tsx); no shipped sprite-sheet manifest/renderer swap. Depends on absent 7ang.3. |

## Summary
- OVERTAKEN: 3 — jea9, lk0a, mmo9
- OBSOLETE: 0
- STILL_OPEN: 19 — fief, zl7f, fptm, w9hj.3, zlon, edtz, e43c, vbow, wq8o, w9hj.4, 0ggv, 7ang, 7ang.1, 7ang.2, 7ang.3, 7ang.6, 7ang.7, 7ang.8, 7ang.9
- UNCERTAIN: 2 — hrlg, 2tlk
| id | P | grade | evidence (file:line / commit / closed-bead id) |
|----|---|-------|-----------------------------------------------|
| psfn-framework-8ora | P1 | UNCERTAIN | channelPrivacy metadata infra + `promptChannelType: 'satellite_hub'` now exist (src/channels/backplane/satellite-registry.ts:79,449; src/channels/api/server.ts:983; related w05a.10 closed 2026-07-15 populated channel privacy metadata). But src/channels/ still holds only api/backplane/discord/telegram — no first-class PWA/companion-ui named channel dir/manifest, and I could not confirm PWA turns surface a distinct channelType in the observer sidecar or appear in Garden channel config. Resolve by checking observer_input_json.turn.channelType for a PWA turn + Garden channel-config listing. |
| psfn-framework-w05a.11 | P1 | STILL_OPEN | Analysis deliverable (not code). The beads it blocks — w05a.7 and w05a.8 — are both DEFERRED to 2026-07-20 (bd show), and no crosswalk analysis artifact is attached. No evidence the active_concerns↔emosim correlation was produced. |
| psfn-framework-2tli | P2 | STILL_OPEN | src/core/intention/proactive-time-gate.ts still evaluates one global window via resolveConfiguredTimeZone/getLocalMinuteOfDay (lines 39-78); grep of intention/ + scheduler/ finds no per-recipient/Contact.timezone consumer. Defect intact. |
| psfn-framework-twhd | P3 | STILL_OPEN | No PIR/biometric presence-driven wake in src/core/scheduler/ (grep for PIR/biometric/presence-wake empty). Future feature still absent; wake still fixed-clock/habit. |
| psfn-framework-7grh | P2 | STILL_OPEN | src/core/scheduler/temporal-wakeup.ts:621 resolveMorningWakeSnapshot still feeds the estimator only `resolveStartupSessionMetadata('reuse_latest_session')` → getRecentSessionEntries(sessionId,...); no cross-channel partner-timestamp projection. The 2x37.3 listRecentlyActiveChannels fan-out is for note delivery, not the estimator input. Defect intact. |
| psfn-framework-opl1 | P1 | STILL_OPEN | Epic 7/20 children complete; operator's own 2026-07-16 audit comments on children confirm enabled production is bootstrap-only/fail-closed with resolvers unwired. Not overtaken. |
| psfn-framework-opl1.5 | P1 | STILL_OPEN | Bead NOTES 2026-07-16 (operator): "production resolver, ordinary lifecycle, completion routes, and contact lifecycle bridge remain missing." Children .5.1-.5.4 open. |
| psfn-framework-opl1.6 | P1 | STILL_OPEN | Bead comment 2026-07-16 (operator): "enabled production remains bootstrap-only and Ed25519 assertion key config is currently unwired"; decomposed into open children .6.1-.6.4. |
| psfn-framework-opl1.7 | P1 | STILL_OPEN | Bead comment 2026-07-16 (operator): "OPL1.7 is a P1 release blocker: all active HTTP/WS admission remains shared-token or process-mTLS"; open children .7.1-.7.5. resolveMemorySubjectAccessContext deliberately absent (fail-closed). |
| psfn-framework-opl1.8 | P1 | STILL_OPEN | Bead comment 2026-07-16 (operator): current surface is still the loopback read-only fleet-status page; "New server-side batch projection is mandatory"; open children .8.1-.8.4. |
| psfn-framework-opl1.9 | P1 | STILL_OPEN | Bead comment 2026-07-16 (operator): enabled fleet mode fail-closed; "four latent P0 integration hazards must be prevented"; open children .9.1-.9.5. Depends on unbuilt .5/.6. |
| psfn-framework-opl1.10 | P1 | STILL_OPEN | Depends on unbuilt opl1.6 (unified origin). WebAuthn/PasskeyAuthorityFloor step-up not implemented; blocks opl1.11/.15/.5.4 (all open). |
| psfn-framework-opl1.11 | P1 | STILL_OPEN | Depends on opl1.10/.5/.7 (all open); memory JIT still token/browser-session keyed per opl1.7 07-16 audit ("memory JIT is token/browser-session keyed"). |
| psfn-framework-opl1.12 | P1 | STILL_OPEN | Certification task gated behind entire opl1 chain (.5/.6/.7/.8/.9/.11/.13/.14/.15 all open). Cannot be done before the surfaces it certifies exist. |
| psfn-framework-65rk | P2 | STILL_OPEN | Epic 0/4 children complete. Scaffolding landed only (shakedown/ dir + docs/shakedown.md per 2026-07-15 note); no deployment-variant certification pass closed. Depends on w9hj (open). |
| psfn-framework-wckv | P2 | STILL_OPEN | Depends on 65rk (open); no clean-machine setup walkthrough docs produced. Premise (README single-companion only) still holds. |
| psfn-framework-brev | P1 | STILL_OPEN | AGENTS.md has NO k3s/psfn-shard/namespace-psfn authority language (grep empty). docs/operations.md:129-130 still calls host `psfn.service` "the authoritative unit"; host-service-non-authoritative doc marking not done. |
| psfn-framework-svus | P2 | OVERTAKEN | Test now passes cleanly in 22s and process exits 0 — no hang (ran `vitest run src/app/maintenance/script-verification/install-psfn-service.test.ts`). Installer reworked in #55 "Quickwins waves 1+2 ... installer" (e6d846bd5b, 2026-07-15), after the 07-14 bead. |
| psfn-framework-2x37 | P1 | STILL_OPEN | Epic 8/10; awaits live next-morning acceptance (bead NOTES) plus two open children (.8, .9). |
| psfn-framework-2x37.8 | P3 | STILL_OPEN | src/core/session/manager-primitives.ts:313 trimRecentEntriesToTokenBudget still counts `countTokens(entry.content)` raw, while entriesToMessages (context-support.ts:261-270) prepends the stampLabel — the two counting paths still disagree. Defect intact. |
| psfn-framework-o968 | P2 | STILL_OPEN | src/core/session/manager.test.ts still contains the real-name literal at lines 362,385,390,1720,1737 (moved from cited 179/202/1235). Acceptance grep (per bead) still returns hits (also api-routes-satellites.test.ts, group-memory-diagnostics-service.test.ts). |
| psfn-framework-2x37.9 | P3 | STILL_OPEN | Cleanups unaddressed: listRecentlyActiveChannels still optional (temporal-wakeup.ts:540); RECENT_ACTIVE_CHANNEL_PARTNER_SCAN_LIMIT=128 + listSessionsByRecentActivity(MAX_SAFE_INTEGER) still at manager.ts:181,555; HISTORY_STAMP_RE still re-encoded in 3 test files (context-builder.test.ts:20, manager.test.ts:55, group-chat-harness/assertions.ts:125), not exported from context-support.ts. |
| psfn-framework-36dm | P2 | STILL_OPEN | src/boundary/integrations/world/tools.ts:509 still describes placeId with misleading `e.g. place.living-room`, and :513 affordanceId `e.g. lr_lights`; schema still does not advertise the loaded exact registry IDs. Defect intact. |
| psfn-framework-dlbs | P2 | STILL_OPEN | src/app/agent/api-surface.ts:106 discord health probe still unconditionally returns `status: 'degraded', detail: 'Discord transport runs outside the agent container'` — still poisons aggregate health. Defect intact. |
| id | P | grade | evidence (file:line / commit / closed-bead id) |
|---|---|---|---|
| psfn-framework-24o5 | P2 | OVERTAKEN | store.ts:607-649 `ensureChannelForWrite` now calls `refreshChannelIndexFromDisk()` (369-381, double-read stability guard) + `resolveExistingSession` before minting; read paths (1353/1472/1578/1634/1989/2003/2041) re-refresh. hgw3 session-read-coherence, commit d0e6d90104 (hgw3 closed 2026-07-15). |
| psfn-framework-dsd5 | P1 | OVERTAKEN | Target script `scripts/ops/setup-local-artemis-shakedown.sh` not in main (only archived branch, 185f6d1421). Role-bound auth token by closed 2k3f; idempotent owner-file seed/migrate-without-overwrite + local-Helm cert of current main by closed yg2s (2026-07-16, validate-kube-rollout 10/10). |
| psfn-framework-j8gv | P2 | STILL_OPEN | vision-attachments.ts:263-299 — inbound URL images still fire dedicated `ImageVisionReviewer.analyze` (`analyzeVisionUrlsInChunks`, `DEDICATED_VISION_REVIEW_QUESTION`) on top of mandatory intake `screenImageIntake` (line 446); no dedup, reviewer not reserved to generated-image validation. 2z12.7 fixed only double byte-crossing. |
| psfn-framework-glex | P2 | STILL_OPEN | ICP substrate landed (src/core/icp/), so the "ICP absent" gate is gone, but SEE/SAW itself absent: no shared vision-extraction sync, no provenance label for synced image info (grep across src empty). Prereq j8gv also open. |
| psfn-framework-fbfe | P1 | UNCERTAIN | Live deploy-to-carlini op, not code. No closure in digest for PR#42/#43→carlini; bead's 2026-07-15 comment shows fleet still on image c0385f2b (one commit before both PRs); yg2s validated main only on local k3d. Resolve: `helm history` on carlini + confirm image tag ≥ 576e33cd and sessions tree stopped growing. |
| psfn-framework-ipw1 | P2 | OVERTAKEN | Blocker ybzz (closed 2026-07-15, commit 76153723) moved candidate eligibility to builder-side read fallback `subjectContactId > mention-diverted memory.contactId > routedContactId` (fields 27ut already backfills) and refuted ipw1's premise; separate subjectContactId derivation now moot. |
| psfn-framework-fnyb | P2 | STILL_OPEN | `Contact` interface has no gender/pronoun/age fields (src/core/contacts/types.ts:266-283); repo-wide grep for gender/pronoun/birthYear/ageProvenance returns zero contact fields. No overlapping closed bead. |
| psfn-framework-hr1q | P2 | STILL_OPEN | `resolveChannelIdentity` mints via upsert, insert default `relationshipType ?? 'stranger'` (crud-operations.ts:290, 1420-1458); `fleetCompanionIds` never consulted at mint; no acquaintance default for fleet peers anywhere in src. |
| psfn-framework-wejv | P2 | STILL_OPEN | Admin contacts page shows only trust/privacy badges, no Human/Companion badge (admin-ui/src/routes/contacts/+page.svelte:80-157); admin Contact Update/Create payloads omit `isMachineIntelligence` (endpoints/contacts.ts:8-46). Store port `setMachineIntelligence` exists (crud-operations.ts:401) but not wired to Garden. |
| psfn-framework-v26r | P2 | STILL_OPEN | Backend shipped (api-routes-wiki-scopes.ts), but frontend gap remains: wiki/+page.svelte has only Personal projects/Wardrobe sections, no Personal/World scope tabs; endpoints/wiki.ts has no scope client functions. |
| psfn-framework-dnll | P1 | STILL_OPEN | Epic at 8/9 children complete; only child dnll.7 (P3, gateway-side per-companion capability-tier resolution, deferred) remains OPEN. Core mechanism (dnll.1) + all P1/P2 seam children landed but not all child work; not fully overtaken. |
| psfn-framework-w05a.12 | P1 | OVERTAKEN | dnll.1 (closed 2026-07-15, commit ade2156b, merged 817aa4a71a) shipped per-companion `settings.overlay.json` deep-merge + put `observerEvalSidecar` on whitelist (settings-overlay.ts:47); each fleet companion holds a distinct `observerEvalSidecar.sessionLabel`, yielding distinct emo_sim sessions. dnll.1 close note explicitly supersedes w05a.12's session isolation. |
| psfn-framework-w05a.13 | P1 | UNCERTAIN | Ops rollout, not code. No closure in digest; blocking dep w05a.12 still open (per this audit, superseded by dnll.1 but bead itself open); emosim helm lives in satellite-hub not this repo. Resolve: confirm carlini helm has emosim enabled, deploymentTarget 'live', per-companion sessions, NetworkPolicy on. |
| psfn-framework-nudf | P2 | STILL_OPEN | No owner-file watcher anywhere in src (no fs.watch/watchFile/chokidar in src/system/config or elsewhere non-test); `refreshModels` fires only on Garden save (settings-service.ts:100-102), never disk-edit triggered. Feature absent. |
| psfn-framework-p6cj | P3 | STILL_OPEN | `LifecycleNotifierConfig` has no subsystem field (notifications.ts:28-33); startup message hardcoded (notifications.ts:343); grep subsystemLabel empty. |
| psfn-framework-nljc | P2 | STILL_OPEN | heartbeat-policy.ts:510-511 still readFileSync+JSON.parse raw per load(), not loadRequiredJsonCached. Related b9kb (commit 0b87b00034) fixed only path root, not caching. |
| psfn-framework-ol0b | P2 | STILL_OPEN | `SkillUsageTelemetryStore.record()` calls load() (full-file read, telemetry.ts:245/247-259) then save() (full-file tmp+rename write, 224/262-269) every invocation; no RAM cache, no debounce. |
| psfn-framework-ay2o | P3 | STILL_OPEN | reflection-journal.ts:98-119 requires AND stores both `internalStateSnapshotRef` and a full cloned `internalState` (throws if only one present); embedded copy still written alongside the reference. |
| psfn-framework-gjhk | P2 | UNCERTAIN | Live-ops disk-reclaim, not code. No closure in digest; bead's 2026-07-15 comment confirms 242M orphan at fleet/carlini/.../state/sessions still present. Resolves only via operator-approved targeted deletion on carlini. |
| psfn-framework-u7sv | P2 | STILL_OPEN | transport.ts:704 & 761 set maxReconnectAttempts=10, reconnectDelayMs=1000 (≈9s budget); client.ts:552-553 don't raise it; agent connect failure throws to main.ts:1465 → process.exit(1); no exit-75 reexec path in src/app (grep clean). Exactly the crashloop bug described. |
| psfn-framework-opl1.13 | P2 | OVERTAKEN | Built outside this bead ID: closed opl1.17 (2026-07-16, PR #82) + commit 944ff97c41 added `createSubjectAuthorizedMemoryStore` wired into Garden admin (local-admin-contract.ts:368); filters named classes (single_contact/multiple_contacts) to allowedViewerRelations self/co_subject across list/detail/search/embedding/bulk (subject-authorized-store.ts:50-80,358-399). Prescribed AdminMemoryBodyGate piggyback moot. (Principal resolution is separate open dep opl1.11.) |
| psfn-framework-36ja | P3 | STILL_OPEN | fatigue-ledger.ts:221-241/ctor:376 and charge-ledger.ts:269-289/ctor:527 still readFileSync entire JSONL at boot; no rotation into sealed segments. 2z12.4 rotated session journals only. |
| psfn-framework-opl1.14 | P2 | OVERTAKEN | Commit 944ff97c41 added subject gating for ContactProfileArtifact in subject-authorized-store.ts:368-388: getContactProfile returns undefined unless contactId===viewerContactId, listContactProfiles returns only own, upsert denies non-subject; wired into Garden admin store. opl1.17 close note deferred profile gating to opl1.14, this commit implemented it. (opl1.11 principal-resolution caveat applies.) |
| psfn-framework-opl1.15 | P2 | STILL_OPEN | No memory/profile privacy break-glass override exists. Only unrelated session-recovery break_glass_quarantine (session-service.ts:652). Fleet-auth webauthn_uv/break_glass + passkey_credentials schema exist (migrations.ts:194,214) but NOT wired to any memory/profile disclosure override. Dep opl1.10 (passkey step-up) still open. |
# Rechecked batch rb-07 (inverse audit — try to prove OVERTAKEN)

main @ 402b3ba53e, 2026-07-16. All beads dated 2026-07-14 (2 days old). Every cited defect/absence was located in CURRENT main code; recent rewrites (tools/session/scheduler/memory/mmo9) moved adjacent code but did not implement any of these goals.

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|---|---|---|---|
| psfn-framework-opl1.16 | P3 | STILL_OPEN | Design-note never produced. `working_docs/backlog-triage-20260715.md:36` still lists "opl1.16 (doc)" to-do; related `jy6s` still open. No decision note binds reflection-gating/multi-admin-escalation questions. |
| psfn-framework-ofa1 | P2 | STILL_OPEN | Feature absent. `src/persistence/sessions/store.ts:300` `channels: Map` has no per-companion recent-window cap/LRU (only rollover delete at :1535); no config knob. `hgw3.5` bounds entries-per-channel, not sessions-per-companion. |
| psfn-framework-fvl9 | P3 | STILL_OPEN | Two corrective paths still don't share a helper: datetime retry inline `agent-invocation.ts:815-848`; vision recovery separate local helper `agent-invocation.ts:928-958`; APIs diverge (setActiveTurnContext vs setActiveTurnCorrelation). |
| psfn-framework-fpiu | P1 | STILL_OPEN | `src/core/agent/substrate-agent/turn-execution-runtime.ts:1487` still `safeResponseText = MISSING_IMAGE_ATTACHMENT_CORRECTION;` — whole-reply replacement, not heal. Guard modularized to `attachment-claim-guard.ts` but block-not-heal remains. Corroborated `working_docs/beads-audit-20260714.md:56`. |
| psfn-framework-fkyu | P2 | STILL_OPEN | Deploy/infra bug. Helm mounts companionDataDir at `/app/companion-data` (`deploy/helm/psfn/values.yaml:60`, workloads.yaml:158/353/492); no `/app/companion/skills` mount. SkillsLoader fails closed (`src/faculties/skills/loader.ts:543`). Operator live-check 2026-07-15 confirms outstanding. |
| psfn-framework-7toj | P2 | STILL_OPEN | Unconditional-latest append persists: `src/core/scheduler/temporal-wakeup.ts:665-667` `channels.push(latest)` past lookback; no live-channel-type allowlist, no testing-session exclusion. Only secondary enumeration-cost concern (2x37.9) partly mitigated at `session/manager.ts:558`. |
| psfn-framework-9c4k | P2 | STILL_OPEN | No testing marker in `src/core/session/session-id.ts`; no purge/cleanup path in session/persistence/garden; "until purged" manual-surgery comment `manager-primitives.ts:291`; no policy in `docs/operations.md`. All four deliverables absent. |
| psfn-framework-1knm | P3 | STILL_OPEN | `admin-ui/src/routes/images/LazyPageContent.svelte:269` still `<p class="line-clamp-3">{image.prompt}</p>`; no expand/modal affordance. |
| psfn-framework-189d | P1 | STILL_OPEN | Softening shim still shipped (`config/concern-softening.json`) applied via `softenConcernText` at `src/core/intention/concerns.ts:631,817`; raw strings intact `internal-state-prompt.ts:132,136,203`. Not rewritten to gentle vocabulary. |
| psfn-framework-ys51 | P2 | STILL_OPEN | TRAP CASE: concern store WAS rewritten (`active-concern-store.ts` → `postgres-adapters/concerns-adapter.ts`) but defect persists — `resolveStaleConcerns` gates only on `expiresAt`/hard-lifetime (concerns-adapter.ts:525-526); `next_review_at` stored/indexed (migrations.ts:901) but never a retirement trigger. |
| psfn-framework-75ci | P2 | STILL_OPEN | `FreeTimeLaneCadenceState` (free-time.ts:395-398) records only lastBlockAtMs/blocksToday; post-block update (:646-647) stores no endReason/silent-until; gate (:192-203) ignores end reason. Silence-ended block still counts. |
| psfn-framework-la3m | P2 | STILL_OPEN | Two lanes distinct: `FREE_TIME_QUIET_HOURS_TASK_ID`/`FREE_TIME_IDLE_TASK_ID` (free-time.ts:67,69), two channel ids (:86-87), two scheduler registrations (:717,729). Not merged. |
| psfn-framework-dtym | P2 | STILL_OPEN | Pass uses `createWorkerExecutionPolicy(WHISPER_WORKER_LANE)` (dream-meaning-pass.ts:274) → `modelPurpose:'memory'` (worker-lanes.ts:293), not main chat model as contract (:23-28) promises; input metadata-only (:81-89), summary-of-a-summary unchanged. |
| psfn-framework-n2z6 | P2 | STILL_OPEN | `memory_import_batch` schema has no occurredAt/extractedAt (tools.ts:469-486); record build never sets it (:528-538); writer gained extractedAt (writer.ts:100,417,831) but import path never supplies it → `Date.now()` stamp survives end-to-end. |
| psfn-framework-3zu5 | P2 | STILL_OPEN | No atomicity constraint: dream prompt asks paragraph-per-episode clipped to MAX_MEANING_CHARS=800 (dream-meaning-pass.ts:81-95,138), no split gate (:117-144); sleeptime DEFAULT_MAX_MEMORY_WRITES=4 no one-moment rule (sleeptime-agent.ts:63). |
| psfn-framework-apq0 | P2 | STILL_OPEN | `threadId: sessionId` verbatim at every episode-creation site: `synthesis.ts:518`, `synthesis.ts:1060`, `synthesis-lane.ts:264`. No semantic thread-join / topic registry / per-thread cap. |
| psfn-framework-6i7c | P2 | STILL_OPEN | `renderEpisodicLandmarkChains` (formatting.ts:160-197) renders only title/time/themes/landmark — no episode.id/meaning; arc-linked episodes admitted with no query-relevance check (`isRelatedEpisodeUseful`, retrieval/episodic.ts:564-589). |
| psfn-framework-x9ka | P2 | STILL_OPEN | `MEMORY_TOOL_ACTIONS` (tools.ts:70-81) has no episode get/expand-by-id; spanRefs (retrieval/episodic.ts:759) never resolve to turns; `listEpisodeArcMemberships` has zero non-test callers (def at retrieval/episodic.ts:330). |
| psfn-framework-dcnu | P1 | STILL_OPEN | `buildContinuityAnchorLines` still emits time_texture_label / reconnection_warmth_signal / warmth_guidance / last_active_at_iso (context-builder.ts:261-267); assembled as Wake Orientation block (:983,1055,1271; prompt-runtime.ts:558-559); RECONNECTION_GUIDANCE unchanged (time-texture.ts:29). |
| psfn-framework-2lw8 | P2 | STILL_OPEN | Refresher lane append-only; only dedup is interval throttle `anti_loop_recent_note` (temporal-wakeup.ts:449); fire path `appendContextSystemNote` (:1042) → `store.append` fresh row (manager.ts:1534-1549), no supersede/tombstone. |
| psfn-framework-u8iv | P2 | STILL_OPEN | `getMergedContinuity` (context-support.ts:216-259) merges all candidateUserIds via getRecent, sorts by timestamp, no channels.json/active-adapter liveness filter; `buildStructuredContinuityBlock` (context-builder.ts:279-309) renders every entry incl. test channels. |
| psfn-framework-6ahp | P3 | STILL_OPEN | `buildCurrentDatetimeProximityAnchor` still renders both `iso` (prompt-plan.ts:112) and `today` (:116); source vars runtime_current_datetime_iso / runtime_current_today produced (datetime.ts:139,141). Neither dropped. |
| psfn-framework-tlnd | P2 | STILL_OPEN | `mirrorMessageToActiveSessions` appends role:system with SOURCE timestamp (mirroring.ts:122); `store.getRecent` returns insertion order (store.ts:1471-1480, no sort); history render verbatim (context-history-assembly.ts:51-72). Ordering unfixed. |
| psfn-framework-vrmf | P2 | STILL_OPEN | No channel-bonding scaffolding: greps for bonded/crossChannelCapable/channelBond/lowest-common return zero product hits; no per-contact cross-channel opt-in, no lowest-common-privacy bond resolution. Prereqs tlnd/u8iv both open. |
# Batch rb-08 — second-pass (prove-overtaken) audit

Main @ 402b3ba53e, 2026-07-16. Inverse of pass one: tried to prove each bead OVERTAKEN/OBSOLETE against current code + closed-bead digest.

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|----|---|-------|-----------------------------------------------|
| psfn-framework-cf5y | P2 | STILL_OPEN | Raw floats intact: `src/faculties/memory/retrieval/formatting.ts:88-89` (moodDrift `.toFixed(2)`), `:103` baseline `.toFixed(2)`, `:104` current `.toFixed(2)` + drift number, `:105` learned-signal count. No baseline-vs-current qualitative framing added. |
| psfn-framework-6vfh | P2 | STILL_OPEN | Two separate blocks still rendered by `buildImmutableHumanSafetySection` `src/core/identity/prompt-composer.ts:75-89` (`immutable_human_safety_amendments` :81, `constitution_precedence` :85); "hardcoded and non-editable" line verbatim at `:47`. No merged "Companion Constitution" block. Closed constitution beads (ojwf/obvz/5q8e.8) are admin-ui prompts-page UI, not this runtime merge. |
| psfn-framework-o75r | P3 | STILL_OPEN | Bare identity block present: `src/core/identity/loader.ts:96-100` (`You are ${name}.`) ahead of description; `src/core/identity/foundation-sections.ts:15` `defaultContent:'You are {{char}}.'` promptOrder 0. No cached weekly self-written self-description surface exists (grep selfDescription/self-written/weekly = 0 relevant hits). |
| psfn-framework-v83d | P2 | STILL_OPEN | Epic 0/6 complete; every child unaddressed (below). Data-layer prereqs (turn-record diet, shared projection authority rnmo) landed but implement none of the child fixes. |
| psfn-framework-v83d.1 | P2 | STILL_OPEN | 8 tabs unchanged: `admin-ui/src/lib/components/prompt-monitor/PromptMonitorSelectedTurnTabs.helpers.ts:18-27` (summary/blocks/prompt/context/tools/diff/timeline/raw). Raw still a full tab (:26), not a toggle. 4x block iteration persists (`PromptMonitorSelectedTurnTabs.svelte:380,434`). |
| psfn-framework-v83d.2 | P2 | STILL_OPEN | `PromptMonitorTimelinePanel.svelte:65` still `formatJson(stage.data)` raw JSON; `:51-53` shows cumulative `stage.elapsedMs` as per-stage cost (cumulative confirmed `src/core/agent/substrate-agent/turn-observability.ts:115`). `stage.data.durationMs` unused. |
| psfn-framework-v83d.3 | P2 | STILL_OPEN | `subsystemOutputs` field/resolver does not exist (grep = 0 hits src/ + admin-ui/); concernDeltaRefs/contactDeltaRefs/internalStateSnapshotRef/contextManifestRef never resolved into a Loom section. |
| psfn-framework-v83d.4 | P2 | STILL_OPEN | `PromptMonitorTextBlock.svelte` (61 lines) has no button, no clipboard/writeText/copied — bare `<pre>` at :59-60. |
| psfn-framework-v83d.5 | P2 | STILL_OPEN | Live-bus still unresolved: `mergePromptMonitorEvent` (`prompt-monitor.ts:791-813`) builds turns with `record:null, promptLoom:null` → client-side `projectTurnSnapshotPrompt` (:497), never resolves memory-id/delta refs; backend `resolveTurnRecordMemoryRefs` (`session-service.ts:765`) runs only on read-side history. rnmo (07-16) unified projection code but did not route live views through backend resolution. |
| psfn-framework-v83d.6 | P3 | STILL_OPEN | `admin-ui/src/routes/prompts/page-helpers.ts:293-294` `estimateTokens = Math.ceil(text.length/4)` still present (called :183,:195); no countTokens routing. |
| psfn-framework-g44z | P1 | STILL_OPEN | Live cutover gate. Operator comment 2026-07-15: acceptance NOT met — deployed image lacks a81cdd49; all 5 agents share WORKSPACE_PATH=/app/workspace on one PVC (leak audit 3ajb). Not deployed/validated; nothing overtakes a live gate. |
| psfn-framework-h7g9 | P1 | STILL_OPEN | Epic; sole child h7g9.1 (live verification) unresolved, so epic stays open. |
| psfn-framework-h7g9.1 | P1 | UNCERTAIN | Target code present & wired, NOT removed by tool-calling rewrite: `src/primitives/llm/empty-tool-argument-retry.ts:74` (retry, max 2 :20), `client-response-helpers.ts:317` classifies `{}` as provider_emitted_empty, wired `client.ts:1217,1852` (import :118). Not obsolete; requires the live/replay run a static audit can't discharge. Resolve: run the deterministic non-Pi smoke. |
| psfn-framework-s10mc.4.1 | P2 | STILL_OPEN | Fleet status still omits fatigue/charge: `src/boundary/gateway/fleet-status.ts:8-10` documents the omission; payload type `:38-53` has no posture field; HTML `:273-276` no column; `server.ts:149` reaffirms "intentionally not shown." Connection-health envelope never extended. |
| psfn-framework-9hyv | P1 | STILL_OPEN | Live gate. Operator comment 2026-07-15: deployed `/app/system-data/models.json` has NO promptCaching key (grep=0); 2z12.1 seed ships enabled but doesn't rewrite deployed owner file. Cache engagement/billing not validatable until redeploy. |
| psfn-framework-dvzq | P2 | **OVERTAKEN** | Scheduler adaptive next-wake refutes the 60s-ceiling premise: `mmo9.5.3` commit `b2ecd2a6b2` + `mmo9.7.8` `7a5439231e`. `src/core/scheduler/scheduler.ts:399-410` `taskNextDueAt` returns `lastRun+intervalMs` for `every` tasks; `:417-462` `computeNextWakeAt`/`armNextWake` clamp to `[MIN_WAKE_MS=50, ceiling]`. The 250ms post-turn executor (`post-turn-actions.ts:1320`) now wakes at ~250ms, not 60s. Described defect gone. (Aspirational eager-drain-on-enqueue still unbuilt, but that is the bead's ask, not the titled defect.) |
| psfn-framework-be3f | P2 | STILL_OPEN | No rolled-out episode-summary breadcrumb selection (grep coveringEpisode/rolledOut/tailEpisode = 0). Deps OPEN: 6i7c — `renderEpisodicLandmarkChains` `src/faculties/memory/retrieval/formatting.ts:160-192` still omits episode id+meaning, no relevance check; x9ka — no get-by-id drill-down tool. Neither dep in closed digest. |
| psfn-framework-zkwr | P3 | STILL_OPEN | No shard goal document (grep goalDocument = 0), no shard-scoped threshold compaction (`compactionThresholdPct` is a global session setting `runtime-config-contracts.ts:216`), no bead-backed shard task graph. `faculties/shards/types.ts:93,140` status is coarse only. Adjacent 98xm worker-budget/7ym.1 north_star landed but not this goal-mode kit. |
| psfn-framework-zlve | P2 | STILL_OPEN | Premise intact, deliverable absent. `FAILURE_SIGNAL_RULES` still exists (`src/core/session/compression-guideline.ts:211`) but its only consumer feeds guideline-evolution, not telemetry. No coherence event stream / Garden card / per-signal breakdown (grep coherence in admin-ui/garden = 0 relevant). |
| psfn-framework-ih1p | P1 | UNCERTAIN | Live gate. Fuse code present: `continuationStop` schema/validation `src/persistence/sessions/turn-records.ts:224-248`. Deployment/live-run proof on psfn-shard not evidenced and not statically dischargeable; target code intact so not obsolete. Resolve: the controlled live run per acceptance. |
| psfn-framework-h6w2 | P1 | UNCERTAIN | Live gate. `memoryRetrievalPolicy` present (`faculties/memory/retrieval.ts`, `scoring.ts`, `decay.ts`, `settings-service.ts`). Deployed-proof of old-landmark retrieval not evidenced, not statically dischargeable; not obsolete. Resolve: the live deployment turn-path validation per acceptance. |
| psfn-framework-dnll.7 | P3 | STILL_OPEN | Operator-deferred 2026-07-15. Gateway still one `CapabilityRuntime` from one companionDataDir: `src/boundary/gateway/privileged-core.ts:84-87`, consumed fleet-wide (eligibility gate :89, `capabilityTierProvider:()=>capabilityRuntime.getTier()` :211). No per-companion gateway-side resolution built. |
| psfn-framework-1qex | P3 | STILL_OPEN | Operator-deferred 2026-07-15; premise intact and nothing speculatively built. `LLMCompleteParams` (`src/boundary/gateway/protocol.ts:182+`) still carries no tools/toolChoice; grep `toolChoice` = 0 in production src (only tests asserting absence). No decision phase converted to mandatory tool_choice. |
| psfn-framework-ervg | P1 | STILL_OPEN | Cross-channel leak intact, no redaction seam built. `src/core/session/manager/context-builder.ts:298` `xmlElement('text', entry.content)` embeds other-channel partner content verbatim into `<cross_channel_continuity>` body.system block (:304-307), ungated; `context-support.ts:216-258` getMerged pushes content with no tombstone check; `continuity.ts:222` getRecent no redaction; Loom `session-service.ts:915-947` provenance-only. eb14 gates plan.messages (continuity is never plan.messages). |

## Summary
- OVERTAKEN: dvzq (scheduler adaptive-wake, mmo9.5.3/mmo9.7.8 — the 250ms executor no longer 60s-bound).
- OBSOLETE: none.
- UNCERTAIN: h7g9.1, ih1p, h6w2 — live-validation gates whose target code is intact; cannot be proven overtaken or done without the live run.
- STILL_OPEN: cf5y, 6vfh, o75r, v83d, v83d.1-.6, g44z, h7g9, s10mc.4.1, 9hyv, be3f, zkwr, zlve, dnll.7, 1qex, ervg.

Note: this batch sits mostly OUTSIDE the tool/session/scheduler/background-work rewrite blast radius (prompt-rework, Loom UI, unbuilt features, live-deploy gates). Only dvzq lived in the scheduler and got overtaken. The moved session file (context-builder.ts → src/core/session/manager/context-builder.ts) preserved the ervg defect at the identical line (:298), so the rewrite did not incidentally fix it.
# Batch rb-09 — second-pass (OVERTAKEN-hunt) recheck

Repo /home/ada/psfn-framework, HEAD de2ad7331b (merge of integrate/opl1-dnll-completion, PR #89, 2026-07-16).

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|---|---|---|---|
| psfn-framework-kl7y | P1 | STILL_OPEN | Epic: 4/5 children closed but child kl7y.5's real verifier fix (commit `85b07ff238`) is NOT an ancestor of HEAD (lives only on origin/fix/opl1-full-family-verifier-remediation). `src/persistence/backups/fleet-restore.ts:838-924` `verifyFleetAuthConsistentFamilyRestore` still doesn't call canonical `restoreFleetAuthConsistentFamily` (line 591). Epic goal unmet in main. |
| psfn-framework-sm9l | P1 | STILL_OPEN | Defect live: `resolveTurnRecordSessionEntries` (`src/persistence/sessions/turn-record-session-refs.ts:576,609-618,646`) gates recentEntries/plan.messages/capturedWirePayload only — never top-level `userMessage.content`/`assistantMessage.content`; served ungated to introspection `source.ts:43-44`, Garden `session-turn-observability.ts:265-266`. `git log --all --grep=sm9l` empty; eb14 test scopes this out. |
| psfn-framework-9syj | P1 | STILL_OPEN | Epic: two P1 children code-complete in main (9syj.6 `b1c66abf12`, 9syj.7 `a74dac4b52`), but epic's "all children complete" criterion fails on open P2 child 9syj.10 (test-coverage debt, unaddressed — see below). |
| psfn-framework-x5rt.11 | P2 | STILL_OPEN | Defect confirmed: manual rollback baseRecord omits fromHelmRevision `src/system/lifecycle/kube-helm-rollback.ts:183-192`; `hasRolledBackFrom` requires `typeof record.fromHelmRevision==='number'` `kube-rollback-store.ts:140`; test asserts the gap as current behavior `kube-rollback-store.test.ts:70-73`. No fix commit references x5rt.11. |
| psfn-framework-65rk.1 | P2 | STILL_OPEN | `shakedown/harness/` does not exist (only `shakedown/README.md` + `shakedown/artie/`). No ported Layer A scripts, no shared probe library, no scorecard. Only landed work is docs+artifacts (`975ed74ebc`). |
| psfn-framework-65rk.2 | P2 | STILL_OPEN | No bootstrap script, no `shakedown:bootstrap` npm script (grep package.json empty). Only prerequisite input artifacts present (`shakedown/artie/ARTIE.png`, `shakedown.env.template`); one-command entrypoint absent. |
| psfn-framework-65rk.3 | P2 | STILL_OPEN | Zero S10 cases authored; `shakedown/harness` absent (dep 65rk.1 undone). `docs/shakedown.md:89` still just states the rule; no ported case catalog. |
| psfn-framework-65rk.4 | P2 | STILL_OPEN | No support-companion cards, no companions.json fragment/template, no teardown scripts under `shakedown/` (only `artie/` present). |
| psfn-framework-x6ig | P1 | STILL_OPEN | Ambient ALS interception intact: `src/core/session/manager.ts:438` still calls `getCapturedSessionOwner(this)` in `resolveSessionChannelId` and throws mismatch mid-turn at `:452-455`. `captured-session-owner.ts:12` still an AsyncLocalStorage. No `CapturedSessionReads`/`resolveForeignSessionForTurn` facade exists. opl1-dnll merge did not touch this. |
| psfn-framework-9syj.10 | P2 | STILL_OPEN | Coverage debt persists: weak ingress-once test unchanged `src/core/session/manager.test.ts:1693-1694` (switch fires inside the fetchSessionTailWindow spy); no test drives `executePostTurnBackgroundWork` owner race; no terminal:* e2e race analog in `turn-execution-runtime.test.ts`. `git log --grep=9syj.10` empty. |
| psfn-framework-opl1.5.3 | P1 | STILL_OPEN | Only child .3.1 landed (gateway fences/receipts). Companion-side bridge absent: `contact-authority-lifecycle` imported only under `src/boundary/gateway` + `src/persistence/postgres/fleet-auth`; nothing in `src/core/contacts`, `src/channels`, `src/app` routes merge/delete/unlink through the saga. Children .3.2/.3.3/.3.4 still OPEN. |
| psfn-framework-mcy8 | P2 | STILL_OPEN | `admin-ui/package.json` scripts has dev/build/preview/check, no `test`; vitest not declared there. 15 node:test files still under `admin-ui/src`. Mixed-runner one-command gap unfixed. Closed k510 unrelated. |
| psfn-framework-mcf5 | P2 | STILL_OPEN | `src/faculties/memory/subject-authorized-store.ts:453-464` — getLinkedMemories/evolution/abstraction getters only check normalizedSubject exists then delegate raw link metadata with no per-source/per-linked subject authorization. File untouched since pre-bead `944ff97c41`. |
| psfn-framework-5fa3 | P2 | STILL_OPEN | `src/test-support/in-memory-memory-subjects.ts:202-217` — `mutateInMemoryAuthorizedSubjects` loops per-id with `if (!memory || memory.deletedAt || !isAuthorized(...)) continue;`, silently skipping, non-atomic vs Postgres. Unchanged since `7b0363bb2b`. |
| psfn-framework-dut9 | P1 | OVERTAKEN | Epic: all 12 child fix commits merged into HEAD via PR #89: dut9.1 `88ce3967`, .2 `4fdd7736da`, .3 `f790203ebc`, .4 `5e19135f34`, .5 `3b78166fe3`, .6 `2a60472477`, .7 `1392a67938`, .8 `1fa9e6cb38`, .9 `b7076fd30d`, .10 `e2c4dba27f`, .11 `209c5dba83`, .12 `fd7fa716a3`. Integration goal met (bd tracker lag: shows 5/12 closed). |
| psfn-framework-opl1.5.4 | P1 | STILL_OPEN | Ceremonies not production-reachable: `src/persistence/postgres/fleet-auth/first-owner-sql.ts:57` still checks `v_ceremony.expires_at <= p_at` (caller time, not DB clock); `principalAuthenticationWired: false` hardcoded in prod (`src/app/gateway/main.ts:120`, `api-surface.ts:329`). Deps opl1.5.3/opl1.6/opl1.10 open. |
| psfn-framework-awve | P3 | STILL_OPEN | Warning source live: `@sveltejs/kit/.../vite/index.js:937` passes codeSplitting to Rollup output; SvelteKit 2.60.1 / Vite 6.4.3. No commit references awve or codeSplitting; toolchain repin (ewnb) didn't remove it. |
| psfn-framework-dut9.2 | P1 | OVERTAKEN | Fixed by `a389cbe81b` (merged `4fdd7736da`). `authorization-context-store.ts:27` domain-separated `AUTHORIZATION_CORRELATION_DIGEST_DOMAIN`, `:179` digests correlation, `:602-604` rejects non-canonical (`/^[0-9a-f]{64}$/`). Raw caller correlationId no longer persisted. |
| psfn-framework-dut9.3 | P1 | OVERTAKEN | Merge `f790203ebc` (ancestor of HEAD) edits the bead's named files — `src/boundary/gateway/fleet-authorization-context.ts` (+93), `src/persistence/postgres/fleet-auth/authorization-context-store.ts` (+113), plus authority-floor/companion-lock SQL, migrations, schema. All deps merged. |
| psfn-framework-opl1.6.1 | P1 | STILL_OPEN | No commit (`git log --all --grep=opl1.6` empty). Named files absent: `src/boundary/fleet-auth/request-capability-target.ts`, `garden-route-capabilities.ts`; no `requestCapabilityTarget` symbol. |
| psfn-framework-opl1.6.2 | P1 | STILL_OPEN | No opl1.6 commit. `src/boundary/fleet-auth/request-capability.ts` absent. Ed25519 exists only in separate hub-device-assertion domain (`hub-device-assertion.ts`); bead explicitly bars generalizing it. Hop request-capability signer/verifier does not exist. |
| psfn-framework-opl1.6.3 | P1 | STILL_OPEN | No opl1.6 commit. `fleet-auth-child-assertions.ts` and `request-capability-replay.ts` absent; no childAssertion/capabilityReplay symbol. Existing `fleet-auth-broker.ts` is the OAuth/Discord-evidence broker, not a signed child-minting exchange. |
| psfn-framework-opl1.6.4 | P1 | STILL_OPEN | No opl1.6 commit. `src/boundary/gateway/fleet-sso-router.ts` absent; no fleet-sso/fleetSso symbol in src. Unified HTTPS-origin SSO router/Helm wiring not built. |
| psfn-framework-opl1.5.3.1 | P1 | OVERTAKEN | Impl `cc673528e0` + merge `e95bad1ed0` (ancestors of HEAD). Present: contract `src/shared/contracts/contact-authority-lifecycle.ts`, gateway port `src/boundary/gateway/contact-lifecycle-authority.ts:7` (executeForCompanion, gateway-derived companionId), receipt/fence store `src/persistence/postgres/fleet-auth/contact-lifecycle-authority-store.ts` (+ mutations, SQL, migration/schema). |
# Batch rb-10 recheck (inverse audit: try to prove OVERTAKEN)

Context: every bead in this batch was **created 2026-07-16** (the audit date) in the
in-flight OPL1.x fleet-auth / Garden-authorization / Companion-UI epic. Each depends on
prerequisite beads that are still OPEN (opl1.5.3.1, opl1.6.1, opl1.6.3, opl1.6.4, dut9.3,
dut9.11) and each parent epic (opl1.5.3, opl1.7, opl1.8, opl1.9) is OPEN. Because these
beads were authored today with full knowledge of the current post-rewrite codebase, they
cannot have been "fixed long ago." Code verification confirms each capability is absent.
The existing `src/persistence/postgres/fleet-auth/contact-lifecycle-authority-store.ts`
is the GATEWAY-side authority store (opl1.4/dut9 evidence-lifecycle work), not the
companion-side coordinator/ledger these beads specify; its own dep opl1.5.3.1 is OPEN.

| id | P | grade | evidence (file:line / commit / closed-bead id) |
|----|---|-------|-----------------------------------------------|
| psfn-framework-opl1.5.3.2 | P1 | STILL_OPEN | Companion-side versioned ownership/intent ledger + prepare transaction absent: no coordinator/intent-ledger in src/core/contacts/ or src/faculties/; no typed manual_hold/no_auth_binding ContactStorePort outcomes (grep). Existing fleet-auth store is gateway-side. Dep opl1.5.3.1 OPEN. |
| psfn-framework-opl1.5.3.3 | P1 | STILL_OPEN | No companion two-phase coordinator to route ContactStorePort mutations through (grep prepare/commit/LifecycleCoordinator in src/core/contacts, src/faculties = none); blocked by unbuilt opl1.5.3.2. |
| psfn-framework-opl1.5.3.4 | P1 | STILL_OPEN | Startup recovery scan/leased worker/restore-quarantine/E2E for the saga not built; depends on unbuilt opl1.5.3.3. |
| psfn-framework-opl1.7.1 | P1 | STILL_OPEN | No canonical route catalogue / authorization classification in src/operator/garden/ (grep route catalogue/canonical classification/assurance = none). Dep opl1.6.1 OPEN. |
| psfn-framework-opl1.7.2 | P1 | STILL_OPEN | No fleet-principal vs legacy-token discriminated Garden admission (grep fleet-principal/admission mode in server.ts = none); current Garden still legacy ADMIN_TOKEN. Deps opl1.6.3/opl1.7.1 OPEN. |
| psfn-framework-opl1.7.3 | P1 | STILL_OPEN | Request-bound AuthContext/ActorContext threading through Garden services not present; blocked by unbuilt opl1.7.2. |
| psfn-framework-opl1.7.4 | P1 | STILL_OPEN | No trusted-host recovery capability endpoint; only fleet-auth-config.ts resolves the secret (grep recovery capability/recovery kind route = none). Deps opl1.6.3/opl1.7.2 OPEN. |
| psfn-framework-opl1.7.5 | P1 | STILL_OPEN | No Garden bounded fleet-auth projection route; depends on unbuilt opl1.7.1/opl1.7.2. |
| psfn-framework-opl1.8.1 | P1 | STILL_OPEN | No authenticated fleet portal projection (grep /v1/fleet/portal, fleetPortal = none). Deps dut9.3/opl1.7.1 OPEN. |
| psfn-framework-opl1.8.2 | P1 | STILL_OPEN | No /fleet shell or /v1/fleet/portal API modules exist; deps opl1.6.4/opl1.7.2/opl1.8.1 OPEN. |
| psfn-framework-opl1.8.3 | P1 | STILL_OPEN | Loopback fleet-status hardening/doc-separation vs the new (nonexistent) portal not done; depends on unbuilt opl1.8.2. |
| psfn-framework-opl1.8.4 | P1 | STILL_OPEN | Unified HTTPS-origin Helm wiring + multi-companion portal E2E not built; depends on unbuilt opl1.8.2. |
| psfn-framework-opl1.9.1 | P1 | STILL_OPEN | Companion-UI still root-scoped, not /companion-ui subpath (grep /companion-ui in src = none; no vite/sw scope config found). Closed u24q (2026-07-13) fixed cache staleness, not subpath scoping. Dep opl1.6.1 OPEN. |
| psfn-framework-opl1.9.2 | P1 | STILL_OPEN | No Hub-device-assertion→fleet-human attachment ledger/enrollment-authority port (embodiment/Hub greps hit shards/presence only). Deps dut9.11 (in-progress ◐), dut9.3 OPEN. |
| psfn-framework-opl1.9.3 | P1 | STILL_OPEN | No /companion-ui/companions/{id}/ws gateway broker or companion.interact action policy; deps opl1.6.3/opl1.7.1/opl1.9.2 OPEN. |
| psfn-framework-opl1.9.4 | P1 | STILL_OPEN | Companion-UI fleet login/switch UX + cross-stack E2E not built; depends on unbuilt opl1.9.1/9.2/9.3/9.5. |
| psfn-framework-opl1.9.5 | P1 | STILL_OPEN | No gateway embodiment-authority store/handoff protocol (grep embodiment = shards/presence-metadata only, not an embodiment authority). Deps opl1.9.2/opl1.9.3 OPEN. |
| psfn-framework-2a01 | P2 | STILL_OPEN | Flaky test still present verbatim: src/persistence/postgres/model-usage-store.integration.test.ts:1079 asserts freshness.state=fresh after setDatabaseAvailability(true) (lines 1070-1085); no fix commit since 2026-07-16 (git log --since 07-16 on that file/store = none). |

Summary: 18/18 STILL_OPEN. None overtaken. The pass-one STILL_VALID grade is correct here
because these are same-day planning beads for an unstarted sub-epic, not stale beads
predating a rewrite.

## Appendix B — deep-dive reports

# Deep Hermes/Codex Capability Audit — PSFN (main @ 402b3ba53e, 2026-07-16)

Grading the OPEN 2026-04/05/06 beads against the CURRENT architecture. The rb-00/rb-01 files
list only OPEN beads; most of these epics' *closed* children already shipped the "easy half"
(e.g. the tool-confusion cluster vvf.1/.3/.6, north_star plan 7ym.1, session-search-into-core
i72.4). The first audit pass grepped for the beads' NAMED target files (`hook-registry.ts`,
`workspace-checkpoint.ts`, `skills-guard.ts`, `tests/security/`, `notifyPartner`) and declared
everything unbuilt. That was wrong for a large slice: the subagent/skills/tool-surface systems
were rewritten several times and the capabilities landed under the codebase's own vocabulary.

---

## 1. Current-architecture map (what actually exists today)

### Worker families (two, not one)
- **Subagents** = `SubagentFaculty` (`src/faculties/subagents/faculty.ts`), short-horizon bounded
  workers. **Shards** = `ShardManager` (`src/faculties/shards/manager.ts`), long-horizon launches.
  Several "shard" asks were satisfied on the **subagent** side; several stay shard-only. This split
  is the single biggest reason the first pass misread coverage.

### Subagent capabilities (present)
- **Identity inheritance**: subagent SubstrateAgent built with `request.systemPrompt ?? parentSystemPrompt`
  (`faculty.ts:388`, threaded `composition.ts:573`). No structured *role/values profile* object though.
- **Status state machine**: `queued|running|completed|failed|cancelled` (`types.ts:6`) enforced by
  `ALLOWED_TRANSITIONS`/`assertAllowedTransition` (`task-registry.ts:6-12,149-157`); honest
  `SubagentOutcome = completed|blocked|cancelled|budget_limited` (`types.ts:19`).
- **Parent mailbox**: `emitCompletionHandoff` (`faculty.ts:747-811`) → `CompletionNoticeBuffer`
  (`completion-notices.ts:58-108`) renders `<background_completions>` into the next parent turn;
  never persisted to session store (`completion-handoff.ts:127-137`).
- **Delegation limits**: usage hints (`descriptions/agency-contracts.ts:42-53`); depth-cap by stripping
  `spawn_subagent/spawn_shard` from child toolset (`BLOCKED_SUBAGENT_TOOL_NAMES`, `faculty.ts:72-86`);
  `maxConcurrent=8` blocked-spawn handoff (`faculty.ts:205-215`); `cancel()`→`agentLoop.abort()` (`332-357`).
- **Per-subagent budget + checkpoints**: typed `LLMWorkSpec` `deadlineMs`/`maxOutputTokens`
  (`work-spec.ts:43-47`), `evaluateBudgetExhaustion`/`finalizeBudgetLimited` (`faculty.ts:1013-1130`)
  → `budget_limited` + `SubagentPartialResult`/`SubagentCheckpoint`/`SubagentRemainingBudget`
  (`types.ts:50-87`). **Advisory only — no WorkerBudgetGovernor, no admission/charge enforcement**
  (`faculty.ts:1076-1080`).
- **Lifecycle audit spine**: `auditTrail.append('subagent.lifecycle.transition' | '.execute.start/.end' |
  '.tools.injected' | '.cancel.requested' …)` (`faculty.ts:249,259,406,344,878…`). This is audit
  *emission*, NOT an operator-registerable hook seam.
- **Model-facing lifecycle tool**: `subagent` tool actions `spawn|message|wait|cancel|status`
  (`subagents/tools.ts:30-200`), gated `shard.spawn` capability (`tools.ts:196`). This is the unified
  long-horizon-worker handle.

### Shard capabilities (present)
- Intra-run multi-turn feed `for turn<maxTurns` (`manager.ts:621-716`), heartbeat health
  (`touchShardHeartbeat`/`refreshShardHealth` `manager.ts:1026,1035-1070`, stale→degraded→offline),
  memory-write **fold-review gate** (`BLOCKED_SHARD_TOOL_NAMES` `manager.ts:79-98`;
  `quarantineShardMemoryMutation`→`foldReviewController.recordPendingMemoryCandidates`
  `tool-sync.ts:62-161`; promotion only on operator `resolveFoldReview` `fold-review.ts:479-516`),
  inline compaction + trajectory capture (`scheduleAutoCompactionBetweenTurns` `manager.ts:698-711`;
  `compressionGuidelineEvolution.captureAndReview` `633-651`).
- **Explicitly owns NO post-turn/cross-heartbeat lane** (`backgroundWorkDisabled:true`,
  `manager.ts:589-591,694-697`). No goal-completion loop, no per-shard token budget, no
  evidence-based completion audit, no repeated-blocker detection.

### Background supervisor (mmo9)
- `BackgroundWorkSupervisor` (`core/agent/background-work/supervisor.ts`, wired `substrate-agent.ts:589`):
  leased queue, lease-renewal heartbeat, retry/backoff, welfare admission (mmo9.7.4), effect fencing.
  Kinds are **only** `memory_extraction|intention_post_turn_hooks|emotion_appraisal|auto_compaction`
  (`background-work/types.ts:27-32`). Cross-turn *task* continuation is a separate lane:
  `subagent.spawn` in `backgroundContinuation` (`post-turn-action-runtime.ts:12,54-67`,
  `post-turn-actions.ts:220-228`, `rescheduleAt` `947-960`).

### Skills / tool-surface / tool-confusion
- **Agent-authored skills**: `skill create/update` (`skills/tools.ts:365-425` → `runtime.ts:165-182`
  → `store.ts:207-255`). Validation is structural/path-safety only (`store.ts:16-101`) — **NO content
  security scanner** for injection/exfil/destructive instructions.
- **Skills guard/telemetry**: eligibility gates (`filter.ts:100-179`), precedence-shadow guard
  (`loader.ts:632-667`), usage telemetry (`telemetry.ts`, surfaced `skill stats`), per-instance
  enable/disable config (`SkillsRuntimeConfig`).
- **Tool-confusion mitigation (strong)**: nearest-name suggestion `suggestNearestToolName`
  (`tool-call-correction.ts:60-79`), retired-alias resolution (`registry.ts:104-118,565-585`),
  malformed-arg retry guard (`tool-call-scheduler.ts:561-635`), schema-invalid reprompt
  (`tool-call-correction.ts:164-172`), action-parameterized surface collapse (`registry.ts:120-526`),
  core/extended exposure + adaptive promotion (`adaptive-tools-runtime.ts:214-322`). **Per-model tool
  *formatting* is ABSENT** (only per-model prompt-cache routing exists, `llm/routing.ts:37`).
- **Pre-tool interception**: block/modify/augment mechanics EXIST but hardcoded in
  `executeSingleToolCall` (`tool-call-scheduler.ts:286-461`): skip-guards block, `validateToolArguments`
  modifies, corrective results augment. **No pluggable/operator hook seam.**
- **No user-extensible hook faculty**: `RuntimeConfigHooks` = 4 fixed internal callbacks
  (`runtime.ts:1668`); `EventBus` (`shared/event-bus.ts`) is internal telemetry, no registration API,
  no `PreToolUse`/`PostToolUse` config keys, no `WORKSPACE/hooks/` scan.
- **No clarify tool**: nearest is `notify approval_request/consider` (operator approval, not user
  request-disambiguation).
- **Session tool still overloaded**: single `session` tool actions
  `list,new,resume,search,grep,wake_return,start_focus,complete_focus` (`registry.ts:327`); focus
  delegates to `focus.ts` but is NOT split into distinct `chat_history`/`focus_work` tools.

### Boundary / security
- **Sandbox**: code exec in child proc with empty env + permission flags
  (`sandbox-execution-port.ts:297-328`); shell exec fail-closed
  (`shell-runner.ts:17` always throws `SHELL_EXEC_CONFINEMENT_UNAVAILABLE`); curated-PATH/env-allowlist
  config exists but dormant (`shell-policy-config.ts:8`). PATH hardening (4r0.5) shipped.
- **Security regression tests (COVERED — all 6 bead categories)**: SSRF
  (`gateway/url-policy.test.ts`, `backplane/safe-remote-fetch.test.ts`), shell sandbox
  (`sandbox/execution/shell-runner.test.ts`, `sandbox-execution-port.test.ts`), path traversal
  (`filesystem/runtime-wiring.test.ts:129`, `filesystem/tools.test.ts:228`), sensitivity/PII
  (`system/trust/privacy-regression.test.ts`), injection
  (`gateway/intake/injection-classifier.test.ts`, `l2/l3-screener.test.ts`), rate limit
  (`system/capabilities/safeguards.test.ts:166`, `world-autonomy-limiter.test.ts`). Spread across the
  tree, NOT in a `tests/security/` dir.
- **Secrets (COVERED-by-equivalence)**: `CredentialVault` backend `env|openbao`
  (`custody/credential-vault.ts:32-49`); `resolveRuntimeCredentialFromEnvironment` **refuses inline
  env secrets, requires file-path/fd delivery** (`runtime-credential-source.ts:73-89`) = the ESO/mounted
  pattern; helm secret-wiring test (`helm-runtime-secret-wiring.test.ts`). SPIFFE SVID is a separate
  (closed) bead hd7f.
- **ABSENT**: workspace checkpoint/shadow-git (git ops has no stash/reset/checkout/snapshot,
  `git/ops.ts:84`); supply-chain PR-diff scanner (only egress canary `canary-egress-guard.ts`);
  Discord inbound is coalescing/lock backpressure not a rate limiter, no 429/retryAfter handling
  (`discord/adapter.ts:595,723`) — outbound has `ExternalCommunicationRateLimiter`
  (`safeguards.ts:478-544`) but NOT the vvf.4 sendTyping strike-counter.

---

## 2. Grade table

| id | grade | what exists now (file:line) | what's genuinely missing |
|----|-------|-----------------------------|--------------------------|
| **vvf** (epic) | PARTIAL | Tool-confusion half shipped (closed vvf.1/.3/.6 + `tool-call-correction.ts`) | hooks/clarify/flood children still open |
| **i72** (epic) | PARTIAL | Skill authoring, session-search-in-core (i72.4 closed), shard heartbeat | checkpoint port, skills scanner, subagent heartbeat |
| **7ym** (epic) | PARTIAL | plan (7ym.1), status/mailbox, delegation limits, work-spec all built | roles/hooks are partial; guardian-reviewer closed-but-unverified |
| **7ym.8** (epic) | PARTIAL | fold-back, intra-run loop, subagent budgets | shard goal-loop, shard budgets, evidence completion audit |
| **031** (epic) | PARTIAL | 14/17 children closed (self-status, degradation, journaling, ambient, provenance…) | 031.11, 031.15 open; 031.17 frozen |
| **4r0** (epic) | PARTIAL | 18/19 closed (PATH hardening, TLS, breakers, WS limits, error handlers…) | only 4r0.12 Model<any> remains |
| **b5m** (epic) | PARTIAL | heartbeat reflection composition landed (bbzq closed) | introspection-not-firing is live-ops; self-directed rest windows unbuilt |
| **w9hj** (epic) | PARTIAL (external) | Satellite-hub PWA live on kube (per ops memory) | in-repo gateway-channel/approvals/artifacts client not present |
| **1z6.1** | **COVERED** | all 6 categories exist as tests (SSRF/shell/traversal/sensitivity/injection/ratelimit — see map §Boundary) | only cosmetic: not consolidated under `tests/security/` |
| **7ym.4** | **COVERED** | state machine `task-registry.ts:6-12` + mailbox `faculty.ts:747-811`/`completion-notices.ts:58-108`; trigger-turn via post-turn `subagent.spawn` | partial-result marking present; partner-facing auto-notify deferred (overlaps s2p.5) |
| **7ym.6** | **COVERED** | hints `agency-contracts.ts:42-53`; depth-cap `faculty.ts:72-86`; `maxConcurrent` `faculty.ts:205-215`; cancel `faculty.ts:332-357`; partial-result `types.ts:50-87` | nothing material |
| **98xm.5** | **COVERED** (equiv) | unified `subagent` tool `spawn/message/wait/cancel/status` gated `shard.spawn` (`subagents/tools.ts:30-200,196`) | no *separate* `shard` tool w/ `deliver`/`list`; budget-envelope-required-on-spawn not enforced |
| **o9de** | **COVERED** (equiv) | credential vault + OpenBao + file/fd secret delivery refusing inline env (`custody/*`) + helm secret-wiring test | ESO/Infisical-specific chart wiring is a deploy choice, not built here |
| **s2p.5** | PARTIAL | completion-handoff mailbox notifies the companion (`faculty.ts:747-811`) | partner-facing auto-notification is policy-deferred (`completion-handoff.ts:118-122`), not delivered |
| **i72.2** | PARTIAL | agent skill create/update built (`skills/tools.ts:365-425`) | content security scanner + `skill.suggestion` event ABSENT |
| **i72.3** | PARTIAL | shard heartbeat built (`manager.ts:1026,1035-1070`) | subagent heartbeat + gateway inactivity-timer extension ABSENT |
| **7ym.2** | PARTIAL | companion identity inheritance via `parentSystemPrompt` (`faculty.ts:388`) | structured role/values profile registry, role toolset/limit enforcement ABSENT |
| **7ym.3** | PARTIAL | block/modify/augment mechanics in `tool-call-scheduler.ts:286-461` | extensible/pluggable `pre_tool_use` hook seam ABSENT |
| **7ym.5** | PARTIAL | lifecycle audit + transition emission (`faculty.ts:249,878…`) | operator-registerable spawn/stop hooks that inject-context/block-spawn ABSENT |
| **7ym.8.1** | PARTIAL | intra-run multi-turn loop `manager.ts:621-716` | cross-heartbeat goal auto-continuation (the P0) ABSENT — shards own no post-turn lane |
| **7ym.8.2** | PARTIAL | subagent budgets shipped (98xm) | shard-specific token/time budget + 80/95/100% threshold prompts ABSENT |
| **7ym.8.4** | PARTIAL | terminal-state validation tags + fold-review gate (`manager.ts:890-895`) | evidence-per-requirement completion audit ABSENT |
| **c7d** | PARTIAL | shard fold-review precedent fully built (`tool-sync.ts:62-161`) | subagents NOT wired to fold-review; `memory` still in default subagent toolset — the actual ask unbuilt |
| **6l1** | PARTIAL | tool-surface reworked (core/extended, correction, telemetry, skill surfacing) | structured audit-with-companion + per-model tool formatting ABSENT |
| **m82u** | PARTIAL | per-owner-file named migrations (`scheduler-owner-migration.ts`; prompt-layers commit 7b950ba8) | reusable migration *registry/runner* framework ABSENT |
| **vvf.2** | ABSENT | — | user-extensible file-based hook system (only internal EventBus/RuntimeConfigHooks) |
| **vvf.4** | ABSENT | (adjacent: outbound `ExternalCommunicationRateLimiter`) | Discord sendTyping strike-counter / progressive-edit auto-disable |
| **vvf.5** | ABSENT | (adjacent: `notify approval_request`) | structured clarify tool with choices[] rendering |
| **i72.1** | ABSENT | — | WorkspaceCheckpointPort / shadow-git snapshot + `fs rollback` |
| **1z6.3** | ABSENT | (adjacent: findings-as-regression-tests exist) | Artemis exit-interview→JSON-assertion pipeline in shakedown artifacts (external path) |
| **4r0.12** | ABSENT | — | `Model<any>` still 19 hits in src/ |
| **9j6** | ABSENT | — | typescript-eslint type-checked rules; 0 `no-floating-promises` configured |
| **98r** | ABSENT | contact store exists (`core/contacts/`) | discrete facts-about-person dossier field/view |
| **q19** | ABSENT | — | `compositionalMode` still typed `'legacy'|'chunk_compose'` (`extraction/types.ts:82`) |
| **f170** | ABSENT | image defaults code-only (`primitives/images/service.ts`) | settings-owned image provider/model defaults contract |
| **917v** | ABSENT | stage helper files exist alongside | `runExtractionOrchestration` NOT extracted — `orchestrator.ts` grew to 1116 LOC |
| **isi.7** | ABSENT | — | human-attention-pressure policy/timeout |
| **hrui** | ABSENT | — | supply-chain PR-diff attack-pattern scanner in CI |
| **8wf5** | ABSENT | (bug still live) | `continuity-watchdog-state.json` still unresolved import |
| **of5w** | ABSENT | (reverse import still present) | `admin-ui/.../settings-garden-contract.ts:1` still `export * from '../../../src/…'` |
| **l3qv** | ABSENT | — | action-pipe `+page.svelte` still 466 LOC, unsplit |
| **jhqb** | ABSENT | `focus.ts` exists | session tool NOT split into `chat_history` + `focus_work` |
| **031.11** | ABSENT | — | emotional-discrepancy detection/journal (prereq 031.17 frozen) |
| **031.15** | ABSENT | (unrelated "embodiment" = latent-presence) | visual autobiography / reference lineage / embodiment consistency |
| **PSFNLIVE-gkr** | ABSENT | (Garden has audit/telemetry) | live-logs stream + event-bus inspector view |

Counts: **COVERED 5 · PARTIAL 20 · ABSENT 20 · MOOT 0** (total 45).

---

## 3. False-close risks (verify separately — outside the grading set)
- **7ym.7** (guardian reviewer subagent) is marked CLOSED, but the subagent faculty has NO
  reviewer-role subagent and cannot even nest workers. Either implemented as fold-review/self-mod
  plumbing (not a spawned reviewer) or false-closed. Verify.
- **7ym.8.3** (repeated-condition blocked audit) marked CLOSED, but shards have only `dedupeKey`
  collapse — no `consecutive_blocked_turns` detector. Possibly satisfied by the subagent `blocked`
  outcome rather than shards. Verify.

## 4. Confidence / risk
- High confidence on COVERED/ABSENT rows backed by direct file:line reads (all four subsystem maps
  read source, not just grep).
- Lower confidence: **w9hj** (PWA lives in the external satellite-hub repo — in-repo absence is not
  full absence), **PSFNLIVE-gkr** (a Garden audit/log viewer may exist under a name I didn't hit),
  **b5m** (part live-ops, not gradeable from source). Treat these three as "needs a targeted look."
- The COVERED-by-equivalence calls (**98xm.5**, **o9de**) would flip to PARTIAL if the operator
  requires the literal artifact (a separate `shard` tool; ESO specifically) rather than the capability.
# Deep audit: Helm / owner-file-migration / ops-guidance cluster

Repo state: on branch `main` @ `de2ad7331b` (prompt's `402b3ba53e` is stale). `main` is **80 commits ahead** of `origin/feat/opl1-dnll-completion-20260716` and that branch has **0 commits main lacks** — the remote DNLL/dut9 wave is fully merged. `origin/work/opl1-dnll-dut9-3-fleet-auth-resolver` is fleet-auth only, not migration/helm/ops. So **no bead here is IN-MOTION-ON-BRANCH; everything is judged in `main`.** The operator was right: a large migration+Helm+docs wave landed 2026-07-15/16 (epics `yg2s`, `dut9.*`, plus `7x37/mkhl/bxso/r11o/tfj5/yooi`).

| id | grade | evidence | remaining scope (if any) |
|----|-------|----------|--------------------------|
| m82u | COVERED | Real framework in main, not shims: 11-file `src/persistence/system-owner-fleet-migration*.ts` (planning/execution/recovery/receipt/owner-validation/bootstrap/io/evolution) + `src/system/config/scheduler-owner-migration.ts` (retired-key migrate-before-validate, atomic/fsync) + charge-policy/skills per-companion migration + Helm pre-upgrade hook `deploy/helm/psfn/templates/owner-migration-upgrade.yaml` (snapshot→migrate→readiness-probe) + CLI `src/app/maintenance/migrate-system-owner-fleet.ts` (digest approvals, no-secrets) + crash-atomic recovery + extensive tests. Alpha boundary + beta-removal criteria documented `docs/specifications.md:31-97`. Acceptance items met. | Realized as concrete registered migrations (scheduler retired-keys + system→fleet fan-out), not one fully-generic pluggable registry; `PromptLayerStore` itself not retrofitted (acceptance allows "or an equivalent owner-file load path" — satisfied). If operator wants the abstract registry, that's residual — but acceptance criteria as written are met. |
| pulo | PARTIAL | Unified pre-scale job exists: `owner-migration-upgrade.yaml` (helm.sh/hook pre-upgrade, weight -20, before workloads) + CLI + per-companion readiness probes cover scheduler/charge-policy/skills/capability-tier with receipts, no secrets (`validations.yaml` approvals whitelist those 4). `model-prefetch-job.yaml` seeds the text-emotion model. Tests cover missing-old-field cases. | (a) `backup.json` migration (encryption / mirrorDir clear) is NOT in the approvals whitelist or the fleet migration (grep: 0 hits) — pulo explicitly named backup.json. (b) The cutover job has NO model-cache **readiness verification** for `SamLowe/go_emotions` + `Xenova MiniLM`; prefetch job only *seeds* text-emotion and only when `modelPrefetch.textEmotion.enabled` — the MiniLM embedding prefetch + a readiness gate before scaling are not proven. |
| jea9 | PARTIAL | Label stamped in all build paths: `scripts/ops/ship-kube-update.sh:144`, `src/app/operator/kube-self-update-transport.ts:328`, deploy-pipeline stage 4 (`docs/operations.md:262+` / `kube-deploy-pipeline.ts:543`). Carried through automated post-rollout gate `kube-post-rollout-validation.ts` (plan.imageRevisionLabel validated as exact 40-char, recorded; agent_readiness = "running image matches target tag/revision"). Local test: `kube-deploy-pipeline.test.ts:149` asserts `record.imageRevisionLabel`. | The named manual validator `scripts/ops/validate-kube-rollout.sh` (1017 lines) still verifies only env `PSFN_GIT_COMMIT`/`CONTRACT_HASH` — no `docker/ctr inspect` of the deployed image's `org.opencontainers.image.revision` label (grep: 0 hits). Acceptance criterion 2 is satisfied by the "equivalent" automated pipeline but NOT by the manual ops script the bead names; if a strict label-equality inspection is wanted, it's absent. |
| brev | STILL_OPEN | No statement anywhere in `AGENTS.md` or `docs/operations.md` marking host `psfn.service` non-authoritative or naming k3s namespace `psfn` as the live authority with read-only discovery commands (targeted greps: 0 hits). `docs/operations.md:128-133` still renders host systemd `psfn.service` as "the authoritative unit"; watchdog section (471-494) still systemd-host-framed. Only "namespace psfn" mentions are in `docs/satellite-hub-kube.md` (unrelated). | Entire ask untouched: add to AGENTS.md + operations.md that the live companion = k3s namespace `psfn`, `/app/system-data` in the PVC is authoritative, host `psfn.service`/`/var/lib/psfn/runtime` are disabled/stale, plus read-only pod/owner-hash discovery commands before any mutation. The migration-doc edits the operator recalls are real but address owner migration, not this host-authority retirement. |
| wckv | STILL_OPEN (epic) | `docs/setup.md` got migration/seed/multi-companion additions (headings: Prerequisites, Install, JSON Owner Files, First Local Bring-Up, Runtime Modes incl. Multi-companion+workspaces, Sanity Checks). But no per-variant clone→first-conversation walkthrough, no troubleshooting matrix keyed to fail-closed startup errors, no bootstrap config generator. | Epic deliverable (newcomer-with-LLM clone-to-conversation per variant: local single, dual, docker, kube; troubleshooting keyed to each fail-closed rejection; bootstrap script/templates) is not done. Depends on `65rk` shakedown. |
| x5rt.11 | STILL_OPEN | `src/system/lifecycle/kube-helm-rollback.ts` baseRecord (lines 183-191) records schemaVersion/namespace/release/trigger/targetHelmRevision/resultingHelmRevision/reason/startedAt — **no `fromHelmRevision`**. `kube-rollback-store.ts:140` `hasRolledBackFrom` requires `typeof fromHelmRevision === 'number'`, so a manual rollback never keys the act-once ledger. Not fixed on `main`, `origin/feat/x5rt-kube-self-management` (git grep empty), or any branch (`git log --all --grep=x5rt.11` empty). | Bug persists exactly as filed. Fix option (a): capture live from-revision into baseRecord; or (b) widen the acted check in `kube-auto-rollback.ts`. Add the regression test the bead specifies. |
| g44z | STILL_OPEN (validation gate, blocked on deploy) | Operator live-check 2026-07-15 (in bead) confirms acceptance not met: fleet image `c0385f2b` lacks c337+`a81cdd49`; all 5 agents share `WORKSPACE_PATH=/app/workspace` on one PVC. Code side: c337 app-level personal/shared workspace source exists (`src/operator/garden/services/shared-workspace-service.ts` etc.). BUT Helm `workloads.yaml` mounts every workload's `workspace` volume at `.Values.runtime.workspacePath` with **no per-companion `subPath`** (lines 166/355/495) — the fleet deployment still shares one workspace path. | Gate can't pass until a deployed revision contains c337 + hygiene remediation with per-companion workspace isolation actually wired. Flag: verify whether c337 intends per-companion `WORKSPACE_PATH` env values vs PVC subPath — current Helm gives neither distinct, matching the live leak. Not code-complete on the Helm/fleet-mount side. |
| 9hyv | STILL_OPEN (validation gate, blocked on deploy) — CODE COVERED | Code shipped in main (2z12.1 squash `84c0089e`): `config/models.seed.json` promptCaching.enabled=true; `prompt-assembly.ts` applies owner policy + emits `prompt.cache.prefix_instability`. Operator live-check: deployed `/app/system-data/models.json` has no promptCaching key; seed does not rewrite deployed owner file. | No code work remains. Bead is a live soak/billing-validation gate: update the deployed models.json owner file (via the owner-migration path) + fleet redeploy, then run the multi-turn soak and inspect provider cache-read billing. Cannot close from code. |

## Appendix C — wave-1 adversarial close verification

# Adversarial close-verification — main @ 402b3ba53e (2026-07-16)

| id | verdict | evidence / unmet criterion |
|----|---------|----------------------------|
| psfn-framework-y6q1 | CONFIRMED-CLOSE | Implementation now exists (bead's own 2026-06-28 "no impl" note is STALE). `src/faculties/memory/maintenance-review.ts` = `MemoryMaintenanceScheduler` with `queuePostWriteReview` (async, `setTimeout(0)` non-blocking) building `near_duplicate` + `provenance_confidence` reviews. Wired to runtime: `writer.ts:269` instantiates it, `:295` calls it post-write. Postgres reviews store (`postgres-store/reviews.ts`) makes state inspectable. `maintenance-review.test.ts` 9 tests pass. All 3 ACs met. |
| psfn-framework-lpro | CONFIRMED-CLOSE | Epic, 5/5 children closed. `deploy/helm/psfn/` chart + templates present; ARM64 build path in `scripts/ops/ship-kube-update.sh` (buildx `--platform`, arm64 node probe) against `docker/Dockerfile.agent`; non-invasive pilot child (aiy7) closed. Parent ACs 1-3 satisfied in-repo (cluster-apply is operational, hub live on kube per record). |
| psfn-framework-h5zn | CONFIRMED-CLOSE | File relocated to `src/persistence/backups/postgres-restore.ts`; `runPsql` failure path redacts via `redactPostgresCredential(describeExecError(error), connection.password)` (:145). `service.ts:247` pg_dump path also redacts. Credential redaction helpers in `postgres-connection.ts`. |
| psfn-framework-ix5b | CONFIRMED-CLOSE | `npx eslint src/operator/garden/transport-server.ts` exits 0, no errors (no-unnecessary-condition at :104 resolved). |
| psfn-framework-vinz.4 | CONFIRMED-CLOSE | `src/faculties/wiki/places-wiki-publication.ts` = deterministic idempotent projection of `places.json` → shared-world wiki pages (registry stays single source of truth, read-only, prunes removed places, no prompt-time raw dump). Wired to `app/maintenance/publish-places-wiki.ts` + `wiki-service.ts`. `places-wiki-publication.test.ts` 4 tests pass. |
| psfn-framework-mmo9.7 | CONFIRMED-CLOSE | Epic, 8/8 children closed. `src/primitives/llm/work-spec.ts` LLMWorkSpec; `autonomous-workspec-enforcement.test.ts` 3 tests pass (test-enforced call-site adoption). Prompt-cache benchmark report `working_docs/prompt-cache-benchmark-20260715.md` present. Welfare/worker-lanes tests pass (`worker-lanes.test.ts` 5). Wiki cached-snapshot landed (see 28pd). Parent ACs met. |
| psfn-framework-fgm4 | CONFIRMED-CLOSE | All 3 local record guards replaced by shared `isRecord`: `supply-chain-check.ts:19`, `rule-engine.ts:22`, `intake-envelope.ts:21` all import from shared utils/types. `grep 'function isRecordValue'` = empty. `verify:shared-type-guards` passes. |
| psfn-framework-engc | CONFIRMED-CLOSE | `satellite-registry.test.ts` now uses in-memory `exampleRegistry()` fixture (synthetic names: pi-voice/Kitchen Voice Pi, `aaaa…` uuid), `mkdtempSync` temp dir — no `process.cwd()`/`satellites.json` read, no real companion name. Test run: 29 passed in a normal checkout. |
| psfn-framework-qz9e | CONFIRMED-CLOSE | `npm --prefix admin-ui run check` → 0 ERRORS 0 WARNINGS, exit 0. Cited parsers now narrow via `requireUuid`/`requireEnum` (icp-autonomy-contract, icp-recovery-fatigue-metadata). |
| psfn-framework-28pd | CONFIRMED-CLOSE | `verify:dependency-cycles` passes: 4 baseline-matched cycles only, no wiki active-context↔retrieval cycle, no regressions. |
| psfn-framework-ctm5 | CONFIRMED-CLOSE | `verify:identity-literals` passes (1648 files, 551 allowlisted). Full `verify:repository-hygiene` chain passes end-to-end. |
| psfn-framework-xo9m | CONFIRMED-CLOSE | `verify:dependency-cycles` passes — only 4 baseline cycles, "No regressions". The 10-cycle regression at base 9bb2bd43 is resolved in current main. |
| psfn-framework-6nje | CONFIRMED-CLOSE | `verify:hardcoded-settings` passes ("[verify-hardcoded-settings] passed"); part of the green full repository-hygiene chain. |

## Summary
- CONFIRMED-CLOSE: 13
- REFUTED-KEEP: 0

Note: y6q1's embedded audit note claiming "no implementation exists" is stale (dated 2026-06-28); the feature was implemented and wired afterward. lpro/mmo9.7 verified via both child status and independent parent-AC evidence.
