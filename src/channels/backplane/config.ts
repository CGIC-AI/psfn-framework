import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { getIgnoredTelegramChannelEnvKeys } from '../../system/config/legacy-env.js';
import {
  envCredential,
  resolveOptionalCredentialReference,
  type CredentialReference,
  type CredentialVaultPort,
} from '../../boundary/custody/credential-vault.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { parseBooleanEnv } from '../../shared/utils/env.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  normalizeChannelVisibility,
  type ChannelVisibility,
} from '../../system/trust/types.js';
import {
  validateChannelEnvelopeLabel,
  type ChannelEnvelopeLabel,
} from '../../system/trust/context-envelope.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import {
  createDefaultChannelGroupMemoryConfig,
  normalizeChannelGroupMemoryConfig,
  type ChannelGroupMemoryConfig,
} from '../../system/config/group-memory-config.js';

const log = createComponentLogger('ChannelConfig');

export const CHANNELS_FILE_NAME = 'channels.json';
const ENV_CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT_TELEGRAM_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TELEGRAM_WEBHOOK_HOST = '0.0.0.0';
const DEFAULT_TELEGRAM_WEBHOOK_PORT = 8_080;
const DEFAULT_TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

export type TelegramMode = 'polling' | 'webhook';

export interface TelegramWebhookConfig {
  url: string;
  secret: string;
  host: string;
  port: number;
  path: string;
}

export interface TelegramChannelConfig {
  enabled: boolean;
  token: string;
  allowedUsers: string[];
  mode: TelegramMode;
  pollIntervalMs: number;
  webhook: TelegramWebhookConfig;
}

export interface DiscordChannelConfig {
  heartbeatChannelId: string;
  allowedBotUserIds: string[];
  groupMemory: ChannelGroupMemoryConfig;
}

export interface ExternalChannelProfileConfig {
  authorId?: string;
  authorName?: string;
  canonicalContactId?: string;
  channelPrivacy?: ChannelVisibility;
}

export interface PsfnAmicaChannelConfig {
  enabled: boolean;
  defaultIdentity?: ExternalChannelProfileConfig;
}

/**
 * Channel-owned Context Envelope labels (E3.1 contract,
 * docs/context-envelope.md). channels.json owns per-channel
 * { privacy, broadcast, contactTracking }; these labels are the
 * highest-precedence source for a channel's envelope:
 *   channel-owned label > operator trust-policy override > derived default.
 * E3.1 validates and carries this section; E3.2 wires it into classification.
 */
export interface ChannelContextEnvelopeConfig {
  /** Exact channel-id keyed envelope labels. */
  channels: Record<string, ChannelEnvelopeLabel>;
}

export interface RuntimeChannelsConfig {
  discord: DiscordChannelConfig;
  telegram: TelegramChannelConfig;
  psfnAmica: PsfnAmicaChannelConfig;
  contextEnvelope: ChannelContextEnvelopeConfig;
}

export interface RuntimeChannelsConfigOverrides {
  telegram?: {
    enabled?: boolean;
    allowedUsers?: string[];
  };
}

const DEFAULT_TELEGRAM_CHANNEL_CONFIG: TelegramChannelConfig = {
  enabled: false,
  token: '',
  allowedUsers: [],
  mode: 'polling',
  pollIntervalMs: DEFAULT_TELEGRAM_POLL_INTERVAL_MS,
  webhook: {
    url: '',
    secret: '',
    host: DEFAULT_TELEGRAM_WEBHOOK_HOST,
    port: DEFAULT_TELEGRAM_WEBHOOK_PORT,
    path: DEFAULT_TELEGRAM_WEBHOOK_PATH,
  },
};

const DEFAULT_DISCORD_CHANNEL_CONFIG: DiscordChannelConfig = {
  heartbeatChannelId: '',
  allowedBotUserIds: [],
  groupMemory: createDefaultChannelGroupMemoryConfig(),
};

const DEFAULT_PSFN_AMICA_CHANNEL_CONFIG: PsfnAmicaChannelConfig = {
  enabled: false,
};

export function createDefaultChannelContextEnvelopeConfig(): ChannelContextEnvelopeConfig {
  return { channels: {} };
}

/**
 * Fail-closed parser for the channels.json `contextEnvelope` section.
 * Exported (E3.2) so Garden channel views and the one-time channel-envelope
 * migration validate against exactly the same rules as runtime load.
 */
