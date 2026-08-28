import {
  envCredential,
  type CredentialReference,
} from '../../boundary/custody/credential-vault.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import { PostgresBuzzRecoveryStore } from '../../persistence/postgres/buzz-recovery-store.js';
import type {
  ChannelPlugin,
  ChannelPluginCreateInput,
  ChannelPluginInstance,
  ChannelPluginParseResult,
} from '../plugins/types.js';
import { BuzzAdapter } from './adapter.js';
import { normalizeBuzzRelayUrl } from './origin.js';
import { isNostrHexKey } from './protocol.js';
import type { BuzzRecoveryStore } from './recovery-store.js';

const BUZZ_ALLOWED_KEYS: Record<string, true> = {
  enabled: true,
  accounts: true,
  relayUrl: true,
  relayPubkey: true,
  channelIds: true,
  allowedAuthorPubkeys: true,
  machineAuthorPubkeys: true,
  recoveryPolicy: true,
};

const BUZZ_ACCOUNT_KEYS: Record<string, true> = {
  companionId: true,
  privateKeyRef: true,
};

const BUZZ_RECOVERY_POLICY_KEYS: Record<string, true> = {
  replayWindowSeconds: true,
  reconnectBaseDelayMs: true,
  reconnectMaxDelayMs: true,
  maxReconnectAttempts: true,
  maxFutureEventSkewSeconds: true,
};

export interface BuzzChannelConfig {
  enabled: boolean;
  relayUrl: string;
  relayPubkey: string;
  accounts: readonly BuzzChannelAccountConfig[];
  companionId?: CompanionId;
  privateKeyRef?: CredentialReference;
  channelIds: readonly string[];
  allowedAuthorPubkeys: readonly string[];
  machineAuthorPubkeys: readonly string[];
  recoveryPolicy?: {
    replayWindowSeconds: number;
    reconnectBaseDelayMs: number;
    reconnectMaxDelayMs: number;
    maxReconnectAttempts: number;
    maxFutureEventSkewSeconds: number;
  };
}

interface BuzzChannelAccountConfig {
  companionId: CompanionId;
  privateKeyRef: CredentialReference;
}

export interface BuzzChannelPluginOptions {
  recoveryStoreFactory?: (scope: {
    community: string;
    companionId: CompanionId;
  }) => BuzzRecoveryStore;
}

export function createBuzzChannelPlugin(
  options: BuzzChannelPluginOptions = {},
): ChannelPlugin<BuzzChannelConfig> {
  return {
    manifest: { id: 'buzz', label: 'Buzz' },
    parseConfig: parseBuzzChannelConfig,
    create: input => createBuzzPluginInstance(input, options.recoveryStoreFactory),
  };
}

