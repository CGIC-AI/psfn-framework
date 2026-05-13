import type { ChannelVisibility } from '../../system/trust/types.js';

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
] as const;

export type SatelliteTelemetryScope = typeof SATELLITE_TELEMETRY_SCOPES[number];

export type SatelliteMobility = 'static' | 'portable' | 'mobile' | 'unknown';

export type SatelliteAuthMode = 'api_key' | 'mtls';

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

export interface SatelliteDefaultIdentityConfig {
  authorId: string;
  authorName: string;
  canonicalContactId: string;
  channelPrivacy: ChannelVisibility;
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
}

export interface SatelliteConfig {
  satelliteId: string;
  displayName: string;
  mobility: SatelliteMobility;
  staticLocationLabel?: string;
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
  capabilities: SatelliteClaimCapabilityResolution;
  telemetryScopes: SatelliteTelemetryScope[];
  auth: {
    mode: SatelliteAuthMode;
    principalId: string;
    certBound: boolean;
  };
}
