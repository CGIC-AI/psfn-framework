import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CredentialReference,
  CredentialVaultPort,
} from '../../boundary/custody/credential-vault.js';
import { envCredential } from '../../boundary/custody/credential-vault.js';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import { parseBooleanEnv } from '../../shared/utils/env.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { loadRequiredJson } from './load-or-seed.js';
import type {
  HubDeviceAssertionVerifierConfig,
  HubDeviceAssertionVerifierKey,
} from '../../boundary/fleet-auth/hub-device-assertion.js';
import {
  assertBrokerSigningKeyNotTrustedByHub,
  assertFleetAuthPublicKeyBoundary,
  canonicalEd25519SpkiFingerprint,
} from './fleet-auth-key-boundary.js';

export const FLEET_AUTH_ENV_VAR = 'PSFN_FLEET_AUTH';
export const FLEET_AUTH_FILE_NAME = 'fleet-auth.json';
export const FLEET_AUTH_SEED_FILE_NAME = 'fleet-auth.seed.json';

const ERROR_PREFIX = 'Invalid fleet auth config';
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const POSTGRES_ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const DISCORD_SNOWFLAKE_PATTERN = /^[1-9][0-9]{16,19}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OAUTH_SCOPES = ['identify', 'guilds', 'guilds.members.read'] as const;

export const FLEET_AUTH_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type FleetAuthRole = typeof FLEET_AUTH_ROLES[number];

/**
 * Stable action vocabulary accepted by the persistence/config substrate.
 * Role evaluation is implemented by opl1.5; this owner file can only disable
 * members of this closed vocabulary and therefore cannot widen that policy.
 */
export const FLEET_AUTH_ACTIONS = [
  'companion.read',
  'garden.read',
  'settings.read',
  'settings.write',
  'tools.execute',
  'contacts.bind',
  'roles.manage',
  'memory.read.self',
  'memory.jit.self',
  'devices.manage',
  'provider.link',
] as const;
export type FleetAuthAction = typeof FLEET_AUTH_ACTIONS[number];

export type FleetAuthVerifierKeyStatus = 'active' | 'retiring' | 'revoked';

export interface FleetAuthVerifierKey {
  issuer: string;
  kid: string;
  publicKeyPem: string;
  notBefore: string;
  notAfter: string;
  status: FleetAuthVerifierKeyStatus;
}

export interface FleetAuthConfig {
  schemaVersion: 1;
  /** Operator-incremented when retained state is deliberately re-enabled. */
  activationGeneration: number;
  canonicalOrigin: string;
  callbackPath: string;
  provider: {
    kind: 'discord';
    clientId: string;
    scopes: Array<typeof OAUTH_SCOPES[number]>;
    clientSecretRef: CredentialReference;
    tokenCustody: 'discard' | 'encrypted_refresh';
  };
  credentials: {
    tokenEncryptionKeyRef: CredentialReference;
    sessionPepperRef: CredentialReference;
    assertionPrivateKeyRef: CredentialReference;
    trustedHostRecoveryCredentialRef: CredentialReference;
    runtimeDatabaseUrlRef: CredentialReference;
    migrationDatabaseUrlRef: CredentialReference;
    backupRestoreDatabaseUrlRef: CredentialReference;
    authorityFloorRootRef: CredentialReference;
  };
  databaseRoles: {
    runtime: string;
    migration: string;
    backupRestore: string;
  };
  verifierKeys: FleetAuthVerifierKey[];
  hubDeviceAssertions: HubDeviceAssertionVerifierConfig;
  ttls: {
    oauthTransactionMs: number;
    sessionIdleMs: number;
    sessionAbsoluteMs: number;
    discordEvidenceMs: number;
    jitGrantMs: number;
    stepUpChallengeMs: number;
    internalAssertionMs: number;
  };
  rolePolicy: {
    disabledActionsByRole: Record<FleetAuthRole, FleetAuthAction[]>;
  };
  discordEvidenceMappings: Array<{
    guildId: string;
    channelId?: string;
    companionId: string;
    requiredRoleIds: string[];
  }>;
}

export interface FleetAuthVerifierConfig {
  kind: 'verifier';
  enabled: true;
  canonicalOrigin: string;
  requestCapabilities: {
    issuer: string;
    maxTtlSeconds: number;
    keys: FleetAuthVerifierKey[];
  };
  hubDeviceAssertions: HubDeviceAssertionVerifierConfig;
}

export interface FleetAuthGatewayConfig {
  kind: 'gateway';
  enabled: true;
  config: FleetAuthConfig;
}

export type FleetAuthRuntimeProjection = FleetAuthGatewayConfig | FleetAuthVerifierConfig;

