import type { SessionStore } from '../../../persistence/sessions/store.js';
import {
  markCompactionSummaryAsUntrustedRecord,
  wrapCompactionSummaryAsUntrustedContext,
} from '../../identity/prompt-composer.js';
import type { SessionEntry } from '../types.js';

const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';

export function shouldPersistSessionChannel(channelId: string): boolean {
  return !channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX);
}

export function createCompactionBoundaryStore(store: SessionStore): SessionStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getRecent') {
        return (channelId: string, limit: number): SessionEntry[] => {
          const normalizedLimit = Math.max(0, Math.floor(limit));
          if (normalizedLimit <= 0) return [];
          const compactions = target.getCompactionSummaries(channelId);
          const coveredUpTo = compactions.reduce(
            (maxCoveredUpTo, summary) => Math.max(maxCoveredUpTo, summary.coveredUpTo),
            0,
          );
          if (coveredUpTo <= 0) {
            return target.getRecent(channelId, normalizedLimit);
          }
          const entries = target.getEntriesInRange(
            channelId,
            coveredUpTo + 1,
            Number.MAX_SAFE_INTEGER,
          );
          if (entries.length <= normalizedLimit) {
            return entries;
          }
          return entries.slice(-normalizedLimit);
        };
      }

      if (property === 'insertCompaction') {
        return (channelId: string, summary: string, coveredUpTo: number): void => {
          target.insertCompaction(
            channelId,
            markCompactionSummaryAsUntrustedRecord(summary),
            coveredUpTo,
          );
        };
      }

      if (property === 'getCompactionSummaries') {
        return (channelId: string) => (
          target.getCompactionSummaries(channelId).map(summary => ({
            ...summary,
            summary: wrapCompactionSummaryAsUntrustedContext(summary.summary),
          }))
        );
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  }) as SessionStore;
}
