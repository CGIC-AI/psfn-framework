// ── REPL Sandbox Types ──

import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';

export interface REPLConfig {
  maxIterations: number;
  outputTruncation: number;
  executionTimeoutMs: number;
}

export const DEFAULT_REPL_CONFIG: REPLConfig = {
  maxIterations: 15,
  outputTruncation: 8192,
  executionTimeoutMs: 5000,
};

export interface REPLDeps {
  llmProvider: LLMProvider;
  embeddingService: EmbeddingService | null;
  memoryStore: MemoryStore | null;
  sessionManager: SessionManager | null;
  config: REPLConfig;
}

export interface ThinkResult {
  answer: string;
  iterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  truncated: boolean;
}