export interface ResolvedGatewayFleetAuthSecrets {
  oauthClientSecret: string;
  tokenEncryptionKey: string;
  sessionPepper: string;
  assertionPrivateKeyPem: string;
  assertionSigningKid: string;
  trustedHostRecoveryCredential: string;
  authorityFloorRoot: string;
  database: {
    runtimeUrl: string;
    migrationUrl: string;
    backupRestoreUrl: string;
  };
}

export interface FleetAuthGardenMetadata {
  enabled: true;
  canonicalOrigin: string;
  callbackPath: string;
  activationGeneration: number;
  provider: Pick<FleetAuthConfig['provider'], 'kind' | 'scopes' | 'tokenCustody'>;
  ttls: FleetAuthConfig['ttls'];
  rolePolicy: FleetAuthConfig['rolePolicy'];
  discordEvidenceMappings: FleetAuthConfig['discordEvidenceMappings'];
  verifierKeys: Array<Pick<FleetAuthVerifierKey, 'issuer' | 'kid' | 'notBefore' | 'notAfter' | 'status'>>;
  hubDeviceAssertions: Omit<HubDeviceAssertionVerifierConfig, 'keys'> & {
    keys: Array<Pick<HubDeviceAssertionVerifierKey, 'kid' | 'notBefore' | 'notAfter' | 'status'>>;
  };
}

