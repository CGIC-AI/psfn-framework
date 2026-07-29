import { describe, expect, it, vi } from 'vitest';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE,
  BackgroundWorkHandoffRetryCapacityError,
  TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE,
  TurnRecordRecoveryEvidenceError,
  type TurnRecordRecoveryEvidenceSkip,
} from './recovery-contract.js';
import { BackgroundWorkHandoffRecoveryRuntime } from './handoff-recovery-runtime.js';

describe('BackgroundWorkHandoffRecoveryRuntime', () => {
  it('drains a full retry batch before performing exactly one durable rescan', async () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      status: 'completed',
      channelId: 'api:bounded-startup-retry',
      sessionId: 'api:bounded-startup-retry',
      turnId: `turn-${String(index)}`,
      backgroundWorkHandoff: {
        schemaVersion: 1,
        jobs: [{ jobId: `job-${String(index)}` }],
      },
    })) as unknown as TurnRecord[];
    let outage = true;
    let pending = 0;
    const enumerated: string[] = [];
    const recoveryStream = vi.fn(() => (async function* () {
      for (const record of records) {
        enumerated.push(record.turnId);
        yield record;
      }
    })());
    const sessions = {
      streamRecoverableBackgroundWorkTurnRecords: recoveryStream,
      deferWorkerValidatedBackgroundWorkHandoffRecovery: vi.fn(() => {
        if (pending === BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE) {
          throw new BackgroundWorkHandoffRetryCapacityError(
            BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE,
          );
        }
        pending += 1;
      }),
      recoverPendingBackgroundWorkHandoffs: vi.fn(async () => {
        if (outage) throw new Error('backing store unavailable');
        const recovered = pending;
        pending = 0;
        return recovered;
      }),
    };
    const enqueue = vi.fn(async () => {
      if (outage) throw new Error('backing store unavailable');
    });
    const runtime = new BackgroundWorkHandoffRecoveryRuntime(sessions);

    await expect(runtime.recover(enqueue))
      .rejects.toBeInstanceOf(BackgroundWorkHandoffRetryCapacityError);
    expect(enumerated).toHaveLength(BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE + 1);
    expect(pending).toBe(BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE);
    expect(recoveryStream).toHaveBeenCalledOnce();

    await expect(runtime.recover(enqueue)).rejects.toThrow('backing store unavailable');
    expect(recoveryStream).toHaveBeenCalledOnce();
    expect(enumerated).toHaveLength(BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE + 1);
    expect(pending).toBe(BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE);

    outage = false;
    await expect(runtime.recover(enqueue)).resolves.toBeUndefined();
    expect(recoveryStream).toHaveBeenCalledOnce();
    expect(pending).toBe(0);

    await expect(runtime.recover(enqueue)).resolves.toBeUndefined();
    expect(recoveryStream).toHaveBeenCalledTimes(2);
    expect(enumerated).toHaveLength(
      records.length + BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE + 1,
    );

    await expect(runtime.recover(enqueue)).resolves.toBeUndefined();
    expect(recoveryStream).toHaveBeenCalledTimes(2);
    expect(enumerated).toHaveLength(
      records.length + BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE + 1,
    );
  });

  it('backs off after structural evidence poison and resets after a later clean enumeration', async () => {
    const poison = new TurnRecordRecoveryEvidenceError('invalid source fingerprint', {
      code: TURN_RECORD_RECOVERY_STRUCTURAL_EVIDENCE_CODE,
    });
    let poisoned = true;
    const recoveryStream = vi.fn(() => (async function* () {
      if (poisoned) throw new AggregateError([new Error('transient peer'), poison]);
    })());
    const recoverPending = vi.fn(async () => 0);
    const runtime = new BackgroundWorkHandoffRecoveryRuntime({
      streamRecoverableBackgroundWorkTurnRecords: recoveryStream,
      deferWorkerValidatedBackgroundWorkHandoffRecovery: vi.fn(),
      recoverPendingBackgroundWorkHandoffs: recoverPending,
    });

    await expect(runtime.recover(async () => undefined)).rejects.toMatchObject({
      errors: [expect.any(Error), poison],
    });
    await expect(runtime.recover(async () => undefined)).resolves.toBeUndefined();
    expect(recoveryStream).toHaveBeenCalledOnce();

    poisoned = false;
    await expect(runtime.recover(async () => undefined)).resolves.toBeUndefined();
    await expect(runtime.recover(async () => undefined)).resolves.toBeUndefined();

    expect(recoveryStream).toHaveBeenCalledTimes(2);
    expect(recoverPending).toHaveBeenCalledTimes(3);
  });

  it('retries owner evidence skips until a later full enumeration completes cleanly', async () => {
    const record = {
      status: 'completed',
      channelId: 'api:concurrent-append-owner',
      sessionId: 'api:concurrent-append-owner',
      turnId: 'turn-after-quiet',
      backgroundWorkHandoff: {
        schemaVersion: 1,
        jobs: [{ jobId: 'job-after-quiet' }],
      },
    } as unknown as TurnRecord;
    let scanAttempt = 0;
    const recoveryStream = vi.fn((
      _signal?: AbortSignal,
      onEvidenceOwnerSkipped?: (skip: TurnRecordRecoveryEvidenceSkip) => void,
    ) => (async function* () {
      scanAttempt += 1;
      if (scanAttempt <= 2) {
        onEvidenceOwnerSkipped?.({
          errno: 'ESTALE',
          ownerSessionId: record.sessionId!,
        });
        return;
      }
      yield record;
    })());
    const enqueue = vi.fn(async () => undefined);
    const runtime = new BackgroundWorkHandoffRecoveryRuntime({
      streamRecoverableBackgroundWorkTurnRecords: recoveryStream,
      deferWorkerValidatedBackgroundWorkHandoffRecovery: vi.fn(),
      recoverPendingBackgroundWorkHandoffs: vi.fn(async () => 0),
    });

    await expect(runtime.recover(enqueue)).resolves.toBeUndefined();
    await expect(runtime.recover(enqueue)).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();

    await expect(runtime.recover(enqueue)).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(recoveryStream).toHaveBeenCalledTimes(3);

    await expect(runtime.recover(enqueue)).resolves.toBeUndefined();
    expect(recoveryStream).toHaveBeenCalledTimes(3);
  });

  it.each(['ESTALE', 'EBADMSG'])(
    'does not latch a stream-level %s evidence failure',
    async (code) => {
      const retryableEvidenceError = new TurnRecordRecoveryEvidenceError(
        `retryable evidence failure: ${code}`,
        { code },
      );
      let fail = true;
      const recoveryStream = vi.fn(() => (async function* () {
        if (fail) {
          fail = false;
          throw retryableEvidenceError;
        }
      })());
      const runtime = new BackgroundWorkHandoffRecoveryRuntime({
        streamRecoverableBackgroundWorkTurnRecords: recoveryStream,
        deferWorkerValidatedBackgroundWorkHandoffRecovery: vi.fn(),
        recoverPendingBackgroundWorkHandoffs: vi.fn(async () => 0),
      });

      await expect(runtime.recover(async () => undefined)).rejects.toBe(retryableEvidenceError);
      await expect(runtime.recover(async () => undefined)).resolves.toBeUndefined();
      await expect(runtime.recover(async () => undefined)).resolves.toBeUndefined();

      expect(recoveryStream).toHaveBeenCalledTimes(2);
    },
  );
});
