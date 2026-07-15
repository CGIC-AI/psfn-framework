# Sprint 10 — Next Steps

Status: 2026-07-08; **§0 added 2026-07-12** (post-triage grilling session — decided priority order, operator decisions, and corrections), with the companion-app, CompanionId, workspace/restore, room-mechanics, accounting, introspection-landmarks, Garden WAN-performance, ICP-autonomy, fleet-efficiency, and public-release-hardening feature status refreshed through 2026-07-15. Where §0 and the older sections disagree, §0 wins. Companion doc to [`sprint-10-multi-companion.md`](./sprint-10-multi-companion.md) (the plan, v2) and [`SPRINT_10_LOCATIONS.md`](./SPRINT_10_LOCATIONS.md) (the locations plan). Those two answer "what are we building and why"; this one answers "what happens next, in what order, before this ships." Bead ids below are enumerated in [`sprint-10-multi-companion-beads.jsonl`](./sprint-10-multi-companion-beads.jsonl) (26 beads, epic `psfn-framework-s10mc` + `psfn-framework-vinz` children + future-idea beads).

The headline fact governing everything below: the multi-companion substrate is **code-complete** on `feat/multi-companion` @ `6608579f` (45 commits ahead of `main`), gated at every merge with build + lint + targeted vitest. It is **not yet validated** — no full runtime has booted the branch, because the implementation sandbox has no `.env` secrets and Docker there cannot publish ports. Code-complete and validated are different claims; §1 keeps them visually distinct, and closing that gap (`psfn-framework-s10f8`) is the first gate in §2.

## Feature branch status — 2026-07-14

- `feat/public-release-hardening`: `psfn-framework-upx0.3` is closed at implementation tip `fd817576` (`60fddadd` implementation plus `fd817576` review remediation). The final integrated gate passed 20 focused offline tests, `verify:public-sanitize`, Helm verification, four shell syntax checks, lint, proportional systemd parsing, and exact tracked-fingerprint greps. The branch is pushed but intentionally unmerged; parent epic `psfn-framework-upx0` remains open.
- Report-only, non-blocking observations: the pre-existing repository-hygiene identity-allowlist backlog remains outside this bead; the completed review also noted lesser CIDR-pattern coverage and private config-locality considerations. These did not affect the core public-sanitization acceptance criteria and were not escalated into another review loop.

## 2026-07-14 feature status — `feat/fleet-efficiency`

- `psfn-framework-2z12.2` is closed at `0b741e01` (implementation `af9f4a33`,
  bounded remediation `0b741e01`). Clean session appends now use a cached archive
  fingerprint instead of rescanning the full journal; stale/unknown fingerprints
  still take the lock-scoped full reconciliation path.
- The remediation preserves exactly-once HMAC append semantics after a transient
  post-commit fingerprint fault, invalidates the cache for the next write, and
  keeps a missing archive fail-closed.
- Final integrated gate: focused session suites 79/79, lint, ESM+DTS build, and
  diff check all passed. The branch is pushed for backup and remains unmerged;
  parent epic `psfn-framework-2z12` remains open for its other children.
- `psfn-framework-2z12.5` is closed at `5dbc011b` (implementation `0dd8e7c6`,
  bounded review remediation `5dbc011b`). PostgreSQL transcript projection boot
  now retains aggregate count/max metadata per channel instead of every message
  ID, and clean writes skip the no-op drift-row delete while tracked drift still
  clears normally.
- The independent review found queued insert/delete reconciliation could overwrite
  newer replacement metadata. Per-channel epochs now discard superseded
  reconciliation, with insert-gap-before-replace and missing-delete-before-replace
  regressions proving cached counts match persisted replacement IDs.
- Final integrated gate for `2z12.5`: projection/repair 15/15, store/journal
  79/79, lint, ESM+DTS build, and worktree plus branch-range diff checks passed.
- Material report-only observations: none.
- `psfn-framework-2z12.8` is closed on integration merge `816253b7`
  (memory implementation `f4d8f8f9`, guideline implementation `a86da443`,
  bounded review remediation `8ae54b72`). Unchanged PostgreSQL decay cycles
  now skip store/DB scans until the next meaningful exponential-curve threshold,
  while memory mutations wake the loop; unchanged guideline cycles skip both
  file reads and model calls until a new failure is appended.
