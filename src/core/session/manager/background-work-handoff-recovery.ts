import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import {
  parseTurnRecordBackgroundWorkHandoff,
  parseWorkerValidatedTurnRecordBackgroundWorkHandoffProjection,
} from '../../agent/background-work/types.js';
import {
  BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE,
  BackgroundWorkHandoffRetryCapacityError,
  TurnRecordRecoveryEvidenceError,
  isTurnRecordRecoveryEvidenceError,
} from '../../agent/background-work/recovery-contract.js';

interface PendingBackgroundWorkHandoffReference {
  sourceChannelId: string;
  logicalSessionId: string;
  turnId: string;
}

type BackgroundWorkHandoffRecoveryStore = Pick<
  SessionStore,
  | 'findEligibleSourceTurnRecord'
  | 'withSourceTurnRecordEligibilityFence'
>;

/**
 * Process-local retry index for TurnRecords that became durable before their
 * PostgreSQL batch enqueue failed. The index retains source identifiers only;
 * recovery always re-reads the canonical record under its eligibility fence.
 */
export class BackgroundWorkHandoffRecovery {
  private pending = new Map<string, PendingBackgroundWorkHandoffReference>();

  constructor(
    private readonly store: BackgroundWorkHandoffRecoveryStore,
    private readonly capacity = BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Background work handoff retry capacity must be a positive safe integer');
    }
  }

  defer(record: TurnRecord): void {
    assertValidRecoveryHandoff(record, parseTurnRecordBackgroundWorkHandoff);
    this.indexReference(record);
  }

  /**
   * Index the content-free projection emitted only after the isolated startup
   * worker validated its full source row. The projection parser re-proves all
   * bindings that survive IPC without trying to hash content that was
   * deliberately stripped before transfer.
   */
  deferWorkerValidatedProjection(record: TurnRecord): void {
    assertContentFreeRecoveryProjection(record);
    assertValidRecoveryHandoff(
      record,
      parseWorkerValidatedTurnRecordBackgroundWorkHandoffProjection,
    );
    this.indexReference(record);
  }

  private indexReference(record: TurnRecord): void {
    const reference = {
      sourceChannelId: record.channelId,
      logicalSessionId: record.sessionId ?? record.channelId,
      turnId: record.turnId,
    } satisfies PendingBackgroundWorkHandoffReference;
    const key = referenceKey(reference);
    if (this.pending.has(key)) return;
    if (this.pending.size >= this.capacity) {
      throw new BackgroundWorkHandoffRetryCapacityError(this.capacity);
    }
    this.pending.set(key, reference);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Drain at most `limit` failed handoffs. Invalid sources are retired without
   * enqueue; failed operations remain indexed and rotate behind other pending
   * work so one poison record cannot starve the queue.
   */
  async recover(
    limit: number,
    operation: (record: TurnRecord) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Background work handoff recovery limit must be a positive safe integer');
    }
    const selected: PendingBackgroundWorkHandoffReference[] = [];
    const pending = this.pending.values();
    while (selected.length < limit) {
      const next = pending.next();
      if (next.done) break;
      selected.push(next.value);
    }
    let recovered = 0;
    const errors: unknown[] = [];
    for (const reference of selected) {
      signal?.throwIfAborted();
      const key = referenceKey(reference);
      try {
        const accepted = await this.store.withSourceTurnRecordEligibilityFence(
          reference.sourceChannelId,
          reference.logicalSessionId,
          reference.turnId,
          async () => {
            if (!this.pending.has(key)) return false;
            const current = await this.store.findEligibleSourceTurnRecord(
              reference.sourceChannelId,
              reference.logicalSessionId,
              reference.turnId,
              signal,
            );
            signal?.throwIfAborted();
            if (current?.status !== 'completed'
              || !current.backgroundWorkHandoff) {
              this.pending.delete(key);
              return false;
            }
            try {
              assertValidRecoveryHandoff(current, parseTurnRecordBackgroundWorkHandoff);
            } catch (error) {
              this.pending.delete(key);
              throw error;
            }
            await operation(current);
            this.pending.delete(key);
            return true;
          },
          signal,
        );
        if (accepted) recovered += 1;
      } catch (error) {
        errors.push(error);
        if (!isTurnRecordRecoveryEvidenceError(error) && this.pending.delete(key)) {
          this.pending.set(key, reference);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Multiple background work handoff recovery attempts failed');
    }
    return recovered;
  }
}

function referenceKey(reference: PendingBackgroundWorkHandoffReference): string {
  return `${reference.sourceChannelId}\u0000${reference.logicalSessionId}\u0000${reference.turnId}`;
}

function assertValidRecoveryHandoff(
  record: TurnRecord,
  parse: (candidate: TurnRecord) => unknown,
): void {
  if (record.status !== 'completed' || !record.backgroundWorkHandoff) {
    throw recoveryEvidenceError(
      'Only completed TurnRecords with background work can be deferred for recovery',
    );
  }
  try {
    parse(record);
  } catch (error) {
    throw recoveryEvidenceError(
      `TurnRecord background work handoff is not safe to index for retry: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

function assertContentFreeRecoveryProjection(record: TurnRecord): void {
  if (record.userMessage.content !== ''
    || record.assistantMessage !== undefined
    || record.toolCalls.length !== 0
    || record.extractedMemoryIds.length !== 0
    || record.concernDeltaRefs.length !== 0
    || record.contactDeltaRefs.length !== 0
    || record.provenanceRefs.length !== 0) {
    throw recoveryEvidenceError(
      'Worker-validated TurnRecord recovery projection contains forbidden old-fat content',
    );
  }
}

function recoveryEvidenceError(message: string, cause?: unknown): Error {
  return new TurnRecordRecoveryEvidenceError(
    message,
    cause === undefined ? undefined : { cause },
  );
}
