# CODEX 325 Repo Review

Date: 2026-03-25
Repo: `psfn-live`
Review mode: static code review plus parallel multi-agent audit
Primary review bead: `PSFNLIVE-pxv`

## Scope

This review explicitly targeted:

- hardcoded values
- mock or synthetic fallbacks
- the literals `vega` and `purrsephone`
- hardcoded local-machine paths
- agent-side bypasses of the gateway, except the allowed `ntfy` case
- unwired, no-op, or stale contract code
- weak or misleading tests
- SQL injection, unvalidated input, race conditions
- missing error handling, silent failures, unclear ownership
- bad types
- 500+ line god files
- separation of concerns, duplicate rules, redundant code
- regression history in `bd`

I reviewed the live tree locally and used parallel sub-reviewers for:

1. security and gateway-boundary violations
2. repo hygiene, hardcoded paths/names, wiring, duplication
3. tests, fallbacks, type escapes, and tracker regressions

## Bottom Line

The repo has real security and architecture problems, not just cleanup debt.

The highest-risk findings are:

1. Arbitrary code execution through `module_install` plus `import(data:text/javascript;base64,...)` in the live process.
2. Direct provider egress from the split agent through the API voice websocket path, bypassing the gateway.
3. A new SSRF-class fetch surface in `image.edit`.
4. Direct local process execution from agent lifecycle tools (`self_restart` / `self_rebuild`), which bypasses the gateway boundary.
5. Repo-owned operational files and backup settings still baking in host-specific paths and personal-name literals.

The repo also still has a live test regression already tracked in beads, several fail-open admin/prompt behaviors, and large structural debt that makes ownership and verification harder than it should be.

## Executive Summary

Confirmed high-severity findings:

- `critical`: arbitrary live-process code execution via module installation and module loading
- `high`: agent-side network egress bypassing the gateway in voice websocket runtime
- `high`: gateway-side image URL fetching without dedicated policy gating or byte caps
- `high`: direct agent/runtime shell execution in lifecycle tools
- `high`: host-specific paths and personal-name literals in the authoritative repo-owned service unit
- `high`: backup config/UI hardcode a local path and swallow config-load errors

Confirmed medium-severity findings:

- admin bootstrap still hides broken character-card state
- admin bootstrap still derives transport identity from unrelated linked identities
- prompt registry history writes are non-fatal and can silently lose audit history
- module registry mutations are race-prone read-modify-write
- `issue_sync` tool contract text no longer matches the gateway implementation
- silent failures still exist in production code
- production-critical monkeypatching exists without direct tests

Confirmed test-quality problems:

- open regression: `src/channels/admin/api-routes.test.ts` harness is currently incompatible with strict prompt-registry startup
- tests explicitly codify at least one bad admin-bootstrap fallback
- test code uses `as any` 904 times; non-test code uses it 16 times
- `installAgentToolSchedulerPatch` has no direct test coverage

Structural debt:

- multiple production files exceed 500 lines, including 1,000+ line entrypoints and 1,800+ line servers
- startup and scheduler behavior are duplicated across runtime modes

Tracker outcome:

- existing tracked regressions were confirmed
- 8 new follow-up beads were created from this review:
  - `PSFNLIVE-1iu`
  - `PSFNLIVE-a44`
  - `PSFNLIVE-zjr`
  - `PSFNLIVE-5jk`
  - `PSFNLIVE-ixy`
  - `PSFNLIVE-47d`
  - `PSFNLIVE-i4r`
  - `PSFNLIVE-ite`

## Detailed Findings

### 1. Critical: autonomous module install is arbitrary code execution

Files:

- `src/repl/sandbox-capabilities/modules.ts:92-97`
- `src/repl/sandbox-capabilities/modules.ts:121-170`
- `src/repl/sandbox-capabilities/modules.ts:186-250`
- `src/modules/loader.ts:193-206`
- `src/modules/loader.ts:262-276`

What is happening:

- `module_install` persists arbitrary source text into the module registry.
- the loader turns that source into a `data:` import and executes it directly with full Node privileges.
- registry updates and `lastError` persistence are plain read-modify-write operations with no lock or compare-and-swap.

Why this is bad:

