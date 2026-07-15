import { describe, expect, it, vi } from 'vitest';

import type { LLMProviderPort, MemoryExtractor } from '../contracts.js';
import type { SessionManager } from '../../session/manager.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import { executePostTurnBackgroundWork } from './post-turn-runtime.js';
import {
  BackgroundWorkDeferredError,
  BackgroundWorkPermanentError,
} from './supervisor.js';
import {
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  fingerprintEmotionAppraisalPersonalityProjection,
  type ClaimedBackgroundWorkJob,
  type EmotionAppraisalBackgroundPayload,
  type MemoryExtractionBackgroundPayload,
} from './types.js';

const TURN_ID = '019d2326-d9e1-701d-bcee-250d2cbb0e4e';

function makeTurnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    turnId: TURN_ID,
    requestId: 'request-1',
    sessionId: 'logical-session-1',
    channelId: 'discord:source-channel',
    channelType: 'discord',
    startedAt: 90,
    completedAt: 100,
    status: 'completed',
    userMessage: { role: 'user', content: 'private source text', timestamp: 90 },
    assistantMessage: { role: 'assistant', content: 'private response text', timestamp: 100 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test-model' },
    provenanceRefs: [],
    internalStateSnapshotRef: 'internal-state-v1:test-snapshot',
    ...overrides,
  };
}

function makeExecution(record: TurnRecord): {
  job: ClaimedBackgroundWorkJob;
  payload: MemoryExtractionBackgroundPayload;
  effects: {
    assertOwned: () => Promise<void>;
    run: (
      effectKey: string,
      operation: (assertOwned: () => Promise<void>) => Promise<void>,
    ) => Promise<void>;
  };
} {
  const payload: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId: record.sessionId ?? record.channelId,
      channelId: record.channelId,
      turnId: record.turnId,
      requestId: record.requestId,
      turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
      createdAtMs: record.completedAt,
    },
    canonicalContactId: 'contact-1',
    placeId: 'living-room',
  };
  const assertOwned = vi.fn(async () => undefined);
  return {
    payload,
    effects: {
      assertOwned,
      run: vi.fn(async (_effectKey, operation) => operation(assertOwned)),
    },
    job: {
      jobId: 'background-job-1',
      idempotencyKey: 'background-idempotency-1',
      logicalSessionId: payload.source.logicalSessionId,
      kind: payload.kind,
      payloadSchemaVersion: 1,
      payload,
      payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
      sourceTurnId: record.turnId,
      sourceRequestId: record.requestId,
      sourceChannelId: record.channelId,
      state: 'running',
      reasonCode: 'started',
      attemptCount: 0,
      maxAttempts: 3,
      createdAtMs: record.completedAt,
      availableAtMs: record.completedAt,
      updatedAtMs: record.completedAt,
      leaseOwner: 'worker-1',
      leaseExpiresAtMs: 1_000,
      revision: 2,
    },
  };
}

function makeDependencies(input: {
  record: TurnRecord | null;
  now?: number;
  maybeExtract?: ReturnType<typeof vi.fn>;
  runIntentionPostTurnHooks?: ReturnType<typeof vi.fn>;
  beforeSourceEligibilityFence?: () => void;
}) {
  const findSourceRecordedTurn = vi.fn(() => input.record);
  const isSourceRecordedTurnEligible = vi.fn(() => true);
  const maybeExtract = input.maybeExtract ?? vi.fn(async () => undefined);
  const triggerEmotionAppraisal = vi.fn(async () => undefined);
  const runIntentionPostTurnHooks = input.runIntentionPostTurnHooks
    ?? vi.fn(async () => undefined);
  const withSourceRecordedTurnEligibilityFence = vi.fn(async (
    _sourceChannelId: string,
    _logicalSessionId: string,
    _turnId: string,
    operation: () => Promise<unknown>,
  ) => {
    input.beforeSourceEligibilityFence?.();
    return operation();
  });
  return {
    dependencies: {
      sessionManager: {
        findSourceRecordedTurn,
        isSourceRecordedTurnEligible,
        withSourceRecordedTurnEligibilityFence,
      } as unknown as SessionManager,
      llmProvider: {} as LLMProviderPort,
      getMemoryExtractor: () => ({ maybeExtract } as unknown as MemoryExtractor),
      runIntentionPostTurnHooks,
      emotionRuntime: { triggerEmotionAppraisal },
      getEmotionTemplateVariables: () => ({ personality: 'current canonical personality' }),
      now: () => input.now ?? 100,
    },
    findSourceRecordedTurn,
    isSourceRecordedTurnEligible,
    withSourceRecordedTurnEligibilityFence,
    maybeExtract,
    runIntentionPostTurnHooks,
    triggerEmotionAppraisal,
  };
}

