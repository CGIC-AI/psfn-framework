import {
  BackgroundWorkHandoffRetryCapacityError,
  isTurnRecordRecoveryEvidenceError,
} from './recovery-contract.js';

export interface BackgroundWorkTickOperations {
  recoverHandoffs(): Promise<void>;
  tick(): Promise<void>;
}

/**
 * Attempt every record from the one-time historical scan. Failed records are
 * transferred to the bounded per-tick retry index instead of forcing the next
 * scheduler tick to enumerate the full TurnRecord history again.
 */
export async function recoverHistoricalBackgroundWorkHandoffs<T>(
  records: Iterable<T> | AsyncIterable<T>,
  enqueue: (record: T) => Promise<void>,
  defer: (record: T) => void,
): Promise<void> {
  const errors: unknown[] = [];
  const retainedErrorsLimit = 16;
  let suppressedErrors = 0;
  for await (const record of records) {
    try {
      await enqueue(record);
    } catch (error) {
      if (isTurnRecordRecoveryEvidenceError(error)) throw error;
      try {
        defer(record);
        if (errors.length < retainedErrorsLimit) errors.push(error);
        else suppressedErrors += 1;
      } catch (deferError) {
        if (deferError instanceof BackgroundWorkHandoffRetryCapacityError) {
          throw new BackgroundWorkHandoffRetryCapacityError(deferError.capacity, {
            cause: new AggregateError(
              [error, deferError],
              'Historical background work handoff retry capacity was exhausted after enqueue failed',
            ),
          });
        }
        if (isTurnRecordRecoveryEvidenceError(deferError)) throw deferError;
        const combined = new AggregateError(
          [error, deferError],
          'Historical background work handoff failed to enqueue and index for retry',
        );
        if (errors.length < retainedErrorsLimit) errors.push(combined);
        else suppressedErrors += 1;
      }
    }
  }

  if (suppressedErrors > 0) {
    errors.push(new Error(
      `${suppressedErrors} additional historical background work handoff failures were suppressed`,
    ));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Multiple historical background work handoffs failed');
  }
}

/**
 * Advance queued work even when an independently recoverable handoff is
 * poisoned. Recovery errors remain visible to the scheduler; they cannot
 * starve unrelated durable jobs that were already accepted by the store.
 */
export async function runBackgroundWorkTick(
  operations: BackgroundWorkTickOperations,
): Promise<void> {
  let recoveryFailed = false;
  let recoveryError: unknown;
  try {
    await operations.recoverHandoffs();
  } catch (error) {
    recoveryFailed = true;
    recoveryError = error;
  }

  try {
    await operations.tick();
  } catch (tickError) {
    if (recoveryFailed) {
      throw new AggregateError(
        [recoveryError, tickError],
        'Background work handoff recovery and supervisor tick both failed',
      );
    }
    throw tickError;
  }

  if (recoveryFailed) throw recoveryError;
}
