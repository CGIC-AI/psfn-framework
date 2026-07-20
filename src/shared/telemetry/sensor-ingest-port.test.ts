import { describe, expect, it } from 'vitest';
import { createCompanionId } from '../routing/companion-id.js';
import type { ExternalTelemetryEvent } from '../event-bus.js';
import type { SatelliteRegistryConfig } from '../contracts/satellite-registry.js';
import { resolveSharedSatelliteObservationDeliveries } from './sensor-ingest-port.js';

const PRIMARY = createCompanionId('11111111-1111-4111-8111-111111111111');
const PRODUCTIVITY = createCompanionId('22222222-2222-4222-8222-222222222222');

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
    endpoints: [{
      endpointId: 'sensor',
      displayName: 'Sensor',
      claimTypes: ['telemetry'],
      promptChannelType: 'api',
      auth: { mode: 'api_key', apiKeyPrincipalIds: ['satellite-key'] },
      defaultIdentity: {
        authorId: 'sensor',
        authorName: 'Sensor',
        canonicalContactId: 'contact-partner',
        channelPrivacy: 'private',
      },
      maxCapabilities: ['telemetry', 'presence'],
      telemetryScopes: ['presence', 'location'],
    }],
  }],
};

function event(overrides: Partial<ExternalTelemetryEvent> = {}): ExternalTelemetryEvent {
  return {
    id: 'event-1',
    source: 'sat-kitchen',
    eventType: 'external.telemetry.status',
    payload: {
      satelliteId: 'sat-kitchen',
      present: true,
      confidence: 0.9,
      unrelatedRoomHistory: 'must not cross',
    },
    occurredAt: '2026-07-19T12:00:00.000Z',
    receivedAt: '2026-07-19T12:00:01.000Z',
    nonce: 'nonce-12345678',
    scope: 'presence',
    auth: {
      principalId: 'satellite-key',
      principalMode: 'api_key',
      satelliteScoped: false,
    },
    ...overrides,
  };
}

describe('resolveSharedSatelliteObservationDeliveries', () => {
  it('fans out a normalized presence observation only to exact recipients', () => {
    const deliveries = resolveSharedSatelliteObservationDeliveries({
      event: event(),
      registry,
    });
    expect(deliveries?.map(delivery => delivery.companionId)).toEqual([
      PRIMARY,
      PRODUCTIVITY,
    ]);
    expect(deliveries?.[0]?.event.payload).toEqual({
      satelliteId: 'sat-kitchen',
      placeId: 'place.kitchen',
      present: true,
      confidence: 0.9,
    });
    expect(deliveries?.[0]?.event.channelId).toBe(
      'satellite-observation:sat-kitchen',
    );
  });

  it('strips caller-controlled session authority and normalizes location minimally', () => {
    const deliveries = resolveSharedSatelliteObservationDeliveries({
      event: event({
        channelId: 'discord:private-session',
        scope: 'location',
        payload: {
          satelliteId: 'sat-kitchen',
          placeId: 'spoofed-place',
          rawTrail: ['bedroom', 'office'],
        },
      }),
      registry,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries?.[0]).toMatchObject({
      companionId: PRODUCTIVITY,
      scope: 'location',
      event: {
        channelId: 'satellite-observation:sat-kitchen',
        scope: 'location',
        payload: {
          satelliteId: 'sat-kitchen',
          placeId: 'place.kitchen',
        },
      },
    });
  });

  it('fails closed when authenticated origin does not match the satellite', () => {
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event({
        auth: {
          principalId: 'wrong-key',
          principalMode: 'api_key',
          satelliteScoped: false,
        },
      }),
      registry,
    })).toEqual([]);
  });

  it('fails closed instead of generically routing an unknown physical origin', () => {
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event({
        source: 'sat-unknown',
        payload: { satelliteId: 'sat-unknown', present: true },
      }),
      registry,
    })).toEqual([]);
  });

  it('falls through when the registry is disabled or the satellite is not shared', () => {
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event(),
      registry: { ...registry, enabled: false },
    })).toBeNull();
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event(),
      registry: {
        ...registry,
        satellites: [{ ...registry.satellites[0], sharedDevice: undefined }],
      },
    })).toBeNull();
  });

  it.each(['health', 'battery'])('falls through for registered %s telemetry', (scope) => {
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event({ scope }),
      registry,
    })).toBeNull();
  });

  it('still fails closed for unauthenticated or non-admitted non-shared observations', () => {
    const nonSharedRegistry: SatelliteRegistryConfig = {
      ...registry,
      satellites: [{ ...registry.satellites[0], sharedDevice: undefined }],
    };
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event({ auth: undefined }),
      registry: nonSharedRegistry,
    })).toEqual([]);
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event(),
      registry: {
        ...nonSharedRegistry,
        satellites: [{
          ...nonSharedRegistry.satellites[0],
          endpoints: [{
            ...nonSharedRegistry.satellites[0].endpoints[0],
            telemetryScopes: ['location'],
          }],
        }],
      },
    })).toEqual([]);
  });

  it('requires the same authenticated endpoint to grant the normalized scope', () => {
    const splitAuthorityRegistry: SatelliteRegistryConfig = {
      ...registry,
      satellites: [{
        ...registry.satellites[0],
        endpoints: [
          {
            ...registry.satellites[0].endpoints[0],
            endpointId: 'presence-other-key',
            auth: { mode: 'api_key', apiKeyPrincipalIds: ['other-key'] },
            telemetryScopes: ['presence'],
          },
          {
            ...registry.satellites[0].endpoints[0],
            endpointId: 'location-sensor',
            telemetryScopes: ['location'],
          },
        ],
      }],
    };
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event(),
      registry: splitAuthorityRegistry,
    })).toEqual([]);
    expect(resolveSharedSatelliteObservationDeliveries({
      event: event({
        scope: 'face',
        payload: {
          satelliteId: 'sat-kitchen',
          claim: { hubIdentityId: 'opaque', confidence: 0.9 },
        },
      }),
      registry: splitAuthorityRegistry,
    })).toEqual([]);
  });

  it('does not treat an observation recipient as an Emanation Member', () => {
    expect(registry.satellites[0].sharedDevice?.observationRecipients).toContainEqual({
      companionId: PRODUCTIVITY,
      scopes: ['presence', 'location'],
    });
    expect(registry.satellites[0].sharedDevice?.emanationMemberIds).not.toContain(PRODUCTIVITY);
  });
});