describe('executePostTurnBackgroundWork', () => {
  it('rehydrates an exact physical-source/logical-session turn without copying content into the job', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({ record });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.findSourceRecordedTurn).toHaveBeenCalledWith(
      record.channelId,
      record.sessionId,
      record.turnId,
    );
    expect(fixture.maybeExtract).toHaveBeenCalledWith(
      record.sessionId,
      'contact-1',
      record.turnId,
      'living-room',
      undefined,
      expect.any(Function),
    );
    expect(JSON.stringify(execution.payload)).not.toContain(record.userMessage.content);
    expect(JSON.stringify(execution.payload)).not.toContain(record.assistantMessage?.content);
  });

  it('defers a briefly missing canonical record instead of consuming an attempt', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({ record: null, now: record.completedAt + 59_999 });

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
        name: 'BackgroundWorkDeferredError',
        reasonCode: 'source_not_ready',
      }));
  });

  it('fails permanently rather than stale-discarding missing or mismatched canonical work', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const missing = makeDependencies({ record: null, now: record.completedAt + 60_000 });
    await expect(executePostTurnBackgroundWork(execution, missing.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkPermanentError>>({
        name: 'BackgroundWorkPermanentError',
        reasonCode: 'source_missing',
      }));

    const mismatch = makeDependencies({
      record: makeTurnRecord({ assistantMessage: {
        role: 'assistant',
        content: 'tampered response',
        timestamp: 100,
      } }),
      now: record.completedAt + 60_000,
    });
    await expect(executePostTurnBackgroundWork(execution, mismatch.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkPermanentError>>({
        name: 'BackgroundWorkPermanentError',
      reasonCode: 'source_mismatch',
    }));
  });

  it('runs emotion appraisal from a hash-bound aggregate projection', async () => {
    const record = makeTurnRecord();
    const base = makeExecution(record);
    const payload: EmotionAppraisalBackgroundPayload = {
      schemaVersion: 1,
      kind: 'emotion_appraisal',
      source: base.payload.source,
      emotionSessionId: record.sessionId!,
      internalStateSnapshotRef: record.internalStateSnapshotRef!,
      appraisalState: {
        schemaVersion: 1,
        emotional: {
          vad: { valence: 0.2, arousal: 0.3, dominance: 0.4 },
          mood: { valence: 0.1, arousal: 0.2, dominance: 0.3 },
          discreteEmotions: { joy: 0.7 },
          confidence: 0.8,
          telemetry: { status: 'trusted', source: 'runtime_state', reasons: [], weight: 1 },
        },
        cognitive: { certaintyLevel: 0.6, topicEngagement: 0.7, processingQuality: 'fluent' },
        attention: {
          activeConcernCount: 2,
          salientEntityCount: 1,
          conversationTrajectory: 'deepening',
        },
        relational: { contactId: 'contact-1', trustLevel: 'regular', moodDrift: 0.1 },
      },
      personalityOwnerRef: 'character-card',
      personalityProjectionHash: fingerprintEmotionAppraisalPersonalityProjection({
        personality: 'old queued personality',
      }),
    };
    const execution = {
      payload,
      effects: base.effects,
      job: {
        ...base.job,
        kind: payload.kind,
        payload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
      },
    };
    const fixture = makeDependencies({ record });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.triggerEmotionAppraisal).toHaveBeenCalledWith(expect.objectContaining({
      sessionChannelId: record.sessionId,
      turnId: record.turnId,
      appraisalState: payload.appraisalState,
      templateVariables: { personality: 'current canonical personality' },
    }));
    expect(fixture.triggerEmotionAppraisal.mock.calls[0]?.[0]).not.toHaveProperty('internalState');

    const mismatchedPayload = {
      ...payload,
      internalStateSnapshotRef: 'internal-state-v1:wrong',
    } satisfies EmotionAppraisalBackgroundPayload;
    await expect(executePostTurnBackgroundWork({
      payload: mismatchedPayload,
      effects: execution.effects,
      job: {
        ...execution.job,
        payload: mismatchedPayload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(mismatchedPayload),
      },
    }, fixture.dependencies)).rejects.toEqual(
      expect.objectContaining<Partial<BackgroundWorkPermanentError>>({
        name: 'BackgroundWorkPermanentError',
        reasonCode: 'source_mismatch',
      }),
    );
  });

  it('checks the source tombstone/uniqueness gate before reading raw turn content', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({ record });
    fixture.isSourceRecordedTurnEligible.mockReturnValue(false);

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkPermanentError>>({
        name: 'BackgroundWorkPermanentError',
        reasonCode: 'source_missing',
      }));

    expect(fixture.findSourceRecordedTurn).not.toHaveBeenCalled();
    expect(fixture.maybeExtract).not.toHaveBeenCalled();
  });

  it('does not let a source revoked after rehydration reach an intention effect', async () => {
    const record = makeTurnRecord();
    const base = makeExecution(record);
    const payload = {
      schemaVersion: 1,
      kind: 'intention_post_turn_hooks',
      source: base.payload.source,
    } as const;
    const execution = {
      payload,
      effects: base.effects,
      job: {
        ...base.job,
        kind: payload.kind,
        payload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
      },
    };
    const persistedResponses: string[] = [];
    const fixture = makeDependencies({
      record,
      runIntentionPostTurnHooks: vi.fn(async (context) => {
        persistedResponses.push(context.response.content);
      }),
      beforeSourceEligibilityFence: () => {
        fixture.isSourceRecordedTurnEligible.mockReturnValue(false);
      },
    });

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkPermanentError>>({
        name: 'BackgroundWorkPermanentError',
        reasonCode: 'source_missing',
      }));

    expect(persistedResponses).toEqual([]);
    expect(fixture.runIntentionPostTurnHooks).not.toHaveBeenCalled();
  });
});