- this is live-process arbitrary code execution, not just dynamic configuration
- in split/yolo mode it defeats the gateway boundary completely
- concurrent installs/enables/error updates can stomp each other and lose state

Evidence:

- `saveModuleRegistry()` writes the module source directly to registry JSON
- `module_install()` is allowed for non-`nursery` tiers
- `loadModuleDefinition()` executes registry source via `import(data:text/javascript;base64,...)`

Tracker:

- no current `PSFNLIVE-*` bead matched this before review
- created `PSFNLIVE-1iu`

### 2. High: API voice websocket runtime bypasses the gateway

Files:

- `src/agent-main.ts:757-762`
- `src/channels/api/voice-websocket-runtime.ts:263-320`
- `src/voice/connectors/stt/deepgram-stream.ts:447-461`
- `src/voice/connectors/tts/elevenlabs-stream.ts:167-181`

What is happening:

- the split agent instantiates the voice websocket runtime locally
- the runtime builds provider connectors locally
- Deepgram opens a provider websocket directly
- ElevenLabs does a direct HTTP POST directly

Why this is bad:

- the agent is supposed to exit through the gateway, not open provider traffic itself
- these calls bypass gateway URL policy, audit, approval, and egress ownership
- this is exactly the kind of boundary break the review request called out

Tracker:

- no current `PSFNLIVE-*` bead matched this before review
- created `PSFNLIVE-a44`

### 3. High: `image.edit` recreates an SSRF surface on the gateway

Files:

- `src/gateway/methods/image.ts:17-39`
- `src/gateway/policy.ts:280-283`
- `src/images/comfyui.ts:325-347`

What is happening:

- `image.create` and `image.edit` are audited-only methods
- gateway policy allows them unconditionally once the method is reachable
- `downloadImage()` fetches caller-supplied URLs with raw `fetch()`

Why this is bad:

- this is an SSRF-class surface parallel to the hardened `web.fetch` path
- there is no dedicated image-method policy gate
- there is no explicit byte cap before buffering remote image data

Tracker:

- no current `PSFNLIVE-*` bead matched this before review
- created `PSFNLIVE-zjr`

### 4. High: lifecycle tools bypass the gateway with direct shell execution

Files:

- `src/tools/lifecycle.ts:25-37`
- `src/tools/lifecycle.ts:167-175`
- `src/agent-main.ts:1063-1083`
- `src/runtime.ts:902-928`

What is happening:

- `launchRestartCommand()` uses `spawn(command, { shell: true, detached: true })`
- `self_rebuild` runs `execSync('npm run build')`
- both tools are registered in the agent and monolithic runtime

Why this is bad:

- this is direct local process execution from tool code
- it bypasses gateway policy and audit
- the user explicitly asked for agent-side gateway bypasses to be treated as findings, with only `ntfy` excepted

Notes:

- the restart command itself is env-controlled, so this is more of a boundary/ownership violation than a classic user-input injection
- it is still a real violation of the intended split architecture

Tracker:

- no current `PSFNLIVE-*` bead matched this before review
- created `PSFNLIVE-5jk`

### 5. High: the repo-owned service unit still hardcodes host-specific paths and personal literals

Files:

- `scripts/system/user/purrsephone.service:2`
- `scripts/system/user/purrsephone.service:10-17`
- `scripts/system/user/purrsephone.service:24`
- `docs/operations/psfn-system-account.md:5-13`

What is happening:

- the authoritative repo-owned user unit still contains:
  - `/mnt/samesung/ai/psfn-live`
  - `/home/vega/.nvm/...`
  - `purrsephone.db`
  - `purrsephone.json`
  - `SyslogIdentifier=purrsephone`

Why this is bad:

- it bakes one machine and one operator identity into the repo-owned live unit
- it conflicts with the documented goal of getting away from private host-specific mounts and operator-home dependencies
- it keeps the exact literals the user asked to scrub

Regression / tracker context:

- related history: `PSFNLIVE-8j5.9`, `PSFNLIVE-8j5.10`
- open related scrub task: `PSFNLIVE-8wf`
- not fully tracked as a host-path generalization bug before this review
- created `PSFNLIVE-ite`

