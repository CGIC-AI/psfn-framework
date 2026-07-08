import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresParticipantTrendStore } from './participant-trend-store.js';

const storeMocks = vi.hoisted(() => ({
  pool: { kind: 'pool' },
  createPostgresPool: vi.fn(() => storeMocks.pool),
  ensurePostgresSchema: vi.fn(async () => undefined),
  executeQuery: vi.fn(async () => undefined),
  queryRows: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: storeMocks.createPostgresPool,
  ensurePostgresSchema: storeMocks.ensurePostgresSchema,
  executeQuery: storeMocks.executeQuery,
  queryRows: storeMocks.queryRows,
}));

beforeEach(() => {
  storeMocks.createPostgresPool.mockClear();
  storeMocks.ensurePostgresSchema.mockClear();
  storeMocks.executeQuery.mockClear();
  storeMocks.queryRows.mockClear();
  storeMocks.queryRows.mockResolvedValue([]);
});

const NOW_ISO = new Date(1_700_000_000_000).toISOString();

describe('PostgresParticipantTrendStore (E6.3)', () => {
  it('initializes schema on connect', async () => {
    await PostgresParticipantTrendStore.connect('postgres://postgres:secret@localhost:5432/psfn');
    expect(storeMocks.ensurePostgresSchema).toHaveBeenCalledWith(
      storeMocks.pool,
      expect.arrayContaining([expect.stringContaining('participant_emotion_trends')]),
    );
  });

  it('upserts a trend by (room, participant)', async () => {
    const store = await PostgresParticipantTrendStore.connect('postgres://x@localhost:5432/psfn');
    await store.saveTrend({
      roomKey: 'room:R',
      participantKey: 'contactA',
      vad: { valence: -0.5, arousal: 0.3, dominance: 0.2 },
      discrete: { anger: 0.6 },
      interactionCount: 4,
      updatedAt: NOW_ISO,
    });
    const [, sql, params] = storeMocks.executeQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO participant_emotion_trends');
    expect(sql).toContain('ON CONFLICT (room_key, participant_key) DO UPDATE');
    expect(params).toEqual([
      'room:R',
      'contactA',
      JSON.stringify({ valence: -0.5, arousal: 0.3, dominance: 0.2 }),
      JSON.stringify({ anger: 0.6 }),
      4,
      NOW_ISO,
    ]);
  });

  it('loads and normalizes persisted room trends', async () => {
    storeMocks.queryRows.mockResolvedValue([
      {
        room_key: 'room:R',
        participant_key: 'contactA',
        vad: { valence: -0.5, arousal: 0.3, dominance: 0.2 },
        discrete: { anger: 0.6 },
        interaction_count: 4,
        updated_at: NOW_ISO,
      },
    ]);
    const store = await PostgresParticipantTrendStore.connect('postgres://x@localhost:5432/psfn');
    const rows = await store.loadRoom('room:R');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      roomKey: 'room:R',
      participantKey: 'contactA',
      vad: { valence: -0.5, arousal: 0.3, dominance: 0.2 },
      discrete: { anger: 0.6 },
      interactionCount: 4,
      updatedAt: NOW_ISO,
    });
  });

  it('deletes evicted participant trends and no-ops on empty input', async () => {
    const store = await PostgresParticipantTrendStore.connect('postgres://x@localhost:5432/psfn');
    await store.deleteTrends('room:R', []);
    expect(storeMocks.executeQuery).not.toHaveBeenCalled();
    await store.deleteTrends('room:R', ['contactA', 'contactB']);
    const [, sql, params] = storeMocks.executeQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM participant_emotion_trends');
    expect(params).toEqual(['room:R', ['contactA', 'contactB']]);
  });
});
