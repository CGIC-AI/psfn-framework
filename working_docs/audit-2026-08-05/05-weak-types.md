# Lane 5 — Weak Types (`any`, `unknown`, casts) Audit

Branch: `feat/emosim-fleet-shakedown`, working tree as-is, 2026-08-05. Read-only.

## Scope & method

Examined: `src/` (root runtime), `companion-ui/src/`, `admin-ui/src/`, `PSFN-Satellite-Hub/` (TS in `src/ts/`, Python in `hub/` + `client/`), plus root/package `tsconfig*.json`, `eslint.config.js`, `config/typecheck-baseline.json`, and `node_modules/json-rpc-2.0/dist/server-and-client.d.ts` to verify a claimed library typing gap.

Method: ripgrep inventories per package for `: any`, `as any`, `any[]`, `Record<string, any>`, `: unknown`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, non-null assertions (`!.`), `as never`; test/non-test split; then opened and read every non-test hotspot file to confirm context (gateway method registration, discord voice runtime, pg stores, JSON.parse validators, satellite-hub hub). Consulted `working_docs/READONLY_AUDIT_origin-main_20260721.md` (its S7 flagged the RPC-boundary `as any`; re-verified below). Did **not** run the full suite, build, or gates per audit constraints; no files modified except this report.

Coverage limits: I did not individually open all ~54 untyped pg DML queries or all 142 non-test `as unknown as` sites — the top ~10 files by count were read in full; the rest were classified by sampling. Counts below are exact from grep; classifications of unread sites are marked candidate.

### Raw inventory (grep counts, TS unless noted)

| pattern | src (non-test) | src (tests) | companion-ui | admin-ui | satellite-hub TS |
|---|---|---|---|---|---|
| `: any` (excl. comment prose) | ~5 real | 224 | 0 (1 hit is comment prose) | 0 | 0 |
| `as any` | 5 (2 redundant, 3 real) | 1,821 | 0 | 0 | 0 |
| `any[]` | 2 real | ~138 | 0 | 0 | 0 |
| `Record<string, any>` | 0 | 8 | 0 | 0 | 0 |
| `as unknown as` | 142 | 1,038 | 9 (all tests) | 8 (2 svelte, 4 non-test) | 7 (5 non-test) |
| `@ts-ignore` | 0 | — | 0 | 0 | 0 |
| `@ts-expect-error` | 8 (all tests, all legitimate "deliberately invalid input" assertions) | — | 0 | 2 (both legitimate negative type tests) | 0 |
| `@ts-nocheck` | 0 | — | 0 | 6 (all test files) | 0 |
| `as never` | 32 grep hits, ~6 real code (rest comment prose) | — | — | — | — |
| non-null `!.` | 35 | heavy (top file 106) | — | — | — |
| Python: `Any` / `# type: ignore` | — | — | — | — | ~17 / 2 |

The headline: **production `src/` is remarkably clean of raw `any`** (≈10 real occurrences). The weak-type risk in this repo concentrates in three places: (1) 221 baselined type errors in production sources, (2) a generic-erasure seam at gateway RPC method registration, and (3) double-cast `this`-to-context patterns that bypass structural checking.

## Critical assessment

### MAJOR 1 — 221 baselined TypeScript errors in production sources; build never typechecks

- Evidence: `config/typecheck-baseline.json` (`totalErrors: 221`, `filesWithErrors: 88`, 112 path+code entries). Distribution by code: TS2322 ×39, TS2345 ×20, TS2339 ×19, TS2353 ×6, TS18048 ×5, TS18046 ×3, TS7006 ×2, plus singletons. By area: `src/core` 27, `src/persistence` 18, `src/app` 17, `src/boundary` 17, `src/faculties` 14.
- `package.json:9` — `"build": "npm run verify:companion-id-types && tsup"`: tsup transpiles without typechecking, so these errors do not block the build. `scripts/verify-typecheck-baseline.mjs` only *prevents growth* (reduction-only re-baseline).
- Root `tsconfig.json` **excludes `**/*.test.ts`** (`tsconfig.json:20`), so these 221 errors are all in non-test production/shakedown sources.
- Why it matters: this is the single largest weak-typing fact in the repo. Every baselined TS2322/TS2345/TS2339 is a place where the declared contract and the actual value disagree and the compiler is being ignored — the same class of bug `as any` would introduce, just arrived at honestly. TS7006 ×2 are literal implicit-`any` parameters. TS18046/18048 ×8 are `unknown`-typed values used without narrowing. Notably `src/app/agent/*.ts` wiring files (companion-presence, icp-initiation) — startup wiring, exactly where a type lie crashes at boot or, worse, silently mis-wires.
- Widespread: 88 files; representative: `src/app/agent/companion-presence-wiring.ts` (TS2739), `src/app/agent/gateway-message-handlers.ts` (TS2345 ×2), `src/app/e2e/icp-certification/process-harness.ts` (TS2322/TS2339).

