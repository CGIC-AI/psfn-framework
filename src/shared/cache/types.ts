export interface AppCacheSetOptions {
  ttlMs?: number;
}

export interface AppCacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  invalidations: number;
  errors: number;
}

export interface AppCache {
  readonly backend: 'memory' | 'redis';
  readonly name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: AppCacheSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  invalidatePrefix(prefix: string): Promise<number>;
  getStats(): AppCacheStats;
  close?(): Promise<void>;
}

export function createEmptyAppCacheStats(): AppCacheStats {
  return {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    invalidations: 0,
    errors: 0,
  };
}

export function cloneAppCacheStats(stats: AppCacheStats): AppCacheStats {
  return { ...stats };
}
