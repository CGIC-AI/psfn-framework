const DEFAULT_MAX_KEYS = 500;

export interface RateLimitedLogEmitterOptions {
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

export type RateLimitedLogEmitter = (key: string, emit: () => void) => boolean;

export function createRateLimitedLogEmitter(
  options: RateLimitedLogEmitterOptions,
): RateLimitedLogEmitter {
  const rawWindowMs = Number.isFinite(options.windowMs) ? options.windowMs : 0;
  const windowMs = Math.max(0, Math.floor(rawWindowMs));
  const rawMaxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const maxKeys = Number.isFinite(rawMaxKeys)
    ? Math.max(1, Math.floor(rawMaxKeys))
    : DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  const lastLoggedAtByKey = new Map<string, number>();

  const prune = (currentTime: number): void => {
    const cutoff = currentTime - windowMs;
    for (const [entryKey, loggedAt] of lastLoggedAtByKey.entries()) {
      if (loggedAt <= cutoff) {
        lastLoggedAtByKey.delete(entryKey);
      }
    }

    while (lastLoggedAtByKey.size > maxKeys) {
      // Evict the oldest entry unconditionally: bailing on unexpected key
      // types would let the map grow without bound.
      const oldest = lastLoggedAtByKey.keys().next();
      if (oldest.done) return;
      lastLoggedAtByKey.delete(oldest.value);
    }
  };

  return (key: string, emit: () => void): boolean => {
    const currentTime = now();
    const lastLoggedAt = lastLoggedAtByKey.get(key);
    if (lastLoggedAt !== undefined && currentTime - lastLoggedAt < windowMs) {
      return false;
    }

    lastLoggedAtByKey.set(key, currentTime);
    prune(currentTime);
    emit();
    return true;
  };
}
