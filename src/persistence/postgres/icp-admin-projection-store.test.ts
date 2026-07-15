import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPostgresPool: vi.fn(),
  queryRows: vi.fn(async () => [] as never[]),
  connectShared: vi.fn(),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: mocks.createPostgresPool,
  queryRows: mocks.queryRows,
}));

vi.mock('./icp-shared-autonomy-store.js', () => ({
  PostgresIcpSharedAutonomyStore: {
    connect: mocks.connectShared,
  },
}));

import { PostgresIcpAdminProjectionStore } from './icp-admin-projection-store.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

describe('PostgresIcpAdminProjectionStore tenant binding', () => {
  beforeEach(() => {
    mocks.createPostgresPool.mockReset();
    mocks.queryRows.mockReset();
    mocks.queryRows.mockResolvedValue([]);
    mocks.connectShared.mockReset();
  });

  it('binds every projection query to the local companion before applying its limit', async () => {
    const sharedPool = { end: vi.fn() };
    const costPool = { end: vi.fn() };
    const shared = { close: vi.fn() };
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.connectShared.mockResolvedValue(shared);
    const store = await PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
    });

    await expect(store.readProjection(7)).resolves.toEqual({
      availability: [],
      episodes: [],
      permits: [],
      fatigue: [],
      costs: [],
    });

    expect(store.localCompanionId).toBe(LOCAL);
    expect(mocks.queryRows).toHaveBeenCalledTimes(5);
    for (const call of mocks.queryRows.mock.calls) {
      expect(call[2]).toEqual([LOCAL, 7]);
    }
    const sql = mocks.queryRows.mock.calls.map(call => String(call[1]));
    expect(sql[0]).toMatch(/WHERE companion_id = \$1/u);
    expect(sql[1]).toMatch(/WHERE \$1::uuid = ANY\(participant_companion_ids\)/u);
    expect(sql[2]).toMatch(/sender_companion_id = \$1 OR recipient_companion_id = \$1/u);
    expect(sql[3]).toMatch(/local_companion_id = \$1 OR peer_companion_id = \$1/u);
    expect(sql[4]).toMatch(/INNER JOIN shared\.icp_conversation_episodes/u);
    expect(sql[4]).toMatch(/WHERE \$1::uuid = ANY\(episode\.participant_companion_ids\)/u);
  });

  it('rejects a local identity outside the known fleet before opening pools', async () => {
    await expect(PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [PEER],
    })).rejects.toThrow('known local companion identity');
    expect(mocks.createPostgresPool).not.toHaveBeenCalled();
    expect(mocks.connectShared).not.toHaveBeenCalled();
  });
});
