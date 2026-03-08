# PSFN Testing Audit

Date: 2026-03-08
Branch: `phase-v`
Repo: `/workspace/psfn-framework`

## Scope

This report combines:

- locally verified findings from direct inspection of the current codebase and current test/tooling surface
- the user-provided independent audit findings included in chat
- limited command verification run during this audit

This report does **not** attempt to re-run the full test suite or manually exercise the product in a browser. It is a structural audit of the current testing strategy, false-confidence patterns, and major coverage gaps.

## Verification Legend

- `Locally verified`: I directly confirmed this on current HEAD via code inspection or command output.
- `User-reported, consistent with repo shape`: The user reported it; I did not fully re-measure it end-to-end, but it matches the observed structure of the repo.
- `Inference`: Derived from observed code/test organization; not directly proven by a dedicated command in this audit.

## Executive Summary

The test suite is not worthless, but it is structurally misweighted.

The backend has a meaningful amount of useful unit and request-level integration coverage. That is the good news.

The bad news is that the repo currently lacks the kinds of tests that would catch the most expensive real-world failures:

- no real browser E2E harness for Garden
- no split-runtime E2E that boots gateway + agent and proves basic operator flows
- no full-runtime boot test in the normal Vitest suite
- multiple "wiring tests" that are not behavior tests at all, but source-text grep assertions over `.ts` files
- major product-critical files with either zero direct tests or only shallow indirect coverage

The result is predictable: many tests can pass while the actual shipped experience is still broken.

## Current Test Surface Inventory

### Locally verified

#### Test runner and scripts

Main repo test scripts from [package.json](./package.json):

- `npm test` -> `vitest run`
- `npm run e2e` -> `tsx src/e2e-test.ts`
- `npm run e2e:voice` -> `tsx src/e2e-voice-roundtrip.ts`
- `npm run smoke:chat` -> `node scripts/chat-cockpit-smoke.mjs`
- `npm run smoke:discord:dm-voice` -> `node scripts/discord-dm-voice-smoke.mjs`

Garden app scripts from [admin-ui/package.json](./admin-ui/package.json):

- `npm --prefix admin-ui run dev`
- `npm --prefix admin-ui run build`
- `npm --prefix admin-ui run preview`
- `npm --prefix admin-ui run check`

There is no configured browser E2E runner in the repo root or `admin-ui`:

- no Playwright config
- no Cypress config
- no WebdriverIO config
- no Puppeteer harness

#### Current Vitest environment

[vitest.config.ts](./vitest.config.ts) sets:

- `environment: 'node'`
- default include: `src/**/*.test.ts`

This means the standard suite is a Node test suite, not a browser test suite.

#### Current test-file count on current HEAD

Locally measured via filesystem scan:

- `src` test files: `235`
- `admin-ui/src` test files: `7`
- total test files detected: `242`
- approximate test case count by `it(`/`test(` token scan: `2870`

Important note:

- This differs from the user-provided `~3,146 test cases across 189 files`.
- The discrepancy is explainable by counting method differences, branch state, whether non-`src` tests are included, and whether nested `test`/`it` blocks or `node:test` files are counted differently.
- The important point is not the exact total; it is the distribution and what the tests actually prove.

## Core Findings

### 1. Garden has effectively no browser-level test coverage

Status: `Locally verified`

Evidence:

- [admin-ui/package.json](./admin-ui/package.json) has no browser E2E command.
- [vitest.config.ts](./vitest.config.ts) is Node-only.
- `admin-ui/src/routes` contains `20` `+page.svelte` files.
- Only `1` route directory has any route-local test file.

Current route pages:

