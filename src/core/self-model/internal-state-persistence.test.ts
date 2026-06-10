import { describe, expect, it, vi } from 'vitest';
import {
  INTERNAL_STATE_REHYDRATION_WINDOW_MS,
  normalizePersistedInternalStateRecord,
  rehydratePersistedInternalState,
  type InternalStateStorePort,
  type PersistedInternalStateRecord,
} from './internal-state-persistence.js';
import { buildInternalStateSnapshotRef, type InternalState } from './state.js';

function buildInternalState(): InternalState {
  return {
    emotional: {
      vad: { valence: 0.4, arousal: 0.1, dominance: 0 },
      mood: { valence: 0.3, arousal: 0, dominance: 0.1 },
      discreteEmotions: { joy: 0.6 },
      confidence: 0.8,
    },
    cognitive: {
      certaintyLevel: 0.7,
      topicEngagement: 0.5,
      processingQuality: 'fluent',
    },
    attention: {
      activeConcerns: [],
      pendingFollowUps: [],
      careReminders: [],
      salientEntities: ['garden'],
      conversationTrajectory: 'casual',
    },
    relational: {
      contactId: 'contact-1',
      trustLevel: 'primary',
      baselineValence: 0.2,
      moodDrift: 0,
      recentInteractionFrequency: 0.5,
      lastSeenDeltaSeconds: 120,
    },
  };
}

function buildRecord(savedAt: string): PersistedInternalStateRecord {
  const state = buildInternalState();
  return {
    state,
    snapshotRef: buildInternalStateSnapshotRef(state),
    metacognitiveFlags: [
      { flag: 'high_engagement', confidence: 0.7, evidence: 'long exchange' },
    ],
    savedAt,
  };
}

function buildStore(record: PersistedInternalStateRecord | null): InternalStateStorePort {
  return {
    save: vi.fn(async () => {}),
    loadLatest: vi.fn(async () => record),
  };
}

describe('rehydratePersistedInternalState', () => {
  it('restores a snapshot inside the freshness window', async () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const record = buildRecord('2026-06-10T08:00:00Z');
    const restore = vi.fn();
    const noteGap = vi.fn();

    const result = await rehydratePersistedInternalState({
      store: buildStore(record),
      agent: { restorePersistedInternalState: restore, noteInternalStateContinuityGap: noteGap },
      now,
    });

    expect(result.outcome).toBe('restored');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0][0].snapshotRef).toBe(record.snapshotRef);
    expect(noteGap).not.toHaveBeenCalled();
  });

  it('reports a continuity gap instead of restoring stale state', async () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const record = buildRecord('2026-06-07T12:00:00Z');
    const restore = vi.fn();
    const noteGap = vi.fn();

    const result = await rehydratePersistedInternalState({
      store: buildStore(record),
      agent: { restorePersistedInternalState: restore, noteInternalStateContinuityGap: noteGap },
      now,
    });

    expect(result.outcome).toBe('gap_detected');
    expect(restore).not.toHaveBeenCalled();
    expect(noteGap).toHaveBeenCalledWith({
      offlineSince: '2026-06-07T12:00:00.000Z',
      gapMs: 3 * 24 * 60 * 60 * 1000,
    });
  });

  it('treats a snapshot exactly at the window edge as fresh', async () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const savedAt = new Date(now.getTime() - INTERNAL_STATE_REHYDRATION_WINDOW_MS).toISOString();
    const restore = vi.fn();

    const result = await rehydratePersistedInternalState({
      store: buildStore(buildRecord(savedAt)),
      agent: { restorePersistedInternalState: restore, noteInternalStateContinuityGap: vi.fn() },
      now,
    });

    expect(result.outcome).toBe('restored');
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no snapshot exists', async () => {
    const restore = vi.fn();
    const noteGap = vi.fn();

    const result = await rehydratePersistedInternalState({
      store: buildStore(null),
      agent: { restorePersistedInternalState: restore, noteInternalStateContinuityGap: noteGap },
    });

    expect(result.outcome).toBe('no_snapshot');
    expect(restore).not.toHaveBeenCalled();
    expect(noteGap).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt persisted state', async () => {
    const record = buildRecord('2026-06-10T08:00:00Z');
    const corrupt = {
      ...record,
      state: { ...record.state, emotional: { ...record.state.emotional, confidence: 99 } },
    } as PersistedInternalStateRecord;

    await expect(rehydratePersistedInternalState({
      store: buildStore(corrupt),
      agent: { restorePersistedInternalState: vi.fn(), noteInternalStateContinuityGap: vi.fn() },
      now: new Date('2026-06-10T12:00:00Z'),
    })).rejects.toThrow(/confidence/);
  });
});

describe('normalizePersistedInternalStateRecord', () => {
  it('round-trips a valid record', () => {
    const record = buildRecord('2026-06-10T08:00:00.000Z');
    const normalized = normalizePersistedInternalStateRecord(record);
    expect(normalized.savedAt).toBe('2026-06-10T08:00:00.000Z');
    expect(normalized.snapshotRef).toBe(record.snapshotRef);
    expect(normalized.metacognitiveFlags).toHaveLength(1);
    expect(normalized.state.relational.contactId).toBe('contact-1');
  });

  it('rejects an empty snapshot ref', () => {
    const record = { ...buildRecord('2026-06-10T08:00:00Z'), snapshotRef: '  ' };
    expect(() => normalizePersistedInternalStateRecord(record)).toThrow(/snapshotRef/);
  });

  it('rejects a non-ISO savedAt', () => {
    const record = { ...buildRecord('2026-06-10T08:00:00Z'), savedAt: 'yesterday-ish' };
    expect(() => normalizePersistedInternalStateRecord(record)).toThrow(/savedAt/);
  });

  it('rejects malformed metacognitive flags', () => {
    const record = buildRecord('2026-06-10T08:00:00Z');
    const corrupt = {
      ...record,
      metacognitiveFlags: [{ flag: 'not_a_real_flag', confidence: 0.5, evidence: 'x' }],
    } as unknown as PersistedInternalStateRecord;
    expect(() => normalizePersistedInternalStateRecord(corrupt)).toThrow();
  });
});
