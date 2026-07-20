export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted && error === signal.reason) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if ((typeof DOMException !== 'undefined' && reason instanceof DOMException
      && reason.name === 'AbortError')
    || (reason instanceof Error && reason.name === 'AbortError')) {
    throw reason;
  }
  throw new DOMException(
    reason instanceof Error && reason.message ? reason.message : 'Request aborted',
    'AbortError',
  );
}
