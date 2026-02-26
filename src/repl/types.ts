// ── REPL Sandbox Types ──

import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from '../memory/store.js';
import type { SessionManager } from '../session/manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { EventBus } from '../event-bus.js';
import type { CapabilityTier } from '../types.js';
import type { ConfirmationQueue } from '../capabilities/confirmation-queue.js';
import type { ModuleRegistryMutation } from '../modules/types.js';

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
  getCapabilityTier?: () => CapabilityTier;
  moduleInstallConfirmationQueue?: ConfirmationQueue | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  config: REPLConfig;
}

export interface ThinkEvidence {
  source:
    | 'memory_search'
    | 'memory_get_by_id'
    | 'session_messages'
    | 'llm_query'
    | 'web_fetch'
    | 'repo'
    | 'module'
    | 'code';
  query?: string;         // search query or llm prompt (truncated)
  snippet: string;        // what was found (truncated to ~200 chars)
  resultCount?: number;   // how many results returned
  attempt?: number;       // retry/sub-query attempt index when applicable
  timestamp: number;
}

export interface ThinkStep {
  iteration: number;
  timestamp: number;       // iteration completion timestamp
  code: string;            // code the LLM wrote
  output: string;          // execution output
  error: string | null;
  evidenceCollected: ThinkEvidence[];
  inputTokens: number;     // prompt/context tokens for this iteration
  outputTokens: number;    // model output tokens for this iteration
  tokensUsed: number;      // deprecated alias: input + output
  cumulativeTokens: number; // running total after this iteration
  durationMs: number;      // wall time for this iteration (llm + execution)
  variablesChanged: string[];
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
