import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { LLMProviderPort, MemoryExtractor } from '../contracts.js';
import { SessionManager } from '../../session/manager.js';
import {
  CapturedSessionReads,
  type CapturedSessionOwnerIdentity,
  type CapturedSessionReadOperations,
} from '../../session/manager/captured-session-owner.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  SessionStore,
  type SourceTurnRecordEligibility,
} from '../../../persistence/sessions/store.js';
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
import { MemoryExtractor as RealMemoryExtractor } from '../../../faculties/memory/extraction.js';
import { createDefaultGroupMemorySettings } from '../../../system/config/group-memory-config.js';
import { ModelCallPreemptedError } from '../../../primitives/llm/model-call-gate.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import {
  executePostTurnBackgroundWork,
  type PostTurnBackgroundRuntimeDependencies,
} from './post-turn-runtime.js';
import type { BackgroundWorkPostTurnTuning } from './config.js';
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
const TEST_POST_TURN_TUNING: BackgroundWorkPostTurnTuning = {
  extractionDrainRequeueDelayMs: 1_000,
  foregroundPreemptionDeferDelayMs: 1_000,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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
      operation: (assertOwned: () => Promise<void>) => Promise<readonly string[] | void>,
    ) => Promise<void>;
  };
  committedOutputRefs: string[];
  signal: AbortSignal;
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
  const committedOutputRefs: string[] = [];
  return {
    payload,
    effects: {
      assertOwned,
      run: vi.fn(async (_effectKey, operation) => {
        const refs = await operation(assertOwned);
        committedOutputRefs.push(...(refs ?? []));
      }),
    },
    committedOutputRefs,
    signal: new AbortController().signal,
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
      deferCount: 0,
      welfareClaimed: false,
    },
  };
}

