import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';

export const SATELLITE_REGISTRY_FILE_NAME = 'satellites.json';

export const SATELLITE_CAPABILITIES = [
  'text',
  'audio_input',
  'speech_to_text',
  'audio_output',
  'text_to_speech',
  'vision',
  'image_upload',
  'avatar',
  'avatar_expression',
  'avatar_action',
  'location',
  'timezone',
  'presence',
  'health',
  'battery',
  'telemetry',
  'outbound_delivery',
  'robotics',
] as const;

export type SatelliteCapability = typeof SATELLITE_CAPABILITIES[number];

export const SATELLITE_RUNTIME_ENABLED_CAPABILITIES = SATELLITE_CAPABILITIES
  .filter((capability): capability is Exclude<SatelliteCapability, 'robotics'> => capability !== 'robotics');

export const SATELLITE_TELEMETRY_SCOPES = [
  'location',
  'timezone',
  'presence',
  'health',
  'battery',
  'network',
  'orientation',
  'ambient',
  'device',
  'status',
  // Companion event relay scopes (w9hj.1). Deny by default: an endpoint
  // receives companion events / may act on approvals only when granted here.
  'approvals',
  'artifacts',
  'tool_activity',
] as const;

export type SatelliteTelemetryScope = typeof SATELLITE_TELEMETRY_SCOPES[number];

export type SatelliteMobility = 'static' | 'portable' | 'mobile' | 'unknown';

export type SatelliteAuthMode = 'api_key' | 'mtls';

export const SATELLITE_TRANSPORT_MODES = [
  'http_chat_completions',
  'voice_websocket',
  'openhome_bridge',
  'satellite_hub',
] as const;

export type SatelliteTransportMode = typeof SATELLITE_TRANSPORT_MODES[number];

export const SATELLITE_CONFIG_RESTART_POLICIES = [
  'manual',
  'restart_on_transport_change',
  'restart_on_runtime_change',
  'restart_on_any_change',
] as const;

export type SatelliteConfigRestartPolicy = typeof SATELLITE_CONFIG_RESTART_POLICIES[number];

/**
 * `satellites.json` is the authority for what an external endpoint may claim.
 * Per-request advertised capabilities only reduce this registry maximum; they
 * never grant new powers by themselves.
 */
export interface SatelliteEndpointAuthConfig {
  mode: SatelliteAuthMode;
  apiKeyPrincipalIds?: string[];
  clientCertFingerprintSha256?: string;
  clientCertSpkiSha256?: string;
  clientCertSubject?: string;
  clientCertSan?: string;
}

/**
 * Client-certificate identity derived from an AUTHENTICATED source only:
 *
 * - `tls_peer`: read directly from the terminated TLS socket's peer
 *   certificate (`getPeerCertificate`) on a `requestCert: true` listener.
 * - `trusted_proxy`: asserted via `X-PSFN-Client-Cert-*` headers by a
 *   TLS-terminating proxy that authenticated itself with the configured
 *   trusted-proxy token. Without that token, client-cert headers are
 *   stripped and never trusted.
 *
 * Raw request headers are NEVER a valid source for this identity (Sprint-10
 * finding C1). `subject`/`san` are only populated when the certificate chain
 * was actually validated (socket `authorized === true`, or a trusted proxy
 * that validated the chain); `fingerprintSha256`/`spkiSha256` are
 * self-authenticating pins and are always usable.
 */
export interface SatelliteClientCertIdentity {
  source: 'tls_peer' | 'trusted_proxy';
  fingerprintSha256?: string;
  spkiSha256?: string;
  subject?: string;
  san?: string;
}

export type SatelliteClientCertMatch = { ok: true } | { ok: false; reason: string };

/**
 * Fail-closed client-certificate binding check: EVERY attribute configured on
 * the endpoint must be present on the authenticated identity and match
 * exactly. A single-attribute match never passes when more attributes are
 * configured, and a missing identity always fails.
 */
