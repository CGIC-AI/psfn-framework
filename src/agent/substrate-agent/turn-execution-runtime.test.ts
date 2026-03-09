import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../event-bus.js';
import type { SessionManager } from '../../session/manager.js';
import type { InternalState } from '../../self-model/state.js';
import type { SubstrateConfig, SubstrateMessage } from '../../types.js';
import type { TurnExecutionRuntime } from './turn-execution-runtime.js';
import { handleMessageForTurn } from './turn-execution-runtime.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMessage(id: string): SubstrateMessage {
  return {
    id,
    channelId: 'ch1',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'Hello there',
    timestamp: new Date('2026-03-08T12:00:00Z'),
  };
}

const TEST_INTERNAL_STATE: InternalState = {
  emotional: {
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discreteEmotions: {},
    confidence: 0,
  },
  cognitive: {
    certaintyLevel: 0.5,
    topicEngagement: 0.5,
    processingQuality: 'fluent',
  },
  attention: {
    activeConcerns: [],
    salientEntities: [],
    conversationTrajectory: 'casual',
  },
  relational: {
    contactId: 'contact-1',
    trustLevel: 'regular',
    baselineValence: 0,
    moodDrift: 0,
    recentInteractionFrequency: 0,
    lastSeenDeltaSeconds: null,
  },
};

