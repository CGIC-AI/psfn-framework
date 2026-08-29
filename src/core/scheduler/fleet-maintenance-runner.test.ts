import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FleetMaintenanceFenceLostError,
  type FleetMaintenanceCoordinator,
  type FleetMaintenanceLease,
} from './fleet-maintenance-coordinator.js';
import { runWithFleetMaintenanceBaton } from './fleet-maintenance-runner.js';

function lease(overrides: Partial<FleetMaintenanceLease> = {}): FleetMaintenanceLease {
  return {
    companionId: '11111111-1111-4111-8111-111111111111',
    fencingToken: 7,
    acquiredAtMs: 1_000,
    expiresAtMs: 6_000,
    phase: 'sleeptime',
    checkpointRef: null,
    preemptRequested: false,
    ...overrides,
  };
}

function coordinator() {
  const initialLease = lease();
  return {
    companionId: initialLease.companionId,
    manifestOrdinal: 0,
    fleetSize: 3,
    announceDemand: vi.fn(async () => undefined),
    tryAcquire: vi.fn(async () => ({ outcome: 'acquired' as const, lease: initialLease })),
    renew: vi.fn(async ({ lease: currentLease, leaseExpiresAtMs }) => ({
      ...currentLease,
      expiresAtMs: leaseExpiresAtMs,
    })),
    commitCheckpoint: vi.fn(async () => ({
      lease: lease({ expiresAtMs: 7_000, phase: 'orientation_review' }),
      disposition: 'continue' as const,
    })),
    release: vi.fn(async () => undefined),
    requestForegroundPreemption: vi.fn(),
    withdrawDemand: vi.fn(),
    readCheckpoint: vi.fn(),
    close: vi.fn(),
  } satisfies FleetMaintenanceCoordinator;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('runWithFleetMaintenanceBaton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces, acquires, checkpoints, and releases completed private work', async () => {
    const fleet = coordinator();
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_100);

    await expect(runWithFleetMaintenanceBaton({
      coordinator: fleet,
      leaseDurationMs: 5_000,
      retryDelayMs: 500,
      phase: 'sleeptime',
      now,
      run: async control => {
        await expect(control.checkpoint({
          phase: 'orientation_review',
          checkpointRef: 'opaque-ref',
        })).resolves.toBe('continue');
        return { outcome: 'complete' as const };
      },
    })).resolves.toEqual({ outcome: 'ran', result: { outcome: 'complete' } });

    expect(fleet.announceDemand).toHaveBeenCalledWith({
      nowMs: 1_000,
      demandExpiresAtMs: 6_000,
    });
    expect(fleet.commitCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ fencingToken: 7 }),
      nowMs: 2_000,
      leaseExpiresAtMs: 7_000,
      phase: 'orientation_review',
      checkpointRef: 'opaque-ref',
    }));
    expect(fleet.release).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ phase: 'orientation_review' }),
      nowMs: 2_100,
      outcome: 'complete',
    }));
  });

  it('keeps demand durable and returns the bounded retry instant while another companion holds it', async () => {
    const fleet = coordinator();
    fleet.tryAcquire.mockResolvedValue({
      outcome: 'waiting',
      reason: 'held',
      holderCompanionId: '22222222-2222-4222-8222-222222222222',
      nextCompanionId: '22222222-2222-4222-8222-222222222222',
      retryAtMs: 4_000,
    });
    const run = vi.fn();

    await expect(runWithFleetMaintenanceBaton({
      coordinator: fleet,
      leaseDurationMs: 5_000,
      retryDelayMs: 500,
      phase: 'sleeptime',
      now: () => 1_000,
      run,
    })).resolves.toEqual({ outcome: 'waiting', retryAtMs: 1_500 });
    expect(run).not.toHaveBeenCalled();
    expect(fleet.release).not.toHaveBeenCalled();
    expect(fleet.withdrawDemand).not.toHaveBeenCalled();
  });

  it('releases a yielded lease after a safe-boundary preemption', async () => {
    const fleet = coordinator();
    fleet.commitCheckpoint.mockResolvedValue({
      lease: lease({ preemptRequested: true }),
      disposition: 'yield_requested',
    });

    await expect(runWithFleetMaintenanceBaton({
      coordinator: fleet,
      leaseDurationMs: 5_000,
      retryDelayMs: 500,
      phase: 'sleeptime',
      now: () => 1_000,
      run: async control => ({
        outcome: await control.checkpoint({ phase: 'arc_formation', checkpointRef: null }) === 'yield'
          ? 'yield' as const
          : 'complete' as const,
      }),
    })).resolves.toEqual({ outcome: 'ran', result: { outcome: 'yield' } });
    expect(fleet.release).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'yield' }));
  });

  it('renews a healthy lease while private work is still inside a slow stage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fleet = coordinator();
    const stage = deferred();

    const running = runWithFleetMaintenanceBaton({
      coordinator: fleet,
      leaseDurationMs: 1_000,
      retryDelayMs: 100,
      phase: 'sleeptime',
      run: async control => {
        await stage.promise;
        await control.checkpoint({ phase: 'slow-stage-complete', checkpointRef: null });
        return { outcome: 'complete' as const };
      },
    });

    await vi.advanceTimersByTimeAsync(2_100);
    expect(fleet.renew).toHaveBeenCalledTimes(4);
    expect(fleet.renew).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseExpiresAtMs: 4_000,
    }));

    stage.resolve();
    await expect(running).resolves.toEqual({
      outcome: 'ran',
      result: { outcome: 'complete' },
    });
  });

  it('turns renewal fence loss into a cooperative yield at the next safe boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fleet = coordinator();
    fleet.renew.mockRejectedValueOnce(new FleetMaintenanceFenceLostError());
    const stage = deferred();

    const running = runWithFleetMaintenanceBaton({
      coordinator: fleet,
      leaseDurationMs: 1_000,
      retryDelayMs: 100,
      phase: 'sleeptime',
      run: async control => {
        await stage.promise;
        return {
          outcome: await control.checkpoint({ phase: 'slow-stage-complete', checkpointRef: null })
            === 'yield'
            ? 'yield' as const
            : 'complete' as const,
        };
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    stage.resolve();
    await expect(running).resolves.toEqual({
      outcome: 'ran',
      result: { outcome: 'yield' },
    });
    expect(fleet.commitCheckpoint).not.toHaveBeenCalled();
    expect(fleet.release).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'yield' }));
  });

  it('does not mask a non-fence renewal failure behind a private yield', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fleet = coordinator();
    const renewalFailure = new Error('Postgres renewal failed');
    fleet.renew.mockRejectedValueOnce(renewalFailure);
    const stage = deferred();

    const running = runWithFleetMaintenanceBaton({
      coordinator: fleet,
      leaseDurationMs: 1_000,
      retryDelayMs: 100,
      phase: 'sleeptime',
      run: async () => {
        await stage.promise;
        return { outcome: 'yield' as const };
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    stage.resolve();
    await expect(running).rejects.toBe(renewalFailure);
  });

  it('preserves both private-run and renewal failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fleet = coordinator();
    const renewalFailure = new Error('Postgres renewal failed');
    const runFailure = new Error('Private stage failed');
    fleet.renew.mockRejectedValueOnce(renewalFailure);
    const stage = deferred();

    const running = runWithFleetMaintenanceBaton({
      coordinator: fleet,
      leaseDurationMs: 1_000,
      retryDelayMs: 100,
      phase: 'sleeptime',
      run: async () => {
        await stage.promise;
        throw runFailure;
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    stage.resolve();
    const caught = await running.catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([runFailure, renewalFailure]);
  });
});
