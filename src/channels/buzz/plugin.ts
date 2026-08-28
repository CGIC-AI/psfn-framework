import {
  envCredential,
  type CredentialReference,
} from '../../boundary/custody/credential-vault.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type {
  ChannelPlugin,
  ChannelPluginCreateInput,
  ChannelPluginInstance,
  ChannelPluginParseResult,
} from '../plugins/types.js';
import { BuzzAdapter } from './adapter.js';
import { normalizeBuzzRelayUrl } from './origin.js';
import { isNostrHexKey } from './protocol.js';

const BUZZ_ALLOWED_KEYS: Record<string, true> = {
  enabled: true,
  relayUrl: true,
  companionId: true,
  privateKeyRef: true,
  channelIds: true,
  allowedAuthorPubkeys: true,
};

export interface BuzzChannelConfig {
  enabled: boolean;
  relayUrl: string;
  companionId?: CompanionId;
  privateKeyRef?: CredentialReference;
  channelIds: readonly string[];
  allowedAuthorPubkeys: readonly string[];
}

export function createBuzzChannelPlugin(): ChannelPlugin<BuzzChannelConfig> {
  return {
    manifest: { id: 'buzz', label: 'Buzz' },
    parseConfig: parseBuzzChannelConfig,
    create: createBuzzPluginInstance,
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
  const rawCompanionId = raw.companionId === undefined
    ? undefined
    : parseString(raw.companionId, 'channels.json.buzz.companionId');
  const companionId = rawCompanionId
    ? createCompanionId(rawCompanionId, 'channels.json.buzz.companionId')
    : undefined;
  const privateKeyRef = parseCredentialReference(
    raw.privateKeyRef,
    'channels.json.buzz.privateKeyRef',
  );
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

  if (enabled) {
    if (!relayUrl) throw new Error('channels.json.buzz.relayUrl must be configured when Buzz is enabled');
    if (!companionId) throw new Error('channels.json.buzz.companionId must be configured when Buzz is enabled');
    if (!privateKeyRef) throw new Error('channels.json.buzz.privateKeyRef must be configured when Buzz is enabled');
    if (channelIds.length === 0) throw new Error('channels.json.buzz.channelIds must not be empty when Buzz is enabled');
    if (allowedAuthorPubkeys.length === 0) {
      throw new Error('channels.json.buzz.allowedAuthorPubkeys must not be empty when Buzz is enabled');
    }
  }

  return {
    enabled,
    ...(companionId ? { companionId } : {}),
    credentials: enabled && privateKeyRef
      ? [{
        id: 'privateKey',
        reference: privateKeyRef,
        description: 'Buzz Nostr private key',
      }]
      : [],
    config: {
      enabled,
      relayUrl,
      ...(companionId ? { companionId } : {}),
      ...(privateKeyRef ? { privateKeyRef } : {}),
      channelIds,
      allowedAuthorPubkeys,
    },
  };
}

function createBuzzPluginInstance(
  input: ChannelPluginCreateInput<BuzzChannelConfig>,
): ChannelPluginInstance {
  if (!input.config.companionId) throw new Error('Enabled Buzz channel requires a companionId');
  const privateKey = input.secrets.privateKey;
  if (!privateKey) throw new Error('Enabled Buzz channel is missing resolved credential "privateKey"');
  const adapter = new BuzzAdapter({
    enabled: input.config.enabled,
    relayUrl: input.config.relayUrl,
    companionId: input.config.companionId,
    privateKey,
    channelIds: input.config.channelIds,
    allowedAuthorPubkeys: input.config.allowedAuthorPubkeys,
  }, {
    shutdownTimeoutMs: input.context.shutdownTimeoutMs,
    intakeScreening: input.context.intakeScreening,
    log: input.context.log,
  });
  return {
    adapter,
    onOperatorAlert: handler => adapter.onOperatorAlert(handler),
  };
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
