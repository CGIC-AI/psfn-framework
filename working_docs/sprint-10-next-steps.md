# Sprint 10 — Next Steps

Status: 2026-07-08; **§0 added 2026-07-12** (post-triage grilling session — decided priority order, operator decisions, and corrections), with the companion-app status, the CompanionId dependency status in §0.4, and the c337 workspace/restore branch status in §0.5 refreshed on 2026-07-13; **room-mechanics feature branch completed 2026-07-13** on `feat/room-mechanics` @ `a410a342` (review-approved). Where §0 and the older sections disagree, §0 wins. Companion doc to [`sprint-10-multi-companion.md`](./sprint-10-multi-companion.md) (the plan, v2) and [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (the locations plan). Those two answer "what are we building and why"; this one answers "what happens next, in what order, before this ships." Bead ids below are enumerated in [`sprint-10-multi-companion-beads.jsonl`](./sprint-10-multi-companion-beads.jsonl) (26 beads, epic `psfn-framework-s10mc` + `psfn-framework-vinz` children + future-idea beads).

The headline fact governing everything below: the multi-companion substrate is **code-complete** on `feat/multi-companion` @ `6608579f` (45 commits ahead of `main`), gated at every merge with build + lint + targeted vitest. It is **not yet validated** — no full runtime has booted the branch, because the implementation sandbox has no `.env` secrets and Docker there cannot publish ports. Code-complete and validated are different claims; §1 keeps them visually distinct, and closing that gap (`psfn-framework-s10f8`) is the first gate in §2.

## 2026-07-13 branch handoff — orphan/stub/bugfix lane

- Branch `fix/orphans-stubs-bugfixes`, pushed fixed point `3efa251c` (initial
  hygiene implementation `a81cdd49`).
- Closed `psfn-framework-jcic` and canonical identity-hygiene bead
  `psfn-framework-rbqo`; closed `psfn-framework-3d9r` as an exact duplicate of
  `rbqo`. The current orphan set was audited one bead at a time. A 2026-07-14
  reconciliation also closed `psfn-framework-mihm` (bounded fail-closed
  empty-argument retry/provenance shipped at `7243616b`) and
  `psfn-framework-i698` (settings-owned active timezone and Intl scheduler
  slots shipped at `80b14103`) instead of holding completed implementations
  open for later validation. The important non-Pi runtime verification left
  from `mihm` is now isolated as `psfn-framework-h7g9.1` under fix-wave epic
  `psfn-framework-h7g9`. `vinz.19`, `vinz.20`, `vinz.21`, `vinz.29`, and
  `7ang` remain genuinely open; `vinz.29` still lacks its formal twin mapping
  on the Garden surface, and `7ang` still has live feature children. Active
  ICP work was excluded.
- Validation: 69 focused tests passed; `npm run lint`, `npm run build`,
  `npm run verify:shared-type-guards`, `npm run verify:identity-literals`,
  `npm run verify:repository-hygiene`, and `git diff --check` passed. Separate
  standards and spec reviews both passed with no findings. No live host was
  contacted.
- Security follow-up `psfn-framework-upx0.8` is integrated and pushed at
  `e2fa8e3e`: `isStrictSubpath` now has one canonical hardened definition in
  `src/persistence/layout.ts`, used by artifact lifecycle and the surviving
  Research Library file boundaries. The different-root absolute-relative
  regression and normal-path coverage passed (24 focused non-SQLite tests),
  as did lint, build, and the independent final review.
- Companion-welfare follow-up `psfn-framework-upx0.7` is integrated and pushed
  at `eb11bf9e`: shard-sourced unified memory `action=write` is classified
  before the wrapped memory tool can execute and is staged in the existing
  durable fold-review flow with both core and shard companion identities. The
  independent review passed with no important findings; the final 135 focused
  tests, lint, and ESM+DTS build also passed. Report-only/no bead: the
  `SHARD_TO_PRIME_SYNC_OPERATIONS` entry and `allowed_shard_memory_write`
  reason name are stale and read as if direct writes remain allowed, but the
  policy denies the operation and tool sync fails closed if that policy ever
  unexpectedly permits it, so there is no current bypass.
- Credential-boundary follow-up `psfn-framework-upx0.6` is integrated and
  pushed at `eb5ba082` (implementation `73fb7646`, review remediation
  `8cdc6f5d`). The local split launcher now gives the agent a one-shot inherited
  descriptor instead of the raw Postgres DSN in its environment; kube/Helm
  agents receive only a Secret-mounted path; and `CoreSubstrateConfig` strips
  the credential before core construction. The single independent review's
  mandatory recovery-chart digest finding was remediated and its final check
  passed. Integrated validation passed 75 credential/startup tests, Helm and
  Kustomize deployment gates, startup/settings/repository-hygiene verifiers,
  lint, ESM+DTS build, and the prior shard/path regression sets. Report-only/no
  bead: explicitly setting projected Secret `defaultMode: 0440` would document
  least-privilege intent more clearly than relying on Kubernetes defaults plus
  pod `fsGroup: 999`; no current multi-user pod exposure was identified.
- Runtime-fallback provenance follow-up `psfn-framework-upx0.12` is integrated
  into `fix/orphans-stubs-bugfixes` and pushed at `5102b0ad` (implementation
  `42a4be0b`). Forced vision-failure and datetime-contradiction notices now
  retain explicit runtime-authored model/strategy provenance in response,
  session/L0, and durable turn-record metadata; ordinary model-authored replies
  remain untagged and existing consumers remain compatible. The single
  independent review passed with no important or material report-only findings.
  Final integrated validation passed all 75 focused tests, `npm run lint`, and
  the ESM+DTS build.
- Discord follow-up scheduling fix `psfn-framework-aoxt` is integrated into
  `fix/orphans-stubs-bugfixes` and pushed at `a92fa7e7` (implementation
  `491221e1`, review remediation `e7f18ba2`). The schedule tool exposes the
  canonical five continuity destinations as one enum, rejects `discord_text`
  without an alias, and preserves valid Discord DM/guild snowflake strings
  unchanged through the real scheduler path. The single independent review
  found numeric snowflakes could be precision-damaged by generic coercion; the
  remediation now rejects raw non-string Discord IDs before enqueue, and the
  same reviewer final check passed. Final integrated validation passed all 30
  focused schedule/tool-call tests, `npm run lint`, and the ESM+DTS build.
- Shard control-plane honesty fix `psfn-framework-upx0.10` is integrated at
  implementation fixed point `b3946dbd`. Model-facing catalogs and descriptions
  no longer advertise the unregistered shard tool; the duplicate subagent port,
  dead shard adapter/tool, and uncalled post-turn registration are removed.
  `SubagentFaculty` remains the sole model-facing subagent path, while
  `ShardExecutionPort` and Wyoming delegation remain wired. The single
  independent review passed with no IMPORTANT or material report-only findings.
  Final integrated validation passed 9 files / 127 tests, `npm run lint`, and
  the ESM+DTS build. Parent `psfn-framework-upx0` remains open.

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
- **Charter items ride the MC lane**: `z7qe.4` (brand CompanionId) was the type-
  safety prerequisite for `s10mc.1` + `s10mc.2` and is now code-complete and
  independently approved on `feat/companion-id-branding` (§0.4); closing it
  satisfies that dependency. `z7qe.1` (SQLite sweep) still blocks `s10mc.2`.
  Rest of the charter-gap epic stays parked.
- **Deliberately deferred**: `cam` cost-accounting review (accepted tail risk —
  it blocks only ICP `6.7` breaker + `6.9` cert), `lpro` kube lane (operator
  reboot approval), `opl1` fleet SSO, `0ggv.4` Artie link
  (hardware being assembled; ICP epic lands first). `w05a` experiment window
  closes 2026-07-20 and resurfaces its own decision beads.

### 0.2 Priority order

**Unblocked now (entry points):**

1. `s10mc.6.1` — ICP W1 contracts (heads the ICP chain)
2. `s10rm` — **feature branch complete and independently approved** @
   `a410a342`; sender-presence authorization, presence-windowed room delivery,
   and durable room/reply provenance are ready for the operator's later branch
   integration.
3. `z7qe.1` — SQLite remnant sweep (blocks `s10mc.2`)
4. `s10f8` — full-runtime validation flag-off/flag-on (entry gate for deploy;
   one activity with the `s10mc.8` live demo)
5. Operator-only queue: `efc2` psfn-test preview review (committed
   ~2026-07-19), `kz0i`/`i698` morning live observations, `lpro.1` reboot.

**ICP chain (wired):** `6.1` → `6.2` broker ∥ `6.6` fatigue/social-charge →
`6.3` target-channel turns (← `s10rm`) → `6.4` tools → `6.5` source adapters →
`6.7` USD breaker (← `cam`, deferred) → `6.8` owner config/Garden → `6.9`
two-real-agent certification.

**MC substrate (parallel once charter items land):** the `z7qe.4` dependency is
satisfied by the reviewed CompanionId branch (§0.4); `s10mc.1` is already
code-complete. `s10mc.2` flagship cutover remains blocked by `z7qe.1` and the
real-snapshot restore proof (§2d hard gate unchanged). `s10mc.3` per-companion owners
and the `s10mc.8`/`s10f8` live demo remain open.

**Companion app lane (`w9hj`, second half of "app running solid"):** `u24q`
service-worker stale-shell recovery is delivered and independently approved on
`feat/companion-app-solid` @ `b3da2ddf`, pending merge to `main`; `8ora`
first-class PWA channel remains a child of `w9hj`, and `mmo9.1` SSE first-chunk
fix rides in `mmo9` wave 1.
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
- `u24q` is delivered on `feat/companion-app-solid` through `b3da2ddf` and an
  independent review approved the branch with zero findings. Local Chromium
  validation exercised both required deploy paths: the actual legacy client
  moved from build A to B after one ordinary reload, and generated build A
  discovered B without discarding active form/attachment state before the
  operator reload; both paths then reloaded B offline. The focused service
  worker suite passed 8/8, Playwright passed 2/2, and companion-ui build and
  lint pass.
- The remaining audited working set is `mmo9.1`, `lghd` (unbounded re-prompt
  retry is intentional design, no bounded abort exists; stays P1), and `343f`.
  `sj4d` and `nw90` were fixed 2026-07-09 and are closed.
- `s10rm` is no longer unbuilt. The review-approved `feat/room-mechanics`
  branch closes the ordinary absent-sender injection hole, preserves only a
  one-shot recipient/channel-bound reply capability across the same stable
  presence epoch, and carries gateway-authoritative room place/privacy plus
  reply lineage through session, turn-record, and memory-extraction seams.
  Group text channels remain scrollback channels outside the location-room
  lane; public location rooms skip the private join-time cutoff, while private
  location rooms deliver only within the witnessed presence window.
- Live experience is good post-S9/S10; the binding constraint is follow-through
  on testing and the less-used surfaces, hence the shakedown epic.

### 0.4 CompanionId dependency completed (2026-07-13)

`psfn-framework-z7qe.4` is code-complete and independently approved on
`feat/companion-id-branding`. The three implementation/review snapshots are
`24711f4d`, `2dd81816`, and `d5878664`. The delivered contract includes distinct
branded core and shard identities, validating and nonthrowing constructors,
canonical preservation of both existing shard wire forms, branded gateway and
channel routing, fail-closed claimed-vs-bound enforcement, reverse voice routing
validation before ACK/state creation, and a negative compile-time fixture wired
into every production build. Persisted IDs and wire formats were not renamed.

Final branch evidence: 280/280 focused tests passed across gateway, channel,
presence, shard, and type-gate seams; `npm run verify:companion-id-types`,
`npm run build` (ESM + DTS), `npm run lint`, and `git diff --check` passed. The
final independent review approved `d5878664`. No live-runtime validation was
claimed or performed for this type-safety branch. The `z7qe.4` dependency is
therefore satisfied; the feature branch still requires the planned operator
merge/integration step before it is present on `feat/multi-companion` or `main`.

### 0.5 Fleet workspace isolation + restore branch (2026-07-13)

`psfn-framework-c337` is code-complete on `feat/fleet-workspace-isolation`,
including remediation of the independent acceptance review. The branch derives
one canonical Personal Workspace per companion, migrates a legacy workspace
only after explicit companion + tree-digest approval, provisions hash-manifested
no-overwrite Companion Library seeds, publishes shared artifacts through
separate proposer/CogSec/reviewer credentials and a crash-recoverable
transaction, and exposes only approved revisions to companions through a
read-only gateway surface. Shell interpreters remain disabled until an
OS-mediated filesystem sandbox exists. Generated-image storage and previews are
bound to the authenticated Personal Workspace, including symlink revalidation.

Fleet backups now carry each Personal Workspace, the Shared Companion Workspace,
or the whole workspace family in their matching companion/cluster/group scope.
Destination-aware Postgres restore helpers verify manifests, reject existing or
overlapping roots, and never combine those scopes. This completes the restore
implementation formerly tracked as `s10d7`; the separate hard gate in §2d is
still a restore rehearsal of a real flagship snapshot before any live schema
cutover.

Restore rollback ownership follow-up `psfn-framework-wprg` was integrated and
pushed on this branch at `078f7bfe` on 2026-07-14 (implementation `28dac423`).
The exact durable Postgres marker now remains present through database rollback
and durable cleanup of published and staged trees; absent or foreign markers do
not authorize filesystem or schema deletion. The single independent review
found one IMPORTANT gap: a fresh restore could delete a pre-existing
deterministic staging tree before authenticating ownership. Remediation
`078f7bfe` makes staging collisions fail closed, rechecks them after database
preflight, claims fresh staging atomically, and cleans only paths claimed by the
current invocation. Final regression evidence was 33/33 focused restore tests,
including three real-Postgres tests and the prior lost-response/SIGKILL paths;
`npm run lint`, `npm run build`, and `npm run verify:backup-restore` also passed.
`wprg` is closed.

Restore credential hardening follow-up `psfn-framework-5s70` was integrated and
pushed on this branch through merge `28c7cba4` on 2026-07-14 (implementation
`76635cd9` and `677b4cdd`; review remediation `4e555d92`). Restore and backup
subprocesses now reject unsupported libpq credential/indirect-auth channels,
remove ambient credential sources from child environments, and pass only the
explicitly approved URL password through `PGPASSWORD`. The single independent
review found one IMPORTANT diagnostic-redaction gap: lowercasing the whole URI
spelling leaked mixed-case percent-escape and form-encoded variants while it
could over-redact unrelated lowercase literals. Remediation preserves literal
case, varies only percent-escape hex case, independently covers `+` space form
encoding, and adds warning/wrapped-error regressions. Final regression evidence
was 77/77 focused connection/restore tests, including three real-Postgres tests;
`npm run lint`, `npm run build`, and `npm run verify:backup-restore` passed.
`5s70` is closed.

The combined `28c7cba4` integration matrix passed 127/127 connection, restore,
transaction, service, and fleet tests, including all three real-Postgres restore
integrations. `npm run lint`, `npm run build` (including DTS), and
`npm run verify:backup-restore` (`verified: true`) also passed. Both discovered
security children of `c337` are therefore closed and pushed. At that checkpoint,
parent `c337` remained open only because its explicit
`npm run verify:repository-hygiene` acceptance gate lacked the already-completed
identity-literal/shared-type-guard remediation from `a81cdd49`. The final
integration and closure are recorded below. The real flagship restore rehearsal
in §2d remains a separate live-cutover gate.

The 2026-07-14 tracker reconciliation reran the fixed point through pushed
commit `c16dd56d`: 434/434 focused
workspace-isolation/restore tests passed across 21 files, including all three
real-Postgres restore integrations; settings-contract verification, lint, the
ESM+DTS build, backup/restore verification (`verified: true`), dependency-cycle
verification, and branch diff checks passed. Commit `a81cdd49` was then applied
as exact stable-patch-equivalent cherry-pick `70068448`. The five directly
touched hygiene test files passed 69/69; identity-literal and shared-type-guard
regressions passed; full repository hygiene, lint, ESM+DTS build, and branch
diff checks passed. `psfn-framework-c337` is therefore closed at `70068448`.
No remaining IMPORTANT c337 implementation defect was found, so no empty fixes
epic was created. Live workspace/cutover proof is tracked separately by
validation bead `psfn-framework-g44z` and does not hold c337 open.

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

**(d) Flagship cutover off `public` schema + shard schema derivation** (remainder of `psfn-framework-s10mc.2`) — **hard gate: verify a restore round-trip of a real flagship snapshot first.** The cutover helper moves the flagship's live data out of the `public` schema into its own `companion_<uuid>` schema; doing that against production data without first proving restore works is the one step in this plan with irreversible-mistake risk. Restore functions are code-complete on `feat/fleet-workspace-isolation` (§0.5), but that is not the real-data proof: merge the branch, restore a flagship snapshot into a disposable Postgres + destination tree, verify it, then cut over.

**(e) Presence-windowed location-room delivery** (`psfn-framework-s10rm`) — **feature branch complete; pending operator integration into `main`.** Entry-event system notes remain merged on `main` (`144fb5c9` → `98e964eb`), and the delivery foundation is at `47dbf683`. The final branch commits (`f7d5d55c`, `d9593b22`, `a410a342`) require a fresh sender presence for ordinary location-room posts; permit only one gateway-verified reply bound to the exact recipient, channel, receipt lifetime, and stable presence epoch; reject forged, expired, reused, moved, or post-leave lineage; persist authoritative room place/privacy and reply provenance into L0/TurnRecord/extraction; and preserve public/group-text semantics without applying the private join-time cutoff. Validation on the final branch: focused gateway/extraction 47/47, affected runtime/session/extraction 280/280, real two-companion loop lane 3/3, build and lint pass, and full Vitest 7,642 passed / 3 skipped with only the two pre-existing scheduler fixture drifts (`minPartnerIdleMinutes`) failing. Final independent review approved `a410a342`.

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
7. **Restore rehearsal** — merge the destination-aware restore functions from `feat/fleet-workspace-isolation`, then prove a real flagship snapshot round-trip on disposable Postgres and filesystem destinations before the cutover in §2d.
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
| `psfn-framework-s10mc.6` | W6 inter-companion communication — **not started**, last unbuilt workstream (§2c) |
| `psfn-framework-s10mc.7` | W7 voice/satellite binding rules — **not started** |
| `psfn-framework-s10mc.8` | Spike — crossover correctness proven under test; **pending**: live two-process demo on real infra (§2f) |
| `psfn-framework-s10rm` | Room mechanics — feature branch complete and independently approved (`f7d5d55c` + `d9593b22` + `a410a342`); bead closed 2026-07-13 with build/lint and room/DM lifecycle evidence; branch pending operator merge to `main` (§2e) |
| `psfn-framework-s10wm` | World-tool `move` must write presence through `CompanionPresenceTurnPort` — integration note for the locations epic, not yet built |
| `psfn-framework-s10d1` | Future-idea: cross-cluster direct companion communication trust model — deferred |
| `psfn-framework-s10d2` | Future-idea: cognitive security firewall at the gateway — deferred, blocks full `s10d1` rollout |
| `psfn-framework-s10d3` | Future-idea: cross-cluster shared world-info sync — deferred, gated on intra-cluster caretaker |
| `psfn-framework-s10d4` | Future-idea: management capability tier above autonomy — deferred |
| `psfn-framework-s10d5` | Future-idea: shared-wiki caretaker/meta layer detailed design — deferred |
| `psfn-framework-s10d6` | Future-idea: voice subsystem rewrite — deferred |
| `psfn-framework-c337` | Personal/Shared Workspace isolation + governed publication + seed/migration/preview containment — closed on `feat/fleet-workspace-isolation` @ `70068448`; both restore-security children are closed; final evidence includes 434/434 focused isolation/restore tests, 69/69 hygiene regressions, settings, full repository hygiene, lint, ESM+DTS build, backup verification, and diff checks (§0.5) |
| `psfn-framework-wprg` | Restore rollback ownership — integrated, independently reviewed, remediated, final-check approved, and closed @ `078f7bfe` (§0.5) |
| `psfn-framework-5s70` | Restore credential-channel hardening — integrated, independently reviewed, remediated, combined-check approved, and closed through merge `28c7cba4` (§0.5) |
| `psfn-framework-g44z` | Separate live validation: lossless Personal Workspace migration, cross-Garden isolation proof using the existing Carlini leak corpus, and disposable real-flagship restore rehearsal before cutover; does not block c337 |
| `psfn-framework-s10d7` | Fleet restore functions — verified shipped with c337 and closed; real flagship restore rehearsal is tracked by `psfn-framework-g44z` and still hard-gates cutover (§2d) |
| `psfn-framework-s10f1` | P2 open: Discord voice has no per-account lane, fails closed under multi-companion |
| `psfn-framework-s10f2` | P3 open: Telegram multi-account support, mirroring the Discord accounts shape |
| `psfn-framework-s10f3` | P2 open: docs pass — `docs/operations.md`/`docs/setup.md` don't cover multi-companion yet |
| `psfn-framework-s10f4` | P2 open: Garden channel editor doesn't round-trip `companionId`/`accounts` fields |
| `psfn-framework-s10f5` | P3 open: supervisor should thread per-companion Discord identity env, not one shared value |
| `psfn-framework-s10f6` | P2 open: ~76 pre-existing `main` test failures, independently confirmed as pre-existing |
| `psfn-framework-s10f7` | P2 open: fleet status page needs a fatigue/charge posture column |
| `psfn-framework-s10f8` | P1 open: full-runtime validation, flag-off then flag-on — entry gate for §2 |
| `psfn-framework-z7qe.4` | CompanionId branding — code-complete and independently approved on `feat/companion-id-branding` @ `d5878664`; dependency satisfied, pending operator merge/integration |
