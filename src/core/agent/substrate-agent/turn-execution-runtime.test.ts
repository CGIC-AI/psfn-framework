import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { DEFAULT_COMPANION_ID } from '../../identity/companion-naming.js';
import { PromptRuntimeLayoutStore, resolvePromptRuntimeLayoutPath } from '../../identity/prompt-runtime.js';
import { getVisionToolRequestContext } from '../../../primitives/images/request-context.js';
import { buildFocusMemoryScopeQuery } from '../../session/focus-knowledge.js';
import type { SessionManager } from '../../session/manager.js';
import {
  buildToolObservationMetadata,
  normalizeToolObservation,
} from '../../session/tool-observation.js';
import type { InternalState } from '../../self-model/state.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  ObserverEvalInput,
  ObserverEvalLifecycleState,
  ObserverEvalSidecarRuntime,
} from '../../eval/observer-sidecar/types.js';
import { drainObserverEvalSidecarQueue } from '../../eval/observer-sidecar/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { createActiveEmanationSatellitePresencePort } from '../satellite-adapter-port.js';
import type { TurnExecutionRuntime } from './turn-execution-runtime.js';
import { handleMessageForTurn } from './turn-execution-runtime.js';
import { runMoaTurn } from './moa-turn.js';

vi.mock('./moa-turn.js', async () => {
  const actual = await vi.importActual<typeof import('./moa-turn.js')>('./moa-turn.js');
  return {
    ...actual,
    runMoaTurn: vi.fn(),
  };
});

const mockedRunMoaTurn = vi.mocked(runMoaTurn);

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

