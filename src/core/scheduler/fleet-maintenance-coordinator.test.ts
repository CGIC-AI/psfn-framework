import { describe, expect, it, vi } from 'vitest';

import {
  createFleetMaintenanceCoordinator,
  staggerFleetScheduleWithinWindow,
  type FleetMaintenanceLease,
  type FleetMaintenanceStorePort,
} from './fleet-maintenance-coordinator.js';

const COMPANIONS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;

describe('fleet maintenance coordinator', () => {
  it('places lightweight work deterministically inside its existing semantic window', () => {
    const window = {
      windowStartMs: Date.parse('2026-08-29T11:00:00.000Z'),
      windowEndMs: Date.parse('2026-08-29T12:00:00.000Z'),
    };

    expect(COMPANIONS.map(companionId => staggerFleetScheduleWithinWindow({
      companionId,
      fleetCompanionIds: COMPANIONS,
      ...window,
    }))).toEqual([
      { manifestOrdinal: 0, scheduledAtMs: Date.parse('2026-08-29T11:00:00.000Z') },
      { manifestOrdinal: 1, scheduledAtMs: Date.parse('2026-08-29T11:20:00.000Z') },
      { manifestOrdinal: 2, scheduledAtMs: Date.parse('2026-08-29T11:40:00.000Z') },
    ]);
  });
});

describe('foreground preemption (jrki1)', () => {
  const NOW = Date.parse('2026-09-25T06:00:00.000Z');

  function lease(overrides: Partial<FleetMaintenanceLease> = {}): FleetMaintenanceLease {
    return {
      companionId: COMPANIONS[0],
      fencingToken: 7,
      acquiredAtMs: NOW,
      expiresAtMs: NOW + 60_000,
      phase: 'sleeptime-drain',
      checkpointRef: null,
      preemptRequested: false,
      ...overrides,
    };
  }

  function fakeStore(): FleetMaintenanceStorePort & { requestPreemption: ReturnType<typeof vi.fn> } {
    return {
      announceDemand: vi.fn(async () => undefined),
      tryAcquire: vi.fn(async () => ({ outcome: 'acquired' as const, lease: lease() })),
      renew: vi.fn(async () => lease()),
      commitCheckpoint: vi.fn(async () => ({ lease: lease(), disposition: 'continue' as const })),
      release: vi.fn(async () => undefined),
      requestPreemption: vi.fn(async () => true),
      withdrawDemand: vi.fn(async () => undefined),
      readCheckpoint: vi.fn(async () => null),
      close: vi.fn(async () => undefined),
    };
  }

  function coordinatorOver(store: FleetMaintenanceStorePort) {
    return createFleetMaintenanceCoordinator({ store, companionId: COMPANIONS[0], fleetCompanionIds: COMPANIONS });
  }

  it('preempts a baton this instance holds in memory, with no database round trip', async () => {
    const store = fakeStore();
    const coordinator = coordinatorOver(store);
    await coordinator.tryAcquire({ nowMs: NOW, leaseExpiresAtMs: NOW + 60_000, phase: 'sleeptime-drain' });

    expect(await coordinator.requestForegroundPreemption({ nowMs: NOW + 1 })).toBe(true);
    expect(store.requestPreemption).not.toHaveBeenCalled();

    const checkpoint = await coordinator.commitCheckpoint({
      lease: lease(), nowMs: NOW + 2, leaseExpiresAtMs: NOW + 60_000, phase: 'wiki-pass', checkpointRef: 'r1',
    });
    expect(checkpoint.disposition).toBe('yield_requested');
    expect(checkpoint.lease.preemptRequested).toBe(true);
  });

  it('signals through the shared row when this instance holds no baton', async () => {
    const store = fakeStore();
    const coordinator = coordinatorOver(store);
    await coordinator.requestForegroundPreemption({ nowMs: NOW });
    expect(store.requestPreemption).toHaveBeenCalledTimes(1);
  });

  it('falls back to the shared row once the held lease expired or was released', async () => {
    const store = fakeStore();
    const coordinator = coordinatorOver(store);
    await coordinator.tryAcquire({ nowMs: NOW, leaseExpiresAtMs: NOW + 60_000, phase: 'sleeptime-drain' });
    await coordinator.requestForegroundPreemption({ nowMs: NOW + 60_001 });
    expect(store.requestPreemption).toHaveBeenCalledTimes(1);

    const second = fakeStore();
    const released = coordinatorOver(second);
    await released.tryAcquire({ nowMs: NOW, leaseExpiresAtMs: NOW + 60_000, phase: 'sleeptime-drain' });
    await released.release({ lease: lease(), nowMs: NOW + 1, outcome: 'complete' });
    await released.requestForegroundPreemption({ nowMs: NOW + 2 });
    expect(second.requestPreemption).toHaveBeenCalledTimes(1);
  });
});
