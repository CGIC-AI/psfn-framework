import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { LLMProviderPort, MemoryExtractor } from '../contracts.js';
import { SessionManager } from '../../session/manager.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { SessionEntry } from '../../session/types.js';
import { buildSessionMetadataWithIcpCorrelation } from '../../session/icp-correlation-metadata.js';
import {
  CHANNEL as ICP_CHANNEL,
  SOURCE as ICP_SOURCE,
  correlation as icpCorrelation,
  recoveryResponse as icpRecoveryResponse,
} from '../../session/icp-recovery.test-fixtures.js';
import { buildSessionMetadataWithTurn } from '../../session/turn-provenance.js';
import { executePostTurnBackgroundWork } from './post-turn-runtime.js';
import {
  BackgroundWorkDeferredError,
  BackgroundWorkPermanentError,
} from './supervisor.js';
import {
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  fingerprintEmotionAppraisalPersonalityProjection,
  type AutoCompactionBackgroundPayload,
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
      userSessionEntryId: 1,
      assistantSessionEntryId: 2,
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
  recentEntries?: SessionEntry[];
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
  const getRecentMessagesAtOrBefore = vi.fn(() => input.recentEntries ?? []);
  const withStableRecordedTurnEligibilitySnapshot = vi.fn(async (
    _logicalSessionId: string,
    _requiredTurnIds: readonly string[],
    readSnapshot: () => SessionEntry[],
    operation: (entries: readonly SessionEntry[]) => Promise<unknown>,
  ) => operation(readSnapshot()));
  const captureAutoCompactionRecentEntries = vi.fn(() => input.recentEntries ?? []);
  const scheduleAutoCompactionBetweenTurns = vi.fn(async () => undefined);
  return {
    dependencies: {
      sessionManager: {
        findSourceRecordedTurn,
        isSourceRecordedTurnEligible,
        withSourceRecordedTurnEligibilityFence,
        getRecentMessagesAtOrBefore,
        withStableRecordedTurnEligibilitySnapshot,
        captureAutoCompactionRecentEntries,
        scheduleAutoCompactionBetweenTurns,
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
    getRecentMessagesAtOrBefore,
    withStableRecordedTurnEligibilitySnapshot,
    captureAutoCompactionRecentEntries,
    scheduleAutoCompactionBetweenTurns,
    maybeExtract,
    runIntentionPostTurnHooks,
    triggerEmotionAppraisal,
  };
}

describe('executePostTurnBackgroundWork', () => {
  it('runs memory extraction from the exact rechecked cross-turn snapshot', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const olderTurnId = '019d2326-d9e1-701d-bcee-250d2cbb0e4f';
    const recentEntries: SessionEntry[] = [
      {
        id: 1,
        channelId: record.sessionId!,
        role: 'user',
        content: 'older turn content',
        timestamp: 80,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: olderTurnId,
          requestId: 'request-older',
          role: 'user',
          actorKind: 'human',
        }),
      },
      {
        id: 2,
        channelId: record.sessionId!,
        role: 'assistant',
        content: record.assistantMessage!.content,
        timestamp: record.completedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
          role: 'assistant',
          actorKind: 'machine_intelligence',
        }),
      },
    ];
    const fixture = makeDependencies({ record, recentEntries });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.getRecentMessagesAtOrBefore).toHaveBeenCalledWith(
      record.sessionId,
      2,
      10,
    );
    expect(fixture.withStableRecordedTurnEligibilitySnapshot).toHaveBeenCalledWith(
      record.sessionId,
      [record.turnId],
      expect.any(Function),
      expect.any(Function),
    );
    expect(fixture.maybeExtract).toHaveBeenCalledWith(
      record.sessionId,
      'contact-1',
      record.turnId,
      'living-room',
      undefined,
      expect.any(Function),
      recentEntries,
    );
  });

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
      [],
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
    const appraisalEntry: SessionEntry = {
      id: 2,
      channelId: record.sessionId!,
      role: 'assistant',
      content: record.assistantMessage!.content,
      timestamp: record.completedAt,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId: record.turnId,
        requestId: record.requestId,
        role: 'assistant',
        actorKind: 'machine_intelligence',
      }),
    };
    const recentEntries: SessionEntry[] = [{
      id: 1,
      channelId: record.sessionId!,
      role: 'system',
      content: '[Intention Appraisal] internal artifact',
      timestamp: 99,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e50',
        requestId: 'request-artifact',
        role: 'system',
        actorKind: 'system',
      }),
    }, appraisalEntry];
    const fixture = makeDependencies({ record, recentEntries });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.triggerEmotionAppraisal).toHaveBeenCalledWith(expect.objectContaining({
      sessionChannelId: record.sessionId,
      turnId: record.turnId,
      appraisalState: payload.appraisalState,
      templateVariables: { personality: 'current canonical personality' },
      recentEntries: [appraisalEntry],
    }));
    expect(fixture.withStableRecordedTurnEligibilitySnapshot).toHaveBeenCalledWith(
      record.sessionId,
      [record.turnId],
      expect.any(Function),
      expect.any(Function),
    );
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

  it('runs auto-compaction from the exact bounded source-turn snapshot', async () => {
    const record = makeTurnRecord();
    const base = makeExecution(record);
    const payload: AutoCompactionBackgroundPayload = {
      schemaVersion: 1,
      kind: 'auto_compaction',
      source: base.payload.source,
      systemPromptTokenCount: 12,
      memoriesTokenCount: 4,
      adaptiveProfile: {
        enabled: false,
        source: 'disabled',
        category: 'default',
        sessionHistoryBudgetPct: 6,
        memoryRetrievalBudgetPct: 2,
      },
      turnBudgetCharacteristics: {},
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
    const recentEntries: SessionEntry[] = [{
      id: 2,
      channelId: record.sessionId!,
      role: 'assistant',
      content: record.assistantMessage!.content,
      timestamp: record.completedAt,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId: record.turnId,
        requestId: record.requestId,
        role: 'assistant',
        actorKind: 'machine_intelligence',
      }),
    }];
    const fixture = makeDependencies({ record, recentEntries });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.captureAutoCompactionRecentEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: record.sessionId,
        maxSessionEntryId: 2,
      }),
    );
    expect(fixture.withStableRecordedTurnEligibilitySnapshot).toHaveBeenCalledWith(
      record.sessionId,
      [record.turnId],
      expect.any(Function),
      expect.any(Function),
    );
    expect(fixture.scheduleAutoCompactionBetweenTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: record.sessionId,
        capturedRecentEntries: recentEntries,
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
    expect(fixture.withSourceRecordedTurnEligibilityFence).toHaveBeenCalledWith(
      record.channelId,
      record.sessionId,
      record.turnId,
      expect.any(Function),
    );
    expect(fixture.withStableRecordedTurnEligibilitySnapshot).not.toHaveBeenCalled();
    expect(fixture.getRecentMessagesAtOrBefore).not.toHaveBeenCalled();
  });

  it('keeps failed ICP output out of real bounded memory, emotion, and compaction effects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-post-turn-icp-projection-'));
    const store = new SessionStore(join(root, 'sessions'), {
      turnRecordEligibilityFence: {
        withTurnRecordEligibilityFence: async (_key, operation) => operation(),
        withTurnRecordEligibilityFences: async (_keys, operation) => operation(),
      },
    });
    const config = {
      dataDir: root,
      companionDataDir: root,
      sessionMessageLimit: 30,
      memoryRetrievalLimit: 15,
      extractionInterval: 5,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 512,
      extractionThresholdPct: 30,
      compactionThresholdPct: 1,
      modelRoster: {
        chat: { provider: 'test', model: 'test', contextWindow: 512, maxTokens: 128 },
      },
    } as SubstrateConfig;
    const sessionManager = new SessionManager(store, config);
    const failedContent = 'FAILED ICP A PRIVATE OUTPUT MUST NEVER ENTER A DURABLE EFFECT';
    const successfulContext = Array.from(
      { length: 4 },
      (_, index) => `successful B bounded context ${index} ${'C'.repeat(160)}`,
    );
    const successfulInput = `successful B input ${'U'.repeat(640)}`;
    const successfulOutput = `successful B output ${'A'.repeat(640)}`;
    const failedRecord = makeTurnRecord({
      turnId: icpCorrelation.turnId,
      requestId: ICP_SOURCE,
      sessionId: ICP_CHANNEL,
      channelId: ICP_CHANNEL,
      completedAt: 80,
      assistantMessage: { role: 'assistant', content: failedContent, timestamp: 80 },
    });
    const successfulRecord = makeTurnRecord({
      sessionId: ICP_CHANNEL,
      channelId: ICP_CHANNEL,
      requestId: 'request-successful-b',
      userMessage: { role: 'user', content: successfulInput, timestamp: 90 },
      assistantMessage: { role: 'assistant', content: successfulOutput, timestamp: 100 },
    });

    try {
      const failedEntryId = sessionManager.recordAssistantMessage(
        ICP_CHANNEL,
        failedContent,
        'contact-peer',
        true,
        'contact-peer',
        {
          turnId: failedRecord.turnId,
          requestId: ICP_SOURCE,
          sourceMessageId: ICP_SOURCE,
          metadata: buildSessionMetadataWithIcpCorrelation(
            undefined,
            icpCorrelation,
            { deliveryStatus: 'pending', recoveryResponse: icpRecoveryResponse },
          ),
        },
      );
      expect(failedEntryId).not.toBeNull();
      sessionManager.recordIcpDeliveryObservation({
        channelId: ICP_CHANNEL,
        sourceMessageId: ICP_SOURCE,
        status: 'failed',
        error: 'peer unavailable',
        recoveryResponse: icpRecoveryResponse,
      });
      for (const content of successfulContext) {
        sessionManager.recordUserMessage(
          ICP_CHANNEL,
          content,
          'human-b',
          'Human B',
          true,
          undefined,
          {
            turnId: successfulRecord.turnId,
            requestId: successfulRecord.requestId,
          },
        );
      }
      const userEntryId = sessionManager.recordUserMessage(
        ICP_CHANNEL,
        successfulInput,
        'human-b',
        'Human B',
        true,
        undefined,
        {
          turnId: successfulRecord.turnId,
          requestId: successfulRecord.requestId,
        },
      );
      const assistantEntryId = sessionManager.recordAssistantMessage(
        ICP_CHANNEL,
        successfulOutput,
        undefined,
        true,
        undefined,
        {
          turnId: successfulRecord.turnId,
          requestId: successfulRecord.requestId,
        },
      );
      expect(userEntryId).not.toBeNull();
      expect(assistantEntryId).not.toBeNull();
      await sessionManager.recordTurn(failedRecord);
      await sessionManager.recordTurn(successfulRecord);

      const base = makeExecution(successfulRecord);
      const source = {
        ...base.payload.source,
        logicalSessionId: ICP_CHANNEL,
        channelId: ICP_CHANNEL,
        requestId: successfulRecord.requestId,
        turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(successfulRecord),
        userSessionEntryId: userEntryId!,
        assistantSessionEntryId: assistantEntryId!,
      };
      const memoryPayload: MemoryExtractionBackgroundPayload = {
        ...base.payload,
        source,
      };
      const effects = base.effects;
      const makeJob = (
        payload: MemoryExtractionBackgroundPayload
          | EmotionAppraisalBackgroundPayload
          | AutoCompactionBackgroundPayload,
      ): ClaimedBackgroundWorkJob => ({
        ...base.job,
        jobId: `job-${payload.kind}`,
        idempotencyKey: `idempotency-${payload.kind}`,
        logicalSessionId: ICP_CHANNEL,
        kind: payload.kind,
        payload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
        sourceRequestId: successfulRecord.requestId,
        sourceChannelId: ICP_CHANNEL,
      });
      const maybeExtract = vi.fn(async () => undefined);
      const triggerEmotionAppraisal = vi.fn(async () => undefined);
      const complete = vi.fn<LLMProviderPort['complete']>().mockImplementation(async (context) => ({
        content: JSON.stringify(context),
        model: 'test',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [],
        stopReason: 'end_turn',
      }));
      const dependencies = {
        sessionManager,
        llmProvider: { stream: vi.fn(), complete } as LLMProviderPort,
        getMemoryExtractor: () => ({ maybeExtract } as unknown as MemoryExtractor),
        runIntentionPostTurnHooks: vi.fn(async () => undefined),
        emotionRuntime: { triggerEmotionAppraisal },
        getEmotionTemplateVariables: () => ({ personality: 'canonical personality' }),
      };

      await executePostTurnBackgroundWork({
        payload: memoryPayload,
        effects,
        job: makeJob(memoryPayload),
      }, dependencies);
      const memoryEntries = maybeExtract.mock.calls[0]?.at(-1) as SessionEntry[];

      const emotionPayload: EmotionAppraisalBackgroundPayload = {
        schemaVersion: 1,
        kind: 'emotion_appraisal',
        source,
        emotionSessionId: ICP_CHANNEL,
        internalStateSnapshotRef: successfulRecord.internalStateSnapshotRef!,
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
            activeConcernCount: 0,
            salientEntityCount: 0,
            conversationTrajectory: 'stable',
          },
          relational: { contactId: 'contact-peer', trustLevel: 'regular', moodDrift: 0 },
        },
        personalityOwnerRef: 'character-card',
        personalityProjectionHash: fingerprintEmotionAppraisalPersonalityProjection({
          personality: 'queued personality',
        }),
      };
      await executePostTurnBackgroundWork({
        payload: emotionPayload,
        effects,
        job: makeJob(emotionPayload),
      }, dependencies);
      const emotionEntries = triggerEmotionAppraisal.mock.calls[0]?.[0].recentEntries;

      const compactionPayload: AutoCompactionBackgroundPayload = {
        schemaVersion: 1,
        kind: 'auto_compaction',
        source,
        systemPromptTokenCount: 0,
        memoriesTokenCount: 0,
        adaptiveProfile: {
          enabled: false,
          source: 'disabled',
          category: 'default',
          sessionHistoryBudgetPct: 100,
          memoryRetrievalBudgetPct: 2,
        },
        turnBudgetCharacteristics: {},
      };
      await executePostTurnBackgroundWork({
        payload: compactionPayload,
        effects,
        job: makeJob(compactionPayload),
      }, dependencies);

      for (const entries of [memoryEntries, emotionEntries]) {
        expect(entries.map(entry => entry.content)).toEqual([
          ...successfulContext,
          successfulInput,
          successfulOutput,
        ]);
        expect(JSON.stringify(entries)).not.toContain(failedContent);
      }
      expect(complete).toHaveBeenCalled();
      expect(JSON.stringify(complete.mock.calls)).not.toContain(failedContent);
      const summaries = store.getCompactionSummaries(ICP_CHANNEL);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.summary).toContain('successful B');
      expect(summaries[0]?.summary).not.toContain(failedContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
