import { describe, expect, it } from 'vitest';
import type {
  SatelliteConfig,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';
import type { SatelliteDeviceHealth } from '../../../shared/telemetry/satellite-device-health.js';
import { buildAdminSatelliteRegistryView } from './satellite-registry-service.js';

function satellite(satelliteId: string): SatelliteConfig {
  return {
    satelliteId,
    displayName: satelliteId,
    mobility: 'static',
    endpoints: [{
      endpointId: `${satelliteId}-main`,
      displayName: 'main',
      claimTypes: ['text'],
      promptChannelType: 'api',
      auth: { mode: 'api_key', apiKeyPrincipalIds: ['principal-1'] },
      defaultIdentity: { authorId: 'author-1', displayName: 'Device' },
      maxCapabilities: ['text'],
      telemetryScopes: ['health'],
    }],
  } as unknown as SatelliteConfig;
}

const REGISTRY: SatelliteRegistryConfig = {
  schemaVersion: 1,
  enabled: true,
  satellites: [satellite('sat-a'), satellite('sat-b')],
};

describe('buildAdminSatelliteRegistryView device health (psfn-framework-s7wq3)', () => {
  it('reports not_implemented and per-satellite not_observed without a health reader', () => {
    const view = buildAdminSatelliteRegistryView(REGISTRY);
    expect(view.liveObservationStatus).toBe('not_implemented');
    for (const satelliteView of view.satellites) {
      expect(satelliteView.live).toEqual({
        status: 'not_observed',
        detail: view.liveObservationDetail,
      });
      expect(satelliteView.endpoints[0]!.live.status).toBe('not_observed');
    }
  });

  it('renders observed per-satellite health, with age and reason, once a reader is wired', () => {
    const health = new Map<string, SatelliteDeviceHealth>([
      ['sat-a', { status: 'ok', lastSeenAtMs: 1_000, ageMs: 250 }],
      ['sat-b', { status: 'degraded', lastSeenAtMs: 500, ageMs: 900_000, reason: 'heartbeat_stale' }],
    ]);

    const view = buildAdminSatelliteRegistryView(REGISTRY, health);

    expect(view.liveObservationStatus).toBe('observed');
    const [a, b] = view.satellites;
    expect(a!.live).toMatchObject({
      status: 'ok', ageMs: 250, lastSeenAt: new Date(1_000).toISOString(),
    });
    expect(a!.live.reason).toBeUndefined();
    expect(b!.live).toMatchObject({ status: 'degraded', ageMs: 900_000, reason: 'heartbeat_stale' });
    // Heartbeats resolve to a satellite, so endpoints stay honestly unobserved.
    expect(b!.endpoints[0]!.live.status).toBe('not_observed');
  });

  it('renders not_observed for a registered satellite the reader has never seen', () => {
    const view = buildAdminSatelliteRegistryView(
      REGISTRY,
      new Map<string, SatelliteDeviceHealth>([['sat-a', { status: 'not_observed' }]]),
    );
    expect(view.satellites.map(s => s.live.status)).toEqual(['not_observed', 'not_observed']);
    expect(view.liveObservationStatus).toBe('observed');
  });
});
