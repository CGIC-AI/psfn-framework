import {
  envCredential,
  type CredentialReference,
} from '../../boundary/custody/credential-vault.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { PostgresMulticaRuntimeLease } from '../../persistence/postgres/multica-runtime-lease.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type {
  ChannelPlugin,
  ChannelPluginCreateInput,
  ChannelPluginInstance,
  ChannelPluginParseResult,
} from '../plugins/types.js';
import { MulticaAdapter } from './adapter.js';
import { normalizeMulticaOrigin } from './origin.js';
import type { MulticaRuntimeLease } from './runtime-lease.js';

const DEFAULT_MULTICA_POLL_INTERVAL_MS = 1_000;
const MIN_MULTICA_POLL_INTERVAL_MS = 250;
const MAX_MULTICA_POLL_INTERVAL_MS = 60_000;
const ENV_CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MULTICA_ALLOWED_KEYS: Record<string, true> = {
  enabled: true,
  baseUrl: true,
  workspaceId: true,
  companionId: true,
  tokenRef: true,
  pollIntervalMs: true,
  runtimeName: true,
};

export interface MulticaChannelConfig {
  enabled: boolean;
  baseUrl: string;
  workspaceId: string;
  companionId?: CompanionId;
  tokenRef?: CredentialReference;
  pollIntervalMs: number;
  runtimeName?: string;
}

export interface MulticaChannelPluginOptions {
  runtimeLease?: MulticaRuntimeLease;
}

export function createMulticaChannelPlugin(
  options: MulticaChannelPluginOptions = {},
): ChannelPlugin<MulticaChannelConfig> {
  return {
    manifest: {
      id: 'multica',
      label: 'Multica',
    },
    parseConfig(raw: unknown): ChannelPluginParseResult<MulticaChannelConfig> {
      return parseMulticaChannelConfig(raw);
    },
    create(input: ChannelPluginCreateInput<MulticaChannelConfig>): ChannelPluginInstance {
      return createMulticaPluginInstance(input, options.runtimeLease);
    },
  };
}

