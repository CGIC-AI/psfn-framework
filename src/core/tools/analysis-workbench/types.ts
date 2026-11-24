// ── REPL Sandbox Types ──

import type { LLMProviderPort, LLMRequestMetadata } from '../../agent/contracts.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { HybridEpisodeSearchPort } from '../../../faculties/memory/retrieval/episode-search.js';
import type { SessionManager } from '../../session/manager.js';
import type { Scheduler } from '../../scheduler/scheduler.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import type { CapabilityTier, CompositionalPolicyConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import type { ApprovalQueuePort } from '../../../system/capabilities/approval-queue-port.js';
import type { ModuleRegistryMutation } from '../../../system/modules/types.js';
import type {
  REPLConfig,
  SandboxExecutionPort,
  SandboxExecutionPortSeed,
  SandboxFileRead,
} from '../../../shared/contracts/sandbox-analysis-contracts.js';

export {
  DEFAULT_REPL_CONFIG,
  DEFAULT_REPL_TIER_BUDGETS,
  validateAnalysisWorkbenchDirectResponseTimeoutMs,
} from '../../../shared/contracts/sandbox-analysis-contracts.js';
export type {
  AnalysisWorkbenchBudget,
  AnalysisWorkbenchCostConfig,
  AnalysisWorkbenchRateLimitConfig,
  NestedAnalysisOptions,
  NestedAnalysisRunner,
  REPLConfig,
  TierAnalysisWorkbenchBudget,
} from '../../../shared/contracts/sandbox-analysis-contracts.js';

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

export interface REPLMutationPolicy {
  allowRepoMutation?: boolean;
  allowWorkspaceWrite?: boolean;
}

export interface REPLDeps {
  llmProvider: LLMProviderPort;
  fileRead?: SandboxFileRead;
  fsReadMaxBytes?: number;
  executionPort?: SandboxExecutionPort | SandboxExecutionPortSeed | null;
  embeddingService: EmbeddingProviderPort | null;
  memoryStore: MemoryStorePort | null;
  episodeSearch?: HybridEpisodeSearchPort | null;
  sessionManager: SessionManager | null;
  scheduler?: Scheduler | null;
  eventBus?: EventBus | null;
  costTelemetry?: CostTelemetryPort | null;
  getCapabilityTier?: () => CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
  chargePolicy?: ChargePolicyConfig;
  moduleInstallConfirmationQueue?: ApprovalQueuePort | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
  requestMetadata?: Partial<LLMRequestMetadata>;
  config: REPLConfig;
  mutationPolicy?: REPLMutationPolicy;
}

export interface AnalysisWorkbenchEvidence {
  source:
    | 'memory_search'
    | 'episode_search'
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

export interface AnalysisWorkbenchStep {
  iteration: number;
  timestamp: number;       // iteration completion timestamp
  code: string;            // code the LLM wrote
  output: string;          // execution output
  error: string | null;
  evidenceCollected: AnalysisWorkbenchEvidence[];
  inputTokens: number;     // prompt/context tokens for this iteration
  outputTokens: number;    // model output tokens for this iteration
  tokensUsed: number;      // deprecated alias: input + output
  cumulativeTokens: number; // running total after this iteration
  durationMs: number;      // wall time for this iteration (llm + execution)
  variablesChanged: string[];
}

export interface AnalysisWorkbenchDiagnostics {
  nestedAnalysisCallCount: number;
  nestedAnalysisSuccessCount: number;
  nestedAnalysisFailureCount: number;
  maxNestedAnalysisDepthReached: number;
}

export interface AnalysisWorkbenchLimitPolicy {
  maxIterations: number;
  maxTokens: number | null;
  maxWallTimeMs: number | null;
  maxSubQueries: number | null;
  maxToolCalls: number | null;
}

type AnalysisWorkbenchOutcome = 'completed' | 'limit_reached';
type AnalysisWorkbenchContinuation = 'not_needed' | 'restart_required';

export function createEmptyAnalysisWorkbenchDiagnostics(): AnalysisWorkbenchDiagnostics {
  return {
    nestedAnalysisCallCount: 0,
    nestedAnalysisSuccessCount: 0,
    nestedAnalysisFailureCount: 0,
    maxNestedAnalysisDepthReached: 0,
  };
}

export interface AnalysisWorkbenchResult {
  answer: string;
  outcome: AnalysisWorkbenchOutcome;
  continuation: AnalysisWorkbenchContinuation;
  limitPolicy: AnalysisWorkbenchLimitPolicy;
  iterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  truncated: boolean;
  budgetStatus: BudgetStatus;
  steps: AnalysisWorkbenchStep[];
  evidence: AnalysisWorkbenchEvidence[];
  diagnostics: AnalysisWorkbenchDiagnostics;
}
