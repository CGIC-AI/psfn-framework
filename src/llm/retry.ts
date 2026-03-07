export interface RetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  retryableErrors?: string[];
}

export interface RetryAttempt {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: Error;
}

export interface RetryOptions {
  isRetryable?: (error: Error) => boolean;
  onRetry?: (attempt: RetryAttempt) => void | Promise<void>;
  sleep?: (delayMs: number) => Promise<void>;
}

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 2000;

const DEFAULT_RETRYABLE_ERROR_PATTERNS = [
  '429',
  '502',
  '503',
  '504',
  'rate limit',
  'too many requests',
  'timeout',
  'timed out',
  'temporarily unavailable',
  'service unavailable',
  'overloaded',
  'connection reset',
  'socket hang up',
  'econnreset',
  'etimedout',
  'eai_again',
  'network error',
  'fetch failed',
] as const;

const NON_RETRYABLE_ERROR = Symbol('non-retryable-error');

type MarkedError = Error & {
  [NON_RETRYABLE_ERROR]?: true;
};

interface ResolvedRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  retryableErrors: string[];
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function parseStatusCode(error: Error): number | null {
  const record = error as unknown as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  const maybeStatus = record.status
    ?? record.statusCode
    ?? response?.status;

  if (typeof maybeStatus === 'number' && Number.isFinite(maybeStatus)) {
    return maybeStatus;
  }

  const messageMatch = error.message.match(/\b([45]\d{2})\b/);
  if (messageMatch) {
    return parseInt(messageMatch[1], 10);
  }

  return null;
}

function resolveRetryConfig(config?: RetryConfig): ResolvedRetryConfig {
  const maxRetries = Number.isFinite(config?.maxRetries)
    ? Math.max(0, Math.floor(config!.maxRetries!))
    : DEFAULT_MAX_RETRIES;
  const baseDelayMs = Number.isFinite(config?.baseDelayMs)
    ? Math.max(0, Math.floor(config!.baseDelayMs!))
    : DEFAULT_BASE_DELAY_MS;

  return {
    maxRetries,
    baseDelayMs,
    retryableErrors: [...(config?.retryableErrors ?? DEFAULT_RETRYABLE_ERROR_PATTERNS)],
  };
}

function backoffDelay(baseDelayMs: number, retryAttemptIndex: number): number {
  return baseDelayMs * (2 ** retryAttemptIndex);
}

export function markErrorAsNonRetryable(error: Error): Error {
  (error as MarkedError)[NON_RETRYABLE_ERROR] = true;
  return error;
}

export function isRetryableError(error: Error, patterns?: string[]): boolean {
  const marked = (error as MarkedError)[NON_RETRYABLE_ERROR];
  if (marked) return false;

  const status = parseStatusCode(error);
  if (status === 429 || status === 408) return true;
  if (status !== null && status >= 500 && status <= 599) return true;
  if (status !== null && status >= 400 && status <= 499) return false;

  const text = `${error.name} ${error.message}`.toLowerCase();
  const checks = patterns ?? DEFAULT_RETRYABLE_ERROR_PATTERNS;
  return checks.some((pattern) => text.includes(pattern.toLowerCase()));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  options?: RetryOptions,
): Promise<T> {
  const resolved = resolveRetryConfig(config);
  const sleep = options?.sleep ?? defaultSleep;
  const isRetryable = options?.isRetryable
    ?? ((error: Error) => isRetryableError(error, resolved.retryableErrors));

  for (let retryAttempt = 0; ; retryAttempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = toError(error);
      const canRetry = retryAttempt < resolved.maxRetries && isRetryable(err);
      if (!canRetry) throw err;

      const delayMs = backoffDelay(resolved.baseDelayMs, retryAttempt);
      await options?.onRetry?.({
        attempt: retryAttempt + 1,
        maxRetries: resolved.maxRetries,
        delayMs,
        error: err,
      });
      await sleep(delayMs);
    }
  }
}