function fail(message: string): never {
  throw new Error(`${ERROR_PREFIX}: ${message}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} must be an object`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  assertNoUnknownKeys(value, keys, field, { errorPrefix: ERROR_PREFIX });
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${field}.${key} is required`);
  }
}

function parseCredentialReference(value: unknown, field: string): CredentialReference {
  const record = requireRecord(value, field);
  requireExactKeys(record, ['kind', 'envName'], field);
  if (record.kind !== 'env') fail(`${field}.kind must be "env"`);
  const envName = requireString(record.envName, `${field}.envName`);
  if (!ENV_NAME_PATTERN.test(envName)) fail(`${field}.envName must be an uppercase environment name`);
  return envCredential(envName);
}

function parseCanonicalOrigin(value: unknown): string {
  const raw = requireString(value, 'canonicalOrigin');
  if (raw.includes('*')) fail('canonicalOrigin must not contain a wildcard');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail('canonicalOrigin must be a valid URL');
  }
  if (parsed.protocol !== 'https:') fail('canonicalOrigin must use https');
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail('canonicalOrigin must contain only an exact https origin');
  }
  if (raw.endsWith('/')) fail('canonicalOrigin must not have a trailing slash');
  if (raw !== parsed.origin) fail('canonicalOrigin must already be in exact normalized form');
  return parsed.origin;
}

function parseCallbackPath(value: unknown): string {
  const path = requireString(value, 'callbackPath');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')
    || path.includes('\\') || /%2f|%5c/iu.test(path)) {
    fail('callbackPath must be an absolute path without a host, query, or fragment');
  }
  const base = 'https://fleet.invalid';
  const parsed = new URL(path, base);
  if (parsed.origin !== base || parsed.pathname !== path) {
    fail('callbackPath must be an exact normalized path');
  }
  return path;
}

function parseScopes(value: unknown): Array<typeof OAUTH_SCOPES[number]> {
  if (!Array.isArray(value) || value.length === 0) fail('provider.scopes must be a non-empty array');
  const allowed = new Set<string>(OAUTH_SCOPES);
  const scopes = value.map((entry, index) => {
    const scope = requireString(entry, `provider.scopes[${index}]`);
    if (!allowed.has(scope)) fail(`provider.scopes[${index}] is unknown`);
    return scope as typeof OAUTH_SCOPES[number];
  });
  if (new Set(scopes).size !== scopes.length) fail('provider.scopes must not contain duplicates');
  if (!scopes.includes('identify')) fail('provider.scopes must include identify');
  return scopes;
}

function parseVerifierKeys(value: unknown): FleetAuthVerifierKey[] {
  if (!Array.isArray(value) || value.length === 0) fail('verifierKeys must be a non-empty array');
  const seen = new Set<string>();
  let activeCount = 0;
  const keys = value.map((entry, index): FleetAuthVerifierKey => {
    const field = `verifierKeys[${index}]`;
    const record = requireRecord(entry, field);
    requireExactKeys(record, ['issuer', 'kid', 'publicKeyPem', 'notBefore', 'notAfter', 'status'], field);
    const issuer = requireString(record.issuer, `${field}.issuer`);
    const kid = requireString(record.kid, `${field}.kid`);
    if (!KEY_ID_PATTERN.test(issuer) || !KEY_ID_PATTERN.test(kid)) {
      fail(`${field}.issuer and kid must use stable identifier characters`);
    }
    const identity = `${issuer}\u0000${kid}`;
    if (seen.has(identity)) fail(`duplicate verifier key ${issuer}/${kid}`);
    seen.add(identity);
    const publicKeyPem = requireString(record.publicKeyPem, `${field}.publicKeyPem`);
    if (publicKeyPem.includes('PRIVATE KEY')) fail(`${field}.publicKeyPem must be a public Ed25519 key`);
    try {
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') fail(`${field}.publicKeyPem must be a public Ed25519 key`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(ERROR_PREFIX)) throw error;
      fail(`${field}.publicKeyPem must be a public Ed25519 key`);
    }
    const notBefore = requireString(record.notBefore, `${field}.notBefore`);
    const notAfter = requireString(record.notAfter, `${field}.notAfter`);
    if (!isCanonicalIsoTimestamp(notBefore) || !isCanonicalIsoTimestamp(notAfter)) {
      fail(`${field} must have an ordered ISO validity window`);
    }
    const start = Date.parse(notBefore);
    const end = Date.parse(notAfter);
    if (start >= end) {
      fail(`${field} must have an ordered ISO validity window`);
    }
    if (record.status !== 'active' && record.status !== 'retiring' && record.status !== 'revoked') {
      fail(`${field}.status must be active, retiring, or revoked`);
    }
    if (record.status === 'active') activeCount += 1;
    return { issuer, kid, publicKeyPem, notBefore, notAfter, status: record.status };
  });
  if (activeCount !== 1) fail('verifierKeys must contain exactly one active verifier key');
  const activeKey = keys.find(key => key.status === 'active')!;
  const now = Date.now();
  if (Date.parse(activeKey.notBefore) > now || Date.parse(activeKey.notAfter) <= now) {
    fail('the active verifier key must be inside its configured validity window');
  }
  return keys;
}

function parseHubDeviceAssertions(value: unknown): HubDeviceAssertionVerifierConfig {
  const field = 'hubDeviceAssertions';
  const record = requireRecord(value, field);
  requireExactKeys(record, ['issuer', 'audience', 'maxTtlSeconds', 'clockSkewSeconds', 'keys'], field);
  const issuer = requireString(record.issuer, `${field}.issuer`);
  if (!KEY_ID_PATTERN.test(issuer)) fail(`${field}.issuer must use stable identifier characters`);
  const audience = parseExactHttpsOrigin(record.audience, `${field}.audience`);
  const maxTtlSeconds = requireInteger(record.maxTtlSeconds, `${field}.maxTtlSeconds`, 5, 60);
  const clockSkewSeconds = requireInteger(record.clockSkewSeconds, `${field}.clockSkewSeconds`, 0, 10);
  if (!Array.isArray(record.keys) || record.keys.length === 0) {
    fail(`${field}.keys must be a non-empty array`);
  }
  const seen = new Set<string>();
  let activeCount = 0;
  const keys = record.keys.map((entry, index): HubDeviceAssertionVerifierKey => {
    const keyField = `${field}.keys[${index}]`;
    const key = requireRecord(entry, keyField);
    requireExactKeys(key, ['kid', 'publicKeyPem', 'notBefore', 'notAfter', 'status'], keyField);
    const kid = requireString(key.kid, `${keyField}.kid`);
    if (!KEY_ID_PATTERN.test(kid)) fail(`${keyField}.kid must use stable identifier characters`);
    if (seen.has(kid)) fail(`duplicate Hub device assertion key ${kid}`);
    seen.add(kid);
    const publicKeyPem = requireString(key.publicKeyPem, `${keyField}.publicKeyPem`);
    if (publicKeyPem.includes('PRIVATE KEY')) fail(`${keyField}.publicKeyPem must be a public Ed25519 key`);
    try {
      const parsed = createPublicKey(publicKeyPem);
      if (parsed.asymmetricKeyType !== 'ed25519') fail(`${keyField}.publicKeyPem must be a public Ed25519 key`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(ERROR_PREFIX)) throw error;
      fail(`${keyField}.publicKeyPem must be a public Ed25519 key`);
    }
    const notBefore = requireString(key.notBefore, `${keyField}.notBefore`);
    const notAfter = requireString(key.notAfter, `${keyField}.notAfter`);
    if (!isCanonicalIsoTimestamp(notBefore) || !isCanonicalIsoTimestamp(notAfter)
      || Date.parse(notBefore) >= Date.parse(notAfter)) {
      fail(`${keyField} must have an ordered ISO validity window`);
    }
    if (key.status !== 'active' && key.status !== 'retiring' && key.status !== 'revoked') {
      fail(`${keyField}.status must be active, retiring, or revoked`);
    }
    if (key.status === 'active') activeCount += 1;
    return { kid, publicKeyPem, notBefore, notAfter, status: key.status };
  });
  if (activeCount !== 1) fail('Hub device assertion keys must contain exactly one active key');
  const active = keys.find(key => key.status === 'active')!;
  const now = Date.now();
  if (Date.parse(active.notBefore) > now || Date.parse(active.notAfter) <= now) {
    fail('the active Hub device assertion key must be inside its configured validity window');
  }
  return { issuer, audience, maxTtlSeconds, clockSkewSeconds, keys };
}

function parseExactHttpsOrigin(value: unknown, field: string): string {
  const raw = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || raw.endsWith('/')
    || raw !== parsed.origin) {
    fail(`${field} must be an exact normalized https origin`);
  }
  return parsed.origin;
}

function parseDatabaseRoles(value: unknown): FleetAuthConfig['databaseRoles'] {
  const record = requireRecord(value, 'databaseRoles');
  requireExactKeys(record, ['runtime', 'migration', 'backupRestore'], 'databaseRoles');
  const roles = {
    runtime: requireString(record.runtime, 'databaseRoles.runtime'),
    migration: requireString(record.migration, 'databaseRoles.migration'),
    backupRestore: requireString(record.backupRestore, 'databaseRoles.backupRestore'),
  };
  for (const [field, role] of Object.entries(roles)) {
    if (!POSTGRES_ROLE_PATTERN.test(role)) fail(`databaseRoles.${field} is not a safe PostgreSQL role name`);
  }
  if (new Set(Object.values(roles)).size !== 3) fail('databaseRoles must name three distinct roles');
  return roles;
}

function parseTtls(value: unknown): FleetAuthConfig['ttls'] {
  const record = requireRecord(value, 'ttls');
  const keys = [
    'oauthTransactionMs',
    'sessionIdleMs',
    'sessionAbsoluteMs',
    'discordEvidenceMs',
    'jitGrantMs',
    'stepUpChallengeMs',
    'internalAssertionMs',
  ] as const;
  requireExactKeys(record, keys, 'ttls');
  const result = {
    oauthTransactionMs: requireInteger(record.oauthTransactionMs, 'ttls.oauthTransactionMs', 30_000, 900_000),
    sessionIdleMs: requireInteger(record.sessionIdleMs, 'ttls.sessionIdleMs', 60_000, 86_400_000),
    sessionAbsoluteMs: requireInteger(record.sessionAbsoluteMs, 'ttls.sessionAbsoluteMs', 300_000, 604_800_000),
    discordEvidenceMs: requireInteger(record.discordEvidenceMs, 'ttls.discordEvidenceMs', 30_000, 3_600_000),
    jitGrantMs: requireInteger(record.jitGrantMs, 'ttls.jitGrantMs', 30_000, 900_000),
    stepUpChallengeMs: requireInteger(record.stepUpChallengeMs, 'ttls.stepUpChallengeMs', 30_000, 600_000),
    internalAssertionMs: requireInteger(record.internalAssertionMs, 'ttls.internalAssertionMs', 1_000, 60_000),
  };
  if (result.sessionIdleMs >= result.sessionAbsoluteMs) {
    fail('ttls.sessionIdleMs must be less than sessionAbsoluteMs');
  }
  if (result.internalAssertionMs >= result.stepUpChallengeMs) {
    fail('ttls.internalAssertionMs must be less than stepUpChallengeMs');
  }
  if (result.internalAssertionMs % 1_000 !== 0) {
    fail('ttls.internalAssertionMs must resolve to whole seconds');
  }
  if (result.stepUpChallengeMs > result.oauthTransactionMs) {
    fail('ttls.stepUpChallengeMs must not exceed oauthTransactionMs');
  }
  if (result.jitGrantMs > result.sessionIdleMs) fail('ttls.jitGrantMs must not exceed sessionIdleMs');
  return result;
}

function parseRolePolicy(value: unknown): FleetAuthConfig['rolePolicy'] {
  const policy = requireRecord(value, 'rolePolicy');
  requireExactKeys(policy, ['disabledActionsByRole'], 'rolePolicy');
  const rawByRole = requireRecord(policy.disabledActionsByRole, 'rolePolicy.disabledActionsByRole');
  requireExactKeys(rawByRole, FLEET_AUTH_ROLES, 'rolePolicy.disabledActionsByRole');
  const knownActions = new Set<string>(FLEET_AUTH_ACTIONS);
  const disabledActionsByRole = Object.fromEntries(FLEET_AUTH_ROLES.map((role) => {
    const raw = rawByRole[role];
    if (!Array.isArray(raw)) fail(`rolePolicy.disabledActionsByRole.${role} must be an array`);
    const actions = raw.map((entry, index) => {
      const action = requireString(entry, `rolePolicy.disabledActionsByRole.${role}[${index}]`);
      if (!knownActions.has(action)) fail(`rolePolicy.disabledActionsByRole.${role} contains unknown action ${action}`);
      return action as FleetAuthAction;
    });
    if (new Set(actions).size !== actions.length) {
      fail(`rolePolicy.disabledActionsByRole.${role} must not contain duplicates`);
    }
    return [role, actions];
  })) as Record<FleetAuthRole, FleetAuthAction[]>;
  return { disabledActionsByRole };
}

function parseSnowflake(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!DISCORD_SNOWFLAKE_PATTERN.test(id)) fail(`${field} must be a stable Discord snowflake string`);
  return id;
}

function parseMappings(value: unknown): FleetAuthConfig['discordEvidenceMappings'] {
  if (!Array.isArray(value)) fail('discordEvidenceMappings must be an array');
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const field = `discordEvidenceMappings[${index}]`;
    const record = requireRecord(entry, field);
    assertNoUnknownKeys(record, ['guildId', 'channelId', 'companionId', 'requiredRoleIds'], field, {
      errorPrefix: ERROR_PREFIX,
    });
    for (const required of ['guildId', 'companionId', 'requiredRoleIds']) {
      if (!Object.hasOwn(record, required)) fail(`${field}.${required} is required`);
    }
    const guildId = parseSnowflake(record.guildId, `${field}.guildId`);
    const channelId = record.channelId === undefined
      ? undefined
      : parseSnowflake(record.channelId, `${field}.channelId`);
    const companionId = requireString(record.companionId, `${field}.companionId`);
    if (!isRfc4122Uuid(companionId)) fail(`${field}.companionId must be a lowercase RFC-4122 UUID`);
    if (!Array.isArray(record.requiredRoleIds)) fail(`${field}.requiredRoleIds must be an array`);
    const requiredRoleIds = record.requiredRoleIds.map((roleId, roleIndex) => (
      parseSnowflake(roleId, `${field}.requiredRoleIds[${roleIndex}]`)
    ));
    if (new Set(requiredRoleIds).size !== requiredRoleIds.length) {
      fail(`${field}.requiredRoleIds must not contain duplicates`);
    }
    const identity = `${guildId}\u0000${channelId ?? ''}\u0000${companionId}`;
    if (seen.has(identity)) fail(`duplicate Discord evidence mapping at ${field}`);
    seen.add(identity);
    return {
      guildId,
      ...(channelId ? { channelId } : {}),
      companionId,
      requiredRoleIds,
    };
  });
}

export function validateFleetAuthConfig(value: unknown, sourcePath: string): FleetAuthConfig {
  const root = requireRecord(value, 'root');
  requireExactKeys(root, [
    'schemaVersion',
    'activationGeneration',
    'canonicalOrigin',
    'callbackPath',
    'provider',
    'credentials',
    'databaseRoles',
    'verifierKeys',
    'hubDeviceAssertions',
    'ttls',
    'rolePolicy',
    'discordEvidenceMappings',
  ], 'root');
  if (root.schemaVersion !== 1) fail('schemaVersion must be 1');

  const provider = requireRecord(root.provider, 'provider');
  requireExactKeys(provider, ['kind', 'clientId', 'scopes', 'clientSecretRef', 'tokenCustody'], 'provider');
  if (provider.kind !== 'discord') fail('provider.kind must be discord');
  const clientId = parseSnowflake(provider.clientId, 'provider.clientId');
  const scopes = parseScopes(provider.scopes);
  const clientSecretRef = parseCredentialReference(
    provider.clientSecretRef,
    'provider.clientSecretRef',
  );
  if (provider.tokenCustody !== 'discard' && provider.tokenCustody !== 'encrypted_refresh') {
    fail('provider.tokenCustody must be discard or encrypted_refresh');
  }

  const credentials = requireRecord(root.credentials, 'credentials');
  const credentialKeys = [
    'tokenEncryptionKeyRef',
    'sessionPepperRef',
    'assertionPrivateKeyRef',
    'trustedHostRecoveryCredentialRef',
    'runtimeDatabaseUrlRef',
    'migrationDatabaseUrlRef',
    'backupRestoreDatabaseUrlRef',
    'authorityFloorRootRef',
  ] as const;
  requireExactKeys(credentials, credentialKeys, 'credentials');
  const parsedCredentials = Object.fromEntries(credentialKeys.map(key => [
    key,
    parseCredentialReference(credentials[key], `credentials.${key}`),
  ])) as unknown as FleetAuthConfig['credentials'];
  const credentialNames = [
    clientSecretRef.envName,
    ...credentialKeys.map(key => parsedCredentials[key].envName),
  ];
  if (new Set(credentialNames).size !== credentialNames.length) {
    fail('credential references must be distinct');
  }
  if (credentialNames.includes('POSTGRES_DATABASE_URL')) {
    fail('fleet auth credentials must not reuse POSTGRES_DATABASE_URL');
  }

  const discordEvidenceMappings = parseMappings(root.discordEvidenceMappings);
  if (discordEvidenceMappings.length > 0
    && (!scopes.includes('guilds') || !scopes.includes('guilds.members.read'))) {
    fail('provider.scopes must include guilds and guilds.members.read when Discord evidence mappings exist');
  }

  const verifierKeys = parseVerifierKeys(root.verifierKeys);
  const requestCapabilityIssuer = verifierKeys[0]!.issuer;
  if (verifierKeys.some(key => key.issuer !== requestCapabilityIssuer)) {
    fail('verifierKeys must use one request-capability issuer');
  }
  const hubDeviceAssertions = parseHubDeviceAssertions(root.hubDeviceAssertions);
  assertFleetAuthPublicKeyBoundary({
    brokerKeys: verifierKeys,
    hubKeys: hubDeviceAssertions.keys,
    allowUnsafeTemplateKeys: basename(sourcePath) === FLEET_AUTH_SEED_FILE_NAME,
  });

  return {
    schemaVersion: 1,
    activationGeneration: requireInteger(root.activationGeneration, 'activationGeneration', 1, Number.MAX_SAFE_INTEGER),
    canonicalOrigin: parseCanonicalOrigin(root.canonicalOrigin),
    callbackPath: parseCallbackPath(root.callbackPath),
    provider: {
      kind: 'discord',
      clientId,
      scopes,
      clientSecretRef,
      tokenCustody: provider.tokenCustody,
    },
    credentials: parsedCredentials,
    databaseRoles: parseDatabaseRoles(root.databaseRoles),
    verifierKeys,
    hubDeviceAssertions,
    ttls: parseTtls(root.ttls),
    rolePolicy: parseRolePolicy(root.rolePolicy),
    discordEvidenceMappings,
  };
}

export function isFleetAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[FLEET_AUTH_ENV_VAR];
  if (!raw?.trim()) return false;
  const parsed = parseBooleanEnv(raw);
  if (parsed === undefined) {
    throw new Error(
      `Invalid ${FLEET_AUTH_ENV_VAR}=${JSON.stringify(raw)}. Expected a boolean flag.`,
    );
  }
  return parsed;
}

export function fleetAuthFilePath(dataDir: string): string {
  return join(dataDir, FLEET_AUTH_FILE_NAME);
}

export function loadFleetAuthConfig(dataDir: string, seedDir = './config'): FleetAuthConfig {
  return loadRequiredJson({
    dataPath: fleetAuthFilePath(dataDir),
    examplePath: join(seedDir, FLEET_AUTH_SEED_FILE_NAME),
    validate: validateFleetAuthConfig,
  });
}

export function saveFleetAuthConfig(dataDir: string, value: unknown): FleetAuthConfig {
  const validated = validateFleetAuthConfig(value, FLEET_AUTH_FILE_NAME);
  writeJsonAtomic(fleetAuthFilePath(dataDir), validated);
  return validated;
}

export function resolveFleetAuthOwnerFile(options: {
  dataDir: string;
  enabled: boolean;
  processMode: 'gateway' | 'agent' | 'operator';
  seedDir?: string;
}): FleetAuthRuntimeProjection | undefined {
  const path = fleetAuthFilePath(options.dataDir);
  const present = existsSync(path);
  if (!options.enabled) {
    if (present) {
      throw new Error(
        `${FLEET_AUTH_FILE_NAME} is present at ${path} but ${FLEET_AUTH_ENV_VAR} is not enabled`,
      );
    }
    return undefined;
  }
  if (!present) {
    throw new Error(`${FLEET_AUTH_ENV_VAR} is enabled but ${FLEET_AUTH_FILE_NAME} is missing at ${path}`);
  }
  const config = loadFleetAuthConfig(options.dataDir, options.seedDir);
  if (options.processMode === 'gateway') {
    return { kind: 'gateway', enabled: true, config };
  }
  return {
    kind: 'verifier',
    enabled: true,
    canonicalOrigin: config.canonicalOrigin,
    requestCapabilities: {
      issuer: config.verifierKeys[0]!.issuer,
      maxTtlSeconds: config.ttls.internalAssertionMs / 1_000,
      keys: config.verifierKeys.map(key => ({ ...key })),
    },
    hubDeviceAssertions: {
      ...config.hubDeviceAssertions,
      keys: config.hubDeviceAssertions.keys.map(key => ({ ...key })),
    },
  };
}

function resolveRequiredSecret(
  vault: CredentialVaultPort,
  reference: CredentialReference,
  description: string,
  minimumLength = 1,
): string {
  const value = vault.resolveRequired(reference, description);
  if (Buffer.byteLength(value, 'utf8') < minimumLength) {
    throw new Error(`${description} must be at least ${minimumLength} bytes`);
  }
  return value;
}

const DATABASE_CREDENTIAL_QUERY_OVERRIDES = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'database',
  'user',
  'password',
  'service',
  'servicefile',
  'passfile',
  'options',
  'target_session_attrs',
]);

function parseDatabaseCredential(
  value: string,
  expectedRole: string,
  description: string,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${description} must be a PostgreSQL URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${description} must be a PostgreSQL URL`);
  }
  const override = [...url.searchParams.keys()].find(parameter => (
    DATABASE_CREDENTIAL_QUERY_OVERRIDES.has(parameter.toLowerCase())
  ));
  if (override) {
    throw new Error(
      `${description} must not use PostgreSQL routing or authentication query override ${override}`,
    );
  }
  if (decodeURIComponent(url.username) !== expectedRole || !url.password) {
    throw new Error(`${description} must authenticate as configured role ${expectedRole}`);
  }
  if (!url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error(`${description} must identify an exact PostgreSQL database`);
  }
  return url;
}

