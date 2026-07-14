# Sprint 10 — Next Steps

Status: 2026-07-08; **§0 added 2026-07-12** (post-triage grilling session — decided priority order, operator decisions, and corrections; where §0 and the older sections disagree, §0 wins). Companion doc to [`sprint-10-multi-companion.md`](./sprint-10-multi-companion.md) (the plan, v2) and [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (the locations plan). Those two answer "what are we building and why"; this one answers "what happens next, in what order, before this ships." Bead ids below are enumerated in [`sprint-10-multi-companion-beads.jsonl`](./sprint-10-multi-companion-beads.jsonl) (26 beads, epic `psfn-framework-s10mc` + `psfn-framework-vinz` children + future-idea beads).

The headline fact governing everything below: the multi-companion substrate is **code-complete** on `feat/multi-companion` @ `6608579f` (45 commits ahead of `main`), gated at every merge with build + lint + targeted vitest. It is **not yet validated** — no full runtime has booted the branch, because the implementation sandbox has no `.env` secrets and Docker there cannot publish ports. Code-complete and validated are different claims; §1 keeps them visually distinct, and closing that gap (`psfn-framework-s10f8`) is the first gate in §2.

## 2026-07-13 branch handoff — orphan/stub/bugfix lane

- Branch `fix/orphans-stubs-bugfixes`, implementation commit `a81cdd49`.
- Closed `psfn-framework-jcic` and canonical identity-hygiene bead
  `psfn-framework-rbqo`; closed `psfn-framework-3d9r` as an exact duplicate of
  `rbqo`. The current orphan set was audited one bead at a time; `mihm`,
  `vinz.19`, `vinz.20`, `vinz.21`, `vinz.29`, `i698`, and `7ang` remain open
  with evidence comments because their acceptance is incomplete or still
  requires operator/live validation. Active ICP work was excluded.
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
- **Deliberately deferred**: `cam` cost-accounting review (accepted tail risk —
  it blocks only ICP `6.7` breaker + `6.9` cert), `lpro` kube lane (operator
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
`6.7` USD breaker (← `cam`, deferred) → `6.8` owner config/Garden → `6.9`
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
| `psfn-framework-s10mc.6` | W6 inter-companion communication — **not started**, last unbuilt workstream (§2c) |
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