function parseMulticaChannelConfig(raw: unknown): ChannelPluginParseResult<MulticaChannelConfig> {
  if (!isRecord(raw)) {
    throw new Error('channels.json.multica must be an object');
  }
  if (Object.hasOwn(raw, 'token')) {
    throw new Error('channels.json.multica.tokenRef must be used instead of token');
  }
  const unknownKeys = Object.keys(raw).filter(key => !MULTICA_ALLOWED_KEYS[key]);
  if (unknownKeys.length > 0) {
    throw new Error(`channels.json.multica has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!Object.hasOwn(raw, 'enabled')) {
    throw new Error('channels.json.multica.enabled must be configured when multica settings are present');
  }

  const enabled = parseConfiguredBoolean(raw.enabled, 'channels.json.multica.enabled') ?? false;
  const baseUrl = parseMulticaBaseUrl(raw.baseUrl) ?? '';
  const workspaceId = parseConfiguredString(raw.workspaceId, 'channels.json.multica.workspaceId') ?? '';
  if (workspaceId && !isRfc4122Uuid(workspaceId)) {
    throw new Error('channels.json.multica.workspaceId must be a lowercase RFC-4122 UUID');
  }
  const rawCompanionId = parseConfiguredString(raw.companionId, 'channels.json.multica.companionId');
  const companionId = rawCompanionId
    ? createCompanionId(rawCompanionId, 'channels.json.multica.companionId')
    : undefined;
  const tokenRef = parseConfiguredCredentialReference(raw.tokenRef, 'channels.json.multica.tokenRef');
  const pollIntervalMs = parseConfiguredPositiveInteger(
    raw.pollIntervalMs,
    'channels.json.multica.pollIntervalMs',
  ) ?? DEFAULT_MULTICA_POLL_INTERVAL_MS;
  if (pollIntervalMs < MIN_MULTICA_POLL_INTERVAL_MS
    || pollIntervalMs > MAX_MULTICA_POLL_INTERVAL_MS) {
    throw new Error(
      `channels.json.multica.pollIntervalMs must be between ${MIN_MULTICA_POLL_INTERVAL_MS} and ${MAX_MULTICA_POLL_INTERVAL_MS}`,
    );
  }
  const runtimeName = parseConfiguredString(raw.runtimeName, 'channels.json.multica.runtimeName');

  if (enabled) {
    if (!baseUrl) throw new Error('channels.json.multica.baseUrl must be configured when multica is enabled');
    if (!workspaceId) throw new Error('channels.json.multica.workspaceId must be configured when multica is enabled');
    if (!companionId) throw new Error('channels.json.multica.companionId must be configured when multica is enabled');
    if (!tokenRef) throw new Error('channels.json.multica.tokenRef must be configured when multica is enabled');
    if (!Object.hasOwn(raw, 'pollIntervalMs')) {
      throw new Error('channels.json.multica.pollIntervalMs must be configured when multica is enabled');
    }
  }

  return {
    enabled,
    companionId,
    ...(enabled ? { continuityChannelPrefixes: [`multica:${workspaceId}:`] } : {}),
    credentials: enabled && tokenRef
      ? [{
        id: 'token',
        reference: tokenRef,
        description: 'Multica gateway token',
      }]
      : [],
    config: {
      enabled,
      baseUrl,
      workspaceId,
      ...(companionId ? { companionId } : {}),
      ...(tokenRef ? { tokenRef } : {}),
      pollIntervalMs,
      ...(runtimeName ? { runtimeName } : {}),
    },
  };
}

function createMulticaPluginInstance(
  input: ChannelPluginCreateInput<MulticaChannelConfig>,
  injectedLease?: MulticaRuntimeLease,
): ChannelPluginInstance {
  const companionId = input.config.companionId;
  if (!companionId) {
    throw new Error('Enabled Multica channel requires a companionId');
  }
  const token = input.secrets.token;
  if (!token) {
    throw new Error('Enabled Multica channel is missing resolved credential "token"');
  }
  const runtimeLease = injectedLease ?? createGatewayMulticaRuntimeLease(input.context.postgresDatabaseUrl);
  const adapter = new MulticaAdapter({
    enabled: input.config.enabled,
    baseUrl: input.config.baseUrl,
    workspaceId: input.config.workspaceId,
    companionId,
    token,
    pollIntervalMs: input.config.pollIntervalMs,
    ...(input.config.runtimeName ? { runtimeName: input.config.runtimeName } : {}),
  }, {
    runtimeLease,
    ...(input.context.shutdownTimeoutMs ? { shutdownTimeoutMs: input.context.shutdownTimeoutMs } : {}),
    log: input.context.log,
    ...(input.context.intakeScreening ? { intakeScreening: input.context.intakeScreening } : {}),
  });
  return {
    adapter,
    onOperatorAlert: handler => adapter.onOperatorAlert(handler),
  };
}

function createGatewayMulticaRuntimeLease(postgresDatabaseUrl: string | undefined): MulticaRuntimeLease {
  const databaseUrl = postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Enabled Multica channel requires config.postgresDatabaseUrl for runtime ownership');
  }
  return new PostgresMulticaRuntimeLease(createPostgresPool(databaseUrl, {
    applicationName: 'psfn-multica-runtime-lease',
    connectionTimeoutMillis: 5_000,
    max: 1,
  }));
}

function parseMulticaBaseUrl(value: unknown): string | undefined {
  const configured = parseConfiguredString(value, 'channels.json.multica.baseUrl');
  if (!configured) return undefined;
  return normalizeMulticaOrigin(configured, 'channels.json.multica.baseUrl');
}

function parseConfiguredString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const parsed = value.trim();
  if (!parsed) {
    throw new Error(`${fieldName} must not be empty`);
  }
  return parsed;
}

function parseConfiguredBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${fieldName} must be a boolean`);
}

function parseConfiguredPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  throw new Error(`${fieldName} must be a positive integer`);
}

function parseConfiguredCredentialReference(
  value: unknown,
  fieldName: string,
): CredentialReference | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  if (value.kind !== 'env') {
    throw new Error(`${fieldName}.kind must be "env"`);
  }
  const envName = parseConfiguredString(value.envName, `${fieldName}.envName`);
  if (!envName || !ENV_CREDENTIAL_NAME_PATTERN.test(envName)) {
    throw new Error(`${fieldName}.envName must be an uppercase env var name`);
  }
  return envCredential(envName);
}
