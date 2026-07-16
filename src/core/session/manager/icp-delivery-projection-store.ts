import type { SessionStore } from '../../../persistence/sessions/store.js';
import { isRecord } from '../../../shared/utils/types.js';
import { parseIcpDeliveryObservation } from '../icp-delivery-recovery.js';
import type { SessionEntry } from '../types.js';

type IcpDeliveryStatus = 'prepared' | 'delivered' | 'failed' | 'suppressed';
const DELIVERY_PROJECTION_PAGE_SIZE = 256;

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is malformed JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function pendingIcpSourceMessageId(entry: SessionEntry): string | null {
  if (entry.role !== 'assistant' || !entry.metadata) return null;
  const metadata = parseJsonObject(entry.metadata, 'Session metadata');
  if (metadata.icpDelivery === undefined) return null;
  if (!isRecord(metadata.icpDelivery)
    || metadata.icpDelivery.schemaVersion !== 1
    || metadata.icpDelivery.status !== 'pending') {
    throw new Error('ICP assistant delivery metadata must be schemaVersion 1 pending state');
  }
  if (!isRecord(metadata.turn)
    || typeof metadata.turn.sourceMessageId !== 'string'
    || !metadata.turn.sourceMessageId.trim()) {
    throw new Error('Pending ICP assistant entry requires turn.sourceMessageId');
  }
  return metadata.turn.sourceMessageId.trim();
}

function parseDeliveryObservation(entry: SessionEntry): {
  sourceMessageId: string;
  status: IcpDeliveryStatus;
} | null {
  if (entry.role !== 'system'
    || !entry.content.startsWith('{"schemaVersion":1,"kind":"icp_delivery"')) return null;
  let value: unknown;
  try {
    value = JSON.parse(entry.content);
  } catch {
    throw new Error('ICP delivery observation is malformed JSON');
  }
  if (!isRecord(value)
    || typeof value.sourceMessageId !== 'string'
    || !value.sourceMessageId.trim()) {
    throw new Error('ICP delivery observation is malformed');
  }
  const observation = parseIcpDeliveryObservation(entry.content, {
    channelId: entry.channelId,
    sourceMessageId: value.sourceMessageId.trim(),
  });
  return {
    sourceMessageId: observation.sourceMessageId,
    status: observation.status,
  };
}

function findDeliveryStatus(
  store: SessionStore,
  channelId: string,
  sourceMessageId: string,
): IcpDeliveryStatus | null {
  const entry = store.findLatestEntries(
    channelId,
    candidate => parseDeliveryObservation(candidate)?.sourceMessageId === sourceMessageId,
    1,
  ).at(0);
  return entry ? parseDeliveryObservation(entry)?.status ?? null : null;
}

function filterUndeliveredIcpAssistantEntries(
  entries: readonly SessionEntry[],
  resolveStatus: (sourceMessageId: string) => IcpDeliveryStatus | null,
): SessionEntry[] {
  return entries.filter((entry) => {
    const sourceMessageId = pendingIcpSourceMessageId(entry);
    if (sourceMessageId === null) return true;
    const status = resolveStatus(sourceMessageId);
    return status === 'delivered';
  });
}

function deliveryContiguousCompactionPrefix(
  store: SessionStore,
  channelId: string,
  proposedEntries: readonly SessionEntry[],
): SessionEntry[] {
  if (proposedEntries.length === 0) return [];
  const coveredUpTo = store.getCompactionSummaries(channelId).reduce(
    (maximum, summary) => Math.max(maximum, summary.coveredUpTo),
    0,
  );
  const proposedIds = new Set(proposedEntries.map(entry => entry.id));
  const proposedEndId = proposedEntries[proposedEntries.length - 1]!.id;
  let cursor = coveredUpTo + 1;

  while (cursor <= proposedEndId) {
    const pageEnd = Math.min(
      proposedEndId,
      cursor + DELIVERY_PROJECTION_PAGE_SIZE - 1,
    );
    const page = store.getEntriesInRange(channelId, cursor, pageEnd);
    for (const entry of page) {
      const sourceMessageId = pendingIcpSourceMessageId(entry);
      if (sourceMessageId !== null
        && (!proposedIds.has(entry.id)
          || findDeliveryStatus(store, channelId, sourceMessageId) !== 'delivered')) {
        return proposedEntries.filter(candidate => candidate.id < entry.id);
      }
    }
    cursor = pageEnd + 1;
  }

  return [...proposedEntries];
}

