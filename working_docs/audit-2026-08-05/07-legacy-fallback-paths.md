# Lane 7 — Deprecated / Legacy / Fallback / Redundant Paths

Audit date: 2026-08-05. Branch: `feat/emosim-fleet-shakedown` (working tree as-is, clean per `git status --porcelain`). Read-only audit; no files modified except this report.

## Scope & method

Assignment: find deprecated, legacy, fallback, and duplicate code paths; establish what is sanctioned before flagging; for each finding give evidence, sanction status, reachability, and a remove/schedule/keep recommendation.

Required reading completed:

- `docs/specifications.md` lines 43–176 — the **Live Alpha Migration Boundary** (the authoritative sanction list) plus the "Out of boundary" list at lines 168–175.
- `AGENTS.md` implementation standard 3 (no legacy paths/shims unless the boundary names them).
- `docs/operations.md` — live authority is the k3s/Helm deployment in namespace `psfn`; host systemd is "disabled, non-authoritative legacy" (operations.md:241–293), with repo-owned units kept deliberately.
- `docs/tool-surface.md` — Charter Law 33 tool-surface retirement contract.
- `deploy/helm/psfn/README.md`, `k8s/README.md`, `deployment/pi-host/README.md`, `docs/context-envelope.md`, `docs/garden-control-plane.md`, `docs/fleet-auth-authority-model.md`.
- Prior audits `working_docs/READONLY_AUDIT_*_20260721.md` and `working_docs/pi_glm_review_626.md` consulted for leads; every reused claim re-verified against current code.

Investigation commands/tools (all read-only): `git status`/`git ls-files`/`git check-ignore`; Grep sweeps over `src/`, `docs/`, `scripts/`, `package.json`, `.github/` for `legacy|deprecated|fallback|compat|migration|TODO remove|k8s|kustomize|systemd|seed.json|loadOrSeedJson|notify_operator|issue_ready|vault_search`; targeted Reads of `src/app/startup/index.ts`, `src/persistence/layout.ts`, `src/system/config/load-or-seed.ts`, `src/system/config/settings-contract.ts`, `src/core/agent/tool-surface/registry.ts`, `src/core/agent/tool-wiring-validator.ts`, `src/operator/garden/garden-request-context.ts`, `src/operator/garden/transport-server.ts`, `src/persistence/backups/config.ts`, `src/faculties/memory/embedding.ts`, `src/faculties/memory/extraction/types.ts`, `src/system/config/legacy-env.ts`, `src/persistence/journals/journal/legacy-source.ts`, `src/persistence/sessions/store/legacy-import.ts`, `k8s/base/configmap.yaml`, `docker/docker-compose*.yml`, `scripts/verify-k8s-manifests.mjs`, `scripts/ci/local-delivery-contract.mjs`, `.github/workflows/ci.yml`.

Coverage limits: I did not run the test suite, gates, `verify:k8s-manifests` (needs `kubectl`), or `knip`. I did not exhaustively review all 50 files in `src/app/maintenance/` — I verified the ones wired to `package.json` `migrate:*` scripts plus the legacy-named ones. The `PSFN-Satellite-Hub/` nested checkout is gitignored in this repo (` .gitignore:48`) and was treated as out of scope. `admin-ui` and `companion-ui` were checked only for old-vs-new duplication at the deployment/doc level, not line-by-line.

## Critical assessment

**No critical findings.** The repo's migration-boundary discipline is real: every runtime fallback I traced is either named in `docs/specifications.md` §Live Alpha Migration Boundary, documented as intentional in `docs/operations.md`, or guarded by fail-closed tests. The findings below are about *untracked* compatibility debt and one parallel-stack decision, not about live fail-open shims.

### Major

**M1. Two parallel Kubernetes deployment stacks: `k8s/` (Kustomize) vs `deploy/helm/psfn/` (Helm) — decision needed, not obviously sanctioned.**

