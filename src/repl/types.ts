// ── REPL Sandbox Types ──

import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { EventBus } from '../event-bus.js';

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
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
  config: REPLConfig;
}

export interface ThinkEvidence {
  source: 'memory_search' | 'memory_get_by_id' | 'session_messages' | 'llm_query' | 'code';
  query?: string;         // search query or llm prompt (truncated)
  snippet: string;        // what was found (truncated to ~200 chars)
  resultCount?: number;   // how many results returned
  attempt?: number;       // retry/sub-query attempt index when applicable
  timestamp: number;
}

export interface ThinkStep {
  iteration: number;
  code: string;            // code the LLM wrote (truncated to 2000 chars)
  output: string;          // execution output (truncated to 1000 chars)
  error: string | null;
  evidenceCollected: ThinkEvidence[];
  tokensUsed: number;      // this iteration's token count (input + output)
}

export interface ThinkResult {
  answer: string;
  iterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  truncated: boolean;
  budgetStatus: BudgetStatus;
  steps: ThinkStep[];
  evidence: ThinkEvidence[];
}
