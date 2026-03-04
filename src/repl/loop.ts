// ── RLM Iteration Loop ──
// Runs an ephemeral think cycle: LLM → code → output → repeat until FINAL.

import type { CapabilityTier, ContextMessage, LLMContext, LLMResponse } from '../types.js';
import type { LLMRequestMetadata } from '../agent/contracts.js';
import type {
  BudgetStatus,
  REPLDeps,
  REPLConfig,
  ThinkBudget,
  ThinkResult,
  ThinkStep,
} from './types.js';
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
import { getRequestContext } from '../llm/request-context.js';

const LLM_TIMEOUT_BUFFER_MS = 25;
const LLM_TIMEOUT_REASON = 'llm timeout';
const LLM_TIMEOUT_ANSWER = '[Think loop timed out waiting for LLM response]';
const INVOCATION_RATE_LIMIT_REASON = 'invocation rate limit';
const NURSERY_DAILY_COST_REASON = 'daily cost cap';
const RATE_LIMIT_ANSWER = '[Think invocation rate limit exceeded; try again shortly]';
const NURSERY_DAILY_CAP_ANSWER = '[Think daily cost cap reached for nursery tier]';

interface DailyCostSnapshot {
  dayKey: string;
  totalUsd: number;
}

interface ReplGovernanceState {
  invocationTimestampsMs: number[];
  dailyCostByTier: Record<CapabilityTier, DailyCostSnapshot>;
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

interface BuildResultOptions {
  answer: string;
  iterations: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startTime: number;
  truncated: boolean;
  budgetStatus: BudgetStatus;
  steps: ThinkStep[];
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
): LLMContext['correlation'] {
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

export async function runRLMLoop(
  task: string,
  deps: REPLDeps,
  toolInvocationMetadata?: Partial<LLMRequestMetadata>,
): Promise<ThinkResult> {
  const startTime = Date.now();
  const { config, llmProvider } = deps;
  const requestMetadata = resolveThinkRequestMetadata(deps, toolInvocationMetadata);
  const tier = deps.getCapabilityTier?.() ?? 'autonomous';
  const budget = resolveEffectiveBudget(config, tier);

  // Budget tracking
  const budgetStatus = createBudgetStatus();
  const governanceState = getOrCreateGovernanceState(llmProvider);
  const dayKey = toDayKey(startTime);
  const dayCost = getDailyCostSnapshot(governanceState, tier, dayKey);
  budgetStatus.dayCostUsd = dayCost.totalUsd;

  const rateWindowMs = Number.isFinite(config.rateLimit.windowMs)
    ? Math.max(1, Math.floor(config.rateLimit.windowMs))
    : 60_000;
  const maxInvocationsPerWindow = Number.isFinite(config.rateLimit.maxInvocationsPerMinute)
    ? Math.floor(config.rateLimit.maxInvocationsPerMinute)
    : 5;

  if (maxInvocationsPerWindow > 0) {
    const cutoff = startTime - rateWindowMs;
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
      });
    }
    governanceState.invocationTimestampsMs.push(startTime);
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
    });
  }

  // Shared budget ref for sandbox llm_query tracking
  const budgetRef: SandboxBudgetRef = {
    subQueries: 0,
    maxSubQueries: budget.maxSubQueries ?? 20,
    toolCalls: 0,
    maxToolCalls: budget.maxToolCalls ?? 50,
  };
  const sandboxTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
  };
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

  const sandbox = new REPLSandbox({
    llmProvider: sandboxLLMProvider,
    embeddingService: deps.embeddingService,
    memoryStore: deps.memoryStore,
    sessionManager: deps.sessionManager,
    scheduler: deps.scheduler,
    eventBus: deps.eventBus,
    getCapabilityTier: deps.getCapabilityTier,
    moduleInstallConfirmationQueue: deps.moduleInstallConfirmationQueue,
    onModuleRegistryMutation: deps.onModuleRegistryMutation,
    requestMetadata,
  }, budgetRef, { memoryCeilingBytes });

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
  };

  const systemPrompt = buildRLMSystemPrompt(metadata);

  const messages: ContextMessage[] = [
    { role: 'user', content: task },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let autonomousCostWarningSent = false;
  const autonomousWarningUsd = Number.isFinite(config.cost.autonomousDailyWarningUsd)
    ? Math.max(0, config.cost.autonomousDailyWarningUsd)
    : 0;
  const applyCostCharge = (inputTokens: number, outputTokens: number): void => {
    const iterationCostUsd = estimateIterationCostUsd(
      config,
      inputTokens,
      outputTokens,
    );
    budgetStatus.sessionCostUsd += iterationCostUsd;
    dayCost.totalUsd += iterationCostUsd;
    budgetStatus.dayCostUsd = dayCost.totalUsd;

    if (
      tier === 'autonomous'
      && autonomousWarningUsd > 0
      && !autonomousCostWarningSent
      && dayCost.totalUsd >= autonomousWarningUsd
    ) {
      budgetStatus.warnings.push(
        `Autonomous daily think spend warning: $${dayCost.totalUsd.toFixed(4)} >= $${autonomousWarningUsd.toFixed(4)}`,
      );
      autonomousCostWarningSent = true;
    }
  };

  for (let i = 0; i < budget.maxIterations; i++) {
    if (tier === 'nursery' && nurseryDailyCapUsd > 0 && dayCost.totalUsd >= nurseryDailyCapUsd) {
      updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries, budgetRef.toolCalls ?? 0);
      budgetStatus.exceeded = NURSERY_DAILY_COST_REASON;
      break;
    }

    const iterationStart = Date.now();
    const remainingBeforeLLM = getRemainingWallTimeMs(startTime, budget);
    if (remainingBeforeLLM !== null && remainingBeforeLLM <= 0) {
      updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries, budgetRef.toolCalls ?? 0);
      budgetStatus.exceeded = 'wall time';
      break;
    }

    let response: LLMResponse;
    try {
      const timeoutMs = remainingBeforeLLM === null
        ? null
        : Math.floor(remainingBeforeLLM - LLM_TIMEOUT_BUFFER_MS);
      if (timeoutMs !== null && timeoutMs <= 0) {
        updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries, budgetRef.toolCalls ?? 0);
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
            `iteration-${i + 1}`,
          ),
        },
        'reasoning',
      );
      response = timeoutMs === null
        ? await completion
        : await withTimeout(completion, timeoutMs);
    } catch (error) {
      updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries, budgetRef.toolCalls ?? 0);
      if (error instanceof LLMIterationTimeoutError) {
        budgetStatus.exceeded = LLM_TIMEOUT_REASON;
        break;
      }
      throw error;
    }

    totalInputTokens += response.inputTokens;
    totalOutputTokens += response.outputTokens;

    // Update budget status
    updateBudgetProgress(
      budgetStatus,
      i + 1,
      totalInputTokens,
      totalOutputTokens,
      startTime,
      budgetRef.subQueries,
      budgetRef.toolCalls ?? 0,
    );

    applyCostCharge(response.inputTokens, response.outputTokens);

    const text = response.content;
    messages.push({ role: 'assistant', content: text });

    const action = parseResponse(text);

    switch (action.type) {
      case 'final': {
        pushPassiveStep(
          steps,
          i + 1,
          response,
          budgetStatus.totalTokens,
          iterationStart,
          action.answer,
        );
        return buildThinkResult({
          answer: action.answer,
          iterations: i + 1,
          totalInputTokens,
          totalOutputTokens,
          startTime,
          truncated: false,
          budgetStatus,
          steps,
        });
      }

      case 'final_var': {
        const locals = sandbox.getLocals();
        const value = locals[action.varName];
        const answer = value !== undefined ? String(value) : `[Variable "${action.varName}" not found]`;
        pushPassiveStep(
          steps,
          i + 1,
          response,
          budgetStatus.totalTokens,
          iterationStart,
          answer,
        );
        return buildThinkResult({
          answer,
          iterations: i + 1,
          totalInputTokens,
          totalOutputTokens,
          startTime,
          truncated: false,
          budgetStatus,
          steps,
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
          iteration: i + 1,
          code: action.code,
          output: result.output,
          error: result.error,
          evidenceCollected: stepEvidence,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          cumulativeTokens: budgetStatus.totalTokens,
          durationMs: Date.now() - iterationStart,
          variablesChanged: result.variablesChanged,
        });
        steps.push(step);

        if (result.finalAnswer !== null) {
          return buildThinkResult({
            answer: result.finalAnswer,
            iterations: i + 1,
            totalInputTokens,
            totalOutputTokens,
            startTime,
            truncated: false,
            budgetStatus,
            steps,
          });
        }

        const feedback = formatExecutionFeedback(
          result.output,
          result.error,
          i + 1,
          stepTokens,
          result.variablesChanged,
        );

        messages.push({ role: 'user', content: feedback });
        break;
      }

      case 'none':
        {
        pushPassiveStep(steps, i + 1, response, budgetStatus.totalTokens, iterationStart);
        messages.push({
          role: 'user',
          content: 'Please write a ```repl code block to execute, or call FINAL("your answer") when done.',
        });
        break;
        }
    }

    // Check budget after each iteration
    updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries, budgetRef.toolCalls ?? 0);
    checkBudget(budgetStatus, budget);
    if (budgetStatus.exceeded) break;
  }

  // Budget or max iterations exhausted
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  updateBudgetRuntime(budgetStatus, startTime, budgetRef.subQueries, budgetRef.toolCalls ?? 0);
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
    iterations: budgetStatus.iterations,
    totalInputTokens,
    totalOutputTokens,
    startTime,
    truncated: true,
    budgetStatus,
    steps,
  });
}
