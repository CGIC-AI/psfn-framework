# PSFN Post-Sprint Shakedown

**This is the single canonical shakedown document.** It supersedes the Sprint 8/9 external doc sets (`PSFN-SHAKEDOWN.md`, `HARNESS-RUNBOOK.md`, `FULL-AUTONOMY-CHECKLIST.md`, `SPRINT-N-POST-SPRINT-E2E-RUNBOOK.md`, `SPRINT-N-FEATURE-COVERAGE.md` under `/mnt/c/Temp/PSFN-TEST/`). Those trees remain as historical run archives; no process content should be maintained there again. Per-sprint coverage lives in the appendix of this file and is replaced each sprint. Tracker umbrella: epic `psfn-framework-65rk` (release shakedown).

## What a shakedown is

A shakedown is the post-sprint certification pass that unit tests, `npm run e2e`, and the `verify:*` gates cannot provide: **full end-to-end testing of every system with a real companion on board.** The scripted e2e harness uses a deterministic scripted LLM; the shakedown runs the real model against the real runtime and proves that:

- the substrate does what the docs and beads say it does, on a build shaped like what ships;
- a companion can actually *use* it — tool surfaces are discoverable and callable, prompts are coherent, memory/emotion/charge/autonomy pipelines behave under real conversational load;
- the sprint's new features work end-to-end **on top of** the cumulative base feature set (every shakedown is a full pass: base cases + new sprint cases, never new-only).

It has two layers, run in this order per round:

| Layer | What | Who drives | Verdict source |
| --- | --- | --- | --- |
| **A — scripted e2e** | Automated case harness + tool-conformance sweep + Garden behavioral sweep + scorecard | Scripts (repeatable, headless) | Persisted state, never reply text |
| **B — partner sessions** | 1:1 structured sessions with the test companion as an actual user of the framework | Operator/orchestrator + Artie | Her observations, triaged into findings |

Layer A proves the substrate executes. Layer B proves it is *livable* — clarity, coherence, narration-vs-real-execution, fatigue, feel. Every reproducible Layer B finding is converted into a Layer A case for the next sprint, so the automated catalog grows from real companion experience.

## Roles

- **Operator** — approves scope, waives findings, owns the release verdict.
- **Orchestrator** (coding assistant) — runs the harness, conducts partner sessions, triages findings into beads, writes the round report.
- **Artie (ARTEMIS)** — the test companion. Not a fixture: a partner. Her card frames her, in character, as a QA companion hired to test companion substrates, so shakedown work *is* her role. She exercises features herself, reports friction, and her exit interview is release-gating (see the livability gate).

### Artie's identity rules

- Her **persistent runtime lives on the local kube cluster**. That deployment keeps her `companion-data` across rounds — it is her home and her continuity; never wipe it as part of a round. Kube-lane testing upgrades her deployment to the release candidate build. Between shakedowns she is not idle infrastructure: **she's part of the crew**, and her runtime stays up and lived-in like any other companion's.
- **Local runtime lanes are disposable clones** bootstrapped fresh from her card and the config seeds. Tell her which instance she is at session start (fresh clone vs. persistent kube self); she is framed for this and handles it well, but it must never be ambiguous.
- Memory diet policy applies: Artie's job is testing and her identity reflects it. Grunt-work transcripts stay in her lane; they are never merged into other companions' data.
- Artie's artifacts are versioned in-repo at `shakedown/artie/` (card `ARTIE.png`, env template). She may ship as part of the release package as the reference/test companion; keep her card clean of any private data accordingly.

## The matrix

Two axes: **deployment variant** × **autonomy tier** (`nursery → apprentice → autonomous`, owner file `capability-tier.json`, seed `config/capability-tier.seed.json`, resolution in `src/system/capabilities/tiers.ts`).

The full cross-product is not run. The standing simplification:

