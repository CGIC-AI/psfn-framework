# Lane 1 — Deduplication & DRY audit

- **Date:** 2026-08-05
- **Branch/worktree:** `feat/emosim-fleet-shakedown`, working tree as-is
- **Posture:** read-only. No files modified; no tests/builds/gates run.

---

## Scope & method

Hunting grounds assigned: (a) gateway/agent intake mirroring, (b) Postgres store
boilerplate, (c) config/owner-file loaders, (d) channel adapters
(discord/telegram/api), (e) duplicated helper functions vs `src/shared/utils/`,
(f) Garden route boilerplate (`src/operator/garden/routes/`), (g) copy-pasted
error-handling/logging shapes. I also spot-checked the two UIs
(`admin-ui/src/lib/api`, `companion-ui/src/lib`) and the kube lifecycle trio.

Exact techniques used:

- Repeated-symbol census:
  `grep -rn "function safeInteger\|function requireUuid\|function requirePositiveInteger\|function requireNonEmptyString\|function normalizePositiveInt\|function toPositiveInteger\|function clampInt\|function clamp(" src --include=*.ts | grep -v test`
- Same-shape file comparison:
  `diff` of `src/channels/discord/clarification.ts` vs `src/channels/telegram/clarification.ts`
  (with channel names normalized); side-by-side `sed` reads of the kube lifecycle files,
  Garden route modules, and Postgres stores.
- Loader-pattern census:
  `grep -rln "loadOrSeedJson\|loadRequiredJson" src/system/config/`,
  `grep -rn "JSON.parse(fs.readFileSync\|JSON.parse(readFileSync" src`.
- Error-shape census:
  `grep -c "toSanitizedMessage(error" src/operator/garden/routes/*.ts`,
  `grep -rn "function errorMessage" src`.
- Intent checks: module-header comments in `src/boundary/gateway/intake/*.ts` and
  `src/core/cogsec/intake/*.ts` (the htm9.x design contract), `AGENTS.md` rules 1/3/5/7,
  `docs/specifications.md` (grep for `loadOrSeed`, `shared/contracts`, `intake`),
  prior audits in `working_docs/READONLY_AUDIT_*_20260721.md` (no dedup leads found there;
  all findings below were derived and verified independently).

**Coverage limits:** I did not enumerate every duplicated literal or every route
handler; counts below come from the greps above and are exact for the patterns named.
I did not deeply audit `PSFN-Satellite-Hub` (Python) internals, `scripts/` (55+
entries), or test-file duplication. `npx tsc`/`knip` were not run (too slow for this
pass; also other lanes own types/dead-code). Every cited line was opened and read.

---

## Critical assessment

No correctness-critical duplication was found (no two divergent copies of a
security decision). All findings are maintainability/deepness issues. Ranked:

### MAJOR 1 — The positive-integer normalizer is reimplemented ~30 times, and two "shared" versions already exist but are barely/un- used

**Evidence.** A census of `normalizePositiveInt(eger)` / `toPositiveInteger` /
`toPositiveIntegerQueryNumber` definitions (all verified by reading the grep hits):

- Fallback family (`value | undefined, fallback`):
  `src/boundary/gateway/discord-startup.ts:75`, `src/boundary/gateway/voice-stream-request.ts:345`,
  `src/faculties/memory/retrieval/episodic.ts:720`, `src/faculties/memory/social-graph/graph-builder-worker.ts:139`,
  `src/faculties/memory/episodic/synthesis.ts:214`, `src/faculties/memory/sleeptime-agent.ts:210`,
  `src/core/emotion/audio-classifier.ts:480`, `src/system/capabilities/safeguards.ts:72`,
  `src/system/capabilities/confirmation-queue.ts:232`, `src/shared/resilience/circuit-breaker.ts:120`,
  `src/core/intention/appraisal/shared.ts:4` (**exported**, used only inside `src/core/intention/`).
- Throw-with-field family (`unknown, field`):
  `src/faculties/wiki/store.ts:240`, `src/faculties/introspection/postgres-store-records.ts:97`,
  `src/faculties/subagents/faculty.ts:1741`, `src/boundary/gateway/intake/injection-classifier.ts:133`,
  `src/core/emotion/appraisal.ts:154`, `src/system/config/skills-config.ts:25`,
  `src/system/config/partner-affect-shadow-config.ts:43`, `src/system/config/scheduler-config.ts:1043`,
  `src/persistence/journals/reflection-substrate.ts:240`.
