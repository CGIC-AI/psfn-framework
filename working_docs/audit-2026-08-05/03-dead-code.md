# Lane 3 — Unused / Dead Code Audit

Date: 2026-08-05 · Branch: `feat/emosim-fleet-shakedown` (working tree as-is) · Auditor: lane 3 of 8

## Scope & method

**Tooling run:**

- `npm run knip` (pinned `npx knip@6.23.0`, config `knip.json`). Full raw output captured
  (2,967 lines): 13 unused files, 1 unused devDependency, 1 unlisted dependency, 20 unlisted
  binaries, **1,177 unused exports**, **1,727 unused exported types**, 4 duplicate exports,
  7 configuration hints. Exit code 1 (findings present).
- Knip config coverage (`knip.json`): workspaces `.` (src/scripts/shakedown), `admin-ui`,
  `companion-ui`. Entries: the three runtime mains, the disabled `src/app/startup/index.ts`,
  two e2e agent-process harnesses, `scripts/**`, `shakedown/harness/*.mjs`.
  **Not covered:** `PSFN-Satellite-Hub/` (Python + TS), `deploy/helm/`, `docker/`, `k8s/`,
  `proxy/`, `admin-ui` SvelteKit routing conventions (see false positives).
- Knip emitted two load errors that degrade specific lanes: `Cannot find module
  '@playwright/test'` for `companion-ui/playwright.config.ts`, and "No Svelte config file
  found" (looked in repo root, not `admin-ui/`). Consequences are enumerated under
  false positives.

**Verification method (the actual work):** knip output was treated as a lead list, never as
verdict. For every unused *file* and for sampled unused *exports* I:

1. Grepped the identifier/basename across `src/`, `scripts/`, `shakedown/`, `admin-ui/src`
   (incl. `.svelte`), `companion-ui/src|e2e|vite`, plus string-reference surfaces:
   `package.json` scripts, `tsup.config.ts` entries, `deploy/helm/**` templates,
   `scripts/fixtures/**`, `docs/**`, `config/*baseline*` / allowlists, `modules/repl-registry.json`
   (empty array — ModuleLoader registry currently registers nothing).
2. Opened the defining file and read the surrounding context (per evidence standard).
3. Classified each unused export by a second pass: word-occurrence count inside the defining
   file separates "exported but used internally" (drop the `export` keyword; code is live)
   from "definition-only" (genuinely dead).

**Bulk pre-screen (read-only scripts over knip's list):** of the 1,177 unused exports, 665
cleanly parseable rows point into `src/` (knip truncates long paths/names with `…`; truncated
rows were excluded from bulk screening and are represented in the sampled clusters instead).
Result: **409 with zero references anywhere outside the defining file** (of which **74 are
definition-only dead** and **335 are used only inside their own file**), 2 test-only, and 254
whose grep hits are the definition/re-export barrel pairs themselves (knip is correct that no
external module imports them; the symbols are live internally — see false positives).

**Coverage limits:** unused exported *types* (1,727) were sampled, not individually verified —
aggregate treatment below. `PSFN-Satellite-Hub` got a manual light pass only (no knip coverage;
no Python dead-code tool installed, and installing one was out of scope). The 112 knip rows
with truncated identifiers were covered only where they fall inside manually inspected
clusters (cert-manager, corpus, disclosure, sprites).

## Critical assessment

Nothing here is a runtime-safety "critical" — dead code in this repo is hygiene debt, not a
live defect. Ranked by cleanup value and confidence.

### Major

**M1. `src/core/emotion/calibration.ts` — verified dead module (264 lines).**
Knip unused-file. Zero importers in `src/`, `scripts/`, tests; the only references in the repo
are baseline/allowlist *metadata* (`config/identity-literal-scan-allowlist.json:856-863`,
`scripts/hardcoded-settings-baseline.json:3316-3345`) which track the file's literals, not its
code. It defines a `CalibrationTableContract` / `CALIBRATION_TABLE_JSON_SCHEMA` for a
`psfn.calibration_table` artifact that nothing produces or consumes (verified by searching the
artifact-type string and every exported identifier). Git: introduced 2026-05-09 in
`bb97f6f83 fix(eval): share calibration table contract with runtime` — the "share with
runtime" consumer apparently never landed or was removed. **Safe to delete** (then drop its
baseline/allowlist entries); a human should confirm no out-of-repo eval tooling emits that
artifact type.

