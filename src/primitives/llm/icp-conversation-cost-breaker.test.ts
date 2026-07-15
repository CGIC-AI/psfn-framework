import { describe, expect, it, vi } from 'vitest';

import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  IcpConversationCostAccountingPort,
  IcpConversationCostProjection,
} from '../../shared/telemetry/model-usage.js';
import type { RoutingCandidate } from './routing.js';
import {
  IcpConversationCostBreaker,
  IcpConversationCostBreakerError,
} from './icp-conversation-cost-breaker.js';

const POLICY = {
  enabled: true as const,
  warningThresholdUsd: 0.002,
  hardLimitUsd: 0.004,
  finalCloseoutReserveUsd: 0.002,
  pendingReservationStaleAfterMs: 60_000,
  includedCostPurposes: {
    conversation_turn: true,
    tool: true,
    summary: true,
    extraction: true,
    sidecar: true,
  },
};

const CORRELATION: IcpConversationCorrelation = {
  conversationId: '33333333-3333-4333-8333-333333333333',
  rootInitiationId: '44444444-4444-4444-8444-444444444444',
  initiatedByCompanionId: '11111111-1111-4111-8111-111111111111',
  localCompanionId: '11111111-1111-4111-8111-111111111111',
  peerCompanionId: '22222222-2222-4222-8222-222222222222',
  peerContactId: 'contact-b',
  channelId: 'companion-dm:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  turnId: 'turn-1',
  messageId: 'message-1',
  requestId: 'request-1',
  chargeLane: 'companion_social',
  surface: 'companion_dm',
  costPurpose: 'conversation_turn',
  costOriginStage: 'reply',
  fatigueDecision: 'allow',
};

const CANDIDATE: RoutingCandidate = {
  provider: 'openrouter',
  model: 'test/model',
  slotKey: 'chat-primary',
  maxTokens: 1_000,
};

function makeConfig(options: {
  enabled?: boolean;
  includeRates?: boolean;
  inputRateUsd?: number;
  outputRateUsd?: number;
  cacheReadRateUsd?: number;
  cacheWriteRateUsd?: number;
} = {}): SubstrateConfig {
  return {
    chargePolicy: {
      icpCostBreaker: options.enabled === false ? { enabled: false } : POLICY,
    },
    modelRegistry: {
      schemaVersion: 1,
      models: [{
        id: 'chat-primary',
        rank: 1,
        identity: { provider: 'openrouter', model: 'test/model' },
        purposes: [{ purpose: 'chat' }],
        ...(options.includeRates === false
          ? {}
          : {
              cost: {
                inputPer1MUsd: options.inputRateUsd ?? 1,
                outputPer1MUsd: options.outputRateUsd ?? 2,
                ...(options.cacheReadRateUsd !== undefined
                  ? { cacheReadPer1MUsd: options.cacheReadRateUsd }
                  : {}),
                ...(options.cacheWriteRateUsd !== undefined
                  ? { cacheWritePer1MUsd: options.cacheWriteRateUsd }
                  : {}),
                currency: 'USD' as const,
              },
            }),
      }],
    },
  } as SubstrateConfig;
}

function projection(overrides: Partial<IcpConversationCostProjection> = {}): IcpConversationCostProjection {
  return {
    conversationId: CORRELATION.conversationId,
    rootInitiationId: CORRELATION.rootInitiationId,
    actualCostUsd: 0,
    pendingProjectedCostUsd: 0.003,
    projectedTotalCostUsd: 0.003,
    warningThresholdUsd: POLICY.warningThresholdUsd,
    hardLimitUsd: POLICY.hardLimitUsd,
    remainingToHardLimitUsd: 0.001,
    actualAttemptCount: 0,
    unknownCostAttemptCount: 0,
    pendingReservationCount: 1,
    staleReservationCount: 0,
    settledReservationCount: 0,
    attributedCompanionCount: 1,
    enforcementState: 'warning',
    ...overrides,
  };
}

function accountingPort(
  reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>(async () => ({
    allowed: true,
    replayed: false,
    reason: 'final_closeout_reserve',
    projectedRequestCostUsd: 0.003,
    projection: projection(),
  })),
): IcpConversationCostAccountingPort {
  return {
    reserveIcpConversationCost: reserve,
    getIcpConversationCostProjection: vi.fn(async () => projection()),
  };
}

