// ── RLM Iteration Loop ──
// Runs an ephemeral think cycle: LLM → code → output → repeat until FINAL.

import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import type { ContextMessage, CorrelationMetadata, LLMContext, LLMResponse } from '../../../shared/contracts/runtime.js';
import type { LLMRequestMetadata } from '../../agent/contracts.js';
import type {
  BudgetStatus,
  NestedThinkOptions,
  REPLDeps,
  REPLConfig,
  ThinkDiagnostics,
  ThinkBudget,
  ThinkResult,
  ThinkStep,
} from './types.js';
import { createEmptyThinkDiagnostics } from './types.js';
import { REPLSandbox } from './sandbox.js';
import type { SandboxBudgetRef } from './sandbox.js';
import { buildRLMSystemPrompt } from './prompt.js';
import type { ThinkContextMetadata } from './prompt.js';
import { parseResponse } from './parse.js';
import {
  buildStep,
  checkBudget,
  createBudgetStatus,
  flattenEvidence,
  formatExecutionFeedback,
  makeBudgetResult,
  updateBudgetProgress,
  updateBudgetRuntime,
} from './loop-helpers.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { evaluateCompositionalPolicyForChannelId } from '../../../system/capabilities/compositional-policy.js';

const LLM_TIMEOUT_BUFFER_MS = 25;
const LLM_TIMEOUT_REASON = 'llm timeout';
const LLM_TIMEOUT_ANSWER = '[Think loop timed out waiting for LLM response]';
const INVOCATION_RATE_LIMIT_REASON = 'invocation rate limit';
const NURSERY_DAILY_COST_REASON = 'daily cost cap';
const RATE_LIMIT_ANSWER = '[Think invocation rate limit exceeded; try again shortly]';
const NURSERY_DAILY_CAP_ANSWER = '[Think daily cost cap reached for nursery tier]';
const MAX_NESTED_THINK_DEPTH = 2;

interface DailyCostSnapshot {
  dayKey: string;
  totalUsd: number;
}

interface ReplGovernanceState {
  invocationTimestampsMs: number[];
  dailyCostByTier: Record<CapabilityTier, DailyCostSnapshot>;
}

interface SharedThinkExecutionState {
  readonly startTime: number;
  readonly rootBudget: ThinkBudget;
  readonly budgetRef: SandboxBudgetRef;
  totalInputTokens: number;
  totalOutputTokens: number;
  consumedIterations: number;
  sessionCostUsd: number;
  warnings: string[];
  autonomousCostWarningSent: boolean;
  nextNestedThinkId: number;
  diagnostics: ThinkDiagnostics;
}

interface ThinkRunOptions {
  depth?: number;
  sharedState?: SharedThinkExecutionState;
  skipInvocationRateLimit?: boolean;
}

const GOVERNANCE_DEFAULT_DAY = '1970-01-01';
const GOVERNANCE_DEFAULT_COST: DailyCostSnapshot = { dayKey: GOVERNANCE_DEFAULT_DAY, totalUsd: 0 };
const REPL_GOVERNANCE_BY_PROVIDER = new WeakMap<object, ReplGovernanceState>();

class LLMIterationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM iteration timed out after ${timeoutMs}ms`);
    this.name = 'LLMIterationTimeoutError';
  }
}

function getRemainingWallTimeMs(startTime: number, budget: ThinkBudget): number | null {
  if (!budget.maxWallTimeMs) return null;
  return budget.maxWallTimeMs - (Date.now() - startTime);
}

function pickMostConstrainedRemainingWallTimeMs(...values: Array<number | null>): number | null {
  const finiteValues = values.filter((value): value is number => value !== null);
  if (finiteValues.length === 0) {
    return null;
  }
  return Math.min(...finiteValues);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    throw new LLMIterationTimeoutError(timeoutMs);
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LLMIterationTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolveTierKey(tier: CapabilityTier): 'nursery' | 'apprentice' | 'autonomous' {
  if (tier === 'nursery' || tier === 'apprentice' || tier === 'autonomous') {
    return tier;
  }
  return 'autonomous';
}

function toDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function getOrCreateGovernanceState(provider: object): ReplGovernanceState {
  const existing = REPL_GOVERNANCE_BY_PROVIDER.get(provider);
  if (existing) return existing;
  const created: ReplGovernanceState = {
    invocationTimestampsMs: [],
    dailyCostByTier: {
      nursery: { ...GOVERNANCE_DEFAULT_COST },
      apprentice: { ...GOVERNANCE_DEFAULT_COST },
      autonomous: { ...GOVERNANCE_DEFAULT_COST },
      custom: { ...GOVERNANCE_DEFAULT_COST },
    },
  };
  REPL_GOVERNANCE_BY_PROVIDER.set(provider, created);
  return created;
}

function getDailyCostSnapshot(
  state: ReplGovernanceState,
  tier: CapabilityTier,
  dayKey: string,
): DailyCostSnapshot {
  const current = state.dailyCostByTier[tier];
  if (current.dayKey !== dayKey) {
    const reset = { dayKey, totalUsd: 0 };
    state.dailyCostByTier[tier] = reset;
    return reset;
  }
  return current;
}

function estimateIterationCostUsd(
  config: REPLConfig,
  inputTokens: number,
  outputTokens: number,
): number {
  const inputRate = Number.isFinite(config.cost.inputUsdPerMillionTokens)
    ? Math.max(0, config.cost.inputUsdPerMillionTokens)
    : 0;
  const outputRate = Number.isFinite(config.cost.outputUsdPerMillionTokens)
    ? Math.max(0, config.cost.outputUsdPerMillionTokens)
    : 0;

  return ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000;
}

function resolveEffectiveBudget(config: REPLConfig, tier: CapabilityTier): ThinkBudget {
  const tierKey = resolveTierKey(tier);
  const tierBudget = config.tierBudgets[tierKey];

  const baseIterations = Number.isFinite(config.budget.maxIterations)
    ? Math.max(1, Math.floor(config.budget.maxIterations))
    : tierBudget.maxIterations;

  const baseWallTime = typeof config.budget.maxWallTimeMs === 'number' && Number.isFinite(config.budget.maxWallTimeMs)
    ? Math.max(1, Math.floor(config.budget.maxWallTimeMs))
    : tierBudget.maxWallTimeMs;

  const baseSubQueries = typeof config.budget.maxSubQueries === 'number' && Number.isFinite(config.budget.maxSubQueries)
    ? Math.max(1, Math.floor(config.budget.maxSubQueries))
    : tierBudget.maxSubQueries;
  const baseToolCalls = typeof config.budget.maxToolCalls === 'number' && Number.isFinite(config.budget.maxToolCalls)
    ? Math.max(1, Math.floor(config.budget.maxToolCalls))
    : tierBudget.maxToolCalls;

  return {
    ...config.budget,
    maxIterations: Math.min(baseIterations, tierBudget.maxIterations),
    maxWallTimeMs: Math.min(baseWallTime, tierBudget.maxWallTimeMs),
    maxSubQueries: Math.min(baseSubQueries, tierBudget.maxSubQueries),
    maxToolCalls: Math.min(baseToolCalls, tierBudget.maxToolCalls),
  };
}

function resolveMemoryCeilingBytes(config: REPLConfig, tier: CapabilityTier): number | undefined {
  const tierLimitMb = config.tierBudgets[resolveTierKey(tier)].memoryCeilingMb;
  if (!Number.isFinite(tierLimitMb) || tierLimitMb <= 0) {
    return undefined;
  }
  return Math.floor(tierLimitMb * 1024 * 1024);
}

function createSharedThinkExecutionState(
  startTime: number,
  rootBudget: ThinkBudget,
  budgetRef: SandboxBudgetRef,
): SharedThinkExecutionState {
  return {
    startTime,
    rootBudget,
    budgetRef,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    consumedIterations: 0,
    sessionCostUsd: 0,
    warnings: [],
    autonomousCostWarningSent: false,
    nextNestedThinkId: 0,
    diagnostics: createEmptyThinkDiagnostics(),
  };
}

function syncBudgetStatusFromSharedState(
  budgetStatus: BudgetStatus,
  sharedState: SharedThinkExecutionState,
  dayCostUsd: number,
): void {
  budgetStatus.sessionCostUsd = sharedState.sessionCostUsd;
  budgetStatus.dayCostUsd = dayCostUsd;
  budgetStatus.warnings = sharedState.warnings;
}

function normalizePositiveBudgetOverride(
  value: number | undefined,
  field: keyof NestedThinkOptions,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`sub_think ${field} must be a positive number`);
  }
  return Math.floor(value);
}

function computeRemainingTokenBudget(sharedState: SharedThinkExecutionState): number | undefined {
  if (sharedState.rootBudget.maxTokens === undefined) {
    return undefined;
  }

  return sharedState.rootBudget.maxTokens
    - (sharedState.totalInputTokens + sharedState.totalOutputTokens);
}

function checkSharedBudgetExceeded(sharedState: SharedThinkExecutionState): BudgetStatus['exceeded'] {
  const totalTokens = sharedState.totalInputTokens + sharedState.totalOutputTokens;
  if (sharedState.consumedIterations >= sharedState.rootBudget.maxIterations) {
    return 'max iterations';
  }
  if (
    sharedState.rootBudget.maxTokens !== undefined
    && totalTokens >= sharedState.rootBudget.maxTokens
  ) {
    return 'token budget';
  }
  if (
    sharedState.rootBudget.maxWallTimeMs !== undefined
    && Date.now() - sharedState.startTime >= sharedState.rootBudget.maxWallTimeMs
  ) {
    return 'wall time';
  }
  if (
    sharedState.rootBudget.maxSubQueries !== undefined
    && sharedState.budgetRef.subQueries >= sharedState.rootBudget.maxSubQueries
  ) {
    return 'sub-query limit';
  }
  if (
    sharedState.rootBudget.maxToolCalls !== undefined
    && (sharedState.budgetRef.toolCalls ?? 0) >= sharedState.rootBudget.maxToolCalls
  ) {
    return 'tool-call limit';
  }
  return null;
}

function buildNestedThinkConfig(
  config: REPLConfig,
  sharedState: SharedThinkExecutionState,
  options: NestedThinkOptions | undefined,
): REPLConfig {
  const maxIterationsOverride = normalizePositiveBudgetOverride(options?.maxIterations, 'maxIterations');
  const maxTokensOverride = normalizePositiveBudgetOverride(options?.maxTokens, 'maxTokens');
  const maxWallTimeOverride = normalizePositiveBudgetOverride(options?.maxWallTimeMs, 'maxWallTimeMs');

  const remainingIterations = sharedState.rootBudget.maxIterations - sharedState.consumedIterations;
  if (remainingIterations <= 0) {
    throw new Error('sub_think budget exhausted: no iterations remaining');
  }

  const remainingTokens = computeRemainingTokenBudget(sharedState);
  if (remainingTokens !== undefined && remainingTokens <= 0) {
    throw new Error('sub_think budget exhausted: no tokens remaining');
  }

  const remainingWallTimeMs = getRemainingWallTimeMs(sharedState.startTime, sharedState.rootBudget);
  if (remainingWallTimeMs !== null && remainingWallTimeMs <= 0) {
    throw new Error('sub_think budget exhausted: no wall time remaining');
  }

  const childBudget: ThinkBudget = {
    ...config.budget,
    maxIterations: maxIterationsOverride === undefined
      ? remainingIterations
      : Math.min(remainingIterations, maxIterationsOverride),
  };

  if (remainingTokens !== undefined) {
    childBudget.maxTokens = maxTokensOverride === undefined
      ? remainingTokens
      : Math.min(remainingTokens, maxTokensOverride);
  } else if (maxTokensOverride !== undefined) {
    childBudget.maxTokens = maxTokensOverride;
  }

  if (remainingWallTimeMs !== null) {
    childBudget.maxWallTimeMs = maxWallTimeOverride === undefined
      ? remainingWallTimeMs
      : Math.min(remainingWallTimeMs, maxWallTimeOverride);
  } else if (maxWallTimeOverride !== undefined) {
    childBudget.maxWallTimeMs = maxWallTimeOverride;
  }

  return {
    ...config,
    budget: childBudget,
  };
}

interface BuildResultOptions {
  answer: string;
  iterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startTime: number;
  truncated: boolean;
  budgetStatus: BudgetStatus;
  steps: ThinkStep[];
  diagnostics: ThinkDiagnostics;
}

function buildThinkResult(options: BuildResultOptions): ThinkResult {
  const allEvidence = flattenEvidence(options.steps);
  return makeBudgetResult(
    {
      answer: options.answer,
      iterations: options.iterations,
      totalInputTokens: options.totalInputTokens,
      totalOutputTokens: options.totalOutputTokens,
      durationMs: Date.now() - options.startTime,
      truncated: options.truncated,
      budgetStatus: options.budgetStatus,
      steps: options.steps,
      evidence: allEvidence,
      diagnostics: options.diagnostics,
    },
  );
}

function pushPassiveStep(
  steps: ThinkStep[],
  iteration: number,
  response: LLMResponse,
  cumulativeTokens: number,
  iterationStart: number,
  output = '',
): void {
  steps.push(buildStep({
    iteration,
    code: '',
    output,
    error: null,
    evidenceCollected: [],
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cumulativeTokens,
    durationMs: Date.now() - iterationStart,
    variablesChanged: [],
  }));
}

interface ResolvedThinkRequestMetadata {
  requestId: string;
  turnId?: string;
  channelId?: string;
  toolName?: string;
  toolCallId?: string;
  originType: 'tool' | 'background' | 'scheduled' | 'chat' | 'memory' | 'summary';
}

function normalizeMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOriginType(value: string | undefined): ResolvedThinkRequestMetadata['originType'] | undefined {
  if (
    value === 'tool'
    || value === 'background'
    || value === 'scheduled'
    || value === 'chat'
    || value === 'memory'
    || value === 'summary'
  ) {
    return value;
  }
  return undefined;
}

function resolveThinkRequestMetadata(
  deps: REPLDeps,
  toolInvocationMetadata: Partial<LLMRequestMetadata> | undefined,
): ResolvedThinkRequestMetadata {
  const contextMetadata = getRequestContext();
  const merged = {
    ...(contextMetadata ?? {}),
    ...(deps.requestMetadata ?? {}),
    ...(toolInvocationMetadata ?? {}),
  };

  const turnId = normalizeMetadataValue(merged.turnId);
  const requestId = normalizeMetadataValue(merged.requestId)
    ?? turnId
    ?? `repl-think-${Date.now()}`;
  const originType = normalizeOriginType(normalizeMetadataValue(merged.originType))
    ?? normalizeOriginType(normalizeMetadataValue(merged.callType))
    ?? 'tool';

  return {
    requestId,
    ...(turnId ? { turnId } : {}),
    ...(normalizeMetadataValue(merged.channelId) ? { channelId: normalizeMetadataValue(merged.channelId) } : {}),
    toolName: normalizeMetadataValue(merged.toolName) ?? 'think',
    ...(normalizeMetadataValue(merged.toolCallId) ? { toolCallId: normalizeMetadataValue(merged.toolCallId) } : {}),
    originType,
  };
}

function buildThinkCorrelation(
  metadata: ResolvedThinkRequestMetadata,
  originStage: string,
  requestSuffix: string,
): CorrelationMetadata {
  return {
    ...(metadata.turnId ? { turnId: metadata.turnId } : {}),
    requestId: `${metadata.requestId}:${requestSuffix}`,
    ...(metadata.channelId ? { channelId: metadata.channelId } : {}),
    callType: metadata.originType,
    ...(metadata.toolName ? { toolName: metadata.toolName } : {}),
    ...(metadata.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
    purpose: originStage,
    originType: metadata.originType,
    originStage,
  };
}

function buildNestedThinkRequestMetadata(
  metadata: ResolvedThinkRequestMetadata,
  childId: number,
): Partial<LLMRequestMetadata> {
  const suffix = `subthink-${childId}`;
  return {
    ...(metadata.turnId ? { turnId: metadata.turnId } : {}),
    requestId: `${metadata.requestId}:${suffix}`,
    ...(metadata.channelId ? { channelId: metadata.channelId } : {}),
    toolName: metadata.toolName ?? 'think',
    ...(metadata.toolCallId ? { toolCallId: `${metadata.toolCallId}:${suffix}` } : {}),
    originType: metadata.originType,
    originStage: 'repl.think.subcall',
  };
}

export async function runRLMLoop(
  task: string,
  deps: REPLDeps,
  toolInvocationMetadata?: Partial<LLMRequestMetadata>,
  runOptions: ThinkRunOptions = {},
): Promise<ThinkResult> {
  const startTime = Date.now();
  const { config, llmProvider } = deps;
  const requestMetadata = resolveThinkRequestMetadata(deps, toolInvocationMetadata);
  const depth = runOptions.depth ?? 0;
  const isNestedRun = depth > 0;
  const tier = deps.getCapabilityTier?.() ?? 'autonomous';
  const budget = resolveEffectiveBudget(config, tier);
  const sharedState = runOptions.sharedState ?? createSharedThinkExecutionState(
    startTime,
    budget,
    {
      subQueries: 0,
      maxSubQueries: budget.maxSubQueries ?? 20,
      toolCalls: 0,
      maxToolCalls: budget.maxToolCalls ?? 50,
    },
  );

  const budgetStatus = createBudgetStatus();
  budgetStatus.warnings = sharedState.warnings;
  const governanceState = getOrCreateGovernanceState(llmProvider);
  const dayKey = toDayKey(sharedState.startTime);
  const dayCost = getDailyCostSnapshot(governanceState, tier, dayKey);
  syncBudgetStatusFromSharedState(budgetStatus, sharedState, dayCost.totalUsd);

  const rateWindowMs = Number.isFinite(config.rateLimit.windowMs)
    ? Math.max(1, Math.floor(config.rateLimit.windowMs))
    : 60_000;
  const maxInvocationsPerWindow = Number.isFinite(config.rateLimit.maxInvocationsPerMinute)
    ? Math.floor(config.rateLimit.maxInvocationsPerMinute)
    : 5;

  if (!runOptions.skipInvocationRateLimit && maxInvocationsPerWindow > 0) {
    const cutoff = sharedState.startTime - rateWindowMs;
    governanceState.invocationTimestampsMs = governanceState.invocationTimestampsMs
      .filter(ts => ts > cutoff);
    if (governanceState.invocationTimestampsMs.length >= maxInvocationsPerWindow) {
      updateBudgetRuntime(budgetStatus, startTime, 0, 0);
      budgetStatus.exceeded = INVOCATION_RATE_LIMIT_REASON;
      return buildThinkResult({
        answer: RATE_LIMIT_ANSWER,
        iterations: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        startTime,
        truncated: true,
        budgetStatus,
        steps: [],
        diagnostics: sharedState.diagnostics,
      });
    }
    governanceState.invocationTimestampsMs.push(sharedState.startTime);
  }

  const nurseryDailyCapUsd = Number.isFinite(config.cost.nurseryDailyCapUsd)
    ? Math.max(0, config.cost.nurseryDailyCapUsd)
    : 0;
  if (tier === 'nursery' && nurseryDailyCapUsd > 0 && dayCost.totalUsd >= nurseryDailyCapUsd) {
    updateBudgetRuntime(budgetStatus, startTime, 0, 0);
    budgetStatus.exceeded = NURSERY_DAILY_COST_REASON;
    return buildThinkResult({
      answer: NURSERY_DAILY_CAP_ANSWER,
      iterations: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      startTime,
      truncated: true,
      budgetStatus,
      steps: [],
      diagnostics: sharedState.diagnostics,
    });
  }

  const sandboxTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };
  const nestedThinkPolicy = requestMetadata.channelId
    ? evaluateCompositionalPolicyForChannelId({
      policy: deps.compositionalPolicy,
      capabilityTier: tier,
      channelId: requestMetadata.channelId,
      purpose: 'think',
    })
    : { allowed: false, reason: 'channel_type_not_allowed' as const };
  const sandboxLLMProvider = Object.create(llmProvider) as typeof llmProvider;
  sandboxLLMProvider.complete = async (context, purpose) => {
    const incomingCorrelation = context.correlation;
    const originStage = normalizeMetadataValue(incomingCorrelation?.originStage)
      ?? normalizeMetadataValue(incomingCorrelation?.purpose)
      ?? `repl.sandbox.${purpose}`;
    const correlationBase = buildThinkCorrelation(
      requestMetadata,
      originStage,
      `sandbox-${purpose}-${Date.now()}`,
    );
    const correlatedContext: LLMContext = {
      ...context,
      correlation: {
        ...correlationBase,
        ...(incomingCorrelation ?? {}),
        callType: incomingCorrelation?.callType
          ?? incomingCorrelation?.originType
          ?? correlationBase.callType,
        purpose: incomingCorrelation?.purpose
          ?? incomingCorrelation?.originStage
          ?? correlationBase.purpose,
        originType: incomingCorrelation?.originType
          ?? incomingCorrelation?.callType
          ?? correlationBase.originType,
        originStage: incomingCorrelation?.originStage
          ?? incomingCorrelation?.purpose
          ?? correlationBase.originStage,
      },
    };
    const response = await llmProvider.complete(correlatedContext, purpose);
    sandboxTokenUsage.inputTokens += response.inputTokens;
    sandboxTokenUsage.outputTokens += response.outputTokens;
    return response;
  };

  const steps: ThinkStep[] = [];
  const memoryCeilingBytes = resolveMemoryCeilingBytes(config, tier);
  const nestedThinkRunner = async (
    nestedTask: string,
    nestedOptions?: NestedThinkOptions,
  ): Promise<string> => {
    sharedState.diagnostics.nestedThinkCallCount += 1;
    sharedState.diagnostics.maxNestedDepthReached = Math.max(
      sharedState.diagnostics.maxNestedDepthReached,
      depth + 1,
    );
    if (!nestedThinkPolicy.allowed) {
      sharedState.diagnostics.nestedThinkFailureCount += 1;
      throw new Error(`sub_think is disabled by compositional policy (${nestedThinkPolicy.reason})`);
    }
    if (depth >= MAX_NESTED_THINK_DEPTH) {
      sharedState.diagnostics.nestedThinkFailureCount += 1;
      throw new Error(`sub_think depth limit reached (${MAX_NESTED_THINK_DEPTH})`);
    }
    try {
      const childId = ++sharedState.nextNestedThinkId;
      const childConfig = buildNestedThinkConfig(config, sharedState, nestedOptions);
      const childResult = await runRLMLoop(
        nestedTask,
        {
          ...deps,
          config: childConfig,
        },
        buildNestedThinkRequestMetadata(requestMetadata, childId),
        {
          depth: depth + 1,
          sharedState,
          skipInvocationRateLimit: true,
        },
      );
      sharedState.diagnostics.nestedThinkSuccessCount += 1;
      return childResult.answer;
    } catch (error) {
      sharedState.diagnostics.nestedThinkFailureCount += 1;
      throw error;
    }
  };

  const sandbox = new REPLSandbox({
    llmProvider: sandboxLLMProvider,
    executionPort: deps.executionPort ?? null,
    embeddingService: deps.embeddingService,
    memoryStore: deps.memoryStore,
    sessionManager: deps.sessionManager,
    scheduler: deps.scheduler,
    eventBus: deps.eventBus,
    getCapabilityTier: deps.getCapabilityTier,
    runNestedThink: nestedThinkRunner,
    moduleInstallConfirmationQueue: deps.moduleInstallConfirmationQueue,
    onModuleRegistryMutation: deps.onModuleRegistryMutation,
    requestMetadata,
  }, sharedState.budgetRef, { memoryCeilingBytes });

  // Gather context metadata for system prompt
  const stats = deps.memoryStore?.getStats();
  const metadata: ThinkContextMetadata = {
    memoryCount: stats?.total ?? 0,
    memoryBreakdown: stats
      ? Object.entries(stats.byType)
        .filter(([, n]) => (n as number) > 0)
        .map(([type, n]) => `${n} ${type}`)
        .join(', ')
      : 'none',
    channelCount: 0,
    currentChannelMessages: 0,
    nestedThinkAvailable: nestedThinkPolicy.allowed && depth < MAX_NESTED_THINK_DEPTH,
  };

  const systemPrompt = buildRLMSystemPrompt(metadata, deps.mutationPolicy);

  const messages: ContextMessage[] = [
    { role: 'user', content: task },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let localIterations = 0;
  const autonomousWarningUsd = Number.isFinite(config.cost.autonomousDailyWarningUsd)
    ? Math.max(0, config.cost.autonomousDailyWarningUsd)
    : 0;
  const applyCostCharge = (inputTokens: number, outputTokens: number): void => {
    const iterationCostUsd = estimateIterationCostUsd(
      config,
      inputTokens,
      outputTokens,
    );
    sharedState.sessionCostUsd += iterationCostUsd;
    dayCost.totalUsd += iterationCostUsd;
    syncBudgetStatusFromSharedState(budgetStatus, sharedState, dayCost.totalUsd);

    if (
      tier === 'autonomous'
      && autonomousWarningUsd > 0
      && !sharedState.autonomousCostWarningSent
      && dayCost.totalUsd >= autonomousWarningUsd
    ) {
      sharedState.warnings.push(
        `Autonomous daily think spend warning: $${dayCost.totalUsd.toFixed(4)} >= $${autonomousWarningUsd.toFixed(4)}`,
      );
      sharedState.autonomousCostWarningSent = true;
    }
  };

  const finalizeBudgetStatus = (): void => {
    if (isNestedRun) {
      updateBudgetRuntime(
        budgetStatus,
        startTime,
        sharedState.budgetRef.subQueries,
        sharedState.budgetRef.toolCalls ?? 0,
      );
    } else {
      updateBudgetProgress(
        budgetStatus,
        sharedState.consumedIterations,
        sharedState.totalInputTokens,
        sharedState.totalOutputTokens,
        startTime,
        sharedState.budgetRef.subQueries,
        sharedState.budgetRef.toolCalls ?? 0,
      );
    }
    syncBudgetStatusFromSharedState(budgetStatus, sharedState, dayCost.totalUsd);
  };

  const refreshBudgetStatus = (): void => {
    updateBudgetProgress(
      budgetStatus,
      localIterations,
      totalInputTokens,
      totalOutputTokens,
      startTime,
      sharedState.budgetRef.subQueries,
      sharedState.budgetRef.toolCalls ?? 0,
    );
    syncBudgetStatusFromSharedState(budgetStatus, sharedState, dayCost.totalUsd);
  };

  const enforceBudgets = (): void => {
    refreshBudgetStatus();
    checkBudget(budgetStatus, budget);
    if (!budgetStatus.exceeded) {
      budgetStatus.exceeded = checkSharedBudgetExceeded(sharedState);
    }
  };

  while (localIterations < budget.maxIterations) {
    if (tier === 'nursery' && nurseryDailyCapUsd > 0 && dayCost.totalUsd >= nurseryDailyCapUsd) {
      finalizeBudgetStatus();
      budgetStatus.exceeded = NURSERY_DAILY_COST_REASON;
      break;
    }

    const iterationStart = Date.now();
    const remainingBeforeLLM = pickMostConstrainedRemainingWallTimeMs(
      getRemainingWallTimeMs(startTime, budget),
      getRemainingWallTimeMs(sharedState.startTime, sharedState.rootBudget),
    );
    if (remainingBeforeLLM !== null && remainingBeforeLLM <= 0) {
      finalizeBudgetStatus();
      budgetStatus.exceeded = 'wall time';
      break;
    }

    let response: LLMResponse;
    const iterationNumber = localIterations + 1;
    try {
      const timeoutMs = remainingBeforeLLM === null
        ? null
        : Math.floor(remainingBeforeLLM - LLM_TIMEOUT_BUFFER_MS);
      if (timeoutMs !== null && timeoutMs <= 0) {
        finalizeBudgetStatus();
        budgetStatus.exceeded = 'wall time';
        break;
      }

      const completion = llmProvider.complete(
        {
          systemPrompt,
          messages,
          correlation: buildThinkCorrelation(
            requestMetadata,
            'repl.think.iteration',
            `iteration-${iterationNumber}`,
          ),
        },
        'reasoning',
      );
      response = timeoutMs === null
        ? await completion
        : await withTimeout(completion, timeoutMs);
    } catch (error) {
      finalizeBudgetStatus();
      if (error instanceof LLMIterationTimeoutError) {
        budgetStatus.exceeded = LLM_TIMEOUT_REASON;
        break;
      }
      throw error;
    }

    localIterations = iterationNumber;
    sharedState.consumedIterations += 1;
    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;
    sharedState.totalInputTokens += response.inputTokens;
    sharedState.totalOutputTokens += response.outputTokens;

    applyCostCharge(response.inputTokens, response.outputTokens);
    refreshBudgetStatus();

    const text = response.content;
    messages.push({ role: 'assistant', content: text });

    const action = parseResponse(text);

    switch (action.type) {
      case 'final': {
        pushPassiveStep(
          steps,
          iterationNumber,
          response,
          sharedState.totalInputTokens + sharedState.totalOutputTokens,
          iterationStart,
          action.answer,
        );
        finalizeBudgetStatus();
        return buildThinkResult({
          answer: action.answer,
          iterations: isNestedRun ? localIterations : sharedState.consumedIterations,
          totalInputTokens: isNestedRun ? totalInputTokens : sharedState.totalInputTokens,
          totalOutputTokens: isNestedRun ? totalOutputTokens : sharedState.totalOutputTokens,
          startTime,
          truncated: false,
          budgetStatus,
          steps,
          diagnostics: sharedState.diagnostics,
        });
      }

      case 'final_var': {
        const locals = sandbox.getLocals();
        const value = locals[action.varName];
        const answer = value !== undefined ? String(value) : `[Variable "${action.varName}" not found]`;
        pushPassiveStep(
          steps,
          iterationNumber,
          response,
          sharedState.totalInputTokens + sharedState.totalOutputTokens,
          iterationStart,
          answer,
        );
        finalizeBudgetStatus();
        return buildThinkResult({
          answer,
          iterations: isNestedRun ? localIterations : sharedState.consumedIterations,
          totalInputTokens: isNestedRun ? totalInputTokens : sharedState.totalInputTokens,
          totalOutputTokens: isNestedRun ? totalOutputTokens : sharedState.totalOutputTokens,
          startTime,
          truncated: false,
          budgetStatus,
          steps,
          diagnostics: sharedState.diagnostics,
        });
      }

      case 'code': {
        const sandboxInputBefore = sandboxTokenUsage.inputTokens;
        const sandboxOutputBefore = sandboxTokenUsage.outputTokens;
        const result = await sandbox.execute(action.code, config.executionTimeoutMs, config.outputTruncation);
        const sandboxInputDelta = sandboxTokenUsage.inputTokens - sandboxInputBefore;
        const sandboxOutputDelta = sandboxTokenUsage.outputTokens - sandboxOutputBefore;
        if (sandboxInputDelta > 0 || sandboxOutputDelta > 0) {
          applyCostCharge(sandboxInputDelta, sandboxOutputDelta);
        }
        const stepEvidence = sandbox.collectEvidence();
        const stepTokens = response.inputTokens + response.outputTokens;

        const step = buildStep({
          iteration: iterationNumber,
          code: action.code,
          output: result.output,
          error: result.error,
          evidenceCollected: stepEvidence,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cumulativeTokens: isNestedRun
            ? totalInputTokens + totalOutputTokens
            : sharedState.totalInputTokens + sharedState.totalOutputTokens,
          durationMs: Date.now() - iterationStart,
          variablesChanged: result.variablesChanged,
        });
        steps.push(step);

        if (result.finalAnswer !== null) {
          finalizeBudgetStatus();
          return buildThinkResult({
            answer: result.finalAnswer,
            iterations: isNestedRun ? localIterations : sharedState.consumedIterations,
            totalInputTokens: isNestedRun ? totalInputTokens : sharedState.totalInputTokens,
            totalOutputTokens: isNestedRun ? totalOutputTokens : sharedState.totalOutputTokens,
            startTime,
            truncated: false,
            budgetStatus,
            steps,
            diagnostics: sharedState.diagnostics,
          });
        }

        const feedback = formatExecutionFeedback(
          result.output,
          result.error,
          iterationNumber,
          stepTokens,
          result.variablesChanged,
        );

        messages.push({ role: 'user', content: feedback });
        break;
      }

      case 'none':
        {
        pushPassiveStep(
          steps,
          iterationNumber,
          response,
          sharedState.totalInputTokens + sharedState.totalOutputTokens,
          iterationStart,
        );
        messages.push({
          role: 'user',
          content: 'Please write a ```repl code block to execute, or call FINAL("your answer") when done.',
        });
        break;
        }
    }

    enforceBudgets();
    if (budgetStatus.exceeded) break;
  }

  // Budget or max iterations exhausted
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  finalizeBudgetStatus();
  if (!budgetStatus.exceeded) {
    budgetStatus.exceeded = 'max iterations';
  }
  const timeoutFallback = budgetStatus.exceeded === LLM_TIMEOUT_REASON
    ? LLM_TIMEOUT_ANSWER
    : budgetStatus.exceeded === NURSERY_DAILY_COST_REASON
      ? NURSERY_DAILY_CAP_ANSWER
    : '[No response generated]';
  return buildThinkResult({
    answer: lastAssistant?.content ?? timeoutFallback,
    iterations: isNestedRun ? localIterations : sharedState.consumedIterations,
    totalInputTokens: isNestedRun ? totalInputTokens : sharedState.totalInputTokens,
    totalOutputTokens: isNestedRun ? totalOutputTokens : sharedState.totalOutputTokens,
    startTime,
    truncated: true,
    budgetStatus,
    steps,
    diagnostics: sharedState.diagnostics,
  });
}