**M2. 74 definition-only dead exports in `src/` — verified by construction, sampled by hand.**
Each of these appears exactly once in the entire repo: its own `export` declaration. I opened
and confirmed a representative dozen across all major clusters:

- `src/core/contacts/store/identity-utils.ts` — six dead helpers from a contact-identity
  verification feature that is gone or never landed: `isValidChannelPrivacyLevel` (:54),
  `normalizeVerificationTtlMs` (:76), `createVerificationToken` (:83),
  `normalizeVerificationState` (:87), `getLegacyDiscordUserId` (:99), `relationshipForTrust`
  (:233). Read the whole 238-line file: no internal call sites.
- `src/core/identity/companion-naming.ts:4,5,7,8` — `LEGACY_CHARACTER_CARD_FILE_NAME`,
  `DEFAULT_ADMIN_CHAT_MODEL_ID`, `LEGACY_COMPANION_NAME`, `LEGACY_COMPANION_ID`: dead
  constants (whole file read; 24 lines).
- `src/core/tools/ntfy.ts:756,846` (+ `deliverApprovalRequestNotification`) — approval-request
  notification formatting/delivery and a gateway notification port with zero call sites, zero
  tests. Consistent with bead evidence that this delivery path is not wired.
- `src/system/config/load-or-seed.ts:122,206` — `loadOrSeedJson` / `loadOrSeedJsonCached`:
  both carry `@deprecated Runtime config must not seed itself` docstrings and have zero
  callers. Deprecated shims past their lifetime (AGENTS.md rule 3).
- `src/system/settings-tools.ts:107` — `createSettingsGetTool` builds the `settings_get` tool,
  but that tool was **retired**: `src/core/agent/tool-surface/registry.ts:366` registers only
  `retiredAlias('settings_get', …)`. The factory is an orphan of the retirement.
- `src/app/startup/support/env-parsing.ts:16` `parseExtractionDrainTimeoutMs`,
  `src/boundary/gateway/filesystem-paths.ts:11` `resolveWorkspaceFsPath`,
  `src/core/session/manager-primitives.ts` `buildSessionHistorySummaryText`,
  `src/persistence/jsonl-segments.ts` `scanJsonlFileForward`,
  `src/shared/routing/envelope.ts` `cloneGatewayRoutingEnvelope`,
  `src/primitives/voice/pipeline/frames.ts` `isVoiceDataFrame` / `isInterruptControlFrame`,
  `src/faculties/skills/loader.ts` `safeFileExists` — all same pattern: definition is the only
  occurrence repo-wide.

  The full 74-row list is reproducible from the method section; representative clusters:
  `identity-utils.ts` (6), `corpus/corpus.ts` constants (8 — corpus vocabulary constants
  `CORPUS_FRAMEWORKS`/`CORPUS_VERDICTS`/… defined but unread), `intake-envelope.ts` guards
  (several), `intention/patterns.ts` SQL/normalizers (4), `layout.ts` reflection-path
  resolvers (2 of its 11 flagged exports; the other 9 are internal-use, see m1 below).

