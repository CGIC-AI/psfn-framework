# Sprint 10 — Next Steps

Status: 2026-07-08; **§0 added 2026-07-12 and §0.4 refreshed 2026-07-14 through W8 closeout** (post-triage grilling session — decided priority order, operator decisions, and corrections; where §0 and the older sections disagree, §0 wins). Companion doc to [`sprint-10-multi-companion.md`](./sprint-10-multi-companion.md) (the plan, v2) and [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (the locations plan). Those two answer "what are we building and why"; this one answers "what happens next, in what order, before this ships." Bead ids below are enumerated in [`sprint-10-multi-companion-beads.jsonl`](./sprint-10-multi-companion-beads.jsonl) (26 beads, epic `psfn-framework-s10mc` + `psfn-framework-vinz` children + future-idea beads).

The headline fact governing everything below: the multi-companion substrate is **code-complete** on `feat/multi-companion` @ `6608579f` (45 commits ahead of `main`), gated at every merge with build + lint + targeted vitest. It is **not yet validated** — no full runtime has booted the branch, because the implementation sandbox has no `.env` secrets and Docker there cannot publish ports. Code-complete and validated are different claims; §1 keeps them visually distinct, and closing that gap (`psfn-framework-s10f8`) is the first gate in §2.

## 0. 2026-07-12 update — decided priority order

Outcome of the 2026-07-12 triage + grilling session. Tracker was reconciled the
same day (13 beads closed with evidence, 2 stale claims demoted, a 90-bead
stale sweep validated 78 as real remaining work), the ICP epic
(`psfn-framework-s10mc.6`, plan: [`s10-icp-autonomy.md`](./s10-icp-autonomy.md))
was dependency-wired end to end, and the release path got tracker structure.
`bd ready` now surfaces the true entry points; the graph below is enforced by
`bd dep` edges, not just prose.

### 0.1 Operator decisions (recorded on the beads)

- **Room ontology** (on `s10rm`): group **text** channels = scrollback history,
  no presence/location gating. **Location-bound rooms** (Discord voice now,
  Unreal-world rooms later) are the only chat surfaces with location mapping:
  sender must be present to post (**close the sender-presence hole**, with a
  narrow stale-reply carve-out — may finish an active exchange, may not
  initiate absent), single occupancy (one room at a time, mirroring
  single-emanation), temporal-gated (miss it = miss that context). **ICP direct
  chat** is its own DM-like channel, location-FREE ("texting a friend while in
  a room with other people"). No companion↔companion Discord DMs.
- **Cluster-sibling trust** (on `s10mc.6`): same-cluster companions are
  MI-marked contacts with baseline trust one notch above default; fatigue fully
  applies; relationship level is earned or scenario-seeded on top of the floor.
  (This resolves the §3 "sibling-contact trust onboarding defaults" gap.)
- **Charter items ride the MC lane**: `z7qe.4` (brand CompanionId) now blocks
  `s10mc.1` + `s10mc.2`; `z7qe.1` (SQLite sweep) blocks `s10mc.2`. Rest of the
  charter-gap epic stays parked.
- **Completed feature branch**: `cam.1`–`cam.6` accounting capture,
  attribution, durable dashboard accounting, canonical analytics,
  charge-to-cost reconciliation, migration/certification, and `574y` operator
  accounting UX are complete and validated at implementation fixed point
  `271b6609` on the pushed `feat/cost-accounting` branch; the `cam` epic and all
  seven accepted-scope children are closed. The branch is not on `main` yet; its
  tracker dependency no longer blocks ICP `6.7` breaker or `6.9`
  certification. Other
  deliberately deferred work: `lpro` kube lane (operator
  reboot approval), `opl1` fleet SSO, `c337` workspaces, `0ggv.4` Artie link
  (hardware being assembled; ICP epic lands first). `w05a` experiment window
  closes 2026-07-20 and resurfaces its own decision beads.

### 0.2 Priority order

**Unblocked now (entry points):**

1. `s10mc.6.1` — ICP W1 contracts (heads the ICP chain)
2. `s10rm` — sender-presence gate + presence-windowed delivery remainder
   (blocks ICP `6.3` and `6.9`)
3. `z7qe.4` — brand CompanionId (blocks `s10mc.1`/`s10mc.2`)
4. `z7qe.1` — SQLite remnant sweep (blocks `s10mc.2`)
5. `s10f8` — full-runtime validation flag-off/flag-on (entry gate for deploy;
   one activity with the `s10mc.8` live demo)
6. Operator-only queue: `efc2` psfn-test preview review (committed
   ~2026-07-19), `kz0i`/`i698` morning live observations, `lpro.1` reboot.

**ICP chain (wired):** `6.1` → `6.2` broker ∥ `6.6` fatigue/social-charge →
`6.3` target-channel turns (← `s10rm`) → `6.4` tools → `6.5` source adapters →
`6.7` USD breaker (← closed `cam`; now ready) → `6.8` owner config/Garden → `6.9`
two-real-agent certification.

**MC substrate (parallel once charter items land):** `s10mc.1` (← `z7qe.4`),
`s10mc.2` flagship cutover (← `z7qe.4`, `z7qe.1`, and restore proof `s10d7` —
§2d hard gate unchanged), `s10mc.3` per-companion owners, `s10mc.8`/`s10f8`
live demo.

**Companion app lane (`w9hj`, second half of "app running solid"):** `u24q`
service-worker stale-shell fix and `8ora` first-class PWA channel are now
children of `w9hj`; `mmo9.1` SSE first-chunk fix rides in `mmo9` wave 1.
Satellite side: `343f` (empty satellite replies — first step is the
discriminating two-model live capture) blocks `6kr8` enrollment.

**Release path (new tracker structure):** `65rk` release-shakedown epic
(local dual + docker + kube variants, includes `mmo9.4` compaction-cliff and
Pi-class runs) → `wckv` setup/bootstrap docs epic → `upx0.1`/`.2`/`.3` →
`upx0.5` history rewrite → public flip. No committed date, by design.

### 0.3 Corrections to the 2026-07-08 text below

- §2c "W6 not started / last unbuilt workstream" is superseded: `s10mc.6` is
  now a nine-child epic with a full implementation plan
  ([`s10-icp-autonomy.md`](./s10-icp-autonomy.md)) and wired dependencies.
- The presence/locations branches (`mc/w5a-companion-presence`,
  `mc/vinz29-dual-presence`, `mc/vinz2021-presence-follow`) are **merged to
  main** — the locations threshold `s10mc` sequenced behind is met.
- 2026-07-12 audits confirmed still open on every branch: `u24q`, `mmo9.1`,
  `lghd` (unbounded re-prompt retry is intentional design, no bounded abort
  exists; stays P1 in the working set), `343f`. `sj4d` and `nw90` were fixed
  2026-07-09 and are closed.
- Live experience is good post-S9/S10; the binding constraint is follow-through
  on testing and the less-used surfaces, hence the shakedown epic.

### 0.4 2026-07-13 ICP implementation-wave status

The first four ICP workstreams are complete on the isolated
`feat/icp-autonomy` feature branch through `f864831a`: W1 contracts and durable
state (`s10mc.6.1`), W2 availability and the permit broker (`s10mc.6.2`), W3
target-channel initiation continuity (`s10mc.6.3`), and W4 semantic
contact/availability/notify tooling (`s10mc.6.4`). Each closed workstream was
validated locally and independently reviewed; the W4 fixed point passed 713
test files / 8,217 tests, build, lint, settings-contract, repository-hygiene,
and two independent reviews with no findings.

W6 fatigue and social-charge regulation (`s10mc.6.6`) is implemented at
`484072be` and hardened through `faae4fe5`. It extends the existing per-companion fatigue engine with decaying
relationship pressure, causal-root anti-reset across DMs/rooms/episodes,
progressive prompt-visible regulation, a real `companion_social` charge lane,
bounded closeout reserve, and zero-model suppression. A shared Postgres
reservation fence serializes the last charged/closeout slot across processes
and restarts while preserving each companion's directional choice; decline,
defer, and unanswered pressure decay continuously rather than resetting on a
calendar day. Review remediation replaced wall-clock pending-turn reclamation
with bounded Postgres session leases, added a durable `delivering` fence and
restart-safe recovery, rebased runtime decisions on the authoritative locked
snapshot before prompt assembly, and unified social surface cost with its
marginal charge. Final remediation also validates every observation-only
restart field before model, gateway, permit, or journal side effects and runs
validated private candidates through a production, capability-gated `notify`
scope that exists only for that candidate turn. Its end-to-end proof starts at
the dispatcher registered by `buildAgentControlPlane`, uses the real adaptive
tool runtime and scheduled tool loop, persists the deferred action, rechecks
live policy, and reaches the target-channel command without forced test tool
state or constant authorization. The `faae4fe5` fixed point passed build/DTS,
lint, settings-contract, repository-hygiene, Fallow, all seven Postgres
reservation integration tests, and the full suite (8,319 passed, 3 skipped).
Subsequent hardening (`d47d4057..72238bc8`) added candidate notify scope/turn
isolation, exclusive candidate-run reservation, and idle queue-ingress
ownership. Both required fresh independent reviews **passed** on the unchanged
code fixed point `72238bc8` (2026-07-13/14; see
`working_docs/w6-review-1-record.md` and `w6-review-2-record.md`). The
follow-up beads are resolved (2026-07-14): the full-suite `ENOENT
*.jsonl.write-lock` teardown failure (`psfn-framework-k510`) was root-caused to
detached subagent follow-up turns escaping `wait()`/`execute()` completion
tracking and fixed by draining outstanding turns before terminal (`a0b25eac`,
merged `1100b786`); the whisper-flush liveness gap (`psfn-framework-srr2`,
`986a55d3`) and queue-ingress hardening with dedicated primitive unit tests
(`psfn-framework-7eke`, `8d56ec5b`) landed with 13 new unit tests. The merged
tree passed two consecutive full normal-mode suites (722 files / 8,357 passed /
3 skipped, exit 0), lint, and build — the branch's first clean full-suite
exits. `.6.6` is closed.

W5 initiation sources (`s10mc.6.5`) is integrated with W6 at `2599c2f5` and
pushed to `origin/feat/icp-autonomy`. Final merged-seam validation at that hash
passed 32 focused test files / 609 tests, including the real Postgres autonomy,
fatigue-reservation, schema-tenancy, intention-lifecycle, and retry-lifecycle
integration suites; `npm run lint` and `npm run build` also passed. `.6.5` is
closed. Two timing edges from the final W5 review remain report-only
observations under the corrected severity standard, with no follow-up beads:
`retryEligibleAtMs` is derived before awaited durable transition/lifecycle work,
so a slow transition can shorten the effective cooldown; and expiry is not
rechecked after slow deferred-to-pending or pending-to-permitted transitions.

W7 conversation-scoped USD warning and runaway enforcement (`s10mc.6.7`) is
complete at integrated head `8e219b7c`. The implementation fixed point
`e65cec03` was independently reviewed; `3d05e68c` remediated descendant cost
correlation and `8e219b7c` added conservative prompt-cache preflight. Final
closeout passed 20 focused files / 466 tests, including 19 real-Postgres tests,
plus settings-contract, lint, ESM+DTS build, and diff checks. Remaining review
observations retain report-only disposition under the agreed severity standard;
they did not affect acceptance and created no follow-up beads.

W8 strict owner configuration, Garden controls, and explainable observability
(`s10mc.6.8`) is complete at integrated head `79e8e80c`. The implementation
line adds strict scheduler and charge-policy ownership, effective/on-disk and
restart-required reporting, bounded redacted projections, audited local
cancel/DND/emergency controls, safe permit invalidation, and the Garden
Autonomy page. Its one independent review found an IMPORTANT tenant/privacy
issue; `79e8e80c` remediates it by binding every projection to the local
companion and excluding unrelated peer-to-peer candidates, lifecycle rows,
costs, provenance, reasons, failures, and derived quiet/failure counts. The
integrated closeout passed 9 focused files / 86 tests, the 2 Garden autonomy
view tests, settings-contract, mandatory lint, root ESM+DTS build, Garden
production build, and diff checks. The inherited repository-hygiene fixture
finding (`psfn-framework-ecr5`) and Garden type-check diagnostics
(`psfn-framework-qz9e`) remain separately tracked; the optional canonical-policy
fallback observation remains report-only. No second review was performed.

This remains an implementation-wave checkpoint, not completion of the ICP epic
or release validation. W9 (`s10mc.6.9`) is now unblocked and ready for its
two-real-agent certification work. The parent `s10mc.6` remains open, and the
feature branch has not been merged into the release branch or exercised
against live infrastructure.

### 0.5 2026-07-14 accounting capture, attribution, dashboard, analytics, and reconciliation status

`psfn-framework-cam.1` is delivered on `feat/cost-accounting` at `56997ede`,
and `psfn-framework-cam.2` is delivered through implementation head
`9a3f57a1` (`61097e33..9a3f57a1`). `psfn-framework-cam.3` is delivered by
`43c76a32` and `825eef8c`. `psfn-framework-cam.4` is integrated and pushed at
`459e73dd` (`362b6c72..459e73dd`). `psfn-framework-cam.5` is implemented by
`8e12a69a`, `31c6594c`, and `073c21e7`, then integrated and pushed at
`38eb7933`. The `psfn-framework-574y` operator UX was implemented by
`74042506`, `702f4fdf`, `f179c6c0`, and `61113c49`; its one review finding was
remediated by `2d8ff2f0`. CAM.6 certification was implemented by `cbadbfbc` and
`42c8df52`; its single review findings were remediated by `271b6609`, which is
integrated and pushed as the final `feat/cost-accounting` head.
CAM.1 records immutable physical provider attempts with reconciled token and
cost economics. CAM.2 adds typed attribution, explicit unknown coverage,
strict filters and groups, indexed Postgres persistence, and fail-closed Garden
tenancy with explicit fleet aggregation. CAM.3 replaces the main dashboard's
in-memory cost samples with canonical Today/Week/Month Postgres queries,
complete call/token/cache/provider/estimated/effective totals, a 15-second
bounded poll, race-safe range switching, and explicit fresh/stale/unavailable
states while keeping live context-pressure and TTFT telemetry transient.
CAM.4 adds one tenant-scoped Postgres analytics grammar for named and strict
custom ranges, operator timezones and DST-aware gap-filled buckets, reconciled
totals/series/component economics, bounded one- or two-dimensional grouping,
stable sorting and cursor pagination, exact top-N plus Other, recent/expensive
events, and content-free CSV/JSON exports from the same filtered raw ledger.
Garden routes and the typed client are wired to that contract, and indexed raw
queries meet the documented year-scale target without rollups.
CAM.5 joins that immutable model-usage ledger to the original charge ledger
through typed exact charge-event and lineage correlation. Its operator-only
projection reports charge units alongside provider, estimated, and effective
cost; deterministic allocation and confidence; token/call mix; coverage; and
explicit attributable, charged-without-usage, usage-without-charge,
ambiguous/many-to-many, and non-model buckets. Retry attempts and nested
shard/subagent policy scopes conserve both source ledgers without double
counting, while the companion-facing charge-budget projection remains unit-only
and monetary-free.
The `574y` UX keeps the dashboard a concise durable summary and makes Charge /
Budget the analytical cockpit over the same CAM.4/CAM.5 APIs: named/custom
ranges, timezone-aware buckets, explicit token/cost components, accessible
graph tables, declared-dimension filtering/grouping/sorting/drill-down,
content-free authenticated export, charge-cost coverage/conservation, and
truthful loading/stale/error states. Accounting URL state survives Token Usage
↔ Charge Policy navigation, and dashboard analysis links carry the committed
Today/Week/Month range without introducing parallel accounting math or storage.
CAM.6 adds transactional real-Postgres migration certification with
backup-required apply, rollback fingerprints, idempotent reruns, explicit
known/inferred/unknown evidence, and non-USD quarantine. Its immutable
provider/call-path corpus reconciles raw attempts through totals, time series,
groups, dashboard, content-free export, and charge allocation across restart,
process, channel, companion, malformed-cost, and tenant-isolation boundaries.
Legacy provider or estimate claims with all monetary fields `NULL` remain
unknown; genuine priced controls remain known or inferred.

CAM.3 validation at `825eef8c`: focused dashboard backend/routes and the
Postgres-memory reachability smoke passed 4 files / 61 tests; the frontend
dashboard tests passed 11/11; the split Garden operator socket/mTLS/API and
model-usage reachability suite passed 17/17; and Docker-backed real local
PostgreSQL reconciliation passed 12/12, including separate writer/operator
processes, cross-process refresh, operator restart, and actual database
outage/recovery/stale-cache transitions. `npm run lint`, `npm run build`,
`npm --prefix admin-ui run build`, `npm run verify:model-usage-capture`, and
`git diff --check` passed. The proportional full suite passed 704 files / 7,742
tests, with only the same two inherited scheduler fixtures that omit
`minPartnerIdleMinutes` while the loader supplies the default `60`; both files
are outside the CAM.3 diff. `npm --prefix admin-ui run check` still reports the
seven pre-CAM.3 flat `ModelUsageEvent` reads in the unchanged Charge/Budget
renderer; that repair is tracked separately by open bead
`psfn-framework-at95`, not attributed to CAM.3.

CAM.4 final-check validation at integrated/pushed head `459e73dd`: focused
range/query/export/service/operator coverage passed 5 files / 50 tests;
Docker-backed real PostgreSQL analytics and benchmark coverage passed 2 files /
14 tests, including tenant isolation, DST buckets, totals/group reconciliation,
cursors, immutable component economics, export, and restart durability. The
3,650-event year benchmark completed the canonical analytics query in 126.56 ms
against the documented `<2000 ms` target. `npm run lint`, `npm run build`,
`npm run garden:build`, and `git diff --check` passed. Independent review passed
with no blocking findings under the accounting security/data-integrity/core-path
failure standard.

Report-only reviewer observations for CAM.4 (intentionally no follow-up beads):
the shared export-row type has minor routed-model-field/duplicate-declaration
hygiene; relative named-range cursors do not pin resolved boundaries across a
calendar rollover; the benchmark is intentionally low-density and its explicit
plan assertion is narrower than the full analytics fan-out; and exports ignore
display cursor/limit state while preserving the complete filtered ledger slice.
None affects tenant isolation, immutable accounting data, the shipped query
path, or mandatory lint/build gates.

CAM.5 final integrated regression at pushed head `38eb7933`: focused CAM.4
range/query/export plus CAM.5 reconciliation/API/operator coverage passed 13
files / 134 tests; Docker-backed real local PostgreSQL model-usage integration
passed 14/14, including restart durability, tenant isolation, analytics, charge
reconciliation, and explicit unknown attribution fallback. `npm run lint`,
`npm run build` (ESM+DTS), `npm run garden:build`, and `git diff --check` passed.
The single independent review returned PASS with no IMPORTANT findings. CAM.5
had no material report-only observations and intentionally created no follow-up
beads.

`574y` final integration/regression at pushed head `2d8ff2f0`: the single
independent review found one IMPORTANT URL-state defect, then the same reviewer
verified the regression-only remediation as PASS. Garden accounting/navigation
passed 12/12, dashboard navigation/state passed 12/12, canonical
query/reconciliation passed 27/27, authenticated operator query/export and
admin auth checks passed, and the privacy regression passed 17/17.
`svelte-check` reported 0 errors and 0 warnings; `npm run lint`, the core
ESM+DTS build, `npm run garden:build`, and `git diff --check` passed. The Garden
build continues to emit the unchanged Rollup `Unknown output options:
codeSplitting` warning; this is report-only, outside the accounting UX diff,
and intentionally has no follow-up bead from this closeout.

CAM.6 final integration/regression at pushed head `271b6609`: the single
independent review found one IMPORTANT accounting-evidence defect and one
mandatory lint-gate failure comprising two errors. The same reviewer verified
the bounded remediation as PASS without starting another review. The targeted
real-Postgres migration test passed 1/1; the full accounting certification
passed 4 files / 9 tests;
`npm run lint` exited 0; and `npm run build` passed ESM+DTS. The earlier
exact-image, provider-disabled local Artemis smoke passed durable API,
dashboard, export, charge/usage conservation, and tenant-denial checks without
external provider spend; it was not rerun during final integrated closeout.

This is whole-accounting completion on a pushed feature branch, not a `main`
merge claim. `psfn-framework-cam.1`–`.6`, `psfn-framework-574y`, and the parent
`psfn-framework-cam` epic are closed. The remaining failing gates observed
during certification are inherited, report-only for accounting, and remain on
their existing beads:

- `psfn-framework-r7tv` — scheduler owner-file round-trip drift for
  `minPartnerIdleMinutes`.
- `psfn-framework-l1qz` — identity-literal repository-hygiene findings.
- `psfn-framework-fgm4` — duplicated local record guards; `fgm4` is the actual
  tracker ID.
- `psfn-framework-dsd5` — stale local Artemis Helm bootstrap state for strict
  owner/auth contracts.

## 1. Where things stand

| Merge (→ `feat/multi-companion`) | Delivered | Status |
|---|---|---|
| `99ebd9c1` mc/w3-companions-config | `companions.json` owner file + `PSFN_MULTI_COMPANION` flag, fail-closed both directions (W3 phase 1, `s10mc.3`) | code-complete |
| `ee375e39` mc/w2-postgres-schemas | Schema-aware pools (`search_path` via libpq options), `COMPANION_PG_SCHEMA`, per-schema migration runner, `shared` schema chain (W2, `s10mc.2`) | code-complete, validated against a live Postgres in-sandbox |
| `bcca5c20` mc/w1-gateway-multiplexing | Companion-addressed gateway routing: `companionId` on identify/correlation, `Map<companionId, connection>`, fail-closed crossover with audit DENY + ntfy alarms, 23-test crossover suite (2 agents × 10 concurrent colliding-id requests) (W1, `s10mc.1`) | code-complete, unit/integration validated |
| `98e964eb` s10-location-foundations | Places registry (`places.json`), static satellite→place binding, situated-presence runtime context, room-entry system note — the locations-epic threshold multi-companion builds on | code-complete |
| `cf3dc9d1` mc/p2-supervisor-launcher | Multi-companion supervisor mode for the split launcher, spawns one agent process per `companions.json` entry | code-complete |
| `75abf583` mc/p2-per-companion-backups | Per-companion backup slices + `groupMode` cluster/group backups; schema-scoped `pg_dump` (part of W2, `s10mc.2`) | code-complete; `verify:backup-restore` green |
| `eda410a4` mc/p2-discord-per-companion | Per-companion Discord bot accounts (`channels.json` `discord.accounts[]` + `tokenRef`), per-account adapter instances, sibling-bot ingest, structurally-impossible cross-account egress | code-complete |
| `53033de6` mc/w5b-wiki-scopes | `personal` vs `shared_world:<siteId>` wiki scope, retrieval keyed off current site, direct shared-write rejection at the store chokepoint (W5b, part of `s10mc.5`) | code-complete |
| `ac389e5b` mc/w5a-companion-presence | Shared-schema `companion_presence` table (race-safe provisioning via advisory lock), co-presence in situated context, `presence.companion.co_located` event, 15-min TTL for crash ghosts (W5a, part of `s10mc.5`) | code-complete |
| `3df117e0` mc/p2-wiring-gaps | Fleet backup scheduling (leader-elected: first companion in `companions.json`) + presence heartbeat refresh | code-complete |
| `6608579f` mc/w4-gardens-fleet | Per-companion Gardens via the supervisor + gateway-served fleet-status page (`FLEET_STATUS_PORT`, loopback-only, read-only) (W4, `s10mc.4`) | code-complete |

Every row above is gated by build + lint + targeted vitest, not a booted process. Locations work continues past the `98e964eb` merge point on the user's side (`s10-loc-emanation`, `s10-loc-enrollment`/`-v2`, `s10-loc-durable-state`); convergence is pending (§2b). ~76 pre-existing test failures on `main` predate all of this and are independently confirmed (`s10f6`).

## 2. Critical path to "everything together"

In order — later steps assume earlier ones are done, except (b) and (a) can run concurrently once someone has a real machine:

**(a) Full-runtime validation, flag off then flag on** — `psfn-framework-s10f8`, **P1, entry gate for everything else**. On a machine with real credentials: boot flag-off and run `smoke:chat` + `e2e` to prove single-companion inertness in an actual process (ideally through the `psfn-live-ops` validation gate); then boot flag-on with a two-entry `companions.json` against a scratch Postgres, two Discord bots in one channel, and confirm routed delivery plus a fatigue-bounded MI↔MI exchange with zero crossover alarms. This also closes the spike bead `psfn-framework-s10mc.8`. Nothing below should be treated as "done" until this runs — every merge to date is test-gated, not runtime-gated.

**(b) Converge the remaining `s10-loc-*` branches** into `feat/multi-companion`. Locations work advanced past the `98e964eb` merge point independently (`s10-loc-emanation`, `s10-loc-enrollment`(-v2), `s10-loc-durable-state`). These touch the same seams multi-companion already extended (`places.json`, satellite binding, situated context) — merge conflicts are expected at the situated-presence and presence-registry layers, not just textual diff noise. Do this before further W5/W6 work lands, or the two lines of development re-diverge.

**(c) W6 — same-cluster inter-companion channels** (`psfn-framework-s10mc.6`) — the last unbuilt workstream. The building blocks are already in place: `presence.companion.co_located` fires from `companion_presence` (merged @ `ac389e5b`), the `ChannelAdapterPort` abstraction already treats a companion-to-companion channel as "just another channel," and `companion_room`/`quiet_companion_room` fatigue budgets already exist in `charge-policy.seed.json`. What's missing is the wiring: peer-as-contact (`isMachineIntelligence`, operator-assigned trust tier), the IPC one-to-one shape, the ad-hoc many-to-many room shape, and extending `two-companion-loop.test.ts` through the real channel path (not just the engine).

**(d) Flagship cutover off `public` schema + shard schema derivation** (remainder of `psfn-framework-s10mc.2`) — **hard gate: verify a restore round-trip of a real flagship snapshot first.** The cutover helper moves the flagship's live data out of the `public` schema into its own `companion_<uuid>` schema; doing that against production data without first proving restore works is the one step in this plan with irreversible-mistake risk. Restore build-out itself is tracked separately as `psfn-framework-s10d7` (deferred, but needed before (d) touches anything real) — sequence: prove restore on a copy, then cut over.

**(e) Presence-windowed private-room delivery** (remainder of `psfn-framework-s10rm`, locations-side). Entry-event system notes already merged (`144fb5c9` → `98e964eb`); what remains is delivering room chat only between join and exit for private/invite rooms (so L0 naturally holds only what was witnessed, no extraction-pipeline change needed), the group-chat exemption (public/group-marked channels see everything regardless of presence), and the who-related/privacy-level memory-tag tweaks.

**(f) Live two-companion demo** — closes `psfn-framework-s10mc.8` for real (crossover correctness is already proven under test load; this is the "watch it happen" milestone): two agent processes, one gateway, one hand-made shared room channel, a fatigue-bounded MI↔MI conversation observed on real infrastructure. This is naturally the same exercise as (a)'s flag-on half — treat them as one activity, not two.

## 3. Hardening before deploy

Gaps identified in a post-implementation review pass, not yet filed as blocking the critical path above but real before this fleet runs unattended:

- **Per-companion model-usage attribution is missing gateway-side.** The audit trail carries `companionId`; the model-usage/cost store does not. Without it, per-companion cost/usage reporting in the fleet view (`s10f7`) has no data to read.
- **Session Postgres adapters have zero tenancy** if a session store is ever used per-companion rather than per-process-isolated files — worth an explicit audit before anyone relies on it, since the general Postgres tenancy fix (`s10mc.2`) was schema-per-companion at the pool level, not per-table column tenancy, and session stores weren't in the original ~35-table gap list.
- **Scheduler thundering herd.** N companions on one process host means N × heartbeat/sleeptime timers with no jitter; `SleeptimeWikiPass` in particular runs nightly per companion and would fire in lockstep. Needs randomized jitter before a fleet size makes this visible.
- **Sibling-contact trust onboarding defaults.** Fleet siblings (companions on the same cluster) should get operator-assigned trust tiers at provisioning time in `companions.json`/`trust-policy.json`, not fall through to stranger-contact defaults on first sibling ingest.
- **MI attribution test gap for L0/L2 extraction in shared rooms.** Need a test proving sibling assertions in a shared room land in L0/L2 as ordinary speech (attributed to the peer), never silently promoted to facts — this is the same boundary the fold-review quarantine pattern exists for elsewhere in the codebase, but W6 (`s10mc.6`) doesn't yet have a test asserting it for the conversational path itself.
- **Security pass on new surfaces:** admin-socket permissions across N per-companion Gardens, ntfy alarm-flooding rate limits (the crossover-detection alarms are loud by design — good for a single incident, bad if a misconfiguration causes a storm), and the fleet-status listener's threat model (currently loopback-only by design, but the network-mode variant noted in `s10f7` needs its own review when it exists).
- **k8s/docker topology.** The supervisor launcher is a single-host dev shape (N processes, one host). k3s wants one agent container per companion; manifests are untouched by this sprint. Not blocking the current critical path, but blocking real multi-companion deploy.
- Plus the standing follow-up beads: `s10f1` (Discord voice has no per-account lane yet — voice fails closed under multi-companion today), `s10f3` (docs pass — `docs/operations.md`/`docs/setup.md` don't cover any of this yet), `s10f4` (Garden channel editor doesn't round-trip `companionId`/`accounts` fields, so an admin edit could silently drop routing), `s10f6` (the ~76 pre-existing `main` test failures — orthogonal to this sprint but mask real regressions on every branch), `s10f7` (fleet status page has no fatigue/charge posture column — the gateway has no cheap authority for it yet).

## 4. Post-sprint roadmap

In rough value order once the critical path (§2) and hardening (§3) are done:

1. **Deploy a second companion to k3s alongside the flagship** — the first real multi-companion deployment, proving the whole stack outside dev/sandbox conditions.
2. **Build the world** — populate `places.json` with real sites beyond the reference scenario, wire the MUD-over-Discord channels (`SPRINT_10_LOCATIONS.md` Workstream A3), seed the shared wiki with real world content.
3. **Wiki caretaker** (`psfn-framework-s10d5`) — detailed design of the dedup/rebalance/cleanup layer that currently ships as the minimal propose→approve flow; needed before the shared wiki scales past a handful of hand-approved entries.
4. **Per-companion trust/charge/capability-tier owners** — W3 phase 2 (temperament), the remainder of `psfn-framework-s10mc.3`: today only `companions.json` itself and backup `groupMode` are per-companion; trust-policy, charge-policy, capability-tier, and settings are still system-global singletons.
5. **Free-time world-wandering lanes** — companions visiting places and each other during idle/free-time budgets, using the co-location events and run-charge lane quotas already described in W6.
6. **Voice**: land `s10f1` (per-account Discord voice lane) first as the pragmatic unblock, then `s10d6` (the fuller voice subsystem rewrite — the Wyoming-based approach is explicitly flagged as likely non-final).
7. **Restore build-out** (`psfn-framework-s10d7`) — per-companion and group restore mirroring the one-to-one backup model; needed in full before the flagship cutover (§2d) touches production data, and independently useful before any real fleet operates unattended.
8. **Horizon** (all explicitly deferred, tracked as future-idea beads, not scoped into this sprint): cross-cluster ICP trust model (`s10d1`) → cognitive security firewall at the gateway (`s10d2`, blocks full rollout of `s10d1`) → management capability tier above autonomy (`s10d4`). Cross-cluster world-info sync (`s10d3`) sits alongside these, gated on the intra-cluster shared wiki + caretaker being proven first.

## 5. Bead index

| Bead | One-line status |
|---|---|
| `psfn-framework-s10mc` | Epic. Substrate code-complete through `6608579f`; open remainder: flagship cutover, shard schema derivation, per-companion trust/charge/tier owners, W6 |
| `psfn-framework-s10mc.1` | W1 gateway multiplexing — code-complete @ `bcca5c20` (+ per-account Discord @ `eda410a4`); remainder split into `s10f1`/`s10f2` |
| `psfn-framework-s10mc.2` | W2 Postgres tenancy — schema plumbing @ `ee375e39`, backups @ `75abf583`; **open**: flagship cutover off `public`, shard schema derivation |
| `psfn-framework-s10mc.3` | W3 config scoping — phase 1 (`companions.json` + flag) @ `99ebd9c1`, supervisor @ `cf3dc9d1`; **open**: per-companion trust/charge/tier/settings owners |
| `psfn-framework-s10mc.4` | W4 Gardens + fleet view — implemented @ `6608579f` per git log; bead notes/status not yet updated to reflect the merge |
| `psfn-framework-s10mc.5` | W5 location deltas — presence @ `ac389e5b`, wiki scopes @ `53033de6`; **open**: caretaker (`s10d5`), shared-schema chunk storage, world-tool `move` wiring (`s10wm`) |
| `psfn-framework-s10mc.6` | ICP autonomy epic — isolated feature branch is complete through W6 plus W5 initiation sources, integrated at `2599c2f5`; W7-W9 remain open; not merged to the release branch or live-tested |
| `psfn-framework-s10mc.6.5` | W5 initiation sources — **closed** 2026-07-14: integrated with W6 at `2599c2f5`; merged seam passed 32 focused files / 609 tests (including real Postgres integration), lint, and build |
| `psfn-framework-s10mc.6.6` | W6 fatigue/social regulation — **closed** 2026-07-14: both fresh reviews passed at `72238bc8`, follow-up beads fixed, two clean full-suite exits on the merged tree |
| `psfn-framework-s10mc.7` | W7 voice/satellite binding rules — **not started** |
| `psfn-framework-s10mc.8` | Spike — crossover correctness proven under test; **pending**: live two-process demo on real infra (§2f) |
| `psfn-framework-s10rm` | Room mechanics — entry-event note merged @ `98e964eb`; **open**: presence-windowed delivery, public-room semantics, memory-tag tweaks (§2e) |
| `psfn-framework-s10wm` | World-tool `move` must write presence through `CompanionPresenceTurnPort` — integration note for the locations epic, not yet built |
| `psfn-framework-s10d1` | Future-idea: cross-cluster direct companion communication trust model — deferred |
| `psfn-framework-s10d2` | Future-idea: cognitive security firewall at the gateway — deferred, blocks full `s10d1` rollout |
| `psfn-framework-s10d3` | Future-idea: cross-cluster shared world-info sync — deferred, gated on intra-cluster caretaker |
| `psfn-framework-s10d4` | Future-idea: management capability tier above autonomy — deferred |
| `psfn-framework-s10d5` | Future-idea: shared-wiki caretaker/meta layer detailed design — deferred |
| `psfn-framework-s10d6` | Future-idea: voice subsystem rewrite — deferred |
| `psfn-framework-s10d7` | Future-idea: restore functions build-out — deferred but hard-gates flagship cutover (§2d) |
| `psfn-framework-s10f1` | P2 open: Discord voice has no per-account lane, fails closed under multi-companion |
| `psfn-framework-s10f2` | P3 open: Telegram multi-account support, mirroring the Discord accounts shape |
| `psfn-framework-s10f3` | P2 open: docs pass — `docs/operations.md`/`docs/setup.md` don't cover multi-companion yet |
| `psfn-framework-s10f4` | P2 open: Garden channel editor doesn't round-trip `companionId`/`accounts` fields |
| `psfn-framework-s10f5` | P3 open: supervisor should thread per-companion Discord identity env, not one shared value |
| `psfn-framework-s10f6` | P2 open: ~76 pre-existing `main` test failures, independently confirmed as pre-existing |
| `psfn-framework-s10f7` | P2 open: fleet status page needs a fatigue/charge posture column |
| `psfn-framework-s10f8` | P1 open: full-runtime validation, flag-off then flag-on — entry gate for §2 |