### MAJOR 2 — Gateway RPC dispatch seam erases all parameter types (`MethodDescriptor<any>` + `as never`), with no schema validation at the seam

- Evidence:
  - `src/boundary/gateway/methods/register.ts:24` — `ReadonlyArray<AuditedMethodDescriptor<any, unknown>>`; `:31` — `(params: unknown) => descriptor.handler(params as never, runtime)`; same pattern in `registerGatedDescriptors` (`:38`, `:94`).
  - `src/boundary/gateway/methods/llm.ts:258` — `Array<CancellableLlmMethodDescriptor<any, unknown>>`; `:600` — `(cleaned: any) => descriptor.handler(cleaned, runtime, signal)`; `:603` — `auditedHandler(params as any)`.
  - 15 files declare descriptor arrays with `MethodDescriptor<any, …>`: confirmation, discord, home-assistant, git, vault, image, notify, beads, web, shell, shard-backends, llm, register, fs, reverse-methods.
  - The `audited` wrapper (`src/boundary/gateway/server.ts:670-705`) performs canary-egress inspection and audit logging — **not** parameter validation. I read the `llm.chat` handler (`llm.ts:261-320`): `params.messages`, `params.systemPrompt`, `params.tools` are used directly off the wire value.
- Why it matters: every gateway JSON-RPC method's params cross from parsed JSON (`unknown`) into a concretely-typed handler via `as never`/`as any` with no typebox/guard validation at the boundary — exactly the pattern the repo's own rules say must validate. Mitigating context: this is the internal gateway↔agent channel, not the public socket (the public frame path *does* validate — `server.ts:1860-1868` enforces frame identity before dispatch), and peer endpoints are authenticated fleet members. But a compromised or buggy agent process can push malformed `llm.chat` params deep into provider calls before anything rejects. The prior audit (READONLY_AUDIT_origin-main S7) flagged the `as any` at this seam; the root cause is the erased descriptor generic, not the cast.
- Strong replacement: keep the heterogeneous registry but change the contract so handlers receive `unknown` and each descriptor carries its validator: `{ name, parse: (p: unknown) => P, handler: (p: P) => Promise<R> }` with `registerAuditedDescriptors` calling `descriptor.handler(descriptor.parse(params), runtime)`. The repo already has the typebox/guard idiom everywhere (e.g. `shared-workspace-store.ts`, `intake-envelope` contracts), so this is a mechanical-if-voluminous refactor. Type errors the replacement would surface: handlers that currently rely on callers having normalized params (e.g. `llm.chat` reading optional fields with `??` defaults) would need those defaults moved into the parse step; expect a handful of "possibly undefined" errors per method file.

### MAJOR 3 — `DiscordVoiceRuntime`: 18 `this as unknown as VoiceTurnRuntimeContext / VoiceRecoveryRuntimeContext` double-casts that structurally cannot be checked

- Evidence: `src/channels/discord/voice.ts:575,593,599,609,615,619,629,641,648,656,660,668,672,676,684,692,704,733` (19 total; one is the unrelated client cast below). The class declares every field `private` (`voice.ts:91-140`), so it can never structurally satisfy the public context interfaces in `src/channels/discord/voice-types.ts:91-136` — the `as unknown as` is not laziness, it is *required* by the current shape, which means the compiler checks nothing: rename `activeTurn` in the class or the interface and all 18 call sites still compile, then crash at runtime.
- Why it matters: this file is the voice intake path (STT transcripts flow to `intakeScreening` — a CogSec trust boundary, `voice-types.ts:114-115`). Type drift here breaks a security-adjacent path silently. The extraction into `voice-turn-runtime.ts`/`voice-recovery-runtime.ts` helpers is good architecture; the typing of the seam is not.
- Strong replacement (design decision, two options): (a) have `DiscordVoiceRuntime` expose a single `private readonly turnContext: VoiceTurnRuntimeContext` object literal whose fields reference the class's privates — the literal is checked structurally once, and helpers receive it without any cast; or (b) make the helpers methods of the class. Option (a) is ~1-2 hours and keeps the split. Errors surfaced: any current mismatches between class fields and the context interfaces (there may be none, but the compiler has never checked).
- Related same-file finding: `voice.ts:314` casts `this.client` (a discord.js `Client`) to an inline ad-hoc optional-chained shape to reach `guilds.fetch(guildId).members.fetch(userId).voice.channel`. discord.js ships all of these types: `client.guilds.fetch(id)` returns `Promise<Guild>`, `guild.members.fetch(id)` returns `Promise<GuildMember>`, `member.voice.channel` is `VoiceBasedChannel | null`. The cast throws away real types to avoid… nothing; the direct typed call compiles. Replace the whole cast with typed discord.js calls.

