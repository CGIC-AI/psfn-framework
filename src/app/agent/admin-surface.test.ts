import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IcpAdminProjectionStore } from '../../persistence/postgres/icp-admin-projection-store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const mocks = vi.hoisted(() => ({
  connectProjection: vi.fn(),
  awaitOptionalReadiness: vi.fn(async (
    _store: string,
    task: () => Promise<unknown>,
  ) => {
    try {
      return await task();
    } catch {
      return undefined;
    }
  }),
}));

vi.mock('../../persistence/postgres/icp-admin-projection-store.js', () => ({
  PostgresIcpAdminProjectionStore: { connect: mocks.connectProjection },
}));

vi.mock('../../persistence/postgres/runtime-readiness.js', () => ({
  awaitOptionalPostgresStoreReadiness: mocks.awaitOptionalReadiness,
}));

import { openIcpAdminProjectionStoreForGarden } from './admin-surface.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

function config(): SubstrateConfig {
  return {
    multiCompanion: true,
    companionId: LOCAL,
    postgresDatabaseUrl: 'postgres://runtime',
    companionFleet: {
      companions: [{ companionId: LOCAL }, { companionId: PEER }],
    },
  } as unknown as SubstrateConfig;
}

describe('production ICP Garden projection composition', () => {
  beforeEach(() => {
    mocks.connectProjection.mockReset();
    mocks.awaitOptionalReadiness.mockClear();
  });

  it('preserves a store whose optional cost slice is unavailable', async () => {
    const store = {
      readProjection: vi.fn(async () => ({
        availability: [],
        episodes: [],
        permits: [],
        fatigue: [],
        costs: [],
        costProjection: {
          available: false,
          unavailableReason: 'relation_contract_unavailable',
        },
      })),
    } as unknown as IcpAdminProjectionStore;
    mocks.connectProjection.mockResolvedValue(store);

    await expect(openIcpAdminProjectionStoreForGarden(config())).resolves.toBe(store);
    expect(mocks.connectProjection).toHaveBeenCalledWith('postgres://runtime', {
      localCompanionId: LOCAL,
      knownCompanionIds: [LOCAL, PEER],
      config: expect.objectContaining({ multiCompanion: true }),
    });
    expect(mocks.awaitOptionalReadiness).toHaveBeenCalledWith(
      'icp_admin_projection',
      expect.any(Function),
    );
  });

  it('fails closed when the required shared projection cannot connect', async () => {
    mocks.connectProjection.mockRejectedValue(new Error('required ICP relation is malformed'));

    await expect(openIcpAdminProjectionStoreForGarden(config())).resolves.toBeNull();
  });
});
