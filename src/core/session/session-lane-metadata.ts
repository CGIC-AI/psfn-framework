import { isRecord } from '../../shared/utils/types.js';
import type { SessionEntry } from './types.js';

export const TEMPORAL_WAKEUP_MORNING_NOTE_SOURCE = 'temporal_wakeup_morning';
export const TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE = 'temporal_wakeup_refresher';

export interface SessionLaneMetadata {
  schemaVersion: number;
  kind: string;
  source?: string;
}

export function parseSessionLaneMetadata(
  entry: Pick<SessionEntry, 'metadata'>,
): SessionLaneMetadata | null {
  if (!entry.metadata) return null;

  let metadata: unknown;
  try {
    metadata = JSON.parse(entry.metadata);
  } catch {
    return null;
  }
  if (!isRecord(metadata) || !isRecord(metadata.sessionLane)) return null;

  const lane = metadata.sessionLane;
  if (typeof lane.schemaVersion !== 'number' || typeof lane.kind !== 'string') return null;
  if (lane.source !== undefined && typeof lane.source !== 'string') return null;

  return {
    schemaVersion: lane.schemaVersion,
    kind: lane.kind,
    ...(lane.source !== undefined ? { source: lane.source } : {}),
  };
}

function isTemporalWakeupRefresherNote(entry: SessionEntry): boolean {
  if (entry.role !== 'system') return false;
  const lane = parseSessionLaneMetadata(entry);
  if (!lane) return false;
  return lane.schemaVersion === 1
    && lane.kind === 'system_note'
    && lane.source === TEMPORAL_WAKEUP_REFRESHER_NOTE_SOURCE;
}

export function filterSupersededTemporalWakeupRefreshers(
  entries: readonly SessionEntry[],
): SessionEntry[] {
  const latestByChannel = new Map<string, SessionEntry>();
  const superseded = new Set<SessionEntry>();

  for (const entry of entries) {
    if (!isTemporalWakeupRefresherNote(entry)) continue;

    const latest = latestByChannel.get(entry.channelId);
    if (!latest) {
      latestByChannel.set(entry.channelId, entry);
      continue;
    }

    // Journal IDs are allocated in append order. Wall-clock timestamps can
    // move backward after a clock correction and cannot define "latest fired."
    const entryIsLater = entry.id > latest.id
      || (entry.id === latest.id && entry.timestamp > latest.timestamp);
    if (entryIsLater) {
      superseded.add(latest);
      latestByChannel.set(entry.channelId, entry);
    } else {
      superseded.add(entry);
    }
  }

  return entries.filter(entry => !superseded.has(entry));
}
