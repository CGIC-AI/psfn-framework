# PSFN Code & Architecture Review — pi + GLM

- **Date:** 2026-06-26
- **Reviewer:** pi coding agent (running GLM model pass)
- **Scope:** READ-ONLY review of `/home/ada/psfn-framework`
- **Guide:** `docs/PSFN_PROJECT_CHARTER_524.md` (author noted it is "slightly stale on the db side")
- **Branch reviewed:** `sprint_9_memory` @ `07693575`
- **Method:** static read of entrypoints, boundary, persistence, trust, faculties, message ontology; ran non-mutating gates (`lint`, `build`, `verify:settings-contract`, `verify:repository-hygiene`) to assess workability.

> Note on the charter's "stale db side": the divergence is narrower than expected. Persistence is now **hard-wired to PostgreSQL** as the operational backend (`src/persistence/runtime-factory.ts:53` throws if `persistenceBackend !== 'postgres'`), but **filesystem JSONL remains the canonical L0 archive** and Postgres is treated as a rebuildable projection/mirror that fails closed (`src/persistence/sessions/store/journal-runtime.ts:305,323`). So the charter's L0-canonical law is in fact honored; the only real drift is that SQLite/shared-`DATA_DIR` paths are gone and Postgres is mandatory. The charter's prose ("database mirror behind `TranscriptProjectionPort`") still describes the architecture accurately.

---

## 1. Executive Summary

This is a mature, unusually disciplined codebase for its domain. The charter's foundational laws are implemented **structurally, not just socially**, in most of the places that matter most:

- Split-runtime-only is enforced (`src/app/startup/index.ts` exits 1).
- The credential boundary is real: **zero `process.env` secret reads in `src/core`**; the LLM client that holds keys is only instantiated gateway-side; `CredentialVaultPort` has both env and OpenBao backends.
- Gateway/sandbox separation is a typed boundary (`isolatedFromGatewaySecrets`), with a hardened child-process sandbox (`--permission`, `--disallow-code-generation-from-strings`, empty env, explicit denied-capability list).
- L0 JSONL is canonical with HMAC hash-chaining; the Postgres transcript store is a drift-tracked projection.
- Message ontology, shard fold-back lineage, trust/privacy ceilings, deny-by-default gateway policy, and exact dependency pinning are all present and coherent with the charter.

The most important problem found is a **broken mandatory quality gate** (`verify:repository-hygiene` crashes on the `vendor/emosim` submodule), plus a set of **god-file accretion hubs** that have shifted from the entrypoints (which the charter specifically warned about, and which are now clean) into domain modules. Lint rigor is shallow for a security-sensitive codebase. None of the findings contradict the core safety model; they are hygiene, workability, and maintainability debt.

**Validation gate results on this checkout:**

| Gate | Result |
|---|---|
| `npm run lint` | ✅ pass (clean) |
| `npm run build` | ✅ pass |
| `npm run verify:settings-contract` | ✅ pass |
| `npm run verify:repository-hygiene` | ❌ **crashes** (see F-1) |
| `npm run verify:startup-owner-files` | ⚠️ fails on missing `COMPANION_ID` (expected fail-closed; this checkout is not the live deployment) |
| Test surface | 431 test files, ~4300 tests discovered via `vitest list` (full run not executed; requires live Postgres) |

---

## 2. Charter Adherence — Where It Lands Well

These are worth calling out because the charter treats them as "project law," and the code enforces them rather than aspirationally documenting them.

