// ── pi-agent-core Version-Coupling Boundary ──
//
// This directory is the ONLY place in the repo allowed to import from
// `@mariozechner/pi-agent-core` directly (enforced by the
// `no-restricted-imports` rule in eslint.config.js). Every other module
// imports the symbols it needs from this index, so a pi-agent-core version
// bump is contained to `src/boundary/pi-agent/` instead of rippling across
// the whole tree.
//
// On a version bump, audit:
//   1. The re-exported surface below — every symbol must still exist with a
//      compatible shape (`npm run build` catches removals/renames; review the
//      upstream changelog for semantic changes that typecheck anyway).
//   2. `./agent-loop-patch.ts` — the scheduled-loop graft overrides PRIVATE
//      Agent internals and can silently no-op or corrupt state if those
//      internals are restructured. See the re-audit note at the top of that
//      file.
//   3. `./substrate-agent-tool.ts` — the repo-owned tool contract mirrors
//      `AgentTool`'s execute signature; confirm mutual assignability with
//      `AgentTool<any>` still holds.
//   4. The module augmentation in `src/core/agent/messages.ts`
//      (`declare module '@mariozechner/pi-agent-core'` extending
//      `CustomAgentMessages`). Augmentations must target the real package
//      name, so that block is a sanctioned coupling site — it is not an
//      import and the lint rule does not apply to it — but it breaks if
//      upstream renames/removes the `CustomAgentMessages` hook.
//
// Consumed surface (types unless noted):
//   Agent (runtime class), AgentContext, AgentEvent, AgentLoopConfig,
//   AgentMessage, AgentTool, AgentToolResult, AgentToolUpdateCallback,
//   StreamFn.
// If new code needs an additional pi-agent-core symbol, re-export it here —
// do not import the package directly elsewhere.

export { Agent } from '@mariozechner/pi-agent-core';
export type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  StreamFn,
} from '@mariozechner/pi-agent-core';

// Repo-owned tool contract (validated-params variant of AgentTool).
export type { SubstrateAgentTool } from './substrate-agent-tool.js';
