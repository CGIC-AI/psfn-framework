# Specifications

This document is the compact contract for how the live runtime is supposed to behave. When this file disagrees with code, prefer the code in the order listed below.

Last updated: 2026-07-14.

## Source Of Truth Order

1. Runtime entrypoints and composition
   - `src/app/startup/index.ts`
   - `src/app/gateway/main.ts`
   - `src/app/agent/main.ts`
   - `src/app/startup/composition/composition.ts`
   - `src/app/startup/composition/parity.ts`
2. Config and persistence contracts
   - `src/shared/contracts/runtime.ts`
   - `src/system/settings.ts`
   - `src/system/settings/contracts.ts`
   - `src/persistence/layout.ts`
3. Bootstrap example only
   - `.env.example`

## Runtime Contract

- The canonical operational mode is split gateway + agent.
- `src/app/startup/index.ts` is disabled and exits fail-closed.
- `npm run split` and `npm run yolo` are the intended launchers for day-to-day runtime use.

## Live Alpha Migration Boundary

Until beta, the live runtime may keep only the migration support listed here. New compatibility or fallback behavior in config, startup, persistence, or model-facing tool names must fail closed unless this section is updated with the supported scope, validation path, and beta-removal condition.

Supported until beta:

- Continuous/local shared-root layout through `DATA_DIR`. This is for local development and smoke testing only; production mode forbids shared-root operation.
- Split-root persistence cutover through `npm run migrate:persistence-layout` and the installer `--migrate-data` path. The cutover tooling may read legacy shared roots, write manifests, and run existing intra-root cleanup, but production startup should stop until the plan is clean.
- Startup owner-file hydration for currently supported legacy owner data. Hydration may seed missing owner files on first boot, migrate or warn on existing owner-file drift, and load model/provider registries with the existing migration paths, but it must not restore `.env` as mutable-settings authority.
- Existing companion persistence migrations for legacy continuity files, session channel filenames, SQLite database placement, contact `discord_user_id` identity rows, and the `core_memory.json` orientation filename. These paths are read/migration support only, not permission to add new parallel artifact names.
- Tool-surface migration aliases documented in `docs/tool-surface.md`. They preserve model-facing continuity while unified tools roll out, and should be removed after canonical actions have stable adoption.

Out of boundary:

- alternate config owner paths not listed in the owner-file contract
- silent fallback from JSON owner files to `.env`
- production fallback to `DATA_DIR` or to overlapping mutable roots
- direct-provider bypass around the gateway/proxy security boundary
- persistence backend fallbacks that change truth, such as app-side vector scans replacing required `pgvector`
- new seed-loading behavior introduced as a compatibility workaround

## Configuration Ownership

### `.env` owns only

- secrets
- host/port/socket wiring
- runtime mode/layout wiring
- explicit bootstrap overrides

### JSON owner files own mutable runtime state

- `settings.json`
- `models.json`
- `providers.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`
- `charge-policy.json`
- `backup.json`

Legacy env values for JSON-owned settings are ignored, and startup hydration migrates or warns on drift where compatibility shims still exist.

## Persistence Layout Contract

### Continuous mode

- Default when `PSFN_RUNTIME_LAYOUT_MODE` is unset and `NODE_ENV` is not `production`
- Shared-root compatibility through `DATA_DIR`
- Defaults to `./data`

### Production mode

- Activated by `PSFN_RUNTIME_LAYOUT_MODE=production` or `NODE_ENV=production`
- Uses isolated mutable roots
- Defaults to:
  - `./runtime/production/system-data`
  - `./runtime/production/companion-data`
  - `./runtime/production/workspace`
  - `./runtime/production/logs`
  - `./runtime/production/tmp`
  - `./runtime/production/backups`

### Fail-closed rules

- `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR` must be set together or not at all
- production mode forbids `DATA_DIR` shared-root operation
- production mutable roots must not overlap
- companion and system roots must be different paths

### Workspace scopes

`WORKSPACE_PATH` means one companion's **Personal Workspace**: writable
documents, journal, personal knowledge base, authored skills, modules,
experiments, downloads, images, and other personal durable files. It is not a
runtime-state root and not a general shared-files root.

The target multi-companion layout has one validated Personal Workspace per
companion plus an installation-owned **Shared Companion Workspace** for
explicitly published collaboration artifacts and common reference material. The
shared-world wiki remains a narrower, site-scoped operator-owned knowledge
surface—not a general shared filesystem.