- The single independent review found that reconstructing decay state could
  double-apply the already-persisted interval after restart. The bounded
  remediation preserves a restart decay epoch and pins both no-discontinuity
  and next-day exponential continuation. Generic/non-signaling eager behavior,
  half-lives, and guideline semantics remain unchanged.
- Final integrated gate for `2z12.8`: memory/guideline/restart 51/51 plus merged
  projection/repair 15/15, lint, ESM+DTS build, and worktree plus branch-range
  diff checks passed. The known full-suite dependency on the untracked
  `<companion>/satellites.json` owner file remains report-only; no rerun was
  needed for this bounded closeout.
- `psfn-framework-2z12.7` is closed on integration merge `05ec2557`
  (implementations `d311f9e0`, `a8561fe7`, `5d73270b`, and `ad0c37cc`; bounded
  review remediation `75dc46aa`). Successfully screened inline images are now
  retained behind opaque connection-local handles so the main-model call crosses
  the gateway transport once on a retention hit. Screening/main behavior is
  unchanged; retention is connection-, companion-, and turn-scoped with a 60s
  TTL, entry/byte caps, disconnect/stop cleanup, exact-byte one-shot resend on a
  miss, an unchanged URL-image path, and exact serialized transport counters.
- The single independent review found two important issues: idle connections did
  not physically prune expired partner bytes, and the gateway wire union omitted
  `gateway_image_ref`. The bounded remediation added proactive unref'd expiry and
  shutdown cleanup with regression coverage, and made the wire contract explicit.
- Final integrated gate for `2z12.7`: image/privacy/transport 192/192 plus merged
  gateway/server regressions 53/53, lint, ESM+DTS build, and worktree plus
  branch-range diff checks passed. Material remaining image observations: none.
- `psfn-framework-2z12.6` is closed on integration head `96c5ef34`
  (active-refresh implementation `c30b3afe`, shared-query-embedding implementation
  `0a6114c7`, bounded review remediation `96c5ef34`). Unchanged active-memory
  refreshes now reuse the byte-identical snapshot without a new embed, vector
  scan, or compositional rerank, and each turn can share one provenance-checked
  query embedding between memory and wiki retrieval.
- The single independent review found that cache identity omitted mutable
  disclosure/room-visibility inputs and that a PostgreSQL rollback could rewind
  the retrieval generation. The bounded remediation fingerprints the normalized
  access-policy snapshot, disables reuse when that snapshot is unsafe, clears
  retained context after access withdrawal, and keeps rollback generations
  monotonic while preventing uncommitted retrieval snapshots. Evidence lives in
  `src/faculties/memory/retrieval.ts`, `src/faculties/memory/postgres-store.ts`,
  `src/shared/retrieval-query-embedding.ts`, and their focused regressions.
- Final integrated gate for `2z12.6`: retrieval/cache/wiki/PostgreSQL 76/76,
  memory-port/trust-policy support 87/87, lint, ESM+DTS build, and worktree plus
  branch-range diff checks passed. The parent epic `psfn-framework-2z12` remains
  open for its other children.
- `psfn-framework-2z12.10` is closed on integration merge `65c79e38`
  (implementation `4c70daac`, bounded review remediation `4acbd9b1`). Salience
  decay now runs on its own scheduler-owned `salienceDecayIntervalMs` key
  defaulting to hourly (previously a 60s-seeded key aliased with
  `maintenanceIntervalMs`), the compaction-guideline review rides the gated
  heartbeat lane instead of the decay key, and retrieval computes decay lazily
  so scoring is cadence-independent. Seed, runtime-config contract, owner-file
  settings contract, Garden admin UI, and docs moved in the same change.
- Both independent adversarial reviews (Opus and Pi, blind to each other)
  converged on one verified blocker: retrieval re-applied exponential decay on
  top of sweep-persisted already-decayed salience (squared decay; a one-half-life
  memory scored 0.25 instead of 0.5). The bounded remediation adds a dedicated
  `salience_decay_anchor_at` column persisted atomically with swept salience in
  both stores (legacy rows backfill from `last_accessed`), makes retrieval decay
  only the residual since the anchor, routes duplicate reinforcement through
  effective salience, and pins the gap with sweep-then-retrieve and 120-day
  aged-memory regressions that the original tests could not see.