**M3. admin-ui: ~34 unused exports, and the sample says they are really dead.**
Because knip's Svelte plugin degraded (root-level config lookup), I hand-verified 10 sampled
admin-ui exports by grepping all of `admin-ui/src` including `.svelte` consumers: **10/10 are
definition-only**, e.g. `getConfirmations` (`lib/api/endpoints/confirmations.ts:29`),
`getContactApprovals` (`contact-approvals.ts:47`), `updateContactLegacyPatch`
(`contacts.ts:49`), `startTelemetry`/`stopTelemetry` (`stores/telemetry.svelte.ts:41,45`),
`setCompanionName` (`stores/companion.svelte.ts:26`), `SETTINGS_SEARCH_ENTRIES`
(`components/settings/settings-search.ts:283`), `zonedDateStartMs`
(`accounting/query-state.ts:94`), `GENERIC_COMPANION_NAME` (`lib/companion-name.ts:7`),
`companionCachePrefix` (`cache/indexeddb.ts:18`). Also `listModels`/`refreshModels`
(`lib/api/endpoints/settings.ts:106,110`) duplicate the live `listDiscoveredModels`/
`refreshDiscoveredModels` pair in `endpoints/models.ts` and have no consumers. These are
leftovers from Garden UI refactors — API client helpers whose pages were removed or rewired.

**M4. companion-ui: dead exports cluster (~10 flagged, sample 5/5 definition-only).**
`MOBILE_CHAT_APP_CAPABILITIES` (`src/lib/api/auth.ts:10`), `approvalsCapabilityAcked`
(`src/lib/approvals.ts:43`), `artifactCapabilityAcked` (`src/lib/artifacts.ts:57`),
`DEFAULT_MIN_INTERVAL_MS` (`src/lib/geolocation.ts:31`), `ACTIVITY_FILTERS`
(`src/ui/activity-drawer.tsx:13`), `SPRITE_MANIFEST_VERSION`/`SPRITE_ASSET_DIR`
(`src/lib/sprites/manifest.ts:24-25`), `VALENCE_MARGIN`/`AROUSAL_*` constants
(`src/lib/sprites/emotion-mapping.ts:52-60`). Capability-ack and sprite-manifest leftovers.

### Minor

**m1. 335 `src/` exports used only inside their own file — the `export` keyword is noise.**
Verified pattern via internal-occurrence counts and spot reads, e.g. the whole
`src/app/cert-manager/config.ts` DEFAULT_* cluster (:18-25, used only within that module —
cert-manager is a live entrypoint, the constants are live config defaults, but nothing imports
them), `createHttpNotificationPort` (`ntfy.ts:949`, called only by
`createHttpNotificationPortFromEnv` at :957), 9 of the 11 flagged `persistence/layout.ts`
resolvers. This is not dead *code*; it is over-wide module surfaces — it inflates the knip
report, slows future audits, and obscures real dead code (M2 hides inside the same list).
Mechanical fix: delete the `export` keyword.

**m2. Dead alias exports (4 duplicate-export findings verified).**

- `src/persistence/backups/config.ts:15` — `DEFAULT_BACKUP_RETENTION_COUNT`, explicitly
  `@deprecated` alias of `DEFAULT_BACKUP_ROTATING_COUNT` (:6); zero non-test references.
  Safe deletion.
- `admin-ui/src/lib/api/endpoints/model-usage.ts:61` — `export const getModelUsageExportUrl =
  buildModelUsageExportPath`; the alias has no consumers (the real name is used at :67 and in
  `accounting.test.ts`). Safe deletion.
- `src/boundary/fleet-auth/request-capability-target.ts:415-417` — three aliases
  (`compileGatewayGardenRequestTarget`, `compileOperatorGardenRequestTarget`,
  `compileAgentGardenRequestTarget`) of `compileGardenRequestCapabilityTarget` (:360); no
  importers of any alias. Safe deletion.
- `src/core/eval/observer-sidecar/emosim-server-adapter.ts:63,66` — `EMOSIM_MIN_READ_CADENCE_MS`
  and `DEFAULT_EMOSIM_AFTER_TICK_DELAY_MS` share a value but are semantically distinct (floor
  vs. default) and both are used internally + in tests. **Not** dead; do not merge (nit only).

**m3. Test-only exports (verified 2; the class is larger).**

- `src/core/enrollment/store.ts:85` — `export class PostgresHubIdentityEnrollmentStore`: the
  production consumer (`src/persistence/runtime-factory.ts:15,315`) uses only the
  `createPostgresHubIdentityEnrollmentStore` factory; the class name appears otherwise only in
  `store.test.ts` (describe label/import). Unexport the class, keep the factory.
