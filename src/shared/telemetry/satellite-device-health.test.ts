import { describe, expect, it, vi } from 'vitest';
import type { ExternalTelemetryEvent } from '../event-bus.js';
import type {
  SatelliteConfig,
  SatelliteRegistryConfig,
  SatelliteTelemetryAuthContext,
} from '../contracts/satellite-registry.js';
import {
  SATELLITE_HEARTBEAT_EVENT_TYPE,
  SatelliteDeviceHealthTracker,
  resolvePlaceDeviceStatus,
} from './satellite-device-health.js';

const PRINCIPAL = 'satellite-principal-1';
const STALE_AFTER_MS = 120_000;

function satellite(overrides: {
  satelliteId: string;
  placeId?: string;
  telemetryScopes?: SatelliteConfig['endpoints'][number]['telemetryScopes'];
}): SatelliteConfig {
  return {
    satelliteId: overrides.satelliteId,
    displayName: overrides.satelliteId,
    mobility: 'static',
    ...(overrides.placeId ? { placeId: overrides.placeId } : {}),
    endpoints: [{
      endpointId: `${overrides.satelliteId}-main`,
      displayName: 'main',
      claimTypes: ['text'],
      promptChannelType: 'api',
      auth: { mode: 'api_key', apiKeyPrincipalIds: [PRINCIPAL] },
      defaultIdentity: { authorId: 'author-1', displayName: 'Device' },
      maxCapabilities: ['text'],
      telemetryScopes: overrides.telemetryScopes ?? ['health'],
    }],
  } as unknown as SatelliteConfig;
}

function registryOf(...satellites: SatelliteConfig[]): SatelliteRegistryConfig {
  return { schemaVersion: 1, enabled: true, satellites };
}

const AUTH: SatelliteTelemetryAuthContext = {
  principalId: PRINCIPAL,
  principalMode: 'api_key',
  satelliteScoped: true,
};

function heartbeat(overrides: {
  satelliteId?: string;
  receivedAtMs?: number;
  payload?: Record<string, unknown>;
  auth?: SatelliteTelemetryAuthContext | undefined;
  eventType?: string;
} = {}): ExternalTelemetryEvent {
  const receivedAtMs = overrides.receivedAtMs ?? 1_000;
  return {
    id: 'ext-1',
    source: overrides.satelliteId ?? 'sat-a',
    eventType: overrides.eventType ?? SATELLITE_HEARTBEAT_EVENT_TYPE,
    payload: { satelliteId: overrides.satelliteId ?? 'sat-a', ...overrides.payload },
    occurredAt: new Date(receivedAtMs).toISOString(),
    receivedAt: new Date(receivedAtMs).toISOString(),
    nonce: 'nonce-1',
    ...('auth' in overrides ? { auth: overrides.auth } : { auth: AUTH }),
  } as ExternalTelemetryEvent;
}

function trackerOver(registry: SatelliteRegistryConfig | undefined) {
  return new SatelliteDeviceHealthTracker({ registry: () => registry, staleAfterMs: STALE_AFTER_MS });
}