describe('IcpConversationCostBreaker', () => {
  it('projects canonical model rates and emits a content-free warning reservation decision', async () => {
    const reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>(async () => ({
      allowed: true,
      replayed: false,
      reason: 'final_closeout_reserve',
      projectedRequestCostUsd: 0.003,
      projection: projection(),
    }));
    const onDecision = vi.fn();
    const breaker = new IcpConversationCostBreaker(makeConfig(), accountingPort(reserve), onDecision);

    const result = await breaker.reservePhysicalAttempt({
      candidate: CANDIDATE,
      purpose: 'chat',
      estimatedInputTokens: 1_000,
      logicalCallId: 'logical-1',
      attempt: 7,
      correlation: { icpCorrelation: CORRELATION },
      requestedAtMs: 123,
    });

    expect(result?.reason).toBe('final_closeout_reserve');
    expect(reserve).toHaveBeenCalledWith({
      logicalCallId: 'logical-1',
      attempt: 7,
      projectedCostUsd: 0.003,
      correlation: CORRELATION,
      policy: POLICY,
      requestedAtMs: 123,
    });
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({
      timestampMs: 123,
      outcome: 'warning',
      reason: 'final_closeout_reserve',
      conversationId: CORRELATION.conversationId,
      rootInitiationId: CORRELATION.rootInitiationId,
      localCompanionId: CORRELATION.localCompanionId,
      costPurpose: 'conversation_turn',
      projectedRequestCostUsd: 0.003,
      projection: expect.objectContaining({ enforcementState: 'warning' }),
    }));
    expect(onDecision.mock.calls[0]?.[0]).not.toHaveProperty('peerContactId');
    expect(onDecision.mock.calls[0]?.[0]).not.toHaveProperty('peerCompanionId');
  });

  it('rounds provider admission projections upward so sub-picodollar excess cannot cross hard', async () => {
    const reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>(async input => ({
      allowed: false,
      replayed: false,
      reason: 'hard_limit_exceeded',
      projectedRequestCostUsd: input.projectedCostUsd,
      projection: projection(),
    }));
    const breaker = new IcpConversationCostBreaker(
      makeConfig({ inputRateUsd: 1.0000000000004, outputRateUsd: 0 }),
      accountingPort(reserve),
    );

    await expect(breaker.reservePhysicalAttempt({
      candidate: { ...CANDIDATE, maxTokens: 0 },
      purpose: 'chat',
      estimatedInputTokens: 1_000_000,
      logicalCallId: 'precision-boundary',
      attempt: 1,
      correlation: { icpCorrelation: CORRELATION },
    })).rejects.toMatchObject({
      code: 'icp_conversation_cost_blocked',
      event: { reason: 'hard_limit_exceeded' },
    });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      projectedCostUsd: 1.000000000001,
    }));
  });

  it('projects the full prompt across every potentially billable cache bucket', async () => {
    const reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>(async input => ({
      allowed: true,
      replayed: false,
      reason: 'below_warning',
      projectedRequestCostUsd: input.projectedCostUsd,
      projection: projection(),
    }));
    const breaker = new IcpConversationCostBreaker(
      makeConfig({
        inputRateUsd: 1,
        outputRateUsd: 0,
        cacheReadRateUsd: 0.2,
        cacheWriteRateUsd: 3,
      }),
      accountingPort(reserve),
    );

    await breaker.reservePhysicalAttempt({
      candidate: { ...CANDIDATE, maxTokens: 0 },
      purpose: 'chat',
      estimatedInputTokens: 1_000,
      promptCacheEngaged: true,
      logicalCallId: 'cache-envelope',
      attempt: 1,
      correlation: { icpCorrelation: CORRELATION },
    });

    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      projectedCostUsd: 0.004200000001,
    }));
  });

  it('fails closed when an engaged cache has an unpriced billable bucket', async () => {
    const reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>();
    const breaker = new IcpConversationCostBreaker(
      makeConfig({ cacheReadRateUsd: 0.2 }),
      accountingPort(reserve),
    );

    await expect(breaker.reservePhysicalAttempt({
      candidate: CANDIDATE,
      purpose: 'chat',
      estimatedInputTokens: 1_000,
      promptCacheEngaged: true,
      logicalCallId: 'cache-missing-write-price',
      attempt: 1,
      correlation: { icpCorrelation: CORRELATION },
    })).rejects.toMatchObject({
      code: 'icp_conversation_cost_blocked',
      event: { reason: 'missing_cost_metadata' },
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('fails closed before accounting when model pricing is missing', async () => {
    const reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>();
    const onDecision = vi.fn();
    const breaker = new IcpConversationCostBreaker(
      makeConfig({ includeRates: false }),
      accountingPort(reserve),
      onDecision,
    );

    await expect(breaker.reservePhysicalAttempt({
      candidate: CANDIDATE,
      purpose: 'chat',
      estimatedInputTokens: 1_000,
      logicalCallId: 'logical-1',
      attempt: 1,
      correlation: { icpCorrelation: CORRELATION },
    })).rejects.toMatchObject({
      code: 'icp_conversation_cost_blocked',
      event: { outcome: 'blocked', reason: 'missing_cost_metadata' },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'blocked',
      reason: 'missing_cost_metadata',
    }));
  });

  it('fails closed on canonical accounting unavailability and surfaces the cause', async () => {
    const cause = new Error('postgres unavailable');
    const reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>(async () => {
      throw cause;
    });
    const breaker = new IcpConversationCostBreaker(makeConfig(), accountingPort(reserve));

    await expect(breaker.reservePhysicalAttempt({
      candidate: CANDIDATE,
      purpose: 'chat',
      estimatedInputTokens: 1_000,
      logicalCallId: 'logical-1',
      attempt: 1,
      correlation: { icpCorrelation: CORRELATION },
    })).rejects.toSatisfy((error: unknown) => (
      error instanceof IcpConversationCostBreakerError
      && error.event.reason === 'accounting_unavailable'
      && error.cause === cause
    ));
  });

  it('is inert when the strict owner policy is disabled or the call is outside ICP', async () => {
    const reserve = vi.fn<IcpConversationCostAccountingPort['reserveIcpConversationCost']>();
    const breaker = new IcpConversationCostBreaker(
      makeConfig({ enabled: false }),
      accountingPort(reserve),
    );

    await expect(breaker.reservePhysicalAttempt({
      candidate: CANDIDATE,
      purpose: 'chat',
      estimatedInputTokens: 1_000,
      logicalCallId: 'logical-1',
      attempt: 1,
      correlation: { icpCorrelation: CORRELATION },
    })).resolves.toBeUndefined();
    await expect(new IcpConversationCostBreaker(makeConfig(), accountingPort(reserve))
      .reservePhysicalAttempt({
        candidate: CANDIDATE,
        purpose: 'chat',
        estimatedInputTokens: 1_000,
        logicalCallId: 'logical-2',
        attempt: 1,
      })).resolves.toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();
  });
});
