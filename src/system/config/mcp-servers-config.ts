import { isIP } from 'node:net';
import { join } from 'node:path';
import type { CredentialReference } from '../../shared/contracts/credential-contracts.js';
import type { SensitivityLevel, TrustLevel } from '../trust/types.js';
import { envCredential } from '../../boundary/custody/credential-vault.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  assertNoUnknownKeys,
  isRecord,
  normalizeStringArray,
} from '../../shared/utils/types.js';
import { loadRequiredJson, loadSeedJson } from './load-or-seed.js';

export const MCP_SERVERS_FILE_NAME = 'mcp-servers.json';
export const MCP_SERVERS_SEED_FILE_NAME = 'mcp-servers.seed.json';

const ERROR_PREFIX = 'Invalid MCP servers config';
const SERVER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const RESERVED_AUTH_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'mcp-method',
  'mcp-protocol-version',
  'mcp-session-id',
  'proxy-authorization',
  'transfer-encoding',
]);

export const MCP_SYSTEM_TRUST_HOSTING_VALUES = [
  'loopback',
  'private_network',
  'remote_dedicated',
  'remote_shared',
] as const;
export type McpSystemTrustHosting = typeof MCP_SYSTEM_TRUST_HOSTING_VALUES[number];

export const MCP_SYSTEM_DATA_OWNERSHIP_VALUES = [
  'operator_private',
  'operator_work',
  'mixed',
  'third_party',
] as const;
export type McpSystemDataOwnership = typeof MCP_SYSTEM_DATA_OWNERSHIP_VALUES[number];

export const MCP_SYSTEM_INPUT_EXPOSURE_VALUES = [
  'closed',
  'operator_authenticated',
  'multi_party',
  'public_untrusted',
] as const;
export type McpSystemInputExposure = typeof MCP_SYSTEM_INPUT_EXPOSURE_VALUES[number];

export const MCP_TOOL_EFFECT_VALUES = [
  'read',
  'write',
  'read_write',
  'destructive',
  'control',
] as const;
export type McpToolEffect = typeof MCP_TOOL_EFFECT_VALUES[number];

export const MCP_CONFIRMATION_VALUES = ['never', 'sensitive', 'always'] as const;
export type McpConfirmationMode = typeof MCP_CONFIRMATION_VALUES[number];

export interface McpSystemTrustFactors {
  hosting: McpSystemTrustHosting;
  dataOwnership: McpSystemDataOwnership;
  inputExposure: McpSystemInputExposure;
}

export interface McpSystemTrustConfig {
  level: TrustLevel;
  factors: McpSystemTrustFactors;
  /** Optional operator restriction. It may narrow, but never widen, the trust-level ceiling. */
  allowedOutboundSensitivity?: SensitivityLevel[];
}

export interface McpToolPolicyEntry {
  effect: McpToolEffect;
  confirmation: McpConfirmationMode;
}

export interface McpToolPolicyConfig {
  /** Unknown tools always fail closed. Version 1 deliberately supports no permissive default. */
  default: 'deny';
  tools: Record<string, McpToolPolicyEntry>;
}

export type McpAuthenticationConfig =
  | { kind: 'bearer'; tokenRef: CredentialReference }
  | { kind: 'api_key'; headerName: string; valueRef: CredentialReference }
  | {
      kind: 'oauth_client_credentials';
      clientId: string;
      clientSecretRef: CredentialReference;
      tokenEndpoint: string;
      expectedIssuer: string;
      scopes: string[];
    };

export interface McpTlsConfig {
  caCertificateRef: CredentialReference;
}

export interface McpServerConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  description: string;
  endpoint: string;
  tls?: McpTlsConfig;
  allowedCompanionIds: string[];
  authentication: McpAuthenticationConfig;
  trust: McpSystemTrustConfig;
  toolPolicy: McpToolPolicyConfig;
}

