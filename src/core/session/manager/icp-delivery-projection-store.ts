import type { SessionStore } from '../../../persistence/sessions/store.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { SessionEntry } from '../types.js';

type IcpDeliveryStatus = 'delivered' | 'failed' | 'suppressed';

interface DeliveryStatusIndex {
  lastEntryId: number;
  statuses: Map<string, IcpDeliveryStatus>;
}

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
  if (entry.role !== 'system' || !entry.content.startsWith('{')) return null;
  let value: Record<string, unknown>;
  try {
    value = parseJsonObject(entry.content, 'ICP delivery observation');
  } catch {
    return null;
  }
  if (value.kind !== 'icp_delivery') return null;
  if (value.schemaVersion !== 1
    || typeof value.sourceMessageId !== 'string'
    || !value.sourceMessageId.trim()
    || (value.status !== 'delivered'
      && value.status !== 'failed'
      && value.status !== 'suppressed')) {
    throw new Error('ICP delivery observation is malformed');
  }
  return {
    sourceMessageId: value.sourceMessageId.trim(),
    status: value.status,
  };
}

function refreshDeliveryStatusIndex(
  store: SessionStore,
  channelId: string,
  indexes: Map<string, DeliveryStatusIndex>,
): ReadonlyMap<string, IcpDeliveryStatus> {
  const latestEntry = store.getRecent(channelId, 1).at(-1);
  const latestEntryId = latestEntry?.id ?? 0;
  let index = indexes.get(channelId);

  if (!index || latestEntryId < index.lastEntryId) {
    index = {
      lastEntryId: 0,
      statuses: new Map<string, IcpDeliveryStatus>(),
    };
    indexes.set(channelId, index);
  }

  if (latestEntryId > index.lastEntryId) {
    const appendedEntries = store.getEntriesInRange(
      channelId,
      index.lastEntryId + 1,
      latestEntryId,
    );
    for (const entry of appendedEntries) {
      const observation = parseDeliveryObservation(entry);
      if (observation) {
        index.statuses.set(observation.sourceMessageId, observation.status);
      }
    }
    index.lastEntryId = latestEntryId;
  }

  return index.statuses;
}

function filterUndeliveredIcpAssistantEntries(
  entries: readonly SessionEntry[],
  statuses: ReadonlyMap<string, IcpDeliveryStatus>,
): SessionEntry[] {
  return entries.filter((entry) => {
    const sourceMessageId = pendingIcpSourceMessageId(entry);
    return sourceMessageId === null || statuses.get(sourceMessageId) === 'delivered';
  });
}

/**
 * Read projection that keeps pending/failed/suppressed sender output out of
 * every ordinary context, extraction, and compaction consumer. Raw journal
 * reads remain available for restart-safe delivery recovery.
 */
export function createIcpDeliveryProjectionStore(store: SessionStore): SessionStore {
  const deliveryIndexes = new Map<string, DeliveryStatusIndex>();
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getRecent') {
        return (channelId: string, limit: number): SessionEntry[] => {
          const normalizedLimit = Math.max(0, Math.floor(limit));
          if (normalizedLimit <= 0) return [];
          const statuses = refreshDeliveryStatusIndex(target, channelId, deliveryIndexes);
          let fetchLimit = normalizedLimit;
          for (;;) {
            const raw = target.getRecent(channelId, fetchLimit);
            const projected = filterUndeliveredIcpAssistantEntries(raw, statuses);
            if (raw.length < fetchLimit || projected.length >= normalizedLimit) {
              return projected.slice(-normalizedLimit);
            }
            fetchLimit = Math.max(fetchLimit + 1, fetchLimit * 2);
          }
        };
      }

      if (property === 'getEntriesInRange') {
        return (channelId: string, startId: number, endId: number): SessionEntry[] => {
          const statuses = refreshDeliveryStatusIndex(target, channelId, deliveryIndexes);
          return filterUndeliveredIcpAssistantEntries(
            target.getEntriesInRange(channelId, startId, endId),
            statuses,
          );
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SessionStore;
}