### MINOR 1 — Root tsconfig is the weakest in the repo; `no-explicit-any` / `no-unsafe-*` not enabled in root eslint

- `tsconfig.json` (root): `strict: true` but **no `noUncheckedIndexedAccess`, no `noImplicitOverride`** — both `companion-ui/tsconfig.json:9-10` and `PSFN-Satellite-Hub/tsconfig.json:9-10` enable both. The largest, oldest package has the loosest flags.
- `eslint.config.js` enables `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition` — but **not** `no-explicit-any` and none of the `no-unsafe-*` family. Consequence: `result.rows[i].some_field` on an untyped `pg` query (rows: `any`) is completely silent in both compiler and linter.
- Corollary nit: `src/boundary/gateway/server.ts:1877` and `src/boundary/gateway/client.ts:653` carry `// eslint-disable-next-line @typescript-eslint/no-explicit-any` for a rule that is not enabled — dead suppressions. And the `as any` they protect is itself redundant: `receiveAndSend(payload: any, …)` (verified `node_modules/json-rpc-2.0/dist/server-and-client.d.ts:23`) accepts anything, so `message as any`/`msg as any` can simply be deleted along with the dead disable comments. The comments claiming "payload param is typed as `any`" are accurate but argue for *removing* the cast, not keeping it.

### MINOR 2 — pg row typing is assertion-based and inconsistent (~54 untyped DML queries)

- Evidence: non-test `src/` has 408 typed `.query<…>(` calls vs ~54 untyped DML (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) `.query(` calls (480 untyped total, most being DDL/BEGIN/COMMIT). Well-typed exemplar: `src/persistence/postgres/fleet-auth/authority-lifecycle-store.ts:357-366` (`query<{action: string; …}>`). Generic helper: `src/faculties/memory/postgres-store.ts:625-634` (`queryWrite<T extends QueryResultRow>`).
- Only 2 files use `.rows` with exclusively untyped queries: `src/app/maintenance/migrate-channel-envelope.ts`, `src/core/contacts/postgres-adapter/connection.ts` (candidate — I did not verify row-shape handling in each).
- Why it matters: the `pg` generic is a compile-time assertion, never validated at runtime; that's acceptable for schema-owned tables (the repo's stance), but the ~54 untyped call sites return `QueryResult<any>` and with no `no-unsafe-*` lint their row access is invisible. Low blast radius individually, but persistence-adjacent.

### MINOR 3 — Tests are a different world: 1,821 `as any`, 1,038 `as unknown as`; shoehorn not adopted

- Test-only casts dwarf production by two orders of magnitude. `Record<string, any>` ×8 and `any[]` ×~138 are also nearly all tests. Non-null assertion hotspots are test files (`background-work-store.integration.test.ts` 106).
- The operator's stated direction is `@total-typescript/shoehorn` for partial test data. Verified: `shoehorn` does **not** appear in `package.json` and has zero imports in `src/`. The migration has not started.
- Note: many sampled test casts are *legitimate* — deliberately-invalid payloads fed to validators (e.g. `companion-ui/src/lib/protocol/framing.test.ts:203-293`, all 8 `as unknown as` in companion-ui tests; all `@ts-expect-error` sites). The cleanup target is the fixture/mock casts (`as any` on managers, event captures), not validator-probing casts. Recommend not flagging validator-probe casts in the migration.

### MINOR 4 — admin-ui: 6 blanket `@ts-nocheck` on test files

- `admin-ui/src/lib/companion-name.test.ts:1`, `components/settings/navigation.test.ts:1`, `components/settings/settings-search.test.ts:1`, `components/tools/filter-tools.test.ts:1`, `settings/authority.test.ts:1`, `theme/loader.test.ts:1`. The one I opened (`companion-name.test.ts`) shows no obvious need for it — plain vitest assertions against typed functions. Candidate — needs human verification whether svelte-check's jsdoc checking of `.test.ts` forced these; if not, delete the directives.

