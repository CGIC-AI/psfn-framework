import { describe, expect, it, vi } from 'vitest';
import { EventBus, type ExternalTelemetryEvent } from '../../../shared/event-bus.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { SatelliteRegistryConfig } from '../../../shared/contracts/satellite-registry.js';
import {
  createSensorCognitionBridge,
  normalizeExternalTelemetryToPerceptionEvent,
  type PerceptionEvent,
} from './sensor-cognition-bridge.js';

const PLACES_REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'site.home', displayName: 'Home', kind: 'physical' }],
  places: [
    {
      placeId: 'place.living',
      siteId: 'site.home',
      displayName: 'Living Area',
      kind: 'physical',
      affordances: [
        {
          affordanceId: 'aff.presence',
          role: 'perceiver',
          kind: 'presence',
          backend: 'satellite',
        },
        {
          affordanceId: 'aff.face',
          role: 'perceiver',
          kind: 'face',
          backend: 'satellite',
        },
      ],
    },
  ],
};

const SATELLITE_REGISTRY: SatelliteRegistryConfig = {
  schemaVersion: 1,
  enabled: true,
  satellites: [
    {
      satelliteId: 'sat.living',
      displayName: 'Living Satellite',
      mobility: 'static',
      placeId: 'place.living',
      endpoints: [
        {
          endpointId: 'telemetry',
          displayName: 'Telemetry Endpoint',
          claimTypes: ['sensor-telemetry'],
          promptChannelType: 'telemetry_satellite',
          auth: { mode: 'api_key' },
          defaultIdentity: {
            authorId: 'home-sensor',
            authorName: 'Home Sensor',
            canonicalContactId: 'contact-home',
            channelPrivacy: 'invite_only',
          },
          maxCapabilities: ['telemetry', 'presence'],
          telemetryScopes: ['presence'],
        },
      ],
    },
  ],
};

function telemetryEvent(overrides: Partial<ExternalTelemetryEvent> = {}): ExternalTelemetryEvent {
  return {
    id: 'event-1',
    source: 'sensor.fixture',
    eventType: 'external.telemetry.status',
    payload: {
      satelliteId: 'sat.living',
      siteId: 'site.home',
      action: 'detected',
    },
    occurredAt: '2026-07-08T12:00:00.000Z',
    receivedAt: '2026-07-08T12:00:01.000Z',
    nonce: 'nonce-12345678',
    channelId: 'satellite:living:test-session',
    scope: 'presence',
    auth: {
      principalId: 'api-key-fixture-shared',
      principalMode: 'api_key',
      satelliteScoped: false,
    },
    ...overrides,
  };
}

function normalize(event: ExternalTelemetryEvent) {
  return normalizeExternalTelemetryToPerceptionEvent({
    event,
    satelliteRegistry: SATELLITE_REGISTRY,
    placesRegistry: PLACES_REGISTRY,
  });
}

