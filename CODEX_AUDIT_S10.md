# Codex Audit: Sprint 10 Prep

Date: 2026-07-09

Audited source: `origin/main` at `bbef11c5287d910c278292df341120a815f53b2c`

Audit worktree: `/home/ada/ai/dev/worktrees/psfn-framework/audit-s10-main`

Tracking bead: `psfn-framework-9kj9`

## Executive Summary

No critical issue was confirmed in the audited slice. The highest-risk Sprint 10 work is concentrated around the runtime security boundary: shell execution for the Obsidian vault bridge, Home Assistant gateway policy semantics, configuration ownership for network/tool-routing settings, and UBS-confirmed denial-of-service / outbound-fetch guard gaps.

Follow-up beads filed from this audit:

- `psfn-framework-lget`: Harden Obsidian vault CLI execution path.
- `psfn-framework-2izg`: Make Home Assistant gateway policy deny unconfigured methods.
- `psfn-framework-w3pj`: Move high-risk network and tool-routing settings out of mutable settings.json.
- `psfn-framework-vj0w`: Surface startup memory hydration failures as degraded runtime state.
- `psfn-framework-c5wf`: Update dev toolchain dependencies flagged by npm audit.
- `psfn-framework-nw90`: Harden fs.search regex mode against event-loop ReDoS.
- `psfn-framework-sj4d`: Reject Redis TLS verification bypass in production.
- `psfn-framework-6ny2`: Route Discord media URL fetches through URL policy and streaming limits.

## Findings

### High: Obsidian CLI path is shell-interpolated from mutable settings

`src/boundary/integrations/vault/ops.ts:178-181` builds a single shell command with:

```ts
const cmd = `${this.config.cliPath} ${args.join(' ')}`;
return execSync(cmd, ...);
```

The vault argument values are shell-escaped, but the executable path itself is not. That executable path is accepted from the settings form at `src/system/settings/form.ts:552-555` and applied into runtime config at `src/system/settings/runtime.ts:834-840`.

Impact: when vault tools are enabled, a malicious or accidental `obsidianCliPath` value containing shell metacharacters can run shell content as the gateway host user on the next `vault.read`, `vault.write`, `vault.search`, or `vault.daily` operation.

Recommended fix: replace shell-string execution with `execFileSync` or `spawn` using an argv array, store vault args as raw values instead of pre-escaped strings, validate the executable path, and add regression tests for shell metacharacters in both `obsidianCliPath` and normal vault arguments.

Follow-up: `psfn-framework-lget`.

### High: Home Assistant policy fails open for unconfigured methods

`src/boundary/gateway/policy.ts:315-323` returns `ALLOW` for `home_assistant.get_states` and `home_assistant.check_connection`, and returns `ALLOW` for `home_assistant.call_service` when Home Assistant is not fully configured. The approval boundary evaluates this policy before handler execution at `src/boundary/gateway/approval-boundary.ts:81-94`.

The handler does recheck runtime state: disabled Home Assistant is denied at `src/boundary/gateway/methods/home-assistant.ts:57-65`, and missing token material is denied at `src/boundary/gateway/methods/home-assistant.ts:108-111`. So this is not a confirmed disabled-HA execution path today. It is still a policy invariant failure: the central audit/confirmation decision says `ALLOW` exactly when config is absent, and future handler refactors or policy-only callers inherit a fail-open contract.

Recommended fix: make policy return `DENY` for all Home Assistant methods unless the feature is enabled, a base URL is present, and token material is configured. Keep `call_service` as `NEEDS_APPROVAL` when configured. Explicitly decide and test whether configured `get_states` and `check_connection` should be `ALLOW` or `NEEDS_APPROVAL`.

Follow-up: `psfn-framework-2izg`.

### High: Security-sensitive network and tool-routing controls remain mutable settings

The owner-file split currently marks only model settings, legacy model keys, `maintenanceIntervalMs`, and `capabilityTier` as non-runtime settings in `src/system/settings/schema.ts:24-29`. `saveSettings` then writes the remaining payload to `settings.json` at `src/system/settings/io.ts:64-76`.

High-risk keys still listed in `RUNTIME_SETTINGS_KEYS` include:

- Web/network expansion: `webFetchAllowInternalNetwork`, local crawler settings, and `webFetchTlsCaCertPaths` at `src/system/settings/contracts.ts:277-286`.
- Home Assistant targeting: `homeAssistantEnabled` and `homeAssistantBaseUrl` at `src/system/settings/contracts.ts:280-281`.
- Channel/tool routing: `telegramAuthorizedUsers`, `wyomingShardRouting`, and `shardToolsets` at `src/system/settings/contracts.ts:313-316`.
- External executable configuration: `obsidianVaultName` and `obsidianCliPath` at `src/system/settings/contracts.ts:317-320`.

