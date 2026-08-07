# Lane 6 — Defensive Programming / Try-Catch Audit

Date: 2026-08-05. Branch audited: `feat/emosim-fleet-shakedown` (working tree as-is). Read-only audit; no files were modified except this report.

## Scope & method

**Mechanical census.** A brace-counting Python scanner (run inline via `python3 -`, no files created) extracted every `catch` block body and classified it: `RETHROW`, `RETURN-VALUE`, `RETURN-DEFAULT(null|false|true|undefined|[]|{}|'')`, `LOG-ONLY`, `EMPTY` / `EMPTY(comment-only)`, `OTHER`. Test files (`*test*`, `__tests__`, `*.spec.*`) were excluded.

Coverage counts (catch blocks, tests excluded):

| Tree | Catch blocks | RETHROW | RETURN-VALUE | OTHER | LOG-ONLY | RETURN-DEFAULT | EMPTY(comment-only) |
|---|---|---|---|---|---|---|---|
| `src/` | 1,758 | 699 | 415 | 308 | 258 | 177 | 41 |
| `admin-ui/src` | 242 | 6 | 12 | 122 | 82 | 5 | 15 |
| `companion-ui/src` | 23 | 3 | 1 | 5 | 8 | 3 | 3 |
| `PSFN-Satellite-Hub` (src/client/scripts TS) | 52 | 12 | 1 | 12 | 22 | 2 | 3 |

Separate greps covered `.catch(() => …)` promise handlers (~60 in `src/`, ~30 across the other trees), retry loops (`attempt`/`maxRetries` patterns), and process-level handlers (`uncaughtException`/`unhandledRejection`).

**Deep reading.** Every `EMPTY(comment-only)` block in `src/` (41/41) was opened and read. All catch blocks in `src/core/cogsec/` were enumerated (41) and every suspicious one read in context (~20 files). In the other priority directories the following fractions of flagged instances were read in full context: `src/persistence/` ~35 instances across sessions/journals/backups/postgres; `src/boundary/gateway/` ~30 instances including every security-relevant gate; `src/core/scheduler/` ~20 instances; `src/core/agent/` ~15 instances; both UIs: all `EMPTYC`/`RETD` instances and samples of `LOGONLY`. `LOG-ONLY` is the least-audited bucket: ~80 of 258 in `src/` were opened; the rest were sampled by directory and the pattern (warn-log + continue on auxiliary/telemetry/hook paths) was consistent everywhere checked.

**Intent checking.** `docs/cognitive-security.md` (fail-closed doctrine; the documented `fail open-advisory` posture for L1.5 scorer failure, line ~239), `docs/specifications.md` alpha migration boundary (legacy journal source migration named ~lines 117–162), and AGENTS.md rules were consulted before judging any pattern.

**Limits.** I did not run tests, builds, or gates (per audit rules). Classification of `OTHER`/`RETV` blocks (723 in `src/`) relied on sampling; these are dominated by catch-and-respond (HTTP error replies) and catch-wrap-rethrow shapes that the classifier could not distinguish from true rethrows. Python source in `PSFN-Satellite-Hub` (`try/except`) was not mechanically scanned — noted as a coverage gap below.

## Critical assessment

**Headline: this codebase's error-handling discipline is unusually strong.** The overwhelming majority of catches are legitimate: they catch genuinely external/untrusted failure surfaces (fs, network, JSON.parse of model output, child processes, Postgres) and do something meaningful — propagate with context (often `AggregateError` preserving both primary and cleanup errors), fail closed with a loud log, quarantine, or record structured telemetry. CogSec paths were specifically verified to fail closed (details in the cleared list below). I found **no critical** error-hiding and **one major** pattern, both in the admin UI rather than the runtime.

### Major

**M1. admin-ui settings: failed owner-file fetches are silently rendered as `{}` in the raw JSON editors.**
`admin-ui/src/routes/settings/SettingsPageController.svelte:990-997` (reload path) and `:1252-1259` (onMount path) — sixteen instances of:

```ts
getSubConfig('providers').catch(() => '{}'),
getSubConfig('channels').catch(() => '{}'),
… 6 more owner files …
```

