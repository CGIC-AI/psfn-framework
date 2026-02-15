// ── Agent Loop (re-export shim) ──
// The actual implementation lives in src/agent/substrate-agent.ts.
// This file re-exports everything to preserve import paths for
// all existing consumers (runtime.ts, api/server.ts, memory/, etc.).

export { SubstrateAgent } from './agent/substrate-agent.js';
export type {
  LLMProvider,
  EmbeddingService,
  MemoryProvider,
  MemoryExtractor,
} from './agent/substrate-agent.js';

// Legacy alias — consumers can import either name.
// Once all call sites are migrated, this alias can be removed.
export { SubstrateAgent as AgentLoop } from './agent/substrate-agent.js';
