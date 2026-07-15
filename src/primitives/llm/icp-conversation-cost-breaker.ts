import type { CorrelationMetadata } from '../../shared/contracts/runtime.js';
import { parseIcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type {
  IcpConversationCostAccountingPort,
  IcpConversationCostBreakerBlockReason,
  IcpConversationCostBreakerEvent,
  IcpConversationCostReservationResult,
} from '../../shared/telemetry/model-usage.js';
import { estimateConservativeModelUsageCostUsd } from '../../shared/telemetry/model-usage-accounting.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resolveModelUsageCostRates } from './model-budget.js';
import type { RoutingCandidate, RoutingPurpose } from './routing.js';

export interface IcpConversationCostPhysicalAttempt {
  candidate: RoutingCandidate;
  purpose: RoutingPurpose;
  estimatedInputTokens: number;
  promptCacheEngaged?: boolean;
  logicalCallId: string;
  attempt: number;
  correlation?: Partial<CorrelationMetadata>;
  requestedAtMs?: number;
}

export class IcpConversationCostBreakerError extends Error {
  readonly code = 'icp_conversation_cost_blocked';

  constructor(
    readonly event: IcpConversationCostBreakerEvent & { outcome: 'blocked' },
    cause?: Error,
  ) {
    super(
      `ICP conversation cost breaker blocked ${event.provider}:${event.model} (${event.reason})`,
      cause ? { cause } : undefined,
    );
    this.name = 'IcpConversationCostBreakerError';
  }
}

function normalizeTokenCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function blockedEvent(
  input: IcpConversationCostPhysicalAttempt,
  reason: IcpConversationCostBreakerBlockReason,
  timestampMs: number,
  options: {
    projectedRequestCostUsd?: number;
    projection?: IcpConversationCostReservationResult['projection'];
  } = {},
): IcpConversationCostBreakerEvent & { outcome: 'blocked' } {
  const correlation = parseIcpConversationCorrelation(input.correlation?.icpCorrelation);
  return {
    timestampMs,
    outcome: 'blocked',
    reason,
    logicalCallId: input.logicalCallId,
    attempt: input.attempt,
    conversationId: correlation.conversationId,
    rootInitiationId: correlation.rootInitiationId,
    localCompanionId: correlation.localCompanionId,
    costPurpose: correlation.costPurpose,
    costOriginStage: correlation.costOriginStage,
    provider: input.candidate.provider,
    model: input.candidate.model,
    ...(input.candidate.slotKey ? { slotKey: input.candidate.slotKey } : {}),
    routingPurpose: input.purpose,
    ...(options.projectedRequestCostUsd !== undefined
      ? { projectedRequestCostUsd: options.projectedRequestCostUsd }
      : {}),
    replayed: false,
    ...(options.projection ? { projection: options.projection } : {}),
  };
}

export class IcpConversationCostBreaker {
  constructor(
    private readonly config: SubstrateConfig,
    private readonly accounting?: IcpConversationCostAccountingPort,
    private readonly onDecision?: (event: IcpConversationCostBreakerEvent) => void,
  ) {}

  requiresInputEstimate(correlation: Partial<CorrelationMetadata> | undefined): boolean {
    return this.config.chargePolicy?.icpCostBreaker.enabled === true
      && correlation?.icpCorrelation !== undefined;
  }

  async reservePhysicalAttempt(
    input: IcpConversationCostPhysicalAttempt,
  ): Promise<IcpConversationCostReservationResult | undefined> {
    const policy = this.config.chargePolicy?.icpCostBreaker;
    if (policy?.enabled !== true || input.correlation?.icpCorrelation === undefined) {
      return undefined;
    }

    const timestampMs = input.requestedAtMs ?? Date.now();
    const correlation = parseIcpConversationCorrelation(input.correlation.icpCorrelation);
    const attempt = normalizeTokenCount(input.attempt, 'attempt');
    if (attempt < 1) throw new Error('attempt must be at least 1');
    const estimatedInputTokens = normalizeTokenCount(
      input.estimatedInputTokens,
      'estimatedInputTokens',
    );
    const estimatedOutputTokens = normalizeTokenCount(
      input.candidate.maxTokens,
      'candidate.maxTokens',
    );
    const estimatedCacheReadTokens = input.promptCacheEngaged === true
      ? estimatedInputTokens
      : 0;
    const estimatedCacheWriteTokens = input.promptCacheEngaged === true
      ? estimatedInputTokens
      : 0;

    const rates = resolveModelUsageCostRates(this.config, input.candidate, input.purpose);
    const projected = estimateConservativeModelUsageCostUsd({
      inputTokens: estimatedInputTokens,
      outputTokens: estimatedOutputTokens,
      cacheReadTokens: estimatedCacheReadTokens,
      cacheWriteTokens: estimatedCacheWriteTokens,
      totalTokens: estimatedInputTokens
        + estimatedOutputTokens
        + estimatedCacheReadTokens
        + estimatedCacheWriteTokens,
    }, rates);
    if (projected === undefined) {
      const event = blockedEvent(input, 'missing_cost_metadata', timestampMs);
      this.onDecision?.(event);
      throw new IcpConversationCostBreakerError(event);
    }
    if (!this.accounting) {
      const event = blockedEvent(input, 'accounting_unavailable', timestampMs, {
        projectedRequestCostUsd: projected,
      });
      this.onDecision?.(event);
      throw new IcpConversationCostBreakerError(event);
    }

    let result: IcpConversationCostReservationResult;
    try {
      result = await this.accounting.reserveIcpConversationCost({
        logicalCallId: input.logicalCallId,
        attempt,
        projectedCostUsd: projected,
        correlation,
        policy,
        requestedAtMs: timestampMs,
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const event = blockedEvent(input, 'accounting_unavailable', timestampMs, {
        projectedRequestCostUsd: projected,
      });
      this.onDecision?.(event);
      throw new IcpConversationCostBreakerError(event, cause);
    }

    const event: IcpConversationCostBreakerEvent = {
      timestampMs,
      outcome: result.allowed
        ? (result.reason === 'final_closeout_reserve' ? 'warning' : 'reserved')
        : 'blocked',
      reason: result.reason,
      logicalCallId: input.logicalCallId,
      attempt,
      conversationId: correlation.conversationId,
      rootInitiationId: correlation.rootInitiationId,
      localCompanionId: correlation.localCompanionId,
      costPurpose: correlation.costPurpose,
      costOriginStage: correlation.costOriginStage,
      provider: input.candidate.provider,
      model: input.candidate.model,
      ...(input.candidate.slotKey ? { slotKey: input.candidate.slotKey } : {}),
      routingPurpose: input.purpose,
      projectedRequestCostUsd: result.projectedRequestCostUsd,
      replayed: result.replayed,
      projection: result.projection,
    };
    this.onDecision?.(event);
    if (!result.allowed) {
      throw new IcpConversationCostBreakerError({
        ...event,
        outcome: 'blocked',
      });
    }
    return result;
  }
}
