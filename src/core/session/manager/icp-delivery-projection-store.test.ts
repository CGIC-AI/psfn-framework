import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';
import {
  CHANNEL as FATIGUE_CHANNEL,
  SOURCE as FATIGUE_SOURCE,
  correlation as fatigueCorrelation,
  fatigueBudget,
  fatigueMetadata,
  recoveryResponse as fatigueRecoveryResponse,
} from '../icp-recovery.test-fixtures.js';
import { createIcpDeliveryProjectionStore } from './icp-delivery-projection-store.js';

const LOCAL_COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER_COMPANION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildRecoveryResponse(
  channelId: string,
  sourceMessageId: string,
) {
  const correlation = {
    conversationId: '44444444-4444-4444-8444-444444444444',
    rootInitiationId: '99999999-9999-4999-8999-999999999999',
    initiatedByCompanionId: LOCAL_COMPANION_ID,
    localCompanionId: LOCAL_COMPANION_ID,
    peerCompanionId: PEER_COMPANION_ID,
    peerContactId: 'contact-nova',
    channelId,
    turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
    messageId: sourceMessageId,
    requestId: sourceMessageId,
    chargeLane: 'companion_social' as const,
    surface: 'companion_dm' as const,
    costPurpose: 'conversation_turn' as const,
    costOriginStage: 'reply' as const,
    fatigueDecision: 'not_evaluated' as const,
  };
  return {
    content: 'Completed reply',
    channelId,
    metadata: {
      model: 'projection-test-model',
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      turnId: correlation.turnId,
      requestId: correlation.requestId,
      icpCorrelation: correlation,
    },
  };
}

function buildSuppressedRecoveryResponse() {
  return {
    ...fatigueRecoveryResponse,
    content: '',
    metadata: {
      ...fatigueRecoveryResponse.metadata,
      icpCorrelation: { ...fatigueCorrelation, fatigueDecision: 'suppress' as const },
      fatigue: {
        ...fatigueMetadata,
        decision: 'suppressed_hard_exhausted' as const,
        modelDisposition: 'suppressed' as const,
        shouldRecordSpend: false,
        policyState: 'hard_exhausted' as const,
        policyBaseState: 'hard_exhausted' as const,
        overchargeBlockedReasons: ['no_qualifying_overcharge_trigger'] as const,
        budget: {
          ...fatigueBudget,
          spentBefore: 8,
          remainingBefore: 0,
          spentAfterProjected: 9,
          remainingAfterProjected: 0,
          normalSpentBefore: 8,
          normalSpentAfterProjected: 9,
        },
        socialRegulation: {
          ...fatigueMetadata.socialRegulation,
          state: 'suppressed' as const,
          relationshipPressure: 8,
          rootNormalSpent: 8,
          contributingEventCount: 8,
        },
      },
    },
  };
}

