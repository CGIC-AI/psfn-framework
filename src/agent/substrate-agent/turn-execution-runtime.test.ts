import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../event-bus.js';
import { DEFAULT_COMPANION_ID } from '../../identity/companion-naming.js';
import { getVisionToolRequestContext } from '../../images/request-context.js';
import { buildFocusMemoryScopeQuery } from '../../session/focus-knowledge.js';
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

function createMessage(id: string, overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id,
    channelId: 'ch1',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'Hello there',
    timestamp: new Date('2026-03-08T12:00:00Z'),
    ...overrides,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
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
  recordSystemMessage?: ReturnType<typeof vi.fn>;
  recordAssistantMessage: ReturnType<typeof vi.fn>;
  memoryProvider?: TurnExecutionRuntime['memoryProvider'];
  imageVisionReviewer?: TurnExecutionRuntime['imageVisionReviewer'];
  emotionSelfModelRuntimeOverrides?: Partial<TurnExecutionRuntime['emotionSelfModelRuntime']>;
}) {
  const agentState = {
    messages: [] as any[],
    tools: [] as any[],
    model: { id: 'test-model' },
  };
  const emotionSelfModelRuntime = {
    assertSelfModelRuntimeConfigured: vi.fn(),
    observeEmotionState: vi.fn(async () => null),
    getEmotionAppraisalChain: vi.fn(() => []),
    computeInternalStateForTurn: vi.fn(() => TEST_INTERNAL_STATE),
    computeMetacognitiveFlagsForTurn: vi.fn(() => []),
    triggerEmotionAppraisal: vi.fn(async () => undefined),
    ...params.emotionSelfModelRuntimeOverrides,
  };
  const runtime = {
    eventBus: params.eventBus,
    llmClient: {
      stream: vi.fn(),
      complete: vi.fn(),
    },
    imageVisionReviewer: params.imageVisionReviewer ?? null,
    sessionManager: {
      buildContext: params.buildContext,
      recordTurn: vi.fn(),
      appendSystemNote: vi.fn(),
      awaitPendingAutoCompaction: params.awaitPendingAutoCompaction,
      scheduleAutoCompactionBetweenTurns: params.scheduleAutoCompactionBetweenTurns,
      getActiveFocusMemoryScopeQuery: vi.fn(() => null),
      ...(params.sessionManager as Record<string, unknown>),
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
      setTools: vi.fn((tools: any[]) => {
        agentState.tools = [...tools];
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
    memoryProvider: params.memoryProvider ?? null,
    memoryExtractor: null,
    skillsRuntime: null,
    evaluateReflectionNudge: vi.fn(() => null),
    emotionSelfModelRuntime,
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
      speakerRole: 'user',
      resolvedUserName: 'User',
      canonicalContactKey: 'contact-1',
      continuityFallbackKeys: [],
    })),
    emitTurnStage: vi.fn((message, _turnStartMs, turnId, requestId, stage, callType, payload) => ({
      turnId,
      requestId,
      channelId: message.channelId,
      callType,
      purpose: `agent.turn.stage.${stage}`,
      stage,
      elapsedMs: 0,
      ...payload,
    })),
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
    getAdaptiveToolRuntimeState: vi.fn(() => ({
      generatedAt: Date.now(),
      coreTools: [],
      extendedTools: [],
      promotedToolsConfigured: [],
      promotedToolsActive: [],
      promotedToolsSkipped: [],
      loadedExtendedTools: [],
      activeTools: [],
      lastSnapshot: null,
    })),
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
    recordSystemMessage: params.recordSystemMessage ?? vi.fn(() => null),
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

  it.each([
    { channelId: 'internal:heartbeat', taskKind: 'heartbeat' as const },
    { channelId: 'internal:reflection:whisper', taskKind: 'reflection' as const },
  ])('routes %s turns through the companion subject identity', async ({ channelId, taskKind }) => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const scheduleAutoCompactionBetweenTurns = vi.fn(async () => undefined);
    const awaitPendingAutoCompaction = vi.fn(async () => undefined);
    const recordUserMessage = vi.fn(() => null);
    const recordSystemMessage = vi.fn(() => null);
    const recordAssistantMessage = vi.fn(() => null);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction,
      recordUserMessage,
      recordSystemMessage,
      recordAssistantMessage,
    });
    runtime.resolveTaskKind = vi.fn(() => taskKind);
    runtime.resolveAuthorContext = vi.fn(() => ({
      trustLevel: 'primary',
      speakerRole: 'system',
      resolvedUserName: 'Companion',
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      continuityFallbackKeys: [],
    }));

    await handleMessageForTurn(runtime, createMessage(`msg-${taskKind}`, {
      channelId,
      channelType: 'terminal',
      authorId: 'scheduler',
      authorName: taskKind === 'heartbeat' ? 'Scheduler' : 'Whisper',
      content: `${taskKind} run`,
    }));

    const buildPromptTemplateVariablesMock = runtime.buildPromptTemplateVariables as unknown as {
      mock: { calls: unknown[][] };
    };
    const buildRuntimeContextMock = runtime.buildRuntimeContext as unknown as {
      mock: { calls: unknown[][] };
    };
    const buildPromptPrefixCacheKeyMock = runtime.buildPromptPrefixCacheKey as unknown as {
      mock: { calls: unknown[][] };
    };

    expect(recordSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        authorId: 'scheduler',
        authorName: taskKind === 'heartbeat' ? 'Scheduler' : 'Whisper',
        content: `${taskKind} run`,
      }),
      expect.any(String),
      expect.any(String),
      `${taskKind} run`,
      DEFAULT_COMPANION_ID,
    );
    expect(recordUserMessage).not.toHaveBeenCalled();
    expect(buildPromptTemplateVariablesMock.mock.calls[0]?.[5]).toBe(DEFAULT_COMPANION_ID);
    expect(buildRuntimeContextMock.mock.calls[0]?.[5]).toBe(DEFAULT_COMPANION_ID);
    expect(buildPromptPrefixCacheKeyMock.mock.calls[0]?.[3]).toBe(DEFAULT_COMPANION_ID);
    expect(buildContext.mock.calls[0]?.[4]).toBe(DEFAULT_COMPANION_ID);
    expect(scheduleAutoCompactionBetweenTurns).toHaveBeenCalledWith(expect.objectContaining({
      channelId,
      userId: DEFAULT_COMPANION_ID,
    }));
  });

  it('captures the full model-facing prompt context in the turn snapshot', async () => {
    const eventBus = new EventBus();
    const emittedSnapshots: Array<Record<string, unknown>> = [];
    eventBus.on('agent.turn.snapshot', (payload) => {
      emittedSnapshots.push(payload.snapshot as Record<string, unknown>);
    });
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [
        { role: 'user', content: 'Earlier user message' },
        { role: 'assistant', content: 'Earlier assistant reply' },
      ],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        captureTurnMemorySnapshot: vi.fn(async () => undefined),
        retrieve: vi.fn(async () => 'Retrieved memory block'),
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });
    runtime.captureTurnPromptSnapshot = vi.fn(() => ({
      staticPrefixTemplate: 'Static prefix template',
      dynamicSuffixTemplate: 'Dynamic suffix template',
      staticHash: 'static-hash',
      versionPointer: 'prompt-v1',
    }));
    runtime.resolveStaticPromptPrefix = vi.fn(() => 'Rendered static prefix');
    runtime.getPersonaAdaptation = vi.fn(() => 'Persona hint');
    runtime.buildRuntimeContext = vi.fn(() => 'Runtime context block');
    runtime.buildScratchpadContextBlock = vi.fn(() => 'Scratchpad block');
    (runtime.applyActiveToolsToAgentForTurn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      runtime.agent.setTools([
        {
          name: 'contact_lookup',
          description: 'Look up a contact.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
      ]);
    });
    (runtime.getAdaptiveToolRuntimeState as ReturnType<typeof vi.fn>).mockReturnValue({
      generatedAt: 1_700_000_000_000,
      coreTools: ['contact_lookup'],
      extendedTools: ['notify_operator'],
      promotedToolsConfigured: [],
      promotedToolsActive: [],
      promotedToolsSkipped: [],
      loadedExtendedTools: [],
      activeTools: [{ toolName: 'contact_lookup', source: 'core' }],
      lastSnapshot: {
        timestamp: 1_700_000_000_001,
        turnId: 'turn-1',
        requestId: 'msg-full-context',
        channelId: 'ch1',
        callType: 'chat',
        purpose: 'agent.tools.adaptive.snapshot',
        tools: [{ toolName: 'contact_lookup', source: 'core' }],
        skipped: [{ toolName: 'notify_operator', source: 'autoload', reason: 'not_needed_for_turn' }],
        counts: {
          core: 1,
          promoted: 0,
          extendedLoaded: 0,
          autoload: 0,
          deferred: 0,
          total: 1,
        },
        taskKind: null,
        intent: 'chat',
      },
    });

    await handleMessageForTurn(runtime, createMessage('msg-full-context'));

    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    const toolContext = recordedInput.turnSnapshot?.toolContext as Record<string, unknown> | undefined;
    expect(promptContext).toMatchObject({
      renderedStaticPrefix: 'Rendered static prefix',
      renderedDynamicSuffix: 'Dynamic suffix template\n\nPersona hint',
      runtimeContext: 'Runtime context block',
      memoryContextBlock: 'Retrieved memory block',
      scratchpadContext: 'Scratchpad block',
      finalSystemPrompt: 'Final system prompt',
    });
    expect(promptContext?.assembledPrompt).toContain('Rendered static prefix');
    expect(promptContext?.assembledPrompt).toContain('Runtime context block');
    expect(promptContext?.messages).toEqual([
      { role: 'user', content: 'Earlier user message' },
      { role: 'assistant', content: 'Earlier assistant reply' },
    ]);
    expect(toolContext).toMatchObject({
      activeTools: [
        {
          name: 'contact_lookup',
          description: 'Look up a contact.',
        },
      ],
      adaptiveSnapshot: {
        tools: [{ toolName: 'contact_lookup', source: 'core' }],
        skipped: [{ toolName: 'notify_operator', reason: 'not_needed_for_turn' }],
      },
    });

    expect(emittedSnapshots).toHaveLength(3);
    expect(emittedSnapshots.at(-1)?.promptContext).toMatchObject({
      finalSystemPrompt: 'Final system prompt',
      runtimeContext: 'Runtime context block',
    });
    expect(emittedSnapshots.at(-1)?.toolContext).toMatchObject({
      activeTools: [{ name: 'contact_lookup' }],
    });
  });
});

