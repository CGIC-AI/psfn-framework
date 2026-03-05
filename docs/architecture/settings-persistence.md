# Settings Persistence Ownership

## Goal

PSFN runtime/admin configuration now uses one authoritative file per domain.
This removes cross-file drift and restart-time overrides caused by duplicated writes.

## Domain Ownership

| Domain | Authoritative File | Runtime Load Source | Allowed Writers |
| --- | --- | --- | --- |
| Runtime/general settings | `data/settings.json` | `loadSettings()` + runtime-owned keys only | `saveSettings()` via admin settings mutation/runtime hooks |
| Models + role assignments | `data/models.json` | `loadModelsConfigWithLegacyMigration()` | `saveModelsConfig()` via shared admin model mutation helpers |
| Scheduler cadence | `data/scheduler.json` | `resolveRuntimeSchedulerConfig()` | `saveSchedulerConfig()` via scheduler endpoints/domain migrations |
| Capability tier | `data/capability-tier.json` | `CapabilityRuntime` / `loadCapabilityTierConfig()` | `saveCapabilityTierConfig()` via shared capability mutation helpers |
| Trust policy | `data/trust-policy.json` | `loadTrustPolicyConfig()` | `saveTrustPolicyConfig()` |
| Skills | `data/skills.json` | `loadSkillsConfig()` | `saveSkillsConfig()` |

## Runtime Contract

1. Load `settings.json` and split into domains.
2. Apply only runtime-owned keys from `settings.json`.
3. Load model domain from `models.json` (with legacy migration guardrails).
4. Load scheduler/trust/capability domains from their own files.
5. Rewrite `settings.json` without legacy cross-domain keys when detected.

## Migration + Drift Detection

During migration window, startup handles legacy mixed state:

- If `models.json` is missing and legacy model keys exist in `settings.json`, models are migrated into `models.json`.
- If `scheduler.json` is missing and legacy `maintenanceIntervalMs` exists in `settings.json`, value is migrated.
- If `capability-tier.json` is missing and legacy `capabilityTier` exists in `settings.json`, value is migrated.
- If legacy values conflict with existing domain files, startup logs drift and keeps the domain file authoritative.

## Admin Mutation Path

- Form and JSON settings endpoints route through shared mutation helpers.
- Model writes and capability writes use shared domain primitives used by both generic settings updates and dedicated domain endpoints.
- `settings.json` persistence strips non-runtime domain keys (`model*`, `maintenanceIntervalMs`, `capabilityTier`) to prevent reintroduction of drift.

## Operational Result

- Restart no longer replays stale model/capability/scheduler values from `settings.json`.
- Each domain round-trips through one file and one writer primitive family.
- Drift is surfaced via logs while legacy state is being retired.
