import type {
  AdminSatelliteEndpointAuthView,
  AdminSatelliteRegistryView,
  SatelliteEndpointAuthConfig,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';

const LIVE_OBSERVATION_DETAIL = 'Live endpoint heartbeat and last-seen telemetry are not recorded by the framework yet.';

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

export function buildAdminSatelliteRegistryView(
  registry: SatelliteRegistryConfig | undefined,
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
    liveObservationStatus: 'not_implemented',
    liveObservationDetail: LIVE_OBSERVATION_DETAIL,
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
          status: 'not_observed',
          detail: LIVE_OBSERVATION_DETAIL,
        },
      })),
    })),
  };
}
