export type LLMErrorCategory =
  | 'abort'
  | 'context_overflow'
  | 'rate_limit'
  | 'timeout'
  | 'auth'
  | 'empty_response'
  | 'unknown';

export interface LLMErrorClassification {
  category: LLMErrorCategory;
  retryable: boolean;
  statusCode?: number;
}

interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  response?: {
    status?: unknown;
  };
  cause?: unknown;
}

const ABORT_PATTERNS = [
  'abort',
  'cancelled',
  'canceled',
] as const;

const CONTEXT_OVERFLOW_PATTERNS = [
  'context length',
  'maximum context length',
  'prompt is too long',
  'prompt too long',
  'context window',
  'too many tokens',
  'token limit',
  'input is too long',
] as const;

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'too many requests',
  'quota exceeded',
  'requests per minute',
  'tokens per minute',
  'over capacity',
  'temporarily overloaded',
] as const;

const TIMEOUT_PATTERNS = [
  'timeout',
  'timed out',
  'deadline exceeded',
  'socket hang up',
  'connection reset',
  'econnreset',
  'etimedout',
  'eai_again',
  'network timeout',
] as const;

const AUTH_PATTERNS = [
  'unauthorized',
  'forbidden',
  'invalid api key',
  'authentication failed',
  'authentication error',
  'access denied',
  'permission denied',
] as const;

const EMPTY_RESPONSE_PATTERNS = [
  'contained no text',
  'contained no text or tool calls',
  'empty response',
  'empty assistant',
  'no text content',
  'provider template artifact',
] as const;

function getStatusCode(error: ErrorLike): number | undefined {
  const fromError = typeof error.status === 'number' ? error.status : undefined;
  if (fromError !== undefined && Number.isFinite(fromError)) return fromError;

  const fromStatusCode = typeof error.statusCode === 'number' ? error.statusCode : undefined;
  if (fromStatusCode !== undefined && Number.isFinite(fromStatusCode)) return fromStatusCode;

  const fromResponse = typeof error.response?.status === 'number'
    ? error.response.status
    : undefined;
  if (fromResponse !== undefined && Number.isFinite(fromResponse)) return fromResponse;

  return undefined;
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function readErrorCode(error: ErrorLike): string | undefined {
  if (typeof error.code === 'string' && error.code.trim().length > 0) {
    return error.code.toUpperCase();
  }
  if (error.cause && typeof error.cause === 'object') {
    return readErrorCode(error.cause as ErrorLike);
  }
  return undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function classifyLLMError(error: unknown): LLMErrorClassification {
  const err = toError(error);
  const errorLike = err as ErrorLike;
  const statusCode = getStatusCode(errorLike);
  const text = `${err.name} ${err.message}`.toLowerCase();
  const code = readErrorCode(errorLike);

  const abortByCode = code === 'ABORT_ERR' || code === 'ERR_ABORTED';
  const abortByName = err.name === 'AbortError';
  if (abortByCode || abortByName || includesAny(text, ABORT_PATTERNS)) {
    return { category: 'abort', retryable: false, ...(statusCode !== undefined ? { statusCode } : {}) };
  }

  const contextStatus = statusCode === 400 || statusCode === 413 || statusCode === 422;
  if (contextStatus || includesAny(text, CONTEXT_OVERFLOW_PATTERNS)) {
    return { category: 'context_overflow', retryable: false, ...(statusCode !== undefined ? { statusCode } : {}) };
  }

  if (statusCode === 429 || includesAny(text, RATE_LIMIT_PATTERNS)) {
    return { category: 'rate_limit', retryable: true, ...(statusCode !== undefined ? { statusCode } : {}) };
  }

  const timeoutStatus = statusCode === 408 || statusCode === 504;
  const timeoutCode = code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'ECONNRESET';
  if (timeoutStatus || timeoutCode || includesAny(text, TIMEOUT_PATTERNS)) {
    return { category: 'timeout', retryable: true, ...(statusCode !== undefined ? { statusCode } : {}) };
  }

  if (statusCode === 401 || statusCode === 403 || includesAny(text, AUTH_PATTERNS)) {
    return { category: 'auth', retryable: true, ...(statusCode !== undefined ? { statusCode } : {}) };
  }

  if (includesAny(text, EMPTY_RESPONSE_PATTERNS)) {
    return { category: 'empty_response', retryable: true, ...(statusCode !== undefined ? { statusCode } : {}) };
  }

  return { category: 'unknown', retryable: true, ...(statusCode !== undefined ? { statusCode } : {}) };
}
