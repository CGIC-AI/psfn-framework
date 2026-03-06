# Phase V PI Package Upgrade Notes

Date: 2026-03-05  
Bead: `PSFN-17lw.4`

## Scope

Upgraded direct PI dependencies:

- `@mariozechner/pi-agent-core`: `^0.52.12` -> `^0.56.2`
- `@mariozechner/pi-ai`: `^0.52.12` -> `^0.56.2`
- `@mariozechner/pi-web-ui`: `^0.52.12` -> `^0.56.2`

`package-lock.json` was regenerated via `npm install`.

## Integration Compatibility Findings

Audited integration seams:

- `src/agent/stream-adapter.ts`
- `src/agent/tool-registrar.ts`
- `src/channels/discord/adapter.ts`
- `src/channels/telegram/adapter.ts`

Observed result:

- No compile-time signature breaks in `streamSimple`, `getEnvApiKey`, `Model`, `StreamFn`, or `AgentTool` usage.
- No runtime-contract regressions detected in targeted seam tests (streaming, tool wiring, session/turn flow, Discord adapter, Telegram adapter).
- No code edits were required in seam files to remain compatible with `0.56.2`.

## Fail-Closed / Regression Posture

- Existing fail-closed behavior remains intact:
  - no permissive fallback paths were added;
  - no auth/trust bypass logic was introduced;
  - error paths remain explicit and test-covered in channel adapters.
- Tool streaming/session/channel adapter behavior remains covered by targeted regressions listed below.

## Validation

Executed:

- `npx vitest run src/agent/stream-adapter.test.ts src/agent/tool-wiring-validator.test.ts src/agent/substrate-agent.test.ts src/channels/discord/adapter.test.ts src/channels/telegram/adapter.test.ts`
  - Result: `5` files passed, `164` tests passed.
- `npm run build`
  - Result: success (ESM + DTS build).

## Notes

- `npm diff` between `0.52.12` and `0.56.2` shows most upstream surface churn in `@mariozechner/pi-ai` provider/model internals; `@mariozechner/pi-agent-core` appeared package-level compatible for this project’s consumed API.
