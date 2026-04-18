import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { DEFAULT_COMPANION_ID } from '../../identity/companion-naming.js';
import { PromptRuntimeLayoutStore, resolvePromptRuntimeLayoutPath } from '../../identity/prompt-runtime.js';
import { getVisionToolRequestContext } from '../../../primitives/images/request-context.js';
import { buildFocusMemoryScopeQuery } from '../../session/focus-knowledge.js';
import type { SessionManager } from '../../session/manager.js';
import type { InternalState } from '../../self-model/state.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { createActiveEmanationSatellitePresencePort } from '../satellite-adapter-port.js';
import type { TurnExecutionRuntime } from './turn-execution-runtime.js';
import { handleMessageForTurn } from './turn-execution-runtime.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-turn-runtime-'));
  return tempDir;
}

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

describe('handleMessageForTurn presence canonicalization', () => {
  it('promotes authority-resolved satellite presence into the turn context before author resolution', async () => {
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
    const resolveAuthorContext = vi.fn(() => ({
      trustLevel: 'regular',
      speakerRole: 'user',
      resolvedUserName: 'User',
      canonicalContactKey: 'contact-1',
      continuityFallbackKeys: [],
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction,
      recordUserMessage,
      recordAssistantMessage,
      resolveAuthorContext,
    });
    const message = createMessage('msg-satellite-context', {
      routing: {
        source: 'wyoming',
        wyoming: {
          presence: {
            kind: 'satellite',
            companionId: DEFAULT_COMPANION_ID,
            siteId: 'ha-main',
            satelliteId: 'office',
            channelId: 'api:wyoming:ha-main:office',
            channelPrivacy: 'private',
          },
        },
      },
    });

    await handleMessageForTurn(runtime, message);

    expect(resolveAuthorContext).toHaveBeenCalledTimes(1);
    expect(resolveAuthorContext).toHaveBeenCalledWith(expect.objectContaining({
      routing: expect.objectContaining({
        source: 'wyoming',
        channelPrivacy: 'private',
        presence: expect.objectContaining({
          kind: 'satellite',
          companionId: DEFAULT_COMPANION_ID,
          siteId: 'ha-main',
          satelliteId: 'office',
          channelPrivacy: 'private',
        }),
        wyoming: expect.objectContaining({
          siteId: 'ha-main',
          satelliteId: 'office',
          presence: expect.objectContaining({
            kind: 'satellite',
            companionId: DEFAULT_COMPANION_ID,
            siteId: 'ha-main',
            satelliteId: 'office',
            channelId: 'api:wyoming:ha-main:office',
            channelPrivacy: 'private',
          }),
        }),
      }),
    }));
  });
});

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
  resolveAuthorContext?: ReturnType<typeof vi.fn>;
  buildTurnBudgetCharacteristics?: ReturnType<typeof vi.fn>;
  memoryProvider?: TurnExecutionRuntime['memoryProvider'];
  imageVisionReviewer?: TurnExecutionRuntime['imageVisionReviewer'];
  emotionSelfModelRuntimeOverrides?: Partial<TurnExecutionRuntime['emotionSelfModelRuntime']>;
}) {
  const agentState = {
    messages: [] as any[],
    tools: [] as any[],
    model: { id: 'test-model', provider: 'test', api: 'openai-completions' },
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
    costTelemetry: createEventBusCostTelemetryPort(params.eventBus),
    satellitePresence: createActiveEmanationSatellitePresencePort(),
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
      abort: vi.fn(),
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
    buildTurnBudgetCharacteristics: params.buildTurnBudgetCharacteristics ?? vi.fn(() => ({ mode: 'default' })),
    resolveTurnCallType: vi.fn(() => 'chat'),
    buildTurnCorrelation: vi.fn((_message, callType, turnId, requestId) => ({
      callType,
      purpose: 'agent.turn',
      turnId,
      requestId,
      channelId: 'ch1',
    })),
    withCorrelationPurpose: vi.fn((correlation, purpose) => ({ ...correlation, purpose })),
    resolveAuthorContext: params.resolveAuthorContext ?? vi.fn(() => ({
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
    recordSystemMessage: params.recordSystemMessage ?? vi.fn(() => null),
    resolveSessionChannelId: vi.fn((channelId: string) => channelId),
    resolveChannelType: vi.fn(() => 'api'),
    ensureModel: vi.fn(),
    captureTurnPromptSnapshot: vi.fn(() => ({})),
    buildScratchpadContextBlock: vi.fn(() => ''),
    normalizeTurnPromptOverride: vi.fn(() => ({ mode: 'default' })),
    resolveResponseStyle: vi.fn(() => 'concise'),
    buildPromptTemplateVariables: vi.fn(() => ({})),
    buildDynamicPromptTemplateVariables: vi.fn(() => ({})),
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
    const buildDynamicPromptTemplateVariablesMock = runtime.buildDynamicPromptTemplateVariables as unknown as {
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
      `[SYSTEM: ${taskKind === 'heartbeat' ? 'Scheduler' : 'Whisper'}] ${taskKind} run`,
      DEFAULT_COMPANION_ID,
    );
    expect(recordUserMessage).not.toHaveBeenCalled();
    expect(buildPromptTemplateVariablesMock.mock.calls[0]?.[5]).toBe(DEFAULT_COMPANION_ID);
    expect(buildDynamicPromptTemplateVariablesMock.mock.calls[0]?.[5]).toBe(DEFAULT_COMPANION_ID);
    expect(buildRuntimeContextMock.mock.calls[0]?.[5]).toBe(DEFAULT_COMPANION_ID);
    expect(buildPromptPrefixCacheKeyMock.mock.calls[0]?.[3]).toBe(DEFAULT_COMPANION_ID);
    expect(buildContext.mock.calls[0]?.[4]).toBe(DEFAULT_COMPANION_ID);
    expect(scheduleAutoCompactionBetweenTurns).toHaveBeenCalledWith(expect.objectContaining({
      channelId,
      userId: DEFAULT_COMPANION_ID,
    }));
    expect((runtime.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      role: 'custom',
      type: 'systemNote',
      content: `[SYSTEM: ${taskKind === 'heartbeat' ? 'Scheduler' : 'Whisper'}] ${taskKind} run`,
    });
  });

  it('routes runtime-authored repair guidance through system session + prompt lanes', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const recordUserMessage = vi.fn(() => null);
    const recordSystemMessage = vi.fn(() => 1);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage,
      recordSystemMessage,
      recordAssistantMessage: vi.fn(() => 2),
    });
    runtime.resolveAuthorContext = vi.fn(() => ({
      trustLevel: 'regular',
      speakerRole: 'system',
      resolvedUserName: 'Runtime',
      canonicalContactKey: 'contact-1',
      continuityFallbackKeys: [],
    }));

    await handleMessageForTurn(runtime, createMessage('msg-runtime-guidance', {
      authorId: 'system:runtime',
      authorName: 'Runtime',
      content: 'tool notify is unavailable; choose another route',
    }));

    expect(recordUserMessage).not.toHaveBeenCalled();
    expect(recordSystemMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      '[SYSTEM: Runtime] tool notify is unavailable; choose another route',
      'contact-1',
    );
    expect((runtime.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      role: 'custom',
      type: 'systemNote',
      content: '[SYSTEM: Runtime] tool notify is unavailable; choose another route',
    });
  });

  it('routes external turns through the canonical continuity subject instead of the session-local author id', async () => {
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
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction,
      recordUserMessage,
      recordAssistantMessage,
    });
    runtime.resolveAuthorContext = vi.fn(() => ({
      trustLevel: 'trusted',
      speakerRole: 'user',
      resolvedUserName: 'Alex',
      canonicalContactKey: 'contact-123',
      subjectIdentityKey: 'discord-user-1',
      continuitySubjectKey: 'contact-123',
      continuityFallbackKeys: ['discord-user-1'],
    }));

    await handleMessageForTurn(runtime, createMessage('msg-canonical-continuity', {
      channelId: 'discord:dm:alex',
      channelType: 'discord',
      authorId: 'discord-user-1',
      authorName: 'Alex',
    }));

    expect(recordUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'discord:dm:alex',
        authorId: 'discord-user-1',
        authorName: 'Alex',
      }),
      expect.any(String),
      expect.any(String),
      'trusted',
      'contact-123',
    );
    expect(recordAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'discord:dm:alex',
        authorId: 'discord-user-1',
      }),
      expect.any(String),
      expect.any(String),
      'assistant reply',
      'trusted',
      'contact-123',
      null,
    );
    expect(buildContext.mock.calls[0]?.[4]).toBe('contact-123');
    expect(scheduleAutoCompactionBetweenTurns).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'discord:dm:alex',
      userId: 'contact-123',
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
      extendedTools: ['notify'],
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
        skipped: [{ toolName: 'notify', source: 'autoload', reason: 'not_needed_for_turn' }],
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
      renderedDynamicSuffix: 'Dynamic suffix template',
      runtimeContext: 'Runtime context block',
      memoryContextBlock: 'Retrieved memory block',
      scratchpadContext: 'Scratchpad block',
      finalSystemPrompt: 'Final system prompt',
    });
    expect(promptContext?.assembledPrompt).toContain('Rendered static prefix');
    expect(promptContext?.assembledPrompt).toContain('Persona hint');
    expect(promptContext?.assembledPrompt).toContain('Runtime context block');
    expect(promptContext?.messages).toEqual([
      { role: 'user', content: 'Earlier user message' },
      { role: 'assistant', content: 'Earlier assistant reply' },
    ]);
    expect(promptContext?.currentTurnInput).toBe('Hello there');
    expect(promptContext?.response).toMatchObject({
      content: 'assistant reply',
      model: 'test-model',
    });
    expect(promptContext?.providerObservability).toMatchObject({
      backendApi: 'openai-completions',
      routeKind: 'registered_model',
      systemRole: {
        transport: 'openai_system',
      },
      providerWireMessages: [
        { role: 'system', source: 'system_prompt', content: 'Final system prompt' },
        { role: 'user', source: 'message', content: 'Earlier user message' },
        { role: 'assistant', source: 'message', content: expect.stringContaining('Earlier assistant reply') },
      ],
    });
    expect(toolContext).toMatchObject({
      activeTools: [
        {
          name: 'contact_lookup',
          description: 'Look up a contact.',
        },
      ],
      adaptiveSnapshot: {
        tools: [{ toolName: 'contact_lookup', source: 'core' }],
        skipped: [{ toolName: 'notify', reason: 'not_needed_for_turn' }],
      },
    });

    expect(emittedSnapshots).toHaveLength(5);
    expect(emittedSnapshots.at(-1)?.promptContext).toMatchObject({
      currentTurnInput: 'Hello there',
      finalSystemPrompt: 'Final system prompt',
      runtimeContext: 'Runtime context block',
      response: {
        content: 'assistant reply',
        model: 'test-model',
      },
      providerObservability: {
        backendApi: 'openai-completions',
      },
    });
    expect(emittedSnapshots.at(-1)?.toolContext).toMatchObject({
      activeTools: [{ name: 'contact_lookup' }],
    });
  });

  it('moves system context into the prompt system lane instead of assistant history in observability snapshots', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [
        { role: 'user', content: 'Earlier user message' },
        { role: 'system', content: '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.' },
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
    });
    runtime.captureTurnPromptSnapshot = vi.fn(() => ({
      staticPrefixTemplate: 'Static prefix template',
      dynamicSuffixTemplate: 'Dynamic suffix template',
      staticHash: 'static-hash',
      versionPointer: 'prompt-v1',
    }));
    runtime.resolveStaticPromptPrefix = vi.fn(() => 'Rendered static prefix');
    runtime.buildRuntimeContext = vi.fn(() => 'Runtime context block');
    runtime.buildScratchpadContextBlock = vi.fn(() => '');
    runtime.getPersonaAdaptation = vi.fn(() => null);

    await handleMessageForTurn(runtime, createMessage('msg-system-context'));

    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    const mergedSystemPrompt = [
      'Final system prompt',
      '<session_context>',
      '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.',
      '</session_context>',
    ].join('\n\n');
    const providerWireMessages = (promptContext?.providerObservability as {
      providerWireMessages?: Array<{ role: string; source: string; content: string }>;
    } | undefined)?.providerWireMessages;

    expect(promptContext?.messages).toEqual([
      { role: 'user', content: 'Earlier user message' },
      { role: 'system', content: '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.' },
      { role: 'assistant', content: 'Earlier assistant reply' },
    ]);
    expect(promptContext?.finalSystemPrompt).toBe(mergedSystemPrompt);
    expect(providerWireMessages).toEqual([
      { role: 'system', source: 'system_prompt', content: mergedSystemPrompt },
      { role: 'user', source: 'message', content: 'Earlier user message' },
      { role: 'assistant', source: 'message', content: expect.stringContaining('Earlier assistant reply') },
    ]);
    expect(providerWireMessages?.some(message => message.role === 'assistant'
      && message.content.includes('Queue a private follow-up reminder.'))).toBe(false);
  });

  it('keeps runtime-layer suffixes active when a custom system prompt override is used', async () => {
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus: new EventBus(),
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
    });
    runtime.normalizeTurnPromptOverride = vi.fn(() => ({
      mode: 'custom',
      systemPrompt: 'Custom system prompt',
    }));
    runtime.captureTurnPromptSnapshot = vi.fn(() => ({
      staticPrefixTemplate: 'Static prefix template',
      dynamicSuffixTemplate: 'Dynamic suffix template',
      staticHash: 'static-hash',
      versionPointer: 'prompt-v1',
    }));
    runtime.buildRuntimeContext = vi.fn(() => '');
    runtime.buildScratchpadContextBlock = vi.fn(() => '');
    runtime.getPersonaAdaptation = vi.fn(() => null);

    await handleMessageForTurn(runtime, createMessage('msg-custom-runtime-suffix'));

    const fullPrompt = buildContext.mock.calls[0]?.[1] as string;
    expect(fullPrompt).toContain('Custom system prompt');
    expect(fullPrompt).toContain('Dynamic suffix template');
  });

  it('applies persisted runtime block order before session context assembly', async () => {
    const root = makeTempDir();
    const layoutStore = new PromptRuntimeLayoutStore(resolvePromptRuntimeLayoutPath(root));
    layoutStore.reorderSystemPromptBlocks([
      'runtime.scratchpad',
      'runtime.context',
      'runtime.persona_adaptation',
      'memory.core',
      'memory.retrieval',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.continuity',
    ], 'admin');

    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [],
      manifest: undefined,
    }));
    const runtime = createRuntime({
      eventBus: new EventBus(),
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
    });
    runtime.config.dataDir = root;
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

    await handleMessageForTurn(runtime, createMessage('msg-runtime-order'));

    const fullPrompt = buildContext.mock.calls[0]?.[1] as string;
    const scratchpadIndex = fullPrompt.indexOf('Scratchpad block');
    const runtimeContextIndex = fullPrompt.indexOf('Runtime context block');
    const personaIndex = fullPrompt.indexOf('Persona hint');
    expect(scratchpadIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeContextIndex).toBeGreaterThan(scratchpadIndex);
    expect(personaIndex).toBeGreaterThan(runtimeContextIndex);
  });
});