function makeEmotionExecution(
  record: TurnRecord,
  internalStateSnapshotRef = record.internalStateSnapshotRef!,
) {
  const base = makeExecution(record);
  const payload: EmotionAppraisalBackgroundPayload = {
    schemaVersion: 1,
    kind: 'emotion_appraisal',
    source: base.payload.source,
    emotionSessionId: record.sessionId!,
    internalStateSnapshotRef,
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
  return {
    payload,
    effects: base.effects,
    signal: base.signal,
    job: {
      ...base.job,
      kind: payload.kind,
      payload,
      payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    },
  };
}

function makeAutoCompactionExecution(record: TurnRecord) {
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
  return {
    payload,
    effects: base.effects,
    signal: base.signal,
    job: {
      ...base.job,
      kind: payload.kind,
      payload,
      payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    },
  };
}

function makeDependencies(input: {
  record: TurnRecord | null;
  maybeExtract?: ReturnType<typeof vi.fn>;
  runIntentionPostTurnHooks?: ReturnType<typeof vi.fn>;
  beforeSourceEligibilityFence?: () => void;
  recentEntries?: SessionEntry[];
  liveRecentEntries?: SessionEntry[];
  boundedSnapshotLimit?: number;
  tuning?: BackgroundWorkPostTurnTuning;
}) {
  const lookupSourceRecordedTurnEligibility = vi.fn(async (): Promise<SourceTurnRecordEligibility> => (
    input.record
      ? { kind: 'eligible' as const, record: input.record }
      : { kind: 'missing' as const }
  ));
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
  const getMessageCount = vi.fn(() => (input.liveRecentEntries ?? input.recentEntries ?? []).length);
  const getRecentMessages = vi.fn(() => input.liveRecentEntries ?? input.recentEntries ?? []);
  const capturedSessionScopeManager = {};
  const createCapturedSessionReads = vi.fn((
    owner: CapturedSessionOwnerIdentity,
  ): CapturedSessionReads => new CapturedSessionReads(
    capturedSessionScopeManager,
    owner,
    {
      buildContext: () => {
        throw new Error('Unexpected buildContext call');
      },
      captureTurnSessionContext: () => {
        throw new Error('Unexpected captureTurnSessionContext call');
      },
      getRecentMessages: () => getRecentMessages(),
    getRecentMessagesAtOrBefore: (maxEntryId: number, limit: number) => (
      getRecentMessagesAtOrBefore(owner.logicalSessionId, maxEntryId, limit)
    ),
      getRoleEnvelopeRefsForEntries: () => [],
    captureAutoCompactionRecentEntries: (
      params: Omit<Parameters<SessionManager['captureAutoCompactionRecentEntries']>[0], 'channelId'>,
    ) => captureAutoCompactionRecentEntries({
      ...params,
      channelId: owner.logicalSessionId,
    }),
    scheduleAutoCompactionBetweenTurns: (
      params: Omit<Parameters<SessionManager['scheduleAutoCompactionBetweenTurns']>[0], 'channelId'>,
    ) => scheduleAutoCompactionBetweenTurns({
      ...params,
      channelId: owner.logicalSessionId,
    }),
      hasPendingAutoCompaction: () => false,
      getActiveFocusMemoryScopeQuery: () => null,
      getRecentConversationSpeakers: () => [],
      resolveConversationScope: () => {
        throw new Error('Unexpected resolveConversationScope call');
      },
      reconcileSessionChannelFromDisk: async () => null,
    } satisfies CapturedSessionReadOperations,
    () => {
      throw new Error('Unexpected foreign-session read');
    },
  ));
  const backgroundSessionManager = {
    createCapturedSessionReads,
    lookupSourceRecordedTurnEligibility,
    withSourceRecordedTurnEligibilityFence,
    withStableRecordedTurnEligibilitySnapshot,
  } satisfies PostTurnBackgroundRuntimeDependencies['sessionManager'];
  return {
    dependencies: {
      sessionManager: backgroundSessionManager,
      llmProvider: {} as LLMProviderPort,
      getMemoryExtractor: () => ({
        maybeExtract,
        getBoundedExtractionSnapshotLimit: () => input.boundedSnapshotLimit ?? 10,
      } as unknown as MemoryExtractor),
      runIntentionPostTurnHooks,
      emotionRuntime: { triggerEmotionAppraisal },
      getEmotionTemplateVariables: () => ({ personality: 'current canonical personality' }),
      tuning: input.tuning ?? TEST_POST_TURN_TUNING,
    },
    lookupSourceRecordedTurnEligibility,
    withSourceRecordedTurnEligibilityFence,
    getRecentMessagesAtOrBefore,
    withStableRecordedTurnEligibilitySnapshot,
    captureAutoCompactionRecentEntries,
    scheduleAutoCompactionBetweenTurns,
    getMessageCount,
    getRecentMessages,
    maybeExtract,
    runIntentionPostTurnHooks,
    triggerEmotionAppraisal,
  };
}

describe('executePostTurnBackgroundWork', () => {
  it('projects actual durable extraction targets as canonical typed refs', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const recentEntries: SessionEntry[] = [{
      id: 2,
      channelId: record.sessionId!,
      role: 'assistant',
      content: record.assistantMessage!.content,
      timestamp: record.completedAt,
    }];
    const fixture = makeDependencies({
      record,
      recentEntries,
      maybeExtract: vi.fn(async () => ({
        memoryIds: ['memory-1'],
        concernIds: ['concern-1'],
        contactIds: ['contact-1'],
      })),
    });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(execution.committedOutputRefs).toEqual([
      'loom-output:v1:memory:bWVtb3J5LTE',
      'loom-output:v1:concern:Y29uY2Vybi0x',
      'loom-output:v1:contact:Y29udGFjdC0x',
    ]);
  });

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
      expect.any(Function),
      { preemptionProtected: false },
    );
  });

  it('binds extraction-issued provider work to its originating logical session', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const recentEntries: SessionEntry[] = [{
      id: 2,
      channelId: record.sessionId!,
      role: 'assistant',
      content: record.assistantMessage!.content,
      timestamp: record.completedAt,
    }];
    const observedContexts: Array<ReturnType<typeof getRequestContext>> = [];
    const fixture = makeDependencies({
      record,
      recentEntries,
      maybeExtract: vi.fn(async () => {
        observedContexts.push(getRequestContext());
        return undefined;
      }),
    });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(observedContexts).toEqual([expect.objectContaining({
      sessionId: record.sessionId,
      channelId: record.channelId,
      channelType: record.channelType,
      turnId: record.turnId,
      requestId: record.requestId,
      callType: 'background',
      originType: 'background',
      originStage: 'extraction',
    })]);
  });

  it('keeps the real compaction drain on its captured API owner across an active-context switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-post-turn-owner-race-'));
    const capturedOwner = 'api:captured-background-owner';
    const futureOwner = 'api:future-background-owner';
    const sourceChannelId = 'api:physical-background-source';
    const fenceEntered = deferred();
    const releaseFence = deferred();
    const store = new SessionStore(join(root, 'sessions'), {
      turnRecordEligibilityFence: {
        withTurnRecordEligibilityFence: async (_key, operation) => operation(),
        withTurnRecordEligibilityFences: async (_keys, operation) => {
          fenceEntered.resolve();
          await releaseFence.promise;
          return operation();
        },
      },
    });
    const config = {
      dataDir: root,
      companionDataDir: root,
      sessionMessageLimit: 30,
      memoryRetrievalLimit: 15,
      extractionInterval: 5,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 4_096,
      extractionThresholdPct: 30,
      compactionThresholdPct: 1,
      modelRoster: {
        chat: { provider: 'test', model: 'test', contextWindow: 4_096, maxTokens: 128 },
      },
    } as SubstrateConfig;
    const sessionManager = new SessionManager(store, config);
    const completedAt = Date.now();
    const record = makeTurnRecord({
      sessionId: capturedOwner,
      channelId: sourceChannelId,
      channelType: 'api',
      startedAt: completedAt - 10,
      completedAt,
      userMessage: {
        role: 'user',
        content: 'captured source input',
        timestamp: completedAt - 10,
      },
      assistantMessage: {
        role: 'assistant',
        content: 'captured source output',
        timestamp: completedAt,
      },
    });

    try {
      let capturedUserEntryId: number | null = null;
      let capturedAssistantEntryId: number | null = null;
      for (let index = 0; index < 3; index += 1) {
        const turnContext = {
          sourceChannelId,
          turnId: record.turnId,
          requestId: record.requestId,
        };
        capturedUserEntryId = sessionManager.recordUserMessage(
          capturedOwner,
          `captured user ${index} ${'A'.repeat(200)}`,
          'user-a',
          'User',
          true,
          undefined,
          turnContext,
        );
        capturedAssistantEntryId = sessionManager.recordAssistantMessage(
          capturedOwner,
          `captured assistant ${index} ${'B'.repeat(200)}`,
          undefined,
          true,
          undefined,
          turnContext,
        );
        sessionManager.recordUserMessage(
          futureOwner,
          `future user ${index} ${'C'.repeat(200)}`,
          'user-b',
          'User',
        );
        sessionManager.recordAssistantMessage(
          futureOwner,
          `future assistant ${index} ${'D'.repeat(200)}`,
        );
      }
      expect(capturedUserEntryId).not.toBeNull();
      expect(capturedAssistantEntryId).not.toBeNull();
      await sessionManager.recordTurn(record);

      const execution = makeAutoCompactionExecution(record);
      execution.payload.source.userSessionEntryId = capturedUserEntryId!;
      execution.payload.source.assistantSessionEntryId = capturedAssistantEntryId!;
      execution.job.payloadFingerprint = fingerprintBackgroundWorkPayload(execution.payload);
      const complete = vi.fn<LLMProviderPort['complete']>().mockResolvedValue({
        content: 'Captured owner summary.',
        model: 'test',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [],
        stopReason: 'end_turn',
      });
      const dependencies = {
        sessionManager,
        llmProvider: { stream: vi.fn(), complete } as unknown as LLMProviderPort,
        getMemoryExtractor: () => null,
        runIntentionPostTurnHooks: vi.fn(async () => undefined),
        emotionRuntime: { triggerEmotionAppraisal: vi.fn(async () => undefined) },
        getEmotionTemplateVariables: () => ({}),
        tuning: TEST_POST_TURN_TUNING,
      };

      sessionManager.setActiveContextSession(capturedOwner);
      const drain = executePostTurnBackgroundWork(execution, dependencies);
      await fenceEntered.promise;
      sessionManager.setActiveContextSession(futureOwner);
      releaseFence.resolve();
      await expect(drain).resolves.toBeUndefined();

      expect(complete).toHaveBeenCalledTimes(1);
      expect(store.getCompactionSummaries(capturedOwner)).toHaveLength(1);
      expect(store.getCompactionSummaries(futureOwner)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sizes the bounded memory snapshot to the configured interval so intervals above ten are reachable', async () => {
    // Regression for psfn-framework-u5bv.10: the handler requested a fixed ten
    // entries, so a configured interval of 11-50 could never accumulate enough
    // uncovered entries in one bounded snapshot to interval-fire — every receipt
    // completed as a durable no-op. The window must now follow the interval.
    const record = makeTurnRecord();
    const execution = makeExecution(record);
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
    const fixture = makeDependencies({ record, recentEntries, boundedSnapshotLimit: 25 });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.getRecentMessagesAtOrBefore).toHaveBeenCalledWith(
      record.sessionId,
      2,
      25,
    );
    expect(fixture.getRecentMessagesAtOrBefore).not.toHaveBeenCalledWith(
      record.sessionId,
      2,
      10,
    );
    expect(fixture.maybeExtract).toHaveBeenCalledOnce();
  });

  it('runs the real extraction orchestrator from the bounded post-turn snapshot only', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    delete execution.payload.canonicalContactId;
    execution.job.payloadFingerprint = fingerprintBackgroundWorkPayload(execution.payload);
    const sourceEntries: SessionEntry[] = [
      {
        id: 1,
        channelId: record.sessionId!,
        role: 'user',
        content: 'Authoritative source turn B contains the bounded private detail.',
        authorName: 'Partner',
        timestamp: record.startedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
          role: 'user',
          actorKind: 'human',
        }),
      },
      {
        id: 2,
        channelId: record.sessionId!,
        role: 'assistant',
        content: 'Authoritative source turn B response.',
        timestamp: record.completedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
          role: 'assistant',
          actorKind: 'machine_intelligence',
        }),
      },
    ];
    const liveRecentEntries: SessionEntry[] = [
      {
        id: 10,
        channelId: record.sessionId!,
        role: 'user',
        content: 'Unfenced live turn A must not enter the prompt.',
        timestamp: 80,
      },
      {
        id: 12,
        channelId: record.sessionId!,
        role: 'assistant',
        content: 'Unfenced newer live turn C must not enter the prompt.',
        timestamp: 120,
      },
    ];
    const fixture = makeDependencies({ record, recentEntries: sourceEntries, liveRecentEntries });
    const complete = vi.fn().mockResolvedValue({ content: '<response></response>' });
    const extractor = new RealMemoryExtractor(
      { complete } as unknown as LLMProviderPort,
      fixture.dependencies.sessionManager,
      {
        getMemoriesByChannel: vi.fn().mockResolvedValue([]),
      } as ConstructorParameters<typeof RealMemoryExtractor>[2],
      {
        embed: vi.fn().mockResolvedValue(new Float32Array(8)),
        embedBatch: vi.fn(),
        dims: 8,
      } as ConstructorParameters<typeof RealMemoryExtractor>[3],
      {
        emit: vi.fn().mockResolvedValue(undefined),
      } as ConstructorParameters<typeof RealMemoryExtractor>[4],
      {
        extractionInterval: 1,
        minImportance: 0,
        minConfidence: 0,
        minNovelty: 0,
        telemetryEnabled: true,
      },
    );
    fixture.dependencies.getMemoryExtractor = () => extractor;

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.getRecentMessages).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    const prompt = complete.mock.calls[0]?.[0].systemPrompt;
    expect(prompt).toContain('Authoritative source turn B contains the bounded private detail.');
    expect(prompt).toContain('Authoritative source turn B response.');
    expect(prompt).not.toContain('Unfenced live turn A must not enter the prompt.');
    expect(prompt).not.toContain('Unfenced newer live turn C must not enter the prompt.');
  });

  it('does not complete durable B from an unrelated in-flight group extraction', async () => {
    const record = makeTurnRecord({
      sessionId: 'logical-session-coalesced-b',
      channelId: 'discord:coalesced-b',
    });
    const execution = makeExecution(record);
    delete execution.payload.canonicalContactId;
    execution.job.payloadFingerprint = fingerprintBackgroundWorkPayload(execution.payload);
    const sourceEntries: SessionEntry[] = [
      {
        id: 1,
        channelId: record.sessionId!,
        role: 'user',
        content: 'Exact fenced turn B contains a durable private preference.',
        authorName: 'Partner',
        timestamp: record.startedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
          role: 'user',
          actorKind: 'human',
        }),
      },
      {
        id: 2,
        channelId: record.sessionId!,
        role: 'assistant',
        content: 'Exact fenced turn B response.',
        timestamp: record.completedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
          role: 'assistant',
          actorKind: 'machine_intelligence',
        }),
      },
    ];
    const fixture = makeDependencies({ record, recentEntries: sourceEntries });
    const groupStarted = deferred();
    const releaseGroup = deferred();
    const boundedBStarted = deferred();
    const releaseBoundedB = deferred();
    let completionCall = 0;
    const complete = vi.fn(async (_context: Parameters<LLMProviderPort['complete']>[0]) => {
      completionCall += 1;
      if (completionCall === 1) {
        groupStarted.resolve();
        await releaseGroup.promise;
      } else {
        boundedBStarted.resolve();
        await releaseBoundedB.promise;
      }
      return { content: '<response></response>' };
    });
    const extractor = new RealMemoryExtractor(
      { complete } as unknown as LLMProviderPort,
      fixture.dependencies.sessionManager,
      {
        getMemoriesByChannel: vi.fn().mockResolvedValue([]),
      } as ConstructorParameters<typeof RealMemoryExtractor>[2],
      {
        embed: vi.fn().mockResolvedValue(new Float32Array(8)),
        embedBatch: vi.fn(),
        dims: 8,
      } as ConstructorParameters<typeof RealMemoryExtractor>[3],
      {
        emit: vi.fn().mockResolvedValue(undefined),
      } as ConstructorParameters<typeof RealMemoryExtractor>[4],
      {
        extractionInterval: 1,
        minImportance: 0,
        minConfidence: 0,
        minNovelty: 0,
        telemetryEnabled: true,
      },
    );
    fixture.dependencies.getMemoryExtractor = () => extractor;

    const groupPromise = extractor.extractObservedGroupRange({
      channelId: record.sessionId!,
      triggerReason: 'observed_count',
      recoveredEntries: [
        {
          id: 101,
          channelId: record.sessionId!,
          role: 'user',
          content: 'Unrelated group range discusses a substantial travel plan.',
          authorName: 'Group member',
          timestamp: 10,
        },
        {
          id: 102,
          channelId: record.sessionId!,
          role: 'assistant',
          content: 'Unrelated group range response.',
          timestamp: 11,
        },
      ],
      groupWriteCaps: createDefaultGroupMemorySettings().writeCaps,
    });
    await groupStarted.promise;

    let postTurnCompleted = false;
    const postTurnPromise = executePostTurnBackgroundWork(
      execution,
      fixture.dependencies,
    ).finally(() => { postTurnCompleted = true; });
    await vi.waitFor(() => {
      expect(execution.effects.run).toHaveBeenCalledOnce();
    });

    releaseGroup.resolve();
    const afterGroup = await Promise.race([
      boundedBStarted.promise.then(() => 'bounded_b_started' as const),
      postTurnPromise.then(() => 'post_turn_completed' as const),
    ]);
    expect(afterGroup).toBe('bounded_b_started');
    expect(postTurnCompleted).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
    const boundedPrompt = complete.mock.calls[1]?.[0].systemPrompt as string;
    expect(boundedPrompt).toContain('Exact fenced turn B contains a durable private preference.');
    expect(boundedPrompt).not.toContain('Unrelated group range discusses a substantial travel plan.');

    releaseBoundedB.resolve();
    await expect(postTurnPromise).resolves.toBeUndefined();
    await expect(groupPromise).resolves.toBe(true);
  });

  it('defers durable B as retryable when the extractor drains before its queued run starts', async () => {
    const record = makeTurnRecord({
      sessionId: 'logical-session-drained-b',
      channelId: 'discord:drained-b',
    });
    const execution = makeExecution(record);
    delete execution.payload.canonicalContactId;
    execution.job.payloadFingerprint = fingerprintBackgroundWorkPayload(execution.payload);
    const sourceEntries: SessionEntry[] = [
      {
        id: 1,
        channelId: record.sessionId!,
        role: 'user',
        content: 'Exact fenced turn B contains a durable private preference.',
        authorName: 'Partner',
        timestamp: record.startedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
          role: 'user',
          actorKind: 'human',
        }),
      },
      {
        id: 2,
        channelId: record.sessionId!,
        role: 'assistant',
        content: 'Exact fenced turn B response.',
        timestamp: record.completedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
          role: 'assistant',
          actorKind: 'machine_intelligence',
        }),
      },
    ];
    const fixture = makeDependencies({
      record,
      recentEntries: sourceEntries,
      tuning: {
        ...TEST_POST_TURN_TUNING,
        extractionDrainRequeueDelayMs: 1_234,
      },
    });
    const groupStarted = deferred();
    const releaseGroup = deferred();
    const complete = vi.fn(async () => {
      groupStarted.resolve();
      await releaseGroup.promise;
      return { content: '<response></response>' };
    });
    const extractor = new RealMemoryExtractor(
      { complete } as unknown as LLMProviderPort,
      fixture.dependencies.sessionManager,
      {
        getMemoriesByChannel: vi.fn().mockResolvedValue([]),
      } as ConstructorParameters<typeof RealMemoryExtractor>[2],
      {
        embed: vi.fn().mockResolvedValue(new Float32Array(8)),
        embedBatch: vi.fn(),
        dims: 8,
      } as ConstructorParameters<typeof RealMemoryExtractor>[3],
      {
        emit: vi.fn().mockResolvedValue(undefined),
      } as ConstructorParameters<typeof RealMemoryExtractor>[4],
      {
        extractionInterval: 1,
        minImportance: 0,
        minConfidence: 0,
        minNovelty: 0,
        telemetryEnabled: true,
      },
    );
    fixture.dependencies.getMemoryExtractor = () => extractor;

    // An unrelated extraction on the same session holds in-flight, so durable B
    // queues behind it (serialize scheduling).
    const groupPromise = extractor.extractObservedGroupRange({
      channelId: record.sessionId!,
      triggerReason: 'observed_count',
      recoveredEntries: [
        {
          id: 101,
          channelId: record.sessionId!,
          role: 'user',
          content: 'Unrelated group range discusses a substantial travel plan.',
          authorName: 'Group member',
          timestamp: 10,
        },
        {
          id: 102,
          channelId: record.sessionId!,
          role: 'assistant',
          content: 'Unrelated group range response.',
          timestamp: 11,
        },
      ],
      groupWriteCaps: createDefaultGroupMemorySettings().writeCaps,
    });
    await groupStarted.promise;

    const postTurnPromise = executePostTurnBackgroundWork(execution, fixture.dependencies);
    await vi.waitFor(() => {
      expect(execution.effects.run).toHaveBeenCalledOnce();
    });

    // Graceful shutdown flips acceptance before B's chained run starts.
    const stopping = extractor.stop({ timeoutMs: 5_000 });
    releaseGroup.resolve();

    // B fails closed: the post-turn seam translates the drain requeue into a
    // retryable defer so the job (and its effect receipt) survive for a later
    // run rather than completing as covered.
    await expect(postTurnPromise).rejects.toEqual(
      expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
        name: 'BackgroundWorkDeferredError',
        reasonCode: 'handler_failed',
        delayMs: 1_234,
      }),
    );
    // B never ran its own extraction LLM (threw before the boundary crossing).
    expect(complete).toHaveBeenCalledOnce();

    await expect(groupPromise).resolves.toBe(true);
    await expect(stopping).resolves.toBe(true);
  });

  it('rehydrates an exact physical-source/logical-session turn without copying content into the job', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
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

    expect(fixture.lookupSourceRecordedTurnEligibility).toHaveBeenCalledWith(
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
      recentEntries,
      expect.any(Function),
      { preemptionProtected: false },
    );
    expect(JSON.stringify(execution.payload)).not.toContain(record.userMessage.content);
    expect(JSON.stringify(execution.payload)).not.toContain(record.assistantMessage?.content);
  });

  it('defers an authoritative empty memory snapshot before entering the effect sink', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({ record, recentEntries: [] });

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
        name: 'BackgroundWorkDeferredError',
        reasonCode: 'source_not_ready',
      }));

    expect(execution.effects.run).not.toHaveBeenCalled();
    expect(fixture.maybeExtract).not.toHaveBeenCalled();
  });

  it('defers a reduced memory snapshot that is missing the source boundary entry', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({
      record,
      recentEntries: [{
        id: 1,
        channelId: record.sessionId!,
        role: 'user',
        content: 'An older entry survived, but the source boundary did not.',
        timestamp: record.startedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4f',
          requestId: 'request-older',
          role: 'user',
          actorKind: 'human',
        }),
      }],
    });

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
        name: 'BackgroundWorkDeferredError',
        reasonCode: 'source_not_ready',
      }));

    expect(execution.effects.run).not.toHaveBeenCalled();
    expect(fixture.maybeExtract).not.toHaveBeenCalled();
  });

  it('preserves source_not_ready when a validation snapshot changes concurrently', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({ record });
    const changed = new Error('eligibility changed during the bounded read');
    changed.name = 'TurnRecordEligibilitySnapshotChangedError';
    fixture.withStableRecordedTurnEligibilitySnapshot.mockRejectedValueOnce(changed);

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
        name: 'BackgroundWorkDeferredError',
        reasonCode: 'source_not_ready',
        terminalReasonCode: undefined,
      }));

    expect(execution.effects.run).not.toHaveBeenCalled();
  });

  it('classifies a missing canonical record as retryable with a truthful terminal reason', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({ record: null });

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
        name: 'BackgroundWorkDeferredError',
        reasonCode: 'source_not_ready',
        terminalReasonCode: 'source_missing',
      }));
  });

  it('leaves missing-source budgeting to the supervisor but permanently fails mismatches', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const missing = makeDependencies({ record: null });
    await expect(executePostTurnBackgroundWork(execution, missing.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
        name: 'BackgroundWorkDeferredError',
        reasonCode: 'source_not_ready',
        terminalReasonCode: 'source_missing',
      }));

    const mismatch = makeDependencies({
      record: makeTurnRecord({ assistantMessage: {
        role: 'assistant',
        content: 'tampered response',
        timestamp: 100,
      } }),
    });
    await expect(executePostTurnBackgroundWork(execution, mismatch.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkPermanentError>>({
        name: 'BackgroundWorkPermanentError',
      reasonCode: 'source_mismatch',
    }));
  });

  it('runs emotion appraisal from a hash-bound aggregate projection', async () => {
    const selfSnapshotRef = 'internal-state-v1:test-snapshot';
    const record = makeTurnRecord({
      internalStateSnapshotRef: [
        'trust:regular',
        'contact:contact-1',
        'prompt:prompt-v1',
        'memory:memory-v1',
        'session:session-v1',
        `self:${selfSnapshotRef}`,
      ].join('|'),
    });
    const execution = makeEmotionExecution(record, selfSnapshotRef);
    const { payload } = execution;
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
      signal: execution.signal,
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

  it('records the social-desire felt signal before the appraisal call (psfn-framework-hrmrq.85)', async () => {
    const selfSnapshotRef = 'internal-state-v1:felt-signal';
    const record = makeTurnRecord({
      internalStateSnapshotRef: [
        'trust:regular',
        'contact:contact-1',
        'prompt:prompt-v1',
        'memory:memory-v1',
        'session:session-v1',
        `self:${selfSnapshotRef}`,
      ].join('|'),
    });
    const execution = makeEmotionExecution(record, selfSnapshotRef);
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
    const fixture = makeDependencies({ record, recentEntries: [appraisalEntry] });
    const callOrder: string[] = [];
    fixture.triggerEmotionAppraisal.mockImplementation(async () => {
      callOrder.push('appraisal');
    });
    const feltSignalRecord = vi.fn(async () => {
      callOrder.push('felt-signal');
      return null;
    });

    await executePostTurnBackgroundWork(execution, {
      ...fixture.dependencies,
      socialDesireFeltSignals: { record: feltSignalRecord },
    });

    // The deterministic accumulation write runs FIRST, with the exact per-turn
    // appraisal state and the turn's completion instant, so an appraisal gate
    // close or model-call preemption can never starve social-desire pressure.
    expect(feltSignalRecord).toHaveBeenCalledTimes(1);
    expect(feltSignalRecord).toHaveBeenCalledWith(execution.payload.appraisalState, {
      sourceRef: `emotion_appraisal:${execution.payload.source.channelId}:${execution.payload.source.turnId}`,
      nowMs: execution.payload.source.createdAtMs,
    });
    expect(callOrder).toEqual(['felt-signal', 'appraisal']);
  });

  it('runs auto-compaction from the exact bounded source-turn snapshot', async () => {
    const record = makeTurnRecord();
    const execution = makeAutoCompactionExecution(record);
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

  it('defers empty emotion and compaction snapshots before entering their effect sinks', async () => {
    const record = makeTurnRecord();

    const emotionExecution = makeEmotionExecution(record);
    const emotionFixture = makeDependencies({ record, recentEntries: [] });
    await expect(executePostTurnBackgroundWork(
      emotionExecution,
      emotionFixture.dependencies,
    )).rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
      name: 'BackgroundWorkDeferredError',
      reasonCode: 'source_not_ready',
    }));
    expect(emotionExecution.effects.run).not.toHaveBeenCalled();
    expect(emotionFixture.triggerEmotionAppraisal).not.toHaveBeenCalled();

    const compactionExecution = makeAutoCompactionExecution(record);
    const compactionFixture = makeDependencies({ record, recentEntries: [] });
    await expect(executePostTurnBackgroundWork(
      compactionExecution,
      compactionFixture.dependencies,
    )).rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkDeferredError>>({
      name: 'BackgroundWorkDeferredError',
      reasonCode: 'source_not_ready',
    }));
    expect(compactionExecution.effects.run).not.toHaveBeenCalled();
    expect(compactionFixture.scheduleAutoCompactionBetweenTurns).not.toHaveBeenCalled();
  });

  it('checks the source tombstone/uniqueness gate before reading raw turn content', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const fixture = makeDependencies({ record });
    fixture.lookupSourceRecordedTurnEligibility.mockResolvedValue({ kind: 'ineligible' });

    await expect(executePostTurnBackgroundWork(execution, fixture.dependencies))
      .rejects.toEqual(expect.objectContaining<Partial<BackgroundWorkPermanentError>>({
        name: 'BackgroundWorkPermanentError',
        reasonCode: 'source_missing',
      }));

    expect(fixture.lookupSourceRecordedTurnEligibility).toHaveBeenCalledOnce();
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
      signal: base.signal,
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
        fixture.lookupSourceRecordedTurnEligibility.mockResolvedValue({ kind: 'ineligible' });
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

  it('passes distinct ownership and durable-boundary functions to intention hooks', async () => {
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
      signal: base.signal,
      job: {
        ...base.job,
        kind: payload.kind,
        payload,
        payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
      },
    };
    const fixture = makeDependencies({ record });

    await executePostTurnBackgroundWork(execution, fixture.dependencies);

    expect(fixture.runIntentionPostTurnHooks).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: record.turnId }),
      {
        propagateFailures: true,
        assertOwned: base.effects.assertOwned,
        runEffect: base.effects.run,
      },
    );
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
      defaultContextWindow: 4_096,
      extractionThresholdPct: 30,
      compactionThresholdPct: 1,
      modelRoster: {
        chat: { provider: 'test', model: 'test', contextWindow: 4_096, maxTokens: 128 },
      },
    } as SubstrateConfig;
    const sessionManager = new SessionManager(store, config);
    const failedContent = 'FAILED ICP A PRIVATE OUTPUT MUST NEVER ENTER A DURABLE EFFECT';
    const unboundContent = 'PRE-TURN-RECORD L0 HISTORY MUST NOT REJECT NEW BACKGROUND WORK';
    const safeOlderContext = [
      `successful B safe older context 0 ${'O'.repeat(160)}`,
      `successful B safe older context 1 ${'O'.repeat(160)}`,
    ];
    const successfulContext = Array.from(
      { length: 4 },
      (_, index) => `successful B bounded context ${index} ${'C'.repeat(160)}`,
    );
    const successfulInput = `successful B input ${'U'.repeat(640)}`;
    const successfulOutput = `successful B output ${'A'.repeat(640)}`;
    const successfulSelfSnapshotRef = 'internal-state-v1:successful-b';
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
      internalStateSnapshotRef: [
        'trust:regular',
        'contact:contact-peer',
        'prompt:none',
        'memory:none',
        'session:none',
        `self:${successfulSelfSnapshotRef}`,
      ].join('|'),
    });

    try {
      sessionManager.appendContextSystemNote(
        ICP_CHANNEL,
        unboundContent,
        'pre-turn-record-context-note',
      );
      for (const content of safeOlderContext) {
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
        getMemoryExtractor: () => ({
          maybeExtract,
          getBoundedExtractionSnapshotLimit: () => 10,
        } as unknown as MemoryExtractor),
        runIntentionPostTurnHooks: vi.fn(async () => undefined),
        emotionRuntime: { triggerEmotionAppraisal },
        getEmotionTemplateVariables: () => ({ personality: 'canonical personality' }),
        tuning: TEST_POST_TURN_TUNING,
      };

      await executePostTurnBackgroundWork({
        payload: memoryPayload,
        effects,
        signal: base.signal,
        job: makeJob(memoryPayload),
      }, dependencies);
      // maybeExtract receives, after recentEntries: a non-crossing pre-write
      // fence and (mmo9.7.4) a trailing welfare options object, so the bounded
      // snapshot is the third-to-last argument.
      const memoryEntries = maybeExtract.mock.calls[0]?.at(-3);
      if (!Array.isArray(memoryEntries)) {
        throw new Error('Memory extraction did not receive a bounded session snapshot');
      }

      const emotionPayload: EmotionAppraisalBackgroundPayload = {
        schemaVersion: 1,
        kind: 'emotion_appraisal',
        source,
        emotionSessionId: ICP_CHANNEL,
        internalStateSnapshotRef: successfulSelfSnapshotRef,
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
        signal: base.signal,
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
        signal: base.signal,
        job: makeJob(compactionPayload),
      }, dependencies);

      for (const entries of [memoryEntries, emotionEntries]) {
        expect(entries.map(entry => entry.content)).toEqual([
          ...safeOlderContext,
          ...successfulContext,
          successfulInput,
          successfulOutput,
        ]);
        expect(JSON.stringify(entries)).not.toContain(failedContent);
        expect(JSON.stringify(entries)).not.toContain(unboundContent);
      }
      expect(complete).toHaveBeenCalled();
      expect(JSON.stringify(complete.mock.calls)).not.toContain(failedContent);
      expect(JSON.stringify(complete.mock.calls)).not.toContain(unboundContent);
      const summaries = store.getCompactionSummaries(ICP_CHANNEL);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.summary).toContain('successful B');
      expect(summaries[0]?.summary).not.toContain(failedContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a model-call preemption in a wrapped error cause chain', async () => {
    const record = makeTurnRecord();
    const execution = makeExecution(record);
    const recentEntries: SessionEntry[] = [
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
    const preempted = new ModelCallPreemptedError(
      'registered_model::local_endpoint',
      'background_continuation',
      'foreground_chat',
    );
    const maybeExtract = vi.fn(async () => {
      throw new Error('Extraction orchestration failed', { cause: preempted });
    });
    const { dependencies } = makeDependencies({
      record,
      recentEntries,
      maybeExtract,
      tuning: {
        ...TEST_POST_TURN_TUNING,
        foregroundPreemptionDeferDelayMs: 2_345,
      },
    });

    const error = await executePostTurnBackgroundWork(execution, dependencies)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BackgroundWorkDeferredError);
    expect(error).toMatchObject({
      reasonCode: 'foreground_active',
      delayMs: 2_345,
    });
  });

  it('requeues and completes a real extraction after its model call is preempted', async () => {
    const record = makeTurnRecord({
      sessionId: 'logical-session-preempted-extraction',
      channelId: 'discord:preempted-extraction',
    });
    const execution = makeExecution(record);
    const recentEntries: SessionEntry[] = [
      {
        id: 1,
        channelId: record.sessionId!,
        role: 'user',
        content: 'I moved to Seattle for a new job and I feel relieved.',
        authorName: 'Partner',
        timestamp: record.startedAt,
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: record.turnId,
          requestId: record.requestId,
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
    // The extraction LLM call is aborted by the gate for a higher-priority
    // foreground acquire. Because the call is pre-commitEffectBoundary, the
    // handler must defer (no attempt consumed), never fail/retry.
    const preempted = new ModelCallPreemptedError(
      'registered_model::local_endpoint',
      'background_continuation',
      'foreground_chat',
    );
    const complete = vi.fn()
      .mockRejectedValueOnce(preempted)
      .mockResolvedValueOnce({ content: '<response></response>' });
    const { dependencies } = makeDependencies({
      record,
      recentEntries,
      tuning: {
        ...TEST_POST_TURN_TUNING,
        foregroundPreemptionDeferDelayMs: 2_345,
      },
    });
    const extractor = new RealMemoryExtractor(
      { complete } as unknown as LLMProviderPort,
      dependencies.sessionManager,
      {
        getMemoriesByChannel: vi.fn().mockResolvedValue([]),
      } as ConstructorParameters<typeof RealMemoryExtractor>[2],
      {
        embed: vi.fn().mockResolvedValue(new Float32Array(8)),
        embedBatch: vi.fn(),
        dims: 8,
      } as ConstructorParameters<typeof RealMemoryExtractor>[3],
      {
        emit: vi.fn().mockResolvedValue(undefined),
      } as ConstructorParameters<typeof RealMemoryExtractor>[4],
      {
        extractionInterval: 1,
        minImportance: 0,
        minConfidence: 0,
        minNovelty: 0,
        telemetryEnabled: true,
      },
    );
    dependencies.getMemoryExtractor = () => extractor;

    const error = await executePostTurnBackgroundWork(execution, dependencies)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(BackgroundWorkDeferredError);
    if (!(error instanceof BackgroundWorkDeferredError)) {
      throw new Error('Expected foreground preemption to defer background work');
    }
    expect(error.reasonCode).toBe('foreground_active');
    expect(error.delayMs).toBe(2_345);

    await expect(executePostTurnBackgroundWork(execution, dependencies)).resolves.toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
