import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  parseTurnRecordBackgroundWorkHandoff,
  type EnqueueBackgroundWorkInput,
} from './types.js';
import {
  BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE,
  BackgroundWorkHandoffRetryCapacityError,
  TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE,
  TurnRecordRecoveryEvidenceError,
  isTurnRecordRecoveryEvidenceError,
  type TurnRecordRecoveryEvidenceSkip,
} from './recovery-contract.js';
import { recoverHistoricalBackgroundWorkHandoffs } from './tick-runtime.js';

export interface BackgroundWorkHandoffRecoverySessionPort {
  streamRecoverableBackgroundWorkTurnRecords(
    signal?: AbortSignal,
    onEvidenceOwnerSkipped?: (skip: TurnRecordRecoveryEvidenceSkip) => void,
  ): AsyncIterable<TurnRecord>;
  deferWorkerValidatedBackgroundWorkHandoffRecovery(record: TurnRecord): void;
  recoverPendingBackgroundWorkHandoffs(
    limit: number,
    operation: (record: TurnRecord) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<number>;
}

export type BackgroundWorkHandoffEnqueue = (
  jobs: readonly EnqueueBackgroundWorkInput[],
) => Promise<void>;

/**
 * Owns the complete startup handoff recovery state machine so SubstrateAgent
 * remains a wiring shell: snapshot-once state, bounded-capacity latch,
 * deterministic evidence latch, concurrent tick deduplication, and abort.
 */
export class BackgroundWorkHandoffRecoveryRuntime {
  private historicalSnapshotRecovered = false;
  private capacityBlocked = false;
  private evidenceBlocked = false;
  private activeRecovery: Promise<void> | null = null;
  private activeAbortController: AbortController | null = null;
  private abortRequested = false;

  constructor(private readonly sessions: BackgroundWorkHandoffRecoverySessionPort) {}

  async recover(enqueue: BackgroundWorkHandoffEnqueue): Promise<void> {
    if (this.abortRequested) {
      throw new DOMException('Background work handoff recovery was aborted', 'AbortError');
    }
    if (!this.activeRecovery) {
      const abortController = new AbortController();
      this.activeAbortController = abortController;
      this.activeRecovery = this.run(enqueue, abortController.signal)
        .catch((error: unknown) => {
          if (error instanceof BackgroundWorkHandoffRetryCapacityError) {
            this.capacityBlocked = true;
          }
          throw error;
        })
        .finally(() => {
          this.activeRecovery = null;
          if (this.activeAbortController === abortController) {
            this.activeAbortController = null;
          }
        });
    }
    await this.activeRecovery;
  }

  abort(): void {
    this.abortRequested = true;
    this.activeAbortController?.abort();
  }

  private async run(
    enqueue: BackgroundWorkHandoffEnqueue,
    signal: AbortSignal,
  ): Promise<void> {
    const recoverPending = async (): Promise<void> => {
      await this.sessions.recoverPendingBackgroundWorkHandoffs(
        BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE,
        async (record) => {
          const jobs = parseTurnRecordBackgroundWorkHandoff(record);
          if (jobs.length > 0) await enqueue(jobs);
        },
        signal,
      );
    };
    if (this.capacityBlocked) {
      await recoverPending();
      // The pending index cannot exceed this same batch size. A successful
      // drain therefore makes one later durable rescan safe; a failed drain
      // throws and leaves the latch in place.
      this.capacityBlocked = false;
      return;
    }
    if (this.evidenceBlocked) {
      await recoverPending();
      // Structural stream poison gets one quiet tick before a later full
      // enumeration can prove the source clean and reset the latch.
      this.evidenceBlocked = false;
      return;
    }
    if (!this.historicalSnapshotRecovered) {
      const enumerationState = { complete: false, evidenceOwnerSkipped: false };
      const records = this.sessions.streamRecoverableBackgroundWorkTurnRecords(
        signal,
        () => { enumerationState.evidenceOwnerSkipped = true; },
      );
      const completionTrackedRecords = (async function* () {
        for await (const record of records) yield record;
        enumerationState.complete = true;
      })();
      try {
        await recoverHistoricalBackgroundWorkHandoffs(
          completionTrackedRecords,
          async (record) => {
            const jobs = workerValidatedRecoveryJobs(record);
            if (jobs.length > 0) await enqueue(jobs);
          },
          record => this.sessions.deferWorkerValidatedBackgroundWorkHandoffRecovery(record),
        );
      } catch (error) {
        if (isDeterministicRecoveryEvidenceError(error)) {
          this.evidenceBlocked = true;
        }
        throw error;
      } finally {
        // A complete snapshot need not be enumerated again. Capacity and stream
        // failures leave this false so the explicit latches govern one rescan.
        if (enumerationState.complete && !enumerationState.evidenceOwnerSkipped) {
          this.historicalSnapshotRecovered = true;
          this.evidenceBlocked = false;
        }
      }
    }
    await recoverPending();
  }
}

function workerValidatedRecoveryJobs(record: TurnRecord): EnqueueBackgroundWorkInput[] {
  if (record.status !== 'completed' || !record.backgroundWorkHandoff) {
    throw new TurnRecordRecoveryEvidenceError(
      'Recovery worker returned a record without a completed handoff',
      { code: TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE },
    );
  }
  // The recovery worker validates identity, payload, payload fingerprint, and
  // source-turn fingerprint before it removes old-fat content for IPC.
  return record.backgroundWorkHandoff.jobs as EnqueueBackgroundWorkInput[];
}

function isDeterministicRecoveryEvidenceError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some(candidate => isDeterministicRecoveryEvidenceError(candidate));
  }
  if (!isTurnRecordRecoveryEvidenceError(error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE;
}
