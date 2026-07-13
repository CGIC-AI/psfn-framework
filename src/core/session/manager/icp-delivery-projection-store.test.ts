import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';
import { createIcpDeliveryProjectionStore } from './icp-delivery-projection-store.js';

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
        sourceMessageId,
        status: 'delivered',
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
    const rawStore = {
      getRecent: (_requestedChannelId: string, limit: number) => entries.slice(-limit),
      getEntriesInRange: (_requestedChannelId: string, startId: number, endId: number) => (
        entries.filter(entry => entry.id >= startId && entry.id <= endId)
      ),
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
  });
});