- Evidence: `k8s/base/` holds 14 manifests (deployments for psfn gateway+agent sidecars, litellm, tei, postgres; configmap/secrets/pvc/rbac/networkpolicy) with `k8s/overlays/{dev,production}`. `k8s/README.md:36-44` presents it as a live install path ("Quick Start: `kubectl kustomize k8s/overlays/production | kubectl apply -f -`"). The Helm chart (`deploy/helm/psfn/`) is the documented live authority (AGENTS.md "Live deployment and private data"; `docs/operations.md:241`).
- It is **not dead**: `scripts/verify-k8s-manifests.mjs` renders all three targets and asserts contract details; it runs in CI (`.github/workflows/ci.yml:100` via `verify:deployment-contracts`) and in the local delivery contract (`scripts/ci/local-delivery-contract.mjs:357`).
- But it is a **narrower, older topology**: `k8s/base/configmap.yaml:19-21` wires a single `COMPANION_DATA_DIR` (single-companion), and the stack has no cert-manager/SPIFFE mTLS, no Redis, no separate Garden deployment, no fleet companions — all of which the Helm chart README lists as the current topology. Nothing outside `k8s/README.md` tells an operator when to choose Kustomize over Helm; `docs/setup.md` and `docs/operations.md` never mention it.
- Sanction status: the migration boundary does not name it (it is a deployment artifact, not runtime fallback behavior, so the boundary arguably does not apply) — but there is also no document stating "k8s/ is a supported second install path" or "k8s/ is dev-only".
- Reachability: any operator following `k8s/README.md` deploys a single-companion, pre-fleet topology that still passes CI.
- Recommendation: **decide and document** — either (a) bless k8s/ as the lightweight single-companion/dev install path in `docs/setup.md` and strip or clearly mark the `production` overlay, or (b) retire k8s/ and `verify:k8s-manifests` and route everyone through Helm. Keeping a CI-verified "production" overlay for a topology the fleet architecture has moved past is the worst option. *Candidate — needs human/design decision.*

**M2. Garden dual authentication: `legacy_token` fallback path alongside fleet SSO, absent from the migration boundary.**

- Evidence: `src/operator/garden/garden-request-context.ts:43-46,78-84,171-198` defines `LegacyGardenActorContext`/`LegacyGardenRequestContext` (`kind: 'legacy_token'`, actor `legacy-token:operator`). It is constructed as a **silent default** when no fleet context is supplied: `src/operator/garden/transport-server.ts:85` and `src/operator/garden/server-routes.ts:73` both do `context ?? createLegacyGardenRequestContext({...})`. Several services branch on it (`garden/services/memory-service.ts:473`, `episodic-memory-service.ts:232`, `api-routes-memory.ts:249,504`, `intake-quarantine-service.ts:237`, `shard-fold-review-service.ts:46`).
- Prior audit adjudication (`working_docs/READONLY_AUDIT_origin-main_DEEPDIVE_20260721.md:14`, re-verified): "Legacy single-companion token path still exists in code for non-fleet; fleet-SSO path is the real surface" — withdrawn as a *production* risk because Garden is not externally reachable in the kube deployment. That adjudication still holds: this is a functional non-fleet path, not an exploitable hole in the live topology.
- Sanction status: **not named** in `docs/specifications.md` §Live Alpha Migration Boundary, which claims to be exhaustive for "compatibility or fallback behavior in config, startup, persistence, or model-facing tool names" (line 45). A Garden auth fallback is arguably startup/config-adjacent. `docs/garden-control-plane.md:536,554` speaks of retiring legacy Garden readers after cutover but sets no criteria for the token path.
- Reachability: any non-fleet deployment (local dev, host systemd legacy, host docker) that sets `ADMIN_TOKEN` reaches it.
- Recommendation: **schedule with criteria** — either add the legacy Garden token path to the boundary with an explicit beta-removal condition (e.g. "remove once fleet auth is the only supported Garden deployment mode"), or file the removal bead now and gate non-fleet Garden behind an explicit opt-in flag so the fallback stops being implicit. *Candidate — needs human/design decision on whether non-fleet Garden remains supported at all.*

### Minor

**m1. `loadOrSeedJson` / `loadOrSeedJsonCached` — deprecated compatibility wrappers with zero callers.**
`src/system/config/load-or-seed.ts:118-128` and `:202-212` are marked `@deprecated` ("Runtime config must not seed itself"). A repo-wide grep for `loadOrSeedJson` finds **only the two definitions** — no production, test, or script callers. This is exactly the "new seed-loading behavior introduced as a compatibility workaround" the boundary lists as out-of-bounds (specifications.md:175), except here the workaround is already empty. Recommendation: **remove now** (mechanical, ~25 lines plus any type-only exports of `LoadOrSeedJsonOptions`).

**m2. `DEFAULT_BACKUP_INTERVAL_MS` / `DEFAULT_BACKUP_RETENTION_COUNT` — deprecated alias constants with zero consumers.**
`src/persistence/backups/config.ts:12-15` declares both with `@deprecated` pointing at `DEFAULT_BACKUP_INTERVAL_HOURS`/`DEFAULT_BACKUP_ROTATING_COUNT`. Grep shows no file outside `backups/config.ts` references either name. Recommendation: **remove now** (mechanical).