Those values are applied directly into runtime config in `src/system/settings/runtime.ts:645-692`, `src/system/settings/runtime.ts:787-802`, `src/system/settings/runtime.ts:820-827`, and `src/system/settings/runtime.ts:830-840`.

Impact: generic settings writes can change network reachability, internal-network fetch posture, channel authorization, shard tool routing, and executable paths. This weakens the repository's strict configuration ownership model and compounds the Obsidian CLI finding above.

Recommended fix: reclassify high-risk network, channel authorization, tool-routing, and executable-path settings into canonical owner files or read-only/admin-reviewed surfaces. Extend `saveSettings` rejection tests, Garden settings exposure, and `npm run verify:settings-contract` coverage.

Follow-up: `psfn-framework-w3pj`.

### Medium: Dev toolchain has critical/high npm audit advisories

`npm audit --json` on the audited branch reported 6 total vulnerabilities in the full dependency tree: 1 critical, 3 high, 1 moderate, and 1 low. The critical direct advisory is for `vitest` (`GHSA-5xrq-8626-4rwp`), with npm reporting `vitest@4.1.10` as the non-major fixed version. The high advisories are in dev/build transitive dependencies including `vite`, `picomatch`, and `flatted`.

`npm audit --omit=dev --json` reported zero production dependency vulnerabilities. That keeps this out of the runtime-critical bucket, but the test/admin-UI build toolchain is still carrying known critical/high issues.

Recommended fix: update the pinned dev/build/test toolchain to exact fixed versions, avoid `npm audit fix --force`, and verify both the root project and `admin-ui` dependency trees.

Follow-up: `psfn-framework-c5wf`.

### Medium: Startup memory hydration failures are warning-only

At agent startup, `src/app/agent/main.ts:342-350` catches `hydrateStartupActiveMemoryContexts` failures and only logs `Startup active memory hydration failed`. `src/app/agent/main.ts:352-358` does the same for core-memory block hydration. Startup then continues into internal state rehydration and runtime wiring.

Impact: after a restart, the runtime can accept user turns with missing active memory or core-memory continuity while the only signal is a warning log. That is a poor failure mode for Sprint 10 work touching memory, places, identity, or multi-companion continuity.

Recommended fix: in production, either fail startup or enter an explicit degraded state surfaced through health/admin status and block normal turns until hydration recovers. If local/continuous mode remains permissive, make that mode split explicit and tested.

Follow-up: `psfn-framework-vj0w`.

## UBS Addendum

UBS was run from upstream tag `v5.3.4` at commit `bd81b3f5ed11bfffa01f5b4b291212335f92ad43` with auto-update disabled:

```bash
UBS_NO_AUTO_UPDATE=1 /tmp/ubs-v5.3.4/ubs . --format=jsonl --no-auto-update
```

The scan exited non-zero with aggregate categories. A second run with `--beads-jsonl` and `--report-json` still emitted only summary rows, so the additional findings below are manual triage of the high-signal UBS categories against source.

### High: fs.search regex mode can monopolize the Node event loop

The public `fs.search` RPC accepts `mode?: 'literal' | 'regex'` in `src/boundary/gateway/protocol.ts:187-195`; the gateway handler forwards `params.mode` into `searchWorkspaceFiles` at `src/boundary/gateway/methods/fs.ts:228-240`. Policy bounds query presence, glob, match/file/byte limits, and context lines at `src/boundary/gateway/policy.ts:432-458`, but it does not validate `mode` or regex complexity.

The implementation compiles caller-provided regexes at `src/boundary/integrations/filesystem/workspace-ops.ts:353-361` and then runs `regex.exec` synchronously over each line at `src/boundary/integrations/filesystem/workspace-ops.ts:217-239`. The scan is bounded to at most 500 files and 200 KB per file, but a catastrophic backtracking pattern can still block the event loop before those outer limits help.

Recommended fix: deny regex mode unless it is truly required, or route it through a safe/bounded matcher with timeout/cancellation semantics. Add policy tests for unsupported mode values and a regression test for a known catastrophic pattern.

Follow-up: `psfn-framework-nw90`.

### High: Discord remote media fetches bypass URL policy and stream limits

`discord.sendMedia` is allowed unconditionally in `src/boundary/gateway/policy.ts:238-246`, and the handler passes `params.media` through at `src/boundary/gateway/methods/discord.ts:22-28`. The media shape includes `url` and optional `localPath` in `src/shared/contracts/runtime.ts:291-297`.

When `localPath` is absent or not present on disk, `src/channels/discord/adapter.ts:388-415` fetches `media.url` directly and buffers `await response.arrayBuffer()` without the gateway web URL policy, internal-network checks, an `AbortSignal`, timeout, or streaming max-byte enforcement. Discord document ingestion has the same buffering pattern at `src/channels/discord/file-ingest.ts:253-264`; it rejects oversized payloads only after the full response has already been read into memory.

