import { describe, expect, it, vi } from 'vitest';

import { EventBus } from '../../shared/event-bus.js';
import {
  createInMemoryWeightedThoughtBackend,
  createWeightedThoughtStorePort,
} from '../intention/weighted-thought-store-port.js';
import type { WeightedThoughtLifecycleConfig } from '../intention/weighted-thoughts.js';
import { registerIcpCoLocationThoughtAdapter } from './co-location-thought-adapter.js';

const CONFIG: WeightedThoughtLifecycleConfig = {
  classes: {
    time_sensitive: { baseWeight: 0.5, halflifeMs: 1_000 },
    standard: { baseWeight: 0.4, halflifeMs: 2_000 },
    trivial: { baseWeight: 0.2, halflifeMs: 3_000 },
  },
  reinforcement: { repeatBoost: 0.5, emotionalChargeWeight: 1 },
  accumulatedWeightCap: 3,
  contradictionDampeningFactor: 0.6,
  declineDampeningFactor: 0.5,
  relevanceFloor: 0.01,
};

describe('ICP co-location thought adapter', () => {
  it('records or reinforces only a low-weight thought and never has an LLM/send seam', async () => {
    const eventBus = new EventBus();
    const store = createWeightedThoughtStorePort(createInMemoryWeightedThoughtBackend());
    const contactStore = {
      getByChannelIdentity: vi.fn().mockResolvedValue({
        id: 'peer-contact',
        isMachineIntelligence: true,
      }),
    };
    registerIcpCoLocationThoughtAdapter({
      eventBus,
      localCompanionId: '11111111-1111-4111-8111-111111111111',
      contactStore: contactStore as never,
      thoughtStore: store,
      lifecycleConfig: CONFIG,
      now: () => 1_700_000_000_000,
    });

    const event = {
      companionId: '22222222-2222-4222-8222-222222222222',
      observerCompanionId: '11111111-1111-4111-8111-111111111111',
      siteId: 'home',
      placeId: 'kitchen',
      kind: 'private' as const,
      since: '2026-07-13T00:00:00.000Z',
      timestamp: 1_700_000_000_000,
    };
    await eventBus.emit('presence.companion.co_located', event);
    await eventBus.emit('presence.companion.co_located', event);

    const thoughts = await store.list();
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({
      source: 'icp_co_location',
      thoughtClass: 'trivial',
      contactId: 'peer-contact',
      reinforcementCount: 1,
      provenance: {
        sourceChannelId: 'companion-room:kitchen',
        sourceChannelType: 'companion',
      },
    });
    expect(thoughts[0]!.accumulatedWeight).toBeLessThan(CONFIG.classes.trivial.baseWeight);
  });

  it('does nothing when the peer lacks a canonical MI contact', async () => {
    const eventBus = new EventBus();
    const store = createWeightedThoughtStorePort(createInMemoryWeightedThoughtBackend());
    registerIcpCoLocationThoughtAdapter({
      eventBus,
      localCompanionId: '11111111-1111-4111-8111-111111111111',
      contactStore: { getByChannelIdentity: vi.fn().mockResolvedValue(undefined) } as never,
      thoughtStore: store,
      lifecycleConfig: CONFIG,
    });
    await eventBus.emit('presence.companion.co_located', {
      companionId: '22222222-2222-4222-8222-222222222222',
      observerCompanionId: '11111111-1111-4111-8111-111111111111',
      siteId: 'home',
      placeId: 'kitchen',
      kind: 'private',
      since: '2026-07-13T00:00:00.000Z',
      timestamp: 1,
    });
    expect(await store.list()).toEqual([]);
  });
});
