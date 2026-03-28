# Specifications

This document is the compact contract for how the live runtime is supposed to behave. When this file disagrees with code, prefer the code in the order listed below.

## Source Of Truth Order

1. Runtime entrypoints and composition
   - `src/app/startup/index.ts`
   - `src/app/gateway/main.ts`
   - `src/app/agent/main.ts`
   - `src/app/startup/composition/composition.ts`
   - `src/app/startup/composition/parity.ts`
2. Config and persistence contracts
   - `src/types.ts`
   - `src/settings.ts`
   - `src/config/settings-contract.ts`
   - `src/persistence/layout.ts`
3. Bootstrap example only
   - `.env.example`

## Runtime Contract

- The canonical operational mode is split gateway + agent.
- `src/app/startup/index.ts` is disabled and exits fail-closed.
- `npm run split` and `npm run yolo` are the intended launchers for day-to-day runtime use.

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

## Artifact Ownership

### System-owned

- JSON owner files listed above
- capability and runtime policy state
- channel configuration

### Companion-owned

- character card
- companion SQLite database
- sessions
- notes, reflections, scratchpad mirror, values journal
- prompt layers and prompt registry
- core memory and north-star state
- images and identity assets
- safeguard audit trail and post-turn queue

Path helpers for these artifacts live in `src/persistence/layout.ts`.

## Startup Hydration Guarantees

Both gateway and agent startup run canonical hydration through `hydrateCanonicalStartupConfig`, which:

- resolves runtime path layout
- loads settings and splits them by owner domain
- loads model and provider registries with legacy migration support
- loads trust-policy and scheduler config
- warns on legacy drift instead of silently re-authorizing `.env`

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