- `admin-ui/src/routes/+page.svelte`
- `admin-ui/src/routes/chat/+page.svelte`
- `admin-ui/src/routes/confirmations/+page.svelte`
- `admin-ui/src/routes/contacts/+page.svelte`
- `admin-ui/src/routes/identity/+page.svelte`
- `admin-ui/src/routes/login/+page.svelte`
- `admin-ui/src/routes/memory/+page.svelte`
- `admin-ui/src/routes/model-room/+page.svelte`
- `admin-ui/src/routes/models/+page.svelte`
- `admin-ui/src/routes/primer/+page.svelte`
- `admin-ui/src/routes/prompts/+page.svelte`
- `admin-ui/src/routes/scheduler/+page.svelte`
- `admin-ui/src/routes/sessions/+page.svelte`
- `admin-ui/src/routes/settings/+page.svelte`
- `admin-ui/src/routes/shards/+page.svelte`
- `admin-ui/src/routes/skills/+page.svelte`
- `admin-ui/src/routes/telemetry/+page.svelte`
- `admin-ui/src/routes/theme/+page.svelte`
- `admin-ui/src/routes/tools/+page.svelte`
- `admin-ui/src/routes/values/+page.svelte`

Route-local tests found:

- [admin-ui/src/routes/models/discovery-autofill.test.ts](./admin-ui/src/routes/models/discovery-autofill.test.ts)

That test is helper logic, not full route UX.

Implication:

- Garden login, logout, redirects, session expiry behavior, settings save flows, page navigation, in-browser fetch wiring, websocket client behavior, and visual/DOM interaction paths are mostly untested.

### 2. The repo calls some scripts "E2E", but they are not full-stack system tests

Status: `Locally verified`

#### `npm run e2e`

The file [src/e2e-test.ts](./src/e2e-test.ts) is not exercising the real deployed topology.

It directly does the following in-process:

- loads config via `loadConfig()` + `hydrateJsonBackedRuntimeConfig()`
- composes identity directly
- composes session runtime directly
- constructs `LLMClient` directly
- constructs `MemoryStore` directly
- calls `composeSubstrateAgent(...)` directly
- wires memory/shard runtime directly
- emits `system.init` and `system.ready` manually

Relevant lines:

