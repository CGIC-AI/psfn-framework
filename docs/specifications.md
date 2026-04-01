# Specifications

This document is the compact contract for how the live runtime is supposed to behave. When this file disagrees with code, prefer the code in the order listed below.

## Source Of Truth Order

1. Runtime entrypoints and composition
   - `src/index.ts`
   - `src/runtime.ts`
   - `src/gateway-main.ts`
   - `src/agent-main.ts`
   - `src/bootstrap/composition.ts`
   - `src/bootstrap/parity.ts`
2. Config and persistence contracts
   - `src/types.ts`
   - `src/settings.ts`
   - `src/config/settings-contract.ts`
   - `src/persistence/layout.ts`
3. Bootstrap example only
   - `.env.example`

## Runtime Contract

- The canonical operational mode is split gateway + agent.
- `src/index.ts` does not start a usable monolith; it exits fail-closed.
- `src/runtime.ts` remains the single-process parity implementation for tests, tooling, and compatibility wiring.
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
- active orientation (`core_memory.json`) and north-star state
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

## Tool Surface Contract

The current target taxonomy and migration map live in [`docs/tool-surface.md`](./tool-surface.md).

Current guidance:

- `promotedExtendedTools` is a short-term exposure mechanism, not the long-term taxonomy.
- `toolset` is the model-facing control surface for listing, activating, pinning, and unpinning non-default tools.
- `orient` is the model-facing active-orientation surface; storage may remain on legacy `core_memory` paths when persistence does not need to change.
- `scratchpad` stays explicit as the ephemeral long-context workspace, separate from `orient` and durable `memory`.
- Scratchpad promotion is selective: stable facts move to `memory`, durable notes move to repo docs or `vault`, and active canon belongs in `orient`.
- `north_star` stays its own semantic tool surface, separate from `orient` and `identity`.
- `north_star` is a unified action-based extended tool, not a core primitive or a transient session-state surface.
- `identity` is the live unified surface for prompt-layer reads/mutations and persona mutation via explicit `action` semantics; write actions remain capability-gated and safeguard-audited.
- `schedule` is the live unified surface for durable reminders, proactive follow-ups, reflection templates, and timed prompt work; legacy scheduler micro-tool semantics remain available as `action` aliases inside that tool during migration.
- `notify` is the live unified surface for operator briefing, lightweight outbound delivery, and approval escalation. `brief` replaces legacy `notify_operator`, `send` requires explicit delivery targets, and `approval_request` keeps review details explicit and fail-closed.

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