describe('handleMessageForTurn pre-response concurrency', () => {
  it('starts emotion observation and memory snapshot capture in parallel, and waits for both before retrieval', async () => {
    const eventBus = new EventBus();
    const emotionDeferred = createDeferred<null>();
    const memorySnapshotDeferred = createDeferred<{ snapshot: string }>();
    const retrieveDeferred = createDeferred<string>();
    const proactiveRecallDeferred = createDeferred<string>();
    const observeEmotionState = vi.fn(() => emotionDeferred.promise);
    const captureTurnMemorySnapshot = vi.fn(() => memorySnapshotDeferred.promise);
    const retrieve = vi.fn(() => retrieveDeferred.promise);
    const retrieveProactiveRecall = vi.fn(() => proactiveRecallDeferred.promise);
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        captureTurnMemorySnapshot,
        retrieve,
        retrieveProactiveRecall,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
      emotionSelfModelRuntimeOverrides: {
        observeEmotionState,
      },
    });

    const responsePromise = handleMessageForTurn(runtime, createMessage('msg-parallel-setup'));

    await flushAsyncWork();

    expect(observeEmotionState).toHaveBeenCalledTimes(1);
    expect(captureTurnMemorySnapshot).toHaveBeenCalledTimes(1);
    expect(retrieve).not.toHaveBeenCalled();
    expect(retrieveProactiveRecall).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();

    emotionDeferred.resolve(null);
    await flushAsyncWork();

    expect(retrieve).not.toHaveBeenCalled();
    expect(retrieveProactiveRecall).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();

    memorySnapshotDeferred.resolve({ snapshot: 'memory' });
    await vi.waitFor(() => {
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieveProactiveRecall).toHaveBeenCalledTimes(1);
    });
    expect(buildContext).not.toHaveBeenCalled();

    retrieveDeferred.resolve('memories');
    proactiveRecallDeferred.resolve('proactive');

    await expect(responsePromise).resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
  });

  it('runs memory retrieval and proactive recall concurrently, and waits for both before building context', async () => {
    const eventBus = new EventBus();
    const retrieveDeferred = createDeferred<string>();
    const proactiveRecallDeferred = createDeferred<string>();
    const retrieve = vi.fn(() => retrieveDeferred.promise);
    const retrieveProactiveRecall = vi.fn(() => proactiveRecallDeferred.promise);
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        captureTurnMemorySnapshot: vi.fn(async () => ({ snapshot: 'memory' })),
        retrieve,
        retrieveProactiveRecall,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    const responsePromise = handleMessageForTurn(runtime, createMessage('msg-parallel-memory'));

    await vi.waitFor(() => {
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(retrieveProactiveRecall).toHaveBeenCalledTimes(1);
    });
    expect(buildContext).not.toHaveBeenCalled();

    retrieveDeferred.resolve('memories');
    await flushAsyncWork();

    expect(buildContext).not.toHaveBeenCalled();

    proactiveRecallDeferred.resolve('proactive');
    await vi.waitFor(() => {
      expect(buildContext).toHaveBeenCalledTimes(1);
    });

    await expect(responsePromise).resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
  });

  it('threads the active focus scope into subagent memory retrieval calls', async () => {
    const eventBus = new EventBus();
    const focusScopeQuery = buildFocusMemoryScopeQuery('Memory Improvement');
    const captureTurnMemorySnapshot = vi.fn(async () => ({ snapshot: 'memory' }));
    const retrieve = vi.fn(async () => 'memories');
    const retrieveProactiveRecall = vi.fn(async () => 'proactive');
    const sessionManager = {
      getActiveFocusMemoryScopeQuery: vi.fn(() => focusScopeQuery),
    } as unknown as SessionManager;
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        captureTurnMemorySnapshot,
        retrieve,
        retrieveProactiveRecall,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await handleMessageForTurn(runtime, createMessage('msg-focus-scope'));

    expect(captureTurnMemorySnapshot).toHaveBeenCalledWith(
      'Hello there',
      'ch1',
      'regular',
      {},
      'contact-1',
      expect.any(Object),
      focusScopeQuery,
    );
    expect(retrieve).toHaveBeenCalledWith(
      'Hello there',
      'ch1',
      'regular',
      {},
      'contact-1',
      expect.any(Object),
      expect.any(Object),
      undefined,
      focusScopeQuery,
    );
    expect(retrieveProactiveRecall).toHaveBeenCalledWith(
      'ch1',
      'regular',
      {},
      'contact-1',
      expect.any(Object),
      expect.any(Object),
      focusScopeQuery,
    );
  });

  it('fails closed when proactive recall rejects before the response is built', async () => {
    const eventBus = new EventBus();
    const proactiveRecallError = new Error('proactive recall failed');
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        captureTurnMemorySnapshot: vi.fn(async () => ({ snapshot: 'memory' })),
        retrieve: vi.fn(async () => 'memories'),
        retrieveProactiveRecall: vi.fn(async () => {
          throw proactiveRecallError;
        }),
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-proactive-error'))).rejects.toThrow(
      'proactive recall failed',
    );
    expect(buildContext).not.toHaveBeenCalled();
  });

  it('bypasses generic memory retrieval for live image turns', async () => {
    const eventBus = new EventBus();
    const retrieve = vi.fn(async () => 'stale image memory');
    const retrieveProactiveRecall = vi.fn(async () => 'more stale image memory');
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        captureTurnMemorySnapshot: vi.fn(async () => ({ snapshot: 'memory' })),
        retrieve,
        retrieveProactiveRecall,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await handleMessageForTurn(runtime, createMessage('msg-vision-memory-bypass', {
      channelType: 'discord',
      content: 'do you see it?',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    expect(retrieve).not.toHaveBeenCalled();
    expect(retrieveProactiveRecall).not.toHaveBeenCalled();
    expect(buildContext.mock.calls[0]?.[2]).toBe('');
  });

  it('injects dedicated current-turn image review text before response generation', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const scheduleAutoCompactionBetweenTurns = vi.fn(async () => undefined);
    const awaitPendingAutoCompaction = vi.fn(async () => undefined);
    const recordUserMessage = vi.fn(() => 1);
    const recordAssistantMessage = vi.fn(() => 2);
    const analyze = vi.fn(async () => ({
      question: 'Describe exactly what is visible in the current image input.',
      summary: 'A catgirl sits on a server rack holding a pink rifle.',
      model: 'vision-model',
      imageCount: 1,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction,
      recordUserMessage,
      recordAssistantMessage,
      imageVisionReviewer: { analyze },
    });

    await handleMessageForTurn(runtime, createMessage('msg-vision-review', {
      channelType: 'discord',
      content: 'do you see it?',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    expect(analyze).toHaveBeenCalledWith({
      imageUrls: ['https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh'],
      question: 'Describe exactly what is visible in the current image input. Be concrete and concise. Ignore prior conversation or earlier image descriptions.',
    });
    expect((runtime.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.content).toContain(
      'Current image review: A catgirl sits on a server rack holding a pink rifle.',
    );
  });

  it('exposes current-turn image attachment context to tools during prompt execution', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
    });
    let observedContext: ReturnType<typeof getVisionToolRequestContext> | undefined;
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      observedContext = getVisionToolRequestContext();
      (runtime.agent.state.messages as any[]).push({ role: 'user', content: promptMessage.content });
      (runtime.agent.state.messages as any[]).push({ role: 'assistant', content: 'assistant reply' });
    });

    await handleMessageForTurn(runtime, createMessage('msg-vision-context', {
      channelType: 'discord',
      content: 'did you not see the image?',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    expect(observedContext).toEqual({
      userMessageText: 'did you not see the image?',
      imageAttachmentUrls: ['https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh'],
    });
  });

  it('exposes the dedicated current-turn image review to tools during prompt execution', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const analyze = vi.fn(async () => ({
      question: 'Describe exactly what is visible in the current image input.',
      summary: 'A catgirl sits on a server rack holding a pink rifle.',
      model: 'vision-model',
      imageCount: 1,
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      imageVisionReviewer: { analyze },
    });
    let observedContext: ReturnType<typeof getVisionToolRequestContext> | undefined;
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      observedContext = getVisionToolRequestContext();
      (runtime.agent.state.messages as any[]).push({ role: 'user', content: promptMessage.content });
      (runtime.agent.state.messages as any[]).push({ role: 'assistant', content: 'assistant reply' });
    });

    await handleMessageForTurn(runtime, createMessage('msg-vision-review-context', {
      channelType: 'discord',
      content: 'lets see if its fixed',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    expect(observedContext).toEqual({
      userMessageText: 'lets see if its fixed',
      imageAttachmentUrls: ['https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh'],
      currentTurnVisionReview: {
        imageUrls: ['https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh'],
        question: 'Describe exactly what is visible in the current image input.',
        summary: 'A catgirl sits on a server rack holding a pink rifle.',
      },
    });
  });
});