- `src/core/intention/concern-candidates.ts:455` — `ConcernCandidateApplyError`: referenced
  only by `concern-candidates.test.ts:706` (a `name` string assertion). Keep the class (it's
  thrown), but it need not be exported — or keep as deliberate test hook; judgment call.
- `shakedown/harness/lib/case-execution.mjs:22` `CaseIsolationError` similarly only reaches
  `test/hardening-catalog.test.mjs`.

**m4. Shakedown harness dead helpers (verified).** `requireIntEnv`
(`shakedown/harness/lib/env.mjs:74`), `parseSectionTable` (`lib/coverage.mjs:27`),
`resolveTargetName` / `TARGET_KUBE` / `TARGET_LOCAL` (`lib/target.mjs:42-53`) — definition-only
within the harness. Test-infrastructure cruft, low stakes.

### Nit

**n1. 1,727 unused exported types.** Concentrated in `src/core` (431), `src/faculties` (166),
`src/system` (133), `src/operator` (130), `src/boundary` (112), `src/shared` (96), admin-ui
(94). Sampled rows are wire/contract vocabulary (e.g. `intake-envelope.ts` guards,
`approval-envelope.ts` `KNOWN_APPROVAL_SOURCE_SYSTEMS`, run-charge lineage types in admin-ui).
Per repo convention (`src/shared/contracts/` documents both sides of the gateway/agent
boundary; `unknown`-at-boundary + contract vocabulary is deliberate), a large fraction of
these are **intentional contract surface**, not slop. Mass deletion would be wrong; a scoped
pass over non-contract directories (`src/operator`, admin-ui endpoint types whose consumer
pages are gone — see M3) is where the real dead types live.

## Recommendations

Ordered by value/effort. "Mechanical" = safe delete/unexport with grep re-verification;
"design" = needs an owner decision.

1. **Fix the knip config so future runs are trustworthy** (mechanical, ~30 min): add
   `admin-ui/svelte.config.js` resolution (run knip so the Svelte plugin finds the config —
   currently it looks in repo root), ensure `@playwright/test` is resolvable when running
   against companion-ui (or drop `playwright.config.ts` from entry and add `e2e/**/*.spec.ts`
   as entry patterns), add tsup-entry awareness for `src/app/maintenance/*` and the two
   worker files (or an `ignore` list with comments pointing at `tsup.config.ts`/helm
   templates). This eliminates ~9 of the 13 unused-file false positives permanently.
2. **Delete the verified-dead list** (mechanical, ~half day incl. focused lint/tests):
   - `src/core/emotion/calibration.ts` + its two baseline/allowlist blocks (M1).
   - The 74 definition-only `src/` exports (M2), including the deprecated
     `loadOrSeedJson`/`loadOrSeedJsonCached` wrappers and `createSettingsGetTool`.
   - The three dead aliases (`backups/config.ts:15`, `model-usage.ts:61` in admin-ui,
     `request-capability-target.ts:415-417`) (m2).
   - Sampled-and-verified admin-ui (M3) and companion-ui (M4) dead exports.
3. **Unexport the 335 internally-used exports** (mechanical but bulky, ~1-2 h with a careful
   codemod + typecheck) (m1). Optional but recommended: it shrinks the knip baseline by ~30%
   so real dead code stops hiding in noise. Do contracts/shared-boundary files last and
   conservatively.
4. **Test-only exports: narrow or annotate** (mechanical, <1 h) (m3): unexport
   `PostgresHubIdentityEnrollmentStore`, decide on `ConcernCandidateApplyError`.
5. **Unused exported types: scoped review, not mass deletion** (design, ~half day): restrict
   to admin-ui endpoint types paired with M3 dead helpers, `src/operator`, and non-contract
   `src/core` files. Treat `src/shared/contracts/**` and wire-vocabulary enums as intentional
   unless both boundary sides are provably gone (n1).