- [src/e2e-test.ts:69](./src/e2e-test.ts#L69)
- [src/e2e-test.ts:99](./src/e2e-test.ts#L99)
- [src/e2e-test.ts:109](./src/e2e-test.ts#L109)
- [src/e2e-test.ts:137](./src/e2e-test.ts#L137)

What it does **not** prove:

- `src/index.ts` entrypoint behavior
- split launcher behavior
- gateway/agent process handshake
- admin server startup
- browser auth/session flows
- real HTTP/CORS between Garden and API
- real websocket server wiring

#### `npm run e2e:voice`

The file [src/e2e-voice-roundtrip.ts](./src/e2e-voice-roundtrip.ts) is closer to an in-process integration harness than a deployed E2E test.

Relevant lines:

- [src/e2e-voice-roundtrip.ts:59](./src/e2e-voice-roundtrip.ts#L59) defines `InMemoryVoiceConnection`
- [src/e2e-voice-roundtrip.ts:266](./src/e2e-voice-roundtrip.ts#L266) instantiates it
- [src/e2e-voice-roundtrip.ts:407](./src/e2e-voice-roundtrip.ts#L407) constructs `createApiVoiceWebSocketRuntime(...)` directly

This means it bypasses:

- the real websocket server path
- the real browser client
- the real admin/Garden UI
- real cross-origin/browser auth behavior

Conclusion:

- The current "E2E" naming materially overstates what these scripts prove.

### 3. Admin backend tests are useful, but mostly not browser or operator-flow tests

Status: `Locally verified`

There is real value here.

Examples:

- [src/channels/admin/server.test.ts](./src/channels/admin/server.test.ts)
- [src/channels/admin/api-routes.test.ts](./src/channels/admin/api-routes.test.ts)

These tests do use:

- real HTTP requests
- a real `AdminServer` instance
- temp state and SQLite-backed flows in many cases

Examples:

- [src/channels/admin/server.test.ts:233](./src/channels/admin/server.test.ts#L233) starts `new AdminServer(...)`
- [src/channels/admin/api-routes.test.ts:529](./src/channels/admin/api-routes.test.ts#L529) does the same for API-route coverage

That is meaningfully stronger than pure mocks.

However, these tests still do **not** prove browser UX works. They do not drive:

- a real browser DOM
- form interaction
- cookie/session behavior from an actual browser runtime
- client-side route transitions
- in-page error presentation
- settings page interaction behavior
- actual Garden fetch patterns under the browser environment

So these tests are best understood as:

- strong request-level backend contract tests
- not admin UX E2E tests

### 4. There is a large, real source-grep anti-pattern in the suite

Status: `Locally verified`

The user called out a pattern like:

```ts
const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
expect(source).toContain('new ModuleLoader(');
```

I measured this anti-pattern on current HEAD.

#### Locally measured count

Using a narrow regex for explicit source-variable string assertions, current HEAD contains approximately:

- `85` grep-style source assertions

These are assertions of the form:

- read a `.ts` source file into `source`, `runtimeSource`, `agentSource`, `gatewaySource`, etc.
- `expect(...).toContain('symbol or call text')`

Representative examples:

- [src/bootstrap/composition.test.ts:385](./src/bootstrap/composition.test.ts#L385)
- [src/bootstrap/composition.test.ts:386](./src/bootstrap/composition.test.ts#L386)
- [src/bootstrap/composition.test.ts:416](./src/bootstrap/composition.test.ts#L416)
- [src/beads/runtime-wiring.test.ts:78](./src/beads/runtime-wiring.test.ts#L78)
- [src/git/runtime-wiring.test.ts:61](./src/git/runtime-wiring.test.ts#L61)
- [src/contacts/runtime-wiring.test.ts:65](./src/contacts/runtime-wiring.test.ts#L65)
- [src/intention/runtime-wiring.test.ts:216](./src/intention/runtime-wiring.test.ts#L216)
- [src/runtime/startup-entrypoints-parity.test.ts:15](./src/runtime/startup-entrypoints-parity.test.ts#L15)

This confirms the user-reported `81` figure is directionally correct; current HEAD locally measured at `85` with a narrow pattern.

#### Why this is structurally bad

These assertions do **not** prove:

- the code path is reachable at runtime
- the wiring actually executes
- the wiring receives correct config
- the subsystem survives startup
- the failure path works fail-closed
- the user-facing behavior works

They only prove a string literal exists in a file.

This is not behavior testing. It is grep disguised as testing.

### 5. Some tests are strong; the suite is not "all lies"

Status: `Locally verified` and `Inference`

The suite is mixed quality, not uniformly bad.

Examples of stronger classes present in the repo:

- admin HTTP contract tests using a real server instance
- SQLite-backed store tests
- file-I/O backed persistence tests
- trust/config validation tests
- some backend request/response flows with realistic temp state

Examples:

- [src/channels/admin/api-routes.test.ts](./src/channels/admin/api-routes.test.ts)
- [src/channels/admin/server.test.ts](./src/channels/admin/server.test.ts)
- [src/session/store.test.ts](./src/session/store.test.ts)
- [src/persistence/cutover.test.ts](./src/persistence/cutover.test.ts)
- [src/trust/policy.test.ts](./src/trust/policy.test.ts)

So the right conclusion is:

- not all tests are fake
- but the suite is structurally broken as a confidence system because the missing test layers are exactly the ones needed to catch product-breaking regressions

### 6. The current suite is already red in at least one current, visible way

Status: `Locally verified`

I ran:

```bash
npm test -- --run src/values/tools.test.ts
```

Current result:

- failing test in [src/values/tools.test.ts:146](./src/values/tools.test.ts#L146)
- failure is due to docs/runtime parity drift with [README.md](./README.md)

This matters for two reasons:

1. The suite is not currently a clean source of truth.
2. Even the current test surface can drift and become stale in ways that reduce trust further.

### 7. There is no visible CI/workflow layer enforcing browser or smoke coverage

Status: `Locally verified`

Current `.github` contents found during audit:

- `.github/copilot-instructions.md`

No workflow files were present that run:

- Playwright/Cypress/browser tests
- named Garden E2E
- split-mode startup smoke in CI
- admin browser regression suite

This does not prove no external CI exists, but it does prove the repo itself is not currently carrying visible GitHub workflow enforcement for those layers.

## Giant Files and Structural Risk

### Locally verified file sizes on current HEAD

Measured with `wc -l`:

- [src/bootstrap/parity.ts](./src/bootstrap/parity.ts): `1542`
- [src/runtime.ts](./src/runtime.ts): `1381`
- [src/agent-main.ts](./src/agent-main.ts): `1147`
- [src/types.ts](./src/types.ts): `1125`
- [src/channels/admin/api-routes.ts](./src/channels/admin/api-routes.ts): `1443`
- [admin-ui/src/routes/settings/+page.svelte](./admin-ui/src/routes/settings/+page.svelte): `2851`
- [src/gateway-main.ts](./src/gateway-main.ts): `998`
- [src/agent/substrate-agent/tool-orchestration-runtime.ts](./src/agent/substrate-agent/tool-orchestration-runtime.ts): `779`

### User-reported sub-claims

Status: `User-reported, consistent with repo shape`

The user reported:

- `wireHeartbeatRuntime()` in `bootstrap/parity.ts` is `1187` lines in one function
- `runtime.ts init()` is `886` lines
- `agent-main.ts main()` is `892` lines and duplicates `runtime.ts`
- `types.ts` has `69` exports and a `148`-field config interface
- `api-routes.ts` has `55` route handlers in one function

I did not fully re-measure each sub-claim in this audit, but all of them are consistent with the observed file sizes and surrounding architecture.

### Direct test-coverage concerns on critical files

Status: `Locally verified`

Files with **no dedicated direct test file match** found during this audit:

- [src/agent-main.ts](./src/agent-main.ts)
- [src/gateway-main.ts](./src/gateway-main.ts)
- [src/agent/substrate-agent/tool-orchestration-runtime.ts](./src/agent/substrate-agent/tool-orchestration-runtime.ts)

This is especially important because these files sit on critical wiring paths.

For Garden settings specifically:

- [admin-ui/src/routes/settings/+page.svelte](./admin-ui/src/routes/settings/+page.svelte) is the largest file in the repo at `2851` lines
- it has no route-local test file
- `admin-ui check` passes type/build checks but still reports `58` warnings, most from this file

Examples of warning concentration:

- [admin-ui/src/routes/settings/+page.svelte:1596](./admin-ui/src/routes/settings/+page.svelte#L1596)
- [admin-ui/src/routes/settings/+page.svelte:1718](./admin-ui/src/routes/settings/+page.svelte#L1718)
- [admin-ui/src/routes/settings/+page.svelte:2163](./admin-ui/src/routes/settings/+page.svelte#L2163)
- [admin-ui/src/routes/settings/+page.svelte:2178](./admin-ui/src/routes/settings/+page.svelte#L2178)

This does not prove the page is broken, but it is consistent with a page that is too large, too interaction-heavy, and insufficiently covered.

## Specific False-Confidence Patterns

### Pattern A: Source-grep wiring tests

Status: `Locally verified`

Example:

- [src/bootstrap/composition.test.ts:384](./src/bootstrap/composition.test.ts#L384)
- [src/bootstrap/composition.test.ts:385](./src/bootstrap/composition.test.ts#L385)

Why it lies:

- string presence is not runtime execution
- dead code still passes
- commented code can pass
- wrong config can pass
- unreachable branches can pass
- true entrypoint parity is not established

### Pattern B: "200 or 404 is acceptable" success windows on product surfaces

Status: `Locally verified`

Example:

- [src/channels/admin/server.test.ts:286](./src/channels/admin/server.test.ts#L286)
- [src/channels/admin/server.test.ts:287](./src/channels/admin/server.test.ts#L287)
- [src/channels/admin/server.test.ts:288](./src/channels/admin/server.test.ts#L288)

The `/garden` route test explicitly accepts either:

- `200` with HTML
- or `404` because build assets are absent

That means the test can pass while the admin UI is unavailable.

### Pattern C: Narrow smoke treated as broad confidence

Status: `Locally verified`

Example:

- [scripts/chat-cockpit-smoke.mjs](./scripts/chat-cockpit-smoke.mjs)

What it proves:

- bootstrap payload shape
- one chat completion round trip
- optional voice websocket handshake

What it does **not** prove:

- Garden login page works in browser
- page navigation works
- settings save/reload works
- auth redirect UX works
- UI components bind the right payloads
- browser session expiry handling works

## Comparison With User-Provided Independent Findings

### "The suite is not all lies, but structurally broken"

Status: `Confirmed in substance`

I agree with this framing.

The current suite contains real tests with value, but the missing test layers are precisely the ones that would catch the operator-facing failures you are describing.

### "Garden admin UI: zero E2E tests"

Status: `Locally verified in substance`

No browser harness was found. No real Garden browser E2E was found.

### "Frontend: all utility tests, almost no page tests"

Status: `Locally verified in substance`

Current local route-page count: `20`
Current route dirs with local tests: `1`

This matches the user's conclusion even if the exact phrasing or line totals differ.

### "Split-mode (gateway + agent): zero E2E test"

Status: `Locally verified in substance`

I found no true split-runtime E2E in the normal suite that boots the launcher and proves end-to-end readiness plus operator flows.

### "Full runtime boot: zero test in Vitest suite"

Status: `Mostly confirmed`

There are request-level and parity tests, but I did not find a normal Vitest test that boots the full real runtime topology and proves a genuine ready-state path through real entrypoints.

### "81 source-grep assertions"

Status: `Confirmed directionally; local current count is higher`

User reported: `81`
Local current narrow regex count: `85`

Conclusion:

- the exact number may vary slightly by regex and branch state
- the anti-pattern is real and materially present

## What Is Missing That Would Actually Reduce 2-3am Failures

Status: `Inference strongly supported by local evidence`

The highest-value missing tests are:

1. Real Garden browser E2E
- login
- logout
- redirect to `/garden/login`
- expired-cookie handling
- basic route navigation

2. Real Settings page E2E
- load settings
- edit values
- save
- reload page
- verify persistence actually hit the correct owner JSON files
- verify fail-closed error presentation

3. Real Chat cockpit/browser E2E
- bootstrap
- send message
- receive response
- session continuity
- error display
- optional voice websocket path from browser

4. Real split-mode boot smoke
- run launcher
- wait for gateway ready
- wait for agent ready
- hit admin/bootstrap endpoints
- confirm one real user flow succeeds

5. Runtime-entrypoint startup tests
- `src/index.ts`
- `src/gateway-main.ts`
- `src/agent-main.ts`
- verify basic startup/teardown behavior, not just source text parity

6. Remove grep-tests and replace them with reachability/behavior tests

## Final Conclusion

The current repo has a substantial number of tests, but the suite is currently optimized for:

- unit behavior
- helper normalization
- backend request contracts
- internal wiring shape

It is not optimized for proving that the actual shipped product works.

That is why regressions are still making it through.

The biggest trust failures are not just "not enough tests"; they are:

- mislabeled in-process integration scripts called `e2e`
- no browser E2E for the main operator surface
- source-grep assertions pretending to validate runtime wiring
- oversized high-risk files with inadequate direct behavioral coverage
- a suite that can still pass while critical UX paths are broken or unavailable

## Commands Run During This Audit

- `cat package.json`
- `cat admin-ui/package.json`
- `find . -maxdepth 3 ...`
- `cat vitest.config.ts`
- route/test inventory scans over `admin-ui/src/routes`
- source/test inventory scans over `src/**/*.test.ts` and `admin-ui/src/**/*.test.*`
- `wc -l` on major files
- `npm test -- --run src/values/tools.test.ts`
- `npm --prefix admin-ui run check`

## Notes

- This report intentionally ignores the currently in-progress local changes in `config/settings.seed.json`, `src/emotion/observer.ts`, and `src/emotion/text-classifier.ts`, per explicit user instruction.
- Untracked files left untouched:
  - `.beads.backup-pre-upgrade-20260306/`
  - `AUDIT_PHASE_V.md`
  - `CLAUDIT_PHASE_V.md`
