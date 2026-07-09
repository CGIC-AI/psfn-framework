# Codex Audit: Sprint 10 Prep

Date: 2026-07-09

Audited source: `origin/main` at `bbef11c5287d910c278292df341120a815f53b2c`

Audit worktree: `/home/ada/ai/dev/worktrees/psfn-framework/audit-s10-main`

Tracking bead: `psfn-framework-9kj9`

## Executive Summary

No critical issue was confirmed in the audited slice. The highest-risk Sprint 10 work is concentrated around the runtime security boundary: shell execution for the Obsidian vault bridge, Home Assistant gateway policy semantics, and configuration ownership for network/tool-routing settings.

Follow-up beads filed from this audit:

- `psfn-framework-lget`: Harden Obsidian vault CLI execution path.
- `psfn-framework-2izg`: Make Home Assistant gateway policy deny unconfigured methods.
- `psfn-framework-w3pj`: Move high-risk network and tool-routing settings out of mutable settings.json.
- `psfn-framework-vj0w`: Surface startup memory hydration failures as degraded runtime state.
- `psfn-framework-c5wf`: Update dev toolchain dependencies flagged by npm audit.

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

## Areas Checked

- Runtime entrypoints and boot wiring: `src/app/gateway/main.ts`, `src/app/agent/main.ts`, startup helpers.
- Configuration ownership and persistence layout: `src/system/settings/*`, `src/system/config/*`, `src/persistence/layout.ts`, `src/persistence/runtime-factory.ts`.
- Gateway policy and privileged tool paths: gateway approval boundary, Home Assistant methods, vault methods, shell-backed integrations, Garden/API auth startup policy.
- Persistence query shape: sampled Postgres stores and dynamic SQL sites. The model usage dynamic `ORDER BY`/`LIMIT` path uses fixed expressions and normalized limits, so it was not raised as a finding.
- Supply-chain pinning surface: Kubernetes images are pinned by tag and digest where external images are used; the satellite hub build script rejects floating image tags. npm production audit is clean; dev tooling has tracked advisories.

## Sprint 10 Priority

1. Fix `psfn-framework-lget` first. It is the clearest command execution boundary issue.
2. Fix `psfn-framework-2izg` with policy tests before expanding Home Assistant/world-control work.
3. Start `psfn-framework-w3pj` early if Sprint 10 adds locations, places, or channel routing settings. Otherwise new UI work will likely deepen the settings ownership debt.
4. Schedule `psfn-framework-vj0w` before memory/continuity changes are treated as production-ready.
5. Use `psfn-framework-c5wf` to clear dev-tool audit noise before Sprint 10 release prep.

## Validation Notes

This was a static codebase audit. No production code was changed.

Commands run on the audit worktree:

- `npm ci`: passed, then reported npm audit advisories in the installed dependency tree.
- `npm audit --json`: reported 1 critical, 3 high, 1 moderate, and 1 low dev-tooling vulnerabilities.
- `npm audit --omit=dev --json`: passed with zero production dependency vulnerabilities.
- `npm run lint`: passed.
