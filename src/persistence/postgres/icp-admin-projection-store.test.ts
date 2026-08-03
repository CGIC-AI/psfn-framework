import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPostgresPool: vi.fn(),
  queryRows: vi.fn(async (
    _pool: unknown,
    _sql: string,
    _values?: readonly unknown[],
  ) => [] as never[]),
  assertRelationColumns: vi.fn(async () => undefined),
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

vi.mock('./relation-contract.js', () => ({
  assertPostgresRelationColumns: mocks.assertRelationColumns,
}));

import { PostgresIcpAdminProjectionStore } from './icp-admin-projection-store.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const FLEET_CONFIG = {
  multiCompanion: true,
  companionFleet: { companions: [{ postgresSchema: 'companion_primary' }] },
  postgresRole: 'companion_follower_runtime',
} as const;

describe('PostgresIcpAdminProjectionStore tenant binding', () => {
  beforeEach(() => {
    mocks.createPostgresPool.mockReset();
    mocks.queryRows.mockReset();
    mocks.queryRows.mockResolvedValue([]);
    mocks.assertRelationColumns.mockReset();
    mocks.assertRelationColumns.mockResolvedValue(undefined);
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
      config: FLEET_CONFIG,
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
    const projectionCalls = mocks.queryRows.mock.calls;
    for (const call of projectionCalls) {
      expect(call[2]).toEqual([LOCAL, 7]);
    }
    expect(mocks.assertRelationColumns).toHaveBeenCalledWith(costPool, {
      relation: 'icp_conversation_cost_decisions',
      columns: [
        'decision_id',
        'conversation_id',
        'root_initiation_id',
        'recorded_at_ms',
        'actual_cost_usd',
        'pending_projected_cost_usd',
        'projected_total_cost_usd',
        'warning_threshold_usd',
        'hard_limit_usd',
        'unknown_cost_attempt_count',
        'allowed',
        'reason',
      ],
    });
    const sql = projectionCalls.map(call => String(call[1]));
    expect(sql[0]).toMatch(/WHERE companion_id = \$1/u);
    expect(sql[1]).toMatch(/WHERE \$1::uuid = ANY\(participant_companion_ids\)/u);
    expect(sql[2]).toMatch(/sender_companion_id = \$1 OR recipient_companion_id = \$1/u);
    expect(sql[3]).toMatch(/local_companion_id = \$1 OR peer_companion_id = \$1/u);
    expect(sql[4]).toMatch(/INNER JOIN shared\.icp_conversation_episodes/u);
    expect(sql[4]).toMatch(/WHERE \$1::uuid = ANY\(episode\.participant_companion_ids\)/u);
  });

  it('fails readiness on an unavailable cost ledger before opening the shared store', async () => {
    const sharedPool = { end: vi.fn(async () => {}) };
    const costPool = { end: vi.fn(async () => {}) };
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.assertRelationColumns.mockRejectedValueOnce(
      new Error('cost ledger schema version is missing'),
    );

    await expect(PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: FLEET_CONFIG,
    })).rejects.toThrow('cost ledger schema version is missing');
    expect(mocks.connectShared).not.toHaveBeenCalled();
    expect(sharedPool.end).toHaveBeenCalledOnce();
    expect(costPool.end).toHaveBeenCalledOnce();
  });

  it('pins the cost pool to the canonical fleet ledger under the current read-only role', async () => {
    // Regression for psfn-framework-vzh0u: the cost pool used to open with no
    // schema, so its unqualified icp_conversation_cost_decisions read resolved
    // via the libpq default `"$user", public` search_path. It must now state its
    // fleet-wide scope deliberately by pinning the canonical ledger schema.
    const sharedPool = { end: vi.fn() };
    const costPool = { end: vi.fn() };
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.connectShared.mockResolvedValue({ close: vi.fn() });

    await PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: FLEET_CONFIG,
    });

    expect(mocks.createPostgresPool).toHaveBeenCalledTimes(2);
    const sharedOptions = mocks.createPostgresPool.mock.calls[0]?.[1] ?? {};
    expect(sharedOptions).toMatchObject({ schema: 'shared' });
    const costOptions = mocks.createPostgresPool.mock.calls[1]?.[1] ?? {};
    expect(costOptions).toMatchObject({
      applicationName: 'psfn-icp-admin-cost-projection',
      schema: 'companion_primary',
      role: 'companion_follower_runtime',
      readOnly: true,
    });
  });

  it('fails closed for an ambiguous (single-companion) scope before opening pools', async () => {
    // The cost projection is a multi-companion-only fleet aggregation surface;
    // constructing it in single-companion mode is ambiguous and must refuse
    // rather than fall back to the accidental default-public path.
    await expect(PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: { multiCompanion: false },
    })).rejects.toThrow(/multi-companion mode/u);
    expect(mocks.createPostgresPool).not.toHaveBeenCalled();
    expect(mocks.connectShared).not.toHaveBeenCalled();
  });

  it('rejects a local identity outside the known fleet before opening pools', async () => {
    await expect(PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [PEER],
      config: FLEET_CONFIG,
    })).rejects.toThrow('known local companion identity');
    expect(mocks.createPostgresPool).not.toHaveBeenCalled();
    expect(mocks.connectShared).not.toHaveBeenCalled();
  });
});
