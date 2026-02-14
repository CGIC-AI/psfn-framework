// ── REPL Sandbox Types ──

import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';

export interface ThinkBudget {
  maxIterations: number;      // default 15
  maxTokens?: number;         // total input+output tokens, default 100_000
  maxWallTimeMs?: number;     // total elapsed, default 120_000 (2 min)
  maxSubQueries?: number;     // llm_query calls, default 20
}

export interface BudgetStatus {
  iterations: number;
  totalTokens: number;
  wallTimeMs: number;
  subQueries: number;
  exceeded: string | null;    // null = ok, string = reason for stop
}

export interface REPLConfig {
  budget: ThinkBudget;
  outputTruncation: number;
  executionTimeoutMs: number;
}

export const DEFAULT_REPL_CONFIG: REPLConfig = {
  budget: {
    maxIterations: 15,
    maxTokens: 100_000,
    maxWallTimeMs: 120_000,
    maxSubQueries: 20,
  },
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
  budgetStatus: BudgetStatus;
}
