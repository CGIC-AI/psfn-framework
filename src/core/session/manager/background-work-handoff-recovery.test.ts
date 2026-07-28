import { describe, expect, it, vi } from 'vitest';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import { createTurnId } from '../../turns/id.js';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  type MemoryExtractionBackgroundPayload,
} from '../../agent/background-work/types.js';
import { BackgroundWorkHandoffRecovery } from './background-work-handoff-recovery.js';
import { projectTurnRecordRecoveryCandidate } from '../../../persistence/sessions/turn-records.js';
import { BackgroundWorkHandoffRetryCapacityError } from '../../agent/background-work/recovery-contract.js';

function makeRecord(index: number): TurnRecord {
  const completedAt = 1_742_000_000_000 + index;
  const turnId = createTurnId(completedAt);
  const record: TurnRecord = {
    schemaVersion: 1,
    turnId,
    requestId: `request-${index}`,
    sessionId: 'session:bounded-recovery',
    channelId: 'api:bounded-recovery',
    channelType: 'api',
    startedAt: completedAt - 1,
    completedAt,
    status: 'completed',
    userMessage: { role: 'user', content: 'source', timestamp: completedAt - 1 },
    assistantMessage: { role: 'assistant', content: 'reply', timestamp: completedAt },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
  };
  const payload: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId: record.sessionId!,
      channelId: record.channelId,
      turnId,
      requestId: record.requestId,
      turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
      createdAtMs: completedAt,
    },
  };
  record.backgroundWorkHandoff = {
    schemaVersion: 1,
    jobs: [{
      ...createBackgroundWorkIdentity({
        logicalSessionId: record.sessionId!,
        turnId,
        kind: payload.kind,
      }),
      logicalSessionId: record.sessionId!,
      kind: payload.kind,
      payload,
      payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
      sourceTurnId: turnId,
      sourceRequestId: record.requestId,
      sourceChannelId: record.channelId,
      createdAtMs: completedAt,
      maxAttempts: 5,
    }],
  };
  return record;
}

