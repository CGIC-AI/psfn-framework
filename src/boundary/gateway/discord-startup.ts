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
