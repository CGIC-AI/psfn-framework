// ── Presence-windowed private-room fan-out (psfn-framework-s10rm) ──
// PRIVATE rooms deliver only to present companions whose window (`since`)
// opened no later than the message mint; PUBLIC rooms (default) never consult
// `since` and stay byte-identical to pre-privacy behavior.

import { describe, expect, it } from 'vitest';
import {
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

function makeLane(rows: Record<string, CompanionPresenceReadRow[]>): GatewayCompanionChannelLane {
  return new GatewayCompanionChannelLane({
    placesRegistry: PLACES,
    presence: {
      listByPlace: async (siteId, placeId) => rows[`${siteId}/${placeId}`] ?? [],
    },
    fleetCompanionIds: new Set(['comp-a', 'comp-b', 'comp-c']),
    now: () => NOW,
  });
}

describe('private-room presence-windowed delivery (psfn-framework-s10rm)', () => {
  it('delivers only to occupants whose window opened before the message mint', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: 'comp-a', updatedAt: FRESH, since: JOINED_BEFORE_MINT }, // sender
        { companionId: 'comp-b', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
        { companionId: 'comp-c', updatedAt: FRESH, since: JOINED_AFTER_MINT }, // join race
      ],
    });
    const resolution = await lane.resolveDelivery('comp-a', 'companion-room:den', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({
      ok: true,
      kind: 'room',
      recipients: ['comp-b'],
      roomPrivacy: 'private',
      windowExcluded: ['comp-c'],
    });
  });

  it('fails closed on a private-room row without a parseable since', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: 'comp-b', updatedAt: FRESH }, // no since
        { companionId: 'comp-c', updatedAt: FRESH, since: 'not-a-date' },
      ],
    });
    const resolution = await lane.resolveDelivery('comp-a', 'companion-room:den', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({
      ok: true,
      recipients: [],
      windowExcluded: ['comp-b', 'comp-c'],
    });
  });

  it('still applies sender exclusion and staleness inside a private room', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: 'comp-a', updatedAt: FRESH, since: JOINED_BEFORE_MINT }, // sender
        { companionId: 'comp-b', updatedAt: STALE, since: JOINED_BEFORE_MINT }, // stale: gone
        { companionId: 'comp-c', updatedAt: FRESH, since: JOINED_BEFORE_MINT },
      ],
    });
    const resolution = await lane.resolveDelivery('comp-a', 'companion-room:den', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({ ok: true, recipients: ['comp-c'], windowExcluded: [] });
  });

  it('uses now() as the cutoff when no mint timestamp is provided', async () => {
    const lane = makeLane({
      'vhome/den': [
        { companionId: 'comp-b', updatedAt: FRESH, since: new Date(NOW - 1).toISOString() },
        { companionId: 'comp-c', updatedAt: FRESH, since: new Date(NOW + 1_000).toISOString() },
      ],
    });
    const resolution = await lane.resolveDelivery('comp-a', 'companion-room:den');
    expect(resolution).toMatchObject({ ok: true, recipients: ['comp-b'], windowExcluded: ['comp-c'] });
  });

  it('public rooms (default privacy) ignore since entirely — byte-identical recipients', async () => {
    const rows: CompanionPresenceReadRow[] = [
      { companionId: 'comp-b', updatedAt: FRESH, since: JOINED_AFTER_MINT }, // would be windowed out
      { companionId: 'comp-c', updatedAt: FRESH }, // no since at all
      { companionId: 'comp-d', updatedAt: STALE, since: JOINED_BEFORE_MINT }, // stale still excluded
    ];
    const lane = makeLane({ 'vhome/living_room': rows });
    const resolution = await lane.resolveDelivery('comp-a', 'companion-room:living_room', {
      messageTimestampMs: MINT,
    });
    expect(resolution).toMatchObject({
      ok: true,
      kind: 'room',
      recipients: ['comp-b', 'comp-c'],
      roomPrivacy: 'public',
    });
    expect('windowExcluded' in resolution && resolution.windowExcluded).toBeFalsy();
  });
});
