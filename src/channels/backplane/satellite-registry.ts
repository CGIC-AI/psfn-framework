import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type {
  SatelliteCapability,
  SatelliteConfigPullResponse,
  SatelliteConfig,
  SatelliteConfigRestartPolicy,
  SatelliteEndpointAuthConfig,
  SatelliteEndpointAudioRuntimeConfig,
  SatelliteEndpointConfig,
  SatelliteEndpointRefreshConfig,
  SatelliteEndpointRuntimeConfig,
  SatelliteEndpointTransportConfig,
  SatelliteMobility,
  SatelliteRegistryConfig,
  SatelliteRoutingMetadata,
  SatelliteTelemetryScope,
  SatelliteTransportMode,
} from '../../shared/contracts/satellite-registry.js';
import {
  SATELLITE_CAPABILITIES,
  SATELLITE_CONFIG_RESTART_POLICIES,
  SATELLITE_REGISTRY_FILE_NAME,
  SATELLITE_RUNTIME_ENABLED_CAPABILITIES,
  SATELLITE_TELEMETRY_SCOPES,
  SATELLITE_TRANSPORT_MODES,
} from '../../shared/contracts/satellite-registry.js';
import type { ApiAuthPrincipal } from './http/auth.js';
import type { ChannelVisibility } from '../../system/trust/types.js';
import { normalizeChannelVisibility } from '../../system/trust/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isRecord } from '../../shared/utils/types.js';

const ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLAIM_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const SATELLITE_CAPABILITY_SET = new Set<string>(SATELLITE_CAPABILITIES);
const SATELLITE_RUNTIME_ENABLED_CAPABILITY_SET = new Set<string>(SATELLITE_RUNTIME_ENABLED_CAPABILITIES);
const SATELLITE_TELEMETRY_SCOPE_SET = new Set<string>(SATELLITE_TELEMETRY_SCOPES);
const SATELLITE_TRANSPORT_MODE_SET = new Set<string>(SATELLITE_TRANSPORT_MODES);
const SATELLITE_CONFIG_RESTART_POLICY_SET = new Set<string>(SATELLITE_CONFIG_RESTART_POLICIES);

export const EMPTY_SATELLITE_REGISTRY_CONFIG: SatelliteRegistryConfig = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  satellites: [],
});

export const SATELLITE_CLAIM_HEADERS = {
  claimType: 'x-psfn-satellite-claim-type',
  satelliteId: 'x-psfn-satellite-id',
  endpointId: 'x-psfn-satellite-endpoint-id',
  sessionId: 'x-psfn-satellite-session-id',
  threadId: 'x-psfn-satellite-thread-id',
  capabilities: 'x-psfn-satellite-capabilities',
  telemetryScopes: 'x-psfn-satellite-telemetry-scopes',
  clientCertFingerprintSha256: 'x-psfn-client-cert-fingerprint-sha256',
  clientCertSpkiSha256: 'x-psfn-client-cert-spki-sha256',
  clientCertSubject: 'x-psfn-client-cert-subject',
  clientCertSan: 'x-psfn-client-cert-san',
} as const;

type HeaderMap = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

export interface ResolvedSatelliteClaim {
  channelId: string;
  authorId: string;
  authorName: string;
  channelPrivacy: ChannelVisibility;
  canonicalContactId: string;
  satellite: SatelliteRoutingMetadata;
}

export type SatelliteClaimResolution = { ok: true; value: ResolvedSatelliteClaim } | {
  ok: false;
  status: number;
  type: string;
  message: string;
};
type SatelliteClaimErrorResolution = Extract<SatelliteClaimResolution, { ok: false }>;

export type SatelliteConfigPullResolution = { ok: true; value: SatelliteConfigPullResponse } | {
  ok: false;
  status: number;
  type: string;
  message: string;
};

function parseConfiguredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const parsed = value.trim();
  if (!parsed) {
    throw new Error(`${fieldName} must not be empty`);
  }
  return parsed;
}

function parseOptionalConfiguredString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return parseConfiguredString(value, fieldName);
}

function parseOptionalConfiguredBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function parseOptionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  return parsePositiveInteger(value, fieldName);
}

function parseStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`${fieldName} must contain only strings`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`${fieldName} must not contain empty strings`);
    }
    unique.add(trimmed);
  }
  if (unique.size === 0) {
    throw new Error(`${fieldName} must contain at least one value`);
  }
  return [...unique];
}

function assertIdToken(value: string, fieldName: string): string {
  if (!ID_TOKEN_PATTERN.test(value)) {
    throw new Error(`${fieldName} must use only letters, numbers, dot, underscore, dash, or colon`);
  }
  return value;
}

