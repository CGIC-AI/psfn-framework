import {
  cloneAppCacheStats,
  createEmptyAppCacheStats,
  type AppCache,
  type AppCacheSetOptions,
  type AppCacheStats,
} from './types.js';

interface MemoryCacheEntry {
  value: string;
  expiresAtMs: number | null;
}

export interface MemoryAppCacheOptions {
  name?: string;
  nowMs?: () => number;
}

function resolveExpiresAtMs(nowMs: number, options?: AppCacheSetOptions): number | null {
  if (options?.ttlMs === undefined) return null;
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error('cache ttlMs must be a positive finite number');
  }
  return nowMs + Math.ceil(options.ttlMs);
}

export class MemoryAppCache implements AppCache {
  readonly backend = 'memory' as const;
  readonly name: string;
  private readonly entries = new Map<string, MemoryCacheEntry>();
  private readonly stats = createEmptyAppCacheStats();
  private readonly nowMs: () => number;

  constructor(options: MemoryAppCacheOptions = {}) {
    this.name = options.name ?? 'memory-app-cache';
    this.nowMs = options.nowMs ?? Date.now;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }

    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(key);
      this.stats.misses += 1;
      return null;
    }

    this.stats.hits += 1;
    return entry.value;
  }

  async set(key: string, value: string, options?: AppCacheSetOptions): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAtMs: resolveExpiresAtMs(this.nowMs(), options),
    });
    this.stats.sets += 1;
  }

  async delete(key: string): Promise<boolean> {
    const deleted = this.entries.delete(key);
    if (deleted) {
      this.stats.deletes += 1;
    }
    return deleted;
  }

  async invalidatePrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      removed += 1;
    }
    this.stats.invalidations += 1;
    this.stats.deletes += removed;
    return removed;
  }

  getStats(): AppCacheStats {
    return cloneAppCacheStats(this.stats);
  }
}

export function createMemoryAppCache(options: MemoryAppCacheOptions = {}): MemoryAppCache {
  return new MemoryAppCache(options);
}