`getSubConfig` throws on any non-OK response (`admin-ui/src/lib/api/endpoints/settings.ts:88-97`). What failure is hidden: an auth expiry, 5xx, or network error fetching e.g. `trust-policy.json` is converted into the literal text `{}`, which then populates the raw editor for that owner file with no error surfaced anywhere (the outer `catch` at :1273 only fires if `getSettings()`/`getSettingsSchema()` fail — the sub-config failures can never reach it). The operator sees a blank-looking `trust-policy.json` / `providers.json`. Mitigation that already exists: only *dirty* editors are written back (`dirtyRawEditorKeys()` at :846 compares against the baseline), so an untouched `{}` is not saved — but the moment the operator types into that editor and saves, the real owner file is replaced with near-empty content, and there is no indication the starting content was a fetch failure rather than reality. This is exactly "catch that returns a default and continues as if success." Correct behavior per repo rules: surface the failure per-editor (error placeholder + disable editing/saving that key) — settings mutation is a trust/policy surface and must not fail open visually. Roughly 16 mechanical sites behind 2 call clusters; fix is a small design decision (error state UX), not a big change.

### Minor

**m1. `src/faculties/wiki/store.ts:445` — projection hook error swallowed with no log at all.**
In `upsert`, the `onUpsert` search-projection callback is wrapped in `try { … } catch { // Fail closed for search only; the write itself has succeeded. }`. Every comparable path in this repo at least emits `log.warn`; this one emits nothing. A persistently failing projection (e.g. pgvector outage) leaves search silently stale forever — invisible divergence between the canonical store and the index. The catch itself is defensible (write already committed; projection is best-effort), the *silence* is not. Mechanical one-line fix: add `log.warn`.

**m2. `src/system/config/load-config.ts:739` — malformed `RESPONSE_STYLE_OVERRIDES` env JSON is silently ignored.**
`parseResponseStyleOverridesEnv` catches JSON.parse failure and returns `undefined` with no log (called at `load-config.ts:299`). An operator typo in this env-owned bootstrap override silently reverts to default response styles — a config change that does nothing and says nothing. Repo rule for env bootstrap overrides is that they are explicit; a malformed explicit override should fail startup or at least log a warning. One-line fix (`log.warn` on the catch, or throw — design call since startup strictness is a policy decision).

**m3. Process-level `unhandledRejection: log and continue` converts all fire-and-forget background failures into single log lines.**
`src/app/startup/support/signal-shutdown.ts:29-31` (policy documented in the comment at :22-25: "Fire-and-forget background paths … must not crash the companion"). This is deliberate and documented, so not flagged as a violation — but its systemic effect is that any background promise that rejects persistently (a wedged extraction lane, a broken Postgres listener) produces one error log per occurrence, forever, with no counter, rate-limit note, or operator alert. Combined with the pervasive `void promise.catch(() => undefined)` fire-and-forget idiom (~60 sites), background-task degradation can be invisible to anyone not reading logs. Candidate for a telemetry counter / repeated-failure escalation, not removal. **Needs human verification** that the ops alerting pipeline actually watches these log lines.

**m4. Status-message sends swallowed with comment-only catches in both channel adapters.**
`src/channels/telegram/adapter.ts:1065` ("Ignore status send failures to avoid blocking primary response flow") and `src/channels/discord/adapter.ts:1494,1506` (same for status send and status cleanup). Cosmetic-only feature, so the catch is legitimate, but zero logging is inconsistent with the repo's otherwise-universal warn-on-swallow norm; a broken token/permission would silently disable all status UX. Nit-level; add `log.debug` at most.

### Nits

**n1. `src/core/session/manager/compaction-service.ts:250` and `src/core/scheduler/temporal-wakeup.ts:836`** return `''` on summary-generation failure. Both warn-log and the empty string is handled downstream as "no enrichment" — verified legitimate, noting only that `''` as the failure sentinel is fragile if a future caller treats empty as success-with-content.

**n2. `src/channels/backplane/shard-parent-icp-ingress.ts:53`** — `for (let attempt = 1; ; attempt += 1)` retries `agentLoop.handleMessage` forever while the parent is busy, bounded only by `waitForIdle()` resolving. Deliberate ("holding shard ICP until the active turn finishes"), logged per attempt; a permanently-busy parent holds the shard message indefinitely with no overall deadline. Candidate — likely fine given turn timeouts elsewhere, but worth a human glance.

## Recommendations

Ordered, with effort estimates:

1. **Fix M1 (admin-ui settings `{}` fallback)** — design decision needed (per-editor error state in `SettingsPageController.svelte`; simplest form: track failed keys, show an error banner in that editor tab, exclude failed keys from the dirty/save path so they can never be written back). Effort: ~0.5–1 day including the save-path guard. Highest value: it sits on the trust-policy/owner-file mutation surface.
2. **Add the missing `log.warn` in `src/faculties/wiki/store.ts:445`** — mechanical, minutes. Consider a repo-wide sweep for `catch {` blocks whose body is only a comment (41 exist; this is the only one I found where the swallowed error has ongoing-divergence consequences and no telemetry).
3. **Warn or fail on malformed `RESPONSE_STYLE_OVERRIDES`** (`load-config.ts:739`) — mechanical to log; failing startup is a policy decision. Minutes to log.
4. **Add a repeated-failure signal for background rejections** — e.g. a counter on the `unhandledRejection` handler and the `LOG-ONLY` catch sites in scheduler lanes, surfaced to operator alerts after N occurrences. Design decision, ~1–2 days. This addresses the systemic m3 rather than any single site.
5. **Standardize the fire-and-forget idiom** — ~60 `.catch(() => undefined)` sites are individually fine (cancellation, cleanup, typing indicators), but a shared `swallowForCleanup(promise, logContext)` helper that at least debug-logs would close the m4-class gaps mechanically. Optional; ~0.5 day, touches many files (conflicts with the 25-file PR budget — would need splitting).

Safe mechanical changes: 2, 3 (log-only variant). Need design decisions: 1, 4, 3 (fail-startup variant), 5.

## Risks & false positives

**Deliberately NOT flagged, after reading each in context (the cleared-legitimate list):**