| Charter law / section | Evidence | Assessment |
|---|---|---|
| §9.1 / Phase 2 — Split-only | `src/app/startup/index.ts` logs "This entrypoint is disabled" and `process.exit(1)` | ✅ Structural |
| §6.4 / Law 3 — Gateway sole privileged edge | `src/boundary/gateway/policy.ts` `evaluatePolicy` is deny-by-default; SSRF via `evaluateUrlPolicy`; symlink-resolved path checks (`resolveCanonicalPath`) | ✅ Strong |
| Law 4 / §6.5 — Untrusted exec outside secrets boundary | `src/app/agent/startup-guards.ts:enforceNetworkIsolationOnStartup` actively probes `1.1.1.1` and **throws** if reachable; `SandboxExecutionBoundary` carries `isolatedFromGatewaySecrets: boolean` | ✅ Strong |
| §6.5 — Sandbox hardness | `src/boundary/sandbox/sandbox-execution-port.ts` child process: `env: {}`, `--permission`, `--disallow-code-generation-from-strings`, `--disable-proto=throw`, IPC sanitizer that strips `__proto__`/`constructor`/`prototype` and caps depth/keys | ✅ Strong |
| Law 7 / §6.3 / §7.3 — Core never gets raw credentials | `grep` of `src/core` for `process.env.*(key|token|secret|...)` returns **nothing**; `LLMClient` is only constructed in `src/system/config/provider-runtime-factory.ts` (gateway) + dev/e2e; `CredentialVaultPort` with env **and** OpenBao (`src/boundary/custody/credential-vault.ts`) | ✅ Strong |
| §6.20 / §7.1 / Law 2 — JSONL canonical L0 | `journal-runtime.ts` appends via `SessionArchivePort`; Postgres is `TranscriptProjectionPort` that `markProjectionDrift`s on failure while "canonical archive remains authoritative" | ✅ Faithful |
| §7.5 — Projection repair / fail-closed search | projection backfill + drift marking; `runtime-factory.ts` rejects non-postgres | ✅ |
| §8 / Phase 4 — Message semantics | `src/core/agent/message-classes.ts`: `outwardSpeech`, `musing`, `systemNote`, `internalWhisper`, `compaction`, `continuity`, `mirror`; `heartbeat-policy.ts:49-50` reserves `whisper` for internal traffic and routes outward to `musing` | ✅ Done |
| §6.13–6.14 — Shard fold-back + lineage | `src/faculties/shards/`: `lineage-contracts.ts` (`parentCompanionId` + `shardCompanionId` + `shardId`), `fold-review.ts`, `result-lineage.ts`, `artifact-return-port.ts`, `artifact-policy.ts`, `output-review.ts`; gateway policy `evaluateShardSessionMemorySyncPolicy` denies `runtime_state` sync and enforces direction/authority | ✅ Strong |
| §8.2 / §8.5 — Authorship integrity, no fake healthy state | `ResponseMetadata` carries explicit non-fabricating fallback codes (`runtime_nonfabricating_notice`); `refusal-patterns.ts` detects and preserves refusals instead of sanitizing them | ✅ |
| Trust/privacy (§9, §8.6) | `src/system/trust/types.ts` honne/tatemae ceilings, `ConsentFlags`, `broadcast-safety.ts` (`public_only` vs `approved_private_context`, approval tokens) | ✅ |
| §7.2 — Owner files for mutable settings | `verify:settings-contract` passes; startup rejects cross-domain keys ("Startup rejected cross-domain keys in settings.json") | ✅ |
| Supply-chain pinning (AGENTS.md) | **0 floating deps**; 9 `overrides` present; all versions exact | ✅ Excellent |

**Bottom line for adherence:** the charter's hardest constraints (secrets boundary, L0 canonicity, split-only, sandbox isolation, message honesty, shard lineage) are implemented and wired to real entrypoints. The architecture in `docs/architecture.md` matches the code and even states its own source-of-truth precedence (`docs/specifications.md`).

---

## 3. Findings

Severity scale: 🔴 High · 🟠 Medium · 🟡 Low · 🔵 Informational

### 🔴 F-1 — `verify:repository-hygiene` is broken by the `vendor/emosim` submodule

- **Location:** `scripts/public-sanitize-check.mjs` (`scanPublicSanitizeTrackedFiles` / `shouldScanTextContent`)
- **Evidence:** `.gitmodules` declares `vendor/emosim` as a submodule. `git ls-files` returns it as a gitlink (mode `160000`). `shouldScanTextContent("vendor/emosim")` returns `true` (no extension → not in `BINARY_EXTENSIONS`), then `readFileSync("vendor/emosim", "utf8")` throws `EISDIR: illegal operation on a directory, read`. Reproduced:
  ```
  > psfn-framework@0.1.0 verify:public-sanitize
  Public-sanitize check failed to complete: EISDIR: illegal operation on a directory, read
  ```
