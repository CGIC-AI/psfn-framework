export const BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE = 32;
export const TURN_RECORD_RECOVERY_EVIDENCE_ERROR_NAME = 'TurnRecordRecoveryEvidenceError';

export class BackgroundWorkHandoffRetryCapacityError extends Error {
  readonly capacity: number;

  constructor(capacity: number, options?: ErrorOptions) {
    super(
      `Background work handoff retry capacity ${String(capacity)} is exhausted; `
      + 'remaining durable handoffs require a later restart/rescan',
      options,
    );
    this.name = 'BackgroundWorkHandoffRetryCapacityError';
    this.capacity = capacity;
  }
}

export class TurnRecordRecoveryEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = TURN_RECORD_RECOVERY_EVIDENCE_ERROR_NAME;
  }
}

/**
 * Worker IPC preserves Error names rather than prototypes. Accept the canonical
 * class locally and the exact protocol name across IPC, including evidence
 * nested in a bounded AggregateError.
 */
export function isTurnRecordRecoveryEvidenceError(error: unknown): boolean {
  if (error instanceof TurnRecordRecoveryEvidenceError
    || (error instanceof Error && error.name === TURN_RECORD_RECOVERY_EVIDENCE_ERROR_NAME)) {
    return true;
  }
  return error instanceof AggregateError
    && error.errors.some(candidate => isTurnRecordRecoveryEvidenceError(candidate));
}
