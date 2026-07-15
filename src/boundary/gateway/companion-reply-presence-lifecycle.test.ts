import { describe, expect, it } from 'vitest';
import { CompanionPresenceRuntime } from '../../core/agent/companion-presence-runtime.js';
import {
  DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS,
  type CompanionPresenceRecord,
  type CompanionPresenceStorePort,
  type CompanionPresenceUpsertInput,
} from '../../core/agent/companion-presence-store-port.js';
import { EventBus } from '../../shared/event-bus.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import { GatewayCompanionChannelLane } from './companion-channels.js';
import { CompanionDeliveryFailureReceipts } from './companion-delivery-failures.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const START = Date.parse('2026-07-13T12:00:00.000Z');
const PLACE = { siteId: 'vhome', placeId: 'living_room', kind: 'virtual' } as const;

const PLACES: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'vhome', displayName: 'Virtual Home', kind: 'virtual' }],
  places: [{
    placeId: 'living_room',
    siteId: 'vhome',
    displayName: 'Living Room',
    kind: 'virtual',
    affordances: [],
  }],
};

class LifecyclePresenceStore implements CompanionPresenceStorePort {
  readonly rows = new Map<string, CompanionPresenceRecord>();

  constructor(private readonly now: () => number) {}

  async upsertPresence(input: CompanionPresenceUpsertInput): Promise<CompanionPresenceRecord> {
    const now = this.now();
    const previous = this.rows.get(input.companionId);
    const continuesPresenceEpoch = previous !== undefined
      && previous.siteId === input.siteId
      && previous.placeId === input.placeId
      && Date.parse(previous.updatedAt) >= now - DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS;
    const record: CompanionPresenceRecord = {
      ...input,
      since: continuesPresenceEpoch ? previous.since : new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    this.rows.set(input.companionId, record);
    return record;
  }

  async listByPlace(siteId: string, placeId: string): Promise<CompanionPresenceRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.siteId === siteId && row.placeId === placeId);
  }

  async listAll(): Promise<CompanionPresenceRecord[]> {
    return [...this.rows.values()];
  }

  async deletePresence(companionId: string): Promise<boolean> {
    return this.rows.delete(companionId);
  }

  async close(): Promise<void> {}
}

describe('gateway reply authorization across the real presence lifecycle', () => {
  it('uses the stable presence epoch when a pre-generation heartbeat changed updatedAt', async () => {
    let now = START;
    const store = new LifecyclePresenceStore(() => now);
    const eventBus = new EventBus();
    const runtimeA = new CompanionPresenceRuntime({
      store,
      companionId: COMPANION_A,
      eventBus,
      placesRegistry: PLACES,
      now: () => new Date(now),
    });
    const runtimeB = new CompanionPresenceRuntime({
      store,
      companionId: COMPANION_B,
      eventBus,
      placesRegistry: PLACES,
      now: () => new Date(now),
    });
    const lane = new GatewayCompanionChannelLane({
      placesRegistry: PLACES,
      presence: store,
      fleetCompanionIds: new Set([COMPANION_A, COMPANION_B]),
      now: () => now,
    });
    const receipts = new CompanionDeliveryFailureReceipts();

    await runtimeA.recordDeliberateMove(PLACE);
    await runtimeB.recordDeliberateMove(PLACE);
    const opening = await lane.resolveDelivery(
      COMPANION_A,
      'companion-room:living_room',
      { messageTimestampMs: now },
    );
    expect(opening).toMatchObject({ ok: true, recipients: [COMPANION_B] });
    if (!opening.ok || opening.kind !== 'room') throw new Error('room opening did not resolve');
    const deliveredPresenceEpoch = opening.recipientPresenceEpochs[COMPANION_B];
    expect(deliveredPresenceEpoch).toEqual({ since: new Date(START).toISOString() });
    receipts.record({
      channelId: opening.channelId,
      messageId: 'companion-opening',
      senderCompanionId: COMPANION_A,
      recipientCompanionId: COMPANION_B,
      deliveredAt: now,
      roomPresenceEpoch: deliveredPresenceEpoch,
    });

    // A pre-generation heartbeat advances the mutable freshness beat while
    // preserving the uninterrupted presence epoch captured by the receipt.
    now += 5 * 60_000;
    await runtimeB.refreshOwnPresence();
    expect(store.rows.get(COMPANION_B)).toMatchObject({
      since: new Date(START).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    // Generation crosses staleness by one millisecond. Keep A fresh so the
    // reply has a live recipient; B's receipt must authorize only this epoch.
    now += DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS + 1;
    await runtimeA.refreshOwnPresence();
    const replyReceipt = receipts.claimReply(
      COMPANION_B,
      opening.channelId,
      'companion-opening',
      now,
    );
    expect(replyReceipt?.roomPresenceEpoch).toEqual(deliveredPresenceEpoch);
    if (!replyReceipt?.roomPresenceEpoch) throw new Error('room reply receipt was not claimed');

    await expect(lane.resolveDelivery(
      COMPANION_B,
      opening.channelId,
      {
        messageTimestampMs: now,
        senderReplyPresenceEpoch: replyReceipt.roomPresenceEpoch,
      },
    )).resolves.toMatchObject({ ok: true, recipients: [COMPANION_A] });
  });
});