- **Impact:** This is the **first** step of `verify:repository-hygiene`, so the whole gate is un-runnable on any checkout that has the submodule registered (with or without it checked out). `AGENTS.md` mandates this gate "for repo-surface changes," so it is silently unavailable exactly where it is required. `verify:dependency-cycles` and `verify:identity-literals` (steps 2–3) never run.
- **Recommendation:** In `listTrackedFiles()`/`shouldScanTextContent`, skip gitlink entries — either filter with `git ls-files --stage` and drop mode `160000`, or `stat()` each path and skip directories. Prefer the gitlink filter so the scanner reflects intent rather than filesystem state.

### 🟠 F-2 — God-file accretion has migrated from entrypoints into domain hubs

- **Location (non-test files ≥ ~1300 LOC):**
  - `src/operator/garden/api-routes.ts` — **2951** lines, ~101 route matchers in one switch/matcher
  - `src/core/scheduler/heartbeat-template-runtime.ts` — **2371** lines
  - `src/app/maintenance/sqlite-to-postgres-memory-migration.ts` — **2297** lines (one-shot migration)
  - `src/faculties/memory/retrieval.ts` — **2255**
  - `src/channels/discord/voice.ts` — **1762**
  - `src/primitives/llm/client.ts` — **1614**
  - `src/faculties/memory/writer.ts` — **1610**
  - `src/boundary/gateway/client.ts` — **1573**
  - `src/faculties/shards/manager.ts` — **1528**
  - `src/core/agent/substrate-agent/runtime-context.ts` — **1480**
  - `src/faculties/memory/postgres-store.ts` — **1440**
  - `src/channels/{telegram,discord}/adapter.ts` — 1353 / 1348
  - `src/core/session/manager.ts` — **1290**
  - `src/core/agent/substrate-agent.ts` — **1281**