describe('SatelliteDeviceHealthTracker (psfn-framework-s7wq3)', () => {
  it('reads not_observed until an admitted heartbeat arrives', () => {
    const tracker = trackerOver(registryOf(satellite({ satelliteId: 'sat-a' })));
    expect(tracker.readStatus('sat-a', 1_000)).toEqual({ status: 'not_observed' });
    tracker.observe(heartbeat());
    expect(tracker.readStatus('sat-a', 1_000)).toMatchObject({ status: 'ok', ageMs: 0 });
  });

  it('degrades a satellite whose heartbeat went silent past the staleness bound', () => {
    const tracker = trackerOver(registryOf(satellite({ satelliteId: 'sat-a' })));
    tracker.observe(heartbeat({ receivedAtMs: 1_000 }));
    expect(tracker.readStatus('sat-a', 1_000 + STALE_AFTER_MS)).toMatchObject({ status: 'ok' });
    expect(tracker.readStatus('sat-a', 1_001 + STALE_AFTER_MS)).toMatchObject({
      status: 'degraded',
      reason: 'heartbeat_stale',
    });
  });

  it('degrades on the device self-reporting unhealthy or offline, and recovers', () => {
    const tracker = trackerOver(registryOf(satellite({ satelliteId: 'sat-a' })));
    tracker.observe(heartbeat({ receivedAtMs: 1_000, payload: { healthy: false } }));
    expect(tracker.readStatus('sat-a', 1_000)).toMatchObject({
      status: 'degraded', reason: 'device_reported_unhealthy',
    });
    tracker.observe(heartbeat({ receivedAtMs: 2_000, payload: { online: false, healthy: true } }));
    expect(tracker.readStatus('sat-a', 2_000)).toMatchObject({
      status: 'degraded', reason: 'device_reported_offline',
    });
    tracker.observe(heartbeat({ receivedAtMs: 3_000, payload: { online: true, healthy: true } }));
    expect(tracker.readStatus('sat-a', 3_000)).toMatchObject({ status: 'ok' });
  });

  describe('fails closed', () => {
    it.each([
      ['a non-heartbeat telemetry event', heartbeat({ eventType: 'external.telemetry.presence' })],
      ['an unauthenticated heartbeat', heartbeat({ auth: undefined })],
      ['an unregistered satellite id', heartbeat({ satelliteId: 'sat-unknown' })],
      ['a malformed boolean health flag', heartbeat({ payload: { healthy: 'yes' } })],
      ['a malformed online flag', heartbeat({ payload: { online: 1 } })],
      ['an unparseable receipt timestamp', {
        ...heartbeat(), receivedAt: 'not-a-date',
      } as ExternalTelemetryEvent],
    ])('never marks a device ok from %s', (_label, event) => {
      const tracker = trackerOver(registryOf(satellite({ satelliteId: 'sat-a' })));
      tracker.observe(event);
      expect(tracker.readStatus('sat-a', 1_000)).toEqual({ status: 'not_observed' });
      expect(tracker.readStatus('sat-unknown', 1_000)).toEqual({ status: 'not_observed' });
    });

    it('rejects a device that was never granted the health telemetry scope', () => {
      const tracker = trackerOver(registryOf(
        satellite({ satelliteId: 'sat-a', telemetryScopes: ['presence'] }),
      ));
      tracker.observe(heartbeat());
      expect(tracker.readStatus('sat-a', 1_000)).toEqual({ status: 'not_observed' });
    });

    it('rejects a credential that is not admitted by any endpoint of that satellite', () => {
      const tracker = trackerOver(registryOf(satellite({ satelliteId: 'sat-a' })));
      tracker.observe(heartbeat({ auth: { ...AUTH, principalId: 'someone-else' } }));
      expect(tracker.readStatus('sat-a', 1_000)).toEqual({ status: 'not_observed' });
    });

    it('leaves the last good record untouched when a later beat is rejected', () => {
      const tracker = trackerOver(registryOf(satellite({ satelliteId: 'sat-a' })));
      tracker.observe(heartbeat({ receivedAtMs: 1_000 }));
      tracker.observe(heartbeat({ receivedAtMs: 5_000, payload: { healthy: 'nope' } }));
      expect(tracker.readStatus('sat-a', 1_000)).toMatchObject({ status: 'ok', lastSeenAtMs: 1_000 });
    });
  });

  it('bounds the snapshot by the registry, never by observed ids', () => {
    const tracker = trackerOver(registryOf(
      satellite({ satelliteId: 'sat-a' }),
      satellite({ satelliteId: 'sat-b' }),
    ));
    tracker.observe(heartbeat({ satelliteId: 'sat-a' }));
    tracker.observe(heartbeat({ satelliteId: 'sat-ghost' }));
    const snapshot = tracker.snapshot(1_000);
    expect([...snapshot.keys()].sort()).toEqual(['sat-a', 'sat-b']);
    expect(snapshot.get('sat-b')).toEqual({ status: 'not_observed' });
  });

  it('subscribes once and stops observing after dispose', () => {
    const handlers: Array<(payload: { event: ExternalTelemetryEvent }) => void> = [];
    const unsubscribe = vi.fn();
    const eventBus = {
      on: vi.fn((_name: string, handler: (payload: { event: ExternalTelemetryEvent }) => void) => {
        handlers.push(handler);
        return unsubscribe;
      }),
    };
    const tracker = trackerOver(registryOf(satellite({ satelliteId: 'sat-a' })));
    tracker.subscribe(eventBus as never);
    tracker.subscribe(eventBus as never);
    expect(eventBus.on).toHaveBeenCalledTimes(1);

    handlers[0]!({ event: heartbeat() });
    expect(tracker.readStatus('sat-a', 1_000)).toMatchObject({ status: 'ok' });

    tracker.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePlaceDeviceStatus (psfn-framework-s7wq3)', () => {
  const registry = registryOf(
    satellite({ satelliteId: 'sat-a', placeId: 'place.kitchen' }),
    satellite({ satelliteId: 'sat-b', placeId: 'place.kitchen' }),
    satellite({ satelliteId: 'sat-c', placeId: 'place.study' }),
  );

  it('returns undefined for a place with no observed device', () => {
    const tracker = trackerOver(registry);
    expect(resolvePlaceDeviceStatus(registry, tracker, 'place.kitchen', 1_000)).toBeUndefined();
    expect(resolvePlaceDeviceStatus(registry, tracker, 'place.unbound', 1_000)).toBeUndefined();
  });

  it('reports ok only when every observed device at the place is healthy', () => {
    const tracker = trackerOver(registry);
    tracker.observe(heartbeat({ satelliteId: 'sat-a' }));
    expect(resolvePlaceDeviceStatus(registry, tracker, 'place.kitchen', 1_000)).toBe('ok');
    tracker.observe(heartbeat({ satelliteId: 'sat-b', payload: { healthy: false } }));
    expect(resolvePlaceDeviceStatus(registry, tracker, 'place.kitchen', 1_000)).toBe('degraded');
    // A degraded kitchen never leaks into an unobserved study.
    expect(resolvePlaceDeviceStatus(registry, tracker, 'place.study', 1_000)).toBeUndefined();
  });
});
