// ── Presence-windowed private-room fan-out (psfn-framework-s10rm) ──
// PRIVATE rooms deliver only to present companions whose window (`since`)
// opened no later than the message mint; PUBLIC rooms (default) never consult
// `since` and stay byte-identical to pre-privacy behavior.

import { describe, expect, it } from 'vitest';
import {
  COMPANION_ROOM_STALE_REPLY_GRACE_MS,
  GatewayCompanionChannelLane,
  type CompanionPresenceReadRow,
} from './companion-channels.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';

const NOW = Date.parse('2026-07-08T12:00:00Z');
const MINT = NOW - 500;
const FRESH = new Date(NOW - 1_000).toISOString();
const STALE = new Date(NOW - 60 * 60_000).toISOString();
const JOINED_BEFORE_MINT = new Date(MINT - 10_000).toISOString();
const JOINED_AFTER_MINT = new Date(MINT + 100).toISOString();

const PLACES: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'vhome', displayName: 'Virtual Home', kind: 'virtual' }],
  places: [
    {
      placeId: 'living_room',
      siteId: 'vhome',
      displayName: 'Living Room',
      kind: 'virtual',
      affordances: [],
    },
    {
      placeId: 'den',
      siteId: 'vhome',
      displayName: 'The Den',
      kind: 'virtual',
      privacy: 'private',
      affordances: [],
    },
  ],
};