**m3. Three `migrate:*` maintenance commands are not named in the migration boundary.**
The boundary (specifications.md:45) says the runtime "may keep **only** the migration support listed here", and it names `migrate:persistence-layout`, `migrate:system-owner-fleet`, `migrate:scheduler-owner`, `migrate:intake-policy-owner`, and `migrate:session-filenames`, each with a beta-removal condition. `package.json` also exposes `migrate:embeddings` (line 59), `migrate:prompt-layer-identifiers` (line 63), and `migrate:channel-envelope` (line 78). These are documented one-shot operator commands (`docs/operations.md:1289`; `docs/context-envelope.md:228,257`) and are runtime-inert, so this is a **boundary-documentation gap**, not a violation with teeth — but the boundary's whole value is exhaustiveness. Recommendation: add the three commands to the boundary with removal criteria, or remove the commands if every live install has already run them (operator knowledge required). Also note the "Existing companion persistence migrations" bullet (specifications.md:130-134) has **no removal condition**, unlike its neighbors — worth adding one.

**m4. Deprecation-warn-only env-var handling in embedding provider resolution.**
`src/faculties/memory/embedding.ts:605-612` warns on `TRANSFORMERS_EMBEDDING_URL`/`TRANSFORMERS_API_KEY` ("deprecated … now runs in-process"), and `:614-618` silently falls back `TRANSFORMERS_MODEL ?? TRANSFORMERS_EMBEDDING_MODEL ?? EMBEDDING_MODEL`. Warn-and-continue on legacy env is consistent with the sanctioned hydration posture ("warns on legacy drift", specifications.md:355; `src/system/config/legacy-env.ts` is the sanctioned central list), but this particular fallback chain is local, unnamed in the boundary, and the fallback to generic `EMBEDDING_MODEL` is silent. Recommendation: fold these keys into the `legacy-env.ts` warn list and drop the local fallback chain, or accept and document. Low priority; embedding provider selection is env-owned wiring so the risk is confined to misconfiguration noise.

**m5. Deprecated settings "compatibility projections" are still load-bearing in Garden.**
`src/system/config/settings-contract.ts:373-388` marks `primaryModel`, `primaryProvider`, `primaryMaxTokens`, `extractionModel`, `modelRoleAssignments`, `modelRoster`, `salienceDecayIntervalMs`, and four `webFetchLocalCrawler*` keys as deprecated compatibility projections of the `models.json` registry. They are still actively read: `src/operator/garden/services/settings-service.ts:410-419` (alias patch handling), `src/operator/garden/chat/bootstrap.ts:501,510`, `src/faculties/shards/configuration-snapshot.ts:209-213,351`. The contract guard deliberately tolerates them (`settings-contract-guard.ts:63,160`), so this is intentional bridging — but there is no removal criterion or tracking note beyond the code comment. Recommendation: keep, but add a boundary/removal note (or a bead) defining when the projections get deleted; otherwise "deprecated" here is permanent.

**m6. `tokensUsed` deprecated alias still populated.**
`src/core/tools/analysis-workbench/types.ts:199` (`// deprecated alias: input + output`) is still written at `src/core/tools/analysis-workbench/loop-helpers.ts:175`. Internal to one tool; harmless; removal is a small mechanical change once consumers (if any external) are confirmed — the field appears in a public result type, so check the tool's output contract first. *Candidate — needs human verification of external consumers.*

**m7. Stale doc claim: `docker-compose.yml` described as SQLite-based.**
`docs/shakedown.md:255` describes the plain compose lane as "(single container, host-socket bind, **SQLite**)". SQLite is gone from the runtime — no `sqlite` dependency in `package.json`, `scripts/verify-postgres-only.mjs` enforces Postgres-only, and neither `docker/docker-compose.yml` nor `docker-compose.production.yml` mentions SQLite. Doc drift only; hand to the comments/docs lane or fix in one line.

### Nit

**n1. `.worktree_branch_rationalization_workspace/` at repo root.** Untracked, self-ignored (its own `.gitignore` contains `*`), contains logs/TSVs from a completed branch-rationalization effort. Not tracked code; local clutter the operator may want to delete. No action required from the repo side.

**n2. `deployment/pi-host/` is current, not legacy — flagged here only to record the check.** Its README documents it as the source of truth for the live k3s Pi's host-level backup units. Keep.

