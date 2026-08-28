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
const VALID_COST_ROW = {
  conversation_id: '33333333-3333-4333-8333-333333333333',
  root_initiation_id: '44444444-4444-4444-8444-444444444444',
  recorded_at_ms: '2000',
  actual_cost_usd: 0.25,
  pending_projected_cost_usd: '0.5',
  projected_total_cost_usd: 0.75,
  warning_threshold_usd: 1,
  hard_limit_usd: 2,
  unknown_cost_attempt_count: '0',
  allowed: true,
  reason: 'below_warning',
  participant_companion_ids: [LOCAL, PEER],
} as const;

function sharedStoreMock() {
  return {
    close: vi.fn(async () => {}),
    listDyadsForCompanion: vi.fn(async () => []),
  };
}

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
    const shared = sharedStoreMock();
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
      dyads: [],
      episodes: [],
      permits: [],
      fatigue: [],
      costs: [],
      costProjection: { available: true, unavailableReason: null },
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
      privileges: ['SELECT'],
    });
    expect(mocks.assertRelationColumns.mock.calls
      .slice(0, 4)
      .map(call => call[1].relation)
      .sort()).toEqual([
      'icp_availability_leases',
      'icp_conversation_episodes',
      'icp_fatigue_turn_reservations',
      'icp_initiation_permits',
    ]);
    const sql = projectionCalls.map(call => String(call[1]));
    expect(sql[0]).toMatch(/WHERE companion_id = \$1/u);
    expect(sql[1]).toMatch(/WHERE \$1::uuid = ANY\(participant_companion_ids\)/u);
    expect(sql[2]).toMatch(/sender_companion_id = \$1 OR recipient_companion_id = \$1/u);
    expect(sql[3]).toMatch(/local_companion_id = \$1 OR peer_companion_id = \$1/u);
    expect(sql[4]).toMatch(/INNER JOIN shared\.icp_conversation_episodes/u);
    expect(sql[4]).toMatch(/WHERE \$1::uuid = ANY\(episode\.participant_companion_ids\)/u);
  });

  it('keeps the shared control plane ready when the optional cost relation is unavailable', async () => {
    const sharedPool = { end: vi.fn(async () => {}) };
    const costPool = { end: vi.fn(async () => {}) };
    const shared = sharedStoreMock();
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.connectShared.mockResolvedValue(shared);
    mocks.assertRelationColumns.mockImplementation(async (
      _pool: unknown,
      contract: { relation: string },
    ) => {
      if (contract.relation === 'icp_conversation_cost_decisions') {
        throw new Error('cost ledger schema version is missing');
      }
    });

    const store = await PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: FLEET_CONFIG,
    });

    await expect(store.readProjection()).resolves.toEqual({
      availability: [],
      dyads: [],
      episodes: [],
      permits: [],
      fatigue: [],
      costs: [],
      costProjection: {
        available: false,
        unavailableReason: 'relation_contract_unavailable',
      },
    });
    expect(mocks.connectShared).toHaveBeenCalledOnce();
    expect(mocks.queryRows).toHaveBeenCalledTimes(4);
    expect(sharedPool.end).not.toHaveBeenCalled();
    expect(costPool.end).not.toHaveBeenCalled();
  });

  it('restores the optional cost slice on a later read after its relation appears', async () => {
    const sharedPool = { end: vi.fn(async () => {}) };
    const costPool = { end: vi.fn(async () => {}) };
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.connectShared.mockResolvedValue(sharedStoreMock());
    let costProbeCount = 0;
    mocks.assertRelationColumns.mockImplementation(async (
      _pool: unknown,
      contract: { relation: string },
    ) => {
      if (contract.relation === 'icp_conversation_cost_decisions'
        && costProbeCount++ === 0) {
        throw new Error('relation is not installed yet');
      }
    });
    const store = await PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: FLEET_CONFIG,
    });

    const first = await store.readProjection();
    const second = await store.readProjection();

    expect(first.costProjection).toEqual({
      available: false,
      unavailableReason: 'relation_contract_unavailable',
    });
    expect(second.costProjection).toEqual({ available: true, unavailableReason: null });
    expect(mocks.queryRows).toHaveBeenCalledTimes(9);
  });

  it('reports an optional cost read failure without discarding the shared projection', async () => {
    const sharedPool = { end: vi.fn(async () => {}) };
    const costPool = { end: vi.fn(async () => {}) };
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.connectShared.mockResolvedValue(sharedStoreMock());
    mocks.queryRows.mockImplementation(async (
      _pool: unknown,
      sql: string,
    ) => {
      if (sql.includes('FROM icp_conversation_cost_decisions')) {
        throw new Error('cost ledger read failed');
      }
      return [];
    });
    const store = await PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: FLEET_CONFIG,
    });

    await expect(store.readProjection()).resolves.toEqual({
      availability: [],
      dyads: [],
      episodes: [],
      permits: [],
      fatigue: [],
      costs: [],
      costProjection: {
        available: false,
        unavailableReason: 'read_failed',
      },
    });
    expect(mocks.queryRows).toHaveBeenCalledTimes(5);
  });

  it('isolates malformed optional cost rows and restores the slice on a later valid read', async () => {
    const sharedPool = { end: vi.fn(async () => {}) };
    const costPool = { end: vi.fn(async () => {}) };
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.connectShared.mockResolvedValue(sharedStoreMock());
    const malformedRows: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['allowed must be boolean', { ...VALID_COST_ROW, allowed: 'false' }],
      ['reason must be present', { ...VALID_COST_ROW, reason: null }],
      ['reason must be supported', { ...VALID_COST_ROW, reason: 'surprise_override' }],
      ['conversation id must be text', { ...VALID_COST_ROW, conversation_id: 42 }],
      ['root initiation id must be nonblank', { ...VALID_COST_ROW, root_initiation_id: ' ' }],
      ['recorded time must be numeric', { ...VALID_COST_ROW, recorded_at_ms: false }],
      ['actual cost must be numeric', { ...VALID_COST_ROW, actual_cost_usd: null }],
      ['pending cost must be numeric', { ...VALID_COST_ROW, pending_projected_cost_usd: [] }],
      ['numeric strings must be canonical', { ...VALID_COST_ROW, actual_cost_usd: '0x10' }],
      ['projected cost must be finite', { ...VALID_COST_ROW, projected_total_cost_usd: Infinity }],
      ['warning threshold must be positive', { ...VALID_COST_ROW, warning_threshold_usd: 0 }],
      ['hard limit must exceed warning', { ...VALID_COST_ROW, hard_limit_usd: 0.5 }],
      ['unknown count must be an integer', { ...VALID_COST_ROW, unknown_cost_attempt_count: 0.5 }],
      ['participants must be companion UUIDs', {
        ...VALID_COST_ROW,
        participant_companion_ids: [LOCAL, 'not-a-companion'],
      }],
    ];
    const costRows = malformedRows.map(([, row]) => row).concat(VALID_COST_ROW);
    let costReadCount = 0;
    mocks.queryRows.mockImplementation(async (
      _pool: unknown,
      sql: string,
    ) => (sql.includes('FROM icp_conversation_cost_decisions')
      ? [costRows[costReadCount++]] as never[]
      : []));
    const store = await PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: FLEET_CONFIG,
    });

    for (const [label] of malformedRows) {
      const projection = await store.readProjection();
      expect(projection, label).toMatchObject({
        availability: [],
        episodes: [],
        permits: [],
        fatigue: [],
        costs: [],
        costProjection: {
          available: false,
          unavailableReason: 'row_contract_invalid',
        },
      });
    }
    await expect(store.readProjection()).resolves.toMatchObject({
      costs: [{
        conversationId: VALID_COST_ROW.conversation_id,
        rootInitiationId: VALID_COST_ROW.root_initiation_id,
        recordedAtMs: 2_000,
        actualCostUsd: 0.25,
        pendingProjectedCostUsd: 0.5,
        projectedTotalCostUsd: 0.75,
        warningThresholdUsd: 1,
        hardLimitUsd: 2,
        unknownCostAttemptCount: 0,
        allowed: true,
        reason: 'below_warning',
        participantCompanionIds: [LOCAL, PEER],
      }],
      costProjection: { available: true, unavailableReason: null },
    });
  });

  it('fails readiness when a mandatory shared projection relation is malformed', async () => {
    const sharedPool = { end: vi.fn(async () => {}) };
    const costPool = { end: vi.fn(async () => {}) };
    mocks.createPostgresPool
      .mockReturnValueOnce(sharedPool)
      .mockReturnValueOnce(costPool);
    mocks.assertRelationColumns.mockImplementation(async (
      _pool: unknown,
      contract: { relation: string },
    ) => {
      if (contract.relation === 'icp_conversation_episodes') {
        throw new Error('mandatory episode projection columns are missing');
      }
    });

    await expect(PostgresIcpAdminProjectionStore.connect('postgres://test', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: FLEET_CONFIG,
    })).rejects.toThrow('mandatory episode projection columns are missing');
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
    mocks.connectShared.mockResolvedValue(sharedStoreMock());

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
