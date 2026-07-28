import { describe, expect, it, vi } from 'vitest';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  BACKGROUND_WORK_HANDOFF_RECOVERY_BATCH_SIZE,
  BackgroundWorkHandoffRetryCapacityError,
  TurnRecordRecoveryEvidenceError,
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

  it('recognizes nested evidence poison once and never reopens the historical stream', async () => {
    const poison = new TurnRecordRecoveryEvidenceError('invalid source fingerprint');
    const recoveryStream = vi.fn(() => (async function* () {
      throw new AggregateError([new Error('transient peer'), poison]);
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
    expect(recoverPending).toHaveBeenCalledOnce();
  });
});
