import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresModelUsageStore } from './model-usage-store.js';
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type { ModelUsageEventInput } from '../../shared/telemetry/model-usage.js';

const TIMEOUT_MS = 120_000;
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const ROOT_INITIATION_ID = '99999999-9999-4999-8999-999999999999';
const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL_ID = `companion-dm:${COMPANION_A}:${COMPANION_B}`;
const POLICY = {
  enabled: true as const,
  warningThresholdUsd: 0.8,
  hardLimitUsd: 1,
  finalCloseoutReserveUsd: 0.2,
  pendingReservationStaleAfterMs: 60_000,
  includedCostPurposes: {
    conversation_turn: true,
    tool: true,
    summary: true,
    extraction: true,
    sidecar: true,
  },
};

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

function correlation(
  localCompanionId: string,
  options: Partial<Pick<IcpConversationCorrelation, 'costPurpose' | 'fatigueDecision'>> = {},
): IcpConversationCorrelation {
  const peerCompanionId = localCompanionId === COMPANION_A ? COMPANION_B : COMPANION_A;
  return {
    conversationId: CONVERSATION_ID,
    rootInitiationId: ROOT_INITIATION_ID,
    initiatedByCompanionId: COMPANION_A,
    localCompanionId,
    peerCompanionId,
    peerContactId: `contact-${peerCompanionId}`,
    channelId: CHANNEL_ID,
    turnId: localCompanionId === COMPANION_A
      ? '018f22a2-52b8-7a3a-8c16-25b7b14f7082'
      : '018f22a2-52b8-7a3a-8c16-25b7b14f7083',
    messageId: `message-${localCompanionId}`,
    requestId: `request-${localCompanionId}`,
    chargeLane: 'companion_social',
    surface: 'companion_dm',
    costPurpose: options.costPurpose ?? 'conversation_turn',
    costOriginStage: options.costPurpose && options.costPurpose !== 'conversation_turn'
      ? 'post_turn'
      : 'reply',
    fatigueDecision: options.fatigueDecision ?? 'allow',
  };
}

function usageEvent(input: {
  logicalCallId: string;
  companionId: string;
  costUsd?: number;
  costPurpose?: IcpConversationCorrelation['costPurpose'];
  shardId?: string;
}): ModelUsageEventInput {
  const icp = correlation(input.companionId, { costPurpose: input.costPurpose ?? 'conversation_turn' });
  return {
    logicalCallId: input.logicalCallId,
    attempt: 1,
    recordedAtMs: 1_752_500_000_100,
    startedAtMs: 1_752_500_000_000,
    completedAtMs: 1_752_500_000_100,
    status: 'success',
    settlement: input.costUsd === undefined ? 'unknown' : 'complete',
    callKind: 'chat',
    attribution: {
      companionId: input.companionId,
      sessionId: `session-${input.companionId}`,
      channelId: CHANNEL_ID,
      channelType: 'companion',
      callType: 'chat',
      purpose: 'chat',
      originType: 'chat',
      originStage: 'agent.turn.prompt',
      chargeLane: 'companion_social',
      conversationId: CONVERSATION_ID,
      rootInitiationId: ROOT_INITIATION_ID,
      ...(input.shardId ? { shardId: input.shardId } : {}),
    },
    provider: 'test-provider',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    ...(input.costUsd !== undefined
      ? {
          estimatedCost: { total: input.costUsd, currency: 'USD' },
          costSource: 'estimate' as const,
          currency: 'USD',
        }
      : { costSource: 'none' as const }),
    metadata: {
      icpCost: {
        purpose: icp.costPurpose,
        originStage: icp.costOriginStage,
        fatigueDecision: icp.fatigueDecision,
      },
    },
  };
}

