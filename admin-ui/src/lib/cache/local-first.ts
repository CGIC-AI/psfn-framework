import { isRecord } from '../../../../src/shared/utils/types.js';
import { companionCacheKey, type GardenCacheStorage } from './indexeddb';
import { getCompanionCacheScope } from '$lib/fleet/companion-scope';

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
  /** Fail-closed boundary normalization before validation and persistence. */
  normalize?(value: unknown): unknown;
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
    const companionScope = getCompanionCacheScope();
    return this.readForScope(companionScope);
  }

  private async readForScope(companionScope: string): Promise<CachedResourceSnapshot<T> | null> {
    const key = companionCacheKey(this.options.key, companionScope);
    const raw = await this.options.storage.read(key);
    this.assertScope(companionScope);
    if (raw === undefined) return null;
    if (!isRecord(raw)
      || raw.schemaVersion !== GARDEN_CACHE_RECORD_SCHEMA_VERSION
      || !nonEmptyString(raw.etag)
      || typeof raw.savedAt !== 'number'
      || !Number.isFinite(raw.savedAt)
      || !(raw.cursor === null || typeof raw.cursor === 'string')) {
      await this.options.storage.remove(key);
      this.assertScope(companionScope);
      return null;
    }
    const normalizedData = this.normalize(raw.data);
    if (!this.options.validate(normalizedData)) {
      await this.options.storage.remove(key);
      this.assertScope(companionScope);
      return null;
    }
    if (normalizedData !== raw.data) {
      await this.write(companionScope, normalizedData, raw.etag, raw.cursor);
    }
    return {
      data: normalizedData,
      etag: raw.etag,
      cursor: raw.cursor,
      savedAt: raw.savedAt,
    };
  }

  async remove(): Promise<void> {
    const companionScope = getCompanionCacheScope();
    await this.options.storage.remove(companionCacheKey(this.options.key, companionScope));
    this.assertScope(companionScope);
  }

  async load(onData: (data: T, source: LocalFirstDataSource) => void): Promise<LocalFirstResult<T>> {
    const companionScope = getCompanionCacheScope();
    const cached = await this.readForScope(companionScope);
    this.assertScope(companionScope);
    if (cached) onData(cached.data, 'cache');
    const result = await this.revalidateForScope(companionScope, cached);
    this.assertScope(companionScope);
    onData(result.data, result.source);
    return result;
  }

  async revalidate(
    knownCached?: CachedResourceSnapshot<T> | null,
  ): Promise<LocalFirstResult<T>> {
    const companionScope = getCompanionCacheScope();
    return this.revalidateForScope(companionScope, knownCached);
  }

  private async revalidateForScope(
    companionScope: string,
    knownCached?: CachedResourceSnapshot<T> | null,
  ): Promise<LocalFirstResult<T>> {
    const cached = knownCached === undefined
      ? await this.readForScope(companionScope)
      : knownCached;
    this.assertScope(companionScope);
    const request: ConditionalFetchRequest = cached
      ? {
          etag: cached.etag,
          ...(cached.cursor !== null ? { cursor: cached.cursor } : {}),
          forceFull: false,
        }
      : { forceFull: false };
    const response = await this.options.fetch(request);
    this.assertScope(companionScope);
    if (response.kind === 'not_modified') {
      if (!cached) {
        throw new Error(`Garden cache ${this.options.key} received 304 without a cached body`);
      }
      const etag = response.etag === undefined ? cached.etag : response.etag;
      if (!nonEmptyString(etag)) {
        throw new Error(`Garden cache ${this.options.key} received an invalid ETag`);
      }
      if (etag !== cached.etag) {
        await this.write(companionScope, cached.data, etag, cached.cursor);
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
        return await this.fullRefetch(companionScope);
      }
      const normalizedMerged = this.normalize(merged.data);
      if (!this.options.validate(normalizedMerged)) {
        throw new Error(`Garden cache ${this.options.key} produced an invalid delta merge`);
      }
      const cursor = merged.cursor === undefined
        ? this.options.cursor?.(normalizedMerged) ?? null
        : merged.cursor;
      await this.write(companionScope, normalizedMerged, fresh.etag, cursor);
      return { data: normalizedMerged, source: 'network', etag: fresh.etag, cursor };
    }

    const cursor = this.options.cursor?.(fresh.data) ?? null;
    await this.write(companionScope, fresh.data, fresh.etag, cursor);
    return { data: fresh.data, source: 'network', etag: fresh.etag, cursor };
  }

  private async fullRefetch(companionScope: string): Promise<LocalFirstResult<T>> {
    const response = await this.options.fetch({ forceFull: true });
    this.assertScope(companionScope);
    if (response.kind !== 'data') {
      throw new Error(`Garden cache ${this.options.key} full refetch returned no body`);
    }
    const fresh = this.requireNetworkData(response);
    const cursor = this.options.cursor?.(fresh.data) ?? null;
    await this.write(companionScope, fresh.data, fresh.etag, cursor);
    return { data: fresh.data, source: 'full_refetch', etag: fresh.etag, cursor };
  }

  private requireNetworkData(
    response: Extract<ConditionalFetchResponse, { kind: 'data' }>,
  ): { data: T; etag: string } {
    if (!nonEmptyString(response.etag)) {
      throw new Error(`Garden cache ${this.options.key} requires an ETag on refreshed data`);
    }
    const normalizedData = this.normalize(response.data);
    if (!this.options.validate(normalizedData)) {
      throw new Error(`Garden cache ${this.options.key} rejected malformed server data`);
    }
    return { data: normalizedData, etag: response.etag };
  }

  private normalize(value: unknown): unknown {
    return this.options.normalize?.(value) ?? value;
  }

  private async write(
    companionScope: string,
    data: T,
    etag: string,
    cursor: string | null,
  ): Promise<void> {
    this.assertScope(companionScope);
    await this.options.storage.write(companionCacheKey(this.options.key, companionScope), {
      schemaVersion: GARDEN_CACHE_RECORD_SCHEMA_VERSION,
      savedAt: this.now(),
      etag,
      cursor,
      data,
    });
    this.assertScope(companionScope);
  }

  private assertScope(expected: string): void {
    if (getCompanionCacheScope() !== expected) {
      throw new DOMException('Companion scope changed', 'AbortError');
    }
  }
}
