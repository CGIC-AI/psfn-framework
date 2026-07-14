import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';

/**
 * Read-side view over a fetched session tail window (psfn-framework-hgw3.5).
 *
 * Wraps a SessionStore for ONE capture so `getRecent`/`getEntriesInRange`
 * gap-fill from the shared Redis tail. Merge rule (hardened): the JOURNAL is
 * the authenticated source of truth, so for every id the journal read
 * returned, the journal row wins outright — Redis rows bypass the journal
 * HMAC chain and must never override them. Tail entries are only accepted
 * for ids NEWER than the journal window's max id: the cross-process
 * freshness gap-fill (entries another process appended that a stale
 * in-memory view might miss). Every other method and every other channel
 * passes straight through.
 *
 * The tail entries must already be validated
 * (SessionStore.fetchSessionTailWindow): ascending by id, no duplicates, id
 * contiguity checked, epoch-fenced, and not behind the just-recorded entry
 * id.
 */
export function createSessionTailReadStore(
  store: SessionStore,
  tailChannelId: string,
  tailEntries: readonly SessionEntry[],
): SessionStore {
  /**
   * Append tail entries strictly NEWER than the journal window's max id.
   * Both inputs are ascending by id, so the concatenation stays sorted.
   */
  const gapFillFromTail = (
    journalEntries: readonly SessionEntry[],
    tailSlice: readonly SessionEntry[],
  ): SessionEntry[] => {
    const journalMaxId = journalEntries.length > 0
      ? journalEntries[journalEntries.length - 1].id
      : -1;
    const newer = tailSlice.filter(entry => entry.id > journalMaxId);
    if (newer.length === 0) return [...journalEntries];
    return [...journalEntries, ...newer];
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
          const merged = gapFillFromTail(target.getRecent(channelId, normalizedLimit), tailEntries);
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
          return gapFillFromTail(base, tailInRange);
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
