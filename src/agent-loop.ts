// ── Agent Loop (re-export shim) ──
// The actual implementation lives in src/agent/substrate-agent.ts.
// This file re-exports everything to preserve import paths for
// all existing consumers (runtime.ts, api/server.ts, memory/, etc.).
// New code should import from canonical modules under `src/agent/*`.

export { SubstrateAgent } from './agent/substrate-agent.js';
export type {
  LLMProvider,
  EmbeddingService,
  MemoryProvider,
  MemoryExtractor,
} from './agent/contracts.js';

/**
 * @deprecated Prefer importing `SubstrateAgent` from `src/agent/substrate-agent.ts`.
 * This alias exists only for compatibility while older call sites migrate.
 */
export { SubstrateAgent as AgentLoop } from './agent/substrate-agent.js';
