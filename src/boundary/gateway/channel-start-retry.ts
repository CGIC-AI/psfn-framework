/**
 * Start-retry policy and retryability classifier shared by every gateway
 * channel surface (Discord, Telegram, installable plugins) under
 * ChannelSurfaceSupervisor (psfn-framework-hvyrl; formerly Discord-named).
 *
 * The policy is env-owned gateway bootstrap wiring, like
 * SHUTDOWN_FORCE_EXIT_TIMEOUT_MS: it shapes how this process starts, not a
 * mutable runtime setting an operator edits live.
 */
import { parsePositiveIntEnv } from '../../shared/utils/env.js';

const DEFAULT_CHANNEL_SURFACE_START_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_CHANNEL_SURFACE_START_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_CHANNEL_SURFACE_START_RETRY_MAX_ATTEMPTS = 0;

const RETRYABLE_CHANNEL_SURFACE_START_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const RETRYABLE_CHANNEL_SURFACE_START_PATTERNS = [
  'connect timeout',
  'timed out',
  'socket hang up',
  'network error',
  'fetch failed',
  'temporarily unavailable',
  'connection reset',
] as const;

function parseStatusCode(error: Error): number | null {
  const record = error as unknown as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  const maybeStatus = record.status ?? record.statusCode ?? response?.status;
  if (typeof maybeStatus === 'number' && Number.isFinite(maybeStatus)) {
    return maybeStatus;
  }
  const match = error.message.match(/\b(?:status|code)\s*[:=]?\s*([45]\d{2})\b/i);
  if (match?.[1]) {
    return Number.parseInt(match[1], 10);
  }
  return null;
}

function parseErrorCode(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return null;
  }
  return code.trim().toUpperCase();
}

export function isRetryableChannelSurfaceStartError(error: Error): boolean {
  const statusCode = parseStatusCode(error);
  if (statusCode === 408 || statusCode === 429) return true;
  if (statusCode !== null && statusCode >= 500 && statusCode <= 599) return true;
  if (statusCode !== null && statusCode >= 400 && statusCode <= 499) return false;

  const code = parseErrorCode(error);
  if (code && RETRYABLE_CHANNEL_SURFACE_START_CODES.has(code)) return true;

  const combined = `${error.name} ${error.message}`.toLowerCase();
  return RETRYABLE_CHANNEL_SURFACE_START_PATTERNS.some((pattern) => combined.includes(pattern));
}

export interface ChannelSurfaceStartRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/**
 * Retired Discord-named variables, each with its channel-surface replacement.
 * Setting one is refused rather than ignored: silently dropping an operator's
 * value would quietly change startup behaviour.
 */
const SUPERSEDED_CHANNEL_ENV_NAMES: ReadonlyArray<readonly [string, string]> = [
  'BASE_DELAY_MS',
  'MAX_DELAY_MS',
  'MAX_ATTEMPTS',
].map(suffix => [`DISCORD_START_RETRY_${suffix}`, `CHANNEL_SURFACE_START_RETRY_${suffix}`] as const);

export function resolveChannelSurfaceStartRetry(env: NodeJS.ProcessEnv): ChannelSurfaceStartRetryPolicy {
  for (const [retired, replacement] of SUPERSEDED_CHANNEL_ENV_NAMES) {
    if (env[retired] !== undefined) {
      throw new Error(
        `${retired} was renamed to ${replacement}: the start-retry policy applies to every `
        + 'channel surface, not only Discord. Rename the variable.',
      );
    }
  }
  return {
    baseDelayMs: parsePositiveIntEnv(
      env.CHANNEL_SURFACE_START_RETRY_BASE_DELAY_MS,
      DEFAULT_CHANNEL_SURFACE_START_RETRY_BASE_DELAY_MS,
    ),
    maxDelayMs: parsePositiveIntEnv(
      env.CHANNEL_SURFACE_START_RETRY_MAX_DELAY_MS,
      DEFAULT_CHANNEL_SURFACE_START_RETRY_MAX_DELAY_MS,
    ),
    maxAttempts: parsePositiveIntEnv(
      env.CHANNEL_SURFACE_START_RETRY_MAX_ATTEMPTS,
      DEFAULT_CHANNEL_SURFACE_START_RETRY_MAX_ATTEMPTS,
    ),
  };
}