describe('handleMessageForTurn failure persistence', () => {
  it('records a failed turn with observed tool calls when execution aborts after tool side effects', async () => {
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
    const buildTurnRecord = vi.fn((input: Parameters<TurnExecutionRuntime['buildTurnRecord']>[0]) => ({
      schemaVersion: 1 as const,
      turnId: input.turnId,
      requestId: input.requestId,
      channelId: input.message.channelId,
      channelType: input.message.channelType,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: input.status ?? 'completed',
      userMessage: {
        role: input.speakerRole,
        content: input.message.content,
        timestamp: input.message.timestamp.getTime(),
      },
      ...(input.assistantMessageContent
        ? {
          assistantMessage: {
            role: 'assistant' as const,
            content: input.assistantMessageContent,
            timestamp: input.completedAt,
          },
        }
        : {}),
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: {
        model: input.model ?? input.response?.metadata.model ?? 'test-model',
      },
      provenanceRefs: [],
    }));
    runtime.buildTurnRecord = buildTurnRecord as unknown as TurnExecutionRuntime['buildTurnRecord'];
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (runtime.agent.state.messages as any[]).push({ role: 'user', content: promptMessage.content });
      (runtime.agent.state.messages as any[]).push({
        role: 'assistant',
        api: 'openai-responses',
        provider: 'openrouter',
        model: 'openrouter/moonshotai/kimi-k2.5',
        usage: {
          input: 120,
          output: 15,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 135,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: 'toolUse',
        timestamp: 1_700_000_100_100,
        content: [
          { type: 'thinking', thinking: 'Need the memory tool first.' },
          {
            type: 'toolCall',
            id: 'call-2',
            name: 'memory_write',
            arguments: { text: 'secret value' },
            thoughtSignature: 'sig-2',
          },
        ],
      });
      (runtime.agent.state.messages as any[]).push({
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'memory_write',
        isError: false,
        timestamp: 1_700_000_100_180,
        content: [{ type: 'text', text: 'Memory stored.' }],
        details: { memoryId: 'memory-2' },
      });
      throw new Error('Request aborted');
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-failed-turn'))).rejects.toThrow('Request aborted');

    expect(buildTurnRecord).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      model: 'test-model',
      assistantSessionEntryId: null,
      turnMessages: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'toolResult', toolName: 'memory_write' }),
      ]),
    }));
    expect(runtime.sessionManager.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
    }));
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

  it('threads temporal retrieval mode through memory snapshot capture and retrieval', async () => {
    const eventBus = new EventBus();
    const captureTurnMemorySnapshot = vi.fn(async () => ({ snapshot: 'memory' }));
    const retrieve = vi.fn(async () => 'memories');
    const retrieveProactiveRecall = vi.fn(async () => 'proactive');
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
      buildTurnBudgetCharacteristics: vi.fn(() => ({ messageText: 'what time is it?' })),
      memoryProvider: {
        captureTurnMemorySnapshot,
        retrieve,
        retrieveProactiveRecall,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await handleMessageForTurn(runtime, createMessage('msg-temporal-memory', {
      content: 'what time is it?',
    }));

    expect(captureTurnMemorySnapshot).toHaveBeenCalledWith(
      'what time is it?',
      'ch1',
      'regular',
      {},
      'contact-1',
      expect.objectContaining({ messageText: 'what time is it?' }),
      undefined,
      { retrievalMode: 'temporal' },
      'temporal',
    );
    expect(retrieve).toHaveBeenCalledWith(
      'what time is it?',
      'ch1',
      'regular',
      {},
      'contact-1',
      expect.objectContaining({ snapshot: 'memory' }),
      expect.objectContaining({ messageText: 'what time is it?' }),
      undefined,
      undefined,
      { retrievalMode: 'temporal' },
      'temporal',
    );
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
      undefined,
      undefined,
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
      undefined,
      undefined,
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

  it('exposes appearance context to tools when selfie_create is active for the turn', async () => {
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
    runtime.buildPromptTemplateVariables = vi.fn(() => ({ 'character.visual_description': 'Silver eyes and a weathered jacket.' }));
    runtime.applyActiveToolsToAgentForTurn = vi.fn(() => {
      runtime.agent.state.tools = [{
        name: 'selfie_create',
        description: 'Generate a dedicated selfie or self-portrait of the companion.',
        inputSchema: { type: 'object' },
      }] as any[];
    });
    let observedContext: ReturnType<typeof getVisionToolRequestContext> | undefined;
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      observedContext = getVisionToolRequestContext();
      (runtime.agent.state.messages as any[]).push({ role: 'user', content: promptMessage.content });
      (runtime.agent.state.messages as any[]).push({ role: 'assistant', content: 'assistant reply' });
    });

    await handleMessageForTurn(runtime, createMessage('msg-selfie-appearance-context', {
      channelType: 'discord',
      content: 'take a selfie',
    }));

    expect(observedContext).toEqual({
      userMessageText: 'take a selfie',
      imageAttachmentUrls: [],
      appearanceContext: 'Silver eyes and a weathered jacket.',
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

  it('aborts a hung vision turn after 10 seconds', async () => {
    vi.useFakeTimers();
    try {
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
      const promptDeferred = createDeferred<void>();
      const abort = vi.fn();
      runtime.agent.abort = abort as typeof runtime.agent.abort;
      runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
        (runtime.agent.state.messages as any[]).push({ role: 'user', content: promptMessage.content });
        return promptDeferred.promise;
      });

      const turnResultPromise = handleMessageForTurn(runtime, createMessage('msg-vision-timeout', {
        channelType: 'discord',
        content: 'what is in the image?',
        attachments: [{
          url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
          contentType: 'image/png',
          name: 'current-image.png',
        }],
      })).then(
        () => null,
        error => error,
      );

      await flushAsyncWork();
      await vi.advanceTimersByTimeAsync(10_000);

      const error = await turnResultPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Vision turn timed out after 10000ms');
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
