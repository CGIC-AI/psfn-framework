import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import type { SatelliteRegistryConfig } from '../../../shared/contracts/satellite-registry.js';
import type { IdentityClaimPerceptionEvent, PresencePerceptionEvent } from './sensor-cognition-bridge.js';
import type { AnonymousResolvedPresence } from './identity-claim-resolver.js';
import { createSharedSatellitePresenceSink } from './presence-follow.js';

const PRIMARY = createCompanionId('11111111-1111-4111-8111-111111111111');
const PRODUCTIVITY = createCompanionId('22222222-2222-4222-8222-222222222222');
const OUTSIDER = createCompanionId('33333333-3333-4333-8333-333333333333');

const registry: SatelliteRegistryConfig = {
  schemaVersion: 1,
  enabled: true,
  productivityCompanionId: PRODUCTIVITY,
  satellites: [{
    satelliteId: 'sat-kitchen',
    displayName: 'Kitchen',
    mobility: 'static',
    placeId: 'place.kitchen',
    sharedDevice: {
      primaryCompanionId: PRIMARY,
      observationRecipients: [
        { companionId: PRIMARY, scopes: ['presence'] },
        { companionId: PRODUCTIVITY, scopes: ['presence', 'location'] },
      ],
      emanationMemberIds: [PRIMARY],
      responseLease: { durationMs: 5_000, activeConversationTtlMs: 60_000 },
    },
    endpoints: [],
  }],
};

function identityEvent(): IdentityClaimPerceptionEvent {
  return {
    kind: 'identity_claim',
    action: 'observed',
    eventId: 'event-identity',
    rawEventType: 'external.telemetry.status',
    source: 'sat-kitchen',
    occurredAt: '2026-07-19T12:00:00.000Z',
    receivedAt: '2026-07-19T12:00:01.000Z',
    scope: 'face',
    satelliteId: 'sat-kitchen',
    siteId: 'site.home',
    placeId: 'place.kitchen',
    placeDisplayName: 'Kitchen',
    channelId: 'satellite:kitchen',
    hubIdentityId: 'opaque-hub-handle',
    confidence: 0.9,
    claimSource: 'face',
  };
}

function presenceEvent(): PresencePerceptionEvent {
  return {
    kind: 'presence',
    action: 'detected',
    eventId: 'event-presence',
    rawEventType: 'external.telemetry.status',
    source: 'sat-kitchen',
    occurredAt: '2026-07-19T12:00:00.000Z',
    receivedAt: '2026-07-19T12:00:01.000Z',
    scope: 'presence',
    satelliteId: 'sat-kitchen',
    siteId: 'site.home',
    placeId: 'place.kitchen',
    placeDisplayName: 'Kitchen',
    channelId: 'satellite:kitchen',
  };
}

function makeHarness(companionId: typeof PRIMARY | typeof PRODUCTIVITY | typeof OUTSIDER) {
  const handleResolvedPresence = vi.fn();
  const handlePerceptionEvent = vi.fn();
  const sink = createSharedSatellitePresenceSink({
    inner: { handleResolvedPresence, handlePerceptionEvent },
    companionId,
    satelliteRegistry: registry,
  });
  return { sink, handleResolvedPresence, handlePerceptionEvent };
}

describe('shared satellite presence observation boundary', () => {
  it('delivers minimum identity-derived presence to an exact observation recipient', async () => {
    const harness = makeHarness(PRODUCTIVITY);
    const presence: AnonymousResolvedPresence = {
      kind: 'anonymous',
      reason: 'unenrolled',
      event: identityEvent(),
      hubIdentityId: 'opaque-hub-handle',
      confidence: 0.9,
    };

    await harness.sink.handleResolvedPresence(presence);

    expect(harness.handleResolvedPresence).toHaveBeenCalledWith(presence);
  });

  it('drops shared-device observations for a non-recipient', async () => {
    const harness = makeHarness(OUTSIDER);

    await harness.sink.handlePerceptionEvent(presenceEvent());

    expect(harness.handlePerceptionEvent).not.toHaveBeenCalled();
  });

  it('does not expose any movement or world-control operation', () => {
    const harness = makeHarness(PRIMARY);
    expect(Object.keys(harness.sink).sort()).toEqual([
      'handlePerceptionEvent',
      'handleResolvedPresence',
    ]);
  });
});
