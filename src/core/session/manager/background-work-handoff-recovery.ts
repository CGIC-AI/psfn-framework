import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';

interface PendingBackgroundWorkHandoffReference {
  sourceChannelId: string;
  logicalSessionId: string;
  turnId: string;
}

type BackgroundWorkHandoffRecoveryStore = Pick<
  SessionStore,
  | 'findSourceTurnRecord'
  | 'isSourceTurnRecordEligible'
  | 'withSourceTurnRecordEligibilityFence'
>;

/**
 * Process-local retry index for TurnRecords that became durable before their
 * PostgreSQL batch enqueue failed. The index retains source identifiers only;
 * recovery always re-reads the canonical record under its eligibility fence.
 */
export class BackgroundWorkHandoffRecovery {
  private pending = new Map<string, PendingBackgroundWorkHandoffReference>();

  constructor(private readonly store: BackgroundWorkHandoffRecoveryStore) {}

  defer(record: TurnRecord): void {
    if (record.status !== 'completed' || !record.backgroundWorkHandoff) {
      throw new Error('Only completed TurnRecords with background work can be deferred for recovery');
    }
    const reference = {
      sourceChannelId: record.channelId,
      logicalSessionId: record.sessionId ?? record.channelId,
      turnId: record.turnId,
    } satisfies PendingBackgroundWorkHandoffReference;
    this.pending.set(referenceKey(reference), reference);
  }

  /**
   * Drain at most `limit` failed handoffs. Invalid sources are retired without
   * enqueue; failed operations remain indexed and rotate behind other pending
   * work so one poison record cannot starve the queue.
   */
  async recover(
    limit: number,
    operation: (record: TurnRecord) => Promise<void>,
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
      const key = referenceKey(reference);
      try {
        const accepted = await this.store.withSourceTurnRecordEligibilityFence(
          reference.sourceChannelId,
          reference.logicalSessionId,
          reference.turnId,
          async () => {
            if (!this.pending.has(key)) return false;
            const current = this.store.findSourceTurnRecord(
              reference.sourceChannelId,
              reference.logicalSessionId,
              reference.turnId,
            );
            if (current?.status !== 'completed'
              || !current.backgroundWorkHandoff
              || !this.store.isSourceTurnRecordEligible(
                reference.sourceChannelId,
                reference.logicalSessionId,
                reference.turnId,
              )) {
              this.pending.delete(key);
              return false;
            }
            await operation(current);
            this.pending.delete(key);
            return true;
          },
        );
        if (accepted) recovered += 1;
      } catch (error) {
        errors.push(error);
        if (this.pending.delete(key)) this.pending.set(key, reference);
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