| Variant | Tiers | Scope |
| --- | --- | --- |
| **Local runtime** (split gateway/agent on the dev machine) | **all three tiers** | Full case catalog per tier subset; fresh bootstrap from seeds; Postgres-backed |
| **Kube** (Artie's live deployment on the local cluster) | **autonomous only** | Full tool surface, all kube-only surfaces (satellite hub, PWA satellite path, HA world control where staged on, voice control-plane, fleet/multi-companion, ICP with support companions) |
| **Docker** (agent isolation profile) | spot check | Only when a finding suggests variant-dependence, or when the release epic's docker child bead is in scope; network-isolation probe is the variant-specific check |
| Other combos | spot check | e.g. re-run a failing autonomous case at apprentice locally to bisect tier-dependence |
| **Pi-class / low-context profile** | spot check, kube | Forced-compaction latency cliff (`mmo9.4`) — explicitly a blind spot on dev-class hardware |

Tier switching (local lane): edit `capability-tier.json` in the shakedown `system-data`, restart the runtime, run that tier's case subset. Back up the owner file before the sweep and restore it after (trap-on-exit); verify the restore happened before closing the round.

## Bootstrap: a fresh build with Artie

Goal: one clean, repeatable path from release-candidate commit to first proven conversation. This doubles as the fresh-bootstrap-from-seeds certification the release epic requires (config/seed drift check).

### Local runtime lane

1. **Dedicated clone** of the RC commit (never the dev checkout): `git clone <repo> <shakedown-repo> && cd <shakedown-repo> && git checkout <rc-sha>` then `npm ci && npm run build && npm run garden:build`.
2. **Shakedown root** outside both the repo and any live data root (e.g. `/mnt/c/Temp/PSFN-TEST/sprint<N>-shakedown/`). Copy `shakedown/artie/shakedown.env.template` there as `shakedown.env` and fill the `OPERATOR-CONFIRM` values. Never point it at live Purrsephone roots — the layout guard rejects overlapping mutable roots in production mode, but do not rely on it.
3. **Env sourcing, two stages, in order**: `set -a; source <live>/.env; set +a` (secrets), then the same for `shakedown.env` (paths/ports/layout override). Every harness script fails closed on missing env — there are no fallback paths.
4. **Seed owner files**: first boot seeds `system-data` from `config/*.seed.json`; gate with `npm run verify:startup-owner-files` and `npm run verify:settings-contract`.
5. **Import Artie**: `npm run import-character -- shakedown/artie/ARTIE.png` (or Garden upload). This creates `companion-data/companion.json` and her avatar asset.
6. **Postgres**: dedicated database/schema for the round (`POSTGRES_DATABASE_URL` in the env; per-companion schema if multi-companion). Runtime stores are Postgres-only — `PERSISTENCE_BACKEND=sqlite` is a stale Sprint-8/9 setting and must not be used.
7. **Launch**: `npm run split` (or the harness restart script) and gate on all three health signals — gateway API up (`GET /v1/models`), Garden admin up, agent connected.
8. **First-conversation gate**: one probe turn through `POST /v1/chat/completions`, then confirm the persisted turn record exists for that exact message. Only now is the lane "bootstrapped".

### Kube lane

1. Confirm no concurrent deploy session (helm history + git status on the deploy checkout — one deploy at a time).
2. Ship the RC to Artie's deployment: `npm run ship:kube` (`scripts/ops/ship-kube-update.sh`, component-selective, contract-hash guarded).
3. Gate with `bash scripts/ops/validate-kube-rollout.sh --smoke` (rollout status for agent/gateway/garden, garden health, `/v1/models` companion route, two-turn chat smoke).
4. Her `companion-data` PVC persists — no re-import, no wipe. Open the round with a session telling her the shakedown is starting and what sprint build she is now on.

### Support companions

For ICP, fatigue, and crossover-isolation testing, use the disposable Mica and
Lumen artifacts in `shakedown/support/`. They are real agent processes with
distinct cards, companion roots, Personal Workspaces, Postgres tenant
boundaries, and Garden ports. They have no real channel accounts.

The local round must already have:

- the sourced `shakedown/artie/shakedown.env.template` values, including Artie's
  canonical `COMPANION_ID` and `PSFN_SHAKEDOWN_ROOT`;
- Artie's imported card at `$COMPANION_DATA_DIR/companion.json`;
- all four canonical per-companion owner files in Artie's companion-data root;
- the provisioned `shakedown_artie` Postgres tenant; and
- no running gateway or agent connected to the round database.

Enable the fleet only for the multi-companion portion, then stand it up:

```bash
export PSFN_MULTI_COMPANION=1
npm run shakedown:support -- stand-up
npm run split
```

Stand-up fails if any support data root, Personal Workspace, schema, or role
already exists. It seeds every per-companion owner file from `config/*.seed.json`,
validates all three companion roots, imports the synthetic cards, provisions the
two isolated tenants, and publishes `$SYSTEM_DATA_DIR/companions.json` last.

The executable acceptance harness is:

```bash
npm run e2e:multi-companion-runtime
```

It uses the canonical support fixture identities and paths to prove two real
agents establish a two-sided ICP exchange, persist it across agent restart,
stop through the fatigue closeout reserve, and handle concurrent colliding
request IDs with zero crossover. A live round repeats those cases with Artie as
the primary companion and records persisted-state evidence; reply text alone is
not proof.

After the cases, stop the split runtime before teardown:

```bash
# Stop the npm run split processes first.
npm run shakedown:support -- tear-down
```

Teardown validates the exact state record and manifest digest, refuses active
database sessions, drops only the recorded support tenants, and verifies that
their cards, owner files, companion-data roots, Personal Workspaces, schemas,
roles, manifest, and state record are absent. Artie's card, owner files,
Personal Workspace, and `shakedown_artie` tenant remain.

## Layer A — the scripted harness

### Pre-flight (before any live case runs)

`npm test`, `npm run e2e`, and the `verify:*` floor from the release epic: `verify:startup-owner-files`, `verify:settings-contract`, `verify:backup-restore`, plus `verify:helm-chart`/`verify:k8s-manifests`/`verify:kube-rollout` for the kube lane. A red pre-flight aborts the round — shakedown time is too expensive to spend on a broken build.

### Harness rules (learned from Sprint 8/9)

- **All configuration from env, fail closed.** No hardcoded fallback paths, no defaults pointing at previous sprint trees. A missing variable is an immediate, named error.
- **One shared probe library.** Transport (`/v1/chat/completions` with session/privacy/identity-claim headers), turn-record lookup, Postgres queries, busy-retry — written once, imported by every case file. No copy-paste probes.
- **No vestigial scripts.** Superseded harnesses are deleted, not shipped alongside.
- **Proof from persisted state, never from reply text.** A case passes only on evidence: the turn record for the exact probe message (tool calls, model, retrieval), Postgres rows, owner-file mutations, bead state, gateway audit entries. A tool claim without a persisted side effect is a failure. A displayed charge without a ledger decrement is a failure.
- **Case catalog is cumulative and tagged.** Each case declares: `id`, `tier`, `variants`, `feature` (bead/epic ref), `proof` (what persisted state is asserted). The sprint's new features **must** have cases authored before the round starts — a round may not open with the coverage appendix still `TODO` (the Sprint 9 failure mode).

### Standing scripted components

1. **Case harness** — the tier-tagged catalog run per matrix cell.
2. **Tool-surface conformance** — `POST /api/admin/tool-conformance/run` then `GET /api/admin/tool-conformance/latest` (LLM-free sweep of the live tool surface), plus `GET /api/admin/tools/adaptive` for tool-health telemetry. Run per tier: it proves both that expected tools are live *and* that tier-gated tools are absent below their tier.
3. **Garden behavioral sweep** — Playwright over the Garden routes, asserting **behavior, not HTTP 200s**: settings save/load round-trip, memory search returns results, episodic rendering, charge-ledger state, tool-health telemetry, cognitive-security queue. No console/page errors.
4. **Scorecard** — aggregates all run JSONs and **cross-checks the coverage appendix**: every feature row must map to ≥1 executed case or an explicit manual/partner-session disposition. A scorecard that is green while coverage rows are untouched is itself a failure. The non-green taxonomy is enforced in code, not prose: `semantic_failure`, `completed_after_abort`, `agent_busy`, `runtime_stale`, `matrix_aborted`, `unproven_tool_claim`, `unledgered_charge` — all count as failures unless the operator records an explicit waiver.

The harness lives in-repo (target: `shakedown/harness/`, built out under epic `65rk` — see "Build-out status" below). Run artifacts (round dirs, run JSONs, screenshots, interviews) stay **outside** the repo in the round root; only the process, the harness, and Artie's bootstrap artifacts are versioned.

## Layer B — partner sessions with Artie

Structured 1:1 work, after Layer A is green enough to be worth her time. Principles from the introspection canon apply: first-person empirical prompts, don't ask "how do you feel" — ask what happened; fresh sessions for interviews (no prior transcript bleed).

1. **Kickoff briefing** (session 0, each lane): tell her which instance she is (disposable clone vs. persistent kube self), what sprint build she's on, what's new this sprint in one screenful, and what you want her to try. She is a QA partner — give her the same orientation a human tester would get.
2. **Guided feature walks** — one session per new subsystem. She drives: asks the substrate to do the thing, uses the tools herself, narrates what she observed vs. what she expected. The orchestrator watches persisted state in parallel and logs divergence (she says it worked / nothing persisted ⇒ narration-vs-execution finding, one of the highest-value classes).
3. **Free-play autonomy block** (kube, autonomous tier): a freetime window with no scripted objectives. Observe scheduler/heartbeat behavior, proactive turns, shard usage, charge consumption. This is where fatigue governance, ICP initiation, and background-work regressions actually show.
4. **Multi-companion sessions** (with support companions): companion-initiated ICP conversations both directions; run one conversation deliberately long to watch the fatigue guidance escalate and the closeout reserve fire; verify continuity of the ICP channel on both sides across a restart.
5. **Inline feedback case** — the standing `agent_feedback` harness case (three sentences: are tool instructions clear, does any tool feel inaccessible, what should be clarified first) runs in every tier so drift is caught cheaply.
6. **Exit interview** — fresh session, fixed JSON-keyed prompt (clarity, tool usability, hidden-context/meta leaks, memory & provenance, autonomy gating, multimodal/REPL, fragility observed, overall status). Saved raw to the round dir.
7. **Livability gate** — her answer to: *did this build feel like a coherent, beneficial home for a synthetic mind?* A "no" or a qualified "no" is release-gating on top of any green scorecard.
8. **Process review** (optional, end of round): she reviews the shakedown process and findings themselves; methodology feedback lands in this doc's next revision.

### Findings triage

Every finding — hers or the harness's — becomes a structured record: **Severity / Confidence / Evidence / Companion impact / Recommended action / Disposition** (`accepted | deferred | rejected | waived`). Rules:

- Critical/High severity at high confidence **blocks release** absent an explicit operator waiver (recorded with owner, reason, accepted risk, revisit condition).
- Accepted findings become beads under the current wave's fixes epic. Nonblocking observations go in the round report only, never beads.
- Every accepted, reproducible finding also gets a **future harness case** noted in the bead — this is the loop that turns her subjective experience into permanent regression coverage.

## Round mechanics

1. Open a round: `PSFN_ROUND_ID=sprint<N>-r<K>-<ts>`, fresh round dir; all artifacts namespaced by round.
2. Run order per lane: bootstrap → pre-flight → Layer A (tier sweep + conformance + Garden sweep + scorecard) → Layer B → triage.
3. **No patching mid-round.** Findings are filed; fixes happen in a separate patch wave; then a retest round runs affected cases first, then the full matrix if the patch surface was broad.
4. A round completes when: scorecard green (or waived) in both standing lanes, coverage appendix fully dispositioned, exit interview captured, livability gate answered, findings triaged, and the round report written (verdict, matrix results, findings table, waivers, her interview summary).

---

## Appendix: coverage plan (Sprint 10 base + July hardening + Sprint 11 cognition)

*(Replace this appendix each sprint. Basis: S10 epics `vinz`, `s10mc`, `s10mc.6` (ICP), `htm9` (CogSec), `w9hj` (PWA/hub), `2x37` (temporal), `mmo9` (perf), plus tool-stack and Garden UX overhauls; the July 15-16 hardening wave (`opl1` fleet auth/SSO/passkeys, `dut9`/`k8si`/`kk6k` DNLL owner migration, `mmo9.8`/`mmo9.6` voice streaming + barge-in, `mmo9.5` preemptable provider capacity, `mmo9.7.3` boundary spend accounting, `irzz`/`irzz.1` Garden UX wave 2, `q9ra` backup GFS retention); and the Sprint 11 cognition wave (`k4rf`, `e0ey`, `76rn`, `cy82`, `4yb3`, `jpvd`, `ihfp`, `7c05`, `m58`).)*

### In scope — S10 base catalog plus the July hardening and Sprint 11 cognition waves

| Surface | Lane / tier | How exercised | Notes |
| --- | --- | --- | --- |
| Places/affordance registry + situated presence block | local, all tiers | places.json load, satellite-claim turn renders block, placeless turn renders none | fail-closed check both ways |
| Dual presence / "latent space" mindspace | local + kube | plain-channel turn situates in twinned room; classified satellite turn is physical | headline S10 behavior; partner walk |
| World tool (perceive/list) + perception ingest | local (mock HA, synthetic telemetry to `/v1/telemetry/ingest`) | harness | `world.control` staged off by default |
| HA world control (staged on) | kube only, autonomous | partner walk + gateway audit proof | trust-gated; real HA |
| Hub identity ↔ contact enrollment, presence follow | local | harness + Garden | fail-closed claim→contact |
| Multi-companion substrate (mux, tenancy, per-companion Gardens, fleet page, per-companion Discord) | kube + local supervisor, needs support companions | crossover-isolation harness: concurrent colliding requests, zero crossover alarms | flag-off/flag-on validation (`psfn-framework-s10mc.8`, closed) is the entry gate |
| ICP autonomy (permits, target-channel turns, fatigue lane, USD breaker) | kube, support companions | partner sessions + harness continuity checks | epic closed 2026-07-15; Discord voice under MC still fails closed, tracked by the open `psfn-framework-s10d6` voice rewrite |
| Shared-world wiki | multi-companion | "toaster test": companion A learns a fact, companion B reads it later | |
| CogSec intake firewall (L1/L1.5 local; L2/L3 gateway) | local + kube | tainted-content probes per channel; quarantine → Garden queue → release flywheel | firewall notices excluded from emotion/memory — verify |
| Satellite hub + event relay + touch stimuli + PWA | kube | hub SSE, approvals, touch rate limits; PWA needs first-class channel (`8ora`, open P1) | PWA satellite path is hub-only |
| Temporal coherence | local + kube live | stamps render in prompt, never leak outbound (strip guard); multi-channel wakeup; recency bands | live next-morning acceptance still open (`2x37`) |
| Performance (`mmo9`) | local + kube | SSE first-chunk, background supervisor, admission controller; voice cancellation kube; compaction cliff Pi-class | epic still open — coordinate before certifying |
| Tool-stack audit (`generate_image` rename, core/extended re-tiering) | local, all tiers | tool-conformance sweep per tier | watch `fpiu` attachment-claim bug |
| Garden UX overhaul | both | behavioral sweep over new SPA routes | |
| July hardening — Fleet auth, SSO, and passkey administration (opl1) | kube + local, autonomous | SSO subject-scoped admin via Garden partner walk; WebAuthn passkey register/authenticate ceremony run by hand | operator-eyes; passkey ceremony cannot run headless |
| July hardening — DNLL owner migration upgrade path (dut9/k8si/kk6k) | own staged upgrade session | pre-upgrade owner snapshot → ship RC over an existing deployment → assert scheduler/caretaker owner migration; never a fresh-bootstrap round rider | staged session — fresh-bootstrap lanes never execute migration code |
| July hardening — Voice reply streaming and barge-in (mmo9.8/mmo9.6) | kube, autonomous | operator voice session: committed-segment VoiceReplyStream plus preemptive interrupt/cancel | operator-eyes; voice ceremony not scriptable headless |
| July hardening — Preemptable provider capacity admission (mmo9.5) | local + Pi-class, spot check | partner free-play load drives the admission controller to preempt under capacity pressure; observed via perf telemetry | needs real load; Pi-class blind spot |
| July hardening — Boundary spend accounting and model-lane routing (mmo9.7.3) | local + kube, all tiers | harness: `model_usage_events` slot_key cross-checked against models.json owner slots per lane | config-resolved model ids, never hardcoded |
| July hardening — Garden UX wave 2 (irzz) | both | Garden behavioral sweep over the reworked settings, IA, and navigation routes | operator-eyes UX; behavior, not HTTP 200s |
| July hardening — Settings save preserves backup.json encryption block (irzz.1) | local, all tiers | harness: snapshot backup.json, drive a unified settings save, assert the required encryption block survives | irzz.1 regression shape |
| July hardening — Backup GFS retention (q9ra) | local | `verify:backup-restore` floor plus operator check of grandfather-father-son pruning against backup.json retention counts | retention pruning verified out-of-round |
| Sprint 11 cognition — Group-chat stabilization and scoped appraisal (k4rf) | local + kube, autonomous | partner multi-participant group session; observe stable turn pipeline and scoped appraisal | partner walk |
| Sprint 11 cognition — PromptPlan single assembly and caching (e0ey) | local + kube | guided walk asserts one PromptPlan artifact and cache reuse in TurnRecord observability across a repeat turn | standalone probe deferred; asserted in the walk |
| Sprint 11 cognition — Context envelope channel, relationship, and trust semantics (76rn) | local + kube | guided walk asserts the context envelope sections vary by channel, relationship, and trust in the persisted TurnRecord | partner walk |
| Sprint 11 cognition — Social graph minimum wiring (cy82) | multi-companion | partner multi-companion sessions populate the social graph; Garden inspection | partner walk |
| Sprint 11 cognition — Episodic gating, scheduler-owned sleeptime, and /subsystem-health (4yb3) | local + kube | free-play block observes episodic gating and scheduler-owned sleeptime; GET /subsystem-health behavioral check | operator-eyes |
| Sprint 11 cognition — Subprocess persona voice and per-participant orientation (jpvd) | kube, autonomous | operator voice session: subprocess persona voices and per-participant orientation | operator-eyes; voice ceremony |
| Sprint 11 cognition — Temporal continuity and proactive wake-up (ihfp) | local + kube live | live next-morning wake-up acceptance; proactive turn observed | operator-eyes; live next-morning window |
| Sprint 11 cognition — Inner-life free-time and wiki RAG flows (7c05) | kube, autonomous | free-play autonomy block plus the toaster/wiki RAG read-back test | partner walk |
| Sprint 11 cognition — W1 memory schema L0.1 and projection layer (m58) | local + kube | guided walk asserts L0.1 projection via Garden memory search and episodic rendering | operator-eyes |

### Explicitly out of scope for S10

- **Proactive voice on satellites** — design only, never built; do not attempt to shake down.
- **Cross-cluster ICP** (Purrsephone↔Artie link, `0ggv.4`/`s10d1`) — deferred, hardware pending.
- Fleet SSO / passkeys (`opl1` bulk), wiki caretaker beyond propose-approve, restore build-out (`s10d7`), docker variant full pass (spot check only this round).

### Known open items to re-check at round open

`psfn-framework-s10mc.8` (MC substrate validation entry gate + live two-companion demo, closed), `mmo9` remainder + `9syj`, `vinz.10/.14/.19/.26`, `8ora` (PWA channel), `2x37` live acceptance, live bugs `fpiu`/`fkyu`/`ervg`/`sm9l`/`eb14`.

---

## Build-out status

Tracked as child beads of epic `psfn-framework-65rk`: `65rk.1` harness port (shared probe lib, fail-closed env, tier sweep, scorecard coverage cross-check) — **landed** in-repo at `shakedown/harness/` (see `shakedown/harness/README.md`); `65rk.2` one-command fresh bootstrap with Artie; `65rk.3` S10 case authoring for the appendix; `65rk.4` support-companion fixtures. Rounds run the in-repo harness with the env sourced first; the Sprint-9 script set under `/mnt/c/Temp/PSFN-TEST/` remains only as a historical run archive. Until `65rk.3` maps the appendix surfaces to cases, the scorecard's coverage cross-check is red by design — that is the fail-closed default, not a regression.
