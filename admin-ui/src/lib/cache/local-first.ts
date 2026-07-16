import { isRecord } from '../../../../src/shared/utils/types.js';
import type { GardenCacheStorage } from './indexeddb';

export type { GardenCacheStorage } from './indexeddb';

const GARDEN_CACHE_RECORD_SCHEMA_VERSION = 1;

export interface CachedResourceSnapshot<T> {
  data: T;
  etag: string;
  cursor: string | null;
  savedAt: number;
}

export interface ConditionalFetchRequest {
  etag?: string;
  cursor?: string;
  forceFull: boolean;
}

export type ConditionalFetchResponse =
  | { kind: 'not_modified'; etag?: string }
  | { kind: 'data'; data: unknown; etag: string | null };

export type LocalFirstMergeResult<T> =
  | { kind: 'merged'; data: T; cursor?: string | null }
  | { kind: 'stale_cursor' };

export type LocalFirstDataSource = 'cache' | 'network' | 'not_modified' | 'full_refetch';

export interface LocalFirstResult<T> {
  data: T;
  source: Exclude<LocalFirstDataSource, 'cache'>;
  etag: string;
  cursor: string | null;
}

interface LocalFirstResourceOptions<T> {
  key: string;
  storage: GardenCacheStorage;
  validate(value: unknown): value is T;
  fetch(request: ConditionalFetchRequest): Promise<ConditionalFetchResponse>;
  cursor?(data: T): string | null;
  merge?(cached: T, fresh: T, cursor: string | null): LocalFirstMergeResult<T>;
  now?: () => number;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class LocalFirstResource<T> {
  private readonly now: () => number;

  constructor(private readonly options: LocalFirstResourceOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  async read(): Promise<CachedResourceSnapshot<T> | null> {
    const raw = await this.options.storage.read(this.options.key);
    if (raw === undefined) return null;
    if (!isRecord(raw)
      || raw.schemaVersion !== GARDEN_CACHE_RECORD_SCHEMA_VERSION
      || !nonEmptyString(raw.etag)
      || typeof raw.savedAt !== 'number'
      || !Number.isFinite(raw.savedAt)
      || !(raw.cursor === null || typeof raw.cursor === 'string')
      || !this.options.validate(raw.data)) {
      await this.options.storage.remove(this.options.key);
      return null;
    }
    return {
      data: raw.data,
      etag: raw.etag,
      cursor: raw.cursor,
      savedAt: raw.savedAt,
    };
  }

  async remove(): Promise<void> {
    await this.options.storage.remove(this.options.key);
  }

  async load(onData: (data: T, source: LocalFirstDataSource) => void): Promise<LocalFirstResult<T>> {
    const cached = await this.read();
    if (cached) onData(cached.data, 'cache');
    const result = await this.revalidate(cached);
    onData(result.data, result.source);
    return result;
  }

  async revalidate(
    knownCached?: CachedResourceSnapshot<T> | null,
  ): Promise<LocalFirstResult<T>> {
    const cached = knownCached === undefined ? await this.read() : knownCached;
    const request: ConditionalFetchRequest = cached
      ? {
          etag: cached.etag,
          ...(cached.cursor !== null ? { cursor: cached.cursor } : {}),
          forceFull: false,
        }
      : { forceFull: false };
    const response = await this.options.fetch(request);
    if (response.kind === 'not_modified') {
      if (!cached) {
        throw new Error(`Garden cache ${this.options.key} received 304 without a cached body`);
      }
      const etag = response.etag === undefined ? cached.etag : response.etag;
      if (!nonEmptyString(etag)) {
        throw new Error(`Garden cache ${this.options.key} received an invalid ETag`);
      }
      if (etag !== cached.etag) {
        await this.write(cached.data, etag, cached.cursor);
      }
      return {
        data: cached.data,
        source: 'not_modified',
        etag,
        cursor: cached.cursor,
      };
    }

    const fresh = this.requireNetworkData(response);
    if (cached && this.options.merge) {
      const merged = this.options.merge(cached.data, fresh.data, cached.cursor);
      if (merged.kind === 'stale_cursor') {
        return await this.fullRefetch();
      }
      if (!this.options.validate(merged.data)) {
        throw new Error(`Garden cache ${this.options.key} produced an invalid delta merge`);
      }
      const cursor = merged.cursor === undefined
        ? this.options.cursor?.(merged.data) ?? null
        : merged.cursor;
      await this.write(merged.data, fresh.etag, cursor);
      return { data: merged.data, source: 'network', etag: fresh.etag, cursor };
    }

    const cursor = this.options.cursor?.(fresh.data) ?? null;
    await this.write(fresh.data, fresh.etag, cursor);
    return { data: fresh.data, source: 'network', etag: fresh.etag, cursor };
  }

  private async fullRefetch(): Promise<LocalFirstResult<T>> {
    const response = await this.options.fetch({ forceFull: true });
    if (response.kind !== 'data') {
      throw new Error(`Garden cache ${this.options.key} full refetch returned no body`);
    }
    const fresh = this.requireNetworkData(response);
    const cursor = this.options.cursor?.(fresh.data) ?? null;
    await this.write(fresh.data, fresh.etag, cursor);
    return { data: fresh.data, source: 'full_refetch', etag: fresh.etag, cursor };
  }

  private requireNetworkData(
    response: Extract<ConditionalFetchResponse, { kind: 'data' }>,
  ): { data: T; etag: string } {
    if (!nonEmptyString(response.etag)) {
      throw new Error(`Garden cache ${this.options.key} requires an ETag on refreshed data`);
    }
    if (!this.options.validate(response.data)) {
      throw new Error(`Garden cache ${this.options.key} rejected malformed server data`);
    }
    return { data: response.data, etag: response.etag };
  }

  private async write(data: T, etag: string, cursor: string | null): Promise<void> {
    await this.options.storage.write(this.options.key, {
      schemaVersion: GARDEN_CACHE_RECORD_SCHEMA_VERSION,
      savedAt: this.now(),
      etag,
      cursor,
      data,
    });
  }
}
