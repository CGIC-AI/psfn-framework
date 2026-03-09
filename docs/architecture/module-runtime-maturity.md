# Module System And Runtime Maturity

- Status: Implemented with guarded rollout
- Date: 2026-03-07
- Scope: PSFN-oft0.12 parity update

## Why This Exists

Runtime and module-system behavior is intentionally different by entrypoint. This document is the operator and engineering parity map for those differences.

## Entrypoint Parity Matrix

| Entrypoint | Startup hydration parity | Module registry file handling | Module activation behavior |
| --- | --- | --- | --- |
| `src/runtime.ts` (single-process) | Yes (`hydrateCanonicalStartupConfig`) | Resolved from workspace policy defaults | Loads enabled modules at startup (`ModuleLoader.loadEnabledModules`) |
| `src/agent-main.ts` (split agent) | Yes (`hydrateCanonicalStartupConfig`) | Uses deterministic workspace-root registry path | Loads enabled modules at startup and applies install/update mutations |
| `src/gateway-main.ts` (split gateway) | Yes (`hydrateCanonicalStartupConfig`) | Always ensures registry file exists before runtime services start | Does not activate modules (gateway role is host/policy/router) |
| `src/chat-cli.ts` | Yes (`hydrateCanonicalStartupConfig`) | N/A | No module lifecycle hooks by design |

## Module System Maturity

Current maturity level is **operational** for runtime loading and mutation handling:

- Registry persistence: `src/modules/registry.ts`
- Runtime loader lifecycle (`validate -> init -> activate -> start`): `src/modules/loader.ts`
- Split-mode runtime wiring and post-load tool validation: `src/agent-main.ts`
- Single-process runtime wiring and post-load tool validation: `src/runtime.ts`
- Tier-aware install controls via REPL/module tools: `src/bootstrap/composition.ts`, `src/modules/loader.test.ts`

What is intentionally not claimed as complete:

- Arbitrary untrusted third-party module execution hardening beyond current policy and tier controls.
- Full ecosystem governance (signing, supply-chain attestation, curated trust catalogs).

## Parity Verification Commands

Run these when touching runtime/module wiring:

```bash
npm run test -- src/runtime/startup-entrypoints-parity.test.ts
npm run test -- src/bootstrap/composition.test.ts
npm run test -- src/modules/loader.test.ts
npm run test -- src/modules/registry.test.ts
```

Expected outcomes:

- All commands pass.
- No entrypoint drifts from startup hydration contract.
- Module install/load behavior remains deterministic in single and split runtime paths.