export function parseContextEnvelopeSection(
  scopedRoot: Record<string, unknown>,
): ChannelContextEnvelopeConfig {
  const section = parseSectionObject(scopedRoot, 'contextEnvelope');
  if (!section) return createDefaultChannelContextEnvelopeConfig();

  const unknownKeys = Object.keys(section).filter(key => key !== 'channels');
  if (unknownKeys.length > 0) {
    throw new Error(`channels.json.contextEnvelope has unsupported keys: ${unknownKeys.join(', ')}`);
  }

  const channelsRaw = section.channels;
  if (channelsRaw === undefined) return createDefaultChannelContextEnvelopeConfig();
  if (!isRecord(channelsRaw)) {
    throw new Error('channels.json.contextEnvelope.channels must be an object');
  }

  const channels: Record<string, ChannelEnvelopeLabel> = {};
  for (const [rawChannelId, rawLabel] of Object.entries(channelsRaw)) {
    const channelId = rawChannelId.trim();
    if (!channelId) {
      throw new Error('channels.json.contextEnvelope.channels keys must be non-empty channel ids');
    }
    channels[channelId] = validateChannelEnvelopeLabel(
      rawLabel,
      `channels.json.contextEnvelope.channels.${rawChannelId}`,
    );
  }
  return { channels };
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  return parseBooleanEnv(value);
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return undefined;

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseTelegramMode(value: unknown): TelegramMode | undefined {
  if (value !== 'polling' && value !== 'webhook') return undefined;
  return value;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim();
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
  const parsed = parseBoolean(value);
  if (parsed === undefined) {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return parsed;
}

function parseConfiguredPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parsePositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseConfiguredTelegramMode(value: unknown, fieldName: string): TelegramMode | undefined {
  if (value === undefined) return undefined;
  const parsed = parseTelegramMode(value);
  if (parsed === undefined) {
    throw new Error(`${fieldName} must be "polling" or "webhook"`);
  }
  return parsed;
}

function parseConfiguredStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`${fieldName} must contain only strings`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`${fieldName} must not contain empty strings`);
    }
    parsed.push(trimmed);
  }
  return parsed;
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

function parseOverrideStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function parseWebhookPath(value: unknown, fallback: string): string {
  const parsed = parseString(value) ?? fallback;
  const normalized = parsed.trim();
  if (!normalized) return fallback;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function deriveWebhookPathFromUrl(webhookUrl: string): string | undefined {
  if (!webhookUrl) return undefined;
  try {
    const parsed = new URL(webhookUrl);
    const path = parsed.pathname.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

function parseExternalChannelProfile(
  value: unknown,
  fieldName: string,
): ExternalChannelProfileConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  const authorId = parseConfiguredString(value.authorId, `${fieldName}.authorId`);
  const authorName = parseConfiguredString(value.authorName, `${fieldName}.authorName`);
  const canonicalContactId = parseConfiguredString(value.canonicalContactId, `${fieldName}.canonicalContactId`);
  const channelPrivacyRaw = parseConfiguredString(value.channelPrivacy, `${fieldName}.channelPrivacy`);
  const channelPrivacy = channelPrivacyRaw
    ? normalizeChannelVisibility(channelPrivacyRaw)
    : undefined;
  if (channelPrivacyRaw && !channelPrivacy) {
    throw new Error(`${fieldName}.channelPrivacy must be one of: private, invite_only, public, broadcast`);
  }

  const profile: ExternalChannelProfileConfig = {
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(canonicalContactId ? { canonicalContactId } : {}),
    ...(channelPrivacy ? { channelPrivacy } : {}),
  };
  if (Object.keys(profile).length === 0) {
    throw new Error(`${fieldName} must define at least one field`);
  }
  return profile;
}

function parseSectionObject(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(root, key)) return undefined;
  const value = root[key];
  if (!isRecord(value)) {
    throw new Error(`channels.json.${key} must be an object`);
  }
  return value;
}

export function loadChannelsOwnerFile(dataDir: string): Record<string, unknown> {
  const filePath = join(dataDir, CHANNELS_FILE_NAME);
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const text = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error('channels.json must contain a JSON object at the root');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to load channels config from ${filePath}: ${toErrorMessage(error)}`);
  }
}

export function saveChannelsOwnerFile(
  dataDir: string,
  nextConfig: unknown,
): Record<string, unknown> {
  if (!isRecord(nextConfig)) {
    throw new Error('channels.json must contain a JSON object at the root');
  }

  // E3.2: owner-file validation on save — the contextEnvelope section is the
  // channel-owned classification authority, so writes that would fail the
  // runtime load validation are rejected fail-closed instead of persisted.
  const scopedRoot = parseSectionObject(nextConfig, 'channels') ?? nextConfig;
  parseContextEnvelopeSection(scopedRoot);

  const filePath = join(dataDir, CHANNELS_FILE_NAME);
  writeJsonAtomic(filePath, nextConfig);
  return nextConfig;
}

function rejectInlineSecretField(
  scope: Record<string, unknown>,
  legacyField: string,
  replacementField: string,
): void {
  if (Object.hasOwn(scope, legacyField)) {
    throw new Error(`${replacementField} must be used instead of ${replacementField.replace(/Ref$/, '')}`);
  }
}

function resolveCredentialValue(
  reference: CredentialReference | undefined,
  env: NodeJS.ProcessEnv,
  credentialVault?: CredentialVaultPort,
): string {
  if (!reference) return '';
  return resolveOptionalCredentialReference(
    credentialVault,
    reference,
    env,
  ) ?? '';
}

export function loadRuntimeChannelsConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: RuntimeChannelsConfigOverrides = {},
  options: { credentialVault?: CredentialVaultPort } = {},
): RuntimeChannelsConfig {
  const ignoredTelegramEnvKeys = getIgnoredTelegramChannelEnvKeys(env);
  if (ignoredTelegramEnvKeys.length > 0) {
    log.warn('Ignoring legacy Telegram env overrides; use channels.json/settings.json for mutable channel settings', {
      keys: ignoredTelegramEnvKeys,
    });
  }

  const rawConfig = loadChannelsOwnerFile(dataDir);
  const root = isRecord(rawConfig) ? rawConfig : {};
  const scopedRoot = parseSectionObject(root, 'channels') ?? root;
  // Context Envelope labels are validated fail-closed at load (E3.1 contract);
  // classification consumes them in E3.2.
  const contextEnvelope = parseContextEnvelopeSection(scopedRoot);
  const discordConfig = parseSectionObject(scopedRoot, 'discord') ?? {};
  const psfnAmicaConfig = parseSectionObject(scopedRoot, 'psfnAmica') ?? {};
  if (Object.keys(psfnAmicaConfig).length > 0 && !Object.hasOwn(psfnAmicaConfig, 'enabled')) {
    throw new Error('channels.json.psfnAmica.enabled must be configured when psfnAmica settings are present');
  }
  const psfnAmicaEnabled = parseConfiguredBoolean(psfnAmicaConfig.enabled, 'channels.json.psfnAmica.enabled')
    ?? DEFAULT_PSFN_AMICA_CHANNEL_CONFIG.enabled;
  const psfnAmicaDefaultIdentity = parseExternalChannelProfile(
    psfnAmicaConfig.defaultIdentity,
    'channels.json.psfnAmica.defaultIdentity',
  );
  const telegramConfig = parseSectionObject(scopedRoot, 'telegram') ?? {};
  if (Object.keys(telegramConfig).length > 0 && !Object.hasOwn(telegramConfig, 'enabled')) {
    throw new Error('channels.json.telegram.enabled must be configured when telegram settings are present');
  }
  const telegramOverride = overrides.telegram ?? {};
  const enabledOverride = typeof telegramOverride.enabled === 'boolean'
    ? telegramOverride.enabled
    : undefined;
  const allowedUsersOverride = Array.isArray(telegramOverride.allowedUsers)
    ? parseOverrideStringArray(telegramOverride.allowedUsers)
    : undefined;

  const enabled = enabledOverride
    ?? parseConfiguredBoolean(telegramConfig.enabled, 'channels.json.telegram.enabled')
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.enabled;

  rejectInlineSecretField(telegramConfig, 'token', 'channels.json.telegram.tokenRef');
  const tokenRef = parseConfiguredCredentialReference(
    telegramConfig.tokenRef,
    'channels.json.telegram.tokenRef',
  );
  const token = resolveCredentialValue(
    tokenRef,
    env,
    options.credentialVault,
  ).trim();
  if (enabled && !token) {
    throw new Error('channels.json.telegram.tokenRef must be configured when telegram is enabled');
  }

  const allowedUsers = allowedUsersOverride
    ?? parseConfiguredStringArray(telegramConfig.allowedUsers, 'channels.json.telegram.allowedUsers')
    ?? [];

  const mode = parseConfiguredTelegramMode(
    telegramConfig.mode,
    'channels.json.telegram.mode',
  ) ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.mode;
  if (enabled && !Object.hasOwn(telegramConfig, 'mode')) {
    throw new Error('channels.json.telegram.mode must be configured when telegram is enabled');
  }

  const pollIntervalMs = parseConfiguredPositiveInteger(telegramConfig.pollIntervalMs, 'channels.json.telegram.pollIntervalMs')
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.pollIntervalMs;
  if (enabled && !Object.hasOwn(telegramConfig, 'pollIntervalMs')) {
    throw new Error('channels.json.telegram.pollIntervalMs must be configured when telegram is enabled');
  }

  const webhookConfig = parseSectionObject(telegramConfig, 'webhook') ?? {};
  rejectInlineSecretField(
    webhookConfig,
    'secret',
    'channels.json.telegram.webhook.secretRef',
  );
  const hasWebhookUrl = Object.hasOwn(telegramConfig, 'webhook') && Object.hasOwn(webhookConfig, 'url');
  const hasWebhookSecret = Object.hasOwn(telegramConfig, 'webhook') && Object.hasOwn(webhookConfig, 'secretRef');
  const hasWebhookHost = Object.hasOwn(telegramConfig, 'webhook') && Object.hasOwn(webhookConfig, 'host');
  const hasWebhookPort = Object.hasOwn(telegramConfig, 'webhook') && Object.hasOwn(webhookConfig, 'port');
  const hasWebhookPath = Object.hasOwn(telegramConfig, 'webhook') && Object.hasOwn(webhookConfig, 'path');
  const webhookUrl = parseConfiguredString(webhookConfig.url, 'channels.json.telegram.webhook.url')
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.webhook.url;
  const webhookSecretRef = parseConfiguredCredentialReference(
    webhookConfig.secretRef,
    'channels.json.telegram.webhook.secretRef',
  );
  const webhookSecret = resolveCredentialValue(
    webhookSecretRef,
    env,
    options.credentialVault,
  ).trim();
  const webhookHost = parseConfiguredString(webhookConfig.host, 'channels.json.telegram.webhook.host')
    ?? DEFAULT_TELEGRAM_WEBHOOK_HOST;
  const webhookPort = parseConfiguredPositiveInteger(webhookConfig.port, 'channels.json.telegram.webhook.port')
    ?? DEFAULT_TELEGRAM_WEBHOOK_PORT;
  const webhookPathFallback = deriveWebhookPathFromUrl(webhookUrl)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.webhook.path;
  const webhookPath = parseWebhookPath(webhookConfig.path, webhookPathFallback);

  if (enabled && mode === 'webhook') {
    if (!hasWebhookUrl || !webhookUrl) {
      throw new Error('channels.json.telegram.webhook.url must be configured when telegram is enabled in webhook mode');
    }
    if (!hasWebhookSecret || !webhookSecret) {
      throw new Error('channels.json.telegram.webhook.secretRef must be configured when telegram is enabled in webhook mode');
    }
    if (!hasWebhookHost || !webhookHost) {
      throw new Error('channels.json.telegram.webhook.host must be configured when telegram is enabled in webhook mode');
    }
    if (!hasWebhookPort || !webhookPort) {
      throw new Error('channels.json.telegram.webhook.port must be configured when telegram is enabled in webhook mode');
    }
    if (!hasWebhookPath || !webhookPath) {
      throw new Error('channels.json.telegram.webhook.path must be configured when telegram is enabled in webhook mode');
    }
  }

  return {
    discord: {
      heartbeatChannelId: parseConfiguredString(discordConfig.heartbeatChannelId, 'channels.json.discord.heartbeatChannelId')
        ?? DEFAULT_DISCORD_CHANNEL_CONFIG.heartbeatChannelId,
      allowedBotUserIds: parseConfiguredStringArray(discordConfig.allowedBotUserIds, 'channels.json.discord.allowedBotUserIds')
        ?? DEFAULT_DISCORD_CHANNEL_CONFIG.allowedBotUserIds,
      groupMemory: normalizeChannelGroupMemoryConfig(
        discordConfig.groupMemory,
        'channels.json.discord.groupMemory',
      ) ?? createDefaultChannelGroupMemoryConfig(),
    },
    psfnAmica: {
      enabled: psfnAmicaEnabled,
      ...(psfnAmicaDefaultIdentity && psfnAmicaEnabled ? { defaultIdentity: psfnAmicaDefaultIdentity } : {}),
    },
    telegram: {
      enabled,
      token,
      allowedUsers,
      mode,
      pollIntervalMs,
      webhook: {
        url: webhookUrl,
        secret: webhookSecret,
        host: webhookHost || DEFAULT_TELEGRAM_WEBHOOK_HOST,
        port: webhookPort,
        path: webhookPath,
      },
    },
    contextEnvelope,
  };
}

export function buildExternalChannelProfiles(
  config: RuntimeChannelsConfig,
): Partial<Record<ChannelType, ExternalChannelProfileConfig>> {
  return config.psfnAmica.enabled && config.psfnAmica.defaultIdentity
    ? { 'psfn-amica': config.psfnAmica.defaultIdentity }
    : {};
}