function createRuntime(params: {
  eventBus: EventBus;
  sessionManager: SessionManager;
  buildContext: ReturnType<typeof vi.fn>;
  scheduleAutoCompactionBetweenTurns: ReturnType<typeof vi.fn>;
  awaitPendingAutoCompaction: ReturnType<typeof vi.fn>;
  recordUserMessage: ReturnType<typeof vi.fn>;
  recordAssistantMessage: ReturnType<typeof vi.fn>;
}) {
  const agentState = {
    messages: [] as any[],
    model: { id: 'test-model' },
  };
  const runtime = {
    eventBus: params.eventBus,
    llmClient: {
      stream: vi.fn(),
      complete: vi.fn(),
    },
    sessionManager: {
      buildContext: params.buildContext,
      recordTurn: vi.fn(),
      appendSystemNote: vi.fn(),
      awaitPendingAutoCompaction: params.awaitPendingAutoCompaction,
      scheduleAutoCompactionBetweenTurns: params.scheduleAutoCompactionBetweenTurns,
    } as unknown as SessionManager,
    config: {
      primaryModel: 'test-model',
      primaryProvider: 'test',
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 1024, contextWindow: 4096 },
      },
    } as unknown as SubstrateConfig,
    runtimeMode: 'default',
    agent: {
      state: agentState,
      setSystemPrompt: vi.fn(),
      replaceMessages: vi.fn((messages: any[]) => {
        agentState.messages = [...messages];
      }),
      prompt: vi.fn(async (message: { content: string }) => {
        agentState.messages.push({ role: 'user', content: message.content });
        agentState.messages.push({ role: 'assistant', content: 'assistant reply' });
      }),
      setModel: vi.fn(),
    },
    bridge: {
      setChannel: vi.fn(() => 'bridge-token'),
      clearChannel: vi.fn(),
    },
    systemPrompt: 'System prompt',
    memoryProvider: null,
    memoryExtractor: null,
    skillsRuntime: null,
    evaluateReflectionNudge: vi.fn(() => null),
    emotionSelfModelRuntime: {
      assertSelfModelRuntimeConfigured: vi.fn(),
      observeEmotionState: vi.fn(async () => null),
      getEmotionAppraisalChain: vi.fn(() => []),
      computeInternalStateForTurn: vi.fn(() => TEST_INTERNAL_STATE),
      computeMetacognitiveFlagsForTurn: vi.fn(() => []),
      triggerEmotionAppraisal: vi.fn(async () => undefined),
    },
    pinDeferredContinuationSessionContext: vi.fn(() => () => undefined),
    resolveTaskKind: vi.fn(() => undefined),
    buildTurnBudgetCharacteristics: vi.fn(() => ({ mode: 'default' })),
    resolveTurnCallType: vi.fn(() => 'chat'),
    buildTurnCorrelation: vi.fn((_message, callType, turnId, requestId) => ({
      callType,
      purpose: 'agent.turn',
      turnId,
      requestId,
      channelId: 'ch1',
    })),
    withCorrelationPurpose: vi.fn((correlation, purpose) => ({ ...correlation, purpose })),
    resolveAuthorContext: vi.fn(() => ({
      trustLevel: 'regular',
      resolvedUserName: 'User',
      canonicalContactKey: 'contact-1',
      continuityFallbackKeys: [],
    })),
    emitTurnStage: vi.fn(),
    recordUserMessage: params.recordUserMessage,
    resolveSessionChannelId: vi.fn((channelId: string) => channelId),
    resolveChannelType: vi.fn(() => 'api'),
    ensureModel: vi.fn(),
    captureTurnPromptSnapshot: vi.fn(() => ({})),
    buildScratchpadContextBlock: vi.fn(() => ''),
    normalizeTurnPromptOverride: vi.fn(() => ({ mode: 'default' })),
    resolveResponseStyle: vi.fn(() => 'concise'),
    buildPromptTemplateVariables: vi.fn(() => ({})),
    setCurrentSelfModelState: vi.fn(),
    buildRuntimeContext: vi.fn(() => ''),
    buildPromptPrefixCacheKey: vi.fn(() => 'prompt-prefix'),
    buildStaticPromptSettingsHash: vi.fn(() => 'settings-hash'),
    resolveStaticPromptPrefix: vi.fn(() => 'System prompt'),
    hashPromptText: vi.fn(() => 'prompt-hash'),
    getPersonaAdaptation: vi.fn(() => null),
    resolveContextWindow: vi.fn(() => 4096),
    preloadExtendedToolsForTurn: vi.fn(() => ({ intent: null })),
    applyActiveToolsToAgentForTurn: vi.fn(),
    setActiveTurnContext: vi.fn(),
    clearActiveTurnContext: vi.fn(),
    setActiveTurnCorrelation: vi.fn(),
    extractResponseText: vi.fn(() => 'assistant reply'),
    getLatestAssistantMessage: vi.fn(() => null),
    accumulateTurnUsage: vi.fn(() => ({
      inputTokens: 11,
      outputTokens: 7,
      toolCalls: 0,
    })),
    recordToolObservations: vi.fn(),
    recordAssistantMessage: params.recordAssistantMessage,
    buildTurnToolSummary: vi.fn(() => ({ toolCalls: [] })),
    inferPostTurnActions: vi.fn(async () => []),
    buildTurnRecord: vi.fn(() => ({
      schemaVersion: 1,
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      provenanceRefs: [],
      toolCalls: [],
      versionPointers: { model: 'test-model' },
      userMessage: { role: 'user', content: 'Hello there', timestamp: Date.now() },
      channelId: 'ch1',
      channelType: 'api',
      requestId: 'req-1',
      startedAt: Date.now(),
      completedAt: Date.now(),
      status: 'completed',
      turnId: 'turn-1',
    })),
    queueBackgroundContinuationCompletion: vi.fn(),
    emitBackgroundContinuationEvent: vi.fn(async () => undefined),
    dequeueBackgroundContinuationDeliveries: vi.fn(() => []),
    emitTelemetry: vi.fn(),
    runIntentionPostTurnHooks: vi.fn(async () => undefined),
  } as unknown as TurnExecutionRuntime;

  return runtime;
}

describe('handleMessageForTurn compaction scheduling', () => {
  it('returns the response without waiting for post-turn compaction and does not pass an llm to buildContext', async () => {
    const eventBus = new EventBus();
    const deferredCompaction = createDeferred<void>();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const scheduleAutoCompactionBetweenTurns = vi.fn(() => deferredCompaction.promise);
    const awaitPendingAutoCompaction = vi.fn(async () => undefined);
    const recordUserMessage = vi.fn(() => 1);
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction,
      recordUserMessage,
      recordAssistantMessage,
    });

    const responsePromise = handleMessageForTurn(runtime, createMessage('msg-1'));
    const timeoutSentinel = Symbol('timeout');
    const response = await Promise.race([
      responsePromise,
      new Promise<symbol>((resolve) => setTimeout(() => resolve(timeoutSentinel), 20)),
    ]);

    expect(response).not.toBe(timeoutSentinel);
    expect(response).toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
    expect(buildContext).toHaveBeenCalledTimes(1);
    expect(buildContext.mock.calls[0][3]).toBeUndefined();
    expect(scheduleAutoCompactionBetweenTurns).toHaveBeenCalledTimes(1);

    deferredCompaction.resolve();
    await deferredCompaction.promise;
  });
});