export interface McpRuntimeLimits {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  idleConnectionTtlMs: number;
  metadataCacheTtlMs: number;
  maxCatalogToolsPerServer: number;
  maxPaginationPages: number;
  maxStaticMetadataBytes: number;
  maxDynamicOutputBytes: number;
}

export interface McpServersConfig {
  schemaVersion: 1;
  limits: McpRuntimeLimits;
  servers: McpServerConfig[];
}

const TRUST_ORDER: Readonly<Record<TrustLevel, number>> = {
  public: 0,
  regular: 1,
  trusted: 2,
  primary: 3,
};

const HOSTING_CEILING: Readonly<Record<McpSystemTrustHosting, number>> = {
  loopback: 3,
  private_network: 2,
  remote_dedicated: 2,
  remote_shared: 1,
};

const DATA_CEILING: Readonly<Record<McpSystemDataOwnership, number>> = {
  operator_private: 3,
  operator_work: 2,
  mixed: 1,
  third_party: 0,
};

const INPUT_CEILING: Readonly<Record<McpSystemInputExposure, number>> = {
  closed: 3,
  operator_authenticated: 2,
  multi_party: 1,
  public_untrusted: 0,
};

const DEFAULT_SENSITIVITY_BY_TRUST: Readonly<Record<TrustLevel, readonly SensitivityLevel[]>> = {
  public: ['public'],
  regular: ['public', 'personal'],
  trusted: ['public', 'personal'],
  primary: ['public', 'personal', 'intimate', 'confidential'],
};

function fail(field: string, detail: string): never {
  throw new Error(`${ERROR_PREFIX}: ${field} ${detail}`);
}