describe('BackgroundWorkHandoffRecovery', () => {
  it('forwards cancellation to the durable eligibility fence', async () => {
    const record = makeRecord(0);
    const controller = new AbortController();
    const withFence = vi.fn(async (
      _sourceChannelId: string,
      _logicalSessionId: string,
      _turnId: string,
      operation: () => Promise<boolean>,
      _signal?: AbortSignal,
    ) => operation());
    const recovery = new BackgroundWorkHandoffRecovery({
      findEligibleSourceTurnRecord: async () => record,
      withSourceTurnRecordEligibilityFence: withFence,
    });
    recovery.defer(record);

    await expect(recovery.recover(
      1,
      async () => undefined,
      controller.signal,
    )).resolves.toBe(1);

    expect(withFence).toHaveBeenCalledOnce();
    expect(withFence.mock.calls[0]?.[4]).toBe(controller.signal);
  });

  it('does not enqueue when cancellation lands during the eligibility reread', async () => {
    const record = makeRecord(0);
    const controller = new AbortController();
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let finishLookup!: (value: TurnRecord) => void;
    const lookupResult = new Promise<TurnRecord>((resolve) => {
      finishLookup = resolve;
    });
    const findEligible = vi.fn(async (
      _sourceChannelId: string,
      _logicalSessionId: string,
      _turnId: string,
      _signal?: AbortSignal,
    ) => {
      markLookupStarted();
      return await lookupResult;
    });
    const recovery = new BackgroundWorkHandoffRecovery({
      findEligibleSourceTurnRecord: findEligible,
      withSourceTurnRecordEligibilityFence: async (
        _source,
        _session,
        _turn,
        operation,
      ) => operation(),
    });
    recovery.defer(record);
    const operation = vi.fn(async () => undefined);

    const pending = recovery.recover(1, operation, controller.signal);
    await lookupStarted;
    controller.abort();
    finishLookup(record);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(findEligible.mock.calls[0]?.[3]).toBe(controller.signal);
    expect(operation).not.toHaveBeenCalled();
  });

  it('traverses only the requested batch size when the pending index is large', async () => {
    const records = Array.from({ length: 1_024 }, (_, index) => makeRecord(index));
    const recordsByTurn = new Map(records.map(record => [record.turnId, record]));
    const recovery = new BackgroundWorkHandoffRecovery({
      findEligibleSourceTurnRecord: async (_sourceChannelId, _logicalSessionId, turnId) => (
        recordsByTurn.get(turnId) ?? null
      ),
      withSourceTurnRecordEligibilityFence: async (_source, _session, _turn, operation) => (
        operation()
      ),
    }, records.length);
    for (const record of records) recovery.defer(record);

    type PendingReference = {
      sourceChannelId: string;
      logicalSessionId: string;
      turnId: string;
    };
    const pending = (recovery as unknown as {
      pending: Map<string, PendingReference>;
    }).pending;
    const originalValues = pending.values.bind(pending);
    let traversed = 0;
    pending.values = (function* instrumentedValues() {
      for (const value of originalValues()) {
        traversed += 1;
        yield value;
      }
    }) as typeof pending.values;

    const operation = vi.fn(async () => undefined);
    expect(await recovery.recover(1, operation)).toBe(1);
    expect(traversed).toBe(1);

    traversed = 0;
    expect(await recovery.recover(32, operation)).toBe(32);
    expect(traversed).toBe(32);
    expect(operation).toHaveBeenCalledTimes(33);
  });

  it('fails closed at capacity without dropping durable rows and recovers fairly after an outage', async () => {
    const records = Array.from({ length: 5 }, (_, index) => makeRecord(index));
    const recordsByTurn = new Map(records.map(record => [record.turnId, record]));
    const recovery = new BackgroundWorkHandoffRecovery({
      findSourceTurnRecord: (_sourceChannelId, _logicalSessionId, turnId) => (
        recordsByTurn.get(turnId) ?? null
      ),
      isSourceTurnRecordEligible: () => true,
      withSourceTurnRecordEligibilityFence: async (_source, _session, _turn, operation) => (
        operation()
      ),
    }, 3);

    for (const record of records.slice(0, 3)) recovery.defer(record);
    expect(() => recovery.defer(records[3]!)).toThrow(BackgroundWorkHandoffRetryCapacityError);
    expect(recovery.hasPending()).toBe(true);
    expect(recordsByTurn.size).toBe(5);

    const outage = vi.fn(async () => {
      throw new Error('backing store unavailable');
    });
    await expect(recovery.recover(3, outage)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'backing store unavailable' }),
        expect.objectContaining({ message: 'backing store unavailable' }),
        expect.objectContaining({ message: 'backing store unavailable' }),
      ],
    });
    expect(outage.mock.calls.map(call => call[0].turnId)).toEqual(
      records.slice(0, 3).map(record => record.turnId),
    );
    expect(recovery.hasPending()).toBe(true);
    expect(recordsByTurn.size).toBe(5);

    const accepted: string[] = [];
    expect(await recovery.recover(3, async record => {
      accepted.push(record.turnId);
    })).toBe(3);
    expect(accepted).toEqual(records.slice(0, 3).map(record => record.turnId));
    expect(recovery.hasPending()).toBe(false);
    expect(recordsByTurn.size).toBe(5);
  });

  it('rejects semantic poison before indexing and retires poison discovered during retry', async () => {
    const valid = makeRecord(10);
    const poisonedBeforeIndex = structuredClone(valid);
    poisonedBeforeIndex.backgroundWorkHandoff!.jobs[0]!.payloadFingerprint = '0'.repeat(64);
    const recordsByTurn = new Map([[valid.turnId, valid]]);
    const recovery = new BackgroundWorkHandoffRecovery({
      findSourceTurnRecord: (_sourceChannelId, _logicalSessionId, turnId) => (
        recordsByTurn.get(turnId) ?? null
      ),
      isSourceTurnRecordEligible: () => true,
      withSourceTurnRecordEligibilityFence: async (_source, _session, _turn, operation) => (
        operation()
      ),
    }, 2);

    expect(() => recovery.defer(poisonedBeforeIndex)).toThrow(
      expect.objectContaining({ name: 'TurnRecordRecoveryEvidenceError' }),
    );
    expect(recovery.hasPending()).toBe(false);

    recovery.defer(valid);
    const poisonedOnDisk = structuredClone(valid);
    poisonedOnDisk.backgroundWorkHandoff!.jobs[0]!.payloadFingerprint = 'f'.repeat(64);
    recordsByTurn.set(valid.turnId, poisonedOnDisk);
    const operation = vi.fn(async () => undefined);
    await expect(recovery.recover(1, operation)).rejects.toMatchObject({
      name: 'TurnRecordRecoveryEvidenceError',
    });
    expect(operation).not.toHaveBeenCalled();
    expect(recovery.hasPending()).toBe(false);
    expect(await recovery.recover(1, operation)).toBe(0);
  });

  it('accepts only content-free worker-validated projections and revalidates their surviving bindings', () => {
    const valid = makeRecord(20);
    const projection = projectTurnRecordRecoveryCandidate(valid);
    const recordsByTurn = new Map([[valid.turnId, valid]]);
    const recovery = new BackgroundWorkHandoffRecovery({
      findSourceTurnRecord: (_sourceChannelId, _logicalSessionId, turnId) => (
        recordsByTurn.get(turnId) ?? null
      ),
      isSourceTurnRecordEligible: () => true,
      withSourceTurnRecordEligibilityFence: async (_source, _session, _turn, operation) => (
        operation()
      ),
    }, 2);

    recovery.deferWorkerValidatedProjection(projection);
    expect(recovery.hasPending()).toBe(true);

    const poisoned = projectTurnRecordRecoveryCandidate(makeRecord(21));
    poisoned.backgroundWorkHandoff!.jobs[0]!.payloadFingerprint = '0'.repeat(64);
    expect(() => recovery.deferWorkerValidatedProjection(poisoned)).toThrow(
      expect.objectContaining({ name: 'TurnRecordRecoveryEvidenceError' }),
    );

    expect(() => recovery.deferWorkerValidatedProjection(makeRecord(22))).toThrow(
      expect.objectContaining({
        name: 'TurnRecordRecoveryEvidenceError',
        message: expect.stringContaining('forbidden old-fat content'),
      }),
    );
  });
});
