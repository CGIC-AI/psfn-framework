export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function abortError(
  reason?: unknown,
  fallbackMessage = 'Request aborted',
  preserveEmptyString = false,
): Error {
  if (reason instanceof Error) {
    reason.name = reason.name || 'AbortError';
    return reason;
  }
  const message = typeof reason === 'string'
    && (preserveEmptyString || reason.trim().length > 0)
    ? reason
    : fallbackMessage;
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