describe('ICP delivery projection store', () => {
  it.each([
    ['pending', null, [1, 3, 4]],
    ['failed', 'failed', [1, 3, 4, 5]],
    ['suppressed', 'suppressed', [1, 3, 4, 5]],
    ['delivered', 'delivered', [2, 3, 4, 5]],
  ] as const)(
    'projects getEntriesBefore through %s delivery state without changing its bounded order',
    (_label, status, expectedIds) => {
      const channelId = FATIGUE_CHANNEL;
      const sourceMessageId = FATIGUE_SOURCE;
      const entries: SessionEntry[] = [{
        id: 1,
        channelId,
        role: 'user',
        content: 'ordinary older context',
        timestamp: 1,
      }, {
        id: 2,
        channelId,
        role: 'assistant',
        content: 'sender output gated by delivery',
        timestamp: 2,
        metadata: JSON.stringify({
          icpDelivery: { schemaVersion: 1, status: 'pending' },
          turn: { sourceMessageId },
        }),
      }, {
        id: 3,
        channelId,
        role: 'user',
        content: 'successful turn B input',
        timestamp: 3,
      }, {
        id: 4,
        channelId,
        role: 'assistant',
        content: 'successful turn B output',
        timestamp: 4,
      }];
      if (status !== null) {
        entries.push({
          id: 5,
          channelId,
          role: 'system',
          content: JSON.stringify({
            schemaVersion: 1,
            kind: 'icp_delivery',
            channelId,
            sourceMessageId,
            status,
            ...(status === 'delivered'
              ? { gatewayMessageId: `gateway-${sourceMessageId}` }
              : {}),
            ...(status === 'failed' ? { error: 'peer unavailable' } : {}),
            recoveryResponse: status === 'suppressed'
              ? buildSuppressedRecoveryResponse()
              : fatigueRecoveryResponse,
          }),
          timestamp: 5,
        });
      }
      const getEntriesBefore = vi.fn(
        (_requestedChannelId: string, beforeId: number, limit: number) => {
          const eligible = entries.filter(entry => entry.id < beforeId);
          return eligible.length <= limit ? eligible : eligible.slice(-limit);
        },
      );
      const rawStore = {
        getEntriesBefore,
        findLatestEntries: (
          _requestedChannelId: string,
          predicate: (entry: SessionEntry) => boolean,
          limit: number,
        ) => entries.filter(predicate).slice(-limit).reverse(),
      } as SessionStore;

      const requestedLimit = status === null ? 3 : 4;
      const projected = createIcpDeliveryProjectionStore(rawStore)
        .getEntriesBefore(channelId, 99, requestedLimit);

      expect(projected.map(entry => entry.id)).toEqual(expectedIds);
      expect(getEntriesBefore).toHaveBeenCalledWith(channelId, 99, expect.any(Number));
    },
  );

  it('projects a delivered assistant entry when its observation is over 5,000 rows behind the tail', () => {
    const channelId = 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sourceMessageId = 'companion-source-1';
    const entries: SessionEntry[] = [{
      id: 1,
      channelId,
      role: 'assistant',
      content: 'Durably delivered reply',
      timestamp: 1,
      metadata: JSON.stringify({
        icpDelivery: { schemaVersion: 1, status: 'pending' },
        turn: { sourceMessageId },
      }),
    }, {
      id: 2,
      channelId,
      role: 'system',
      content: JSON.stringify({
        schemaVersion: 1,
        kind: 'icp_delivery',
        channelId,
        sourceMessageId,
        status: 'delivered',
        gatewayMessageId: 'companion:stable-delivery-1',
        recoveryResponse: buildRecoveryResponse(channelId, sourceMessageId),
      }),
      timestamp: 2,
    }];
    for (let index = 0; index < 5_001; index += 1) {
      entries.push({
        id: index + 3,
        channelId,
        role: 'system',
        content: `ordinary row ${index}`,
        timestamp: index + 3,
      });
    }
    const getEntriesInRange = vi.fn(
      (_requestedChannelId: string, startId: number, endId: number) => (
        entries.filter(entry => entry.id >= startId && entry.id <= endId)
      ),
    );
    const rawStore = {
      getRecent: (_requestedChannelId: string, limit: number) => entries.slice(-limit),
      getLastEntry: () => entries.at(-1),
      getEntriesInRange,
      findLatestEntries: (
        _requestedChannelId: string,
        predicate: (entry: SessionEntry) => boolean,
        limit: number,
      ) => entries.filter(predicate).slice(-limit).reverse(),
    } as SessionStore;
    const projectedStore = createIcpDeliveryProjectionStore(rawStore);

    expect(projectedStore.getEntriesInRange(channelId, 1, 1)).toEqual([
      expect.objectContaining({
        id: 1,
        content: 'Durably delivered reply',
      }),
    ]);
    expect(projectedStore.getRecent(channelId, 6_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 1,
        content: 'Durably delivered reply',
      }),
    ]));
    expect(getEntriesInRange.mock.calls).toContainEqual([channelId, 1, 1]);
    expect(getEntriesInRange.mock.calls.every(([, startId, endId]) => (
      Number(endId) - Number(startId) + 1 <= 256
    ))).toBe(true);
  });

  it('treats a delivered observation with turn completion as delivered', () => {
    const channelId = 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sourceMessageId = 'companion-source-completed';
    const entries: SessionEntry[] = [{
      id: 1,
      channelId,
      role: 'assistant',
      content: 'Completed reply',
      timestamp: 1,
      metadata: JSON.stringify({
        icpDelivery: { schemaVersion: 1, status: 'pending' },
        turn: { sourceMessageId },
      }),
    }, {
      id: 2,
      channelId,
      role: 'system',
      content: JSON.stringify({
        schemaVersion: 1,
        kind: 'icp_delivery',
        channelId,
        sourceMessageId,
        status: 'delivered',
        gatewayMessageId: 'companion:stable-delivery-completed',
        recoveryResponse: buildRecoveryResponse(channelId, sourceMessageId),
        turnCompleted: true,
      }),
      timestamp: 2,
    }];
    const rawStore = {
      getRecent: (_requestedChannelId: string, limit: number) => entries.slice(-limit),
      getLastEntry: () => entries.at(-1),
      getEntriesInRange: (_requestedChannelId: string, startId: number, endId: number) => (
        entries.filter(entry => entry.id >= startId && entry.id <= endId)
      ),
      findLatestEntries: (
        _requestedChannelId: string,
        predicate: (entry: SessionEntry) => boolean,
        limit: number,
      ) => entries.filter(predicate).slice(-limit).reverse(),
    } as SessionStore;

    expect(createIcpDeliveryProjectionStore(rawStore).getRecent(channelId, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, content: 'Completed reply' }),
    ]));
  });
});
