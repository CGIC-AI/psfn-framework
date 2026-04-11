// ── REPL Sandbox Types ──

import type { LLMProviderPort, EmbeddingProviderPort, LLMRequestMetadata } from '../../agent/contracts.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { SessionManager } from '../../session/manager.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import type { CapabilityTier, CompositionalPolicyConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type { SandboxExecutionPort } from '../../../boundary/sandbox/capabilities/contracts.js';

export interface ThinkBudget {
  maxIterations: number;      // default 15
  maxTokens?: number;         // total input+output tokens, default 100_000
  maxWallTimeMs?: number;     // total elapsed before tier clamp, default 120_000 (2 min)
  maxSubQueries?: number;     // llm_query calls, default 20
  maxToolCalls?: number;      // sandbox tool calls (file/web helpers), default 50
}

export interface TierThinkBudget {
  maxIterations: number;
  maxWallTimeMs: number;
  maxSubQueries: number;
  maxToolCalls: number;
  memoryCeilingMb: number;
}

export interface ThinkRateLimitConfig {
  maxInvocationsPerMinute: number;
  windowMs: number;
}

export interface ThinkCostConfig {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  nurseryDailyCapUsd: number;
  autonomousDailyWarningUsd: number;
}

export interface BudgetStatus {
  iterations: number;
  totalTokens: number;
  wallTimeMs: number;
  subQueries: number;
  toolCalls: number;
  sessionCostUsd: number;
  dayCostUsd: number;
  warnings: string[];
  exceeded: string | null;    // null = ok, string = reason for stop
}

export interface REPLConfig {
  budget: ThinkBudget;
  tierBudgets: Record<'nursery' | 'apprentice' | 'autonomous', TierThinkBudget>;
  rateLimit: ThinkRateLimitConfig;
  cost: ThinkCostConfig;
  outputTruncation: number;
  executionTimeoutMs: number;
}

export interface REPLMutationPolicy {
  allowRepoMutation?: boolean;
  allowWorkspaceWrite?: boolean;
}

export interface NestedThinkOptions {
  maxIterations?: number;
  maxTokens?: number;
  maxWallTimeMs?: number;
}

export type NestedThinkRunner = (
  task: string,
  options?: NestedThinkOptions,
) => Promise<string>;

export const DEFAULT_REPL_TIER_BUDGETS: REPLConfig['tierBudgets'] = {
  nursery: {
    maxIterations: 5,
    maxWallTimeMs: 30_000,
    maxSubQueries: 10,
    maxToolCalls: 25,
    memoryCeilingMb: 128,
  },
  apprentice: {
    maxIterations: 10,
    maxWallTimeMs: 60_000,
    maxSubQueries: 15,
    maxToolCalls: 40,
    memoryCeilingMb: 192,
  },
  autonomous: {
    maxIterations: 15,
    maxWallTimeMs: 120_000,
    maxSubQueries: 20,
    maxToolCalls: 50,
    memoryCeilingMb: 256,
  },
};

export const DEFAULT_REPL_CONFIG: REPLConfig = {
  budget: {
    maxIterations: 15,
    maxTokens: 100_000,
    maxWallTimeMs: 120_000,
    maxSubQueries: 20,
    maxToolCalls: 50,
  },
  tierBudgets: DEFAULT_REPL_TIER_BUDGETS,
  rateLimit: {
    maxInvocationsPerMinute: 5,
    windowMs: 60_000,
  },
  cost: {
    inputUsdPerMillionTokens: 2.0,
    outputUsdPerMillionTokens: 8.0,
    nurseryDailyCapUsd: 0.5,
    autonomousDailyWarningUsd: 5.0,
  },
  outputTruncation: 8192,
  executionTimeoutMs: 5000,
};

export interface REPLDeps {
  llmProvider: LLMProviderPort;
  executionPort?: SandboxExecutionPort | null;
  embeddingService: EmbeddingProviderPort | null;
  memoryStore: MemoryStorePort | null;
  sessionManager: SessionManager | null;
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
  costTelemetry?: CostTelemetryPort | null;
  getCapabilityTier?: () => CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
  moduleInstallConfirmationQueue?: ApprovalQueuePort | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  requestMetadata?: Partial<LLMRequestMetadata>;
  config: REPLConfig;
  mutationPolicy?: REPLMutationPolicy;
}

export interface ThinkEvidence {
  source:
    | 'memory_search'
    | 'memory_get_by_id'
    | 'session_messages'
    | 'session_search'
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

export interface ThinkDiagnostics {
  nestedThinkCallCount: number;
  nestedThinkSuccessCount: number;
  nestedThinkFailureCount: number;
  maxNestedDepthReached: number;
}

export function createEmptyThinkDiagnostics(): ThinkDiagnostics {
  return {
    nestedThinkCallCount: 0,
    nestedThinkSuccessCount: 0,
    nestedThinkFailureCount: 0,
    maxNestedDepthReached: 0,
  };
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
  diagnostics: ThinkDiagnostics;
}