- Final integrated gate for `2z12.10`: memory/scheduler/config/settings
  focused suites 378/378, real-PostgreSQL store integration 6/6 (new anchor
  column exercised against a live database), lint, and ESM+DTS build passed on
  the integrated branch.
- `psfn-framework-2z12.3` is closed on integration merge `215d028b`
  (implementation `4d8807e1`). Idle keepalive now uses authenticated
  transport heartbeats instead of an audited `discord.typing` RPC; real typing
  remains audited and missing acknowledgements still close the connection.
  Its single two-axis review passed without findings. Worker evidence was 178
  targeted tests plus lint/build; the combined final gate below supersedes it.
- `psfn-framework-2z12.9` is closed on integration merge `94234eab`
  (implementation `642fcbd4`, single remediation `39a36a16`). The narrowed
  six-item sweep landed recoverable directory caching, coherent archive
  fingerprints, exact token-count reuse, chain-index boot fingerprints,
  disk-load-only settings logging, and strict binary voice audio frames.
  Sampling extraction was explicitly rejected because this branch has no
  owner/config authority for that decision. The one important review finding
  was a derived-index channel-id isolation hole; canonical journal identity is
  now authoritative. Lesser fingerprint/test/voice-order observations remain
  report-only.
- `psfn-framework-2z12.4` is closed on merge `7ce11bd8` plus integration repair
  `0985c297` (implementation `0964f4ad`, single remediation `183e375a`). The
  validated 16 MiB turn-boundary rotation is integrated and general range,
  compaction-summary, tombstoned recent, and tombstoned turn-record reads are
  segment/byte bounded while preserving exact redaction. The one review found
  two valid blockers: unverified leading rows could be treated as empty, and
  unsigned index tombstone IDs could weaken partner-data redaction. Canonical
  fallback and journal-authoritative tombstones now fail closed. Legacy
  Garden/`t5z7.2` scope was explicitly cut from this lane; no Garden branch was
  merged or resurrected.
- Final integrated gate at pushed `feat/fleet-efficiency` head `0985c297`:
  session/journal/repair 182/182, gateway/small-wins 288/288, lint, ESM+DTS
  build, and diff check passed. The branch is clean and origin-equal.
- Final tracker classification for the original nine-child wave: **9/9 closed**.
  Three newer scheduler-census children (`2z12.10`-`.12`) were subsequently
  attached and are not part of that original-wave ratio; `.10` is also closed.
  `2z12.1` operational enablement/soak/pricing proof remains separately owned by
  top-level validation bead `9hyv`. The parent epic remains open only for real
  newer children/validation, not for the completed original wave.

## 2026-07-14 feature status — `feat/garden-wan-performance`

- `psfn-framework-t5z7.2` is closed at `4b22e676` (bounded archive reader
  `2b0bc87b`, Garden `beforeId` adoption `689f7cfc`, single-review remediation
  `4b22e676`). Older-message pages now seek to the requested cursor without a
  full channel replay, and select among numbered sealed segments without
  linearly opening every newer sibling. The existing pagination API and
  optional-Redis behavior are unchanged.
- The one independent review found mandatory integrity, bounded-IO,
  cross-process tombstone-privacy, segmented-authority, and lint gaps. The one
  allowed remediation made cursor skip authority HMAC-verified, refreshed the
  fingerprint-gated tombstone index before bounded reads, and made canonical
  replay, metadata, tails, quarantine, fingerprints, and rewrites agree on the
  same logical segmented archive. Final integrated gate at `4b22e676`: six
  exact regressions passed, the proportional journal/session/Garden slice
  passed 137/137, lint passed, root ESM+DTS build passed, and diff checks were
  clean. Parent epic `psfn-framework-t5z7` remains open because `.9` and `.10`
  remain real work.
- `psfn-framework-t5z7.5` is closed through `b2af5296` (server-cache
  implementation `2ff153c0`, single-review remediation `77d2d825`, integration
  merge `9dbc59d0`, pagination-seam test alignment `b2af5296`). The hot newest
  transcript page now reuses the deployment/companion-scoped shared Redis tail
  while authenticated journal rows remain authoritative on every ID overlap.
  A current bounded canonical window rejects and repopulates cross-process
  tails that lag a durable append; Redis-disabled, degraded-cache, older-page,
  and namespace-isolation behavior remain intact. Recent activity and session
  lists were already slim channel-index reads, so no redundant cache was added.