### 6. High: backup config is fail-open and hardcodes a local machine path

Files:

- `src/backup/config.ts:8`
- `src/backup/config.ts:61-70`
- `src/backup/config.ts:84-95`
- `src/config/backup-config.ts:65-75`
- `admin-ui/src/routes/settings/+page.svelte:266-272`
- `admin-ui/src/routes/settings/+page.svelte:1091-1102`
- `admin-ui/src/routes/settings/+page.svelte:2433-2436`

What is happening:

- backend and admin UI default to `/mnt/ai/psfn-bak`
- backup config loading is wrapped in a blanket `catch {}` and falls back to hardcoded defaults
- `loadBackupConfig()` is strict and validates `backup.json`, but that strictness is discarded here

Why this is bad:

- malformed or unreadable `backup.json` silently becomes a default config path
- mutable owner-file configuration drifts back toward baked-in literals
- this is both a hardcoded-path problem and a hidden-fallback problem

Tracker:

- no matching current bead existed before review
- created `PSFNLIVE-ixy`

### 7. Medium: admin bootstrap still hides broken identity state

Files:

- `src/channels/admin/chat/bootstrap.ts:711-739`
- `src/channels/admin/chat/bootstrap.test.ts:298-360`

What is happening:

- `loadCurrentCharacterCard()` swallows `loadCharacterCard()` failures and returns `null`
- `resolveAssistantName()` then falls back to `runtimeConfig.characterName`
- `resolveOnboardingMetadata()` treats failed loads the same as no starter card

Why this is bad:

- broken or unreadable identity state can still look healthy in admin bootstrap
- this is a leftover fail-open behavior in an area that was supposed to fail closed

Regression / tracker context:

- likely leftover/regression relative to `PSFNLIVE-8j5.7`
- created `PSFNLIVE-47d`

### 8. Medium: admin bootstrap still derives `defaultAuthorId` from the wrong source

Files:

- `src/channels/admin/chat/bootstrap.ts:514-526`
- `src/channels/admin/chat/bootstrap.ts:605-620`
- `src/channels/admin/chat/bootstrap.test.ts:176-220`

What is happening:

- for conversation targets, `resolveDefaultAuthorId()` looks up the first linked identity on the contact
- that value is written into transport headers as `X-User-ID`
- the test suite explicitly expects the fallback behavior for a Discord conversation target

Why this is bad:

- session/transport identity can drift away from the selected target
- the current tests preserve the fallback instead of flagging it

Regression / tracker context:

- same family as `PSFNLIVE-8j5.7`
- included in `PSFNLIVE-47d`

### 9. Medium: prompt registry audit history can be lost without blocking the update

Files:

- `src/identity/prompt-registry.ts:217-246`
- `src/identity/prompt-registry.ts:367-372`
- `src/identity/prompt-registry.test.ts:67-81`

What is happening:

- `update()` writes history first, but `appendHistory()` catches write failures and only logs
- prompt content still updates and saves successfully
- tests cover only the happy path

Why this is bad:

- prompt history is an audit trail
- if that write matters, it should fail closed or become explicitly operator-visible
- current behavior can silently desynchronize current prompt state from its change history

Regression / tracker context:

- related area: `PSFNLIVE-8j5.3`
- no current dedicated bead existed before review
- created `PSFNLIVE-i4r`

### 10. Medium: current test harness regression is real and already tracked

Files:

- `src/channels/admin/api-routes.test.ts:468-470`
- `src/identity/prompt-registry.ts:188-195`

What is happening:

- the admin API test harness constructs `PromptRegistryStore` on a temp path it never seeds
- `PromptRegistryStore` now immediately calls `loadStrict()` in the constructor

Why this matters:

- this is not a flaky test; it is a structurally broken harness after strict prompt-registry hardening
- it means at least part of the test surface is currently lying about repo health

Tracker:

- already tracked by open bead `PSFNLIVE-8j5.10.2`

### 11. Medium: production-critical monkeypatching exists with no direct tests

Files:

- `src/agent/agent-loop-patch.ts:5-182`
- `src/agent/substrate-agent.ts:333-345`

What is happening:

