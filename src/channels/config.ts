import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ChannelConfig');

const CHANNELS_CONFIG_FILE = 'channels.json';
const ENV_TOKEN_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const DEFAULT_TELEGRAM_POLL_INTERVAL_MS = 1_000;

export type TelegramMode = 'polling' | 'webhook';

export interface TelegramChannelConfig {
  enabled: boolean;
  token: string;
  allowedUsers: string[];
  mode: TelegramMode;
  pollIntervalMs: number;
}

export interface RuntimeChannelsConfig {
  telegram: TelegramChannelConfig;
}

const DEFAULT_TELEGRAM_CHANNEL_CONFIG: TelegramChannelConfig = {
  enabled: false,
  token: '',
  allowedUsers: [],
  mode: 'polling',
  pollIntervalMs: DEFAULT_TELEGRAM_POLL_INTERVAL_MS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
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

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function parseAllowlistFromEnv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
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
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export function loadRuntimeChannelsConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeChannelsConfig {
  const rawConfig = loadRawChannelsConfig(dataDir);
  const interpolated = interpolateEnvTokens(rawConfig, env);
  const root = isRecord(interpolated) ? interpolated : {};
  const scopedRoot = isRecord(root.channels) ? root.channels : root;
  const telegramConfig = isRecord(scopedRoot.telegram)
    ? scopedRoot.telegram
    : {};

  const enabled = parseBoolean(env.TELEGRAM_ENABLED)
    ?? parseBoolean(telegramConfig.enabled)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.enabled;

  const tokenFromFile = typeof telegramConfig.token === 'string'
    ? telegramConfig.token.trim()
    : DEFAULT_TELEGRAM_CHANNEL_CONFIG.token;
  const token = (env.TELEGRAM_BOT_TOKEN ?? tokenFromFile).trim();

  const allowedUsers = parseAllowlistFromEnv(env.TELEGRAM_ALLOWED_USERS)
    ?? parseStringArray(telegramConfig.allowedUsers);

  const mode = parseTelegramMode(env.TELEGRAM_MODE)
    ?? parseTelegramMode(telegramConfig.mode)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.mode;

  const pollIntervalMs = parsePositiveInteger(env.TELEGRAM_POLL_INTERVAL_MS)
    ?? parsePositiveInteger(telegramConfig.pollIntervalMs)
    ?? DEFAULT_TELEGRAM_CHANNEL_CONFIG.pollIntervalMs;

  return {
    telegram: {
      enabled,
      token,
      allowedUsers,
      mode,
      pollIntervalMs,
    },
  };
}
