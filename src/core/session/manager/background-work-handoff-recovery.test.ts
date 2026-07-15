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
  it('traverses only the requested batch size when the pending index is large', async () => {
    const records = Array.from({ length: 1_024 }, (_, index) => makeRecord(index));
    const recordsByTurn = new Map(records.map(record => [record.turnId, record]));
    const recovery = new BackgroundWorkHandoffRecovery({
      findSourceTurnRecord: (_sourceChannelId, _logicalSessionId, turnId) => (
        recordsByTurn.get(turnId) ?? null
      ),
      isSourceTurnRecordEligible: () => true,
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