Current fleet wiring has no per-entry workspace path and forwards one inherited
`WORKSPACE_PATH` to all fleet agents. This means personal workspace isolation is
not shipped under multi-companion yet. Do not add a `SHARED_WORKSPACE_PATH` env
setting, derive paths ad hoc, or claim workspace tenancy until the owner-file,
path-containment, gateway-policy, backup, and tests contracts land together.

When implemented, personal and shared workspace roots must be canonicalized,
non-overlapping with each other and with system/companion/runtime roots, and
contained beneath the configured runtime root. Shared writes require explicit
actor and provenance records, review policy, atomic writes, containment checks,
and CogSec screening before shared material can reach prompts, wikis, or memory.

## Artifact Ownership

### System-owned

- JSON owner files listed above
- capability and runtime policy state
- channel configuration

### Companion-owned

- character card
- PostgreSQL-backed companion runtime state
- append-only session JSONL archives
- notes, reflections, scratchpad mirror, values evolution ledger
- prompt layers and prompt registry
- core memory and north-star state
- images and identity assets
- safeguard audit trail and post-turn queue

### Personal-workspace-owned

- one companion's authored documents, personal journal, personal knowledge base,
  managed skills, modules, experiments, downloads, and saved artifacts
- these files are companion-private by default and are not runtime state

### Shared-workspace-owned (target contract)

- installation-owned collaboration artifacts and common reference material
- a Companion Library / Seed Bundle of approved documentation, templates, and
  default skills
- never personal memory, session archives, identity assets, credentials, or
  mutable runtime configuration

Path helpers for these artifacts live in `src/persistence/layout.ts`.

## Startup Hydration Guarantees

Both gateway and agent startup run canonical hydration through `hydrateCanonicalStartupConfig`, which:

- resolves runtime path layout
- loads settings and splits them by owner domain
- loads model and provider registries with legacy migration support
- loads trust-policy, scheduler, capability, charge-policy, backup, skills, and channel config
- warns on legacy drift instead of silently re-authorizing `.env`

## Same-Cluster Inter-Companion Autonomy

- Autonomous initiation is same-cluster only, disabled by default, and started
  only when `scheduler.json > icpAutonomy.enabled` is true. Its strict owner
  block also owns candidate TTL/retry, permit TTL, and operator availability
  lease TTL. There is no env shadow or compatibility reader.
- `charge-policy.json` owns companion-social quota and continuation cost,
  fatigue/social/overcharge reserve, structured continuation-evidence switches,
  and the ICP conversation cost breaker. Existing `trust-policy.json`,
  `channels.json`, capability tier, contact block/trust, and gateway policy
  remain independent mandatory gates.
- Candidate motivation and peer-contact binding stay companion-local. Shared
  arbitration stores only content-free availability, episode, provenance, and
  permit control state. Permits are short-lived, single-use, candidate-bound,
  recovery-safe, and invalidated when operator DND or emergency disable fences a
  participant.
- Peer-visible content is authored by the target ordinary channel turn. The
  source handoff never accepts message content, and ICP-correlated turns cannot
  recursively initiate another channel.
- Garden `/autonomy` exposes only bounded/redacted local-participant
  control-plane state and effective/on-disk/restart owner semantics. Unrelated
  peer↔peer lifecycle, provenance, reason, fatigue, cost, and derived counts are
  excluded. Audited local controls are
  revision-checked candidate cancellation, operator DND, and one-way live
  emergency disable plus persisted owner disable.
- Not shipped: cross-cluster communication, fleet-wide/cross-companion control,
  message puppeteering, private transcript/reasoning inspection, and any Garden
  exposure of chain-of-thought.

## Security And Fail-Closed Posture

- Gateway owns external egress and secrets.
- Agent startup probes outbound reachability and aborts unless the operator explicitly overrides isolation.
- URL fetches, filesystem access, and sensitive tool actions are policy-gated.
- Capability eligibility and confirmation queues gate privileged actions.
- Trust-aware memory retrieval withholds data by default when policy does not allow disclosure.
- Unknown or malformed provider/settings data should reject rather than silently coerce.

## Validation Baseline

Use the smallest relevant set, but these are the common contract checks:

```bash
npm run lint
npm run build
npm run verify:settings-contract
npm run verify:repository-hygiene
npm run verify:backup-restore
```

For runtime-specific surfaces, add the matching smoke or e2e command.
