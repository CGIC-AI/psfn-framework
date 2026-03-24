import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../logger.js';
import { getIgnoredTelegramChannelEnvKeys } from '../config/legacy-env.js';
import { toErrorMessage } from '../utils/errors.js';
import { parseBooleanEnv } from '../utils/env.js';
import { isRecord } from '../utils/types.js';

const log = createComponentLogger('ChannelConfig');

const CHANNELS_CONFIG_FILE = 'channels.json';
const ENV_TOKEN_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
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
}

export interface RuntimeChannelsConfig {
  discord: DiscordChannelConfig;
  telegram: TelegramChannelConfig;
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
};

function interpolateEnvTokens(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_TOKEN_PATTERN, (_match, token: string) => env[token] ?? '');
  }
  if (Array.isArray(value)) {
    return value.map(item => interpolateEnvTokens(item, env));
  }
  if (!isRecord(value)) return value;

  const mapped: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    mapped[key] = interpolateEnvTokens(nested, env);
  }
  return mapped;
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

function parseStringArray(value: unknown): string[] {
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

function loadRawChannelsConfig(dataDir: string): Record<string, unknown> {
  const filePath = join(dataDir, CHANNELS_CONFIG_FILE);
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const text = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return {};
    return parsed;
  } catch (error) {
    log.warn('Failed to parse channels config JSON, using defaults', {
      filePath,
      error: toErrorMessage(error),
    });
    return {};
  }
}

export function loadRuntimeChannelsConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: RuntimeChannelsConfigOverrides = {},
): RuntimeChannelsConfig {
  const ignoredTelegramEnvKeys = getIgnoredTelegramChannelEnvKeys(env);
  if (ignoredTelegramEnvKeys.length > 0) {
    log.warn('Ignoring legacy Telegram env overrides; use channels.json/settings.json for mutable channel settings', {
      keys: ignoredTelegramEnvKeys,
    });
  }

  const rawConfig = loadRawChannelsConfig(dataDir);
  const interpolated = interpolateEnvTokens(rawConfig, env);
  const root = isRecord(interpolated) ? interpolated : {};
  const scopedRoot = isRecord(root.channels) ? root.channels : root;
  const discordConfig = isRecord(scopedRoot.discord)
    ? scopedRoot.discord
    : {};
  const telegramConfig = isRecord(scopedRoot.telegram)
    ? scopedRoot.telegram
    : {};
  const telegramOverride = overrides.telegram ?? {};
  const enabledOverride = typeof telegramOverride.enabled === 'boolean'
    ? telegramOverride.enabled
    : undefined;
  const allowedUsersOverride = Array.isArray(telegramOverride.allowedUsers)
    ? parseStringArray(telegramOverride.allowedUsers)
    : undefined;

  const enabled = enabledOverride
    ?? parseBoolean(telegramConfig.enabled)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.enabled;

  const tokenFromFile = typeof telegramConfig.token === 'string'
    ? telegramConfig.token.trim()
    : DEFAULT_TELEGRAM_CHANNEL_CONFIG.token;
  const token = (env.TELEGRAM_BOT_TOKEN ?? tokenFromFile).trim();

  const allowedUsers = allowedUsersOverride
    ?? parseStringArray(telegramConfig.allowedUsers);

  const mode = parseTelegramMode(telegramConfig.mode)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.mode;

  const pollIntervalMs = parsePositiveInteger(telegramConfig.pollIntervalMs)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.pollIntervalMs;

  const webhookConfig = isRecord(telegramConfig.webhook)
    ? telegramConfig.webhook
    : {};
  const webhookUrl = (env.TELEGRAM_WEBHOOK_URL
    ?? parseString(webhookConfig.url)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.webhook.url).trim();
  const webhookSecret = (env.TELEGRAM_WEBHOOK_SECRET
    ?? parseString(webhookConfig.secret)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.webhook.secret).trim();
  const webhookHost = (env.TELEGRAM_WEBHOOK_HOST
    ?? parseString(webhookConfig.host)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.webhook.host).trim();
  const webhookPort = parsePositiveInteger(env.TELEGRAM_WEBHOOK_PORT)
    ?? parsePositiveInteger(webhookConfig.port)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.webhook.port;
  const webhookPathFallback = deriveWebhookPathFromUrl(webhookUrl)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.webhook.path;
  const webhookPath = parseWebhookPath(
    env.TELEGRAM_WEBHOOK_PATH ?? webhookConfig.path,
    webhookPathFallback,
  );

  return {
    discord: {
      heartbeatChannelId: parseString(discordConfig.heartbeatChannelId)
        ?? DEFAULT_DISCORD_CHANNEL_CONFIG.heartbeatChannelId,
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
  };
}