function databaseIdentity(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
}

function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return fromLeft === ''
    || (!fromLeft.startsWith('..') && !isAbsolute(fromLeft))
    || (!fromRight.startsWith('..') && !isAbsolute(fromRight));
}

function resolveAuthorityFloorRoot(value: string, protectedRoots: readonly string[]): string {
  if (!isAbsolute(value)) throw new Error('Fleet auth authority floor root must be an absolute path');
  const requested = resolve(value);
  if (!existsSync(requested)) throw new Error(`Fleet auth authority floor root is inaccessible: ${requested}`);
  const canonical = realpathSync(requested);
  const stats = statSync(canonical);
  if (!stats.isDirectory()) throw new Error('Fleet auth authority floor root must be a directory');
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('Fleet auth authority floor root must not be group/world accessible');
  }
  for (const protectedRoot of protectedRoots) {
    const trimmed = protectedRoot.trim();
    if (!trimmed) continue;
    const protectedPath = existsSync(trimmed) ? realpathSync(trimmed) : resolve(trimmed);
    if (pathsOverlap(canonical, protectedPath)) {
      throw new Error('Fleet auth authority floor root must remain outside restorable runtime roots');
    }
  }
  return canonical;
}

export function resolveGatewayFleetAuthSecrets(options: {
  config: FleetAuthConfig;
  credentialVault: CredentialVaultPort;
  protectedRestoreRoots: readonly string[];
  companionDatabaseUrl?: string;
}): ResolvedGatewayFleetAuthSecrets {
  const { config, credentialVault } = options;
  const oauthClientSecret = resolveRequiredSecret(
    credentialVault,
    config.provider.clientSecretRef,
    'Fleet auth Discord OAuth client secret',
  );
  const tokenEncryptionKey = resolveRequiredSecret(
    credentialVault,
    config.credentials.tokenEncryptionKeyRef,
    'Fleet auth token encryption key',
    32,
  );
  const sessionPepper = resolveRequiredSecret(
    credentialVault,
    config.credentials.sessionPepperRef,
    'Fleet auth session pepper',
    32,
  );
  const assertionPrivateKeyPem = resolveRequiredSecret(
    credentialVault,
    config.credentials.assertionPrivateKeyRef,
    'Fleet auth assertion private signing key',
  );
  let derivedPublicKey: string;
  try {
    const privateKey = createPrivateKey(assertionPrivateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('not Ed25519');
    }
    derivedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw new Error('Fleet auth assertion private signing key must be an Ed25519 private key');
  }
  const activeVerifier = config.verifierKeys.find(key => key.status === 'active')!;
  const configuredPublicKey = createPublicKey(activeVerifier.publicKeyPem)
    .export({ type: 'spki', format: 'pem' }).toString();
  if (canonicalEd25519SpkiFingerprint(derivedPublicKey)
    !== canonicalEd25519SpkiFingerprint(configuredPublicKey)) {
    throw new Error('Fleet auth assertion private signing key does not match the active public verifier key');
  }
  assertBrokerSigningKeyNotTrustedByHub(derivedPublicKey, config.hubDeviceAssertions.keys);
  assertFleetAuthPublicKeyBoundary({
    brokerKeys: config.verifierKeys,
    hubKeys: config.hubDeviceAssertions.keys,
    allowUnsafeTemplateKeys: false,
  });
  const trustedHostRecoveryCredential = resolveRequiredSecret(
    credentialVault,
    config.credentials.trustedHostRecoveryCredentialRef,
    'Fleet auth trusted-host recovery credential',
    32,
  );
  if (new Set([
    oauthClientSecret,
    tokenEncryptionKey,
    sessionPepper,
    assertionPrivateKeyPem,
    trustedHostRecoveryCredential,
  ]).size !== 5) {
    throw new Error('Fleet auth gateway and trusted-host security credentials must be distinct');
  }
  const runtimeUrl = resolveRequiredSecret(
    credentialVault,
    config.credentials.runtimeDatabaseUrlRef,
    'Fleet auth runtime database credential',
  );
  const migrationUrl = resolveRequiredSecret(
    credentialVault,
    config.credentials.migrationDatabaseUrlRef,
    'Fleet auth migration database credential',
  );
  const backupRestoreUrl = resolveRequiredSecret(
    credentialVault,
    config.credentials.backupRestoreDatabaseUrlRef,
    'Fleet auth backup/restore database credential',
  );
  const runtime = parseDatabaseCredential(runtimeUrl, config.databaseRoles.runtime, 'Fleet auth runtime database credential');
  const migration = parseDatabaseCredential(migrationUrl, config.databaseRoles.migration, 'Fleet auth migration database credential');
  const backup = parseDatabaseCredential(backupRestoreUrl, config.databaseRoles.backupRestore, 'Fleet auth backup/restore database credential');
  if (new Set([runtimeUrl, migrationUrl, backupRestoreUrl]).size !== 3) {
    throw new Error('Fleet auth requires three distinct PostgreSQL credentials');
  }
  const companionDatabaseUrl = options.companionDatabaseUrl?.trim();
  if (companionDatabaseUrl
    && [runtimeUrl, migrationUrl, backupRestoreUrl].includes(companionDatabaseUrl)) {
    throw new Error('Fleet auth credentials must not reuse the companion POSTGRES_DATABASE_URL value');
  }
  if (companionDatabaseUrl) {
    let companionCredential: URL;
    try {
      companionCredential = new URL(companionDatabaseUrl);
    } catch {
      throw new Error('Companion POSTGRES_DATABASE_URL must be a PostgreSQL URL');
    }
    if (Object.values(config.databaseRoles).includes(
      decodeURIComponent(companionCredential.username),
    )) {
      throw new Error('Companion POSTGRES_DATABASE_URL must not authenticate as a fleet auth role');
    }
    if (companionCredential.searchParams.has('user')
      || companionCredential.searchParams.has('service')) {
      throw new Error('Companion POSTGRES_DATABASE_URL must not use a PostgreSQL role-routing override');
    }
  }
  if (new Set([runtime.username, migration.username, backup.username]).size !== 3) {
    throw new Error('Fleet auth requires three distinct PostgreSQL credential roles');
  }
  const identities = [runtime, migration, backup].map(databaseIdentity);
  if (new Set(identities).size !== 1) {
    throw new Error('Fleet auth PostgreSQL credentials must target the same exact database');
  }
  const authorityFloorRoot = resolveAuthorityFloorRoot(
    resolveRequiredSecret(
      credentialVault,
      config.credentials.authorityFloorRootRef,
      'Fleet auth authority floor root',
    ),
    options.protectedRestoreRoots,
  );

  return {
    oauthClientSecret,
    tokenEncryptionKey,
    sessionPepper,
    assertionPrivateKeyPem,
    assertionSigningKid: activeVerifier.kid,
    trustedHostRecoveryCredential,
    authorityFloorRoot,
    database: { runtimeUrl, migrationUrl, backupRestoreUrl },
  };
}

