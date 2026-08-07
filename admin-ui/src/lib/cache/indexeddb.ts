import { isRecord } from '../../../../src/shared/utils/types.js';
import {
  getCompanionCacheScope,
  onCompanionScopeChange,
} from '$lib/fleet/companion-scope';

const GARDEN_CACHE_DATABASE = 'psfn-garden-local-cache';
const GARDEN_CACHE_DATABASE_VERSION = 1;
const GARDEN_CACHE_OBJECT_STORE = 'resources';

export interface GardenCacheStorage {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  removePrefix?(prefix: string): Promise<void>;
}

function companionCachePrefix(companionScope: string): string {
  return `companion:${companionScope}:`;
}

export function companionCacheKey(
  key: string,
  companionScope = getCompanionCacheScope(),
): string {
  return `${companionCachePrefix(companionScope)}${key}`;
}

function requestResult(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error('IndexedDB transaction failed'),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error('IndexedDB transaction aborted'),
    );
  });
}

/**
 * Origin-scoped Garden cache. The browser origin is the companion deployment
 * boundary; credentials and mutation intents are never written here.
 */
class IndexedDbGardenCacheStorage implements GardenCacheStorage {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory?: IDBFactory) {}

  async read(key: string): Promise<unknown> {
    const database = await this.open();
    const transaction = database.transaction(GARDEN_CACHE_OBJECT_STORE, 'readonly');
    const completed = transactionCompletion(transaction);
    const [raw] = await Promise.all([
      requestResult(transaction.objectStore(GARDEN_CACHE_OBJECT_STORE).get(key)),
      completed,
    ]);
    if (raw === undefined) return undefined;
    if (!isRecord(raw) || raw.key !== key || !Object.hasOwn(raw, 'value')) {
      await this.remove(key);
      return undefined;
    }
    return raw.value;
  }

  async write(key: string, value: unknown): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(GARDEN_CACHE_OBJECT_STORE, 'readwrite');
    transaction.objectStore(GARDEN_CACHE_OBJECT_STORE).put({ key, value });
    await transactionCompletion(transaction);
  }

  async remove(key: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(GARDEN_CACHE_OBJECT_STORE, 'readwrite');
    transaction.objectStore(GARDEN_CACHE_OBJECT_STORE).delete(key);
    await transactionCompletion(transaction);
  }

  async removePrefix(prefix: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(GARDEN_CACHE_OBJECT_STORE, 'readwrite');
    const objectStore = transaction.objectStore(GARDEN_CACHE_OBJECT_STORE);
    const cursorCompleted = new Promise<void>((resolve, reject) => {
      const request = objectStore.openCursor();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          cursor.delete();
        }
        cursor.continue();
      };
    });
    await Promise.all([cursorCompleted, transactionCompletion(transaction)]);
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const factory = this.resolveFactory();
    this.databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(GARDEN_CACHE_DATABASE, GARDEN_CACHE_DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(GARDEN_CACHE_OBJECT_STORE)) {
          database.createObjectStore(GARDEN_CACHE_OBJECT_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error ?? new Error('Unable to open the IndexedDB Garden cache'),
      );
      request.onblocked = () => reject(new Error('IndexedDB Garden cache upgrade was blocked'));
    });
    return this.databasePromise;
  }

  private resolveFactory(): IDBFactory {
    if (this.factory) return this.factory;
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is required for the Garden local-first cache');
    }
    return indexedDB;
  }
}

let browserStorage: GardenCacheStorage | null = null;

export function getGardenCacheStorage(): GardenCacheStorage {
  if (!browserStorage) browserStorage = new IndexedDbGardenCacheStorage();
  return browserStorage;
}

onCompanionScopeChange((previousCompanionId) => {
  if (!previousCompanionId || !browserStorage?.removePrefix) return;
  return browserStorage.removePrefix(companionCachePrefix(previousCompanionId));
});