function assertClaimType(value: string, fieldName: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CLAIM_TYPE_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must be lowercase letters, numbers, dot, underscore, or dash`);
  }
  return normalized;
}

function parseMobility(value: unknown, fieldName: string): SatelliteMobility {
  const parsed = parseConfiguredString(value, fieldName);
  if (parsed !== 'static' && parsed !== 'portable' && parsed !== 'mobile' && parsed !== 'unknown') {
    throw new Error(`${fieldName} must be one of: static, portable, mobile, unknown`);
  }
  return parsed;
}

function parseChannelPrivacy(value: unknown, fieldName: string): ChannelVisibility {
  const raw = parseConfiguredString(value, fieldName);
  const parsed = normalizeChannelVisibility(raw);
  if (!parsed) {
    throw new Error(`${fieldName} must be one of: private, semi_private, public, broadcast`);
  }
  return parsed;
}

function parseEndpointPath(value: unknown, fieldName: string): string | undefined {
  const parsed = parseOptionalConfiguredString(value, fieldName);
  if (parsed === undefined) return undefined;
  if (!parsed.startsWith('/') || parsed.includes('://') || parsed.includes('?') || parsed.includes('#')) {
    throw new Error(`${fieldName} must be an absolute HTTP path without query string or fragment`);
  }
  return parsed;
}

function normalizeSha256Hex(value: string, fieldName: string): string {
  const normalized = value.trim().toLowerCase().replace(/:/gu, '');
  if (!HEX_SHA256_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function parseAuthConfig(value: unknown, fieldName: string): SatelliteEndpointAuthConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const mode = parseConfiguredString(value.mode, `${fieldName}.mode`);
  if (mode !== 'api_key' && mode !== 'mtls') {
    throw new Error(`${fieldName}.mode must be one of: api_key, mtls`);
  }

  const apiKeyPrincipalIds = value.apiKeyPrincipalIds === undefined
    ? undefined
    : parseStringArray(value.apiKeyPrincipalIds, `${fieldName}.apiKeyPrincipalIds`);
  const clientCertFingerprintSha256 = parseOptionalConfiguredString(
    value.clientCertFingerprintSha256,
    `${fieldName}.clientCertFingerprintSha256`,
  );
  const clientCertSpkiSha256 = parseOptionalConfiguredString(
    value.clientCertSpkiSha256,
    `${fieldName}.clientCertSpkiSha256`,
  );
  const clientCertSubject = parseOptionalConfiguredString(value.clientCertSubject, `${fieldName}.clientCertSubject`);
  const clientCertSan = parseOptionalConfiguredString(value.clientCertSan, `${fieldName}.clientCertSan`);

  if (mode === 'mtls' && !clientCertFingerprintSha256 && !clientCertSpkiSha256 && !clientCertSubject && !clientCertSan) {
    throw new Error(`${fieldName} mTLS mode requires at least one client certificate binding`);
  }

  return {
    mode,
    ...(apiKeyPrincipalIds ? { apiKeyPrincipalIds } : {}),
    ...(clientCertFingerprintSha256
      ? { clientCertFingerprintSha256: normalizeSha256Hex(clientCertFingerprintSha256, `${fieldName}.clientCertFingerprintSha256`) }
      : {}),
    ...(clientCertSpkiSha256
      ? { clientCertSpkiSha256: normalizeSha256Hex(clientCertSpkiSha256, `${fieldName}.clientCertSpkiSha256`) }
      : {}),
    ...(clientCertSubject ? { clientCertSubject } : {}),
    ...(clientCertSan ? { clientCertSan } : {}),
  };
}

function parseCapabilities(value: unknown, fieldName: string): SatelliteCapability[] {
  return parseStringArray(value, fieldName).map((entry) => {
    if (!SATELLITE_CAPABILITY_SET.has(entry)) {
      throw new Error(`${fieldName} contains unknown capability "${entry}"`);
    }
    return entry as SatelliteCapability;
  });
}

function parseTelemetryScopes(value: unknown, fieldName: string): SatelliteTelemetryScope[] {
  if (value === undefined) return [];
  return parseStringArray(value, fieldName).map((entry) => {
    if (!SATELLITE_TELEMETRY_SCOPE_SET.has(entry)) {
      throw new Error(`${fieldName} contains unknown telemetry scope "${entry}"`);
    }
    return entry as SatelliteTelemetryScope;
  });
}

function parseTransportMode(value: unknown, fieldName: string): SatelliteTransportMode {
  const parsed = parseConfiguredString(value, fieldName);
  if (!SATELLITE_TRANSPORT_MODE_SET.has(parsed)) {
    throw new Error(`${fieldName} must be one of: ${SATELLITE_TRANSPORT_MODES.join(', ')}`);
  }
  return parsed as SatelliteTransportMode;
}

function parseRestartPolicy(value: unknown, fieldName: string): SatelliteConfigRestartPolicy {
  const parsed = parseConfiguredString(value, fieldName);
  if (!SATELLITE_CONFIG_RESTART_POLICY_SET.has(parsed)) {
    throw new Error(`${fieldName} must be one of: ${SATELLITE_CONFIG_RESTART_POLICIES.join(', ')}`);
  }
  return parsed as SatelliteConfigRestartPolicy;
}

function parseEndpointTransportConfig(value: unknown, fieldName: string): SatelliteEndpointTransportConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const transport: SatelliteEndpointTransportConfig = {
    mode: parseTransportMode(value.mode, `${fieldName}.mode`),
    ...(value.chatCompletionsPath !== undefined
      ? { chatCompletionsPath: parseEndpointPath(value.chatCompletionsPath, `${fieldName}.chatCompletionsPath`) }
      : {}),
    ...(value.voiceWebSocketPath !== undefined
      ? { voiceWebSocketPath: parseEndpointPath(value.voiceWebSocketPath, `${fieldName}.voiceWebSocketPath`) }
      : {}),
  };

  if (transport.mode === 'http_chat_completions' && !transport.chatCompletionsPath) {
    throw new Error(`${fieldName}.chatCompletionsPath must be configured when mode is http_chat_completions`);
  }
  if (transport.mode === 'voice_websocket' && !transport.voiceWebSocketPath) {
    throw new Error(`${fieldName}.voiceWebSocketPath must be configured when mode is voice_websocket`);
  }
  return transport;
}

function parseEndpointAudioRuntimeConfig(value: unknown, fieldName: string): SatelliteEndpointAudioRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return {
    ...(value.inputDevice !== undefined
      ? { inputDevice: parseConfiguredString(value.inputDevice, `${fieldName}.inputDevice`) }
      : {}),
    ...(value.outputDevice !== undefined
      ? { outputDevice: parseConfiguredString(value.outputDevice, `${fieldName}.outputDevice`) }
      : {}),
    ...(value.sampleRateHz !== undefined
      ? { sampleRateHz: parsePositiveInteger(value.sampleRateHz, `${fieldName}.sampleRateHz`) }
      : {}),
    ...(value.channelCount !== undefined
      ? { channelCount: parsePositiveInteger(value.channelCount, `${fieldName}.channelCount`) }
      : {}),
    ...(value.frameMs !== undefined
      ? { frameMs: parsePositiveInteger(value.frameMs, `${fieldName}.frameMs`) }
      : {}),
    ...(value.wakeWordEnabled !== undefined
      ? { wakeWordEnabled: parseOptionalConfiguredBoolean(value.wakeWordEnabled, `${fieldName}.wakeWordEnabled`) }
      : {}),
  };
}

function parseEndpointRefreshConfig(value: unknown, fieldName: string): SatelliteEndpointRefreshConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const refresh: SatelliteEndpointRefreshConfig = {
    intervalMs: parsePositiveInteger(value.intervalMs, `${fieldName}.intervalMs`),
    ...(value.jitterMs !== undefined
      ? { jitterMs: parseOptionalPositiveInteger(value.jitterMs, `${fieldName}.jitterMs`) }
      : {}),
    restartPolicy: parseRestartPolicy(value.restartPolicy, `${fieldName}.restartPolicy`),
    ...(value.restartGraceMs !== undefined
      ? { restartGraceMs: parseOptionalPositiveInteger(value.restartGraceMs, `${fieldName}.restartGraceMs`) }
      : {}),
  };
  if (refresh.jitterMs !== undefined && refresh.jitterMs >= refresh.intervalMs) {
    throw new Error(`${fieldName}.jitterMs must be less than ${fieldName}.intervalMs`);
  }
  return refresh;
}

function parseEndpointRuntimeConfig(value: unknown, fieldName: string): SatelliteEndpointRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${fieldName}.schemaVersion must be 1`);
  }
  return {
    schemaVersion: 1,
    transport: parseEndpointTransportConfig(value.transport, `${fieldName}.transport`),
    ...(value.audio !== undefined
      ? { audio: parseEndpointAudioRuntimeConfig(value.audio, `${fieldName}.audio`) }
      : {}),
    refresh: parseEndpointRefreshConfig(value.refresh, `${fieldName}.refresh`),
  };
}