/**
 * Read projection that keeps pending/failed/suppressed sender output out of
 * every ordinary context, extraction, and compaction consumer. Raw journal
 * reads remain available for restart-safe delivery recovery.
 */
export function createIcpDeliveryProjectionStore(store: SessionStore): SessionStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getRecent') {
        return (channelId: string, limit: number): SessionEntry[] => {
          const normalizedLimit = Math.max(0, Math.floor(limit));
          if (normalizedLimit <= 0) return [];
          // Use the wrapped read surface rather than getLastEntry so composed
          // hot-tail views can contribute rows newer than the local journal.
          const lastEntry = target.getRecent(channelId, 1).at(-1);
          if (!lastEntry) return [];
          let cursor = lastEntry.id;
          let projected: SessionEntry[] = [];
          while (cursor > 0 && projected.length < normalizedLimit) {
            const pageStart = Math.max(1, cursor - DELIVERY_PROJECTION_PAGE_SIZE + 1);
            const page = filterUndeliveredIcpAssistantEntries(
              target.getEntriesInRange(channelId, pageStart, cursor),
              sourceMessageId => findDeliveryStatus(target, channelId, sourceMessageId),
            );
            projected = [...page, ...projected].slice(-normalizedLimit);
            cursor = pageStart - 1;
          }
          return projected;
        };
      }

      if (property === 'getEntriesInRange') {
        return (channelId: string, startId: number, endId: number): SessionEntry[] => (
          filterUndeliveredIcpAssistantEntries(
            target.getEntriesInRange(channelId, startId, endId),
            sourceMessageId => findDeliveryStatus(target, channelId, sourceMessageId),
          )
        );
      }

      if (property === 'getEntriesBefore') {
        return (channelId: string, beforeId: number, limit: number): SessionEntry[] => {
          if (!Number.isFinite(beforeId) || !Number.isFinite(limit)) return [];
          const normalizedBeforeId = Math.max(0, Math.floor(beforeId));
          const normalizedLimit = Math.max(0, Math.floor(limit));
          if (normalizedBeforeId <= 0 || normalizedLimit <= 0) return [];

          const statuses = new Map<string, IcpDeliveryStatus | null>();
          const resolveStatus = (sourceMessageId: string): IcpDeliveryStatus | null => {
            if (statuses.has(sourceMessageId)) return statuses.get(sourceMessageId) ?? null;
            const status = findDeliveryStatus(target, channelId, sourceMessageId);
            statuses.set(sourceMessageId, status);
            return status;
          };
          let cursor = normalizedBeforeId;
          let projected: SessionEntry[] = [];
          while (cursor > 0 && projected.length < normalizedLimit) {
            const page = target.getEntriesBefore(
              channelId,
              cursor,
              DELIVERY_PROJECTION_PAGE_SIZE,
            );
            if (page.length === 0) break;
            const earliestEntry = page[0]!;
            if (earliestEntry.id >= cursor) {
              throw new Error('SessionStore getEntriesBefore returned a non-decreasing page');
            }
            projected = [
              ...filterUndeliveredIcpAssistantEntries(page, resolveStatus),
              ...projected,
            ].slice(-normalizedLimit);
            cursor = earliestEntry.id;
            if (page.length < DELIVERY_PROJECTION_PAGE_SIZE) break;
          }
          return projected;
        };
      }

      if (property === 'getCompactionBoundarySafePrefix') {
        return (
          channelId: string,
          proposedEntries: readonly SessionEntry[],
        ): SessionEntry[] => deliveryContiguousCompactionPrefix(
          target,
          channelId,
          target.getCompactionBoundarySafePrefix(channelId, proposedEntries),
        );
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SessionStore;
}