- **Context vs. charter:** Charter §12.1 ("No God Files") explicitly named `src/app/agent/main.ts` and `src/app/gateway/main.ts`. Those two are now genuinely thin composition roots (gateway `main.ts` is ~210 lines of sequencing; agent `main.ts` delegates to `core-bootstrap`/`startup-context`/`control-plane`). **That refactor succeeded.** The pressure relocated: `api-routes.ts`, `runtime-context.ts`, `substrate-agent.ts`, `session/manager.ts`, `gateway/client.ts`, and the memory/shard managers are the new accretion hubs.
- **Nuance:** Not all large files are bad. `heartbeat-template-runtime.ts` is cohesive (it is exactly the charter's §8.6 "context presentation quality is architecture" — numeric-state → companion-readable translation) and could be split by domain but is not dangerous. The higher-risk ones are the **dispatch/wiring hubs** (`api-routes.ts`, `runtime-context.ts`, `substrate-agent.ts`, `session/manager.ts`) where unrelated concerns share a file and drift is likely.
- **Recommendation:** Prioritize splitting `api-routes.ts` (already partially done via `api-routes-episodic-memory.ts` — extend that pattern per resource family) and `runtime-context.ts`/`substrate-agent.ts` (split by turn-lifecycle phase). Add a soft LOC ceiling to `verify:repository-hygiene` or a Fallow rule so new hubs are caught before they grow.

### 🟠 F-3 — Lint configuration is too shallow for a security-sensitive substrate

- **Location:** `eslint.config.js`
- **Evidence:** The entire rule set for `src/**/*.ts` is `@typescript-eslint/no-unused-vars` + `@typescript-eslint/no-unnecessary-condition`. There are **no** rules for `no-floating-promises`, `require-await`, `no-misused-promises`, `return-await`, or the `recommended-type-checked` set, despite ~556 `catch` blocks and heavy `async`/`Promise` usage across boundary code.
- **Impact:** `npm run lint` is the **mandatory** gate per `AGENTS.md` ("mandatory for every tracked code change"), but it currently only catches unused vars and tautological conditions. Floating/dropped promises — a classic source of silent failures in an event-bus + RPC architecture — are not caught. This is charter-relevant: §12.6 "No Silent Failures."
- **Mitigating factor:** A targeted scan shows only **3** `.catch(() => {})` swallows in non-test code, two of which are benign fire-and-forget Discord typing indicators (`src/channels/discord/adapter.ts:926,930`). So the *current* code is not broadly swallowing; the risk is that the gate will not *prevent* regressions.
- **Recommendation:** Adopt `typescript-eslint` `recommended-type-checked` plus `no-floating-promises` and `no-misused-promises`. Expect a cleanup pass; land it as a dedicated bead so the noise is bounded.

### 🟡 F-4 — Named "legacy" code paths in the memory extraction orchestrator

- **Location:** `src/faculties/memory/extraction/orchestrator.ts:166,202`; type in `src/faculties/memory/extraction/types.ts:64` (`compositionalMode: 'legacy' | 'chunk_compose'`)
- **Evidence:** Extraction selects `compositionalMode: options.useCompositionalExtraction ? 'chunk_compose' : 'legacy'`. A persisted mode literal named `legacy` is a standing alternate path, which sits in tension with the charter's "No legacy code paths or compatibility shims" (AGENTS.md Coding Standards #3) and §12.2 "No Dead Wiring."
- **Nuance:** This is not dead code — both branches are live — and most other `legacy*` symbols in the repo are legitimate one-way migration helpers (`migrateLegacyPersistenceLayout`, `legacyDataDir`, etc., which are correct and time-bounded). The extraction mode is the one place where `legacy` is a *runtime-selected strategy* rather than a migration.
- **Recommendation:** Either rename the mode to something intention-revealing (e.g., `'single_pass'` vs `'chunk_compose'`) or, if `'legacy'` is truly meant to retire, gate it behind the capability tier and add a beta-removal criterion (mirroring the AGENTS.md "Live Alpha Migration Boundary" discipline).

### 🟡 F-5 — `@deprecated` config fields without a tracked removal plan

- **Location:**
  - `src/system/config/runtime-config-contracts.ts:208,210,212` — `webFetchAllowlist`/`webFetchAllowHttp`/`webFetchDomainBlocklist` marked `@deprecated`, successors are `webFetchAllowInternalNetwork` + `webFetchDomainAllowlist` + `webFetchAllowHttp`.
  - `src/boundary/gateway/url-policy.ts:83` — `@deprecated Use allowInternalNetwork + domainAllowlist instead`
  - `src/system/config/settings-contract.ts:63,347` — a `deprecated?: boolean` field is tracked and set from a `DEPRECATED_SETTINGS_FIELDS` set.
- **Impact:** The deprecation *plumbing* exists (good), but I did not find a beta-removal criterion or tracked bead tying these to a removal date. The charter's migration boundary requires deprecated compatibility to be "named in the live boundary with scope, validation, and beta-removal criteria" before it is expanded, and existing compat to be "treated as removal debt and tracked before beta."
- **Recommendation:** Confirm these deprecated fields are enumerated in `docs/specifications.md`'s live-boundary section with a removal target; if not, file a removal-debt bead.

### 🟡 F-6 — Broadcast-safety content classification is heuristic regex

- **Location:** `src/system/trust/broadcast-safety.ts`
- **Evidence:** `SENSITIVE_PATTERNS`, `PRIVATE_PATTERNS` (incl. email/phone regexes), `OFF_BRAND_PATTERNS` are plain regex lists. They gate `public_only` vs `approved_private_context`.
- **Impact:** Regex PII/keyword matching is known to both over-block (false "private" on benign text) and under-block (any phrasing the regex doesn't cover). For a *safety* boundary this is acceptable as a first-line filter but should not be the only signal. The charter (§8.2, §9) treats authorship/privacy as correctness, not best-effort.
- **Recommendation:** Document this explicitly as defense-in-depth (regex pre-filter → trust-ceiling enforcement → operator approval), and add a regression test corpus of positive/negative broadcast samples so drift is caught. The surrounding `approvedTokens` + trust-ceiling layers already provide the real enforcement, so this is "make the heuristic's role explicit," not "replace it."

### 🔵 F-7 — `eval/` is a very large fraction of the tracked tree

- **Evidence:** `eval/` contains **912 files** (vs 1202 TS files in `src/`). Sub-surfaces: `companion-shape`, `discovery`, `emotion-l3`, `llm-response`, `local`, `logprob-harness`, `memory`, `repeng`, `scenarios`.
- **Impact:** None as a defect — this is clearly intentional and aligns with the charter's "useful at every capability level" and data-driven tuning (Phase 10). Worth noting only because (a) it dwarfs `src/` and any "repo surface" scanner/hygiene rule should be aware of it, and (b) the Python `eval/repeng` + `eval/local` surfaces introduce a second toolchain (Python) that is not covered by `npm run lint`.
- **Recommendation:** Informational. Consider a one-line note in `AGENTS.md` or `docs/` clarifying that `eval/` is first-class and which gate (if any) covers its Python.

### 🔵 F-8 — Charter document has a copy-paste corruption

- **Location:** `docs/PSFN_PROJECT_CHARTER_524.md` §6.26, last lines.
- **Evidence:** The wiki section ends with "...the companion's own vault is deprecated in favor of this wiki**ion is not the canonical source of truth.** Mirrors and projections must be rebuildable..." — two paragraphs have been mashed together ("wiki" + the start of the §6.23 mirror paragraph).
- **Impact:** Doc-only, but this is the *guide* for reviews like this one. Worth fixing so future reviewers don't trip on it.
- **Recommendation:** Repair the §6.26/§6.23 boundary in the charter.

---

## 4. Positive Observations (keep doing these)

- **Fail-closed identity:** `loadConfig()` requires `COMPANION_ID` and throws otherwise (`src/system/config/load-config.ts:87`) — exactly the charter's "missing identity state must not be papered over."
- **HMAC hash-chained L0:** session journal entries are signed with a rolling HMAC (`journal-runtime.ts` `integrityProvider.sign`), giving tamper-evidence on the canonical archive for free.
- **Production layout guardrails are real:** `layout.ts` `assertNoDuplicateRoots` / `assertNoOverlappingRoots` / `assertWorkspaceDoesNotOverlapRuntimeState`, and production mode **forbids** shared-root `DATA_DIR` — matching the AGENTS.md production-stricter-than-continuous rule.
- **Gateway policy is genuinely deny-by-default:** the `default:` arm of `evaluatePolicy` returns `DENY`; every new method must be explicitly allowed.
- **Sandbox IPC hardening:** `sanitizeForIpc` strips prototype-pollution keys, caps depth/arrays/keys, handles cycles — the kind of detail that is usually missing.
- **Message-class tagging is structural:** `tagMessageClass` + `MESSAGE_CLASSES` means authorship semantics are carried on the message, not inferred downstream.
- **Doc/code alignment:** `docs/architecture.md` and `docs/specifications.md` state a source-of-truth precedence and the code follows it; the disabled entrypoint is even called out in the docs.

---

## 5. Suggested Follow-Up Beads (if tracked)

1. **F-1** — Fix `public-sanitize-check.mjs` to skip gitlink/submodule entries; un-block `verify:repository-hygiene`. (High, small, isolated.)
2. **F-3** — Adopt `typescript-eslint` type-checked rules (`no-floating-promises`, `no-misused-promises`, `require-await`); triage the resulting findings. (Medium, cross-cutting.)
3. **F-2** — Split `api-routes.ts` along resource families using the existing `api-routes-episodic-memory.ts` pattern; add a LOC/complexity guard to repo hygiene. (Medium, incremental.)
4. **F-4 / F-5** — Rename or retire the extraction `'legacy'` mode; enumerate deprecated web-fetch config fields in the live boundary with removal targets. (Low–Medium.)
5. **F-8** — Repair the charter §6.26/§6.23 copy-paste corruption. (Trivial.)

---

## 6. Reviewer's Note on Method & Limits

- This was a **static, read-only** pass. I did not run the full `npm test` suite because it requires a live Postgres instance; I relied on `vitest list` for test-discovery counts and on the targeted verify scripts.
- Charter-law *behavior* (e.g., "companion never interacts with the auditor directly," §6.25/Law 28) was assessed by reading the wiring, not by exercising it at runtime; a runtime privacy/audit test pass would strengthen confidence in the introspection-consent laws.
- The "stale db side" caveat in the request turned out to be largely benign for this review: the JSONL-canonical / Postgres-projection model is intact and is precisely what the charter prescribes. The only operative consequence is that Postgres is now a hard requirement for the agent runtime.