- PSFN patches private `pi-agent-core` internals through a broad `PatchedAgent` type full of `any`
- on failure it fabricates assistant messages and event objects itself
- the patch is installed in production
- `rg -n "agent-loop-patch|installAgentToolSchedulerPatch" src --glob '*.test.ts'` returned no matches

Why this is bad:

- this is a fragile boundary against upstream library changes
- it is core runtime behavior without direct tests
- the fabricated event path is especially risky because it recreates protocol behavior manually

Tracker:

- no current dedicated bead existed before review
- not broken enough yet to warrant a separate top-priority bead above the security items, but it should not be ignored

### 12. Medium: tests are heavily type-bypassed and sometimes codify the wrong behavior

Evidence:

- `src/runtime/bootstrap-helpers.test.ts:115-170`
- `src/agent/stream-adapter.test.ts:164-179`
- `src/channels/admin/chat/bootstrap.test.ts:214`
- repository count:
  - test `as any`: `904`
  - non-test `as any`: `16`

Why this matters:

- this is how contract drift hides in plain sight
- the tests are often proving that helper functions accept invalid shapes instead of proving the real types are enforced
- some tests, like the admin bootstrap conversation case, are actively preserving fallback behavior that should be questioned

### 13. Medium: production code still contains silent failures

Files:

- `src/channels/discord/adapter.ts:777-786`
- `src/backup/config.ts:65-70`
- `src/channels/admin/chat/bootstrap.ts:733-739`

Examples:

- Discord typing errors are swallowed with `.catch(() => {})`
- backup config load errors are swallowed
- character-card load failures are swallowed

Why this matters:

- these are not harmless logs-only concerns; they are precisely the kind of fail-open behavior that keeps broken state looking healthy

### 14. Medium: `issue_sync` contract text is stale and misleading

Files:

- `src/beads/runtime-wiring.ts:18-25`
- `src/gateway/protocol.ts:148`
- `src/gateway/methods/beads.ts:487-500`

What is happening:

- the tool/gateway contract still exposes `issue_sync` / `beads.sync`
- repo instructions explicitly say not to rely on `bd sync`
- the gateway implementation behind `beads.sync` now performs GitHub Project sync, not the old `bd sync` semantics

Why this matters:

- it is a stale tool contract in a repo that treats `bd` as authoritative
- if the UI/tool description is wrong, operators and future code will reason from the wrong contract

Tracker:

- no dedicated bead existed before this review
- lower priority than the security findings, but still real cleanup debt

## God Files And Separation Of Concerns

Production files over 500 lines:

- `src/runtime.ts` - 1401 LOC
- `src/agent-main.ts` - 1200 LOC
- `src/gateway-main.ts` - 1011 LOC
- `src/channels/admin/api-routes.ts` - 1812 LOC
- `src/channels/api/server.ts` - 1811 LOC
- `src/bootstrap/parity.ts` - 1633 LOC
- `admin-ui/src/routes/settings/+page.svelte` - 3316 LOC

Other large but important files:

- `src/memory/retrieval.ts` - 2153 LOC
- `src/channels/discord/voice.ts` - 1761 LOC
- `src/channels/telegram/adapter.ts` - 1353 LOC
- `src/gateway/client.ts` - 1350 LOC

Why this matters:

- ownership is smeared across runtime bootstrapping, policy, IO, scheduler wiring, and admin transport
- reviews and regression testing get harder because one edit can affect too many concerns
- the duplicated code I found is exactly what large files tend to produce

Concrete duplication confirmed:

- `logStartupHydrationDiagnostics()` is independently implemented in:
  - `src/gateway-main.ts:117`
  - `src/runtime.ts:183`
  - `src/agent-main.ts:170`
- `salience-decay` and `Compression Guideline Review` scheduler wiring are duplicated in:
  - `src/runtime.ts:696+`
  - `src/agent-main.ts:593+`

## Hardcoded Names And Paths

Confirmed personal-name or host-path hits that matter:

- repo-owned live unit:
  - `scripts/system/user/purrsephone.service`
- backend default mirror path:
  - `src/backup/config.ts:8`
- admin UI default mirror path:
  - `admin-ui/src/routes/settings/+page.svelte:271`
  - `admin-ui/src/routes/settings/+page.svelte:1098`
  - `admin-ui/src/routes/settings/+page.svelte:2435`