export function satelliteClientCertMatchesBinding(
  auth: SatelliteEndpointAuthConfig,
  clientCert: SatelliteClientCertIdentity | undefined,
): SatelliteClientCertMatch {
  if (!clientCert) {
    return {
      ok: false,
      reason: 'Satellite mTLS endpoints require a client certificate authenticated by the TLS listener '
        + 'or an authenticated trusted proxy; client-certificate request headers alone are never accepted',
    };
  }
  const bindings: Array<{ label: string; configured?: string; presented?: string }> = [
    {
      label: 'clientCertFingerprintSha256',
      ...(auth.clientCertFingerprintSha256 !== undefined ? { configured: auth.clientCertFingerprintSha256 } : {}),
      ...(clientCert.fingerprintSha256 !== undefined ? { presented: clientCert.fingerprintSha256 } : {}),
    },
    {
      label: 'clientCertSpkiSha256',
      ...(auth.clientCertSpkiSha256 !== undefined ? { configured: auth.clientCertSpkiSha256 } : {}),
      ...(clientCert.spkiSha256 !== undefined ? { presented: clientCert.spkiSha256 } : {}),
    },
    {
      label: 'clientCertSubject',
      ...(auth.clientCertSubject !== undefined ? { configured: auth.clientCertSubject } : {}),
      ...(clientCert.subject !== undefined ? { presented: clientCert.subject } : {}),
    },
    {
      label: 'clientCertSan',
      ...(auth.clientCertSan !== undefined ? { configured: auth.clientCertSan } : {}),
      ...(clientCert.san !== undefined ? { presented: clientCert.san } : {}),
    },
  ];

  let configuredCount = 0;
  for (const binding of bindings) {
    if (binding.configured === undefined) continue;
    configuredCount += 1;
    if (binding.presented === undefined) {
      return {
        ok: false,
        reason: `Authenticated client certificate is missing required attribute ${binding.label}`,
      };
    }
    if (binding.presented !== binding.configured) {
      return {
        ok: false,
        reason: `Authenticated client certificate attribute ${binding.label} does not match the registry binding`,
      };
    }
  }

  if (configuredCount === 0) {
    // Parser guarantees mTLS endpoints configure at least one binding; if a
    // config bypassed the parser, fail closed rather than matching vacuously.
    return { ok: false, reason: 'Satellite mTLS endpoint has no client certificate bindings configured' };
  }
  return { ok: true };
}

/**
 * Principal used to authenticate a satellite claim. `satelliteScoped`
 * principals derive from per-satellite API keys (`API_SATELLITE_KEYS`) and
 * are only admitted by endpoints that EXPLICITLY list their principal id;
 * they never inherit the shared-key default (Sprint-10 finding H4).
 */
export interface SatelliteApiKeyPrincipalRef {
  id: string;
  satelliteScoped: boolean;
}

export function satelliteEndpointAdmitsApiKeyPrincipal(
  auth: SatelliteEndpointAuthConfig,
  principal: SatelliteApiKeyPrincipalRef,
): boolean {
  if (principal.satelliteScoped) {
    return auth.apiKeyPrincipalIds !== undefined && auth.apiKeyPrincipalIds.includes(principal.id);
  }
  if (auth.apiKeyPrincipalIds !== undefined) {
    return auth.apiKeyPrincipalIds.includes(principal.id);
  }
  return true;
}

/**
 * Authenticated origin context attached to external telemetry at the API
 * ingress. The perception bridge uses this to bind a payload-claimed
 * `satelliteId` to the credential that actually authenticated the request
 * (Sprint-10 finding 04-M1): the claimed satellite must have at least one
 * endpoint that admits this principal (and, for mTLS endpoints, whose cert
 * binding matches the authenticated client certificate).
 */
export interface SatelliteTelemetryAuthContext {
  principalId: string;
  principalMode: 'api_key' | 'insecure_local';
  satelliteScoped: boolean;
  clientCert?: SatelliteClientCertIdentity;
}

export function satelliteAdmitsAuthenticatedOrigin(
  satellite: SatelliteConfig,
  auth: SatelliteTelemetryAuthContext,
): boolean {
  if (auth.principalMode !== 'api_key') return false;
  return satellite.endpoints.some((endpoint) => {
    if (!satelliteEndpointAdmitsApiKeyPrincipal(endpoint.auth, {
      id: auth.principalId,
      satelliteScoped: auth.satelliteScoped,
    })) {
      return false;
    }
    if (endpoint.auth.mode === 'mtls') {
      return satelliteClientCertMatchesBinding(endpoint.auth, auth.clientCert).ok;
    }
    return true;
  });
}

export interface SatelliteDefaultIdentityConfig {
  authorId: string;
  authorName: string;
  canonicalContactId: string;
  channelPrivacy: ChannelPrivacy;
}

export interface SatelliteEndpointTransportConfig {
  mode: SatelliteTransportMode;
  chatCompletionsPath?: string;
  voiceWebSocketPath?: string;
}

export interface SatelliteEndpointAudioRuntimeConfig {
  inputDevice?: string;
  outputDevice?: string;
  sampleRateHz?: number;
  channelCount?: number;
  frameMs?: number;
  wakeWordEnabled?: boolean;
}

export interface SatelliteEndpointRefreshConfig {
  intervalMs: number;
  jitterMs?: number;
  restartPolicy: SatelliteConfigRestartPolicy;
  restartGraceMs?: number;
}

export interface SatelliteEndpointRuntimeConfig {
  schemaVersion: 1;
  transport: SatelliteEndpointTransportConfig;
  audio?: SatelliteEndpointAudioRuntimeConfig;
  refresh: SatelliteEndpointRefreshConfig;
}