function parseEndpointConfig(value: unknown, fieldName: string): SatelliteEndpointConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const endpointId = assertIdToken(parseConfiguredString(value.endpointId, `${fieldName}.endpointId`), `${fieldName}.endpointId`);
  const displayName = parseConfiguredString(value.displayName, `${fieldName}.displayName`);
  const claimTypes = parseStringArray(value.claimTypes, `${fieldName}.claimTypes`)
    .map((entry, index) => assertClaimType(entry, `${fieldName}.claimTypes[${index}]`));
  const promptChannelType = assertClaimType(
    parseConfiguredString(value.promptChannelType, `${fieldName}.promptChannelType`),
    `${fieldName}.promptChannelType`,
  );
  const auth = parseAuthConfig(value.auth, `${fieldName}.auth`);
  const maxCapabilities = parseCapabilities(value.maxCapabilities, `${fieldName}.maxCapabilities`);
  const telemetryScopes = parseTelemetryScopes(value.telemetryScopes, `${fieldName}.telemetryScopes`);
  const runtime = parseEndpointRuntimeConfig(value.runtime, `${fieldName}.runtime`);
  if (!isRecord(value.defaultIdentity)) {
    throw new Error(`${fieldName}.defaultIdentity must be an object`);
  }
  const defaultIdentity = {
    authorId: assertIdToken(
      parseConfiguredString(value.defaultIdentity.authorId, `${fieldName}.defaultIdentity.authorId`),
      `${fieldName}.defaultIdentity.authorId`,
    ),
    authorName: parseConfiguredString(value.defaultIdentity.authorName, `${fieldName}.defaultIdentity.authorName`),
    canonicalContactId: assertIdToken(
      parseConfiguredString(value.defaultIdentity.canonicalContactId, `${fieldName}.defaultIdentity.canonicalContactId`),
      `${fieldName}.defaultIdentity.canonicalContactId`,
    ),
    channelPrivacy: parseChannelPrivacy(value.defaultIdentity.channelPrivacy, `${fieldName}.defaultIdentity.channelPrivacy`),
  };

  return {
    endpointId,
    displayName,
    claimTypes,
    promptChannelType,
    auth,
    defaultIdentity,
    maxCapabilities,
    telemetryScopes,
    ...(runtime ? { runtime } : {}),
  };
}

