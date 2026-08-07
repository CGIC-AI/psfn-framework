export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Compute an exponential backoff delay for a given zero-based attempt index.
 *
 * - Attempt 0 returns `baseMs`.
 * - Attempt 1 returns `baseMs * 2`.
 * - The result is capped at `maxMs` when `maxMs` is finite.
 */
export function backoffMs(baseMs: number, attemptIndex: number, maxMs = Number.POSITIVE_INFINITY): number {
  const raw = baseMs * (2 ** Math.max(0, attemptIndex));
  if (!Number.isFinite(maxMs)) return raw;
  return Math.min(maxMs, Number.isFinite(raw) ? raw : maxMs);
}
