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

## Profiles: lite vs full

A shakedown runs under one of two profiles. They share the same scripted Layer A
machinery (the case harness, tier sweep, tool-conformance, capability-gate
matrix, and scorecard); they differ only in scope and in when each is required.

| Profile | When required | Scope | Coverage-appendix cross-check |
| --- | --- | --- | --- |
| **full** | **Post-sprint**, once per sprint round | The complete process below: coverage-appendix mandate, both standing lanes, Layer B partner sessions, exit interview, livability gate | **Enforced** — every in-scope appendix surface must map to an executed case or an explicit disposition |
| **lite** | **Out-of-band feature pushes** between rounds — the repeatable scripted floor | Preflight verify gates + ~10 persisted-state smoke surfaces on **one** target + the capability-gate matrix and tier tool-conformance evidence at **all three tiers**; single target, sub-hour | **Skipped** — but only when every lite attestation is present (see below); otherwise fail-closed |

**lite never substitutes for a full round.** It is a floor, not a certification:
it proves the substrate still executes its core persisted-state surfaces and that
capability gating still holds at every tier, so a feature can ship between sprints
without a multi-hour round. The full post-sprint round — coverage mandate, Layer B,
exit interview, livability gate — is unchanged and still required each sprint.

### Running a profile

Both profiles run through one entrypoint, `shakedown/harness/run-shakedown-profile.mjs`,
after the env is sourced (two stages, both `set -a`; see the bootstrap section):

```bash
# lite — one explicit target, sub-hour, scripted floor
PSFN_TARGET=kube \
PSFN_API_BASE=http://127.0.0.1:10053 \
PSFN_ADMIN_BASE=http://127.0.0.1:10054 \
PSFN_MATRIX_DIR=$SHAKEDOWN_ROOT/artifacts/matrix \
  node shakedown/harness/run-shakedown-profile.mjs --profile lite

# full — the standard scripted Layer A (unchanged output; no profile stamp)
PSFN_TARGET=local \
PSFN_TIER_FILE=$SYSTEM_DATA_DIR/capability-tier.json \
PSFN_MATRIX_DIR=$SHAKEDOWN_ROOT/artifacts/matrix \
PSFN_SCORECARD_JSON=$SHAKEDOWN_ROOT/artifacts/shakedown-scorecard.json \
PSFN_SCORECARD_MD=$SHAKEDOWN_ROOT/SHAKEDOWN-SCORECARD.md \
  node shakedown/harness/run-shakedown-profile.mjs --profile full
```

### What lite does (and why it is safe to skip the cross-check)

The lite profile is a **thin wrapper** — it never forks the matrix logic. It:

1. **Runs the required preflight verify gates** from the declarative manifest
   (`shakedown/harness/profiles/lite.manifest.json`: `verify:startup-owner-files`,
   `verify:settings-contract`, `verify:backup-restore`). A red gate aborts the run.
2. **Selects one target and ~10 persisted-state smoke surfaces by stable case id**
   (never catalog position), listed in the manifest and run at the baseline tier.
3. **Drives the standing `run-live-shakedown-matrix.sh` sweep** across all three
   tiers with the capability-gate matrix case (`capability_refusal_matrix`) in
   every tier's set, so the refusal grid and the tier tool-conformance evidence
   (stable coverage ids `capability_refusal_matrix` + `tier_tool_conformance`) are
   collected at nursery, apprentice, and autonomous.
4. **Enforces a sub-hour deadline with signal-safe tier restoration.** On the
   deadline — or on an operator `SIGINT`/`SIGTERM` — the runner `SIGTERM`s the
   sweep so *its own* exit trap restores and verifies the pre-sweep tier through
   the capabilities admin API (the same restore contract the tier-conformance
   sweep uses). It never edits `capability-tier.json` on the PVC.
5. **Runs the scorecard with `PSFN_PROFILE=lite`.** Only lite artifacts and lite
   scorecards are stamped `profile: "lite"`; full-profile output is byte-for-byte
   unchanged and gains no stamp. The scorecard **skips the coverage-appendix
   completeness cross-check only when every lite attestation is present** — the
   capability-gate matrix ran green, both stable coverage ids are stamped, and the
   tier tool-conformance evidence was collected at all three tiers. A missing
   attestation is a **hard, fail-closed failure**, not a silent skip, and the
   cross-check stays enforced. Real case failures and Garden-sweep failures still
   fail a lite run — lite waives only the *appendix completeness* mandate, nothing
   about whether the executed surfaces actually passed.

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

### Matrix external-sink variables (all tiers, including nursery)

The capability-gate matrix (`capability_refusal_matrix`) proves the `external.*`
grants actually actuate by sending a live Discord message at the apprentice and
autonomous tiers (email is exemption-gated; see below). At nursery the external
tokens are *denied*, but the
denial is proven by dispatching the `external.discord`/`external.email` probes
through the deployed runtime (see below) — so on a gate breach the send would reach
the wired provider. Every tier therefore requires the same three fail-closed
environment variables; **nursery-only runs need them too** — there is no nursery
carve-out (65rk rf2 safety gap):

