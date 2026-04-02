import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresReflectionMetacognitionMirrorStore } from './postgres-mirror.js';

const postgresMirrorMocks = vi.hoisted(() => ({
  pool: { kind: 'pool' },
  createPostgresPool: vi.fn(() => postgresMirrorMocks.pool),
  ensurePostgresSchema: vi.fn(async () => undefined),
  executeQuery: vi.fn(async () => undefined),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: postgresMirrorMocks.createPostgresPool,
  ensurePostgresSchema: postgresMirrorMocks.ensurePostgresSchema,
  executeQuery: postgresMirrorMocks.executeQuery,
}));

beforeEach(() => {
  postgresMirrorMocks.createPostgresPool.mockClear();
  postgresMirrorMocks.ensurePostgresSchema.mockClear();
  postgresMirrorMocks.executeQuery.mockClear();
});

describe('PostgresReflectionMetacognitionMirrorStore', () => {
  it('initializes schema and mirrors reflection entries into postgres', async () => {
    const store = await PostgresReflectionMetacognitionMirrorStore.connect(
      'postgres://postgres:secret@localhost:5432/psfn',
    );

    await store.mirrorEntry({
      id: 'reflection-meta-1',
      kind: 'reflection_run',
      occurredAt: '2026-04-02T12:00:00.000Z',
      templateId: 'musing',
      templateName: 'Musing',
      executionSource: 'manual',
      initiatorSurface: 'tool:heartbeat_run_template',
      initiatedBy: 'companion',
      reason: 'Manual reflection run via heartbeat_run_template',
      channelId: 'internal:reflection:musing',
      sendToDiscordEffective: false,
      mode: 'agent',
      internalStateSnapshotRef: 'snapshot-1',
      metacognitiveFlags: [{ flag: 'steadiness', confidence: 0.7 }],
      reflectionJournalEntryId: 'reflection-1',
      prompt: 'Reflect briefly.',
      reflection: 'I noticed steady attention.',
    });

    expect(postgresMirrorMocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://postgres:secret@localhost:5432/psfn',
      expect.objectContaining({ applicationName: 'psfn-reflections' }),
    );
    expect(postgresMirrorMocks.ensurePostgresSchema).toHaveBeenCalledTimes(1);
    expect(postgresMirrorMocks.executeQuery).toHaveBeenCalledTimes(1);
    expect(postgresMirrorMocks.executeQuery.mock.calls[0]?.[1]).toContain('INSERT INTO reflections');
    expect(postgresMirrorMocks.executeQuery.mock.calls[0]?.[2]?.[0]).toBe('reflection-meta-1');
  });
});