function parseBuzzChannelConfig(raw: unknown): ChannelPluginParseResult<BuzzChannelConfig> {
  if (!isRecord(raw)) throw new Error('channels.json.buzz must be an object');
  if (Object.hasOwn(raw, 'privateKey')) {
    throw new Error('channels.json.buzz.privateKeyRef must be used instead of privateKey');
  }
  const unknownKeys = Object.keys(raw).filter(key => !BUZZ_ALLOWED_KEYS[key]);
  if (unknownKeys.length > 0) {
    throw new Error(`channels.json.buzz has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!Object.hasOwn(raw, 'enabled')) {
    throw new Error('channels.json.buzz.enabled must be configured when Buzz settings are present');
  }

  const enabled = parseBoolean(raw.enabled, 'channels.json.buzz.enabled');
  const relayUrl = raw.relayUrl === undefined
    ? ''
    : normalizeBuzzRelayUrl(
      parseString(raw.relayUrl, 'channels.json.buzz.relayUrl'),
      'channels.json.buzz.relayUrl',
    );
  const relayPubkey = raw.relayPubkey === undefined
    ? ''
    : parseNostrPubkey(raw.relayPubkey, 'channels.json.buzz.relayPubkey');
  const accounts = parseBuzzAccounts(raw.accounts);
  const channelIds = parseExactStringList(raw.channelIds, 'channels.json.buzz.channelIds', value => (
    isRfc4122Uuid(value)
      ? null
      : 'must be a lowercase RFC-4122 UUID'
  ));
  const allowedAuthorPubkeys = parseExactStringList(
    raw.allowedAuthorPubkeys,
    'channels.json.buzz.allowedAuthorPubkeys',
    value => isNostrHexKey(value)
      ? null
      : 'must be a 64-character lowercase hex pubkey',
  );
  const machineAuthorPubkeys = parseExactStringList(
    raw.machineAuthorPubkeys,
    'channels.json.buzz.machineAuthorPubkeys',
    value => isNostrHexKey(value)
      ? null
      : 'must be a 64-character lowercase hex pubkey',
  );
  const recoveryPolicy = parseRecoveryPolicy(raw.recoveryPolicy);

  if (enabled) {
    if (!relayUrl) throw new Error('channels.json.buzz.relayUrl must be configured when Buzz is enabled');
    if (!relayPubkey) throw new Error('channels.json.buzz.relayPubkey must be configured when Buzz is enabled');
    if (accounts.length === 0) {
      throw new Error('channels.json.buzz.accounts must not be empty when Buzz is enabled');
    }
    if (allowedAuthorPubkeys.length === 0) {
      throw new Error('channels.json.buzz.allowedAuthorPubkeys must not be empty when Buzz is enabled');
    }
    if (machineAuthorPubkeys.some(pubkey => !allowedAuthorPubkeys.includes(pubkey))) {
      throw new Error('channels.json.buzz.machineAuthorPubkeys must be a subset of allowedAuthorPubkeys');
    }
    if (!recoveryPolicy) {
      throw new Error('channels.json.buzz.recoveryPolicy must be configured when Buzz is enabled');
    }
  }

  return {
    enabled,
    credentials: [],
    ...(enabled && accounts.length > 0
      ? {
        instances: accounts.map(account => ({
          id: account.companionId,
          companionId: account.companionId,
          credentials: [{
            id: 'privateKey',
            reference: account.privateKeyRef,
            description: `Buzz Nostr private key for companion ${account.companionId}`,
          }],
          config: {
            enabled,
            relayUrl,
            relayPubkey,
            accounts,
            companionId: account.companionId,
            privateKeyRef: account.privateKeyRef,
            channelIds,
            allowedAuthorPubkeys,
            machineAuthorPubkeys,
            ...(recoveryPolicy ? { recoveryPolicy } : {}),
          },
        })),
      }
      : {}),
    config: {
      enabled,
      relayUrl,
      relayPubkey,
      accounts,
      channelIds,
      allowedAuthorPubkeys,
      machineAuthorPubkeys,
      ...(recoveryPolicy ? { recoveryPolicy } : {}),
    },
  };
}

function parseBuzzAccounts(value: unknown): BuzzChannelAccountConfig[] {
  const fieldName = 'channels.json.buzz.accounts';
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  const accounts = value.map((entry, index) => {
    const accountField = `${fieldName}[${index}]`;
    const account = parseExactObject(entry, accountField, BUZZ_ACCOUNT_KEYS);
    const companionId = createCompanionId(
      parseString(account.companionId, `${accountField}.companionId`),
      `${accountField}.companionId`,
    );
    const privateKeyRef = parseCredentialReference(
      account.privateKeyRef,
      `${accountField}.privateKeyRef`,
    );
    if (!privateKeyRef) throw new Error(`${accountField}.privateKeyRef must be configured`);
    return { companionId, privateKeyRef };
  });
  const companionIds = accounts.map(account => account.companionId);
  if (new Set(companionIds).size !== companionIds.length) {
    throw new Error(`${fieldName} must not contain duplicate companionId values`);
  }
  return accounts;
}

function createBuzzPluginInstance(
  input: ChannelPluginCreateInput<BuzzChannelConfig>,
  recoveryStoreFactory?: BuzzChannelPluginOptions['recoveryStoreFactory'],
): ChannelPluginInstance {
  if (!input.config.companionId) throw new Error('Enabled Buzz channel requires a companionId');
  const privateKey = input.secrets.privateKey;
  if (!privateKey) throw new Error('Enabled Buzz channel is missing resolved credential "privateKey"');
  const recoveryPolicy = input.config.recoveryPolicy;
  if (!recoveryPolicy) throw new Error('Enabled Buzz channel is missing recoveryPolicy');
  const recoveryStore = recoveryStoreFactory?.({
    community: input.config.relayUrl,
    companionId: input.config.companionId,
  }) ?? createGatewayBuzzRecoveryStore(
    input.context.postgresDatabaseUrl,
    input.config.relayUrl,
    input.config.companionId,
  );
  const adapter = new BuzzAdapter({
    enabled: input.config.enabled,
    relayUrl: input.config.relayUrl,
    relayPubkey: input.config.relayPubkey,
    companionId: input.config.companionId,
    privateKey,
    channelIds: input.config.channelIds,
    allowedAuthorPubkeys: input.config.allowedAuthorPubkeys,
    machineAuthorPubkeys: input.config.machineAuthorPubkeys,
    replayWindowSeconds: recoveryPolicy.replayWindowSeconds,
    reconnectBaseDelayMs: recoveryPolicy.reconnectBaseDelayMs,
    reconnectMaxDelayMs: recoveryPolicy.reconnectMaxDelayMs,
    maxReconnectAttempts: recoveryPolicy.maxReconnectAttempts,
    maxFutureEventSkewSeconds: recoveryPolicy.maxFutureEventSkewSeconds,
  }, {
    shutdownTimeoutMs: input.context.shutdownTimeoutMs,
    intakeScreening: input.context.intakeScreening,
    log: input.context.log,
    recoveryStore,
  });
  return {
    adapter,
    onOperatorAlert: handler => adapter.onOperatorAlert(handler),
  };
}

function createGatewayBuzzRecoveryStore(
  postgresDatabaseUrl: string | undefined,
  community: string,
  companionId: string,
): BuzzRecoveryStore {
  const databaseUrl = postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Enabled Buzz channel requires config.postgresDatabaseUrl for durable recovery');
  }
  return PostgresBuzzRecoveryStore.connect(databaseUrl, { community, companionId });
}

function parseNostrPubkey(value: unknown, fieldName: string): string {
  const parsed = parseString(value, fieldName);
  if (!isNostrHexKey(parsed)) throw new Error(`${fieldName} must be a 64-character lowercase hex pubkey`);
  return parsed;
}

function parseRecoveryPolicy(value: unknown): BuzzChannelConfig['recoveryPolicy'] | undefined {
  const fieldName = 'channels.json.buzz.recoveryPolicy';
  if (value === undefined) {
    return undefined;
  }
  const policy = parseExactObject(value, fieldName, BUZZ_RECOVERY_POLICY_KEYS);
  const recovery = {
    replayWindowSeconds: parsePositiveInteger(
      policy.replayWindowSeconds,
      `${fieldName}.replayWindowSeconds`,
    ),
    reconnectBaseDelayMs: parsePositiveInteger(
      policy.reconnectBaseDelayMs,
      `${fieldName}.reconnectBaseDelayMs`,
    ),
    reconnectMaxDelayMs: parsePositiveInteger(
      policy.reconnectMaxDelayMs,
      `${fieldName}.reconnectMaxDelayMs`,
    ),
    maxReconnectAttempts: parsePositiveInteger(
      policy.maxReconnectAttempts,
      `${fieldName}.maxReconnectAttempts`,
    ),
    maxFutureEventSkewSeconds: parsePositiveInteger(
      policy.maxFutureEventSkewSeconds,
      `${fieldName}.maxFutureEventSkewSeconds`,
    ),
  };
  if (recovery.reconnectMaxDelayMs < recovery.reconnectBaseDelayMs) {
    throw new Error(`${fieldName}.reconnectMaxDelayMs must be at least reconnectBaseDelayMs`);
  }
  return recovery;
}

function parseExactObject(
  value: unknown,
  fieldName: string,
  allowedKeys: Readonly<Record<string, true>>,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${fieldName} must be an object`);
  const unknownKeys = Object.keys(value).filter(key => !allowedKeys[key]);
  if (unknownKeys.length > 0) throw new Error(`${fieldName} has unsupported keys: ${unknownKeys.join(', ')}`);
  return value;
}

function parsePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function parseString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName} must be a non-empty string`);
  return value.trim();
}

function parseBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${fieldName} must be a boolean`);
  return value;
}

function parseCredentialReference(
  value: unknown,
  fieldName: string,
): CredentialReference | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${fieldName} must be an object`);
  const unknownKeys = Object.keys(value).filter(key => key !== 'kind' && key !== 'envName');
  if (unknownKeys.length > 0) {
    throw new Error(`${fieldName} has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (value.kind !== 'env') throw new Error(`${fieldName}.kind must be "env"`);
  const envName = parseString(value.envName, `${fieldName}.envName`);
  try {
    return envCredential(envName);
  } catch {
    throw new Error(`${fieldName}.envName must be an uppercase env var name`);
  }
}

function parseExactStringList(
  value: unknown,
  fieldName: string,
  validate: (entry: string) => string | null,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  const entries = value.map((entry, index) => {
    const parsed = parseString(entry, `${fieldName}[${index}]`);
    const validationError = validate(parsed);
    if (validationError) throw new Error(`${fieldName}[${index}] ${validationError}`);
    return parsed;
  });
  if (new Set(entries).size !== entries.length) throw new Error(`${fieldName} must not contain duplicates`);
  return entries;
}
