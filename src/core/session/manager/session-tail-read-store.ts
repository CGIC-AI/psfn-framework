import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';

/**
 * Read-side view over a fetched session tail window (psfn-framework-hgw3.5).
 *
 * Wraps a SessionStore for ONE capture so `getRecent`/`getEntriesInRange`
 * consult the shared Redis tail first:
 * - a window that fits inside the tail is served from the tail alone;
 * - a wider window merges journal-backed entries with the tail BY ENTRY ID,
 *   with the tail (Redis) copy winning on overlap — never interleaving
 *   duplicates;
 * - every other method and every other channel passes straight through.
 *
 * The tail entries must already be validated/normalized
 * (SessionStore.fetchSessionTailWindow): ascending by id, no duplicates, and
 * not behind the just-recorded entry id.
 */
export function createSessionTailReadStore(
  store: SessionStore,
  tailChannelId: string,
  tailEntries: readonly SessionEntry[],
): SessionStore {
  const mergeWithTail = (base: readonly SessionEntry[], tailSlice: readonly SessionEntry[]): SessionEntry[] => {
    const byId = new Map<number, SessionEntry>();
    for (const entry of base) {
      byId.set(entry.id, entry);
    }
    for (const entry of tailSlice) {
      byId.set(entry.id, entry);
    }
    return [...byId.values()].sort((left, right) => left.id - right.id);
  };

  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getRecent') {
        return (channelId: string, limit: number): SessionEntry[] => {
          if (channelId !== tailChannelId) {
            return target.getRecent(channelId, limit);
          }
          const normalizedLimit = Math.max(0, Math.floor(limit));
          if (normalizedLimit <= 0) return [];
          if (tailEntries.length >= normalizedLimit) {
            return tailEntries.slice(-normalizedLimit);
          }
          const merged = mergeWithTail(target.getRecent(channelId, normalizedLimit), tailEntries);
          if (merged.length <= normalizedLimit) return merged;
          return merged.slice(-normalizedLimit);
        };
      }

      if (property === 'getEntriesInRange') {
        return (channelId: string, startId: number, endId: number): SessionEntry[] => {
          const base = target.getEntriesInRange(channelId, startId, endId);
          if (channelId !== tailChannelId) {
            return base;
          }
          if (!Number.isFinite(startId) || !Number.isFinite(endId)) return base;
          const normalizedStart = Math.max(0, Math.floor(Math.min(startId, endId)));
          const normalizedEnd = Math.max(0, Math.floor(Math.max(startId, endId)));
          const tailInRange = tailEntries.filter(
            entry => entry.id >= normalizedStart && entry.id <= normalizedEnd,
          );
          if (tailInRange.length === 0) return base;
          return mergeWithTail(base, tailInRange);
        };
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  }) as SessionStore;
}
