import { cloneInternalState, type InternalState } from './state.js';
import { cloneMetacognitiveFlags, type MetacognitiveFlag } from './metacognition.js';

/**
 * Snapshots older than this are not rehydrated at startup: stale emotional and
 * attention state from before a long outage must not silently masquerade as
 * her current running state. Instead the gap itself is surfaced.
 */
export const INTERNAL_STATE_REHYDRATION_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface PersistedInternalStateRecord {
  state: InternalState;
  snapshotRef: string;
  metacognitiveFlags: MetacognitiveFlag[];
  /** ISO timestamp of when this state was last current. */
  savedAt: string;
}

export interface InternalStateStorePort {
  save(record: PersistedInternalStateRecord): Promise<void>;
  loadLatest(): Promise<PersistedInternalStateRecord | null>;
}

/**
 * Describes a restart where persisted internal state existed but was too old
 * to restore. Rendered to the companion so she knows continuity was broken —
 * a multi-day gap usually means a technical failure happened around her, not
 * an ordinary quiet stretch.
 */
export interface InternalStateContinuityGap {
  /** ISO timestamp of the last persisted internal state before the gap. */
  offlineSince: string;
  gapMs: number;
}

export interface InternalStateRehydrationAgent {
  restorePersistedInternalState(record: PersistedInternalStateRecord): void;
  noteInternalStateContinuityGap(gap: InternalStateContinuityGap): void;
}

export type InternalStateRehydrationResult =
  | { outcome: 'restored'; savedAt: string; ageMs: number }
  | { outcome: 'gap_detected'; gap: InternalStateContinuityGap }
  | { outcome: 'no_snapshot' };

export function normalizePersistedInternalStateRecord(
  record: PersistedInternalStateRecord,
): PersistedInternalStateRecord {
  const snapshotRef = typeof record.snapshotRef === 'string' ? record.snapshotRef.trim() : '';
  if (!snapshotRef) {
    throw new Error('Persisted internal state snapshotRef must be a non-empty string');
  }
  const savedAtMs = Date.parse(typeof record.savedAt === 'string' ? record.savedAt : '');
  if (!Number.isFinite(savedAtMs)) {
    throw new Error('Persisted internal state savedAt must be an ISO timestamp');
  }
  return {
    state: cloneInternalState(record.state),
    snapshotRef,
    metacognitiveFlags: cloneMetacognitiveFlags(record.metacognitiveFlags),
    savedAt: new Date(savedAtMs).toISOString(),
  };
}

/**
 * Loads the persisted internal state and either restores it (fresh enough) or
 * reports the continuity gap to the agent (stale). Corrupt persisted state
 * fails closed: the error propagates instead of starting with invented state.
 */
export async function rehydratePersistedInternalState(options: {
  store: InternalStateStorePort;
  agent: InternalStateRehydrationAgent;
  now?: Date;
  rehydrationWindowMs?: number;
}): Promise<InternalStateRehydrationResult> {
  const record = await options.store.loadLatest();
  if (!record) {
    return { outcome: 'no_snapshot' };
  }

  const normalized = normalizePersistedInternalStateRecord(record);
  const nowMs = (options.now ?? new Date()).getTime();
  const ageMs = Math.max(0, nowMs - Date.parse(normalized.savedAt));
  const windowMs = options.rehydrationWindowMs ?? INTERNAL_STATE_REHYDRATION_WINDOW_MS;

  if (ageMs <= windowMs) {
    options.agent.restorePersistedInternalState(normalized);
    return { outcome: 'restored', savedAt: normalized.savedAt, ageMs };
  }

  const gap: InternalStateContinuityGap = {
    offlineSince: normalized.savedAt,
    gapMs: ageMs,
  };
  options.agent.noteInternalStateContinuityGap(gap);
  return { outcome: 'gap_detected', gap };
}