### NITS (verified, low value to fix individually)

- `src/boundary/pi-agent/agent-loop-patch.ts:135,156,182,189` — `agent as unknown as PatchedAgent` to read pi-agent-core private fields (`activeRun`, `_state`). Deliberate, documented, contained monkey-patch boundary; real risk is silent breakage on upstream bumps (privates aren't semver-covered) — the file header already mandates re-checking on bumps. Leave as-is; note the `this as unknown as Agent` at :182/:189 is the *reverse* cast and could be typed via the `PatchedAgent` intersection instead.
- `src/boundary/pi-agent/substrate-agent-tool.ts:25,33` — `AgentTool<any>` / `params: any` is extensively documented (lines 1-17) as mirroring upstream's erased generic; params are schema-validated by the scheduler before `execute`. Correct as-is; the file itself says to re-verify the mirror on every pi-agent-core bump.
- `src/app/gateway/api-surface.ts:922-938` — inert `EventBus`/`SessionManager`/`SubstrateAgent`/`SensorIngestPort` stubs double-cast to full interfaces. Deliberate fail-closed stubs (throw on use). A `Pick<>`-narrowed constructor param would be stronger but requires changing `ApiServer`'s constructor contract — design decision, low value.
- `src/channels/api/voice-websocket-runtime.ts:166,198` and `src/channels/discord/voice-recovery-runtime.ts:109` — `undefined as never` / `runtime as never` to satisfy iterator/context types; works, but `as never` is the least-documented cast; each deserves a one-line comment.
- `src/persistence/workspaces/shared-workspace-store.ts:174-215` — validate-then-cast is the repo's correct idiom, but the guards check a *subset* of fields before casting to the full record type (e.g. `parseReview` checks 6 fields → `as unknown as SharedWorkspaceReviewRecord`). If the record type grows a required field, the guard silently under-validates. Same shape in `src/core/cogsec/drift/drift-review-card-store.ts:234,311,312` (though that file *does* whitelist unknown keys — the stronger pattern). Prefer the drift-store's known-keys whitelist everywhere.
- `PSFN-Satellite-Hub/src/ts/hub/voxta-facade.ts:510` — `frame as unknown as SignalRInvocation` after only `isRecord` + `type === 1` checks; `invocation.invocationId` is used unvalidated. Add field guards.
- `PSFN-Satellite-Hub/src/ts/pi-client/mic-control-server.ts:273` — `Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>`: the standard Node↔DOM stream-type mismatch; fine.
- Python: clean. `Any` uses are legitimately generic (`hub/util.py:24 to_jsonable(value: Any) -> Any`) or external-API-typed (`hub/devices/esphome_session.py:16,53` — aioesphomeapi). `# type: ignore` ×2: `hub/runtime.py:300` could be eliminated with a `TypeGuard` on `_parse_enum`; `tests/test_realtime_server.py:79` is test-only.
- `src/app/e2e/e2e-test.ts:88-89` — `data: any` event capture in the e2e harness; harmless.

## Recommendations

Ordered by value/effort:

1. **Burn down `config/typecheck-baseline.json`** (221 errors / 88 files). Start with `src/app/agent/*` wiring files (17 errors in `src/app`) and the TS7006/TS18046/18048 subset (~10 errors) — small, high-signal. The gate is already reduction-only, so every fix is locked in. Effort: days, but parallelizable by directory; mechanical for most TS2322/TS2345. *Needs no design decisions; safe to delegate.*
2. **Close the gateway descriptor seam** (Major 2): introduce a `parse` step per descriptor in `src/boundary/gateway/methods/types.ts` + `register.ts`, migrate the 15 descriptor files one at a time. Design decision: typebox schema per method vs hand guards — repo precedent favors typebox at wire boundaries. Effort: 2-4 days total, sharded per file. Start with `llm.ts` (largest blast radius).
3. **Fix the voice-runtime context seam** (Major 3): option (a) — a single checked context object — in `src/channels/discord/voice.ts`; then delete all 18 double-casts and the discord.js client cast at :314. Effort: half a day including tests. Mechanical once the context-object shape is chosen.
4. **Enable `noUncheckedIndexedAccess` + `noImplicitOverride` in root `tsconfig.json`** — will surface new errors; land behind the existing baseline gate (the gate aggregates by path+code, so this is exactly its use case). Effort: flag flip + baseline refresh; fixes delegated to (1). Also enable `@typescript-eslint/no-explicit-any` (error) for non-test `src/` and delete the two dead disable comments + redundant `as any` at `server.ts:1877-1879` / `client.ts:652-654`. Effort: ~1 hour.
5. **Type the remaining ~54 untyped pg DML queries** with row generics (match the `authority-lifecycle-store.ts:357` exemplar). Mechanical, ~1 day; candidate count needs a precise re-scan.
6. **Start the shoehorn migration for test fixtures**: add `@total-typescript/shoehorn` (pinned), convert fixture/mock `as any` casts first (highest count: `substrate-agent.test.ts`, `autoresearch-ttft.test.ts`, `postgres.test.ts`), and explicitly exempt validator-probe casts. Effort: ongoing, per-file.
7. **admin-ui**: try deleting the 6 `@ts-nocheck` directives and run `npm run check`; restore only with a comment naming the forcing error. Effort: 1 hour.
8. **Under-validation guards**: add known-keys whitelists (drift-store pattern) to `shared-workspace-store.ts` parsers, and field guards to `voxta-facade.ts:510`. Effort: hours each.

## Risks & false positives

Deliberately **not** flagged:

- **Validated-boundary `unknown`** (the repo's dominant pattern, ~4,240 `: unknown` in src): JSON-RPC params, `JSON.parse` results, pg `jsonb` columns all arrive as `unknown` and are narrowed by guards/typebox. `drift-review-card-store.ts`, `shared-workspace-store.ts`, `admin-ui/src/lib/fleet/model-usage-data.ts:251` (validates coverage math before casting) are exemplars — the trailing `as unknown as FullType` after a guard is the correct TypeScript idiom, since TS cannot narrow a whole object shape.
- **`as unknown as` in tests that feed deliberately-invalid payloads to validators** (all 9 companion-ui occurrences, both admin-ui `@ts-expect-error`s, all 8 src `@ts-expect-error`s) — these are negative tests; casts are required to construct the invalid input.
- **Deliberate cross-process duplication / boundary mirrors** (`substrate-agent-tool.ts`, `agent-loop-patch.ts`) — documented per AGENTS.md and file headers.
- **`sandbox-analysis-contracts.ts:72` `(...args: any[]) => unknown`** for a sandbox host helper — `unknown[]` would be marginally stronger but the sandbox boundary erases types anyway; not worth churn.
- **Non-null assertions**: only 35 in non-test src; sampled ones are post-check narrowing. Not a pattern.
- **Postgres `query<T>` generics being assertion-only**: schema-owned database; adding runtime row validation would be a policy change, not a type fix.

Candidates needing human verification:

- The exact count and disposition of the ~54 untyped pg DML queries (my grep distinguishes typed vs untyped calls, not whether results are safely handled).
- Whether the 6 admin-ui `@ts-nocheck` files have a real forcing error under svelte-check.
- `src/core/contacts/postgres-adapter/connection.ts` and `src/app/maintenance/migrate-channel-envelope.ts` row handling (only files with exclusively untyped queries + `.rows` access).
- Whether any of the 221 baselined errors indicate live runtime bugs (I classified by code and location; I did not trace each).

## Cross-lane notes

- **Dead code lane**: the two dead `eslint-disable-next-line @typescript-eslint/no-explicit-any` comments (`server.ts:1877`, `client.ts:653`) if the rule is never enabled; also potentially the `as any` casts themselves.
- **Defensive code lane**: `shared-workspace-store.ts` partial-field guards vs full-type casts (NIT above) is as much a validation-coverage question as a typing one.
- **Comments/slop lane**: the "payload param is typed as `any`" comments argue for the opposite of what the code does; `as never` sites lack justifying comments.
- **Types/dedup lane**: `VoiceTurnRuntimeContext` vs `DiscordVoiceRuntime` field duplication (the context interfaces re-declare the class's state) is a duplication smell underlying Major 3.
- **Legacy lane**: nothing weak-types-specific found that intersects the alpha migration boundary in `docs/specifications.md`; the gateway param seam predates multi-companion auth and may belong to that migration's scope.
- Prior-audit cross-check: READONLY_AUDIT_origin-main_20260721 S7 ("Production `as any` at gateway RPC boundary") confirmed still present but re-diagnosed — root cause is the erased `MethodDescriptor<any>` generic (Major 2), and two of the three production `as any` are simply redundant casts.