6. **`PSFN-Satellite-Hub`: add to knip or accept manual audits** (design, ~1 h): currently
   uncovered. Light manual pass found no dead modules (hub wired via `pyproject.toml`
   `[project.scripts]` `hub` → `hub.cli` → systemd unit + helm satellite-hub image), but a
   Python pass (vulture) would need an isolated env.
7. **Do NOT remove** (documented-intent keeps, recorded here so the next auditor doesn't
   re-litigate): `src/app/maintenance/force-episodic-synthesis.ts` (operator tooling; KEEP
   ruling in `working_docs/code-quality-review-20260719.md:392` and bead `psfn-framework-aylm.9`;
   its SQLite retirement is separately tracked in bead `psfn-framework-3c2.7`),
   `src/app/startup/index.ts` (deliberately disabled monolith guard, exits 1 with a pointer
   message — keep as a fail-closed stub), the four helm/tsup-referenced maintenance entries,
   the two worker files, `admin-ui/src/hooks.ts`, `tailwindcss` devDependency.

## Risks & false positives

**Knip false positives — verified, with mechanism (9 of 13 "unused files"):**
- `src/app/maintenance/migrate-required-settings-blocks.ts`,
  `owner-upgrade-readiness-probe.ts`, `verify-shell-sandbox-runtime.ts` — built by tsup
  (`tsup.config.ts:10-23`) and invoked by string path from helm templates
  (`deploy/helm/psfn/templates/owner-migration-upgrade.yaml:110`, `_helpers.tpl:991-998`),
  verify scripts (`scripts/verify-helm-chart.mjs:307,672`,
  `scripts/verify-shell-sandbox-image.mjs:30`), and docs (`docs/helm-upgrades.md:481`).
- `src/app/maintenance/force-episodic-synthesis.ts` — manual operator CLI (usage string at
  its :168); documented KEEP (see recommendation 7). Flag it as *legacy SQLite tooling
  pending retirement*, not as dead.
- `src/persistence/sessions/turn-record-recovery-worker.ts` /
  `turn-tombstone-authority-worker.ts` — loaded via computed worker URLs
  (`turn-record-recovery.ts:55`, `turn-tombstone-authority.ts:61`,
  `new URL(\`./…-worker${sourceExtension}\`, import.meta.url)`) plus tsup entries and a test
  (`turn-records.test.ts:1052`).
- `shakedown/harness/lib/capability-matrix.d.mts` — type-declaration companion of
  `capability-matrix.mjs`, picked up implicitly by TS consumers such as
  `lib/production-capability-probe.ts:25`.
- `companion-ui/e2e/fleet-auth-flow.spec.ts`, `service-worker-lifecycle.spec.ts`,
  `e2e/fixtures/legacy-main.tsx` — the e2e directory contains *only* these files;
  `playwright.config.ts` (`testDir: './e2e'`, no `testIgnore`) picks up both specs, and
  `legacy-main.tsx` is referenced by string path at `service-worker-lifecycle.spec.ts:9`.
  Knip missed all three because `@playwright/test` wasn't resolvable when it loaded the
  config (root-level run; the dep lives in `companion-ui/package.json:20`).
- `admin-ui/src/hooks.ts` — exports the SvelteKit **`reroute` universal hook**; a plain
  `src/hooks.ts` (no `.client`/`.server` suffix) is exactly where SvelteKit ≥2.3 expects it,
  and admin-ui pins `@sveltejs/kit` 2.70.1. Live framework wiring; knip's Svelte plugin
  degraded (root config lookup) and missed it. Deleting it would silently break fleet
  companion-scope URL routing.
- `admin-ui/src/lib/api/endpoints/models.ts` — imported by
  `admin-ui/src/routes/models/+page.svelte:10` via the `$lib` alias (same plugin degradation).
- `tailwindcss` devDependency (admin-ui) — `@import 'tailwindcss'` in
  `admin-ui/src/app.css:1` references the package by name, and `@tailwindcss/vite@4.2.1`
  lists `tailwindcss` as a regular dependency; the explicit pin is defensible. Keep.