export interface SatelliteEndpointConfig {
  endpointId: string;
  displayName: string;
  claimTypes: string[];
  promptChannelType: string;
  auth: SatelliteEndpointAuthConfig;
  defaultIdentity: SatelliteDefaultIdentityConfig;
  maxCapabilities: SatelliteCapability[];
  telemetryScopes: SatelliteTelemetryScope[];
  runtime?: SatelliteEndpointRuntimeConfig;
}

export interface SatelliteConfig {
  satelliteId: string;
  displayName: string;
  mobility: SatelliteMobility;
  staticLocationLabel?: string;
  /**
   * Static foreign key into `places.json` (`PlaceConfig.placeId`). Binds this
   * satellite to a place so situated context and affordances resolve. Static
   * only: physical re-bind happens in admin UX, never at runtime. When set and
   * `places.json` is present, the placeId must resolve or startup fails closed
   * (see `assertSatellitePlaceBindings`).
   */
  placeId?: string;
  endpoints: SatelliteEndpointConfig[];
}

export interface SatelliteRegistryConfig {
  schemaVersion: 1;
  enabled: boolean;
  satellites: SatelliteConfig[];
}

export interface AdminSatelliteEndpointAuthView {
  mode: SatelliteAuthMode;
  allowedPrincipalCount: number;
  certBound: boolean;
  certBindingTypes: string[];
}

export interface AdminSatelliteEndpointLiveView {
  status: 'not_observed';
  detail: string;
}

export interface AdminSatelliteEndpointView {
  endpointId: string;
  displayName: string;
  claimTypes: string[];
  promptChannelType: string;
  auth: AdminSatelliteEndpointAuthView;
  defaultIdentity: SatelliteDefaultIdentityConfig;
  maxCapabilities: SatelliteCapability[];
  telemetryScopes: SatelliteTelemetryScope[];
  live: AdminSatelliteEndpointLiveView;
}

export interface AdminSatelliteView {
  satelliteId: string;
  displayName: string;
  mobility: SatelliteMobility;
  staticLocationLabel?: string;
  endpoints: AdminSatelliteEndpointView[];
}

export interface AdminSatelliteRegistryView {
  schemaVersion: 1;
  enabled: boolean;
  satelliteCount: number;
  endpointCount: number;
  liveObservationStatus: 'not_implemented';
  liveObservationDetail: string;
  satellites: AdminSatelliteView[];
}

export interface SatelliteClaimCapabilityResolution {
  advertised: SatelliteCapability[];
  registryMax: SatelliteCapability[];
  effective: SatelliteCapability[];
  policyDenied: SatelliteCapability[];
}

export interface SatelliteRoutingMetadata {
  schemaVersion: 1;
  satelliteId: string;
  satelliteDisplayName: string;
  endpointId: string;
  endpointDisplayName: string;
  claimType: string;
  sessionId: string;
  mobility: SatelliteMobility;
  promptChannelType: string;
  staticLocationLabel?: string;
  /** Static place binding carried onto the turn (see `SatelliteConfig.placeId`). */
  placeId?: string;
  capabilities: SatelliteClaimCapabilityResolution;
  telemetryScopes: SatelliteTelemetryScope[];
  auth: {
    mode: SatelliteAuthMode;
    principalId: string;
    certBound: boolean;
  };
}

export interface SatelliteConfigPullHeaderContract {
  claimType: string;
  satelliteId: string;
  endpointId: string;
  sessionId: string;
  threadId: string;
  capabilities: string;
  telemetryScopes: string;
}

export interface SatelliteConfigPullSessionContract {
  channelType: 'api';
  routingSource: 'satellite';
  claimType: string;
  channelIdTemplate: string;
  sessionIdHeader: string;
  fixedHeaders: {
    claimType: string;
    satelliteId: string;
    endpointId: string;
  };
  headerNames: SatelliteConfigPullHeaderContract;
}

export interface SatelliteConfigPullResponse {
  object: 'companion.satellite_config';
  schemaVersion: 1;
  configVersion: string;
  satellite: {
    satelliteId: string;
    displayName: string;
    mobility: SatelliteMobility;
    staticLocationLabel?: string;
  };
  endpoint: {
    endpointId: string;
    displayName: string;
    promptChannelType: string;
    claimType: string;
    claimTypes: string[];
  };
  identity: SatelliteDefaultIdentityConfig;
  session: SatelliteConfigPullSessionContract;
  capabilities: {
    registryMax: SatelliteCapability[];
    runtimeEnabled: SatelliteCapability[];
    policyDenied: SatelliteCapability[];
  };
  telemetryScopes: SatelliteTelemetryScope[];
  auth: {
    mode: SatelliteAuthMode;
    principalId: string;
    certBound: boolean;
  };
  runtime: SatelliteEndpointRuntimeConfig;
}