## Recommendations

Ordered, with effort estimates:

1. **Resolve the k8s/-vs-Helm question (M1).** Design decision, not mechanical. If keeping: one paragraph in `docs/setup.md` defining when Kustomize is supported, and either delete `k8s/overlays/production` or annotate it as unmaintained-topology. If retiring: delete `k8s/`, `scripts/verify-k8s-manifests.mjs`, and the `verify:k8s-manifests` wiring in `package.json:121-122`, `ci.yml:100`, `local-delivery-contract.mjs:357`. Effort: 0.5–1 day either way.
2. **Put the Garden legacy-token path under explicit governance (M2).** Design decision (does non-fleet Garden survive to beta?). Minimal version: add it to the specifications.md boundary with a removal condition. Fuller version: require an explicit `ALLOW_LEGACY_GARDEN_TOKEN`-style opt-in so the `?? createLegacyGardenRequestContext` default stops being implicit. Effort: boundary note 1 hour; opt-in gating 0.5–1 day plus tests.
3. **Close the boundary-documentation gaps (m3, m5, and the removal-condition-less bullet at specifications.md:130-134).** Mechanical doc edits once the operator confirms which live migrations have completed. Effort: 1–2 hours.
4. **Delete the dead deprecated wrappers (m1, m2).** Safe, mechanical: remove `loadOrSeedJson`/`loadOrSeedJsonCached` (+ `LoadOrSeedJsonOptions` if unreferenced) from `src/system/config/load-or-seed.ts`, and the two alias constants in `src/persistence/backups/config.ts`. Run lint + targeted config tests. Effort: <1 hour. This is the only finding I'd execute without any design input.
5. **Consolidate embedding env deprecation into `legacy-env.ts` (m4).** Small, mostly mechanical, but touches startup-warning behavior — needs a settings-contract verify run. Effort: 0.5 day.
6. **Confirm consumers, then drop `tokensUsed` (m6) and schedule the contacts `privacyLevel` column cleanup** (already documented in `src/core/contacts/types.ts:31-39,58-65,132` as "a later cleanup bead" — verify that bead exists and link it). Effort: 1–2 hours each.
7. **Fix the SQLite doc line (m7).** One-line edit. Effort: minutes.

## Risks & false positives

Deliberately **not** flagged, with the verification that cleared them:

- **`src/app/startup/index.ts`** (assignment candidate a): the entire file is an 11-line fail-closed stub that logs "This entrypoint is disabled" and `process.exit(1)`. Explicitly sanctioned: `docs/specifications.md:26`, `docs/architecture.md:9`, `docs/setup.md:3`, `docs/development-status.md:18`; listed as a knip entry (`knip.json:6`). **Keep intentionally** — it is the guard against the old monolith, not a legacy path.
- **`deployment/systemd/`** (candidate c): documented in `docs/operations.md:246-293` as "disabled, non-authoritative legacy" but deliberately kept repo-owned so no shadow copy becomes authoritative; still exercised by `scripts/system/install-psfn-service.sh` and tests under `src/app/maintenance/script-verification/`. The `user/companion-watchdog.*` units are the documented liveness path for the legacy host unit (operations.md:535-577). **Keep intentionally.**
- **Runtime persistence migrations in `src/persistence/layout.ts`** (candidate d): `migrateLegacyPersistenceLayout` (layout.ts:1083-1087) runs idempotently at every startup from `composition.ts:257,302,432` and `runtime-factory.ts:155`, plus inside the cutover tool (`cutover.ts:913`). Sanctioned by specifications.md:130-134 ("Existing companion persistence migrations …"). The migrations are one-way, `existsSync`-guarded, and warn-not-fail on individual file errors (layout.ts:571,602,628,1017) — that warn-and-continue is intentional for opaque-file moves and matches the sanction text. Not one-shot-removable yet; the only gap is the missing removal criterion (m3).
- **Session filename lazy detector**: fails closed with the exact operator command (`src/persistence/sessions/store/channel-index.ts:402`; tested in `store-filename-migration.test.ts`), precisely as specifications.md:121-129 prescribes. Sanctioned.
- **Tool-surface alias machinery**: retired aliases are enforced *uncallable* by derived drift guards (`src/core/agent/tool-surface/registry.ts:60-99`, registration tests in `tool-runtime-facade.test.ts:731-830`) and emit corrective messages (`tool-call-correction.ts:114-122`); hidden aliases are the sanctioned migration aliases of specifications.md:150 + `docs/tool-surface.md`. The `DEFAULT_GATEWAY_TOOL_METADATA_COVERAGE` entries for retired names (`tool-wiring-validator.ts:168-216`) are *guards that disable* a mistakenly re-registered alias, not live implementations. Well-governed; removal timing is the documented "after canonical actions have stable adoption".
- **`src/system/config/legacy-env.ts`**: the central warn-on-drift list sanctioned by specifications.md:200,355.
- **`src/persistence/workspaces/legacy-workspace-migration.ts` + `src/app/gateway/legacy-workspace-migration-logging.ts`**: the sanctioned one-time `WORKSPACE_PATH` cutover (specifications.md:151-166), with fail-closed digest approval and `not_needed` realpath handling.
- **Postgres rollback bridges** (`l2_memories.salience_decay_anchor_at` default, `model_usage_events` insert trigger): explicitly sanctioned with removal criteria (specifications.md:135-149).
- **`config/*.seed.json`** (candidate g): 17 seed files consumed by startup owner-file hydration (`src/system/config/startup-owner-files.ts:289-400`) for first-boot seeding only — sanctioned (specifications.md:107) and shipped in the image for opt-in Helm bootstrap (`bootstrap.seedOwnerFiles`, default false, per chart README). Runtime loading fails closed on missing owner files (`load-or-seed.ts:100-116`); seeds never overwrite.
- **`docker/docker-compose.yml` / `.production.yml` / `.smoke.yml` and `proxy/`**: active, documented lanes — smoke (`docs/setup.md:56-149`), host-docker production wired to `npm run agent:docker` and verified by `scripts/verify-agent-docker-isolation.mjs`, proxy via `npm run proxy:up`. Distinct from the k3s authority but not pretending to be it.
- **`src/persistence/journals/journal/legacy-source.ts` and `src/persistence/sessions/store/legacy-import.ts`**: these implement the **legacy chat import feature** (importing history from external sources) — "legacy" names the source data, not a code path to retire.
- **`src/system/config/fleet-auth-legacy-surface-guard.ts`**: a guard *against* legacy surfaces, not one itself.
- **Memory extraction `legacy` mode** (flagged in `working_docs/pi_glm_review_626.md` and bead `psfn-framework-q19`): **already fixed** — `src/faculties/memory/extraction/types.ts:82` now types `compositionalMode: 'single_pass' | 'chunk_compose'`; remaining "legacy" hits in that directory are test descriptions and a recovery-ceiling comment. Bead q19 looks delivered; recommend closing it (cross-lane: beads hygiene).
- **Contacts `privacyLevel` deprecated fields**: intentionally retained as provenance evidence with "column removal is a later cleanup bead" documented in place (`src/core/contacts/types.ts:31-39`). Tracked debt, not a violation.
- **`unknown`-typed and `?? fallback` parameter defaults** throughout `src/core/**` (e.g. `clampLimit(value, fallback)`): ordinary defensive normalization, not legacy paths.
- **Deprecated settings fields remaining in the schema** (`settings-contract.ts:373-388`): flagged only for missing removal criteria (m5); their presence is guarded and intentional.
- **`.fallow/`, `.svelte-kit/`, `dist/`, `data/`**: gitignored local tool/build/runtime residue, not tracked code.

Candidates needing human verification: M1 (operator intent for k8s/), M2 (non-fleet Garden support policy), m6 (`tokensUsed` external consumers), m3 (whether the three migrate commands have completed on every live install).

## Cross-lane notes

- **Dead-code lane**: `loadOrSeedJson`/`loadOrSeedJsonCached` (m1) and the backup alias constants (m2) are zero-caller exports — knip should corroborate. Bead `psfn-framework-q19` appears delivered and closable.
- **Docs/comments lane**: stale "SQLite" claim at `docs/shakedown.md:255` (m7); `k8s/README.md` presents an unmaintained-topology production overlay as a quickstart (M1 doc aspect).
- **Defensive-code lane**: warn-and-continue per-file error handling in `layout.ts` migrations (lines 571, 602, 628, 1017) — I judged it sanctioned, but the lane may want to double-check the swallowed-error policy reading.
- **Types/weak-types lane**: deprecated-but-live settings projections (m5) and `tokensUsed` (m6) are type-surface debt.
- **Dedup lane**: k8s/ vs Helm (M1) and Garden legacy vs fleet auth (M2) are the two true parallel implementations; everything else I checked was sanctioned or single-path.
- **Cycles/architecture lane**: nothing legacy-specific found; no new import-graph seams observed in the files I read.