- The one independent review found two important partner-data issues: an
  unauthenticated same-ID tail row could override journal content/channel, and
  the freshness checkpoint was process-local. The one allowed remediation made
  journal truth win and added the exact blocked-writer/two-store freshness
  proof. Final integrated gate at `b2af5296`: both exact regressions passed,
  the combined server-cache/journal/session slice passed 95/95, lint passed,
  root ESM+DTS build passed, and diff checks were clean. Parent epic
  `psfn-framework-t5z7` remains open only for `.9` and `.10`.
- `psfn-framework-t5z7.4` is closed at `af553dc0` (server/API slice
  `118890bd`, client/UI slice `af553dc0`). The sessions index is now one
  contact-free request carrying only bounded channel/session identity,
  activity, and counts; `listSessionRoutes` no longer recursively calls
  `listSessions`.
- Contact linkage resolves only after the operator selects one session, through
  a focused detail endpoint that exposes the prior id/display-name fields but
  not contact notes, trust, relationship, or privacy data. Repeat SPA navigation
  paints the Garden-session cache immediately and performs one conditional
  ETag-compatible revalidation; selection detail survives list refreshes.
- The single independent review passed at fixed point `af553dc0` with no
  important findings and no remediation. Final integrated gate: service/routes
  27/27, admin endpoint/client/loader 17/17, Garden build, root ESM+DTS build,
  lint, and worktree plus branch-range diff checks passed. The two known,
  untouched prompt-monitor Svelte diagnostics remain report-only. Parent epic
  `psfn-framework-t5z7` remains open for its other children.
- `psfn-framework-t5z7.8` is closed at `582f3160` (bounded JSONL/memo slice
  `47626be8`, list/detail API and explicit-click Garden UI slice `1165cfba`,
  independent-review remediation `582f3160`). Garden audit history now reads a
  bounded 16 MiB/2,000-entry tail, memoizes unchanged file identities, and
  fails closed when the file changes during a read. List responses omit raw
  source blobs and internal record IDs; authenticated no-store detail resolves
  raw data only after an explicit operator click.
- The single independent review at `1165cfba` found three important privacy and
  consistency issues. The one allowed remediation replaced predictable hashes
  with companion-bound HMAC opaque IDs backed by the canonical session-HMAC
  keyring, sanitized gateway error text in list-visible data, and made list and
  detail use the same bounded unfiltered source window before local filtering.
  Final integrated gate at `582f3160`: server/service/routes 33/33, Garden
  endpoint 2/2, lint, Garden build, root ESM+DTS build, and worktree plus
  branch-range diff checks passed. The inherited, untouched diagnostics at
  `admin-ui/src/lib/events/prompt-monitor.ts:336` and
  `admin-ui/src/lib/events/prompt-monitor.test.ts:260` remain report-only.
  Parent epic `psfn-framework-t5z7` remains open for its other children.
- `psfn-framework-t5z7.7` is closed through `c22a1cea` (shared visibility and
  websocket queue controllers `edc50e4b`, polling-page adoption `2a9150e2`,
  gateway signal scoping `5042ae25`, reconnect and subsystem-health remediation
  `c22a1cea`). Hidden Garden tabs now make zero network poll requests; becoming
  visible performs one immediate refresh and resumes the fallback interval.
  Confirmation, contact-approval, graph-proposal, and CogSec approval pages use
  content-free websocket invalidations while connected and visibility-aware
  fallback polling while disconnected. Local-only shards and telemetry clocks
  remain local intervals.
- The single independent review at `2a9150e2` found four important freshness
  and multi-companion issues. The one allowed remediation pinned confirmation
  and gateway queue signals to the authenticated healthy companion, emitted
  intake-quarantine hints only after durable text/image holds, made a
  websocket false-to-true reconnect perform exactly one visibility-gated
  refresh with no fallback timer left behind, and moved subsystem health onto
  the shared visibility poller. Final integrated gate at `c22a1cea`: gateway
  signaling and quarantine tests 130/130, Garden poller/adoption tests 17/17,
  root ESM+DTS build, Garden build, lint, and worktree plus branch-range diff
  checks passed. Garden's inherited `codeSplitting` warnings and the untouched
  prompt-monitor diagnostics remain report-only. Parent epic
  `psfn-framework-t5z7` remains open for its other children.
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
  satisfies that dependency. `z7qe.2` (introspection landmarks) is also complete
  and closed on its pushed feature branch (§0.7). `z7qe.1` (SQLite sweep) still
  blocks `s10mc.2`. Rest of the charter-gap epic stays parked for genuine
  children `z7qe.1`, `.3`, and `.5`-`.9`.