- Optional family (`unknown` → `number | undefined`):
  `src/faculties/memory/embedding.ts:175`, `src/shared/context-budget.ts:181`,
  `src/primitives/llm/routing.ts:199`, `src/primitives/llm/model-hint-routing.ts:486`,
  `src/boundary/sandbox/execution/shell-execution-policy.ts:77`,
  `src/core/agent/post-turn-subagent-spawn.ts:6`, `src/core/cogsec/lineage.ts:152`,
  `src/shared/authenticity-provenance.ts:28`,
  `src/system/settings/coercion.ts:29` (**exported, zero importers** — verified
  `grep -rn "from.*settings/coercion" src | grep -v test | wc -l` → 0).
- Query-param family: `src/operator/garden/api-routes.ts:121`,
  `src/operator/garden/routes/overview-routes.ts:70` (same name, same job).

**Why it matters.** This is the single most-duplicated helper in the codebase.
Three semantic families (fallback / throw / optional) plus string-parsing variants
(`coercion.ts:29` parses strings; most others don't) mean each new module rolls its
own and may pick subtly different coercion (e.g. `Math.floor` at
`discord-startup.ts:77` vs strict `Number.isInteger` elsewhere). Two consolidation
attempts already happened and both failed to be adopted — the pattern of "add a local
copy" is actively winning over "find the shared one," which is exactly what
`AGENTS.md` rule 5 (extend existing primitives) is meant to prevent.

**Recommended home.** One canonical module — either extend
`src/shared/utils/numeric.ts` (already the home of `clamp*`, already imported by ~10
files) or a new `src/shared/utils/numbers.ts` — exporting three explicitly named
functions: `toPositiveInteger(value: unknown): number | undefined`,
`positiveIntegerOr(value, fallback)`, `requirePositiveInteger(value, field): number`.
Migration is mechanical per call site but each of the ~30 sites must be checked
against the exact local semantics (floor-vs-strict, string parsing, min bounds).

### MAJOR 2 — Postgres row-guard helpers duplicated across 10 stores, in 4 semantic variants; one exact duplicate of an exported util

**Evidence (all files opened and read):**

- `safeInteger` defined 10 times:
  - throw-with-field: `src/persistence/postgres/icp-initiation-candidate-store.ts:56`,
    `icp-fatigue-regulation-reservation-store.ts:69`, `speaking-arbiter-store.ts:161`,
    `partner-affect-shadow-store.ts:67`, `icp-shared-autonomy-store.ts:159`,
    `social-pot-store.ts:67` (identical bodies);
  - throw-with-field, `unknown` input, `>= 0` bound:
    `background-work-store.ts:150`;
  - throw, `>= 1` bound, different message: `fleet-auth/oauth-session-store.ts:41`;
  - **returns `null` instead of throwing** (no `field` param):
    `icp-local-policy-authority.ts:109`, `icp-initiation-policy-authority.ts:69`
    (identical bodies).
- `requireUuid` defined 8 times, all delegating to `isRfc4122Uuid` from
  `src/shared/utils/types.ts:13`: `src/shared/contracts/icp-autonomy.ts:257`,
  `src/core/icp/initiation-candidate.ts:106`, `src/core/icp/local-policy-contract.ts:135`,
  `src/boundary/gateway/icp-autonomy-contract.ts:127`,
  `src/boundary/fleet-auth/recovery-request-capability.ts:285`,
  `src/boundary/fleet-auth/request-capability.ts:423`,
  `src/persistence/postgres/speaking-arbiter-store.ts:123`,
  `src/persistence/postgres/icp-initiation-candidate-store.ts:62`.
  Bodies are line-identical except that `recovery-request-capability.ts:285` calls a
  local `reject(...)` instead of `throw new Error(...)`.
- `requirePositiveInteger`: `icp-initiation-candidate-store.ts:67`,
  `icp-shared-autonomy-store.ts:170`, `icp-fatigue-regulation-reservation-store.ts:42`,
  plus the `unknown`-input variant `src/boundary/fleet-auth/hub-device-assertion.ts:432`.
- **Exact duplicate of an existing export:** `quoteSchema` at
  `src/persistence/postgres/icp-initiation-policy-authority.ts:74-76` is
  byte-identical to `quotePostgresSchemaName` exported from
  `src/persistence/postgres.ts:54-57` (used 24 times elsewhere — the canonical
  helper exists and is adopted; this one store just didn't use it).

**Why it matters.** The null-vs-throw split is a real behavioral fork living under
one name: a maintainer copying `safeInteger` from the wrong store silently changes
error behavior of row decoding (throw = corrupt-row alarm; null = optional column).
`src/persistence/postgres.ts` already centralizes `queryRows`/`queryOne`/
`ensurePostgresSchema`/`runPostgresMigrations` (lines 352/361/232/314), so the
"where does shared store code live" question is already answered — these guards just
predate or bypass it.

**Recommended home.** `src/persistence/postgres.ts` (or a sibling
`src/persistence/postgres/row-guards.ts` if file size is a concern): export
`parseSafeInteger(value): number | null` and
`requireSafeInteger(value, field): number` (+ `requirePositiveInteger`,
`requireUuid`). For `requireUuid` used by contract/boundary parsers,
`src/shared/utils/types.ts` next to `isRfc4122Uuid` is the natural home
(`requireRfc4122Uuid`). The `quoteSchema` → `quotePostgresSchemaName` swap is a
pure mechanical one-line-per-site change with zero semantic risk.

### MAJOR 3 — `requireNonEmptyString` family reimplemented ~14 times

**Evidence (grep census; representative bodies read):**
`src/shared/net/mtls.ts:23`, `src/shared/telemetry/turn-performance.ts:380`
(assertion-signature variant), `src/shared/contracts/model-budget.ts:65`,
`src/system/config/companions-config.ts:149`,
`src/system/config/cogsec-persona-conformance-config.ts:31` (+`:38` array variant),
`src/boundary/integrations/shell/tools.ts:23`,
`src/boundary/integrations/vault/tools.ts:82`,
`src/boundary/integrations/journal/tools.ts:29` (named `requireNonEmpty`),
`src/shared/retrieval-query-embedding.ts:34`,
`src/faculties/memory/extraction/reflection-output.ts:6`,
`src/persistence/workspaces/shared-workspace-store.ts:127`, plus a plain-JS copy
inside the embedded worker template `src/boundary/gateway/session-integrity-worker-source.ts:228`
(that one is inside a `WORKER_SOURCE` string and likely must stay self-contained —
see Risks).

Two input families exist: `string | undefined` (env-var reading, e.g. `mtls.ts:23`)
and `unknown` (wire/owner-file validation, e.g. `companions-config.ts:149`). Both are
one-liners over the same check.

**Recommended home.** `src/shared/utils/strings.ts` (currently exports only
`uniqueStrings` — line 1) or `src/shared/utils/types.ts`. Two functions:
`requireNonEmptyString(value: unknown, field): string` and an env-flavored
`requireEnvString(value: string | undefined, field): string` — or one `unknown`
function, since `string | undefined` is a subtype. Mechanical.

### MINOR 4 — Garden route error/body boilerplate: 43 copies of the same rejection handler

**Evidence.** `sendJson(res, 500, { error: toSanitizedMessage(error, '<fallback>') })`
appears 43 times across 16 route modules (verified count via
`grep -c "toSanitizedMessage(error" src/operator/garden/routes/*.ts`), e.g.
`contact-routes.ts:29`, `image-routes.ts` (14 occurrences), `overview-routes.ts` (12),
`session-routes.ts` (10). The shape is always
`.then((data) => sendJson(res, 200, ...), (error) => sendJson(res, 500, { error: toSanitizedMessage(error, '...') }))`.
Additionally, positive-integer query parsing exists in three shapes:
`parsePositiveIntegerParam` (`session-routes.ts:29-46`, result-type),
an inline throw helper (`concern-routes.ts:62`), and an inline 400 send
(`partner-affect-shadow-routes.ts:53`).

**Assessment.** `toSanitizedMessage` itself is already shared
(`routes/shared.ts:15-20`) — good. The remaining duplication is the two-line
rejection callback. A `sendInternalError(res, error, fallback)` helper in
`routes/shared.ts`, plus promoting `parsePositiveIntegerParam` there, removes ~90
lines and, more importantly, kills the three divergent query-parse error channels
(400-with-message vs throw vs inline). Contained to one directory; mechanical.
Note: the explicit `.then(ok, err)` style is presumably deliberate to avoid
async-handler unhandled rejections — keep that discipline in the helper's
implementation.

### MINOR 5 — Kube lifecycle trio: identical `defaultSleep` ×3 and a re-implemented readiness wait

**Evidence.**

- Identical `defaultSleep` (unref'd `setTimeout`) at
  `src/system/lifecycle/kube-auto-rollback.ts:225-230`,
  `kube-helm-rollback.ts:72-77`, `kube-rollout-restart.ts:43-48`.
  (`src/shared/utils/timing.ts:1` exports `sleep` but without `unref`, so a direct
  swap changes process-liveness behavior — add an `unref` option or a
  `sleepUnref` export rather than blindly reusing.)
- `kube-rollout-restart.ts:71-92` re-implements `waitForDeploymentsReady`
  (exported at `kube-helm-rollback.ts:97-113`), including a byte-identical copy of
  the `describePending` message format (compare `kube-rollout-restart.ts:81-86` with
  `kube-helm-rollback.ts:79-89`). The restart version throws on timeout; the
  rollback version returns `{ ready: false, pending }` — a documented, deliberate
  difference (the helm-rollback comment at lines 91-96 explains the
  discriminated-result choice). Consolidation: have `waitForReadiness` call
  `waitForDeploymentsReady` and throw on `!ready`, and export `describePending`.
  Same directory, trivially testable. The mirror is even acknowledged in the
  `createKubeHelmRollbackExecutor` doc comment ("Mirrors the rollout-restart
  executor", line ~145).

### MINOR 6 — `clamp` reimplemented locally despite an adopted shared module; two parallel *exported* clamps in the memory domain

**Evidence.** `src/shared/utils/numeric.ts` exports `clamp`/`clampUnit`/`clampSigned`
and is imported by ~10 files (verified). Local reimplementations persist:
`src/faculties/memory/tools.ts:112` (`clamp`, NaN→midpoint fallback) **and** `:117`
(`clampInt`, NaN→min fallback) — two variants in one file;
`src/faculties/memory/boundary-log.ts:54`; `src/core/agent/fatigue/adaptive-tuning.ts:74`;
`src/shared/diagnostics/runtime-diagnostics.ts:154` (4-arg `unknown`+fallback variant).
More notably, two **exported** parallel clamps exist inside the same domain:
`src/faculties/memory/retrieval/scoring.ts:489` (`export function clamp`) and
`src/faculties/memory/extraction/config.ts:23` (`export function clamp`).

**Assessment.** The shared `clamp(value: unknown, ...)` defaults non-numbers to 0;
the locals differ in NaN fallback (midpoint vs min vs 0). The private locals are
nit-level; the real issue is the two *public* `clamp` exports in `faculties/memory`
— parallel public APIs for the same operation in one bounded context. Deprecate
both in favor of `numeric.ts` (with an explicit-fallback parameter if the NaN
behavior is load-bearing). Needs per-site semantic check; not a blind sed.

### MINOR 7 — `JSON.parse(readFileSync(...))` manifest/owner reading repeated ~30 times; no shared reader next to the shared writer

**Evidence.** ~30 non-test call sites (grep census; representative reads):
`src/persistence/backups/` alone has 7 with the same missing-file → parse →
`isRecord` shape — `backup-contents.ts:50-56`, `encryption.ts:149-156`,
`system-config-tree.ts:57-67`, `kubernetes-helm.ts:174`, `fleet-restore.ts:216,250`,
`fleet-auth-coordinator.ts:398`. Elsewhere:
`src/persistence/workspaces/shared-workspace-store.ts:175,189`,
`src/persistence/sessions/store/channel-index-storage.ts:100`,
`src/system/lifecycle/kube-rollback-store.ts:104`,
`src/system/lifecycle/kube-post-rollout-validation-store.ts:75`, etc.
`src/shared/utils/fs.ts:107` exports `writeJsonAtomic` but there is no reader
counterpart; the closest existing reader is the private `parseJsonFile` at
`src/system/config/load-or-seed.ts:85-88`.

**Assessment.** The owner-file loaders (system/config) are already consolidated via
`load-or-seed.ts` (15 modules use it — see non-findings). The remaining sites are
one-shot manifest/state readers that can't use `loadRequiredJson` (no validator
seam, different error wording). A `readJsonFileSync(path): unknown` in
`src/shared/utils/fs.ts` would standardize parse + error context while leaving
validation and messages at call sites. Low value per site but very low risk.
**Candidate — needs human verification** whether repo owners want a raw-JSON reader
in shared/utils at all (it could encourage bypassing the owner-file contract; the
backups modules are not owner files, so the contract doesn't apply to them).

### NIT 8 — Thin `errorMessage` wrappers around `toErrorMessage` in ~10 modules

**Evidence.** `function errorMessage(error: unknown): string { return toErrorMessage(error); }`
verbatim at `src/faculties/memory/tools.ts:108-110`,
`src/faculties/memory/tools/scratchpad.ts:16`, `src/faculties/north-star/tools.ts:29-31`,
`src/faculties/values/tools.ts:29`, `src/core/contacts/tools.ts:132-134`,
`src/core/intention/concern-route-handoff.ts:190`,
`src/core/intention/concern-route-adapters.ts:127`,
`src/core/scheduler/schedule-tool.ts:185`, `src/core/identity/prompt-tools.ts:100`.
`src/operator/garden/api-routes-shared-workspace.ts:13-15` defines the same wrapper
but re-implements the body (`error instanceof Error ? error.message : String(error)`)
instead of importing `toErrorMessage` from `src/shared/utils/errors.ts:5`.
Delete the wrappers (use `toErrorMessage` directly) or, if the short name is
load-bearing for readability, alias the import. ~30 lines, zero risk.

### NIT 9 — Exponential backoff triplicated

**Evidence.** `src/primitives/llm/retry.ts:111` (`backoffDelay`, private),
`src/boundary/gateway/discord-startup.ts:81-85` (`backoffDelayMs`, cap + non-finite
guard), `src/channels/telegram/adapter.ts:551-558` (`resolveNextPollDelayMs`, cap via
`MAX_POLL_BACKOFF_MS`). Same `base * 2^(attempt-1)`, capped formula. A
`backoffMs(base, max, attempt)` next to `sleep` in `src/shared/utils/timing.ts`
would serve all three. Low value (3 sites, 5 lines each); **candidate** — the
callers differ in whether attempt is 0- or 1-based, which is exactly the kind of
off-by-one a hasty consolidation introduces.

### NIT 10 — admin-ui endpoint modules hand-build query strings (15 files, 21 sites)

**Evidence.** `new URLSearchParams` appears 21 times across 15 of the ~40 modules in
`admin-ui/src/lib/api/endpoints/` (grep census; representative read
`endpoints/concerns.ts:35-41`): each repeats
`if (query.x !== undefined) params.set('x', String(query.x))` + `?`-suffix assembly.
`apiGet` (`admin-ui/src/lib/api/client.ts:143`) takes only a path. A
`withQuery(path, params)` helper in `client.ts` (skipping `undefined`) removes the
pattern. Contained, mechanical, no behavior change. (SvelteKit `$lib` is
admin-ui-internal; no cross-app sharing implied.)

---

## Recommendations

Ordered by value/effort. "Mechanical" = safe find-replace-per-site with existing
tests as the safety net; "design" = a semantic decision is required first.

1. **Create one canonical positive-integer coercion module** (`src/shared/utils/numeric.ts`
   extension or new `numbers.ts`) with three explicitly named functions
   (optional / fallback / require). Migrate the ~30 sites of MAJOR 1 in batches per
   directory. **Mechanical per site, but wide; needs a per-site semantics check**
   (floor-vs-strict, string parsing). Effort: 0.5–1 day including tests. Also delete
   or re-export the zero-importer `src/system/settings/coercion.ts:29` (see
   cross-lane notes).
2. **Add Postgres row-guards to `src/persistence/postgres.ts`** (`parseSafeInteger` /
   `requireSafeInteger` / `requirePositiveInteger` / `requireUuid`) and migrate the
   10 stores (MAJOR 2). Keep both null-returning and throwing forms under distinct
   names. Effort: ~2–3 h. **Start with the zero-risk `quoteSchema` →
   `quotePostgresSchemaName` swap** in `icp-initiation-policy-authority.ts`
   (lines 74, 128, 194, 304, 382, 387, 398) as a standalone first commit — pure
   deletion of a duplicate.
3. **Add `requireRfc4122Uuid` to `src/shared/utils/types.ts`** next to
   `isRfc4122Uuid`; migrate the 8 `requireUuid` copies (MAJOR 2). One wrinkle:
   `recovery-request-capability.ts:285` throws via a local `reject()` with possibly
   different error typing — check its `reject` before swapping. Effort: ~1 h.
4. **Add `requireNonEmptyString` to `src/shared/utils/strings.ts`**; migrate the ~14
   sites (MAJOR 3), excluding the embedded `WORKER_SOURCE` copy. Effort: ~2 h.
5. **Garden routes: add `sendInternalError` + shared `parsePositiveIntegerParam` to
   `routes/shared.ts`** (MINOR 4). Mechanical, one directory. Effort: ~2 h.
6. **Kube lifecycle: export `describePending`, reuse `waitForDeploymentsReady` in
   `kube-rollout-restart.ts`, factor one `defaultSleep`** (MINOR 5). Design-lite
   (throw-vs-result is already documented; preserve it). Effort: ~1 h.
7. **Merge the two exported memory-domain `clamp`s into `numeric.ts` usage**
   (MINOR 6); leave private NaN-fallback clamps alone unless touched. **Design
   decision:** whether NaN-fallback behavior is load-bearing per call site.
   Effort: ~2 h.
8. **Delete the ~10 `errorMessage` wrappers** in favor of `toErrorMessage`
   (NIT 8). Mechanical. Effort: <1 h.
9. **`readJsonFileSync` in `shared/utils/fs.ts`** (MINOR 7) — do only if the owners
   accept a raw JSON reader in shared utils (see candidate note). Effort: ~2 h.
10. **admin-ui `withQuery` helper** (NIT 10). Mechanical. Effort: ~1 h.
11. **Shared `backoffMs`** (NIT 9) — optional, lowest priority. Effort: ~1 h.

Nothing here requires cross-process coordination; items 1–3 touch
`src/shared/utils/` and `src/persistence/`, so per repo rules they need
accompanying tests in the same style as existing `*.test.ts` siblings and should
respect the `verify:hardcoded-settings` gate (no new policy literals — these are
pure functions, so fine).

---

## Risks & false positives

**Deliberately NOT flagged (verified intent):**

- **Gateway vs core intake "mirroring" (`src/boundary/gateway/intake/` vs
  `src/core/cogsec/intake/`) — deliberate, documented.** The split is the htm9.x
  architecture: the gateway is the secret holder, so the L2/L3 tool-less OpenRouter
  screeners live gateway-side (`l2-screener.ts:10-14`, `escalation.ts:14-17`), while
  the envelope state machine and sink gates live agent-side (`screening.ts`,
  `sink-gates.ts`). The gateway implements an agent-owned port interface
  (`IntakeEscalationPort` imported from core at `escalation.ts:30-36`), and the
  shared taxonomy/contract lives in `src/shared/contracts/intake-envelope.ts`.
  This is process-boundary design, not duplication. The L1 deterministic scanners
  (`core/cogsec/intake/scanners/`) and the L1.5 ML scorer
  (`boundary/gateway/intake/injection-classifier.ts`) are different tiers, not copies.
- **Discord vs Telegram clarification — genuinely different mechanisms.** Discord
  uses button components with a custom-id protocol and fail-closed index resolution
  (`discord/clarification.ts:20-62`); Telegram has no inline-keyboard scaffolding in
  this adapter and uses a numbered-list + reply-parse flow
  (`telegram/clarification.ts` header). The shared contract (`PendingClarification`)
  is already centralized in `src/boundary/gateway/protocol.ts`. Merging renderers
  would couple channel-specific UI logic — wrong direction.
- **Config owner-file loaders — already consolidated.** 15 modules in
  `src/system/config/` load through `loadRequiredJson`/`loadRequiredJsonCached` in
  `load-or-seed.ts`. The remaining `readFileSync` users there
  (`settings-contract-guard.ts:46`, `settings-owner-backfill.ts:32`,
  `seed-defaults.ts:74`, `settings-overlay.ts:190`,
  `intake-policy-owner-migration.ts:62`) are migration/guard tools with different
  contracts, not owner-file loads.
- **Postgres connect/schema/migration boilerplate — already consolidated** in
  `src/persistence/postgres.ts` (`createPostgresPool`, `ensurePostgresSchema*`,
  `runPostgresMigrations`, `queryRows`/`queryOne`) and `tenancy.ts` (519 lines of
  shared tenancy logic). The per-store `connect()` wrappers are thin and
  type-distinct; MAJOR 2 flags only the guard helpers, not the store structure.
- **admin-ui vs companion-ui websocket/stream clients — different servers and
  protocols** (`admin-ui/src/lib/api/websocket.ts` ↔ Garden WS;
  `companion-ui/src/lib/stream/hub-stream.ts` ↔ satellite hub), separate
  deployables with separate build tooling. Do not merge.
- **`channels/shared/reaction-surface.ts` and `long-running-tool-status.ts`** already
  factor the shared channel logic the assignment asked about; no action.
- **`unknown`-typed trust-boundary parsers with local guards** (e.g. the
  fleet-auth capability modules) are per AGENTS.md the correct pattern; MAJOR 3
  only proposes hoisting the *identical* guard body, not changing types.

**Candidates needing human verification:**

- The `readJsonFileSync` shared reader (MINOR 7) — policy question about encouraging
  raw JSON reads outside the owner-file contract.
- The plain-JS `requireNonEmptyString` inside the `WORKER_SOURCE` template
  (`src/boundary/gateway/session-integrity-worker-source.ts:228`) — embedded worker
  sources likely must stay dependency-free; I did not verify the worker bundling
  constraints.
- Whether `coercion.ts`'s string-parsing `toPositiveInteger` semantics should be the
  canonical one (it is the most lenient of the family).
- Shared `backoffMs` (NIT 9) — attempt-base off-by-one risk on migration.

**Risks of the recommendations themselves:**

- MAJOR 1/2 consolidations touch security-adjacent validation (intake classifier,
  fleet-auth capabilities, ICP stores). Each site migration must preserve the exact
  error type/message where tests assert on them — I saw error-message assertions in
  the neighborhoods I read, so expect test churn if messages change.
- None of these changes should land as one giant PR; the repo's 25-file/1,500-line
  PR budget implies batching per directory.

---

## Cross-lane notes

For the operator to cross-reference with other audit lanes:

- **Dead code lane:** `src/system/settings/coercion.ts:29` `toPositiveInteger` (and
  possibly siblings in that file — I only verified this one) is exported with **zero
  importers** (verified by grep). The deprecated `loadOrSeedJson` /
  `loadOrSeedJsonCached` wrappers (`src/system/config/load-or-seed.ts:122-128`,
  `:206-212`) have **zero callers anywhere in `src/` or `scripts/`** (verified by
  grep; docs/specifications.md does not name them as part of the alpha migration
  boundary). Candidates for removal per AGENTS.md rule 3.
- **Hygiene lane (anomaly found incidentally):** four tracked `.ts` files contain
  NUL bytes and are detected as binary (`file` reports "data"):
  `src/faculties/wiki/shared-pgvector-projection.ts` (538 NUL bytes),
  `src/system/config/fleet-auth-config.ts`,
  `src/boundary/fleet-auth/request-capability-target.ts`,
  `src/core/eval/observer-sidecar/persistence.ts`. This breaks grep-based tooling
  (I hit "binary file matches" warnings during this audit) and smells like an
  editor/encoding accident. Not a dedup issue; flagging for whoever owns repo
  hygiene.
- **Weak-types lane:** several of the duplicated guards exist *because* call sites
  type rows loosely (`string | number` pg numerics, `unknown` wire values). A
  shared row-decoding codec would subsume MAJOR 2 — flagging the overlap so the two
  lanes don't produce conflicting recommendations.
- **Legacy lane:** the `loadOrSeedJson` deprecation (above) is the only
  legacy-shim-shaped item I encountered; the deprecation comment claims a policy
  ("Runtime config must not seed itself") that is enforced in
  `loadRequiredJson` — so removal is safe once the dead-code lane confirms zero
  external callers (e.g. deployment scripts outside this repo).
- **Comments/slop lane:** module-header comments in the intake firewall are
  exemplary (they're how I verified intent); no slop found in the files I read.