- The 254 grep-positive `src/` rows in my pre-screen — their hits are the
  definition/barrel-re-export file pairs themselves (e.g. `capsule.ts` ↔ `disclosure/index.ts`
  for `CAPSULE_USE_INTENTS`). Knip's graph verdict (no external importer) is consistent with
  the greps; these are barrel-surface exports of internally-live symbols, **not** dead code.
  Whether the barrel re-exports should exist is a dedup/surface question, not dead code.
- Unlisted binaries (20) — `helm`, `kubectl`, `gh`, `bd`, `openssl`, `systemctl`, `rg`,
  `playwright`, `esbuild`, `bus-*`: environment/operator-provided tools invoked by scripts and
  ops tooling; intentional. `rollup` imported by
  `companion-ui/vite/companion-service-worker.ts:4` is supplied transitively by vite — a real
  but trivial manifest nit (cross-lane: dependency hygiene).

**Deliberately not flagged:**
- `src/shared/contracts/**` "unused" vocabulary — deliberate cross-process contract surface
  per AGENTS.md.
- `src/app/startup/composition/**` exports — the startup tree is live wiring for the split
  runtime (AGENTS.md source-of-truth list); its flagged exports are mostly internal-use (m1).
- `modules/repl-registry.json` is an empty array — the ModuleLoader registry currently
  registers nothing, so no dynamic-registration false positives arise from it today.
- 112 knip rows with truncated identifiers — not individually verifiable without re-running
  knip with wider output; their directories overlap the manually verified clusters, so the
  classification ratios should hold, but treat per-row use of the bulk numbers as approximate.

**Candidates needing human verification:**
- `src/core/emotion/calibration.ts` (M1): code-dead in-repo, but confirm no external eval
  tooling writes/reads `psfn.calibration_table` artifacts before deleting (it was added to
  "share with runtime", so a consumer may live outside this checkout).
- `src/core/cogsec/intake/corpus/corpus.ts` vocabulary constants (`CORPUS_FRAMEWORKS` et al.):
  possibly kept as schema documentation for the JSONL corpus fixtures; check with the cogsec
  owner before deleting.
- `ConcernCandidateApplyError` export (m3): may be an intentional test-observability hook.

## Cross-lane notes

- **Legacy/shims lane:** deprecated `loadOrSeedJson`/`loadOrSeedJsonCached`
  (`src/system/config/load-or-seed.ts:118-127,202-211`) and `DEFAULT_BACKUP_RETENTION_COUNT`
  (`src/persistence/backups/config.ts:14-15`) are deprecated wrappers past their callers;
  `force-episodic-synthesis.ts` belongs to the SQLite-retirement epic (beads
  `psfn-framework-3c2.5`–`3c2.8`), not this lane.
- **Dedup lane:** barrel re-export pairs (`src/core/cogsec/disclosure/index.ts` ↔ `capsule.ts`
  and similar, ~254 rows) — internal symbols exported through two surfaces; admin-ui
  `settings.ts:106-112` `listModels`/`refreshModels` duplicate `endpoints/models.ts`.
- **Types lane:** 1,727 unused exported types (aggregate in n1); also
  `request-capability-target.ts` contains 418 NUL bytes (grep treats it as binary — likely
  embedded binary payload test vectors, but worth a hygiene glance).
- **Dependency-hygiene lane:** `rollup` unlisted dependency in companion-ui; the 20 unlisted
  binaries are environment-provided but undocumented in any manifest.
- **Comments/slop lane:** `createSettingsGetTool` orphan is a leftover of the `settings_get`
  retirement (`tool-surface/registry.ts:366`); the retired-alias comment documents the
  retirement but nobody removed the factory — doc/code drift.
- **Defensive-code lane:** nothing flagged here conflicts with fail-closed policy code; the
  dead guards found (e.g. `isIntakeSink`, `isIntakeDerivationKind`) are unused validators, not
  weakened ones.