export function projectFleetAuthGardenMetadata(config: FleetAuthConfig): FleetAuthGardenMetadata {
  return {
    enabled: true,
    canonicalOrigin: config.canonicalOrigin,
    callbackPath: config.callbackPath,
    activationGeneration: config.activationGeneration,
    provider: {
      kind: config.provider.kind,
      scopes: [...config.provider.scopes],
      tokenCustody: config.provider.tokenCustody,
    },
    ttls: { ...config.ttls },
    rolePolicy: {
      disabledActionsByRole: Object.fromEntries(FLEET_AUTH_ROLES.map(role => [
        role,
        [...config.rolePolicy.disabledActionsByRole[role]],
      ])) as Record<FleetAuthRole, FleetAuthAction[]>,
    },
    discordEvidenceMappings: config.discordEvidenceMappings.map(mapping => ({
      ...mapping,
      requiredRoleIds: [...mapping.requiredRoleIds],
    })),
    verifierKeys: config.verifierKeys.map(({ issuer, kid, notBefore, notAfter, status }) => ({
      issuer,
      kid,
      notBefore,
      notAfter,
      status,
    })),
    hubDeviceAssertions: {
      issuer: config.hubDeviceAssertions.issuer,
      audience: config.hubDeviceAssertions.audience,
      maxTtlSeconds: config.hubDeviceAssertions.maxTtlSeconds,
      clockSkewSeconds: config.hubDeviceAssertions.clockSkewSeconds,
      keys: config.hubDeviceAssertions.keys.map(({ kid, notBefore, notAfter, status }) => ({
        kid,
        notBefore,
        notAfter,
        status,
      })),
    },
  };
}