- **Completed feature branch**: `cam.1`–`cam.6` accounting capture,
  attribution, durable dashboard accounting, canonical analytics,
  charge-to-cost reconciliation, migration/certification, and `574y` operator
  accounting UX are complete and validated at implementation fixed point
  `271b6609` on the pushed `feat/cost-accounting` branch (§0.6); the `cam` epic
  and all seven accepted-scope children are closed, and its tracker dependency
  no longer blocks ICP `6.7` breaker or `6.9` certification.
- **Deliberately deferred**: `lpro` kube lane (operator
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
4. `z7qe.3`, `.5`-`.9` — remaining charter-gap children; see their live bead
   acceptance rather than treating the epic as parked
5. `s10f8` — full-runtime validation flag-off/flag-on (entry gate for deploy;
   one activity with the `s10mc.8` live demo)
5. Operator-only queue: `efc2` psfn-test preview review (committed
   ~2026-07-19), `kz0i`/`i698` morning live observations, `lpro.1` reboot.

**ICP chain (wired):** `6.1` → `6.2` broker ∥ `6.6` fatigue/social-charge →
`6.3` target-channel turns (← `s10rm`) → `6.4` tools → `6.5` source adapters →
`6.7` USD breaker (← closed `cam`; now ready) → `6.8` owner config/Garden → `6.9`
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

- The earlier §2c status is superseded: `s10mc.6` is now a completed
  nine-child epic, with the implementation and
  certification trail recorded in
  [`s10-icp-autonomy.md`](./s10-icp-autonomy.md) and the tracker.
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

### ICP implementation-wave status (2026-07-14)

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

W9 (`s10mc.6.9`) and the parent ICP autonomy epic (`s10mc.6`) are closed on
`feat/icp-autonomy` after final integrated verification at `d8dd6ba4`. The
certification run passed 10 real-process cases plus 2 fixture cases, covering
autonomous initiation, deterministic no-LLM gates, private-room windows,
schema-local extraction and trust, compaction and both-agent restart, causal
fatigue/reserve suppression, fleet-scoped warning and hard cost stops,
delivery failure/retry and duplicate collapse, adversarial rollback, and
feature-off single-companion parity. The proportional combined affected
surface passed 12 files / 346 tests; settings-contract, mandatory lint,
ESM+DTS build, backup/restore, and reachability checks also passed. The known
public-sanitize fixtures tracked by `psfn-framework-ecr5`, six non-core
identity-literal findings, and one certification EOF whitespace finding were
operator-classified report-only. All nine direct children are closed with
evidence. The feature branch is still intentionally unmerged to the release
branch and has not been exercised against live infrastructure.

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

### 0.6 2026-07-14 accounting capture, attribution, dashboard, analytics, and reconciliation status

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

### 0.7 2026-07-13 completed feature branch — introspection landmarks

- `feat/introspection-landmarks` is complete at reviewed code head `86cc6618`;
  child bead `psfn-framework-z7qe.2` is closed. Parent charter epic `z7qe`
  remains open because it still has live children (`z7qe.1`, `.3`, `.5`, `.6`,
  `.7`, `.8`, and `.9`).
- Delivered companion-owned append-only consent, a scheduled three-call blinded
  divergence audit with auditor/companion context separation, append-only
  Postgres landmark and terminal-decision ledgers, private values-consistency
  findings, and private model-usage telemetry. Intimate or untrusted turns fail
  closed and are never replayed into the audit.
- The final privacy hardening binds each candidate to its exact logical-session
  owner and revalidates route retirement, physical TurnRecord ownership,
  owner loadability, and tombstones after every awaited disclosure boundary and
  before durable writes. Deterministic disk-reload races cover both
  `break_glass_quarantine` and `fresh_split` with zero subsequent model or write
  calls.
- Validation at `86cc6618`: 477/477 tests across all 24 changed-surface test
  files, including seven real local Postgres cases; `npm run lint`, ESM+DTS
  `npm run build`, `npm run verify:settings-contract`, and `git diff --check`
  passed. The same independent adversarial reviewer that found the route and
  in-flight retirement bugs gave final PASS (225 focused tests, Postgres 6/6,
  lint green).
- Repository-hygiene note: `npm run verify:repository-hygiene` still stops at
  the inherited identity-literal baseline (the existing PSFN/`psfn` findings;
  no introspection file or new feature literal is reported). Public-sanitize
  passes. This is recorded as inherited branch baseline, not claimed as a green
  hygiene gate and not expanded into this feature.

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

**(b) Converge the remaining `s10-loc-*` branches** into `feat/multi-companion`. Locations work advanced past the `98e964eb` merge point independently (`s10-loc-emanation`, `s10-loc-enrollment`(-v2), `s10-loc-durable-state`). These touch the same seams multi-companion already extended (`places.json`, satellite binding, situated context) — merge conflicts are expected at the situated-presence and presence-registry layers, not just textual diff noise. Reconcile these lines before release integration so they do not re-diverge.

**(c) ICP autonomy — same-cluster inter-companion channels** (`psfn-framework-s10mc.6`) — **completed on `feat/icp-autonomy` through final integrated verification at `d8dd6ba4`.** All nine children are closed. The production-faithful certification proves the autonomous DM/room pipeline, persistence and restart continuity, privacy/trust isolation, fatigue/charge closure, canonical cost stops, failure recovery, and feature-off parity. Remaining work here is release-branch integration and the explicitly separate live exercise in (a)/(f), not implementation scope inside this epic.

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
| `psfn-framework-s10mc` | Epic. Substrate code-complete through `6608579f`; ICP autonomy child epic `s10mc.6` is closed on its feature branch; open remainder: flagship cutover, shard schema derivation, per-companion trust/charge/tier owners |
| `psfn-framework-s10mc.1` | W1 gateway multiplexing — code-complete @ `bcca5c20` (+ per-account Discord @ `eda410a4`); remainder split into `s10f1`/`s10f2` |
| `psfn-framework-s10mc.2` | W2 Postgres tenancy — schema plumbing @ `ee375e39`, backups @ `75abf583`; **open**: flagship cutover off `public`, shard schema derivation |
| `psfn-framework-s10mc.3` | W3 config scoping — phase 1 (`companions.json` + flag) @ `99ebd9c1`, supervisor @ `cf3dc9d1`; **open**: per-companion trust/charge/tier/settings owners |
| `psfn-framework-s10mc.4` | W4 Gardens + fleet view — implemented @ `6608579f` per git log; bead notes/status not yet updated to reflect the merge |
| `psfn-framework-s10mc.5` | W5 location deltas — presence @ `ac389e5b`, wiki scopes @ `53033de6`; **open**: caretaker (`s10d5`), shared-schema chunk storage, world-tool `move` wiring (`s10wm`) |
| `psfn-framework-s10mc.6` | ICP autonomy epic — **closed** 2026-07-14: all nine children closed; final integrated certification at `d8dd6ba4` passed 10 real-process + 2 fixture cases, 346 proportional tests, settings-contract, lint, ESM+DTS build, and backup/restore; not yet merged to the release branch or live-tested |
| `psfn-framework-s10mc.6.5` | W5 initiation sources — **closed** 2026-07-14: integrated with W6 at `2599c2f5`; merged seam passed 32 focused files / 609 tests (including real Postgres integration), lint, and build |
| `psfn-framework-s10mc.6.6` | W6 fatigue/social regulation — **closed** 2026-07-14: both fresh reviews passed at `72238bc8`, follow-up beads fixed, two clean full-suite exits on the merged tree |
| `psfn-framework-s10mc.6.9` | W9 two-real-agent certification — **closed** 2026-07-14 at integrated verification point `d8dd6ba4`; 10 real-process + 2 fixture cases and 12 affected files / 346 tests passed; report-only hygiene/whitespace observations recorded in the close reason |
| `psfn-framework-1lxi` | P1 post-restart recipient turn-record persistence — **closed** 2026-07-14 at `b4ff8709`; exact real-process regression, 362 proportional tests, lint, ESM+DTS build, and diff checks passed |
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
| `psfn-framework-g44z` | Separate live validation: lossless Personal Workspace migration, cross-Garden isolation proof using the existing synthetic leak corpus, and disposable real-flagship restore rehearsal before cutover; does not block c337 |
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
