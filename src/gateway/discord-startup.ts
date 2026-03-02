export const DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS = 2_000;
export const DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS = 30_000;
export const DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS = 0;

const RETRYABLE_DISCORD_START_CODES = new Set([
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

const RETRYABLE_DISCORD_START_PATTERNS = [
  'connect timeout',
  'timed out',
  'socket hang up',
  'network error',
  'fetch failed',
  'temporarily unavailable',
  'connection reset',
] as const;

export interface DiscordStartRetryAttempt {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: Error;
}

export interface DiscordStartRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: Error) => boolean;
  onRetry?: (attempt: DiscordStartRetryAttempt) => void | Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function parseStatusCode(error: Error): number | null {
  const record = error as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  const maybeStatus = record.status ?? record.statusCode ?? response?.status;
  if (typeof maybeStatus === 'number' && Number.isFinite(maybeStatus)) {
    return maybeStatus;
  }
  const match = error.message.match(/\b(?:status|code)\s*[:=]?\s*([45]\d{2})\b/i);
  if (match) {
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

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value!);
  return parsed >= 0 ? parsed : fallback;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value!);
  return parsed > 0 ? parsed : fallback;
}

function backoffDelayMs(baseDelayMs: number, maxDelayMs: number, attempt: number): number {
  const rawDelay = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  if (!Number.isFinite(rawDelay)) return maxDelayMs;
  return Math.min(maxDelayMs, rawDelay);
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function isRetryableDiscordStartError(error: Error): boolean {
  const statusCode = parseStatusCode(error);
  if (statusCode === 408 || statusCode === 429) return true;
  if (statusCode !== null && statusCode >= 500 && statusCode <= 599) return true;
  if (statusCode !== null && statusCode >= 400 && statusCode <= 499) return false;

  const code = parseErrorCode(error);
  if (code && RETRYABLE_DISCORD_START_CODES.has(code)) return true;

  const combined = `${error.name} ${error.message}`.toLowerCase();
  return RETRYABLE_DISCORD_START_PATTERNS.some((pattern) => combined.includes(pattern));
}

export async function startDiscordWithRetry(
  start: () => Promise<void>,
  options: DiscordStartRetryOptions = {},
): Promise<void> {
  const maxAttempts = normalizeNonNegativeInt(
    options.maxAttempts,
    DEFAULT_DISCORD_START_RETRY_MAX_ATTEMPTS,
  );
  const baseDelayMs = normalizePositiveInt(
    options.baseDelayMs,
    DEFAULT_DISCORD_START_RETRY_BASE_DELAY_MS,
  );
  const maxDelayMs = normalizePositiveInt(
    options.maxDelayMs,
    DEFAULT_DISCORD_START_RETRY_MAX_DELAY_MS,
  );
  const sleep = options.sleep ?? defaultSleep;
  const isRetryable = options.isRetryable ?? isRetryableDiscordStartError;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await start();
      return;
    } catch (error) {
      const err = toError(error);
      const retryable = isRetryable(err);
      const canRetry = maxAttempts <= 0 || attempt < maxAttempts;
      if (!retryable || !canRetry) throw err;

      const delayMs = backoffDelayMs(baseDelayMs, maxDelayMs, attempt);
      await options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        error: err,
      });
      await sleep(delayMs);
    }
  }
}