async function createStores(): Promise<{
  pools: Pool[];
  fleetA: PostgresModelUsageStore;
  fleetB: PostgresModelUsageStore;
  writerA: PostgresModelUsageStore;
  writerB: PostgresModelUsageStore;
}> {
  if (!harness) throw new Error('Postgres test harness is unavailable');
  const { databaseUrl } = await harness.createDatabase();
  const pools = Array.from({ length: 4 }, (_, index) => createPostgresPool(databaseUrl, {
    applicationName: `icp-cost-breaker-${index}`,
    allowExitOnIdle: true,
    max: 2,
  }));
  return {
    pools,
    fleetA: new PostgresModelUsageStore(pools[0]!, { fleetAggregation: true }),
    fleetB: new PostgresModelUsageStore(pools[1]!, { fleetAggregation: true }),
    writerA: new PostgresModelUsageStore(pools[2]!, { companionId: COMPANION_A }),
    writerB: new PostgresModelUsageStore(pools[3]!, { companionId: COMPANION_B }),
  };
}

describe('canonical ICP conversation cost breaker', () => {
  it('serializes projected reservations across processes and both companions', async () => {
    const stores = await createStores();
    try {
      const [first, second] = await Promise.all([
        stores.fleetA.reserveIcpConversationCost({
          logicalCallId: 'race-a', attempt: 1, projectedCostUsd: 0.55,
          correlation: correlation(COMPANION_A), policy: POLICY, requestedAtMs: 1_752_500_000_000,
        }),
        stores.fleetB.reserveIcpConversationCost({
          logicalCallId: 'race-b', attempt: 1, projectedCostUsd: 0.55,
          correlation: correlation(COMPANION_B), policy: POLICY, requestedAtMs: 1_752_500_000_000,
        }),
      ]);

      expect([first.allowed, second.allowed].sort()).toEqual([false, true]);
      expect([first.reason, second.reason]).toContain('hard_limit_exceeded');
      const projection = await stores.fleetA.getIcpConversationCostProjection({
        conversationId: CONVERSATION_ID,
        rootInitiationId: ROOT_INITIATION_ID,
        policy: POLICY,
        nowMs: 1_752_500_000_100,
      });
      expect(projection).toMatchObject({
        actualCostUsd: 0,
        pendingProjectedCostUsd: 0.55,
        projectedTotalCostUsd: 0.55,
        pendingReservationCount: 1,
        attributedCompanionCount: 1,
      });
    } finally {
      await Promise.all(stores.pools.map(pool => pool.end()));
    }
  }, TIMEOUT_MS);

  it('settles reservations against immutable actual usage without double counting', async () => {
    const stores = await createStores();
    try {
      await stores.fleetA.reserveIcpConversationCost({
        logicalCallId: 'actual-a', attempt: 1, projectedCostUsd: 0.4,
        correlation: correlation(COMPANION_A), policy: POLICY, requestedAtMs: 1_752_500_000_000,
      });
      await stores.writerA.recordUsageEvent(usageEvent({
        logicalCallId: 'actual-a', companionId: COMPANION_A, costUsd: 0.25,
      }));
      const second = await stores.fleetB.reserveIcpConversationCost({
        logicalCallId: 'actual-b', attempt: 1, projectedCostUsd: 0.4,
        correlation: correlation(COMPANION_B), policy: POLICY, requestedAtMs: 1_752_500_000_200,
      });
      expect(second.allowed).toBe(true);

      const projection = await stores.fleetA.getIcpConversationCostProjection({
        conversationId: CONVERSATION_ID,
        rootInitiationId: ROOT_INITIATION_ID,
        policy: POLICY,
        nowMs: 1_752_500_000_300,
      });
      expect(projection).toMatchObject({
        actualCostUsd: 0.25,
        pendingProjectedCostUsd: 0.4,
        projectedTotalCostUsd: 0.65,
        settledReservationCount: 1,
        attributedCompanionCount: 2,
      });
    } finally {
      await Promise.all(stores.pools.map(pool => pool.end()));
    }
  }, TIMEOUT_MS);

  it('keeps unknown and stale reservations conservative across restart', async () => {
    const stores = await createStores();
    try {
      await stores.fleetA.reserveIcpConversationCost({
        logicalCallId: 'unknown-a', attempt: 1, projectedCostUsd: 0.1,
        correlation: correlation(COMPANION_A, { costPurpose: 'summary' }),
        policy: POLICY,
        requestedAtMs: 1_752_500_000_000,
      });
      await stores.writerA.recordUsageEvent(usageEvent({
        logicalCallId: 'unknown-a', companionId: COMPANION_A, costPurpose: 'summary',
      }));

      const blocked = await stores.fleetB.reserveIcpConversationCost({
        logicalCallId: 'after-unknown', attempt: 1, projectedCostUsd: 0.01,
        correlation: correlation(COMPANION_B), policy: POLICY, requestedAtMs: 1_752_500_120_000,
      });
      expect(blocked).toMatchObject({ allowed: false, reason: 'unknown_historical_cost' });
      expect(blocked.projection).toMatchObject({
        unknownCostAttemptCount: 1,
        pendingProjectedCostUsd: 0.1,
        staleReservationCount: 1,
        enforcementState: 'unknown_cost',
      });
    } finally {
      await Promise.all(stores.pools.map(pool => pool.end()));
    }
  }, TIMEOUT_MS);

  it('reserves the warning band only for fatigue-authorized closeout and never bypasses hard', async () => {
    const stores = await createStores();
    try {
      await stores.fleetA.reserveIcpConversationCost({
        logicalCallId: 'warning-base', attempt: 1, projectedCostUsd: 0.75,
        correlation: correlation(COMPANION_A), policy: POLICY, requestedAtMs: 1_752_500_000_000,
      });
      const ordinary = await stores.fleetA.reserveIcpConversationCost({
        logicalCallId: 'important-ordinary', attempt: 1, projectedCostUsd: 0.1,
        correlation: correlation(COMPANION_A), policy: POLICY, requestedAtMs: 1_752_500_000_010,
      });
      expect(ordinary).toMatchObject({ allowed: false, reason: 'warning_closeout_reserve_only' });

      const closeout = await stores.fleetB.reserveIcpConversationCost({
        logicalCallId: 'closeout', attempt: 1, projectedCostUsd: 0.15,
        correlation: correlation(COMPANION_B, { fatigueDecision: 'allow_overcharge' }),
        policy: POLICY,
        requestedAtMs: 1_752_500_000_020,
      });
      expect(closeout).toMatchObject({ allowed: true, reason: 'final_closeout_reserve' });

      const beyondHard = await stores.fleetB.reserveIcpConversationCost({
        logicalCallId: 'closeout-too-large', attempt: 1, projectedCostUsd: 0.11,
        correlation: correlation(COMPANION_B, { fatigueDecision: 'allow_overcharge' }),
        policy: POLICY,
        requestedAtMs: 1_752_500_000_030,
      });
      expect(beyondHard).toMatchObject({ allowed: false, reason: 'hard_limit_exceeded' });
    } finally {
      await Promise.all(stores.pools.map(pool => pool.end()));
    }
  }, TIMEOUT_MS);

  it('does not consume ICP scope for human, shard, subagent, or global budget rows', async () => {
    const stores = await createStores();
    try {
      await stores.writerA.recordUsageEvent({
        ...usageEvent({ logicalCallId: 'human-row', companionId: COMPANION_A, costUsd: 9 }),
        metadata: {},
      });
      await stores.writerA.recordUsageEvent(usageEvent({
        logicalCallId: 'shard-row', companionId: COMPANION_A, costUsd: 7, shardId: 'shard-1',
      }));
      const projection = await stores.fleetA.getIcpConversationCostProjection({
        conversationId: CONVERSATION_ID,
        rootInitiationId: ROOT_INITIATION_ID,
        policy: POLICY,
        nowMs: 1_752_500_000_200,
      });
      expect(projection).toMatchObject({
        actualCostUsd: 0,
        projectedTotalCostUsd: 0,
        attributedCompanionCount: 0,
      });
      const global = await stores.fleetA.getModelBudgetSpend(1_752_500_000_200, {
        companionId: COMPANION_A,
      });
      expect(global.dailyEstimatedCostUsd).toBe(16);
      await expect(stores.writerA.getIcpConversationCostProjection({
        conversationId: CONVERSATION_ID,
        rootInitiationId: ROOT_INITIATION_ID,
        policy: POLICY,
        nowMs: 1_752_500_000_200,
      })).rejects.toThrow(/fleet/i);
    } finally {
      await Promise.all(stores.pools.map(pool => pool.end()));
    }
  }, TIMEOUT_MS);
});