function requiredString(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string') fail(field, 'must be a string');
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    fail(field, `must contain 1-${maximum} characters`);
  }
  return normalized;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field, 'must be a boolean');
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(field, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(field, `must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function credentialReference(value: unknown, field: string): CredentialReference {
  if (!isRecord(value)) fail(field, 'must be an env credential reference');
  assertNoUnknownKeys(value, ['kind', 'envName'], field, { errorPrefix: ERROR_PREFIX });
  if (value.kind !== 'env') fail(`${field}.kind`, 'must be "env"');
  return envCredential(requiredString(value.envName, `${field}.envName`, 128));
}

function httpsUrl(value: unknown, field: string): string {
  const raw = requiredString(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(field, 'must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:') fail(field, 'must use HTTPS/TLS');
  if (parsed.username || parsed.password) fail(field, 'must not embed credentials');
  if (parsed.hash) fail(field, 'must not contain a fragment');
  return parsed.toString();
}

function normalizeAuthentication(value: unknown, field: string): McpAuthenticationConfig {
  if (!isRecord(value)) fail(field, 'must be an object');
  const kind = value.kind;
  if (kind === 'bearer') {
    assertNoUnknownKeys(value, ['kind', 'tokenRef'], field, { errorPrefix: ERROR_PREFIX });
    return { kind, tokenRef: credentialReference(value.tokenRef, `${field}.tokenRef`) };
  }
  if (kind === 'api_key') {
    assertNoUnknownKeys(value, ['kind', 'headerName', 'valueRef'], field, { errorPrefix: ERROR_PREFIX });
    const headerName = requiredString(value.headerName, `${field}.headerName`, 128);
    if (!HEADER_NAME_PATTERN.test(headerName)) fail(`${field}.headerName`, 'is not a valid HTTP header name');
    if (RESERVED_AUTH_HEADER_NAMES.has(headerName.toLowerCase())) {
      fail(`${field}.headerName`, 'is reserved for transport custody');
    }
    return { kind, headerName, valueRef: credentialReference(value.valueRef, `${field}.valueRef`) };
  }
  if (kind === 'oauth_client_credentials') {
    assertNoUnknownKeys(
      value,
      ['kind', 'clientId', 'clientSecretRef', 'tokenEndpoint', 'expectedIssuer', 'scopes'],
      field,
      { errorPrefix: ERROR_PREFIX },
    );
    const scopes = normalizeStringArray(value.scopes, `${field}.scopes`, { errorPrefix: ERROR_PREFIX });
    const tokenEndpoint = httpsUrl(value.tokenEndpoint, `${field}.tokenEndpoint`);
    const expectedIssuer = httpsUrl(value.expectedIssuer, `${field}.expectedIssuer`);
    if (new URL(tokenEndpoint).origin !== new URL(expectedIssuer).origin) {
      fail(
        `${field}.tokenEndpoint`,
        'must use the same origin as authentication.expectedIssuer',
      );
    }
    return {
      kind,
      clientId: requiredString(value.clientId, `${field}.clientId`, 256),
      clientSecretRef: credentialReference(value.clientSecretRef, `${field}.clientSecretRef`),
      tokenEndpoint,
      expectedIssuer,
      scopes,
    };
  }
  fail(`${field}.kind`, 'must be bearer, api_key, or oauth_client_credentials');
}

function normalizeTls(value: unknown, field: string): McpTlsConfig {
  if (!isRecord(value)) fail(field, 'must be an object');
  assertNoUnknownKeys(value, ['caCertificateRef'], field, { errorPrefix: ERROR_PREFIX });
  return {
    caCertificateRef: credentialReference(value.caCertificateRef, `${field}.caCertificateRef`),
  };
}

function normalizeTrust(value: unknown, field: string): McpSystemTrustConfig {
  if (!isRecord(value)) fail(field, 'must be an object');
  assertNoUnknownKeys(value, ['level', 'factors', 'allowedOutboundSensitivity'], field, {
    errorPrefix: ERROR_PREFIX,
  });
  if (!isRecord(value.factors)) fail(`${field}.factors`, 'must be an object');
  assertNoUnknownKeys(value.factors, ['hosting', 'dataOwnership', 'inputExposure'], `${field}.factors`, {
    errorPrefix: ERROR_PREFIX,
  });
  const level = enumValue(value.level, ['primary', 'trusted', 'regular', 'public'] as const, `${field}.level`);
  const factors: McpSystemTrustFactors = {
    hosting: enumValue(value.factors.hosting, MCP_SYSTEM_TRUST_HOSTING_VALUES, `${field}.factors.hosting`),
    dataOwnership: enumValue(
      value.factors.dataOwnership,
      MCP_SYSTEM_DATA_OWNERSHIP_VALUES,
      `${field}.factors.dataOwnership`,
    ),
    inputExposure: enumValue(
      value.factors.inputExposure,
      MCP_SYSTEM_INPUT_EXPOSURE_VALUES,
      `${field}.factors.inputExposure`,
    ),
  };
  const factorCeiling = Math.min(
    HOSTING_CEILING[factors.hosting],
    DATA_CEILING[factors.dataOwnership],
    INPUT_CEILING[factors.inputExposure],
  );
  if (TRUST_ORDER[level] > factorCeiling) {
    fail(`${field}.level`, `cannot exceed the ceiling derived from hosting/data/input factors`);
  }

  let allowedOutboundSensitivity: SensitivityLevel[] | undefined;
  if (value.allowedOutboundSensitivity !== undefined) {
    const requested = normalizeStringArray(
      value.allowedOutboundSensitivity,
      `${field}.allowedOutboundSensitivity`,
      { errorPrefix: ERROR_PREFIX },
    ).map(entry => enumValue(
      entry,
      ['public', 'personal', 'intimate', 'confidential'] as const,
      `${field}.allowedOutboundSensitivity`,
    ));
    const ceiling = new Set(DEFAULT_SENSITIVITY_BY_TRUST[level]);
    if (requested.some(entry => !ceiling.has(entry))) {
      fail(`${field}.allowedOutboundSensitivity`, `cannot widen the ${level} trust ceiling`);
    }
    allowedOutboundSensitivity = requested;
  }

  return {
    level,
    factors,
    ...(allowedOutboundSensitivity ? { allowedOutboundSensitivity } : {}),
  };
}

function normalizeToolPolicy(value: unknown, field: string): McpToolPolicyConfig {
  if (!isRecord(value)) fail(field, 'must be an object');
  assertNoUnknownKeys(value, ['default', 'tools'], field, { errorPrefix: ERROR_PREFIX });
  if (value.default !== 'deny') fail(`${field}.default`, 'must be "deny"');
  if (!isRecord(value.tools)) fail(`${field}.tools`, 'must be an object');
  const tools: Record<string, McpToolPolicyEntry> = {};
  for (const [toolName, rawPolicy] of Object.entries(value.tools)) {
    if (!TOOL_NAME_PATTERN.test(toolName)) fail(`${field}.tools`, `contains invalid tool name "${toolName}"`);
    if (!isRecord(rawPolicy)) fail(`${field}.tools.${toolName}`, 'must be an object');
    assertNoUnknownKeys(rawPolicy, ['effect', 'confirmation'], `${field}.tools.${toolName}`, {
      errorPrefix: ERROR_PREFIX,
    });
    const effect = enumValue(
      rawPolicy.effect,
      MCP_TOOL_EFFECT_VALUES,
      `${field}.tools.${toolName}.effect`,
    );
    const confirmation = enumValue(
        rawPolicy.confirmation,
        MCP_CONFIRMATION_VALUES,
        `${field}.tools.${toolName}.confirmation`,
    );
    if ((effect === 'destructive' || effect === 'control') && confirmation !== 'always') {
      fail(
        `${field}.tools.${toolName}.confirmation`,
        `${effect} tools must use confirmation "always"`,
      );
    }
    tools[toolName] = { effect, confirmation };
  }
  return { default: 'deny', tools };
}

function normalizeLimits(value: unknown, field: string): McpRuntimeLimits {
  if (!isRecord(value)) fail(field, 'must be an object');
  const keys = [
    'connectTimeoutMs',
    'requestTimeoutMs',
    'idleConnectionTtlMs',
    'metadataCacheTtlMs',
    'maxCatalogToolsPerServer',
    'maxPaginationPages',
    'maxStaticMetadataBytes',
    'maxDynamicOutputBytes',
  ] as const;
  assertNoUnknownKeys(value, keys, field, { errorPrefix: ERROR_PREFIX });
  return {
    connectTimeoutMs: positiveInteger(value.connectTimeoutMs, `${field}.connectTimeoutMs`, 300_000),
    requestTimeoutMs: positiveInteger(value.requestTimeoutMs, `${field}.requestTimeoutMs`, 3_600_000),
    idleConnectionTtlMs: positiveInteger(value.idleConnectionTtlMs, `${field}.idleConnectionTtlMs`, 86_400_000),
    metadataCacheTtlMs: positiveInteger(value.metadataCacheTtlMs, `${field}.metadataCacheTtlMs`, 86_400_000),
    maxCatalogToolsPerServer: positiveInteger(
      value.maxCatalogToolsPerServer,
      `${field}.maxCatalogToolsPerServer`,
      10_000,
    ),
    maxPaginationPages: positiveInteger(value.maxPaginationPages, `${field}.maxPaginationPages`, 256),
    maxStaticMetadataBytes: positiveInteger(
      value.maxStaticMetadataBytes,
      `${field}.maxStaticMetadataBytes`,
      16_777_216,
    ),
    maxDynamicOutputBytes: positiveInteger(
      value.maxDynamicOutputBytes,
      `${field}.maxDynamicOutputBytes`,
      67_108_864,
    ),
  };
}

function hostnameIsLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isIP(normalized) === 4) return normalized.startsWith('127.');
  return normalized === '[::1]' || normalized === '::1';
}

function normalizeServer(value: unknown, field: string): McpServerConfig {
  if (!isRecord(value)) fail(field, 'must be an object');
  assertNoUnknownKeys(
    value,
    [
      'id',
      'displayName',
      'enabled',
      'description',
      'endpoint',
      'tls',
      'allowedCompanionIds',
      'authentication',
      'trust',
      'toolPolicy',
    ],
    field,
    { errorPrefix: ERROR_PREFIX },
  );
  const id = requiredString(value.id, `${field}.id`, 64).toLowerCase();
  if (!SERVER_ID_PATTERN.test(id)) fail(`${field}.id`, 'must be a lowercase key-safe identifier');
  const endpoint = httpsUrl(value.endpoint, `${field}.endpoint`);
  const trust = normalizeTrust(value.trust, `${field}.trust`);
  if (trust.factors.hosting === 'loopback' && !hostnameIsLoopback(new URL(endpoint).hostname)) {
    fail(`${field}.trust.factors.hosting`, 'claims loopback but endpoint is not loopback');
  }
  const allowedCompanionIds = normalizeStringArray(
    value.allowedCompanionIds,
    `${field}.allowedCompanionIds`,
    { errorPrefix: ERROR_PREFIX },
  );
  if (allowedCompanionIds.length === 0) fail(`${field}.allowedCompanionIds`, 'must not be empty');
  return {
    id,
    displayName: requiredString(value.displayName, `${field}.displayName`, 128),
    enabled: requiredBoolean(value.enabled, `${field}.enabled`),
    description: requiredString(value.description, `${field}.description`, 1_024),
    endpoint,
    ...(value.tls === undefined ? {} : { tls: normalizeTls(value.tls, `${field}.tls`) }),
    allowedCompanionIds,
    authentication: normalizeAuthentication(value.authentication, `${field}.authentication`),
    trust,
    toolPolicy: normalizeToolPolicy(value.toolPolicy, `${field}.toolPolicy`),
  };
}

export function validateMcpServersConfig(raw: unknown, sourcePath: string): McpServersConfig {
  if (!isRecord(raw)) fail(sourcePath, 'must contain an object');
  assertNoUnknownKeys(raw, ['schemaVersion', 'limits', 'servers'], sourcePath, { errorPrefix: ERROR_PREFIX });
  if (raw.schemaVersion !== 1) fail(`${sourcePath}.schemaVersion`, 'must be 1');
  if (!Array.isArray(raw.servers)) fail(`${sourcePath}.servers`, 'must be an array');
  const seen = new Set<string>();
  const servers = raw.servers.map((server, index) => {
    const normalized = normalizeServer(server, `${sourcePath}.servers[${index}]`);
    if (seen.has(normalized.id)) fail(`${sourcePath}.servers[${index}].id`, `duplicates "${normalized.id}"`);
    seen.add(normalized.id);
    return normalized;
  });
  return {
    schemaVersion: 1,
    limits: normalizeLimits(raw.limits, `${sourcePath}.limits`),
    servers,
  };
}

export function loadMcpServersConfig(
  dataDir: string,
  options: { seedDir?: string } = {},
): McpServersConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, MCP_SERVERS_FILE_NAME),
    examplePath: join(seedDir, MCP_SERVERS_SEED_FILE_NAME),
    validate: validateMcpServersConfig,
  });
}

export function loadMcpServersSeedDefaults(
  options: { seedDir?: string } = {},
): McpServersConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadSeedJson({
    seedPath: join(seedDir, MCP_SERVERS_SEED_FILE_NAME),
    validate: validateMcpServersConfig,
  });
}

export function saveMcpServersConfig(dataDir: string, value: unknown): McpServersConfig {
  const validated = validateMcpServersConfig(value, MCP_SERVERS_FILE_NAME);
  writeJsonAtomic(join(dataDir, MCP_SERVERS_FILE_NAME), validated);
  return validated;
}
