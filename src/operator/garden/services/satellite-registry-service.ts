import type {
  AdminSatelliteEndpointAuthView,
  AdminSatelliteLiveView,
  AdminSatelliteRegistryView,
  SatelliteEndpointAuthConfig,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';
import type { SatelliteDeviceHealth } from '../../../shared/telemetry/satellite-device-health.js';

const LIVE_OBSERVATION_DETAIL = 'Live endpoint heartbeat and last-seen telemetry are not recorded by the framework yet.';

/** Heartbeats resolve to a satellite, so per-endpoint liveness stays unobserved. */
const ENDPOINT_LIVE_DETAIL = 'Device health is reported per satellite; endpoint-level heartbeat is not reported.';

const SATELLITE_LIVE_DETAILS = {
  observed: 'Device health heartbeats are being recorded for this satellite.',
  degraded: 'This device is degraded: its last heartbeat is stale or it reported itself unhealthy.',
  awaiting: 'No device health heartbeat has been admitted for this satellite yet.',
} as const;

/**
 * Renders one satellite's operator-facing health row. Fail-closed: with no
 * reader, or with no admitted heartbeat, the row reads `not_observed` — the
 * exact state the surface showed before heartbeats were tracked.
 */
function buildSatelliteLiveView(health: SatelliteDeviceHealth | undefined): AdminSatelliteLiveView {
  if (!health || health.status === 'not_observed') {
    return { status: 'not_observed', detail: health ? SATELLITE_LIVE_DETAILS.awaiting : LIVE_OBSERVATION_DETAIL };
  }
  return {
    status: health.status,
    detail: health.status === 'degraded' ? SATELLITE_LIVE_DETAILS.degraded : SATELLITE_LIVE_DETAILS.observed,
    ...(health.lastSeenAtMs === undefined ? {} : { lastSeenAt: new Date(health.lastSeenAtMs).toISOString() }),
    ...(health.ageMs === undefined ? {} : { ageMs: health.ageMs }),
    ...(health.reason ? { reason: health.reason } : {}),
  };
}

function buildAuthView(auth: SatelliteEndpointAuthConfig): AdminSatelliteEndpointAuthView {
  const certBindingTypes: string[] = [];
  if (auth.clientCertFingerprintSha256) certBindingTypes.push('fingerprint_sha256');
  if (auth.clientCertSpkiSha256) certBindingTypes.push('spki_sha256');
  if (auth.clientCertSubject) certBindingTypes.push('subject');
  if (auth.clientCertSan) certBindingTypes.push('san');

  return {
    mode: auth.mode,
    allowedPrincipalCount: auth.apiKeyPrincipalIds?.length ?? 0,
    certBound: auth.mode === 'mtls',
    certBindingTypes,
  };
}

/**
 * Operator device-health surface (bead psfn-framework-s7wq3). The operator sees
 * full per-device health at all times; `health` is a plain derived snapshot, so
 * this stays a pure function with no clock of its own. Omitting it preserves
 * the pre-heartbeat output exactly.
 */
export function buildAdminSatelliteRegistryView(
  registry: SatelliteRegistryConfig | undefined,
  health?: ReadonlyMap<string, SatelliteDeviceHealth>,
): AdminSatelliteRegistryView {
  const satellites = registry?.satellites ?? [];
  const endpointCount = satellites.reduce((total, satellite) => total + satellite.endpoints.length, 0);

  return {
    schemaVersion: 1,
    enabled: registry?.enabled ?? false,
    ...(registry?.productivityCompanionId
      ? { productivityCompanionId: registry.productivityCompanionId }
      : {}),
    satelliteCount: satellites.length,
    retiredSatelliteCount: registry?.retiredSatellites?.length ?? 0,
    endpointCount,
    liveObservationStatus: health ? 'observed' : 'not_implemented',
    liveObservationDetail: health
      ? 'Device health is derived from authenticated satellite heartbeats.'
      : LIVE_OBSERVATION_DETAIL,
    satellites: satellites.map(satellite => ({
      satelliteId: satellite.satelliteId,
      displayName: satellite.displayName,
      mobility: satellite.mobility,
      synthetic: satellite.testProvenance !== undefined,
      ...(satellite.testProvenance
        ? {
            testRunId: satellite.testProvenance.runId,
            testManifestId: satellite.testProvenance.manifestId,
          }
        : {}),
      ...(satellite.staticLocationLabel ? { staticLocationLabel: satellite.staticLocationLabel } : {}),
      ...(satellite.sharedDevice ? { sharedDevice: satellite.sharedDevice } : {}),
      live: buildSatelliteLiveView(health?.get(satellite.satelliteId)),
      endpoints: satellite.endpoints.map(endpoint => ({
        endpointId: endpoint.endpointId,
        displayName: endpoint.displayName,
        claimTypes: endpoint.claimTypes,
        promptChannelType: endpoint.promptChannelType,
        auth: buildAuthView(endpoint.auth),
        defaultIdentity: endpoint.defaultIdentity,
        maxCapabilities: endpoint.maxCapabilities,
        telemetryScopes: endpoint.telemetryScopes,
        ...(endpoint.hubDeviceEnrollment ? { hubDeviceEnrollment: endpoint.hubDeviceEnrollment } : {}),
        live: {
          status: 'not_observed' as const,
          detail: health ? ENDPOINT_LIVE_DETAIL : LIVE_OBSERVATION_DETAIL,
        },
      })),
    })),
  };
}
