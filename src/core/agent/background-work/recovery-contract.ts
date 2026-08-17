export const BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE = 32;
export const TURN_RECORD_RECOVERY_EVIDENCE_ERROR_NAME = 'TurnRecordRecoveryEvidenceError';
export const TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE = 'ESTRUCTURAL';
export const TURN_RECORD_RECOVERY_CORRUPT_EVIDENCE_CODE = 'EBADMSG';

export interface TurnRecordRecoveryEvidenceSkip {
  errno: string;
  ownerSessionId: string;
  /** Exact trusted physical channel that owns the selected L0 chain. */
  sourceChannelId?: string;
  /** Exact content-free identity of the physical L0 generation that failed. */
  sourceFingerprint?: string;
  /** Content-free identity of the selected physical archive generation itself. */
  sourceArchiveFingerprint?: string;
  /** Trusted in-process paths used only to re-prove that exact generation before disposition. */
  sourceArchivePaths?: readonly string[];
  /** True when this exact generation already has an fsync-durable terminal disposition. */
  retired?: boolean;
}

export interface CorruptTurnRecordRecoveryEvidenceSkip extends TurnRecordRecoveryEvidenceSkip {
  errno: typeof TURN_RECORD_RECOVERY_CORRUPT_EVIDENCE_CODE;
  sourceChannelId: string;
  sourceFingerprint: string;
  sourceArchiveFingerprint: string;
  sourceArchivePaths: readonly string[];
}

export interface BackgroundWorkHandoffRecoveryDisposition {
  isCorruptOwnerRetired(skip: CorruptTurnRecordRecoveryEvidenceSkip): boolean;
  quarantineCorruptOwner(skip: CorruptTurnRecordRecoveryEvidenceSkip): Promise<void>;
}

export interface TurnRecordRecoveryEvidenceErrorOptions extends ErrorOptions {
  code?: string;
}

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
  readonly code?: string;

  constructor(message: string, options?: TurnRecordRecoveryEvidenceErrorOptions) {
    super(message, options);
    this.name = TURN_RECORD_RECOVERY_EVIDENCE_ERROR_NAME;
    if (options?.code) this.code = options.code;
  }
}

export function isCorruptTurnRecordRecoveryEvidenceSkip(
  skip: TurnRecordRecoveryEvidenceSkip,
): skip is CorruptTurnRecordRecoveryEvidenceSkip {
  return skip.errno === TURN_RECORD_RECOVERY_CORRUPT_EVIDENCE_CODE
    && typeof skip.sourceChannelId === 'string'
    && skip.sourceChannelId.trim().length > 0
    && typeof skip.sourceFingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(skip.sourceFingerprint)
    && typeof skip.sourceArchiveFingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(skip.sourceArchiveFingerprint)
    && Array.isArray(skip.sourceArchivePaths)
    && skip.sourceArchivePaths.length > 0
    && skip.sourceArchivePaths.every(path => typeof path === 'string' && path.length > 0);
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