describe('sensor cognition bridge normalization', () => {
  it('normalizes presence detected events with satellite-bound place context', () => {
    const result = normalize(telemetryEvent({
      payload: {
        satelliteId: 'sat.living',
        siteId: 'site.home',
        action: 'detected',
        confidence: 0.92,
        occupancyCount: 1,
        affordanceId: 'aff.presence',
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      event: {
        kind: 'presence',
        action: 'detected',
        satelliteId: 'sat.living',
        siteId: 'site.home',
        placeId: 'place.living',
        placeDisplayName: 'Living Area',
        confidence: 0.92,
        occupancyCount: 1,
        affordanceId: 'aff.presence',
      },
    });
  });

  it('normalizes presence cleared events from boolean present=false payloads', () => {
    const result = normalize(telemetryEvent({
      id: 'event-cleared',
      payload: {
        origin: { satelliteId: 'sat.living', siteId: 'site.home' },
        present: false,
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      event: {
        kind: 'presence',
        action: 'cleared',
        placeId: 'place.living',
      },
    });
  });

  it('normalizes identity-claim observed events without resolving contacts', () => {
    const result = normalize(telemetryEvent({
      id: 'event-claim',
      scope: 'face',
      payload: {
        origin: { satelliteId: 'sat.living', siteId: 'site.home' },
        type: 'identity-claim.observed',
        claim: {
          hubIdentityId: 'hub.identity.sample',
          confidence: 0.84,
        },
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      event: {
        kind: 'identity_claim',
        action: 'observed',
        satelliteId: 'sat.living',
        placeId: 'place.living',
        hubIdentityId: 'hub.identity.sample',
        confidence: 0.84,
        claimSource: 'face',
      },
    });
  });

  it('rejects raw biometric material on identity claims', () => {
    const result = normalize(telemetryEvent({
      id: 'event-raw-biometric',
      scope: 'face',
      payload: {
        satelliteId: 'sat.living',
        type: 'identity-claim.observed',
        claim: {
          hubIdentityId: 'hub.identity.sample',
          confidence: 0.8,
          faceEmbedding: [0.1, 0.2],
        },
      },
    }));

    expect(result).toEqual({
      ok: false,
      kind: 'malformed',
      reason: 'raw_biometric_payload_rejected',
      satelliteId: 'sat.living',
      placeId: 'place.living',
    });
  });

  it('fails closed via whitelist on non-biometric but non-whitelisted claim fields (04-M3)', () => {
    const result = normalize(telemetryEvent({
      id: 'event-extra-field',
      scope: 'face',
      payload: {
        satelliteId: 'sat.living',
        type: 'identity-claim.observed',
        claim: {
          hubIdentityId: 'hub.identity.sample',
          confidence: 0.8,
          // Not a denylisted biometric key, but not whitelisted either: a
          // denylist would have missed this; the whitelist fails closed.
          gaitSignature: 'abc',
        },
      },
    }));

    expect(result).toEqual({
      ok: false,
      kind: 'malformed',
      reason: 'raw_biometric_payload_rejected',
      satelliteId: 'sat.living',
      placeId: 'place.living',
    });
  });

  it('fails closed via whitelist on deeply nested non-whitelisted material (04-M3)', () => {
    const result = normalize(telemetryEvent({
      id: 'event-deep-nested',
      scope: 'face',
      payload: {
        satelliteId: 'sat.living',
        type: 'identity-claim.observed',
        claim: {
          hubIdentityId: 'hub.identity.sample',
          confidence: 0.8,
          // faceVector is not in the depth-4 legacy denylist key set; the
          // whitelist rejects it regardless of nesting.
          meta: { deep: { faceVector: [0.1, 0.2] } },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: 'malformed', reason: 'raw_biometric_payload_rejected' });
  });

  it('accepts a whitelisted identity claim carrying only hubIdentityId + confidence (04-M3)', () => {
    const result = normalize(telemetryEvent({
      id: 'event-clean-claim',
      scope: 'face',
      payload: {
        origin: { satelliteId: 'sat.living', siteId: 'site.home' },
        type: 'identity-claim.observed',
        claim: {
          hubIdentityId: 'hub.identity.sample',
          confidence: 0.77,
        },
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      event: {
        kind: 'identity_claim',
        hubIdentityId: 'hub.identity.sample',
        confidence: 0.77,
      },
    });
  });

  it('fails closed on site claims that conflict with the satellite place binding', () => {
    const result = normalize(telemetryEvent({
      payload: {
        satelliteId: 'sat.living',
        siteId: 'site.other',
        action: 'detected',
      },
    }));

    expect(result).toEqual({
      ok: false,
      kind: 'malformed',
      reason: 'claimed_site_does_not_match_bound_place',
      satelliteId: 'sat.living',
      placeId: 'place.living',
    });
  });
});

describe('sensor cognition bridge subscription', () => {
  it('invokes the sink and emits a delivered telemetry counter', async () => {
    const eventBus = new EventBus();
    const sink = { handlePerceptionEvent: vi.fn<(event: PerceptionEvent) => void>() };
    const logger = { warn: vi.fn() };
    const counters: unknown[] = [];
    eventBus.on('agent.perception.bridge.telemetry', event => counters.push(event));

    const bridge = createSensorCognitionBridge({
      eventBus,
      satelliteRegistry: SATELLITE_REGISTRY,
      placesRegistry: PLACES_REGISTRY,
      sink,
      logger,
      now: () => 123,
    });

    await eventBus.emit('external.telemetry.ingested', { event: telemetryEvent() });

    expect(bridge.active).toBe(true);
    expect(sink.handlePerceptionEvent).toHaveBeenCalledTimes(1);
    expect(sink.handlePerceptionEvent.mock.calls[0]?.[0]).toMatchObject({
      kind: 'presence',
      action: 'detected',
      placeId: 'place.living',
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(counters).toEqual([
      expect.objectContaining({
        counter: 'delivered',
        reason: 'perception_event_delivered',
        eventId: 'event-1',
        satelliteId: 'sat.living',
        placeId: 'place.living',
        perceptionKind: 'presence',
        timestamp: 123,
      }),
    ]);

    bridge.unsubscribe();
  });

  it('loud-drops malformed relevant telemetry without throwing the subscriber loop', async () => {
    const eventBus = new EventBus();
    const sink = { handlePerceptionEvent: vi.fn<(event: PerceptionEvent) => void>() };
    const logger = { warn: vi.fn() };
    const counters: unknown[] = [];
    eventBus.on('agent.perception.bridge.telemetry', event => counters.push(event));

    createSensorCognitionBridge({
      eventBus,
      satelliteRegistry: SATELLITE_REGISTRY,
      placesRegistry: PLACES_REGISTRY,
      sink,
      logger,
      now: () => 456,
    });

    await eventBus.emit('external.telemetry.ingested', {
      event: telemetryEvent({
        id: 'event-malformed',
        source: 'sensor.unmapped',
        payload: { action: 'detected' },
      }),
    });

    expect(sink.handlePerceptionEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Sensor cognition bridge dropped telemetry event',
      expect.objectContaining({
        reason: 'missing_satellite_origin',
        eventId: 'event-malformed',
        scope: 'presence',
      }),
    );
    expect(counters).toEqual([
      expect.objectContaining({
        counter: 'malformed',
        reason: 'missing_satellite_origin',
        eventId: 'event-malformed',
        timestamp: 456,
      }),
    ]);
  });

  it('ignores Garden-only observability telemetry scopes without invoking cognition', async () => {
    const eventBus = new EventBus();
    const sink = { handlePerceptionEvent: vi.fn<(event: PerceptionEvent) => void>() };
    const logger = { warn: vi.fn() };
    const counters: unknown[] = [];
    eventBus.on('agent.perception.bridge.telemetry', event => counters.push(event));

    createSensorCognitionBridge({
      eventBus,
      satelliteRegistry: SATELLITE_REGISTRY,
      placesRegistry: PLACES_REGISTRY,
      sink,
      logger,
    });

    await eventBus.emit('external.telemetry.ingested', {
      event: telemetryEvent({
        id: 'event-observability',
        scope: 'cluster-a',
        payload: { status: 'green' },
      }),
    });

    expect(sink.handlePerceptionEvent).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(counters).toEqual([]);
  });

  it('deduplicates repeated external telemetry events by normalized perception id', async () => {
    const eventBus = new EventBus();
    const sink = { handlePerceptionEvent: vi.fn<(event: PerceptionEvent) => void>() };
    const counters: unknown[] = [];
    eventBus.on('agent.perception.bridge.telemetry', event => counters.push(event));

    createSensorCognitionBridge({
      eventBus,
      satelliteRegistry: SATELLITE_REGISTRY,
      placesRegistry: PLACES_REGISTRY,
      sink,
      logger: { warn: vi.fn() },
    });

    const event = telemetryEvent({ id: 'event-duplicate' });
    await eventBus.emit('external.telemetry.ingested', { event });
    await eventBus.emit('external.telemetry.ingested', { event });

    expect(sink.handlePerceptionEvent).toHaveBeenCalledTimes(1);
    expect(counters).toEqual([
      expect.objectContaining({ counter: 'delivered', eventId: 'event-duplicate' }),
      expect.objectContaining({ counter: 'duplicate', eventId: 'event-duplicate' }),
    ]);
  });

  it('uses an explicit no-op sink by default', async () => {
    const eventBus = new EventBus();
    const counters: unknown[] = [];
    eventBus.on('agent.perception.bridge.telemetry', event => counters.push(event));

    createSensorCognitionBridge({
      eventBus,
      satelliteRegistry: SATELLITE_REGISTRY,
      placesRegistry: PLACES_REGISTRY,
      logger: { warn: vi.fn() },
    });

    await eventBus.emit('external.telemetry.ingested', { event: telemetryEvent({ id: 'event-noop' }) });

    expect(counters).toEqual([
      expect.objectContaining({ counter: 'delivered', eventId: 'event-noop' }),
    ]);
  });

  it('stays byte-identical no-op when registry config is absent or off', async () => {
    const eventBus = new EventBus();
    const sink = { handlePerceptionEvent: vi.fn<(event: PerceptionEvent) => void>() };
    const logger = { warn: vi.fn() };
    const counters: unknown[] = [];
    eventBus.on('agent.perception.bridge.telemetry', event => counters.push(event));

    const bridge = createSensorCognitionBridge({
      eventBus,
      satelliteRegistry: { ...SATELLITE_REGISTRY, enabled: false },
      placesRegistry: PLACES_REGISTRY,
      sink,
      logger,
    });

    await eventBus.emit('external.telemetry.ingested', { event: telemetryEvent() });
    await bridge.handleTelemetryEvent(telemetryEvent({ id: 'event-direct-noop' }));

    expect(bridge.active).toBe(false);
    expect(sink.handlePerceptionEvent).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(counters).toEqual([]);
  });
});

describe('authenticated satellite origin binding (Sprint-10 04-M1)', () => {
  it('fails closed when telemetry lacks an authenticated origin context', () => {
    const event = telemetryEvent();
    delete (event as Partial<ExternalTelemetryEvent>).auth;
    const result = normalize(event);
    expect(result).toEqual({
      ok: false,
      kind: 'malformed',
      reason: 'missing_authenticated_origin',
      satelliteId: 'sat.living',
    });
  });

  it('rejects a payload-forged satelliteId when the authenticated principal is not admitted by that satellite', () => {
    const result = normalize(telemetryEvent({
      auth: {
        principalId: 'api-key-of-a-different-satellite',
        principalMode: 'api_key',
        satelliteScoped: true,
      },
    }));
    expect(result).toEqual({
      ok: false,
      kind: 'malformed',
      reason: 'satellite_origin_not_authorized_for_principal',
      satelliteId: 'sat.living',
    });
  });

  it('rejects non-api-key principals claiming a satellite origin', () => {
    const result = normalize(telemetryEvent({
      auth: {
        principalId: 'local-insecure',
        principalMode: 'insecure_local',
        satelliteScoped: false,
      },
    }));
    expect(result).toMatchObject({
      ok: false,
      reason: 'satellite_origin_not_authorized_for_principal',
    });
  });

  it('admits a satellite-scoped principal explicitly bound to the claimed satellite', () => {
    const registry: SatelliteRegistryConfig = {
      ...SATELLITE_REGISTRY,
      satellites: [
        {
          ...SATELLITE_REGISTRY.satellites[0]!,
          endpoints: [
            {
              ...SATELLITE_REGISTRY.satellites[0]!.endpoints[0]!,
              auth: { mode: 'api_key', apiKeyPrincipalIds: ['api-key-sat-living'] },
            },
          ],
        },
      ],
    };
    const result = normalizeExternalTelemetryToPerceptionEvent({
      event: telemetryEvent({
        auth: {
          principalId: 'api-key-sat-living',
          principalMode: 'api_key',
          satelliteScoped: true,
        },
      }),
      satelliteRegistry: registry,
      placesRegistry: PLACES_REGISTRY,
    });
    expect(result).toMatchObject({ ok: true, event: { satelliteId: 'sat.living' } });
  });

  it('requires a matching authenticated client certificate for mTLS-only satellites', () => {
    const fingerprint = 'a1'.repeat(32);
    const registry: SatelliteRegistryConfig = {
      ...SATELLITE_REGISTRY,
      satellites: [
        {
          ...SATELLITE_REGISTRY.satellites[0]!,
          endpoints: [
            {
              ...SATELLITE_REGISTRY.satellites[0]!.endpoints[0]!,
              auth: { mode: 'mtls', clientCertFingerprintSha256: fingerprint },
            },
          ],
        },
      ],
    };

    const withoutCert = normalizeExternalTelemetryToPerceptionEvent({
      event: telemetryEvent(),
      satelliteRegistry: registry,
      placesRegistry: PLACES_REGISTRY,
    });
    expect(withoutCert).toMatchObject({
      ok: false,
      reason: 'satellite_origin_not_authorized_for_principal',
    });

    const withCert = normalizeExternalTelemetryToPerceptionEvent({
      event: telemetryEvent({
        auth: {
          principalId: 'api-key-fixture-shared',
          principalMode: 'api_key',
          satelliteScoped: false,
          clientCert: { source: 'tls_peer', fingerprintSha256: fingerprint },
        },
      }),
      satelliteRegistry: registry,
      placesRegistry: PLACES_REGISTRY,
    });
    expect(withCert).toMatchObject({ ok: true });
  });
});
