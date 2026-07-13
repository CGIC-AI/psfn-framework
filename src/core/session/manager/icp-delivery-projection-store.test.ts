import { describe, expect, it, vi } from 'vitest';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';
import { createIcpDeliveryProjectionStore } from './icp-delivery-projection-store.js';

const LOCAL_COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const PEER_COMPANION_ID = '22222222-2222-4222-8222-222222222222';

function buildRecoveryResponse(channelId: string, sourceMessageId: string) {
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

describe('ICP delivery projection store', () => {
  it('projects a delivered assistant entry when its observation is over 5,000 rows behind the tail', () => {
    const channelId = 'companion-dm:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
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
    const channelId = 'companion-dm:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
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
