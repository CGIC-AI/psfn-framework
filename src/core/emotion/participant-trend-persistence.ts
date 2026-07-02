import {
  cloneParticipantTrend,
  type ParticipantEmotionTrend,
} from './participant-trends.js';
import type { VADVector } from './state.js';

// ── Persistence contract for per-participant room trends (bead E6.3) ──
//
// Trends must survive restart: an in-memory-only accumulator that dies on
// restart would let a room's orientation silently reset. This port follows the
// runtime-store pattern (see PostgresInternalStateStore) — a small keyed store
// upserted as trends move, loaded lazily per room on first touch.

export interface PersistedParticipantTrend {
  readonly roomKey: string;
  readonly participantKey: string;
  readonly vad: VADVector;
  readonly discrete: Record<string, number>;
  readonly interactionCount: number;
  /** ISO timestamp of the last update. */
  readonly updatedAt: string;
}

export interface ParticipantTrendStorePort {
  /** All persisted trends for one room (key: 'room:<channelId>'). */
  loadRoom(roomKey: string): Promise<PersistedParticipantTrend[]>;
  /** Upsert one participant's trend within a room. */
  saveTrend(record: PersistedParticipantTrend): Promise<void>;
  /** Delete specific participant trends (eviction). No-op on empty. */
  deleteTrends(roomKey: string, participantKeys: readonly string[]): Promise<void>;
}

function requireKey(value: string, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new Error(`Persisted participant trend ${field} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeVad(value: unknown, field: string): VADVector {
  if (!value || typeof value !== 'object') {
    throw new Error(`Persisted participant trend ${field} must be a VAD object`);
  }
  const record = value as Record<string, unknown>;
  const axis = (name: 'valence' | 'arousal' | 'dominance'): number => {
    const raw = record[name];
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Persisted participant trend ${field}.${name} must be a finite number`);
    }
    return Math.max(-1, Math.min(1, parsed));
  };
  return { valence: axis('valence'), arousal: axis('arousal'), dominance: axis('dominance') };
}

function normalizeDiscrete(value: unknown, field: string): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') {
    throw new Error(`Persisted participant trend ${field} must be an object`);
  }
  const out: Record<string, number> = {};
  for (const [rawLabel, rawScore] of Object.entries(value as Record<string, unknown>)) {
    const label = rawLabel.trim().toLowerCase();
    if (!label) continue;
    const score = typeof rawScore === 'number' ? rawScore : Number(rawScore);
    if (!Number.isFinite(score)) {
      throw new Error(`Persisted participant trend ${field}.${rawLabel} must be a finite number`);
    }
    out[label] = Math.max(0, Math.min(1, score));
  }
  return out;
}

export function normalizePersistedParticipantTrend(
  record: PersistedParticipantTrend,
): PersistedParticipantTrend {
  const roomKey = requireKey(record.roomKey, 'roomKey');
  const participantKey = requireKey(record.participantKey, 'participantKey');
  const updatedAtMs = Date.parse(typeof record.updatedAt === 'string' ? record.updatedAt : '');
  if (!Number.isFinite(updatedAtMs)) {
    throw new Error('Persisted participant trend updatedAt must be an ISO timestamp');
  }
  const interactionCount = Number(record.interactionCount);
  if (!Number.isInteger(interactionCount) || interactionCount < 0) {
    throw new Error('Persisted participant trend interactionCount must be a non-negative integer');
  }
  return {
    roomKey,
    participantKey,
    vad: normalizeVad(record.vad, 'vad'),
    discrete: normalizeDiscrete(record.discrete, 'discrete'),
    interactionCount,
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

/** In-memory runtime trend → persisted record. */
export function toPersistedParticipantTrend(
  roomKey: string,
  trend: ParticipantEmotionTrend,
): PersistedParticipantTrend {
  return normalizePersistedParticipantTrend({
    roomKey,
    participantKey: trend.participantKey,
    vad: { ...trend.vad },
    discrete: { ...trend.discrete },
    interactionCount: trend.interactionCount,
    updatedAt: new Date(trend.updatedAtMs).toISOString(),
  });
}

/** Persisted record → in-memory runtime trend. */
export function fromPersistedParticipantTrend(
  record: PersistedParticipantTrend,
): ParticipantEmotionTrend {
  const normalized = normalizePersistedParticipantTrend(record);
  return cloneParticipantTrend({
    participantKey: normalized.participantKey,
    vad: normalized.vad,
    discrete: normalized.discrete,
    interactionCount: normalized.interactionCount,
    updatedAtMs: Date.parse(normalized.updatedAt),
  });
}