beforeEach(() => {
  mockedRunMoaTurn.mockReset();
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

function makeChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 100,
      background: 100,
      maintenance: 0,
      subagent: 100,
      shard: 100,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 0,
      localImageGeneration: 0,
      paidImageGeneration: 6,
      analysisWorkbenchExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 4,
    },
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

  it('passes runtime config into MoA turns so charge policy is available', async () => {
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
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction,
      recordUserMessage,
      recordAssistantMessage,
      configOverrides: {
        moaEnabled: true,
        chargePolicy: makeChargePolicy(),
      },
    });
    mockedRunMoaTurn.mockResolvedValueOnce({
      output: 'MoA reply',
      model: 'moa-model',
      turnUsage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        llmCalls: 1,
        toolCalls: 0,
        contextUtilization: 1,
      },
      rounds: 1,
      stopReason: 'stop',
    });

    await handleMessageForTurn(runtime, createMessage('msg-moa-charge-config'));

    expect(mockedRunMoaTurn).toHaveBeenCalledTimes(1);
    expect(mockedRunMoaTurn.mock.calls[0]?.[0]).toMatchObject({
      config: expect.objectContaining({
        chargePolicy: expect.objectContaining({
          runChargeQuotaByLane: expect.objectContaining({
            interactive: 100,
          }),
        }),
      }),
    });
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
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  configOverrides?: Partial<SubstrateConfig>;
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
      ...params.configOverrides,
    } as unknown as SubstrateConfig,
    runtimeMode: 'default',
    agent: {
      state: agentState,
      setSystemPrompt: vi.fn(),
      replaceMessages: vi.fn((messages: any[]) => {
        agentState.messages = [...messages];
      }),
      appendMessage: vi.fn((message: any) => {
        agentState.messages = [...agentState.messages, message];
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
    observerEvalSidecar: params.observerEvalSidecar ?? null,
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

const OBSERVER_TEST_MESSAGE_CONTENT = 'Observer seam probe';
const TEST_EMOTION_SNAPSHOT: EmotionStateSnapshot = {
  vad: { valence: 0.24, arousal: 0.41, dominance: -0.12 },
  mood: { valence: 0.08, arousal: 0.18, dominance: -0.04 },
  discrete: { curiosity: 0.7, concern: 0.2 },
  confidence: 0.82,
};

function cloneTestEmotionSnapshot(): EmotionStateSnapshot {
  return {
    vad: { ...TEST_EMOTION_SNAPSHOT.vad },
    mood: { ...TEST_EMOTION_SNAPSHOT.mood },
    discrete: { ...TEST_EMOTION_SNAPSHOT.discrete },
    confidence: TEST_EMOTION_SNAPSHOT.confidence,
  };
}

async function runObserverSidecarTurn(observerEvalSidecar?: ObserverEvalSidecarRuntime | null) {
  const eventBus = new EventBus();
  const emotionSnapshot = cloneTestEmotionSnapshot();
  const observeEmotionState = vi.fn(async () => emotionSnapshot);
  type ComputeInternalStateInput = Parameters<
    TurnExecutionRuntime['emotionSelfModelRuntime']['computeInternalStateForTurn']
  >[0];
  const computeInternalStateForTurn = vi.fn((_input: ComputeInternalStateInput) => TEST_INTERNAL_STATE);
  const buildContext = vi.fn(async () => ({
    systemPrompt: 'System prompt',
    messages: [],
    manifest: undefined,
  }));
  const recordAssistantMessage = vi.fn(() => 2);
  const runtime = createRuntime({
    eventBus,
    sessionManager: {} as SessionManager,
    buildContext,
    scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
    awaitPendingAutoCompaction: vi.fn(async () => undefined),
    recordUserMessage: vi.fn(() => 1),
    recordAssistantMessage,
    observerEvalSidecar,
    emotionSelfModelRuntimeOverrides: {
      observeEmotionState,
      computeInternalStateForTurn,
    },
  });

  const response = await handleMessageForTurn(runtime, createMessage('msg-observer-sidecar', {
    content: OBSERVER_TEST_MESSAGE_CONTENT,
    isDirectMessage: true,
    routing: {
      source: 'api',
      channelPrivacy: 'private',
    },
  }));

  return {
    response,
    computeInternalStateForTurn,
    recordAssistantMessage,
    emotionSnapshot,
  };
}

function expectProductionEmotionSnapshotUnchanged(result: Awaited<ReturnType<typeof runObserverSidecarTurn>>) {
  expect(result.response.metadata.internalState?.emotional).toEqual(TEST_INTERNAL_STATE.emotional);
  expect(result.emotionSnapshot).toEqual(TEST_EMOTION_SNAPSHOT);
  expect(result.computeInternalStateForTurn).toHaveBeenCalledTimes(2);
  for (const call of result.computeInternalStateForTurn.mock.calls) {
    expect(call[0].emotionSnapshot).toEqual(TEST_EMOTION_SNAPSHOT);
  }
  expect(result.recordAssistantMessage.mock.calls[0]?.[6]).toEqual(TEST_EMOTION_SNAPSHOT);
}

describe('handleMessageForTurn observer eval sidecar seam', () => {
  it('leaves the production emotion snapshot unchanged when the sidecar is absent', async () => {
    const result = await runObserverSidecarTurn();

    expectProductionEmotionSnapshotUnchanged(result);
  });

  it('does not invoke a disabled sidecar and leaves the production emotion snapshot unchanged', async () => {
    const observeTurn = vi.fn();
    const lifecycleStates: ObserverEvalLifecycleState[] = [];
    const result = await runObserverSidecarTurn({
      config: { enabled: false, sidecarId: 'observer-test' },
      observer: { observeTurn },
      onLifecycleState: vi.fn((state: ObserverEvalLifecycleState) => {
        lifecycleStates.push(state);
      }),
    });

    expect(observeTurn).not.toHaveBeenCalled();
    expect(lifecycleStates).toEqual([
      expect.objectContaining({
        status: 'disabled',
        sidecarId: 'observer-test',
        reason: 'config_disabled',
      }),
    ]);
    expectProductionEmotionSnapshotUnchanged(result);
  });

  it('reports an unavailable sidecar without changing the production emotion snapshot', async () => {
    const lifecycleStates: ObserverEvalLifecycleState[] = [];
    const result = await runObserverSidecarTurn({
      config: { enabled: true, sidecarId: 'observer-test' },
      observer: null,
      onLifecycleState: vi.fn((state: ObserverEvalLifecycleState) => {
        lifecycleStates.push(state);
      }),
    });

    expect(lifecycleStates).toEqual([
      expect.objectContaining({
        status: 'unavailable',
        sidecarId: 'observer-test',
        reason: 'observer_not_configured',
      }),
    ]);
    expectProductionEmotionSnapshotUnchanged(result);
  });

  it('passes a frozen copy-only payload to an enabled sidecar without changing production emotion state', async () => {
    const lifecycleStates: ObserverEvalLifecycleState[] = [];
    let receivedInput: ObserverEvalInput | null = null;
    const observeTurn = vi.fn((input: ObserverEvalInput) => {
      receivedInput = input;
      const mutableInput = input as unknown as {
        emotion: {
          snapshot: {
            confidence: number;
            vad: { valence: number };
            discrete: Record<string, number>;
          } | null;
        };
      };
      try {
        if (mutableInput.emotion.snapshot) {
          mutableInput.emotion.snapshot.confidence = 0;
          mutableInput.emotion.snapshot.vad.valence = -1;
          mutableInput.emotion.snapshot.discrete.curiosity = 0;
        }
      } catch {
        // Frozen payloads throw under ESM strict mode; copy-only behavior is
        // asserted through the unchanged production snapshot below.
      }
    });
    const sidecarRuntime: ObserverEvalSidecarRuntime = {
      config: { enabled: true, sidecarId: 'observer-test', deployment: 'test' },
      observer: { observeTurn },
      onLifecycleState: vi.fn((state: ObserverEvalLifecycleState) => {
        lifecycleStates.push(state);
      }),
    };

    const result = await runObserverSidecarTurn(sidecarRuntime);
    expectProductionEmotionSnapshotUnchanged(result);

    await drainObserverEvalSidecarQueue(sidecarRuntime);

    expect(observeTurn).toHaveBeenCalledTimes(1);
    expect(receivedInput).not.toBeNull();
    const input = receivedInput as ObserverEvalInput;
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.emotion)).toBe(true);
    expect(Object.isFrozen(input.emotion.snapshot?.vad)).toBe(true);
    expect(input).toMatchObject({
      schemaVersion: 1,
      turn: {
        requestId: 'msg-observer-sidecar',
        sourceMessageId: 'msg-observer-sidecar',
        channelId: 'ch1',
        channelType: 'api',
      },
      source: {
        routingSource: 'api',
        isDirectMessage: true,
        channelPrivacy: 'private',
      },
      emotion: {
        snapshot: TEST_EMOTION_SNAPSHOT,
        appraisalEntryCount: 0,
      },
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: OBSERVER_TEST_MESSAGE_CONTENT.length,
        attachmentCount: 0,
        hasVisionInput: false,
        sensitivity: 'confidential',
      },
      provenance: {
        seam: 'substrate-agent.pre-turn.emotion-observed',
        emotionSnapshotSource: 'observeEmotionState',
        correlation: {
          callType: 'chat',
          purpose: 'agent.turn',
        },
      },
    });
    expect(lifecycleStates).toEqual([
      expect.objectContaining({
        status: 'enabled',
        sidecarId: 'observer-test',
        reason: 'queued',
      }),
    ]);
  });

  it('records a degraded sidecar lifecycle state without changing the running turn', async () => {
    const observeTurn = vi.fn(() => {
      throw new Error('sidecar failed');
    });
    const lifecycleStates: ObserverEvalLifecycleState[] = [];
    const sidecarRuntime: ObserverEvalSidecarRuntime = {
      config: { enabled: true, sidecarId: 'observer-test' },
      observer: { observeTurn },
      onLifecycleState: vi.fn((state: ObserverEvalLifecycleState) => {
        lifecycleStates.push(state);
      }),
    };

    const result = await runObserverSidecarTurn(sidecarRuntime);

    expectProductionEmotionSnapshotUnchanged(result);
    expect(result.response).toMatchObject({
      content: 'assistant reply',
      channelId: 'ch1',
    });

    await drainObserverEvalSidecarQueue(sidecarRuntime);
    expect(observeTurn).toHaveBeenCalledTimes(1);
    expect(lifecycleStates).toEqual([
      expect.objectContaining({
        status: 'enabled',
        sidecarId: 'observer-test',
        reason: 'queued',
      }),
      expect.objectContaining({
        status: 'degraded',
        sidecarId: 'observer-test',
        reason: 'observer_failed',
        error: expect.objectContaining({
          message: 'Observer eval sidecar error redacted',
          redacted: true,
          redactionReason: 'raw_error_redacted',
          rawMessageLength: 'sidecar failed'.length,
        }),
      }),
    ]);
  });

  it('returns the running turn without waiting for pending sidecar observer work', async () => {
    const observerCompletion = createDeferred<void>();
    const observeTurn = vi.fn(() => observerCompletion.promise);
    const sidecarRuntime: ObserverEvalSidecarRuntime = {
      config: { enabled: true, sidecarId: 'observer-test' },
      observer: { observeTurn },
    };

    const result = await runObserverSidecarTurn(sidecarRuntime);

    expect(result.response).toMatchObject({
      content: 'assistant reply',
      channelId: 'ch1',
    });
    expectProductionEmotionSnapshotUnchanged(result);

    let drainSettled = false;
    const drainPromise = drainObserverEvalSidecarQueue(sidecarRuntime).then(snapshot => {
      drainSettled = true;
      return snapshot;
    });
    await flushAsyncWork();

    expect(observeTurn).toHaveBeenCalledTimes(1);
    expect(drainSettled).toBe(false);

    observerCompletion.resolve();
    const snapshot = await drainPromise;
    expect(snapshot.counts.completed).toBe(1);
  });
});

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
        getActiveMemoryContext: vi.fn(() => ({
          key: 'active-memory:key',
          subjectKey: 'contact:contact-1',
          channelId: 'ch1',
          trustLevel: 'regular',
          channelVisibility: 'private',
          visibilityScope: 'non_broadcast',
          contextBlock: 'Retrieved memory block',
          contextChars: 'Retrieved memory block'.length,
          selectedMemoryIds: ['mem-1'],
          generatedAt: Date.now(),
          lastRefreshStartedAt: Date.now(),
          refreshStatus: 'ready',
          versionPointer: 'active-memory-v1',
        })),
        refreshActiveMemoryContext: vi.fn(async () => null),
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
      dynamicSuffixTemplate: [
        'Dynamic suffix template',
        '<current_datetime>',
        '<date>Stale legacy date</date>',
        '</current_datetime>',
      ].join('\n'),
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

  it('appends the current datetime anchor at the end of the provider system prompt', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      systemPromptSections: [
        {
          id: 'final_system_prompt',
          title: 'Final System Prompt',
          content: 'Final system prompt',
          charCount: 'Final system prompt'.length,
          tokenCount: 3,
        },
      ],
      messages: [
        { role: 'system', content: '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.' },
        { role: 'user', content: 'Current user message' },
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
    runtime.buildDynamicPromptTemplateVariables = vi.fn(() => ({
      active_timezone: 'America/New_York',
      runtime_current_weekday: 'Wednesday',
      runtime_current_date_human: 'March 18, 2026',
      runtime_current_time_human: '9:30 AM',
      runtime_current_datetime_iso: '2026-03-18T09:30:00.000-04:00',
    }));

    await handleMessageForTurn(runtime, createMessage('msg-current-datetime-anchor'));

    const fullPrompt = buildContext.mock.calls[0]?.[1] as string;
    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    const currentDatetimeAnchor = [
      '<current_datetime>',
      '<weekday>Wednesday</weekday>',
      '<date>March 18, 2026</date>',
      '<time>9:30 AM</time>',
      '<timezone>America/New_York</timezone>',
      '<iso>2026-03-18T09:30:00.000-04:00</iso>',
      '</current_datetime>',
    ].join('\n');
    const mergedSystemPrompt = [
      'Final system prompt',
      '<session_context>',
      '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.',
      '</session_context>',
      currentDatetimeAnchor,
    ].join('\n\n');
    const finalSystemPrompt = promptContext?.finalSystemPrompt as string | undefined;
    const providerWireMessages = (promptContext?.providerObservability as {
      providerWireMessages?: Array<{ role: string; source: string; content: string }>;
    } | undefined)?.providerWireMessages;
    const finalSystemSections = promptContext?.finalSystemSections as Array<{ id: string; content: string }> | undefined;

    expect(fullPrompt).toContain('Dynamic suffix template');
    expect(fullPrompt).not.toContain('Stale legacy date');
    expect(finalSystemPrompt).toBe(mergedSystemPrompt);
    expect(finalSystemPrompt?.endsWith(currentDatetimeAnchor)).toBe(true);
    expect(finalSystemPrompt?.indexOf('</session_context>')).toBeLessThan(
      finalSystemPrompt?.lastIndexOf('<current_datetime>') ?? -1,
    );
    expect(providerWireMessages?.[0]).toEqual({
      role: 'system',
      source: 'system_prompt',
      content: mergedSystemPrompt,
    });
    expect(providerWireMessages?.[1]).toEqual({
      role: 'user',
      source: 'message',
      content: 'Current user message',
    });
    expect(finalSystemSections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'runtime.current_datetime',
        content: currentDatetimeAnchor,
      }),
    ]));
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
      'session.orientation',
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

  it('does not let slow pre-prompt observability subscribers block prompt progress', async () => {
    const eventBus = new EventBus();
    const releaseTurnStart = createDeferred<void>();
    const releaseFirstSnapshot = createDeferred<void>();
    const turnStartEvents: Array<Record<string, unknown>> = [];
    const turnSnapshotEvents: Array<Record<string, unknown>> = [];

    eventBus.on('agent.turn.start', async (payload) => {
      turnStartEvents.push(payload as unknown as Record<string, unknown>);
      await releaseTurnStart.promise;
    });
    eventBus.on('agent.turn.snapshot', async (payload) => {
      turnSnapshotEvents.push(payload as unknown as Record<string, unknown>);
      if (turnSnapshotEvents.length === 1) {
        await releaseFirstSnapshot.promise;
      }
    });

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

    const responsePromise = handleMessageForTurn(runtime, createMessage('msg-slow-observability'));

    await vi.waitFor(() => {
      expect(turnStartEvents).toHaveLength(1);
      expect(turnSnapshotEvents.length).toBeGreaterThan(0);
      expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    });

    const firstSnapshot = turnSnapshotEvents[0] as {
      requestId?: string;
      channelId?: string;
      purpose?: string;
      snapshot?: Record<string, unknown>;
    };
    expect(turnStartEvents[0]).toMatchObject({
      requestId: 'msg-slow-observability',
      channelId: 'ch1',
      purpose: 'agent.turn.start',
      message: expect.objectContaining({
        id: 'msg-slow-observability',
        channelId: 'ch1',
      }),
    });
    expect(firstSnapshot).toMatchObject({
      requestId: 'msg-slow-observability',
      channelId: 'ch1',
      purpose: 'agent.turn.snapshot',
      snapshot: expect.objectContaining({
        requestId: 'msg-slow-observability',
        channelId: 'ch1',
      }),
    });
    expect(firstSnapshot.snapshot?.promptContext).toBeUndefined();

    releaseTurnStart.resolve();
    releaseFirstSnapshot.resolve();

    await expect(responsePromise).resolves.toMatchObject({
      content: 'assistant reply',
      channelId: 'ch1',
    });
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
  it('uses active memory immediately and schedules refresh without waiting for it', async () => {
    const eventBus = new EventBus();
    const emotionDeferred = createDeferred<null>();
    const refreshDeferred = createDeferred<null>();
    const observeEmotionState = vi.fn(() => emotionDeferred.promise);
    const getActiveMemoryContext = vi.fn(() => ({
      key: 'active-memory:key',
      subjectKey: 'contact:contact-1',
      channelId: 'ch1',
      trustLevel: 'regular',
      channelVisibility: 'private',
      visibilityScope: 'non_broadcast',
      contextBlock: 'already recalled memory',
      contextChars: 'already recalled memory'.length,
      selectedMemoryIds: ['mem-1'],
      generatedAt: Date.now(),
      lastRefreshStartedAt: Date.now(),
      refreshStatus: 'ready',
      versionPointer: 'active-memory-v1',
      manifestSeed: {
        reason: 'active_projection',
        returnedCount: 1,
        selectedTypes: { semantic: 1 },
      },
    }));
    const refreshActiveMemoryContext = vi.fn(() => refreshDeferred.promise);
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
        getActiveMemoryContext,
        refreshActiveMemoryContext,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
      emotionSelfModelRuntimeOverrides: {
        observeEmotionState,
      },
    });

    const responsePromise = handleMessageForTurn(runtime, createMessage('msg-parallel-setup'));

    await flushAsyncWork();

    expect(observeEmotionState).toHaveBeenCalledTimes(1);
    expect(getActiveMemoryContext).toHaveBeenCalledTimes(1);
    expect(refreshActiveMemoryContext).toHaveBeenCalledTimes(1);
    expect(buildContext).not.toHaveBeenCalled();

    emotionDeferred.resolve(null);
    await vi.waitFor(() => {
      expect(buildContext).toHaveBeenCalledTimes(1);
    });
    expect(buildContext.mock.calls[0]?.[2]).toBe('already recalled memory');

    await expect(responsePromise).resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
    refreshDeferred.resolve(null);
  });

  it('does not call fresh retrieval on the foreground response path', async () => {
    const eventBus = new EventBus();
    const captureTurnMemorySnapshot = vi.fn(async () => ({ snapshot: 'memory' }));
    const retrieve = vi.fn(async () => 'fresh memories');
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
      memoryProvider: {
        getActiveMemoryContext: vi.fn(() => null),
        refreshActiveMemoryContext: vi.fn(async () => null),
        captureTurnMemorySnapshot,
        retrieve,
        retrieveProactiveRecall,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-parallel-memory')))
      .resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });

    expect(captureTurnMemorySnapshot).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(retrieveProactiveRecall).not.toHaveBeenCalled();
    expect(buildContext).toHaveBeenCalledTimes(1);
  });

  it('threads temporal retrieval mode through active memory refresh scheduling', async () => {
    const eventBus = new EventBus();
    const refreshActiveMemoryContext = vi.fn(async () => null);
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
        getActiveMemoryContext: vi.fn(() => null),
        refreshActiveMemoryContext,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await handleMessageForTurn(runtime, createMessage('msg-temporal-memory', {
      content: 'what time is it?',
    }));

    expect(refreshActiveMemoryContext).toHaveBeenCalledWith(expect.objectContaining({
      contextText: 'what time is it?',
      channelId: 'ch1',
      trustLevel: 'regular',
      channelMeta: {},
      canonicalContactId: 'contact-1',
      turnBudgetCharacteristics: expect.objectContaining({ messageText: 'what time is it?' }),
      callerContext: { retrievalMode: 'temporal' },
      retrievalMode: 'temporal',
    }));
  });

  it('attaches structured observability warnings to the context stage when chat context is stale or contradictory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T16:00:00.000Z'));

    try {
      const nowMs = Date.now();
      const eventBus = new EventBus();
      let activeTurnId = '';
      eventBus.on('agent.turn.start', (payload) => {
        activeTurnId = payload.turnId ?? '';
      });
      const staleObservation = normalizeToolObservation({
        toolName: 'orientation_dump',
        content: 'Orientation note: keep the trust policy lane isolated.',
      });
      const captureTurnMemorySnapshot = vi.fn(async () => ({
        channelId: 'ch1',
        contactEmotionalMemories: [],
        semanticCandidates: [
          {
            id: 'reflection-memory',
            text: 'It has been 3 days since we last heard from the user.',
            type: 'reflection',
            importance: 0.8,
            confidence: 0.9,
            emotionalValence: 0.1,
            salience: 0.7,
            sourceRef: 'reflection:journal',
            extractedAt: nowMs - (3 * 24 * 60 * 60 * 1000),
            lastAccessed: nowMs,
            accessCount: 1,
            tags: ['reflection'],
            sensitivity: 'personal',
            similarity: 0.91,
          },
        ],
        lexicalCandidates: [],
        proactiveCandidates: [],
        versionPointer: 'memory-v1',
      }));
      const retrieve = vi.fn(async () => {
        await eventBus.emit('memory.retrieval', {
          turnId: activeTurnId,
          channelId: 'ch1',
          requestId: 'msg-warning-stage',
          count: 2,
          selectedTypes: { reflection: 2 },
        });
        return 'memories';
      });
      const buildContext = vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: undefined,
      }));
      const runtime = createRuntime({
        eventBus,
        sessionManager: {
          captureTurnContextSnapshot: vi.fn(() => ({
            channelId: 'ch1',
            recentEntries: [
              {
                id: 1,
                channelId: 'ch1',
                role: 'tool',
                content: staleObservation.content,
                timestamp: nowMs - (48 * 60 * 60 * 1000),
                metadata: buildToolObservationMetadata(undefined, staleObservation.metadata),
              },
              {
                id: 2,
                channelId: 'ch1',
                role: 'assistant',
                content: 'Checking in from yesterday.',
                timestamp: nowMs - (24 * 60 * 60 * 1000),
              },
              {
                id: 3,
                channelId: 'ch1',
                role: 'user',
                content: 'What changed just now?',
                timestamp: nowMs,
              },
            ],
            compactionSummaryTexts: [],
            focusKnowledgeTexts: [],
            continuityEntries: [
              {
                id: 4,
                channelId: 'discord:live',
                originChannelId: 'discord:live',
                role: 'assistant',
                content: 'Live continuity ping.',
                timestamp: nowMs - (5 * 60 * 1000),
              },
            ],
            versionPointer: 'session-v1',
          })),
        } as unknown as SessionManager,
        buildContext,
        scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
        awaitPendingAutoCompaction: vi.fn(async () => undefined),
        recordUserMessage: vi.fn(() => 1),
        recordAssistantMessage: vi.fn(() => 2),
        buildTurnBudgetCharacteristics: vi.fn(() => ({ messageText: 'what time is it?' })),
        memoryProvider: {
          captureTurnMemorySnapshot,
          retrieve,
          retrieveProactiveRecall: vi.fn(async () => ''),
        } as unknown as TurnExecutionRuntime['memoryProvider'],
      });
      runtime.captureTurnPromptSnapshot = vi.fn(() => ({
        staticPrefixTemplate: 'System prompt',
        dynamicSuffixTemplate: [
          '[Companion-Derived Values Layer]',
          '- v7 @ 2026-04-17T22:00:00.000Z (companion_reflection; template=values-reflection; mode=agent):',
          '  We have not heard from the user in days, so continuity may be breaking down.',
        ].join('\n'),
        staticHash: 'static-hash',
        versionPointer: 'prompt-v1',
      }));

      await handleMessageForTurn(runtime, createMessage('msg-warning-stage', {
        content: 'what time is it?',
        timestamp: new Date(nowMs),
      }));

      const buildTurnRecordMock = runtime.buildTurnRecord as unknown as ReturnType<typeof vi.fn>;
      const turnObservability = buildTurnRecordMock.mock.calls[0]?.[0]?.turnObservability;
      const contextStage = turnObservability?.stages.find((stage: { stage: string }) => stage.stage === 'context');

      expect(contextStage?.data.observabilityWarnings.map((warning: { code: string }) => warning.code).sort()).toEqual([
        'history_span_exceeded',
        'stale_tool_observation_verbatim',
        'values_activity_contradiction',
      ]);
      expect(contextStage?.data.observabilityCounters).toEqual({
        warningCount: 3,
        historySpanExceededCount: 1,
        staleToolObservationVerbatimCount: 1,
        valuesActivityContradictionCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('threads the active focus scope into active memory refresh scheduling', async () => {
    const eventBus = new EventBus();
    const focusScopeQuery = buildFocusMemoryScopeQuery('Memory Improvement');
    const refreshActiveMemoryContext = vi.fn(async () => null);
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
        getActiveMemoryContext: vi.fn(() => null),
        refreshActiveMemoryContext,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await handleMessageForTurn(runtime, createMessage('msg-focus-scope'));

    expect(refreshActiveMemoryContext).toHaveBeenCalledWith(expect.objectContaining({
      contextText: 'Hello there',
      channelId: 'ch1',
      trustLevel: 'regular',
      channelMeta: {},
      canonicalContactId: 'contact-1',
      turnBudgetCharacteristics: expect.any(Object),
      scopeQuery: focusScopeQuery,
    }));
  });

  it('keeps the foreground response path open when active memory refresh rejects', async () => {
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
      memoryProvider: {
        getActiveMemoryContext: vi.fn(() => ({
          key: 'active-memory:key',
          subjectKey: 'contact:contact-1',
          channelId: 'ch1',
          trustLevel: 'regular',
          channelVisibility: 'private',
          visibilityScope: 'non_broadcast',
          contextBlock: 'previously recalled memory',
          contextChars: 'previously recalled memory'.length,
          selectedMemoryIds: ['mem-1'],
          generatedAt: Date.now(),
          lastRefreshStartedAt: Date.now(),
          refreshStatus: 'ready',
          versionPointer: 'active-memory-v1',
        })),
        refreshActiveMemoryContext: vi.fn(async () => {
          throw new Error('active memory refresh failed');
        }),
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-active-memory-refresh-error')))
      .resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
    expect(buildContext).toHaveBeenCalledTimes(1);
    expect(buildContext.mock.calls[0]?.[2]).toBe('previously recalled memory');
  });

  it('bypasses generic memory retrieval for live image turns', async () => {
    const eventBus = new EventBus();
    const getActiveMemoryContext = vi.fn(() => null);
    const refreshActiveMemoryContext = vi.fn(async () => null);
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
        getActiveMemoryContext,
        refreshActiveMemoryContext,
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

    expect(getActiveMemoryContext).not.toHaveBeenCalled();
    expect(refreshActiveMemoryContext).not.toHaveBeenCalled();
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
    expect(recordUserMessage).toHaveBeenCalledTimes(1);
    const persistedUserContent = recordUserMessage.mock.calls[0]?.[5] as string;
    expect(persistedUserContent).toContain('do you see it?');
    expect(persistedUserContent).toContain('---\nImage attachment:');
    expect(persistedUserContent).toContain('Description: A catgirl sits on a server rack holding a pink rifle.');
    expect(persistedUserContent).toContain('Model: vision-model');
    expect(persistedUserContent).toContain('Image count: 1');
    const buildTurnRecordMock = runtime.buildTurnRecord as unknown as ReturnType<typeof vi.fn>;
    expect(buildTurnRecordMock.mock.calls[0]?.[0]?.persistedUserMessageContent).toBe(persistedUserContent);
  });

  it('persists an unavailable image-description block when dedicated image review fails', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: undefined,
    }));
    const recordUserMessage = vi.fn(() => 1);
    const analyze = vi.fn(async () => {
      throw new Error('provider failed with signed_url_secret=abc123');
    });
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage,
      recordAssistantMessage: vi.fn(() => 2),
      imageVisionReviewer: { analyze },
    });

    await handleMessageForTurn(runtime, createMessage('msg-vision-review-failure', {
      channelType: 'discord',
      content: 'what did i send?',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    expect(analyze).toHaveBeenCalledTimes(3);
    const persistedUserContent = recordUserMessage.mock.calls[0]?.[5] as string;
    expect(persistedUserContent).toContain('what did i send?');
    expect(persistedUserContent).toContain('---\nImage attachment:');
    expect(persistedUserContent).toContain(
      'Description unavailable: vision pipeline failed before image contents could be inspected.',
    );
    expect(persistedUserContent).toContain('Image count: 1');
    expect(persistedUserContent).not.toContain('signed_url_secret');
    const buildTurnRecordMock = runtime.buildTurnRecord as unknown as ReturnType<typeof vi.fn>;
    expect(buildTurnRecordMock.mock.calls[0]?.[0]?.persistedUserMessageContent).toBe(persistedUserContent);
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

  it('applies same-turn selfie autoload before rendering dynamic prompt variables', async () => {
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
    const callOrder: string[] = [];
    runtime.preloadExtendedToolsForTurn = vi.fn(() => ({
      intent: 'social',
      skipped: [],
    }));
    runtime.applyActiveToolsToAgentForTurn = vi.fn(() => {
      callOrder.push('apply-tools');
      runtime.agent.state.tools = [{
        name: 'selfie_create',
        description: 'Generate a dedicated selfie or self-portrait of the companion.',
        inputSchema: { type: 'object' },
      }] as any[];
    });
    runtime.buildDynamicPromptTemplateVariables = vi.fn(() => {
      callOrder.push('dynamic-prompt');
      expect((runtime.agent.state.tools as Array<{ name?: string }>).some(tool => tool.name === 'selfie_create'))
        .toBe(true);
      return {
        runtime_self_image_tool_active: 'true',
      };
    });

    await handleMessageForTurn(runtime, createMessage('msg-selfie-autoload-prompt', {
      channelType: 'discord',
      content: 'take a selfie',
    }));

    expect(runtime.preloadExtendedToolsForTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'take a selfie',
      }),
      undefined,
      expect.objectContaining({
        requestId: 'msg-selfie-autoload-prompt',
      }),
    );
    expect(callOrder).toEqual(['apply-tools', 'dynamic-prompt']);
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

  it('retries empty vision prompt recovery three times before returning a visible fallback reply', async () => {
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
    runtime.extractResponseText = vi.fn(() => {
      const latestAssistant = [...(runtime.agent.state.messages as any[])]
        .reverse()
        .find(message => message.role === 'assistant');
      if (Array.isArray(latestAssistant?.content)) {
        return latestAssistant.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('');
      }
      return typeof latestAssistant?.content === 'string' ? latestAssistant.content : '';
    });
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (runtime.agent.state.messages as any[]).push({ role: 'user', content: promptMessage.content });
      (runtime.agent.state.messages as any[]).push({ role: 'assistant', content: '' });
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-vision-empty', {
      channelType: 'discord',
      content: 'what is in the image?',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(4);
    expect(response).toMatchObject({
      content: expect.stringContaining('image reader failed'),
      metadata: {
        diagnostics: {
          fallback: expect.objectContaining({
            code: 'vision_empty_response',
            strategy: 'runtime_nonfabricating_notice',
            attempts: 3,
            finalContentEmpty: false,
            runtimeFallbackApplied: true,
          }),
        },
      },
    });
  });

  it('aborts a hung vision turn after 30 seconds and returns a visible fallback reply', async () => {
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
      runtime.extractResponseText = vi.fn(() => {
        const latestAssistant = [...(runtime.agent.state.messages as any[])]
          .reverse()
          .find(message => message.role === 'assistant');
        if (Array.isArray(latestAssistant?.content)) {
          return latestAssistant.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('');
        }
        return typeof latestAssistant?.content === 'string' ? latestAssistant.content : '';
      });
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
      }));

      await flushAsyncWork();
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(turnResultPromise).resolves.toMatchObject({
        content: expect.stringContaining('image reader failed'),
        metadata: {
          diagnostics: {
            fallback: expect.objectContaining({
              code: 'vision_prompt_unavailable',
              runtimeFallbackApplied: true,
            }),
          },
        },
      });
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