function parseSatelliteConfig(value: unknown, fieldName: string): SatelliteConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const satelliteId = assertIdToken(
    parseConfiguredString(value.satelliteId, `${fieldName}.satelliteId`),
    `${fieldName}.satelliteId`,
  );
  const displayName = parseConfiguredString(value.displayName, `${fieldName}.displayName`);
  const mobility = parseMobility(value.mobility, `${fieldName}.mobility`);
  const staticLocationLabel = parseOptionalConfiguredString(value.staticLocationLabel, `${fieldName}.staticLocationLabel`);
  if (!Array.isArray(value.endpoints)) {
    throw new Error(`${fieldName}.endpoints must be an array`);
  }
  if (value.endpoints.length === 0) {
    throw new Error(`${fieldName}.endpoints must contain at least one endpoint`);
  }
  const endpoints = value.endpoints.map((endpoint, index) => parseEndpointConfig(endpoint, `${fieldName}.endpoints[${index}]`));

  return {
    satelliteId,
    displayName,
    mobility,
    ...(staticLocationLabel ? { staticLocationLabel } : {}),
    endpoints,
  };
}

function assertUniqueRegistryBindings(config: SatelliteRegistryConfig): void {
  const satelliteIds = new Set<string>();
  const endpointKeys = new Set<string>();
  const claimKeys = new Set<string>();

  for (const satellite of config.satellites) {
    if (satelliteIds.has(satellite.satelliteId)) {
      throw new Error(`satellites.json has duplicate satelliteId "${satellite.satelliteId}"`);
    }
    satelliteIds.add(satellite.satelliteId);
    for (const endpoint of satellite.endpoints) {
      const endpointKey = `${satellite.satelliteId}:${endpoint.endpointId}`;
      if (endpointKeys.has(endpointKey)) {
        throw new Error(`satellites.json has duplicate endpoint "${endpointKey}"`);
      }
      endpointKeys.add(endpointKey);
      for (const claimType of endpoint.claimTypes) {
        const claimKey = `${satellite.satelliteId}:${endpoint.endpointId}:${claimType}`;
        if (claimKeys.has(claimKey)) {
          throw new Error(`satellites.json has duplicate claim binding "${claimKey}"`);
        }
        claimKeys.add(claimKey);
      }
    }
  }
}

