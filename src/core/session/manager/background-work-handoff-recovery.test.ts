import { describe, expect, it, vi } from 'vitest';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import { createTurnId } from '../../turns/id.js';
import { BackgroundWorkHandoffRecovery } from './background-work-handoff-recovery.js';

function makeRecord(index: number): TurnRecord {
  const completedAt = 1_742_000_000_000 + index;
  const turnId = createTurnId(completedAt);
  return {
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
    backgroundWorkHandoff: { schemaVersion: 1, jobs: [] },
  };
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
    });
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
});