- **All CogSec catches reviewed are legitimate.** Verified fail-closed: escalation-port failure forces quarantine with the failure on the envelope (`src/core/cogsec/intake/screening.ts:759-783`); corrupt quarantine/drift-card files throw (`quarantine-store.ts:539-552`, `drift-review-card-store.ts:444-455`); canary egress scan errors return `leaked: true` (`canary/egress-scan.ts:91-95`); per-scanner failures are recorded in `scannerErrors` on every report (`scanners/index.ts:181-187`); the L1.5 scorer failure and rule-engine reload failure are the *documented* `fail open-advisory` posture (`screening.ts:834-845`, `rule-engine.ts:364-369`, per `docs/cognitive-security.md` ~line 239), with errors recorded on the envelope/report — not swallowed. Audit-hook catches (`sink-gates.ts:432`, `contact-block-gate.ts:71`, `canary-egress-guard.ts:161`) log errors and deliberately don't let a broken audit hook flip a security decision. Per-contact drift-scan skips log loudly and the watermark is only advanced on scan success (`drift/drift-review-lane.ts:248-258`).
- **Empty catch for best-effort cleanup after the real error is already propagating** — the dominant EMPTYC pattern: `unlinkSync(tmpPath)` inside a catch that rethrows (`src/shared/utils/fs.ts:90-92,122`, `src/persistence/journals/journal/file-io.ts:891`, `src/app/cert-manager/service.ts:78,94`, `src/system/lifecycle/kube-post-rollout-validation-store.ts:28`, `src/core/agent/tool-conformance/store.ts:29`). Legitimate; the original error is never masked.
- **Parse-or-fallback catches on untrusted/optional input** — JSON.parse of model output with strict validation afterward (`src/core/icp/initiation-consent-evaluator.ts:28,38`, `src/core/intention/social-desire-consent-evaluator.ts:58`, `src/core/scheduler/free-time-chooser.ts:409` — `null` maps to fail-closed rest/defer), `new URL()` probes (`url-policy.ts:219`, `bootstrap-input.ts:176`, `voice-websocket-runtime.ts:401`), PATH/executable probing (`shell-execution-policy.ts:104,401`, `faculties/skills/filter.ts:92`), optional metadata sidecars (`images-service.ts:114`, `generated-media.ts:329`), `pathExists`/`statSync` predicates (`methods/fs.ts:130`, `owner-file-reload-watcher.ts:107`).
- **Non-throwing predicate wrappers around throwing validators** — `isShardExceptionalAction` (`system/capabilities/shard-approval-grant-policy.ts:129`, documented as the probe twin of the throwing resolver; the denial path itself is fail-closed), `isSpiffeUri` (`shared/net/mtls.ts:180`).
- **Fail-closed false returns with telemetry** — welfare-grant verification failure strips `preemptionProtected` and logs (`boundary/gateway/methods/llm.ts:220`); `canSurfaceUpstreamUpgradeFailure` defaults to the restrictive answer (`fleet-sso-router.ts:867`).
- **Catch-collect-then-AggregateError resource-release patterns** — `cross-process-write-lock.ts:331-374`, `turn-record-eligibility-fence.ts:87-171`, `fleet-restore-database-marker.ts:62-94`, `icp-local-policy-authority.ts:375-391`, `disposeCompositions` (`intake/fleet-screening.ts:77`). These are exemplary.
- **Scheduler/lane LOG-ONLY catches** — enrichment/telemetry/hook failures with warn logs (`post-turn-runtime.ts:236,423`, `free-time.ts:737`, `reflection-template-runtime.ts` ×10, `scheduler.ts:498` drain during shutdown). The operation that matters is never gated on these.
- **Legacy JSON→JSONL fallback** (`persistence/journals/journal/legacy-source.ts:189`) — sanctioned by the alpha migration boundary in `docs/specifications.md` (~lines 117–162).
- **Batch→per-record embedding fallback** (`faculties/memory/writer.ts:1380`) — warn-logged degradation to a slower equivalent path; acceptable, though a persistent embedding-service failure will quietly double import latency (noted, not flagged).
- **Memory journal per-line parse quarantine** (`persistence/sessions/turn-records.ts:1238`, `faculties/values/store.ts:646`) — malformed lines are quarantined/skipped with error logs and sidecar records; turn-record-identity treats unprojectable rows as ambiguity, never absence (`turn-record-identity.ts:401,422`) — genuinely fail-closed.
- **UI catches** — localStorage guards (`admin-ui auth-storage.ts:16`, `+layout.svelte:89,252`, `floating-save.ts:82,97`), response-body best-effort reads (`.catch(() => '')`), parse-then-validate protocol envelopes returning `undefined` to the validator below (`companion-ui gateway-protocol.ts:118`), audio node teardown (`voice-playback-controller.ts:235`), transport-error-event ownership comments (`companion-ui App.tsx:416,426`). All appropriate for UI code.
- **`void … .catch(() => undefined)` fire-and-forget** — sampled ~30 of ~60; all were typing indicators, status-message cleanup, cancellation propagation, stream teardown, or chain-continuation where the error still reaches the original awaiter (e.g. `social-graph/proposals.ts:206` — `mutationChain` swallows only the chain-continuation copy; `next` still rejects to the caller).
- **Retry loops** — `agent-backend.ts:776` retries an empty provider response exactly once then fails closed with a 502 diagnostic; `primitives/llm/retry.ts` is bounded (`DEFAULT_MAX_RETRIES = 3`); `fallback.ts` logs every candidate failure and throws on exhaustion in both `run` and `runStream` (verified `handleCandidateFailure` throws on last attempt — `runStream`'s missing post-loop throw is safe because of it).

**Coverage gaps / candidates needing human verification:**

- **Python `try/except` in `PSFN-Satellite-Hub` was not mechanically scanned** (only its TS). If the operator wants symmetric coverage, that's a follow-up.
- **m3** assumes no external log alerting; if ops already alerts on `Unhandled promise rejection` / repeated lane errors, downgrade to nit.
- The `OTHER`/`RETV` buckets (~723 blocks in `src/`) were sampled, not exhaustively read; the samples were uniformly legitimate (HTTP error responses, wrap-and-rethrow), but I cannot claim 100% coverage there.
- `src/faculties/wiki/store.ts:445` (m1): if the projection hook is itself internally logged by the callee, the missing outer log is harmless — I did not trace every `onUpsert` implementation; marked accordingly as needs-verification in spirit, though the call-site silence is real.

## Cross-lane notes

- **Comments/slop lane:** the catch-block comments in this repo are exceptionally informative (many cite bead IDs and design contracts) — worth noting as a positive outlier; a few are doing the work a log line should (m1, m4 above).
- **Dead-code lane:** none found here, but the sixteen-site duplicated `getSubConfig(...).catch(() => '{}')` blocks in `SettingsPageController.svelte` (:990-997 and :1252-1259) are a copy-paste cluster the dedup lane should record alongside the M1 fix.
- **Types lane:** several catches type-narrow via `error instanceof Error ? … : String(error)` inline; a shared guard exists (`toErrorMessage`) and is used inconsistently — minor consistency note for the types/dedup lanes.
- **Legacy lane:** `persistence/journals/journal/legacy-source.ts` and `faculties/values/store.ts:671` legacy-migration catches are sanctioned by the `docs/specifications.md` migration boundary; the legacy lane should confirm the removal criteria there are still tracked.
- **Weak-types lane:** `catch (error)` followed by `(error as NodeJS.ErrnoException).code` (e.g. `quarantine-store.ts:330,346`) relies on the errno shape without a guard; works in practice, flagged only as a weak-typing pattern that lane may already track.
