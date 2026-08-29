import {
  FleetMaintenanceFenceLostError,
  type FleetMaintenanceCoordinator,
  type FleetMaintenanceLease,
} from './fleet-maintenance-coordinator.js';

export interface FleetMaintenancePrivateOutcome {
  outcome: 'complete' | 'yield' | 'retry';
}

export interface FleetMaintenanceRunControl {
  checkpoint(input: {
    phase: string;
    checkpointRef: string | null;
  }): Promise<'continue' | 'yield'>;
}

export type FleetMaintenanceBatonRunResult<T> =
  | { outcome: 'waiting'; retryAtMs: number }
  | { outcome: 'ran'; result: T };

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

async function releaseLease(input: {
  coordinator: FleetMaintenanceCoordinator;
  lease: FleetMaintenanceLease;
  nowMs: number;
  outcome: 'complete' | 'yield';
}): Promise<void> {
  try {
    await input.coordinator.release(input);
  } catch (error) {
    if (input.outcome === 'yield' && error instanceof FleetMaintenanceFenceLostError) {
      return;
    }
    throw error;
  }
}

/**
 * Runs one companion-private resumable drain under the system-scoped fenced
 * baton. The callback owns content and private checkpoints; this helper owns
 * only demand, lease renewal, opaque checkpoint authority, and release.
 */
export async function runWithFleetMaintenanceBaton<T extends FleetMaintenancePrivateOutcome>(
  input: {
    coordinator: FleetMaintenanceCoordinator;
    leaseDurationMs: number;
    retryDelayMs: number;
    phase: string;
    run(control: FleetMaintenanceRunControl): Promise<T>;
    now?: () => number;
  },
): Promise<FleetMaintenanceBatonRunResult<T>> {
  const leaseDurationMs = requirePositiveSafeInteger(
    input.leaseDurationMs,
    'fleetMaintenance.leaseDurationMs',
  );
  const retryDelayMs = requirePositiveSafeInteger(
    input.retryDelayMs,
    'fleetMaintenance.retryDelayMs',
  );
  const now = input.now ?? Date.now;
  const announcedAtMs = now();
  await input.coordinator.announceDemand({
    nowMs: announcedAtMs,
    demandExpiresAtMs: announcedAtMs + leaseDurationMs,
  });
  const acquireAtMs = now();
  const acquired = await input.coordinator.tryAcquire({
    nowMs: acquireAtMs,
    leaseExpiresAtMs: acquireAtMs + leaseDurationMs,
    phase: input.phase,
  });
  if (acquired.outcome === 'waiting') {
    const retryDeadlineMs = acquireAtMs + retryDelayMs;
    return {
      outcome: 'waiting',
      retryAtMs: acquired.retryAtMs !== null && acquired.retryAtMs > acquireAtMs
        ? Math.min(acquired.retryAtMs, retryDeadlineMs)
        : retryDeadlineMs,
    };
  }

  let lease = acquired.lease;
  let leaseMutationTail: Promise<void> = Promise.resolve();
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let renewalInFlight: Promise<void> = Promise.resolve();
  const authorityState: { failure: { error: unknown } | null } = { failure: null };
  let renewalStopped = false;
  const renewalDelayMs = Math.max(1, Math.floor(leaseDurationMs / 2));

  const mutateLease = async <R>(operation: () => Promise<R>): Promise<R> => {
    const mutation = leaseMutationTail.then(async () => {
      if (authorityState.failure !== null) throw authorityState.failure.error;
      return await operation();
    });
    leaseMutationTail = mutation.then(() => undefined, () => undefined);
    return await mutation;
  };

  const scheduleRenewal = (): void => {
    if (renewalStopped || authorityState.failure !== null) return;
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      renewalInFlight = mutateLease(async () => {
        const renewalAtMs = now();
        lease = await input.coordinator.renew({
          lease,
          nowMs: renewalAtMs,
          leaseExpiresAtMs: renewalAtMs + leaseDurationMs,
        });
      }).catch((error: unknown) => {
        authorityState.failure = { error };
      }).finally(() => {
        scheduleRenewal();
      });
    }, renewalDelayMs);
  };

  const stopRenewal = async (): Promise<void> => {
    renewalStopped = true;
    if (renewalTimer !== null) {
      clearTimeout(renewalTimer);
      renewalTimer = null;
    }
    await renewalInFlight;
    await leaseMutationTail;
  };

  const control: FleetMaintenanceRunControl = {
    checkpoint: async checkpoint => {
      if (authorityState.failure?.error instanceof FleetMaintenanceFenceLostError) {
        return 'yield';
      }
      if (authorityState.failure !== null) throw authorityState.failure.error;
      try {
        return await mutateLease(async () => {
          const checkpointAtMs = now();
          const committed = await input.coordinator.commitCheckpoint({
            lease,
            nowMs: checkpointAtMs,
            leaseExpiresAtMs: checkpointAtMs + leaseDurationMs,
            phase: checkpoint.phase,
            checkpointRef: checkpoint.checkpointRef,
          });
          lease = committed.lease;
          return committed.disposition === 'yield_requested' ? 'yield' : 'continue';
        });
      } catch (error) {
        authorityState.failure = { error };
        if (error instanceof FleetMaintenanceFenceLostError) return 'yield';
        throw error;
      }
    },
  };
  scheduleRenewal();

  try {
    const result = await input.run(control);
    await stopRenewal();
    const authorityFailure = authorityState.failure?.error;
    if (authorityState.failure !== null
      && !(authorityFailure instanceof FleetMaintenanceFenceLostError
        && result.outcome === 'yield')) {
      throw authorityFailure;
    }
    await releaseLease({
      coordinator: input.coordinator,
      lease,
      nowMs: now(),
      outcome: result.outcome === 'complete' ? 'complete' : 'yield',
    });
    return { outcome: 'ran', result };
  } catch (error) {
    await stopRenewal();
    const failures: unknown[] = [error];
    const authorityFailure = authorityState.failure?.error;
    if (authorityState.failure !== null && authorityFailure !== error) {
      failures.push(authorityFailure);
    }
    try {
      await releaseLease({
        coordinator: input.coordinator,
        lease,
        nowMs: now(),
        outcome: 'yield',
      });
    } catch (releaseError) {
      failures.push(releaseError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Fleet maintenance run failed with cleanup errors');
    }
    throw error;
  }
}