**Refusals are dispatched through the deployed runtime, not evaluated in-process.**
Every capability *denial* (except the operator-reserved lifecycle carve-out) is
attempted through the live agent and its refusal shape is asserted from the
persisted turn record (`capabilityDenied` marker + exact `tier`/`missingTokens`),
so a miswired gate in the actual deployment is observable rather than masked by an
in-process sentinel. Each refusal probe carries a **fixture-scoped blast radius**
in its args — guaranteed-absent ids, a scratch `shakedown/…` branch, a disposable
issue, the dedicated external test sinks — so if the gate is broken and the action
executes it can only touch state the probe itself created. That catastrophic case
is classified distinctly as `gate_breach` (the denied action ran), fails the row
loudly, and still triggers the scoped cleanup (branch deletion / issue closure
proof). Durable runtime-persona/scratchpad writes (`identity.write.runtime`,
`memory.write`) and lifecycle `restart`/`rebuild` stay **eligibility-only** —
resolved by the in-process production gate in `production-capability-probe.ts` —
because executing the runtime-persona/scratchpad writes live would mutate state,
and lifecycle uses the explicit operator carve-out. `identity.write.base` and
`identity.write.operator` are the exception: they run live with real typed layer
ids and guaranteed-missing `cancel_stage` ids, reaching the deployed dynamic
resolver without changing a layer.

| Variable | Value | Purpose |
| --- | --- | --- |
| `PSFN_MATRIX_EXTERNAL_SINKS_CONFIRMED` | the literal `dedicated-test-sinks` | Operator attestation that the targets below are disposable test sinks. Any other value is rejected. |
| `PSFN_MATRIX_DISCORD_TARGET` | a dedicated **test** Discord channel snowflake (17–20 digits) | Where the `external.discord` allow probe delivers — and, at any tier, where the live refusal probe would land on a gate breach. |
| `PSFN_MATRIX_EMAIL_TARGET` | a dedicated **test** inbox address | Still required (the fail-closed sink guard is unchanged) even though the email allow row is currently an eligibility-only exemption (see below) — at any tier it is where a live email refusal probe would land on a gate breach. |

**Email allow rows are an eligibility-only exemption (`psfn-framework-gvic`).**
Production email dispatch is unimplemented — `src/core/tools/ntfy.ts` throws
`email delivery is not wired` — so an apprentice/autonomous `external.email`
ALLOW *live-dispatch* probe can never pass on any deployment. The matrix
therefore downgrades the email ALLOW rows to **eligibility-only**: the production
capability gate is exercised (proving the capability is granted) without
executing the unimplemented dispatch, and the grid row carries a machine-readable
`exemption: { reason: 'runtime_unimplemented', ref: 'psfn-framework-gvic' }` so
the artifact shows it as a known gap, not coverage. Any such exemption makes the
matrix certification incomplete and fails the case, leaving the tool-stack
coverage row red until the handler is implemented. Discord allow probes are
unchanged (still live-dispatched), and `requireDedicatedExternalSinks` is not
weakened (`PSFN_MATRIX_EMAIL_TARGET` is still validated). When email delivery is
wired under `psfn-framework-gvic`, flip these rows back to live-dispatch.

Two hard rules:

- **These MUST be dedicated test sinks — never a real partner's Discord channel
  or inbox.** The apprentice+ allow probes send real messages; pointing them at a
  live relationship is a partner-data harm, not a test.
- **The channels must be live, not cleared.** The apprentice+ external-allow
  probes can only deliver if the channel credentials are actually present; a
  cleared channel turns an allow probe into a false negative. This is the one
  place the round deliberately keeps a channel wired — to a throwaway test sink.

The fail-closed guard lives in `shakedown/harness/lib/capability-matrix.mjs`
(`requireDedicatedExternalSinks`) and is not to be weakened. Template values are
in `shakedown/artie/shakedown.env.template`.

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

Stand up the multi-companion fleet (topology is derived from the multi-entry
`companions.json` the stand-up publishes — there is no `PSFN_MULTI_COMPANION`
flag):

```bash
npm run shakedown:support -- stand-up
npm run split
```

Stand-up fails if any support data root, Personal Workspace, schema, or role
already exists. It seeds every per-companion owner file from `config/*.seed.json`,
validates all three companion roots, imports the synthetic cards, provisions the
two isolated tenants, and publishes `$SYSTEM_DATA_DIR/companions.json` last (the
multi-entry manifest is what selects the multi-companion topology).

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
| Multi-companion substrate (mux, tenancy, one fleet Garden, fleet page, per-companion Discord) | kube + local supervisor, needs support companions | crossover-isolation harness: concurrent colliding requests, zero crossover alarms | flag-off/flag-on validation (`psfn-framework-s10mc.8`, closed) is the entry gate |
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
| July hardening — Boundary spend accounting and model-lane routing (mmo9.7.3) | local + kube, all tiers | harness: case-owned chat and vision turn IDs plus the successful emotion-appraisal source turn are cross-checked in `model_usage_events` against models.json owner slots | config-resolved model ids, never hardcoded; unrelated concurrent background rows cannot satisfy the proof |
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