export function parseSatelliteRegistryConfig(
  rawConfig: unknown,
  sourceLabel = SATELLITE_REGISTRY_FILE_NAME,
): SatelliteRegistryConfig {
  if (!isRecord(rawConfig)) {
    throw new Error(`${sourceLabel} must contain a JSON object at the root`);
  }
  if (rawConfig.schemaVersion !== 1) {
    throw new Error(`${sourceLabel}.schemaVersion must be 1`);
  }
  const enabled = rawConfig.enabled === undefined ? true : rawConfig.enabled;
  if (typeof enabled !== 'boolean') {
    throw new Error(`${sourceLabel}.enabled must be a boolean`);
  }
  if (!Array.isArray(rawConfig.satellites)) {
    throw new Error(`${sourceLabel}.satellites must be an array`);
  }
  const satellites = rawConfig.satellites.map((satellite, index) => parseSatelliteConfig(satellite, `${sourceLabel}.satellites[${index}]`));
  if (enabled && satellites.length === 0) {
    throw new Error(`${sourceLabel}.satellites must contain at least one satellite when enabled`);
  }

  const config: SatelliteRegistryConfig = {
    schemaVersion: 1,
    enabled,
    satellites,
  };
  assertUniqueRegistryBindings(config);
  return config;
}

export function loadSatelliteRegistryConfig(dataDir: string): SatelliteRegistryConfig {
  const filePath = join(dataDir, SATELLITE_REGISTRY_FILE_NAME);
  if (!existsSync(filePath)) {
    return EMPTY_SATELLITE_REGISTRY_CONFIG;
  }

  try {
    const text = readFileSync(filePath, 'utf8');
    return parseSatelliteRegistryConfig(JSON.parse(text), SATELLITE_REGISTRY_FILE_NAME);
  } catch (error) {
    throw new Error(`Failed to load satellite registry from ${filePath}: ${toErrorMessage(error)}`);
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readHeader(headers: HeaderMap, name: string, maxLength: number): string | undefined {
  const raw = firstHeader(headers[name]);
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export function hasSatelliteClaimHeaders(headers: HeaderMap): boolean {
  return Boolean(
    readHeader(headers, SATELLITE_CLAIM_HEADERS.claimType, 64)
    || readHeader(headers, SATELLITE_CLAIM_HEADERS.satelliteId, 128)
    || readHeader(headers, SATELLITE_CLAIM_HEADERS.endpointId, 128)
    || readHeader(headers, SATELLITE_CLAIM_HEADERS.sessionId, 128)
    || readHeader(headers, SATELLITE_CLAIM_HEADERS.threadId, 128),
  );
}

function parseHeaderList(raw: string | undefined, fieldName: string): string[] {
  if (!raw) return [];
  if (raw.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${fieldName} must be JSON array or comma-separated list: ${toErrorMessage(error)}`);
    }
    return parseStringArray(parsed, fieldName);
  }
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function parseClaimCapabilities(raw: string | undefined): SatelliteCapability[] {
  const entries = parseHeaderList(raw, 'X-PSFN-Satellite-Capabilities');
  const parsed: SatelliteCapability[] = [];
  for (const entry of entries) {
    if (!SATELLITE_CAPABILITY_SET.has(entry)) {
      throw new Error(`X-PSFN-Satellite-Capabilities contains unknown capability "${entry}"`);
    }
    parsed.push(entry as SatelliteCapability);
  }
  return [...new Set(parsed)];
}

function parseClaimTelemetryScopes(raw: string | undefined): SatelliteTelemetryScope[] {
  const entries = parseHeaderList(raw, 'X-PSFN-Satellite-Telemetry-Scopes');
  const parsed: SatelliteTelemetryScope[] = [];
  for (const entry of entries) {
    if (!SATELLITE_TELEMETRY_SCOPE_SET.has(entry)) {
      throw new Error(`X-PSFN-Satellite-Telemetry-Scopes contains unknown telemetry scope "${entry}"`);
    }
    parsed.push(entry as SatelliteTelemetryScope);
  }
  return [...new Set(parsed)];
}

function findEndpoint(input: {
  registry: SatelliteRegistryConfig;
  satelliteId: string;
  endpointId: string;
  claimType: string;
}): { satellite: SatelliteConfig; endpoint: SatelliteEndpointConfig } | null {
  const satellite = input.registry.satellites.find(candidate => candidate.satelliteId === input.satelliteId);
  if (!satellite) return null;
  const endpoint = satellite.endpoints.find(candidate => (
    candidate.endpointId === input.endpointId
    && candidate.claimTypes.includes(input.claimType)
  ));
  return endpoint ? { satellite, endpoint } : null;
}

function resolveEffectiveCapabilities(input: {
  registryMax: readonly SatelliteCapability[];
  advertised: readonly SatelliteCapability[];
}): SatelliteRoutingMetadata['capabilities'] {
  const registryMax = [...new Set(input.registryMax)];
  const advertised = [...new Set(input.advertised)];
  const advertisedOrMax = advertised.length > 0 ? advertised : registryMax;
  const unauthorized = advertisedOrMax.filter(capability => !registryMax.includes(capability));
  if (unauthorized.length > 0) {
    throw new Error(`satellite advertised capabilities outside registry maximum: ${unauthorized.join(', ')}`);
  }
  const policyDenied = advertisedOrMax.filter(capability => !SATELLITE_RUNTIME_ENABLED_CAPABILITY_SET.has(capability));
  const effective = advertisedOrMax.filter((capability): capability is SatelliteCapability => (
    registryMax.includes(capability)
    && SATELLITE_RUNTIME_ENABLED_CAPABILITY_SET.has(capability)
  ));
  return {
    advertised,
    registryMax,
    effective,
    policyDenied,
  };
}

function resolveEffectiveTelemetryScopes(input: {
  registryAllowed: readonly SatelliteTelemetryScope[];
  requested: readonly SatelliteTelemetryScope[];
}): SatelliteTelemetryScope[] {
  const registryAllowed = [...new Set(input.registryAllowed)];
  const requested = [...new Set(input.requested)];
  const unauthorized = requested.filter(scope => !registryAllowed.includes(scope));
  if (unauthorized.length > 0) {
    throw new Error(`satellite requested telemetry scopes outside registry maximum: ${unauthorized.join(', ')}`);
  }
  return requested;
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function buildRuntimeCapabilityPolicy(endpoint: SatelliteEndpointConfig): SatelliteConfigPullResponse['capabilities'] {
  const registryMax = [...new Set(endpoint.maxCapabilities)];
  const runtimeEnabled = registryMax.filter((capability): capability is SatelliteCapability => (
    SATELLITE_RUNTIME_ENABLED_CAPABILITY_SET.has(capability)
  ));
  const policyDenied = registryMax.filter(capability => !SATELLITE_RUNTIME_ENABLED_CAPABILITY_SET.has(capability));
  return {
    registryMax,
    runtimeEnabled,
    policyDenied,
  };
}

function buildSatelliteConfigPullResponse(input: {
  satellite: SatelliteConfig;
  endpoint: SatelliteEndpointConfig;
  claimType: string;
  principal: ApiAuthPrincipal;
}): SatelliteConfigPullResponse {
  const { satellite, endpoint, claimType, principal } = input;
  if (!endpoint.runtime) {
    throw new Error('Satellite endpoint does not have runtime config');
  }
  const responseWithoutVersion = {
    object: 'companion.satellite_config' as const,
    schemaVersion: 1 as const,
    satellite: {
      satelliteId: satellite.satelliteId,
      displayName: satellite.displayName,
      mobility: satellite.mobility,
      ...(satellite.staticLocationLabel ? { staticLocationLabel: satellite.staticLocationLabel } : {}),
    },
    endpoint: {
      endpointId: endpoint.endpointId,
      displayName: endpoint.displayName,
      promptChannelType: endpoint.promptChannelType,
      claimType,
      claimTypes: endpoint.claimTypes,
    },
    identity: endpoint.defaultIdentity,
    session: {
      channelType: 'api' as const,
      routingSource: 'satellite' as const,
      claimType,
      channelIdTemplate: `satellite:${claimType}:{sessionId}`,
      sessionIdHeader: SATELLITE_CLAIM_HEADERS.sessionId,
      fixedHeaders: {
        claimType,
        satelliteId: satellite.satelliteId,
        endpointId: endpoint.endpointId,
      },
      headerNames: {
        claimType: SATELLITE_CLAIM_HEADERS.claimType,
        satelliteId: SATELLITE_CLAIM_HEADERS.satelliteId,
        endpointId: SATELLITE_CLAIM_HEADERS.endpointId,
        sessionId: SATELLITE_CLAIM_HEADERS.sessionId,
        threadId: SATELLITE_CLAIM_HEADERS.threadId,
        capabilities: SATELLITE_CLAIM_HEADERS.capabilities,
        telemetryScopes: SATELLITE_CLAIM_HEADERS.telemetryScopes,
      },
    },
    capabilities: buildRuntimeCapabilityPolicy(endpoint),
    telemetryScopes: endpoint.telemetryScopes,
    auth: {
      mode: endpoint.auth.mode,
      principalId: principal.id,
      certBound: endpoint.auth.mode === 'mtls',
    },
    runtime: endpoint.runtime,
  };

  return {
    ...responseWithoutVersion,
    configVersion: stableHash(responseWithoutVersion),
  };
}

function verifyApiKeyAuth(auth: SatelliteEndpointAuthConfig, principal: ApiAuthPrincipal): SatelliteClaimErrorResolution | null {
  if (principal.mode !== 'api_key') {
    return {
      ok: false,
      status: 403,
      type: 'satellite_claim_requires_api_key',
      message: 'Satellite claims require API key authentication',
    };
  }
  if (auth.apiKeyPrincipalIds && !auth.apiKeyPrincipalIds.includes(principal.id)) {
    return {
      ok: false,
      status: 403,
      type: 'satellite_principal_not_allowed',
      message: 'API key principal is not allowed for this satellite endpoint',
    };
  }
  return null;
}

function verifyMtlsAuth(
  auth: SatelliteEndpointAuthConfig,
  headers: HeaderMap,
  principal: ApiAuthPrincipal,
): SatelliteClaimErrorResolution | null {
  const apiKeyError = verifyApiKeyAuth(auth, principal);
  if (apiKeyError) return apiKeyError;

  const presentedFingerprint = readHeader(headers, SATELLITE_CLAIM_HEADERS.clientCertFingerprintSha256, 160);
  const presentedSpki = readHeader(headers, SATELLITE_CLAIM_HEADERS.clientCertSpkiSha256, 160);
  const presentedSubject = readHeader(headers, SATELLITE_CLAIM_HEADERS.clientCertSubject, 512);
  const presentedSan = readHeader(headers, SATELLITE_CLAIM_HEADERS.clientCertSan, 512);

  const fingerprintMatches = auth.clientCertFingerprintSha256 && presentedFingerprint
    ? normalizeSha256Hex(presentedFingerprint, 'X-PSFN-Client-Cert-Fingerprint-SHA256') === auth.clientCertFingerprintSha256
    : false;
  const spkiMatches = auth.clientCertSpkiSha256 && presentedSpki
    ? normalizeSha256Hex(presentedSpki, 'X-PSFN-Client-Cert-SPKI-SHA256') === auth.clientCertSpkiSha256
    : false;
  const subjectMatches = auth.clientCertSubject && presentedSubject
    ? presentedSubject === auth.clientCertSubject
    : false;
  const sanMatches = auth.clientCertSan && presentedSan
    ? presentedSan === auth.clientCertSan
    : false;

  if (!fingerprintMatches && !spkiMatches && !subjectMatches && !sanMatches) {
    return {
      ok: false,
      status: 403,
      type: 'satellite_certificate_not_allowed',
      message: 'Satellite client certificate binding did not match the registry',
    };
  }
  return null;
}

function verifySatelliteAuth(
  auth: SatelliteEndpointAuthConfig,
  headers: HeaderMap,
  principal: ApiAuthPrincipal,
): SatelliteClaimErrorResolution | null {
  if (auth.mode === 'api_key') {
    return verifyApiKeyAuth(auth, principal);
  }
  return verifyMtlsAuth(auth, headers, principal);
}

function satelliteClaimError(status: number, type: string, message: string): SatelliteClaimResolution {
  return { ok: false, status, type, message };
}

function satelliteConfigPullError(status: number, type: string, message: string): SatelliteConfigPullResolution {
  return { ok: false, status, type, message };
}

export function resolveSatelliteClaim(options: {
  headers: HeaderMap;
  principal: ApiAuthPrincipal;
  registry?: SatelliteRegistryConfig;
}): SatelliteClaimResolution {
  const { headers, principal, registry } = options;
  if (!hasSatelliteClaimHeaders(headers)) {
    return satelliteClaimError(400, 'invalid_request', 'No satellite claim headers were provided');
  }
  if (!registry?.enabled) {
    return satelliteClaimError(503, 'satellite_registry_not_configured', 'Satellite claims require an enabled satellites.json registry');
  }

  const claimTypeRaw = readHeader(headers, SATELLITE_CLAIM_HEADERS.claimType, 64);
  const satelliteId = readHeader(headers, SATELLITE_CLAIM_HEADERS.satelliteId, 128);
  const endpointId = readHeader(headers, SATELLITE_CLAIM_HEADERS.endpointId, 128);
  const sessionIdRaw = readHeader(headers, SATELLITE_CLAIM_HEADERS.sessionId, 128)
    ?? readHeader(headers, SATELLITE_CLAIM_HEADERS.threadId, 128);
  if (!claimTypeRaw || !satelliteId || !endpointId || !sessionIdRaw) {
    return satelliteClaimError(
      400,
      'invalid_satellite_claim',
      'Satellite claims require X-PSFN-Satellite-Claim-Type, X-PSFN-Satellite-ID, X-PSFN-Satellite-Endpoint-ID, and X-PSFN-Satellite-Session-ID',
    );
  }

  let claimType: string;
  let sessionId: string;
  try {
    claimType = assertClaimType(claimTypeRaw, 'X-PSFN-Satellite-Claim-Type');
    assertIdToken(satelliteId, 'X-PSFN-Satellite-ID');
    assertIdToken(endpointId, 'X-PSFN-Satellite-Endpoint-ID');
    sessionId = sessionIdRaw.trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('X-PSFN-Satellite-Session-ID must use only letters, numbers, dot, underscore, dash, or colon');
    }
  } catch (error) {
    return satelliteClaimError(400, 'invalid_satellite_claim', toErrorMessage(error));
  }

  const match = findEndpoint({ registry, satelliteId, endpointId, claimType });
  if (!match) {
    return satelliteClaimError(403, 'satellite_claim_not_registered', 'Satellite claim is not registered for this satellite endpoint');
  }

  const authError = verifySatelliteAuth(match.endpoint.auth, headers, principal);
  if (authError) return authError;

  let capabilities: SatelliteRoutingMetadata['capabilities'];
  let telemetryScopes: SatelliteTelemetryScope[];
  try {
    capabilities = resolveEffectiveCapabilities({
      registryMax: match.endpoint.maxCapabilities,
      advertised: parseClaimCapabilities(readHeader(headers, SATELLITE_CLAIM_HEADERS.capabilities, 1024)),
    });
    telemetryScopes = resolveEffectiveTelemetryScopes({
      registryAllowed: match.endpoint.telemetryScopes,
      requested: parseClaimTelemetryScopes(readHeader(headers, SATELLITE_CLAIM_HEADERS.telemetryScopes, 1024)),
    });
  } catch (error) {
    return satelliteClaimError(403, 'satellite_capability_not_allowed', toErrorMessage(error));
  }

  const satelliteMetadata: SatelliteRoutingMetadata = {
    schemaVersion: 1,
    satelliteId: match.satellite.satelliteId,
    satelliteDisplayName: match.satellite.displayName,
    endpointId: match.endpoint.endpointId,
    endpointDisplayName: match.endpoint.displayName,
    claimType,
    sessionId,
    mobility: match.satellite.mobility,
    promptChannelType: match.endpoint.promptChannelType,
    ...(match.satellite.staticLocationLabel ? { staticLocationLabel: match.satellite.staticLocationLabel } : {}),
    capabilities,
    telemetryScopes,
    auth: {
      mode: match.endpoint.auth.mode,
      principalId: principal.id,
      certBound: match.endpoint.auth.mode === 'mtls',
    },
  };

  return {
    ok: true,
    value: {
      channelId: `satellite:${claimType}:${sessionId}`,
      authorId: match.endpoint.defaultIdentity.authorId,
      authorName: match.endpoint.defaultIdentity.authorName,
      canonicalContactId: match.endpoint.defaultIdentity.canonicalContactId,
      channelPrivacy: match.endpoint.defaultIdentity.channelPrivacy,
      satellite: satelliteMetadata,
    },
  };
}

export function resolveSatelliteConfigPull(options: {
  headers: HeaderMap;
  principal: ApiAuthPrincipal;
  registry?: SatelliteRegistryConfig;
  satelliteId: string | undefined;
  endpointId: string | undefined;
  claimType: string | undefined;
}): SatelliteConfigPullResolution {
  const { headers, principal, registry } = options;
  if (!registry?.enabled) {
    return satelliteConfigPullError(503, 'satellite_registry_not_configured', 'Satellite config pulls require an enabled satellites.json registry');
  }
  if (!options.satelliteId || !options.endpointId || !options.claimType) {
    return satelliteConfigPullError(
      400,
      'invalid_satellite_config_request',
      'Satellite config pulls require satelliteId, endpointId, and claimType query parameters',
    );
  }

  let satelliteId: string;
  let endpointId: string;
  let claimType: string;
  try {
    satelliteId = assertIdToken(options.satelliteId.trim(), 'satelliteId');
    endpointId = assertIdToken(options.endpointId.trim(), 'endpointId');
    claimType = assertClaimType(options.claimType, 'claimType');
  } catch (error) {
    return satelliteConfigPullError(400, 'invalid_satellite_config_request', toErrorMessage(error));
  }

  const match = findEndpoint({ registry, satelliteId, endpointId, claimType });
  if (!match) {
    return satelliteConfigPullError(403, 'satellite_config_not_registered', 'Satellite config pull is not registered for this satellite endpoint');
  }

  const authError = verifySatelliteAuth(match.endpoint.auth, headers, principal);
  if (authError) {
    return satelliteConfigPullError(authError.status, authError.type, authError.message);
  }

  try {
    return {
      ok: true,
      value: buildSatelliteConfigPullResponse({
        satellite: match.satellite,
        endpoint: match.endpoint,
        claimType,
        principal,
      }),
    };
  } catch (error) {
    return satelliteConfigPullError(503, 'satellite_runtime_config_not_configured', toErrorMessage(error));
  }
}