- tests still carrying `Vega` / `Purrsephone` literals:
  - `src/memory/extraction/mention-only-contacts.test.ts:36+`
  - `src/tools/session-search.test.ts:184+`
  - `src/scripts/install-psfn-service.test.ts:47+`

Tracker context:

- open scrub task already exists: `PSFNLIVE-8wf`
- this review added `PSFNLIVE-ite` because the authoritative service unit still embeds host-specific paths and personal literals

## SQL Injection, Input Validation, Race Conditions

What I found:

- no confirmed SQL injection bug rose to the top in this pass
- the dominant input-validation and exploitation risks were elsewhere:
  - arbitrary module source execution
  - remote image URL fetching
  - direct agent provider egress
  - header/identity fallback in admin bootstrap
- confirmed race condition:
  - module registry mutation and `lastError` persistence are read-modify-write without a lock or CAS

So:

- SQL injection was not the major problem in this codebase snapshot
- arbitrary code execution, SSRF, and gateway-boundary violations are the bigger risks right now

## Regression And Bead History

Already tracked and still relevant:

- `PSFNLIVE-8j5.10.2`
  - current admin API test harness regression after strict prompt-registry startup
- `PSFNLIVE-8j5.8`
  - launcher/runtime hardcoded admin and socket defaults remain open
- `PSFNLIVE-8wf`
  - repo-wide scrub of legacy personal names and lab fixtures remains open

Closed beads that this tree appears to have partially backslid from or left incomplete:

- `PSFNLIVE-8j5.3`
  - prompt fallback hardening landed, but prompt history durability is still non-fatal
- `PSFNLIVE-8j5.7`
  - admin bootstrap synthetic defaults were supposedly removed, but broken card state and cross-target author fallback still remain
- `PSFNLIVE-8j5.9`
  - repo-owned service move landed, but the repo-owned unit is still machine-specific and identity-specific

New beads created from this review:

- `PSFNLIVE-1iu` - module install / execution hardening
- `PSFNLIVE-a44` - voice websocket gateway boundary
- `PSFNLIVE-zjr` - image-edit SSRF hardening
- `PSFNLIVE-5jk` - lifecycle tool gateway boundary
- `PSFNLIVE-ixy` - backup config fail-closed + path cleanup
- `PSFNLIVE-47d` - admin bootstrap identity/author fallback hardening
- `PSFNLIVE-i4r` - prompt registry history durability
- `PSFNLIVE-ite` - repo-owned service path/name generalization

All of the new beads were linked back to `PSFNLIVE-pxv` with `discovered-from`.

## Questions I Could Not Fully Prove In This Pass

- I did not prove a specific unreachable production module or dead file end-to-end.
- I did not prove a concrete SQL injection vector.
- I did not run a full unused-export or dead-code analyzer across the whole repo.

Those are worth another pass only after the critical/high boundary issues are addressed, because the current top risks are much worse than ordinary dead code.

## Recommended Order

1. `PSFNLIVE-1iu` - module execution hardening
2. `PSFNLIVE-a44` - voice websocket gateway boundary
3. `PSFNLIVE-zjr` - image SSRF hardening
4. `PSFNLIVE-5jk` - lifecycle command boundary
5. `PSFNLIVE-ixy` - backup config fail-closed
6. `PSFNLIVE-47d` - admin bootstrap fail-closed cleanup
7. `PSFNLIVE-8j5.10.2` - fix the already-broken admin API test harness
8. `PSFNLIVE-ite` and `PSFNLIVE-8wf` - service/path/name scrub

## Final Assessment

This repo is not mainly suffering from cosmetic sloppiness. The worst problems are boundary and trust problems:

- the agent can still do things it should only do through the gateway
- the gateway has a fresh SSRF-class input path
- the module system is effectively code injection by design
- several supposedly fail-closed areas still hide broken state

The repo also has real hygiene debt:

- hardcoded local paths
- stale personal literals
- giant god files
- duplicated runtime logic
- weakly typed tests that sometimes preserve the wrong behavior

The review did not find a dominant SQL injection problem, but it did find multiple more serious issues than SQL injection.
