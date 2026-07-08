import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresScheduledPromptStore } from './scheduled-prompt-store.js';

const storeMocks = vi.hoisted(() => ({
  pool: { kind: 'pool' },
  createPostgresPool: vi.fn(() => storeMocks.pool),
  ensurePostgresSchema: vi.fn(async () => undefined),
  queryOne: vi.fn(async () => undefined as unknown),
  queryRows: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: storeMocks.createPostgresPool,
  ensurePostgresSchema: storeMocks.ensurePostgresSchema,
  queryOne: storeMocks.queryOne,
  queryRows: storeMocks.queryRows,
}));

beforeEach(() => {
  storeMocks.createPostgresPool.mockClear();
  storeMocks.ensurePostgresSchema.mockClear();
  storeMocks.queryOne.mockReset();
  storeMocks.queryRows.mockReset();
  storeMocks.queryRows.mockResolvedValue([]);
});

const ROW = {
  id: 'planned:1',
  name: 'Review',
  prompt: 'Please review this prompt.',
  run_at: '2026-03-08T14:15:00.000Z',
  created_at: '2026-03-07T12:00:00.000Z',
  source: 'schedule_tool',
  channel_id: 'internal:planned:1',
  channel_type: 'terminal',
  author_id: 'scheduler',
  author_name: 'Review',
  status: 'pending',
  delivery_channel_id: 'discord:heartbeat',
  completed_at: null,
};

describe('PostgresScheduledPromptStore', () => {
  it('initializes the scheduled prompt schema on connect', async () => {
    await PostgresScheduledPromptStore.connect('postgres://postgres:secret@localhost:5432/psfn');

    expect(storeMocks.ensurePostgresSchema).toHaveBeenCalledWith(
      storeMocks.pool,
      expect.arrayContaining([expect.stringContaining('scheduler_scheduled_prompts')]),
    );
  });

  it('creates pending scheduled prompt rows', async () => {
    storeMocks.queryOne.mockResolvedValue(ROW);
    const store = await PostgresScheduledPromptStore.connect('postgres://x@localhost:5432/psfn');

    const created = await store.create({
      id: ROW.id,
      name: ROW.name,
      prompt: ROW.prompt,
      runAt: ROW.run_at,
      createdAt: ROW.created_at,
      source: 'schedule_tool',
      channelId: ROW.channel_id,
      channelType: 'terminal',
      authorId: ROW.author_id,
      authorName: ROW.author_name,
      deliveryChannelId: ROW.delivery_channel_id,
    });

    const [, sql, params] = storeMocks.queryOne.mock.calls[0];
    expect(sql).toContain('INSERT INTO scheduler_scheduled_prompts');
    expect(params).toEqual([
      ROW.id,
      ROW.name,
      ROW.prompt,
      ROW.run_at,
      ROW.created_at,
      'schedule_tool',
      ROW.channel_id,
      'terminal',
      ROW.author_id,
      ROW.author_name,
      ROW.delivery_channel_id,
    ]);
    expect(created).toMatchObject({
      id: ROW.id,
      status: 'pending',
      deliveryChannelId: ROW.delivery_channel_id,
    });
  });

  it('lists pending rows ordered by due time', async () => {
    storeMocks.queryRows.mockResolvedValue([ROW]);
    const store = await PostgresScheduledPromptStore.connect('postgres://x@localhost:5432/psfn');

    const rows = await store.listPending({ limit: 25 });

    const [, sql, params] = storeMocks.queryRows.mock.calls[0];
    expect(sql).toContain("WHERE status = 'pending'");
    expect(sql).toContain('ORDER BY run_at ASC, created_at ASC, id ASC');
    expect(params).toEqual([25]);
    expect(rows).toHaveLength(1);
  });

  it('marks only pending rows complete', async () => {
    storeMocks.queryOne.mockResolvedValue({
      ...ROW,
      status: 'completed',
      completed_at: '2026-03-08T14:16:00.000Z',
    });
    const store = await PostgresScheduledPromptStore.connect('postgres://x@localhost:5432/psfn');

    const completed = await store.markCompleted(ROW.id, {
      completedAt: '2026-03-08T14:16:00.000Z',
    });

    const [, sql, params] = storeMocks.queryOne.mock.calls[0];
    expect(sql).toContain("AND status = 'pending'");
    expect(params).toEqual([ROW.id, '2026-03-08T14:16:00.000Z']);
    expect(completed?.status).toBe('completed');
    expect(completed?.completedAt).toBe('2026-03-08T14:16:00.000Z');
  });
});