function makeLane(
  rows: Record<string, CompanionPresenceReadRow[]>,
  now: () => number = () => NOW,
): GatewayCompanionChannelLane {
  return new GatewayCompanionChannelLane({
    placesRegistry: PLACES,
    presence: {
      listByPlace: async (siteId, placeId) => rows[`${siteId}/${placeId}`] ?? [],
    },
    fleetCompanionIds: new Set(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']),
    now,
  });
}

describe('private-room presence-windowed delivery (psfn-framework-s10rm)', () => {
  it('delivers only to occupants whose window opened before the message mint', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT }, // sender
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
        { companionId: '33333333-3333-4333-8333-333333333333', updatedAt: FRESH, since: JOINED_AFTER_MINT }, // join race
      ],
    });
    const resolution = await lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:den', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({
      ok: true,
      kind: 'room',
      recipients: ['22222222-2222-4222-8222-222222222222'],
      roomPrivacy: 'private',
      windowExcluded: ['33333333-3333-4333-8333-333333333333'],
    });
  });

  it('fails closed on a private-room row without a parseable since', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH }, // no since
        { companionId: '33333333-3333-4333-8333-333333333333', updatedAt: FRESH, since: 'not-a-date' },
      ],
    });
    const resolution = await lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:den', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({
      ok: true,
      recipients: [],
      windowExcluded: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
    });
  });

  it('still applies sender exclusion and staleness inside a private room', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT }, // sender
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: STALE, since: JOINED_BEFORE_MINT }, // stale: gone
        { companionId: '33333333-3333-4333-8333-333333333333', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
      ],
    });
    const resolution = await lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:den', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({ ok: true, recipients: ['33333333-3333-4333-8333-333333333333'], windowExcluded: [] });
  });

  it('uses now() as the cutoff when no mint timestamp is provided', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH, since: new Date(NOW - 1).toISOString() },
        { companionId: '33333333-3333-4333-8333-333333333333', updatedAt: FRESH, since: new Date(NOW + 1_000).toISOString() },
      ],
    });
    const resolution = await lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:den');
    expect(resolution).toMatchObject({ ok: true, recipients: ['22222222-2222-4222-8222-222222222222'], windowExcluded: ['33333333-3333-4333-8333-333333333333'] });
  });

  it('uses the supplied envelope timestamp as the single freshness clock', async () => {
    const lane = makeLane({
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
      ],
    }, () => NOW + 24 * 60 * 60_000);

    await expect(lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room', {
      messageTimestampMs: NOW,
    })).resolves.toMatchObject({
      ok: true,
      recipients: ['22222222-2222-4222-8222-222222222222'],
    });
  });

  it('public rooms (default privacy) ignore since entirely — byte-identical recipients', async () => {
    const rows: CompanionPresenceReadRow[] = [
      { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
      { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH, since: JOINED_AFTER_MINT }, // would be windowed out
      { companionId: '33333333-3333-4333-8333-333333333333', updatedAt: FRESH }, // no since at all
      { companionId: '44444444-4444-4444-8444-444444444444', updatedAt: STALE, since: JOINED_BEFORE_MINT }, // stale still excluded
    ];
    const lane = makeLane({ 'vhome/living_room': rows });
    const resolution = await lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({
      ok: true,
      kind: 'room',
      recipients: ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
      roomPrivacy: 'public',
    });
    expect('windowExcluded' in resolution && resolution.windowExcluded).toBeFalsy();
  });

  it('rejects a location-room send when the sender is absent or stale', async () => {
    const absent = makeLane({
      'vhome/living_room': [
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH },
      ],
    });
    const stale = makeLane({
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: STALE },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH },
      ],
    });

    await expect(absent.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room'))
      .resolves.toMatchObject({
        ok: false,
        violation: { event: 'companion_room_sender_not_present' },
      });
    await expect(stale.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room'))
      .resolves.toMatchObject({
        ok: false,
        violation: { event: 'companion_room_sender_not_present' },
      });
  });

  it('allows an absent sender only through a gateway-verified stale-reply carveout', async () => {
    let now = NOW;
    const presenceSince = JOINED_BEFORE_MINT;
    const rows = {
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: presenceSince },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH },
      ],
    };
    const lane = makeLane(rows, () => now);
    now += 15 * 60_000 + 1;
    rows['vhome/living_room'][1] = {
      companionId: '22222222-2222-4222-8222-222222222222',
      updatedAt: new Date(now).toISOString(),
    };

    await expect(lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room', {
      senderReplyPresenceEpoch: { since: presenceSince },
    })).resolves.toMatchObject({
      ok: true,
      recipients: ['22222222-2222-4222-8222-222222222222'],
    });
  });

  it('rejects a reply proof after explicit leave or when it belongs to another presence window', async () => {
    const proof = { since: JOINED_BEFORE_MINT };
    const leftRoom = makeLane({
      'vhome/living_room': [
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH },
      ],
    });
    const differentWindow = makeLane({
      'vhome/living_room': [
        {
          companionId: '11111111-1111-4111-8111-111111111111',
          updatedAt: STALE,
          since: new Date(Date.parse(JOINED_BEFORE_MINT) + 1).toISOString(),
        },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH },
      ],
    });

    await expect(leftRoom.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room', {
      senderReplyPresenceEpoch: proof,
    })).resolves.toMatchObject({
      ok: false,
      violation: { event: 'companion_room_sender_not_present' },
    });
    await expect(differentWindow.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room', {
      senderReplyPresenceEpoch: proof,
    })).resolves.toMatchObject({
      ok: false,
      violation: { event: 'companion_room_sender_not_present' },
    });
  });

  it('rejects a stale reply after the narrow presence-boundary grace', async () => {
    const staleAt = Date.parse(FRESH) + 15 * 60_000;
    const afterGrace = staleAt + COMPANION_ROOM_STALE_REPLY_GRACE_MS + 1;
    const lane = makeLane({
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: new Date(afterGrace).toISOString() },
      ],
    });

    await expect(lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room', {
      messageTimestampMs: afterGrace,
      senderReplyPresenceEpoch: { since: JOINED_BEFORE_MINT },
    })).resolves.toMatchObject({
      ok: false,
      violation: { event: 'companion_room_sender_not_present' },
    });
  });

  it('returns the exact accepted recipient presence rows for gateway reply receipts', async () => {
    const lane = makeLane({
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
      ],
    });

    await expect(lane.resolveDelivery('11111111-1111-4111-8111-111111111111', 'companion-room:living_room'))
      .resolves.toMatchObject({
        ok: true,
        recipientPresenceEpochs: {
          '22222222-2222-4222-8222-222222222222': { since: JOINED_BEFORE_MINT },
        },
      });
  });
});

describe('autonomous initiation room resolution', () => {
  it('requires both sender and selected peer to be current room members', async () => {
    const lane = makeLane({
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH },
      ],
    });
    await expect(lane.resolveInitiation(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'companion-room:living_room',
    )).resolves.toMatchObject({
      ok: true,
      kind: 'room',
      recipients: ['22222222-2222-4222-8222-222222222222'],
    });

    const senderAbsent = makeLane({
      'vhome/living_room': [{ companionId: '22222222-2222-4222-8222-222222222222', updatedAt: FRESH }],
    });
    await expect(senderAbsent.resolveInitiation(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'companion-room:living_room',
    )).resolves.toMatchObject({
      ok: false,
      violation: { event: 'companion_initiation_room_membership_mismatch' },
    });

    const peerStale = makeLane({
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-111111111111', updatedAt: FRESH },
        { companionId: '22222222-2222-4222-8222-222222222222', updatedAt: STALE },
      ],
    });
    await expect(peerStale.resolveInitiation(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'companion-room:living_room',
    )).resolves.toMatchObject({
      ok: false,
      violation: { event: 'companion_initiation_room_membership_mismatch' },
    });
  });
});