Recommended fix: constrain remote Discord downloads through the gateway URL policy or a Discord-CDN-specific allowlist, deny internal/private network targets unless explicitly allowed, and use streaming byte limits plus timeout/cancellation. Preserve the existing local-path path for generated images.

Follow-up: `psfn-framework-6ny2`.

### Medium: Redis cache TLS verification can be disabled in production

`src/shared/cache/redis-cache.ts:14` defines `PSFN_REDIS_TLS_REJECT_UNAUTHORIZED`. `resolveAppCacheRuntimeConfigFromEnv` parses it with default `true` but accepts `false` at `src/shared/cache/redis-cache.ts:140-145`, and `buildRedisClientOptions` passes it to the Redis socket at `src/shared/cache/redis-cache.ts:186-190`.

Production startup explicitly rejects gateway TLS verification bypasses and process-global TLS disablement in `src/system/config/load-config.ts:260-272`, but there is no equivalent production-layout rejection for `PSFN_REDIS_TLS_REJECT_UNAUTHORIZED=false` when `PSFN_APP_CACHE_MODE=redis`.

Recommended fix: fail closed in production runtime layout when Redis TLS verification is disabled. Keep `rediss://` with default verification and `PSFN_REDIS_TLS_CA_CERT_PATH` as the supported custom trust path.

Follow-up: `psfn-framework-sj4d`.

### UBS false positives discarded

- Beads command execution: `src/boundary/gateway/methods/beads.ts:166-176` uses `spawn('bd', args, { shell: false })`, validates issue refs before argv construction, caps output, and has tests covering `shell: false`.
- Async EventBus listeners: `src/shared/event-bus.ts:1061-1083` awaits guards and handlers with `Promise.allSettled`; async Discord/Telegram listeners are not dropped promises.
- Sensitive logging: the flagged `token` logs are token-count/budget telemetry or sanitizer status messages, not credential values.
- Archive traversal: Office/ZIP handling uses entry-size limits and bounded inflation in `src/channels/discord/zip-container.ts:145-185`; tree backup manifest verification rejects paths escaping the capture root in `src/persistence/backups/companion-tree.ts:150-166`.

## Areas Checked

- Runtime entrypoints and boot wiring: `src/app/gateway/main.ts`, `src/app/agent/main.ts`, startup helpers.
- Configuration ownership and persistence layout: `src/system/settings/*`, `src/system/config/*`, `src/persistence/layout.ts`, `src/persistence/runtime-factory.ts`.
- Gateway policy and privileged tool paths: gateway approval boundary, Home Assistant methods, vault methods, shell-backed integrations, Garden/API auth startup policy.
- Persistence query shape: sampled Postgres stores and dynamic SQL sites. The model usage dynamic `ORDER BY`/`LIMIT` path uses fixed expressions and normalized limits, so it was not raised as a finding.
- Supply-chain pinning surface: Kubernetes images are pinned by tag and digest where external images are used; the satellite hub build script rejects floating image tags. npm production audit is clean; dev tooling has tracked advisories.
- UBS high-signal categories: command execution, dynamic regex, outbound fetch/SSRF, TLS bypass, archive traversal, sensitive logging, and async listener handling.

## Sprint 10 Priority

1. Fix `psfn-framework-lget` first. It is the clearest command execution boundary issue.
2. Fix `psfn-framework-2izg` with policy tests before expanding Home Assistant/world-control work.
3. Start `psfn-framework-w3pj` early if Sprint 10 adds locations, places, or channel routing settings. Otherwise new UI work will likely deepen the settings ownership debt.
4. Fix `psfn-framework-nw90` and `psfn-framework-6ny2` before exposing broader filesystem/media workflows to autonomous agents.
5. Schedule `psfn-framework-vj0w` before memory/continuity changes are treated as production-ready.
6. Fold `psfn-framework-sj4d` into production config hardening if Redis app cache is planned for Sprint 10.
7. Use `psfn-framework-c5wf` to clear dev-tool audit noise before Sprint 10 release prep.

## Validation Notes

This was a static codebase audit. No production code was changed.

Commands run on the audit worktree:

- `npm ci`: passed, then reported npm audit advisories in the installed dependency tree.
- `npm audit --json`: reported 1 critical, 3 high, 1 moderate, and 1 low dev-tooling vulnerabilities.
- `npm audit --omit=dev --json`: passed with zero production dependency vulnerabilities.
- `UBS_NO_AUTO_UPDATE=1 /tmp/ubs-v5.3.4/ubs . --format=jsonl --no-auto-update`: completed with findings; manually triaged high-signal categories into the UBS addendum above.
- `npm run lint`: passed.
