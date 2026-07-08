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
