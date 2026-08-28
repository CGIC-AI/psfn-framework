import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fromAny } from '@total-typescript/shoehorn';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EventMap } from '../../../shared/event-bus.js';
import { DEFAULT_COMPANION_ID } from '../../identity/companion-naming.js';
import { sessionEntryToMessage } from '../messages.js';
import { PromptRuntimeLayoutStore, resolvePromptRuntimeLayoutPath } from '../../identity/prompt-runtime.js';
import { getVisionToolRequestContext } from '../../../primitives/images/request-context.js';
import { buildFocusMemoryScopeQuery } from '../../session/focus-knowledge.js';
import { resolveConversationScopeFromMetadata } from '../../session/conversation-scope.js';
import { SessionManager } from '../../session/manager.js';
import {
  CapturedSessionReads,
  type CapturedSessionOwnerIdentity,
  type CapturedSessionReadOperations,
} from '../../session/manager/captured-session-owner.js';
import { SessionStore, type SessionStoreOptions } from '../../../persistence/sessions/store.js';
import {
  getPromptPlanBlockText,
  renderPromptPlanAssembledPrompt,
  serializePromptPlanSystemPrompt,
  type PromptPlan,
} from './turn-execution/prompt-plan.js';
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
import { sanitizeObserverEvalInput } from '../../eval/observer-sidecar/privacy.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import type {
  AgentResponse,
  IntentionalNoReplyMetadata,
  SubstrateMessage,
  TurnRecord,
} from '../../../shared/contracts/runtime.js';
import { createEventBusCostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { notePendingPaidDeliverable } from '../../../shared/paid-deliverable-tracking.js';
import { createActiveEmanationSatellitePresencePort } from '../satellite-adapter-port.js';
import type { FatigueBudgetEvent } from '../../../shared/contracts/runtime.js';
import {
  createOverchargeFatigueEvaluation,
  DeterministicFatigueBudgetPort,
  type FatigueBudgetHistoryPort,
  type FatigueBudgetPort,
} from '../fatigue/fatigue-budget.js';
import type { IcpFatigueRegulationReservationPort } from '../fatigue/regulation-reservation.js';
import type { HumanAttentionPressurePort } from '../fatigue/human-attention-pressure.js';
import type {
  TurnAdmissionRuntime,
  TurnExecutionRuntime,
} from './turn-execution-runtime.js';
import { handleMessageForTurn } from './turn-execution-runtime.js';
import { isExtractionTranscriptEntry } from '../../../faculties/memory/extraction/chunk-compose.js';
import { evaluateCogSecMemoryCandidacy } from '../../cogsec/memory-candidacy.js';
import { PromptCacheTurnRuntime } from './turn-execution/prompt-cache-runtime.js';
import { CompletionNoticeBuffer } from '../completion-notices.js';
import { TurnSupportRuntime } from './turn-support-runtime.js';
import type { ResolvedAuthorContext } from './runtime-context.js';
import { runMoaTurn } from './moa-turn.js';
import { buildTurnUserContent } from './vision-attachments.js';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
import {
  createTurnId,
  deriveDeterministicTurnId,
} from '../../turns/id.js';
import { parseIcpRecoveryResponse } from '../../session/icp-delivery-recovery.js';
import {
  buildSessionMetadataWithTurn,
  resolveSessionEntryTurnContext,
} from '../../session/turn-provenance.js';
import { runWithChargeContext } from '../../../shared/telemetry/run-charge.js';
import { resolveTaskKind as resolveChannelTaskKind } from './channel-routing-runtime.js';
import { createInteractiveTerminalMessage } from '../../../app/cli/interactive-terminal-message.js';
import { ParentTurnContinuationBudgetExceededError } from '../turn-limits.js';
import { parseTurnRecordBackgroundWorkHandoff } from '../background-work/types.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { ConfirmationQueue } from '../../../system/capabilities/confirmation-queue.js';
import { createApprovalQueuePortFromConfirmationQueue } from '../../../system/capabilities/approval-queue-port.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { makeContextManifestFixture } from '../../../test-support/context-manifest.js';
import { extractTurnRecordSelfSnapshotRef } from '../../../shared/contracts/turn-record-internal-state-ref.js';
import { buildTurnRecord } from './turn-records.js';
import { buildAuthenticityProvenance } from '../../../shared/authenticity-provenance.js';
import { CAPABILITY_TIER_CHANGE_NOTICE_PROVENANCE_NOTE } from '../../../system/capabilities/change-notice.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';

const TEST_FLEET_COMPANION_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('./moa-turn.js', async () => {
  const actual = await vi.importActual<typeof import('./moa-turn.js')>('./moa-turn.js');
  return {
    ...actual,
    runMoaTurn: vi.fn(),
  };
});

vi.mock('./vision-attachments.js', async () => {
  const actual = await vi.importActual<typeof import('./vision-attachments.js')>('./vision-attachments.js');
  return {
    ...actual,
    buildTurnUserContent: vi.fn(actual.buildTurnUserContent),
  };
});

const mockedRunMoaTurn = vi.mocked(runMoaTurn);
const mockedBuildTurnUserContent = vi.mocked(buildTurnUserContent);

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

beforeEach(() => {
  mockedRunMoaTurn.mockReset();
  mockedBuildTurnUserContent.mockClear();
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-turn-runtime-'));
  return tempDir;
}

function createRuntimeSessionManager(dataDir = makeTempDir()): SessionManager {
  return new SessionManager(
    new SessionStore(dataDir),
    makePersistenceConfig(dataDir),
  );
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

// The runtime.state seed layer is a REQUIRED render section (E2.5): the real
// buildDynamicPromptTemplateVariables always produces these tokens, so mocked
// variable builders must too or the turn fails loudly by design.
const BASE_TURN_PROMPT_VARIABLES: Record<string, string> = {
  runtime_last_message_received_present: 'false',
  runtime_last_message_received_missing: 'true',
  runtime_last_message_received_weekday: '',
  runtime_last_message_received_date_human: '',
  runtime_last_message_received_time_human: '',
  runtime_last_message_received_timezone: '',
  runtime_last_message_received_ago: '',
  runtime_internal_turn_kind: '',
  runtime_chat_type: 'direct_message',
  runtime_room_id: 'ch1',
  runtime_channel_type: 'api',
  runtime_channel_visibility: 'private',
  runtime_current_message_author_xml: '<current_message_author name="User" id="user-1" />',
  runtime_recent_active_participants_xml: '',
  runtime_participant_relationships_xml: '',
};

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
      companion_social: 100,
      background: 100,
      maintenance: 0,
      subagent: 100,
      shard: 100,
    },
    surfaceCosts: {
      localImageGeneration: 0,
      paidImageGeneration: 6,
      analysisWorkbenchExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
      companionSocialContinuation: 1,
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
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

function makePersistenceConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16_384, contextWindow: 4_096 },
    },
  };
}

class InMemoryFatigueBudgetHistory implements FatigueBudgetHistoryPort {
  readonly events: FatigueBudgetEvent[] = [];

  listFatigueEvents(query: NonNullable<Parameters<FatigueBudgetHistoryPort['listFatigueEvents']>[0]> = {}): FatigueBudgetEvent[] {
    return this.events.filter(event => (
      (query.localCompanionId === undefined || event.localCompanionId === query.localCompanionId)
      && (query.peerContactId === undefined || event.peerContactId === query.peerContactId)
      && (query.channelId === undefined || event.channelId === query.channelId)
      && (query.dayKey === undefined || event.dayKey === query.dayKey)
      && (query.decision === undefined || event.decision === query.decision)
    )).slice(0, query.limit);
  }

  recordFatigueEvent(event: FatigueBudgetEvent): void {
    this.events.push({
      ...event,
      triggeringAuthor: { ...event.triggeringAuthor },
      peer: { ...event.peer },
      ...(event.details ? { details: { ...event.details } } : {}),
      ...(event.lineage ? { lineage: { ...event.lineage } } : {}),
    });
  }
}

function createFatigueBudgetHarness() {
  const history = new InMemoryFatigueBudgetHistory();
  const fatigueBudget = new DeterministicFatigueBudgetPort(history, {
    now: () => Date.parse('2026-03-08T12:00:00Z'),
  });
  return { fatigueBudget, history };
}

function seedMachineIntelligenceFatigueSpend(input: {
  fatigueBudget: FatigueBudgetPort;
  count: number;
  channelId?: string;
  peerContactId?: string;
}): void {
  for (let index = 0; index < input.count; index += 1) {
    const evaluation = input.fatigueBudget.evaluate({
      localCompanionId: TEST_FLEET_COMPANION_ID,
      channelId: input.channelId ?? 'ch1',
      peer: {
        contactId: input.peerContactId ?? 'contact-mi',
        channelAuthorId: 'mi-user',
        displayName: 'Peer MI',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: input.peerContactId ?? 'contact-mi',
        channelAuthorId: 'mi-user',
        displayName: 'Peer MI',
        isMachineIntelligence: true,
      },
      limits: {
        softLimit: 2,
        hardLimit: 5,
        overchargeLimit: 2,
      },
      timestampMs: Date.now() + index,
    });
    input.fatigueBudget.recordFinalDecision(evaluation);
  }
}

function seedMachineIntelligenceOverchargeSpend(input: {
  fatigueBudget: FatigueBudgetPort;
  count: number;
  channelId?: string;
  peerContactId?: string;
}): void {
  for (let index = 0; index < input.count; index += 1) {
    const evaluation = input.fatigueBudget.evaluate({
      localCompanionId: TEST_FLEET_COMPANION_ID,
      channelId: input.channelId ?? 'ch1',
      peer: {
        contactId: input.peerContactId ?? 'contact-mi',
        channelAuthorId: 'mi-user',
        displayName: 'Peer MI',
        isMachineIntelligence: true,
      },
      triggeringAuthor: {
        role: 'machine_intelligence',
        contactId: input.peerContactId ?? 'contact-mi',
        channelAuthorId: 'mi-user',
        displayName: 'Peer MI',
        isMachineIntelligence: true,
      },
      limits: {
        softLimit: 2,
        hardLimit: 5,
        overchargeLimit: 2,
      },
      timestampMs: Date.now() + 10 + index,
    });
    input.fatigueBudget.recordFinalDecision(
      createOverchargeFatigueEvaluation(evaluation, 'overcharge_recent_human_participation'),
    );
  }
}

function machineIntelligenceAuthorContext(
  overrides: Partial<ResolvedAuthorContext> = {},
): ResolvedAuthorContext {
  return {
    trustLevel: 'regular',
    speakerRole: 'user',
    actorKind: 'machine_intelligence',
    resolvedUserName: 'Peer MI',
    speakingWithIsMachineIntelligence: true,
    relationshipType: 'acquaintance',
    canonicalContactKey: 'contact-mi',
    continuityFallbackKeys: [],
    ...overrides,
  };
}

function humanAuthorContext(
  overrides: Partial<ResolvedAuthorContext> = {},
): ResolvedAuthorContext {
  return {
    trustLevel: 'regular',
    speakerRole: 'user',
    actorKind: 'human',
    resolvedUserName: 'Human',
    canonicalContactKey: 'contact-human',
    continuityFallbackKeys: [],
    ...overrides,
  };
}

async function flushAsyncWork() {
  // E3.3 added one more pre-turn await (speaker-contact resolvability for the
  // envelope derivation), so the flush window covers a couple more microtasks.
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('handleMessageForTurn presence canonicalization', () => {
  it('promotes authority-resolved satellite presence into the turn context before author resolution', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn<SessionManager['buildContext']>(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      sessionPromptBlocks: [{ id: 'memory.retrieval', content: 'Session memory sentinel' }],
      messages: [
        { role: 'user', content: 'Earlier request' },
        { role: 'assistant', content: 'Earlier assistant reply' },
      ],
      manifest: makeContextManifestFixture(),
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
    const firstMoaCall = mockedRunMoaTurn.mock.calls[0];
    const firstBuildContextCall = buildContext.mock.calls[0];
    const [moaInput] = firstMoaCall;
    const assembledSystemPrompt = firstBuildContextCall[1];
    expect(moaInput.authoritativeSystemPrompt).toBe(assembledSystemPrompt);
    expect(assembledSystemPrompt).toContain('System prompt');
    expect(moaInput).toMatchObject({
      config: expect.objectContaining({
        chargePolicy: expect.objectContaining({
          runChargeQuotaByLane: expect.objectContaining({
            interactive: 100,
          }),
        }),
      }),
    });
    const moaPrompt = moaInput.prompt;
    expect(moaPrompt).not.toContain('System prompt');
    expect(moaPrompt).toContain('Session memory sentinel');
    expect(moaPrompt).toContain('assistant:\nEarlier assistant reply');
    expect(moaPrompt.match(/Hello there/g)).toHaveLength(1);
    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    expect(promptContext?.currentTurnInput).toBe('Hello there');
    expect(promptContext?.providerObservability).toMatchObject({
      backendModel: 'moa-model',
      providerWireMessages: [{ role: 'user', source: 'message', content: moaPrompt }],
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
  situated: {
    location: null,
  },
};

function createRuntime(params: {
  eventBus: EventBus;
  sessionManager: SessionManager;
  buildContext: ReturnType<typeof vi.fn>;
  scheduleAutoCompactionBetweenTurns: ReturnType<typeof vi.fn>;
  awaitPendingAutoCompaction: ReturnType<typeof vi.fn>;
  hasPendingAutoCompaction?: ReturnType<typeof vi.fn>;
  recordUserMessage: ReturnType<typeof vi.fn>;
  recordSystemMessage?: ReturnType<typeof vi.fn>;
  recordAssistantMessage: ReturnType<typeof vi.fn>;
  resolveAuthorContext?: ReturnType<typeof vi.fn>;
  buildTurnBudgetCharacteristics?: ReturnType<typeof vi.fn>;
  beginForegroundBackgroundWork?: ReturnType<typeof vi.fn>;
  endForegroundBackgroundWork?: ReturnType<typeof vi.fn>;
  enqueuePostTurnBackgroundWork?: ReturnType<typeof vi.fn>;
  backgroundWorkMaxAttempts?: number;
  consumeIntentionalNoReplyDecision?: ReturnType<typeof vi.fn>;
  memoryProvider?: TurnExecutionRuntime['memoryProvider'];
  imageVisionReviewer?: TurnExecutionRuntime['imageVisionReviewer'];
  emotionSelfModelRuntimeOverrides?: Partial<TurnExecutionRuntime['emotionSelfModelRuntime']>;
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null;
  fatigueBudget?: FatigueBudgetPort | null;
  humanAttentionPressure?: HumanAttentionPressurePort | null;
  fatigueRegulationReservations?: IcpFatigueRegulationReservationPort | null;
  durableChargeRecorder?: TurnExecutionRuntime['durableChargeRecorder'];
  durableChargeProbe?: TurnExecutionRuntime['durableChargeProbe'];
  configOverrides?: Partial<SubstrateConfig>;
  cogSecMode?: TurnExecutionRuntime['cogSecMode'];
}) {
  let currentTurnDisclosureLineage: ReturnType<
    TurnExecutionRuntime['getCurrentTurnDisclosureLineage']
  >;
  const agentState = {
    messages: fromAny([]),
    tools: fromAny([]),
    model: { id: 'test-model', provider: 'test', api: 'openai-completions' },
  };
  const emotionSelfModelRuntime = {
    assertSelfModelRuntimeConfigured: vi.fn(),
    observeEmotionState: vi.fn(async () => null),
    getEmotionAppraisalChain: vi.fn(() => []),
    getActiveConcernCount: vi.fn(() => 0),
    computeInternalStateForTurn: vi.fn(() => TEST_INTERNAL_STATE),
    computeMetacognitiveFlagsForTurn: vi.fn(() => []),
    triggerEmotionAppraisal: vi.fn(async () => undefined),
    reserveNarrativeEmotionAppraisal: vi.fn(() => ({
      schemaVersion: 1,
      mode: 'drift_only',
      baselineVad: { valence: -0.5, arousal: 0, dominance: 0 },
      targetVad: { valence: 0, arousal: 0, dominance: 0 },
      vadDelta: 0.5,
      threshold: 0.35,
    })),
    ...params.emotionSelfModelRuntimeOverrides,
  };
  const sessionManager = {
    buildContext: params.buildContext,
    captureTurnSessionContext: vi.fn(async (input: { channelId: string }) => ({
      channelId: input.channelId,
      recentEntries: [],
      sourceEntryCount: 0,
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [],
      versionPointer: 'mock-session-context',
    })),
    recordTurn: vi.fn(),
    hasRecordedTurn: vi.fn(() => false),
    findRecordedTurn: vi.fn(() => null),
    findSourceRecordedTurn: vi.fn(() => null),
    findUniqueSourceRecordedTurn: vi.fn(async () => null),
    resolveSessionForIngress: vi.fn((channelId: string) => channelId),
    appendSystemNote: vi.fn(),
    appendContextSystemNote: vi.fn(),
    awaitPendingAutoCompaction: params.awaitPendingAutoCompaction,
    hasPendingAutoCompaction: params.hasPendingAutoCompaction ?? vi.fn(() => false),
    scheduleAutoCompactionBetweenTurns: params.scheduleAutoCompactionBetweenTurns,
    getActiveFocusMemoryScopeQuery: vi.fn(() => null),
    getRecentMessages: vi.fn(() => []),
    getRecentMessagesAtOrBefore: vi.fn(() => []),
    getRoleEnvelopeRefsForEntries: vi.fn(() => []),
    captureAutoCompactionRecentEntries: vi.fn(() => []),
    reconcileSessionChannelFromDisk: vi.fn(async () => null),
    getRecentConversationSpeakers: vi.fn(() => []),
    resolveConversationScope: vi.fn((input: {
      channelId: string;
      channelMeta?: ChannelMeta;
      userId?: string;
      contact?: { contactId: string; displayName?: string };
    }) => resolveConversationScopeFromMetadata({
      channelId: input.channelId,
      isDirectMessage: input.channelMeta?.isDirectMessage,
      ...(input.channelMeta ? { channelMeta: input.channelMeta } : {}),
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.userId ? { participantId: input.userId } : {}),
    })),
    createCapturedSessionReads: vi.fn((
      _owner: CapturedSessionOwnerIdentity,
    ): CapturedSessionReads => {
      throw new Error('Captured session reads factory is not initialized');
    }),
    ...params.sessionManager,
  };
  const createMockCapturedSessionReadOperations = (
    owner: CapturedSessionOwnerIdentity,
  ): CapturedSessionReadOperations => ({
    buildContext: (...args) => sessionManager.buildContext(owner.logicalSessionId, ...args),
    captureTurnSessionContext: (input) => sessionManager.captureTurnSessionContext({
      ...input,
      channelId: owner.logicalSessionId,
    }),
    getRecentMessages: (limit) => sessionManager.getRecentMessages(owner.logicalSessionId, limit),
    getRecentMessagesAtOrBefore: (maxEntryId, limit) => (
      sessionManager.getRecentMessagesAtOrBefore(owner.logicalSessionId, maxEntryId, limit)
    ),
    getRoleEnvelopeRefsForEntries: (entryIds) => (
      sessionManager.getRoleEnvelopeRefsForEntries(owner.logicalSessionId, entryIds)
    ),
    scheduleAutoCompactionBetweenTurns: (input) => (
      sessionManager.scheduleAutoCompactionBetweenTurns({
        ...input,
        channelId: owner.logicalSessionId,
      })
    ),
    captureAutoCompactionRecentEntries: (input) => (
      sessionManager.captureAutoCompactionRecentEntries({
        ...input,
        channelId: owner.logicalSessionId,
      })
    ),
    hasPendingAutoCompaction: () => sessionManager.hasPendingAutoCompaction(owner.logicalSessionId),
    getActiveFocusMemoryScopeQuery: () => (
      sessionManager.getActiveFocusMemoryScopeQuery(owner.logicalSessionId)
    ),
    getRecentConversationSpeakers: () => (
      sessionManager.getRecentConversationSpeakers(owner.logicalSessionId)
    ),
    getPrivateRelationshipActivity: () => null,
    resolveConversationScope: (input) => sessionManager.resolveConversationScope({
      ...input,
      channelId: owner.logicalSessionId,
    }),
    reconcileSessionChannelFromDisk: () => (
      sessionManager.reconcileSessionChannelFromDisk(owner.logicalSessionId)
    ),
  });
  const createMockCapturedSessionReads = (
    owner: CapturedSessionOwnerIdentity,
  ): CapturedSessionReads => new CapturedSessionReads(
    sessionManager,
    owner,
    createMockCapturedSessionReadOperations(owner),
    channelId => {
      const foreignOwner = {
        logicalSessionId: channelId,
        sourceChannelId: channelId,
      };
      return {
        owner: foreignOwner,
        operations: createMockCapturedSessionReadOperations(foreignOwner),
      };
    },
  );
  sessionManager.createCapturedSessionReads = vi.fn(createMockCapturedSessionReads);
  const runtime = {
    eventBus: params.eventBus,
    costTelemetry: createEventBusCostTelemetryPort(params.eventBus),
    durableChargeRecorder: params.durableChargeRecorder ?? vi.fn(async () => undefined),
    durableChargeProbe: params.durableChargeProbe ?? vi.fn(async () => 'absent'),
    fatigueBudget: params.fatigueBudget ?? null,
    humanAttentionPressure: params.humanAttentionPressure ?? null,
    fatigueRegulationReservations: params.fatigueRegulationReservations ?? null,
    satellitePresence: createActiveEmanationSatellitePresencePort(),
    llmClient: {
      stream: vi.fn(),
      complete: vi.fn(),
    },
    imageVisionReviewer: params.imageVisionReviewer ?? null,
    cogSecMode: params.cogSecMode ?? 'enforce',
    sessionManager,
    config: {
      primaryModel: 'test-model',
      primaryProvider: 'test',
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 1024, contextWindow: 4096 },
      },
      ...(params.fatigueBudget || params.humanAttentionPressure
        ? {
            companionId: TEST_FLEET_COMPANION_ID,
            chargePolicy: makeChargePolicy(),
          }
        : {}),
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
    promptCacheRuntime: new PromptCacheTurnRuntime(),
    completionNotices: new CompletionNoticeBuffer(),
    memoryProvider: params.memoryProvider ?? null,
    memoryExtractor: null,
    skillsRuntime: null,
    evaluateReflectionNudge: vi.fn(() => null),
    emotionSelfModelRuntime,
    observerEvalSidecar: params.observerEvalSidecar ?? null,
    backgroundWorkMaxAttempts: params.backgroundWorkMaxAttempts ?? 5,
    pinDeferredContinuationSessionContext: vi.fn(() => () => undefined),
    beginForegroundBackgroundWork: params.beginForegroundBackgroundWork
      ?? vi.fn((logicalSessionId: string) => ({
        id: 'foreground-test',
        logicalSessionId,
        ready: Promise.resolve(),
        signal: new AbortController().signal,
      })),
    endForegroundBackgroundWork: params.endForegroundBackgroundWork ?? vi.fn(),
    enqueuePostTurnBackgroundWork: params.enqueuePostTurnBackgroundWork ?? vi.fn(async () => undefined),
    resolveTaskKind: vi.fn(() => undefined),
    buildTurnBudgetCharacteristics: params.buildTurnBudgetCharacteristics ?? vi.fn(() => ({ mode: 'default' })),
    resolveTurnCallType: vi.fn(() => 'chat'),
    buildTurnCorrelation: vi.fn((message, callType, turnId, requestId, logicalSessionId) => ({
      callType,
      purpose: 'agent.turn',
      turnId,
      requestId,
      channelId: message.channelId,
      sessionId: logicalSessionId,
    })),
    withCorrelationPurpose: vi.fn((correlation, purpose) => ({ ...correlation, purpose })),
    countResolvableSpeakerContacts: vi.fn(async () => 0),
    resolveParticipantRelationships: vi.fn(async () => []),
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
    resolveChannelType: vi.fn(() => 'api'),
    ensureModel: vi.fn(),
    captureTurnPromptSnapshot: vi.fn(() => ({})),
    buildScratchpadContextBlock: vi.fn(() => ''),
    normalizeTurnPromptOverride: vi.fn(() => ({ mode: 'default' })),
    resolveResponseStyle: vi.fn(() => 'concise'),
    buildPromptTemplateVariables: vi.fn(() => ({})),
    buildDynamicPromptTemplateVariables: vi.fn(async () => ({ ...BASE_TURN_PROMPT_VARIABLES })),
    setCurrentSelfModelState: vi.fn(async () => undefined),
    setCurrentTurnDisclosureLineage: vi.fn((lineage) => {
      currentTurnDisclosureLineage = lineage;
    }),
    getCurrentTurnDisclosureLineage: vi.fn(() => currentTurnDisclosureLineage),
    buildRuntimeContext: vi.fn(() => ''),
    buildPromptPrefixCacheKey: vi.fn(() => 'prompt-prefix'),
    buildStaticPromptSettingsHash: vi.fn(() => 'settings-hash'),
    resolveStaticPromptPrefix: vi.fn(async () => 'System prompt'),
    hashPromptText: vi.fn(() => 'prompt-hash'),
    getPersonaAdaptation: vi.fn(() => null),
    resolveContextWindow: vi.fn(() => 4096),
    resolveToolTurnOutcome: vi.fn(() => ({ intent: null })),
    getAdaptiveToolRuntimeState: vi.fn(() => ({
      generatedAt: Date.now(),
      coreTools: [],
      extendedTools: [],
      promotedToolsConfigured: [],
      promotedToolsActive: [],
      promotedToolsSkipped: [],
      activeTools: [],
      lastSnapshot: null,
    })),
    getActiveTurnTools: vi.fn(() => agentState.tools),
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
    recordToolObservations: vi.fn(() => []),
    recordAssistantMessage: params.recordAssistantMessage,
    buildTurnToolSummary: vi.fn(() => ({ toolCalls: [] })),
    inferPostTurnActions: vi.fn(async () => []),
    buildTurnRecord: vi.fn((input: Parameters<TurnExecutionRuntime['buildTurnRecord']>[0]) => ({
      schemaVersion: 1,
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      provenanceRefs: [],
      toolCalls: [],
      versionPointers: { model: input.response?.metadata.model ?? input.model ?? 'test-model' },
      userMessage: {
        role: 'user',
        content: input.persistedUserMessageContent ?? input.message.content,
        timestamp: input.message.timestamp.getTime(),
      },
      ...(input.response || input.assistantMessageContent !== undefined
        ? {
            assistantMessage: {
              role: 'assistant' as const,
              content: input.assistantMessageContent ?? input.response?.content ?? '',
              timestamp: input.completedAt,
            },
          }
        : {}),
      sessionId: input.turnSessionIdentity.logicalSessionId,
      channelId: input.turnSessionIdentity.sourceChannelId,
      channelType: input.message.channelType,
      requestId: input.requestId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: input.status ?? 'completed',
      turnId: input.turnId,
      ...(input.internalStateSnapshotRef
        ? { internalStateSnapshotRef: input.internalStateSnapshotRef }
        : {}),
      ...(input.message.routing?.icpCorrelation
        ? { icpCorrelation: input.message.routing.icpCorrelation }
        : {}),
    })),
    queueBackgroundContinuationCompletion: vi.fn(),
    emitBackgroundContinuationEvent: vi.fn(async () => undefined),
    dequeueBackgroundContinuationDeliveries: vi.fn(() => []),
    emitTelemetry: vi.fn(),
    consumeIntentionalNoReplyDecision: params.consumeIntentionalNoReplyDecision ?? vi.fn(() => null),
    runIntentionPostTurnHooks: vi.fn(async () => undefined),
  } as unknown as TurnAdmissionRuntime;

  return runtime;
}

function createPersistenceBackedRuntime(
  dataDir: string,
  eventBus: EventBus,
  storeOptions: SessionStoreOptions = {},
) {
  const store = new SessionStore(dataDir, storeOptions);
  const sessionManager = new SessionManager(store, makePersistenceConfig(dataDir));
  const turnSupportRuntime = new TurnSupportRuntime({
    eventBus,
    sessionManager,
    backgroundWorkSupervisor: null,
    hashPromptText: text => `hash:${text.length}`,
    resolveContextWindow: () => 4_096,
  });
  const buildContext = vi.fn(async () => ({
    systemPrompt: 'System prompt',
    messages: [],
    manifest: makeContextManifestFixture(),
  }));
  const runtime = createRuntime({
    eventBus,
    sessionManager: {} as SessionManager,
    buildContext,
    scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
    awaitPendingAutoCompaction: vi.fn(async () => undefined),
    recordUserMessage: vi.fn((...args: Parameters<TurnSupportRuntime['recordUserMessage']>) => (
      turnSupportRuntime.recordUserMessage(...args)
    )),
    recordAssistantMessage: vi.fn((...args: Parameters<TurnSupportRuntime['recordAssistantMessage']>) => (
      turnSupportRuntime.recordAssistantMessage(...args)
    )),
  });
  runtime.sessionManager.recordTurn = sessionManager.recordTurn.bind(sessionManager);
  runtime.sessionManager.appendContextSystemNote = sessionManager.appendContextSystemNote.bind(sessionManager);
  runtime.recordSystemMessage = turnSupportRuntime.recordSystemMessage.bind(turnSupportRuntime);
  runtime.recordToolObservations = turnSupportRuntime.recordToolObservations.bind(turnSupportRuntime);
  runtime.buildTurnRecord = turnSupportRuntime.buildTurnRecord.bind(turnSupportRuntime);
  runtime.extractResponseText = vi.fn(() => {
    const latestAssistant = [...(fromAny(runtime.agent.state.messages))]
      .reverse()
      .find(message => message.role === 'assistant');
    return Array.isArray(latestAssistant?.content)
      ? latestAssistant.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('')
      : typeof latestAssistant?.content === 'string'
        ? latestAssistant.content
        : '';
  });

  return { runtime, store, sessionManager, turnSupportRuntime };
}

describe('handleMessageForTurn MCP disclosure context', () => {
  it('publishes the admitted turn lineage before the model invocation', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      expect(runtime.getCurrentTurnDisclosureLineage()).toMatchObject({
        effectiveSensitivity: expect.any(String),
        sourceCount: 1,
      });
      runtime.agent.state.messages.push({ role: 'user', content: promptMessage.content });
      runtime.agent.state.messages.push({ role: 'assistant', content: 'assistant reply' });
    });

    await handleMessageForTurn(runtime, createMessage('msg-mcp-disclosure-context'));

    expect(runtime.setCurrentTurnDisclosureLineage).toHaveBeenCalled();
    expect(runtime.agent.prompt).toHaveBeenCalledOnce();
  });
});

describe('handleMessageForTurn intentional no-reply', () => {
  it('returns structured no-reply metadata and skips assistant persistence', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const noReply: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: 'response_control_tool',
      auditId: 'no-reply:test-turn:tool-call-1',
      decidedAt: Date.parse('2026-03-08T12:00:00Z'),
      turnId: '018f0000-0000-7000-9000-000000000001' as IntentionalNoReplyMetadata['turnId'],
      requestId: 'msg-no-reply',
      channelId: 'ch1',
      toolCallId: 'tool-call-1',
      reason: 'resting intentionally',
    };
    const consumeIntentionalNoReplyDecision = vi.fn(() => noReply);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
      consumeIntentionalNoReplyDecision,
    });
    // Genuine silence: no user-facing reply text was authored this turn.
    runtime.extractResponseText = vi.fn(() => '');

    const response = await handleMessageForTurn(runtime, createMessage('msg-no-reply'));

    expect(response.content).toBe('');
    expect(response.metadata.noReply).toEqual(noReply);
    expect(recordAssistantMessage).not.toHaveBeenCalled();
    expect(consumeIntentionalNoReplyDecision).toHaveBeenCalledTimes(1);
    expect(runtime.buildTurnRecord).toHaveBeenCalledWith(expect.objectContaining({
      assistantSessionEntryId: null,
      response: expect.objectContaining({
        metadata: expect.objectContaining({ noReply }),
      }),
    }), expect.anything());
  });

  it('demotes a no-reply issued after a user-facing reply was authored and delivers the reply', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const noReply: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: 'response_control_tool',
      auditId: 'no-reply:test-turn:tool-call-2',
      decidedAt: Date.parse('2026-07-04T23:21:44Z'),
      turnId: '018f0000-0000-7000-9000-000000000002' as IntentionalNoReplyMetadata['turnId'],
      requestId: 'msg-demoted-no-reply',
      channelId: 'ch1',
      toolCallId: 'tool-call-2',
    };
    const consumeIntentionalNoReplyDecision = vi.fn(() => noReply);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
      consumeIntentionalNoReplyDecision,
    });
    // The user-facing reply authored before the internal continuation issued
    // its no_reply — it must be delivered, never silently dropped.

    const response = await handleMessageForTurn(runtime, createMessage('msg-demoted-no-reply'));

    expect(response.content).toBe('assistant reply');
    expect(response.metadata.noReply).toBeUndefined();
    expect(recordAssistantMessage).toHaveBeenCalledTimes(1);
    expect(runtime.emitTelemetry).toHaveBeenCalledWith(
      'agent.no_reply.demoted',
      expect.objectContaining({ auditId: noReply.auditId }),
    );
  });
});

describe('handleMessageForTurn outbound reply hygiene', () => {
  it('strips mimicked history stamps before persistence and channel dispatch', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
    });
    // The model mimicked the rendered-history stamp prefix on its own reply
    // (psfn-framework-2x37.10): the accepted turn text must reach persistence
    // and AgentResponse.content clean, on every line, including doubled stamps.
    runtime.extractResponseText = vi.fn(
      () => '[Mon 07-13-26 14:32] the kettle is on\n[Mon 07-13-26 14:32] [Mon 07-13-26 14:33] tea in five',
    );

    const response = await handleMessageForTurn(runtime, createMessage('msg-stamped'));

    expect(response.content).toBe('the kettle is on\ntea in five');
    expect(recordAssistantMessage).toHaveBeenCalledTimes(1);
    expect(recordAssistantMessage.mock.calls[0]?.[4]).toBe('the kettle is on\ntea in five');
  });

  it('leaves a stamp quoted mid-sentence in the reply untouched', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
    });
    const quoted = 'you sent that at [Mon 07-13-26 14:32] if I remember right';
    runtime.extractResponseText = vi.fn(() => quoted);

    const response = await handleMessageForTurn(runtime, createMessage('msg-quoted-stamp'));

    expect(response.content).toBe(quoted);
    expect(recordAssistantMessage.mock.calls[0]?.[4]).toBe(quoted);
  });

  it('heals an image-attachment claim without replacing the rest of the reply', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
    });
    runtime.extractResponseText = vi.fn(
      () => '*image attached*\nFresh selfie, exactly like you asked for.',
    );

    const response = await handleMessageForTurn(runtime, createMessage('msg-false-image-claim'));

    const healedReply = 'Fresh selfie, exactly like you asked for.';
    expect(response.content).toBe(healedReply);
    expect(response.content).not.toContain('I could not attach an image');
    expect(response.attachments).toBeUndefined();
    expect(recordAssistantMessage.mock.calls[0]?.[4]).toBe(healedReply);
    expect(runtime.emitTelemetry).toHaveBeenCalledWith(
      'agent.image_attachment_claim.rejected',
      expect.objectContaining({
        channelId: 'ch1',
        requestId: 'msg-false-image-claim',
      }),
    );
  });

  it('never delivers either marker from a same-line two-marker reply', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
    });
    runtime.extractResponseText = vi.fn(
      () => '*image attached* here you go [photo attached]',
    );

    const response = await handleMessageForTurn(runtime, createMessage('msg-two-false-image-claims'));

    expect(response.content).not.toMatch(/(?:image|photo) attached/iu);
    expect([
      'here you go',
      'I could not attach an image because no image tool completed successfully this turn. '
        + 'I need to call selfie_create or generate_image before saying an image is attached.',
    ]).toContain(response.content);
    expect(recordAssistantMessage.mock.calls[0]?.[4]).toBe(response.content);
  });

  it('uses the correction only when removing the claim leaves no reply', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
    });
    runtime.extractResponseText = vi.fn(() => 'Your selfie is attached below.');

    const response = await handleMessageForTurn(runtime, createMessage('msg-only-false-image-claim'));

    const correction = 'I could not attach an image because no image tool completed successfully this turn. '
      + 'I need to call selfie_create or generate_image before saying an image is attached.';
    expect(response.content).toBe(correction);
    expect(recordAssistantMessage.mock.calls[0]?.[4]).toBe(correction);
    expect(runtime.emitTelemetry).toHaveBeenCalledWith(
      'agent.image_attachment_claim.rejected',
      expect.objectContaining({
        channelId: 'ch1',
        requestId: 'msg-only-false-image-claim',
      }),
    );
  });

  it('replaces a zero-call image-edit success narration with a named failure', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
    });
    runtime.extractResponseText = vi.fn(
      () => "worked:true, 'image edit generated via fal (openai/gpt-image-2/edit), pending attachment delivery'",
    );

    const response = await handleMessageForTurn(runtime, createMessage('msg-zero-call-edit', {
      content: 'Please edit this photo to make the lighting warmer.',
    }));

    expect(response.content).toContain('image_edit_execution_unconfirmed');
    expect(response.content).toContain('no successful generate_image action="edit" result');
    expect(response.attachments).toBeUndefined();
    expect(recordAssistantMessage.mock.calls[0]?.[4]).toBe(response.content);
    expect(runtime.emitTelemetry).toHaveBeenCalledWith(
      'agent.image_edit_request.unfulfilled',
      expect.objectContaining({
        channelId: 'ch1',
        requestId: 'msg-zero-call-edit',
      }),
    );
  });

  it('emits telemetry when a final response only narrates a pending tool action', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        buildContext,
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
    });
    runtime.extractResponseText = vi.fn(() => 'Now updating to in_progress.');

    await handleMessageForTurn(runtime, createMessage('msg-unfinished-tool-narration'));

    expect(runtime.emitTelemetry).toHaveBeenCalledWith(
      'agent.tool_execution_narration.unfinished',
      expect.objectContaining({
        channelId: 'ch1',
        requestId: 'msg-unfinished-tool-narration',
      }),
    );
  });
});

describe('handleMessageForTurn generated media delivery', () => {
  it('turns successful media tool results into response attachments for chat egress', async () => {
    const eventBus = new EventBus();
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const companionDataDir = makeTempDir();
    const personalImagesDir = join(companionDataDir, 'images');
    mkdirSync(personalImagesDir);
    const localPath = join(personalImagesDir, 'generated-purr.png');
    writeFileSync(localPath, Buffer.from('png-bytes'));
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      configOverrides: {
        companionDataDir,
        workspacePath: companionDataDir,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally preserves its Promise-returning lifecycle contract.
    (runtime.agent.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-media-1',
          name: 'media',
          arguments: { prompt: 'a purring cat on a server rack' },
        }],
        stopReason: 'toolUse',
      });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'toolResult',
        toolCallId: 'call-media-1',
        toolName: 'media',
        isError: false,
        timestamp: 1_700_000_100_180,
        content: [{ type: 'text', text: 'Generated 1 image.' }],
        details: {
          mediaResult: {
            provider: 'fal',
            mode: 'create',
            requestId: 'image-request-1',
            images: [{
              url: 'https://images.example.test/purr.png',
              contentType: 'image/png',
              fileName: 'purr.png',
              localPath,
            }],
          },
        },
      });
      (fromAny(runtime.agent.state.messages)).push({ role: 'assistant', content: 'Here is the image.' });
    });
    runtime.extractResponseText = vi.fn(() => 'Here is the image.');

    const response = await handleMessageForTurn(runtime, createMessage('msg-generated-media'));

    const expectedAttachment = {
      url: 'https://images.example.test/purr.png',
      contentType: 'image/png',
      name: 'purr.png',
      localPath,
    };
    expect(response.attachments).toEqual([expectedAttachment]);
    expect(runtime.recordToolObservations).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-generated-media' }),
      expect.objectContaining({ sourceChannelId: 'ch1', logicalSessionId: 'ch1' }),
      expect.any(String),
      'msg-generated-media',
      expect.arrayContaining([
        expect.objectContaining({
          role: 'toolResult',
          toolName: 'media',
          details: expect.objectContaining({
            mediaResult: expect.objectContaining({
              images: [expect.objectContaining({ localPath })],
            }),
          }),
        }),
      ]),
      'regular',
    );
    expect(runtime.buildTurnRecord).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({
        attachments: [expectedAttachment],
      }),
      turnMessages: expect.arrayContaining([
        expect.objectContaining({
          role: 'toolResult',
          toolName: 'media',
        }),
      ]),
    }), expect.anything());
    expect(emitSpy).toHaveBeenCalledWith('agent.turn.end', expect.objectContaining({
      response: expect.objectContaining({
        attachments: [expectedAttachment],
      }),
    }));
  });

  it('queues high-sensitivity generated media instead of sending it to a public audience', async () => {
    const eventBus = new EventBus();
    const companionDataDir = makeTempDir();
    const personalImagesDir = join(companionDataDir, 'images');
    mkdirSync(personalImagesDir);
    const localPath = join(personalImagesDir, 'private-art.png');
    writeFileSync(localPath, Buffer.from('png-bytes'));
    const queue = new ConfirmationQueue({ idFactory: () => 'artifact-public-approval' });
    const notify = vi.fn(async () => ({ messageId: 'notice-public-art' }));
    const shareApprovedArtifacts = vi.fn(async () => {});
    const runtime = createRuntime({
      eventBus,
      sessionManager: createRuntimeSessionManager(companionDataDir),
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        getActiveMemoryContext: vi.fn(() => ({
          key: 'active-memory:public-art',
          subjectKey: 'channel:public-art',
          channelId: 'discord:public-art',
          trustLevel: 'regular',
          channelVisibility: 'public',
          visibilityScope: 'non_broadcast',
          contextBlock: 'private relationship context',
          contextChars: 28,
          selectedMemoryIds: ['private-memory'],
          artifactSensitivitySources: [{
            ref: 'memory:private-memory',
            sensitivity: 'confidential',
          }],
          generatedAt: Date.now(),
          lastRefreshStartedAt: Date.now(),
          refreshStatus: 'ready',
          versionPointer: 'active-memory-public-art-v1',
        })),
        refreshActiveMemoryContext: vi.fn(async () => null),
        retrieve: vi.fn(async () => ''),
      },
      configOverrides: {
        companionDataDir,
        workspacePath: companionDataDir,
      },
    });
    runtime.artifactApprovalQueue = createApprovalQueuePortFromConfirmationQueue(queue);
    runtime.artifactApprovalNotifier = { notify };
    runtime.shareApprovedArtifacts = shareApprovedArtifacts;
    vi.mocked(runtime.agent.prompt).mockImplementationOnce(async () => {
      runtime.agent.state.messages.push({ role: 'user', content: 'Create something for this public room.' });
      runtime.agent.state.messages.push({
        role: 'toolResult',
        toolCallId: 'call-private-art',
        toolName: 'generate_image',
        isError: false,
        content: [{ type: 'text', text: 'Generated 1 image.' }],
        details: {
          imageResult: {
            provider: 'fal',
            mode: 'create',
            requestId: 'private-art-request',
            fallbackUsed: false,
            images: [{
              url: 'https://images.example.test/private-art.png',
              contentType: 'image/png',
              fileName: 'private-art.png',
              localPath,
            }],
          },
        },
      });
      runtime.agent.state.messages.push({ role: 'assistant', content: 'Here is the art.' });
    });
    runtime.extractResponseText = vi.fn(() => 'Here is the art.');

    const response = await handleMessageForTurn(runtime, createMessage('msg-public-art', {
      channelId: 'discord:public-art',
      channelType: 'discord',
      isDirectMessage: false,
      routing: { channelPrivacy: 'public' },
    }));

    expect(response.content).toBe('');
    expect(response.attachments).toBeUndefined();
    expect(queue.listPending()).toEqual([
      expect.objectContaining({ id: 'artifact-public-approval', method: 'artifact.share' }),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(shareApprovedArtifacts).not.toHaveBeenCalled();
    expect(runtime.sessionManager.appendSystemNote).toHaveBeenCalledWith(
      'discord:public-art',
      expect.stringContaining('inherited confidential context'),
      'artifact_egress_approval',
      'discord:public-art',
    );
  });

  it('recovers response attachments from tracked paid deliverables when the turn transcript misses the tool result', async () => {
    const eventBus = new EventBus();
    const companionDataDir = makeTempDir();
    const personalImagesDir = join(companionDataDir, 'images');
    mkdirSync(personalImagesDir);
    const localPath = join(personalImagesDir, 'missed-transcript-purr.png');
    writeFileSync(localPath, Buffer.from('png-bytes'));
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      configOverrides: {
        companionDataDir,
        workspacePath: companionDataDir,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally preserves its Promise-returning lifecycle contract.
    (runtime.agent.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (promptMessage: { content: string }) => {
      notePendingPaidDeliverable({
        surface: 'paidImageGeneration',
        toolName: 'selfie_create',
        toolCallId: 'call-missed-transcript',
        identifier: 'image-request-missed-transcript',
        artifactCount: 1,
        artifactKind: 'image',
        provider: 'fal',
        mode: 'edit',
        artifacts: [{
          url: 'https://images.example.test/missed-transcript-purr.png',
          contentType: 'image/png',
          fileName: 'missed-transcript-purr.png',
          localPath,
        }],
      });
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: 'Your selfie is attached below.',
      });
    });
    runtime.extractResponseText = vi.fn(() => 'Your selfie is attached below.');

    const response = await handleMessageForTurn(runtime, createMessage('msg-missed-tool-result'));

    const expectedAttachment = {
      url: 'https://images.example.test/missed-transcript-purr.png',
      contentType: 'image/png',
      name: 'missed-transcript-purr.png',
      localPath,
    };
    expect(response.content).toBe('Your selfie is attached below.');
    expect(response.attachments).toEqual([expectedAttachment]);
    expect(runtime.emitTelemetry).not.toHaveBeenCalledWith(
      'agent.image_attachment_claim.rejected',
      expect.anything(),
    );
    expect(runtime.recordToolObservations).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-missed-tool-result' }),
      expect.objectContaining({ sourceChannelId: 'ch1', logicalSessionId: 'ch1' }),
      expect.any(String),
      'msg-missed-tool-result',
      expect.not.arrayContaining([
        expect.objectContaining({
          role: 'toolResult',
          toolName: 'selfie_create',
        }),
      ]),
      'regular',
    );
    expect(runtime.buildTurnRecord).toHaveBeenCalledWith(expect.objectContaining({
      response: expect.objectContaining({
        attachments: [expectedAttachment],
      }),
      turnMessages: expect.not.arrayContaining([
        expect.objectContaining({
          role: 'toolResult',
          toolName: 'selfie_create',
        }),
      ]),
    }), expect.anything());
  });

  it('drops a paid deliverable and emits no attachments when the turn ends in intentional no-reply', async () => {
    const eventBus = new EventBus();
    const companionDataDir = makeTempDir();
    const personalImagesDir = join(companionDataDir, 'images');
    mkdirSync(personalImagesDir);
    const localPath = join(personalImagesDir, 'no-reply-purr.png');
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const noReply: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: 'response_control_tool',
      auditId: 'no-reply:paid-turn:call-media-1',
      decidedAt: Date.parse('2026-07-04T02:33:00Z'),
      turnId: '018f0000-0000-7000-9000-000000000003' as IntentionalNoReplyMetadata['turnId'],
      requestId: 'msg-paid-no-reply',
      channelId: 'ch1',
      toolCallId: 'call-media-1',
    };
    const recordAssistantMessage = vi.fn(() => 2);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage,
      consumeIntentionalNoReplyDecision: vi.fn(() => noReply),
      configOverrides: {
        companionDataDir,
        workspacePath: companionDataDir,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally preserves its Promise-returning lifecycle contract.
    (runtime.agent.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'toolResult',
        toolCallId: 'call-media-1',
        toolName: 'media',
        isError: false,
        content: [{ type: 'text', text: 'Generated 1 image.' }],
        details: {
          mediaResult: {
            provider: 'fal',
            mode: 'create',
            requestId: 'image-request-1',
            images: [{
              url: 'https://images.example.test/purr.png',
              contentType: 'image/png',
              fileName: 'purr.png',
              localPath,
            }],
          },
        },
      });
    });
    runtime.extractResponseText = vi.fn(() => '');

    const response = await handleMessageForTurn(runtime, createMessage('msg-paid-no-reply'));

    // No-reply still suppresses egress; the paid drop is audited (WARN), never silent.
    expect(response.content).toBe('');
    expect(response.attachments).toBeUndefined();
    expect(response.metadata.noReply).toEqual(noReply);
    expect(recordAssistantMessage).not.toHaveBeenCalled();
  });
});

describe('handleMessageForTurn human attention pressure', () => {
  it('injects an internal boundary alert without suppressing the human turn', async () => {
    const buildContext = vi.fn(async (_channelId: string, fullPrompt: string) => ({
      systemPrompt: fullPrompt,
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const evaluate = vi.fn(() => ({
      schemaVersion: 1 as const,
      timestampMs: 1_000,
      localCompanionId: TEST_FLEET_COMPANION_ID,
      contactId: 'contact-human',
      channelId: 'ch1',
      trustLevel: 'public' as const,
      relationshipType: 'stranger' as const,
      channelContext: 'direct_mention' as const,
      weight: 2,
      pressureInWindow: 4,
      threshold: 3,
      decision: 'boundary_alert' as const,
      reason: 'threshold_reached' as const,
      suppressTurn: false as const,
      sourceMessageId: 'human-pressure',
      turnId: '01900000-0000-7000-8000-000000000001',
    }));
    const runtime = createRuntime({
      eventBus: new EventBus(),
      sessionManager: {
        resolveSessionChannelId: vi.fn(() => 'logical-session'),
      } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      humanAttentionPressure: { evaluate },
      resolveAuthorContext: vi.fn(() => humanAuthorContext({
        trustLevel: 'public',
        relationshipType: 'stranger',
      })),
    });

    const response = await handleMessageForTurn(runtime, createMessage('human-pressure', {
      isDirectMessage: false,
      routing: { responseMode: 'respond' },
    }));

    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'contact-human',
      channelId: 'ch1',
      trustLevel: 'public',
      relationshipType: 'stranger',
      channelContext: 'direct_mention',
      sourceMessageId: 'human-pressure',
      turnId: expect.any(String),
    }));
    expect(buildContext.mock.calls[0]?.[1]).toContain('<human_attention_boundary_alert');
    expect(buildContext.mock.calls[0]?.[1]).toContain('in your own voice');
    expect(runtime.agent.prompt).toHaveBeenCalledOnce();
    expect(response.content).toBe('assistant reply');
  });
});

describe('handleMessageForTurn fatigue enforcement', () => {
  function createFatigueRuntime(params: {
    fatigueBudget: FatigueBudgetPort;
    fatigueRegulationReservations?: IcpFatigueRegulationReservationPort;
    eventBus?: EventBus;
    buildContext?: ReturnType<typeof vi.fn>;
    resolveAuthorContext?: ReturnType<typeof vi.fn>;
    sessionManager?: Partial<SessionManager>;
    configOverrides?: Partial<SubstrateConfig>;
    recordAssistantMessage?: ReturnType<typeof vi.fn>;
    consumeIntentionalNoReplyDecision?: ReturnType<typeof vi.fn>;
    durableChargeRecorder?: TurnExecutionRuntime['durableChargeRecorder'];
  }) {
    const buildContext = params.buildContext ?? vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus: params.eventBus ?? new EventBus(),
      sessionManager: (params.sessionManager ?? {}) as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: params.recordAssistantMessage ?? vi.fn(() => 2),
      consumeIntentionalNoReplyDecision:
        params.consumeIntentionalNoReplyDecision ?? vi.fn(() => null),
      fatigueBudget: params.fatigueBudget,
      durableChargeRecorder: params.durableChargeRecorder,
      ...(params.fatigueRegulationReservations
        ? { fatigueRegulationReservations: params.fatigueRegulationReservations }
        : {}),
      configOverrides: params.configOverrides,
      countResolvableSpeakerContacts: vi.fn(async () => 0),
      resolveParticipantRelationships: vi.fn(async () => []),
      resolveAuthorContext: params.resolveAuthorContext ?? vi.fn(() => machineIntelligenceAuthorContext()),
    });
    return { runtime, buildContext };
  }

  function createInboundIcpFatigueMessage(input: {
    id: string;
    localCompanionId: string;
    peerCompanionId: string;
    turnId: string;
  }): SubstrateMessage {
    const channelId = `companion-dm:${input.localCompanionId}:${input.peerCompanionId}`;
    return createMessage(input.id, {
      channelId,
      channelType: 'companion',
      isDirectMessage: true,
      authorId: input.peerCompanionId,
      authorName: 'Peer MI',
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        icpCorrelation: {
          conversationId: '44444444-4444-4444-8444-444444444444',
          rootInitiationId: '99999999-9999-4999-8999-999999999999',
          initiatedByCompanionId: input.peerCompanionId,
          localCompanionId: input.peerCompanionId,
          peerCompanionId: input.localCompanionId,
          peerContactId: 'peer-local-contact',
          channelId,
          turnId: input.turnId,
          messageId: input.id,
          requestId: input.id,
          chargeLane: 'interactive',
          surface: 'companion_dm',
          costPurpose: 'conversation_turn',
          costOriginStage: 'initiation',
          fatigueDecision: 'allow',
        },
      },
    });
  }

  it('re-authorizes recovered private artifacts from current sidecars without duplicate delivery or approval', async () => {
    const { fatigueBudget } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const messageId = 'recovered-private-artifact';
    const turnId = createTurnId();
    const message = createInboundIcpFatigueMessage({
      id: messageId,
      localCompanionId,
      peerCompanionId,
      turnId,
    });
    const baseCorrelation = message.routing?.icpCorrelation;
    if (!baseCorrelation) throw new Error('test message requires ICP correlation');
    const recoveredCorrelation: IcpConversationCorrelation = {
      ...baseCorrelation,
      localCompanionId,
      peerCompanionId,
      peerContactId: 'contact-mi',
      turnId,
      messageId,
      requestId: messageId,
      costOriginStage: 'reply',
      fatigueDecision: 'not_evaluated',
    };
    const companionDataDir = makeTempDir();
    const localPath = join(companionDataDir, 'recovered-private-artifact.png');
    writeFileSync(localPath, Buffer.from('png-bytes'));
    writeFileSync(`${localPath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      sensitivityClassification: {
        schemaVersion: 1,
        sensitivity: 'confidential',
        basis: 'contested',
        classifiedAt: '2026-07-16T15:00:00.000Z',
        sources: [{ ref: 'turn:original', sensitivity: 'public' }],
        contests: [{
          actor: 'operator',
          previousSensitivity: 'public',
          sensitivity: 'confidential',
          reason: 'Current review found private source material.',
          contestedAt: '2026-07-16T15:00:00.000Z',
        }],
      },
    }));
    const recoveredResponse: AgentResponse = {
      content: 'Here is the recovered private artifact.',
      channelId: message.channelId,
      attachments: [{
        url: 'https://images.example.test/recovered-private-artifact.png',
        contentType: 'image/png',
        name: 'recovered-private-artifact.png',
        localPath,
      }],
      metadata: {
        model: 'recovered-model',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
        turnId,
        requestId: messageId,
        icpCorrelation: recoveredCorrelation,
      },
    };
    const queue = new ConfirmationQueue({ idFactory: () => 'recovered-private-approval' });
    const notify = vi.fn(async () => ({ messageId: 'recovered-private-notice' }));
    const shareApprovedArtifacts = vi.fn(async () => {});
    const finalizeDelivery = vi.fn(async () => undefined);
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      configOverrides: {
        companionId: localCompanionId,
        companionDataDir,
        workspacePath: companionDataDir,
      },
    });
    runtime.artifactApprovalQueue = createApprovalQueuePortFromConfirmationQueue(queue);
    runtime.artifactApprovalNotifier = { notify };
    runtime.shareApprovedArtifacts = shareApprovedArtifacts;

    const first = await handleMessageForTurn(runtime, message, {
      recoveredResponse,
      sourceAlreadyPersisted: true,
      finalizeDelivery,
    });
    const replay = await handleMessageForTurn(runtime, message, {
      recoveredResponse,
      sourceAlreadyPersisted: true,
      finalizeDelivery,
    });

    expect(first).toMatchObject({ content: '' });
    expect(first.attachments).toBeUndefined();
    expect(replay).toEqual(first);
    expect(finalizeDelivery).toHaveBeenCalledTimes(2);
    expect(finalizeDelivery).toHaveBeenNthCalledWith(1, first);
    expect(finalizeDelivery).toHaveBeenNthCalledWith(2, first);
    expect(queue.listPending()).toEqual([
      expect.objectContaining({ id: 'recovered-private-approval', method: 'artifact.share' }),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(shareApprovedArtifacts).not.toHaveBeenCalled();

    await queue.resolve(
      { id: 'recovered-private-approval', decision: 'approve' },
      { kind: 'operator', id: 'operator:test' },
    );
    const settledReplay = await handleMessageForTurn(runtime, message, {
      recoveredResponse,
      sourceAlreadyPersisted: true,
      finalizeDelivery,
    });
    expect(settledReplay).toEqual(first);
    expect(finalizeDelivery).toHaveBeenCalledTimes(3);
    expect(queue.listPending()).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(shareApprovedArtifacts).toHaveBeenCalledTimes(1);

    rmSync(`${localPath}.image-meta.json`);
    await expect(handleMessageForTurn(runtime, message, {
      recoveredResponse,
      sourceAlreadyPersisted: true,
      finalizeDelivery,
    })).rejects.toThrow('Artifact sensitivity metadata is unavailable');
    writeFileSync(`${localPath}.image-meta.json`, JSON.stringify({ schemaVersion: 1 }));
    await expect(handleMessageForTurn(runtime, message, {
      recoveredResponse,
      sourceAlreadyPersisted: true,
      finalizeDelivery,
    })).rejects.toThrow('Artifact sensitivity metadata is missing or invalid');
    expect(finalizeDelivery).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(shareApprovedArtifacts).toHaveBeenCalledTimes(1);
  });

  it('calls the model for a normal MI turn and records one spend after the assistant response', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const { runtime } = createFatigueRuntime({ fatigueBudget });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-normal', {
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }));

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(response.content).toBe('assistant reply');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'allowed_charged',
      shouldRecordSpend: true,
      recordedEvent: {
        amount: 1,
        spentAfter: 1,
      },
    });
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      amount: 1,
      decision: 'charged',
      peerContactId: 'contact-mi',
      channelId: 'ch1',
    });
  });

  it('rejects an invalid inbound companion correlation before persisting actor history', async () => {
    const { fatigueBudget } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      configOverrides: { companionId: localCompanionId },
    });
    const message = createInboundIcpFatigueMessage({
      id: 'invalid-inbound-before-persistence',
      localCompanionId,
      peerCompanionId,
      turnId: '77777777-7777-4777-8777-777777777799',
    });
    message.authorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    await expect(handleMessageForTurn(runtime, message))
      .rejects.toThrow('Inbound ICP initiation correlation does not match recipient identity/contact routing');
    expect(runtime.recordUserMessage).not.toHaveBeenCalled();
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
  });

  it('suppresses before the model when the durable cross-channel reservation loses the last slot', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const reserve = vi.fn(async () => ({
      outcome: 'exhausted' as const,
      normalSpentBefore: 5,
      overchargeSpentBefore: 0,
      relationshipPressure: 5,
      rootNormalSpent: 5,
      rootOverchargeSpent: 0,
      contributingReservationCount: 5,
    }));
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery: vi.fn(),
      handoff: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    const inboundCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: peerCompanionId,
      localCompanionId: peerCompanionId,
      peerCompanionId: localCompanionId,
      peerContactId: 'peer-local-contact',
      channelId,
      turnId: '77777777-7777-4777-8777-777777777777',
      messageId: 'companion-initiation:33333333-3333-4333-8333-333333333333',
      requestId: 'companion-initiation:33333333-3333-4333-8333-333333333333',
      chargeLane: 'interactive' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'allow' as const,
    };

    const response = await handleMessageForTurn(runtime, createMessage('inbound-icp-last-slot', {
      channelId,
      channelType: 'companion',
      isDirectMessage: true,
      authorId: peerCompanionId,
      authorName: 'Peer MI',
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        icpCorrelation: inboundCorrelation,
      },
    }));

    expect(reserve.mock.calls.map(([call]) => call.decision)).toEqual(['charged', 'overcharge']);
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(response.content).toBe('');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'suppressed_hard_exhausted',
      modelDisposition: 'suppressed',
      shouldRecordSpend: false,
      overchargeReasons: ['explicit_peer_invitation'],
      socialRegulation: {
        state: 'suppressed',
        relationshipPressure: 5,
      },
    });
    expect(response.metadata.icpCorrelation).toMatchObject({
      fatigueDecision: 'suppress',
      fatigueReasonCode: 'fatigue_exhausted',
    });
    expect(history.events).toHaveLength(0);
  });

  it('rebases a fresh directional budget onto pair-shared pressure before prompt assembly', async () => {
    const { fatigueBudget } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const reserve = vi.fn(async () => ({
      outcome: 'reserved' as const,
      reservationOutcome: 'pending' as const,
      normalSpentBefore: 0,
      overchargeSpentBefore: 0,
      relationshipPressure: 2,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingReservationCount: 2,
    }));
    const prepareDelivery = vi.fn(async () => undefined);
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery,
      handoff: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    const buildContext = vi.fn(async (_channelId: string, fullPrompt: string) => ({
      systemPrompt: fullPrompt,
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      buildContext,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    const inboundCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: peerCompanionId,
      localCompanionId: peerCompanionId,
      peerCompanionId: localCompanionId,
      peerContactId: 'peer-local-contact',
      channelId,
      turnId: '77777777-7777-4777-8777-777777777780',
      messageId: 'companion-initiation:33333333-3333-4333-8333-333333333336',
      requestId: 'companion-initiation:33333333-3333-4333-8333-333333333336',
      chargeLane: 'interactive' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'allow' as const,
    };

    const response = await runWithChargeContext({
      chargePolicy: runtime.config.chargePolicy!,
      eventBus: runtime.eventBus,
      lane: 'interactive',
      runId: 'inbound-icp-soft-race',
    }, async () => await handleMessageForTurn(runtime, createMessage('inbound-icp-soft-race', {
      channelId,
      channelType: 'companion',
      isDirectMessage: true,
      authorId: peerCompanionId,
      authorName: 'Peer MI',
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        icpCorrelation: inboundCorrelation,
      },
    }), { finalizeDelivery: vi.fn(async () => undefined) }));

    expect(runtime.agent.prompt).toHaveBeenCalledOnce();
    expect(buildContext.mock.calls[0]?.[1]).toContain('fatigue state soft_exhausted');
    expect(buildContext.mock.calls[0]?.[1]).toContain('charge lane: companion_social');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'wrap_up_charged',
      budget: { normalSpentBefore: 0 },
      socialRegulation: {
        state: 'charge_lane_active',
        chargeLane: 'companion_social',
        marginalChargeUnits: 1,
        relationshipPressure: 2,
      },
    });
    expect(response.metadata.icpCorrelation).toMatchObject({
      fatigueDecision: 'allow',
      chargeLane: 'companion_social',
    });
    expect(prepareDelivery).toHaveBeenCalledOnce();
  });

  it('uses the fenced overcharge slot when a work turn crosses the hard boundary', async () => {
    const { fatigueBudget } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const reserve = vi.fn(async (input: Parameters<IcpFatigueRegulationReservationPort['reserve']>[0]) => ({
      outcome: input.decision === 'charged' ? 'exhausted' as const : 'reserved' as const,
      normalSpentBefore: input.hardLimit,
      overchargeSpentBefore: 0,
      relationshipPressure: input.hardLimit,
      rootNormalSpent: input.hardLimit,
      rootOverchargeSpent: 0,
      contributingReservationCount: input.hardLimit,
    }));
    const finalize = vi.fn(async () => undefined);
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery: vi.fn(),
      handoff: vi.fn(),
      finalize,
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    runtime.resolveTaskKind = vi.fn(message => resolveChannelTaskKind(message, {
      get: () => undefined,
    }));
    const inboundCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: localCompanionId,
      localCompanionId,
      peerCompanionId,
      peerContactId: 'contact-mi',
      channelId,
      turnId: createTurnId(),
      messageId: 'companion-initiation:33333333-3333-4333-8333-333333333337',
      requestId: 'companion-initiation:33333333-3333-4333-8333-333333333337',
      chargeLane: 'interactive' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'allow' as const,
    };

    const response = await runWithChargeContext({
      chargePolicy: runtime.config.chargePolicy!,
      eventBus: runtime.eventBus,
      lane: 'interactive',
      runId: 'inbound-icp-hard-work-race',
    }, async () => await handleMessageForTurn(runtime, createMessage(inboundCorrelation.requestId, {
      channelId,
      channelType: 'companion',
      isDirectMessage: true,
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        privateTurnTrigger: true,
        icpContinuationTaskKind: 'work',
        icpCorrelation: inboundCorrelation,
      },
    }), { finalizeDelivery: vi.fn(async () => undefined) }));

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls.map(([call]) => call.decision)).toEqual(['charged', 'overcharge']);
    expect(runtime.agent.prompt).toHaveBeenCalledOnce();
    expect(response.metadata.icpCorrelation).toMatchObject({
      fatigueDecision: 'allow_overcharge',
      chargeLane: 'companion_social',
    });
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'overcharge_charged',
      spendDecision: 'overcharge',
      overchargePermitted: true,
      overchargeReasons: ['work_intent_wrapup'],
      socialRegulation: {
        state: 'overcharge_closeout',
        continuationEvidence: ['active_work_or_research'],
      },
    });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'delivered',
      fatigue: expect.objectContaining({ spendDecision: 'overcharge' }),
    }));
  });

  it('uses verified inbound initiation lineage as explicit invitation evidence', async () => {
    const { fatigueBudget } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const reserve = vi.fn(async (input: Parameters<IcpFatigueRegulationReservationPort['reserve']>[0]) => ({
      outcome: input.decision === 'charged' ? 'exhausted' as const : 'reserved' as const,
      normalSpentBefore: input.hardLimit,
      overchargeSpentBefore: 0,
      relationshipPressure: input.hardLimit,
      rootNormalSpent: input.hardLimit,
      rootOverchargeSpent: 0,
      contributingReservationCount: input.hardLimit,
    }));
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery: vi.fn(),
      handoff: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    const messageId = 'companion-initiation:33333333-3333-4333-8333-333333333339';
    const correlation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: peerCompanionId,
      localCompanionId: peerCompanionId,
      peerCompanionId: localCompanionId,
      peerContactId: 'peer-local-contact',
      channelId,
      turnId: createTurnId(),
      messageId,
      requestId: messageId,
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'allow' as const,
    };

    const response = await runWithChargeContext({
      chargePolicy: runtime.config.chargePolicy!,
      eventBus: runtime.eventBus,
      lane: 'interactive',
      runId: 'inbound-explicit-invitation',
    }, async () => await handleMessageForTurn(runtime, createMessage(messageId, {
        channelId,
        channelType: 'companion',
        isDirectMessage: true,
        authorId: peerCompanionId,
        authorName: 'Peer MI',
        routing: {
          source: 'companion',
          canonicalContactId: 'contact-mi',
          authorIsMachineIntelligence: true,
          icpCorrelation: correlation,
        },
      }), { finalizeDelivery: vi.fn(async () => undefined) }));

    expect(reserve.mock.calls.map(([call]) => call.decision)).toEqual(['charged', 'overcharge']);
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'overcharge_charged',
      overchargeReasons: ['explicit_peer_invitation'],
      socialRegulation: {
        continuationEvidence: ['explicit_peer_invitation'],
      },
    });
    expect(runtime.agent.prompt).toHaveBeenCalledOnce();
  });

  it('suppresses without a model call when the fenced overcharge retry loses its race', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const reserve = vi.fn(async (input: Parameters<IcpFatigueRegulationReservationPort['reserve']>[0]) => ({
      outcome: 'exhausted' as const,
      normalSpentBefore: input.hardLimit,
      overchargeSpentBefore: input.decision === 'overcharge' ? input.overchargeLimit : 0,
      relationshipPressure: input.hardLimit,
      rootNormalSpent: input.hardLimit,
      rootOverchargeSpent: input.decision === 'overcharge' ? input.overchargeLimit : 0,
      contributingReservationCount: input.hardLimit,
    }));
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery: vi.fn(),
      handoff: vi.fn(),
      finalize: vi.fn(),
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    runtime.resolveTaskKind = vi.fn(() => 'work');
    const inboundCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: peerCompanionId,
      localCompanionId: peerCompanionId,
      peerCompanionId: localCompanionId,
      peerContactId: 'peer-local-contact',
      channelId,
      turnId: '77777777-7777-4777-8777-777777777782',
      messageId: 'companion-initiation:33333333-3333-4333-8333-333333333338',
      requestId: 'companion-initiation:33333333-3333-4333-8333-333333333338',
      chargeLane: 'interactive' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'allow' as const,
    };

    const response = await handleMessageForTurn(runtime, createMessage('inbound-icp-hard-work-loser', {
      channelId,
      channelType: 'companion',
      isDirectMessage: true,
      authorId: peerCompanionId,
      authorName: 'Peer MI',
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        icpCorrelation: inboundCorrelation,
      },
    }));

    expect(reserve).toHaveBeenCalledTimes(2);
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'suppressed_hard_exhausted',
      shouldRecordSpend: false,
      overchargeEligible: true,
      overchargeBlockedReasons: ['overcharge_reserve_exhausted'],
    });
    expect(history.events).toHaveLength(0);
  });

  it('reserves before the model and finalizes the exact spend after durable delivery', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const correlation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: peerCompanionId,
      localCompanionId: peerCompanionId,
      peerCompanionId: localCompanionId,
      peerContactId: 'peer-local-contact',
      channelId,
      turnId: '77777777-7777-4777-8777-777777777778',
      messageId: 'companion-initiation:33333333-3333-4333-8333-333333333334',
      requestId: 'companion-initiation:33333333-3333-4333-8333-333333333334',
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'reply' as const,
      fatigueDecision: 'allow' as const,
    };
    const reserve = vi.fn(async () => ({
      outcome: 'reserved' as const,
      reservationOutcome: 'pending' as const,
      normalSpentBefore: 0,
      overchargeSpentBefore: 0,
      relationshipPressure: 0,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingReservationCount: 0,
    }));
    const prepareDelivery = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery,
      handoff: vi.fn(),
      finalize,
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    const finalizeDelivery = vi.fn(async () => undefined);

    const response = await handleMessageForTurn(runtime, createMessage(correlation.requestId, {
      channelId,
      channelType: 'companion',
      isDirectMessage: true,
      authorId: peerCompanionId,
      authorName: 'Peer MI',
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        icpCorrelation: correlation,
      },
    }), { finalizeDelivery });

    expect(reserve).toHaveBeenCalledOnce();
    expect(runtime.agent.prompt).toHaveBeenCalledOnce();
    expect(finalizeDelivery).toHaveBeenCalledOnce();
    expect(prepareDelivery).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({
      correlation: expect.objectContaining({
        conversationId: correlation.conversationId,
        rootInitiationId: correlation.rootInitiationId,
        localCompanionId,
        peerCompanionId,
        peerContactId: 'contact-mi',
      }),
      outcome: 'delivered',
      fatigue: expect.objectContaining({
        spendDecision: 'charged',
        recordedEvent: expect.objectContaining({ amount: 1, decision: 'charged' }),
        socialRegulation: expect.objectContaining({
          rootInitiationId: correlation.rootInitiationId,
        }),
      }),
    }));
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(
      (runtime.agent.prompt as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(prepareDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeDelivery.mock.invocationCallOrder[0]!,
    );
    expect(finalizeDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      finalize.mock.invocationCallOrder[0]!,
    );
    expect(response.metadata.fatigue?.recordedEvent).toMatchObject({ amount: 1 });
    expect(history.events).toHaveLength(1);
  });

  it('fails closed before model or delivery when durable social charge persistence fails', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const reserve = vi.fn(async () => ({
      outcome: 'reserved' as const,
      reservationOutcome: 'pending' as const,
      normalSpentBefore: 0,
      overchargeSpentBefore: 0,
      relationshipPressure: 2,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingReservationCount: 2,
    }));
    const prepareDelivery = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const handoff = vi.fn(async () => undefined);
    const durableChargeRecorder = vi.fn(async () => {
      throw new Error('charge ledger is read-only');
    });
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: {
        reserve,
        readInitiationPressure: vi.fn(),
        prepareDelivery,
        handoff,
        finalize,
        close: vi.fn(),
      },
      durableChargeRecorder,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    const finalizeDelivery = vi.fn(async () => undefined);

    const message = createInboundIcpFatigueMessage({
      id: 'icp-charge-ledger-failure',
      localCompanionId,
      peerCompanionId,
      turnId: '77777777-7777-4777-8777-777777777798',
    });
    if (!message.routing?.icpCorrelation) throw new Error('test requires ICP correlation');
    message.routing.icpCorrelation = {
      ...message.routing.icpCorrelation,
      chargeLane: 'companion_social',
    };
    await expect(runWithChargeContext({
      chargePolicy: makeChargePolicy(),
      eventBus: runtime.eventBus,
      lane: 'interactive',
      runId: message.id,
    }, async () => await handleMessageForTurn(runtime, message, { finalizeDelivery })))
      .rejects.toThrow('charge ledger is read-only');

    expect(durableChargeRecorder).toHaveBeenCalledOnce();
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(finalizeDelivery).not.toHaveBeenCalled();
    expect(prepareDelivery).not.toHaveBeenCalled();
    expect(history.events).toHaveLength(0);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
    expect(handoff).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'model error', error: new Error('generation failed') },
    {
      label: 'cancellation',
      error: Object.assign(new Error('turn cancelled'), { name: 'AbortError' }),
    },
  ])('releases the pending session lease exactly once after $label', async ({ error }) => {
    const { fatigueBudget } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const reserve = vi.fn(async () => ({
      outcome: 'reserved' as const,
      reservationOutcome: 'pending' as const,
      normalSpentBefore: 0,
      overchargeSpentBefore: 0,
      relationshipPressure: 0,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingReservationCount: 0,
    }));
    const finalize = vi.fn(async () => undefined);
    const handoff = vi.fn(async () => undefined);
    const prepareDelivery = vi.fn(async () => undefined);
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery,
      handoff,
      finalize,
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });
    (runtime.agent.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(handleMessageForTurn(runtime, createInboundIcpFatigueMessage({
      id: `icp-${error.name.toLowerCase()}-failure`,
      localCompanionId,
      peerCompanionId,
      turnId: error.name === 'AbortError'
        ? '77777777-7777-4777-8777-777777777784'
        : '77777777-7777-4777-8777-777777777783',
    }))).rejects.toThrow(error.message);

    expect(reserve).toHaveBeenCalledOnce();
    expect(prepareDelivery).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
    expect(handoff).toHaveBeenCalledOnce();
  });

  it('hands a prepared delivering response to recovery when external delivery fails', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const reserve = vi.fn(async () => ({
      outcome: 'reserved' as const,
      reservationOutcome: 'pending' as const,
      normalSpentBefore: 0,
      overchargeSpentBefore: 0,
      relationshipPressure: 0,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingReservationCount: 0,
    }));
    const prepareDelivery = vi.fn(async () => undefined);
    const handoff = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery,
      handoff,
      finalize,
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
    });

    await expect(handleMessageForTurn(runtime, createInboundIcpFatigueMessage({
      id: 'icp-delivery-failure',
      localCompanionId,
      peerCompanionId,
      turnId: '77777777-7777-4777-8777-777777777785',
    }), {
      finalizeDelivery: vi.fn(async () => {
        throw new Error('delivery failed');
      }),
    })).rejects.toThrow('delivery failed');

    expect(prepareDelivery).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledOnce();
    expect(history.events).toHaveLength(1);
  });

  it.each([
    'fatigue_append',
    'prepare_delivery',
  ] as const)('writes intentional no-reply recovery before a crash at %s and replays without a second model call', async (crashPoint) => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const originalRecord = fatigueBudget.recordFinalDecision.bind(fatigueBudget);
    if (crashPoint === 'fatigue_append') {
      vi.spyOn(fatigueBudget, 'recordFinalDecision')
        .mockImplementationOnce(() => {
          throw new Error('simulated no-reply crash before fatigue append');
        })
        .mockImplementation((evaluation, input) => originalRecord(evaluation, input));
    }
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const messageId = `icp-no-reply-${crashPoint}`;
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const turnId = deriveDeterministicTurnId([
      'icp-reply',
      localCompanionId,
      channelId,
      messageId,
    ].join(':'));
    const noReply: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: 'response_control_tool',
      auditId: `no-reply:${turnId}:tool-call-1`,
      decidedAt: 10_000,
      turnId,
      requestId: messageId,
      channelId,
      toolCallId: 'tool-call-1',
    };
    const reserve = vi.fn(async () => ({
      outcome: 'reserved' as const,
      reservationOutcome: 'pending' as const,
      normalSpentBefore: 0,
      overchargeSpentBefore: 0,
      relationshipPressure: 0,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingReservationCount: 0,
    }));
    const prepareDelivery = vi.fn(async () => {
      if (crashPoint === 'prepare_delivery' && prepareDelivery.mock.calls.length === 1) {
        throw new Error('simulated no-reply crash after preparation');
      }
    });
    const handoff = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const reservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery,
      handoff,
      finalize,
      close: vi.fn(),
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: reservations,
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
      consumeIntentionalNoReplyDecision: vi.fn(() => noReply),
    });
    runtime.extractResponseText = vi.fn(() => '');
    const message = createInboundIcpFatigueMessage({
      id: messageId,
      localCompanionId,
      peerCompanionId,
      turnId: '77777777-7777-4777-8777-777777777790',
    });
    let durableNoReply: AgentResponse | undefined;
    const finalizeDelivery = vi.fn(async (response: AgentResponse) => {
      durableNoReply = structuredClone(response);
    });

    await expect(handleMessageForTurn(runtime, message, { finalizeDelivery }))
      .rejects.toThrow('simulated no-reply crash');
    expect(durableNoReply).toMatchObject({
      content: '',
      metadata: {
        noReply,
        fatiguePendingSpend: { amount: 1 },
      },
    });
    expect(handoff).toHaveBeenCalledOnce();
    const modelCallsBeforeRecovery = runtime.agent.prompt.mock.calls.length;
    if (!durableNoReply) throw new Error('test expected durable no-reply response');

    const recovered = await handleMessageForTurn(runtime, message, {
      recoveredResponse: durableNoReply,
      finalizeDelivery,
    });

    expect(recovered).toMatchObject({ content: '', metadata: { noReply } });
    expect(runtime.agent.prompt).toHaveBeenCalledTimes(modelCallsBeforeRecovery);
    expect(history.events).toHaveLength(1);
    expect(prepareDelivery).toHaveBeenCalledTimes(
      crashPoint === 'prepare_delivery' ? 2 : 1,
    );
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'no_reply' }));
    expect(finalize).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });

  it.each([
    { label: 'delivered reply', terminalOutcome: 'delivered' as const, noReply: false },
    { label: 'intentional no-reply', terminalOutcome: 'no_reply' as const, noReply: true },
  ])('replays $label after reservation finalization without delivery or ordinary-artifact duplication', async ({
    terminalOutcome,
    noReply,
  }) => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const messageId = `icp-terminal-replay-${terminalOutcome}`;
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const turnId = deriveDeterministicTurnId([
      'icp-reply',
      localCompanionId,
      channelId,
      messageId,
    ].join(':'));
    const noReplyMetadata: IntentionalNoReplyMetadata | null = noReply
      ? {
          schemaVersion: 1,
          disposition: 'intentional_no_reply',
          source: 'response_control_tool',
          auditId: `no-reply:${turnId}:tool-call-terminal`,
          decidedAt: 10_000,
          turnId,
          requestId: messageId,
          channelId,
          toolCallId: 'tool-call-terminal',
        }
      : null;
    let reservationOutcome: 'pending' | 'delivered' | 'no_reply' = 'pending';
    let reserveCalls = 0;
    const reserve = vi.fn(async () => {
      reserveCalls += 1;
      return {
        outcome: reserveCalls === 1 ? 'reserved' as const : 'replayed' as const,
        reservationOutcome,
        normalSpentBefore: 0,
        overchargeSpentBefore: 0,
        relationshipPressure: 0,
        rootNormalSpent: 0,
        rootOverchargeSpent: 0,
        contributingReservationCount: 0,
      };
    });
    const prepareDelivery = vi.fn(async () => undefined);
    const finalize = vi.fn(async (input: Parameters<IcpFatigueRegulationReservationPort['finalize']>[0]) => {
      if (input.outcome === 'failed') throw new Error('terminal replay must not fail the reservation');
      if (reservationOutcome !== 'pending' && reservationOutcome !== input.outcome) {
        throw new Error('reservation terminal outcome changed across replay');
      }
      reservationOutcome = input.outcome;
    });
    let recordedTurn: TurnRecord | null = null;
    const recordTurn = vi.fn((record: TurnRecord) => { recordedTurn = record; });
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations: {
        reserve,
        readInitiationPressure: vi.fn(),
        prepareDelivery,
        handoff: vi.fn(),
        finalize,
        close: vi.fn(),
      },
      configOverrides: { multiCompanion: true, companionId: localCompanionId },
      consumeIntentionalNoReplyDecision: vi.fn(() => noReplyMetadata),
      sessionManager: {
        recordTurn,
        hasRecordedTurn: vi.fn(() => recordedTurn?.status === 'completed'),
        findRecordedTurn: vi.fn(() => recordedTurn),
        findSourceRecordedTurn: vi.fn(() => recordedTurn),
        findUniqueSourceRecordedTurn: vi.fn(async () => recordedTurn),
      },
    });
    if (noReply) runtime.extractResponseText = vi.fn(() => '');
    const message = createInboundIcpFatigueMessage({
      id: messageId,
      localCompanionId,
      peerCompanionId,
      turnId: '77777777-7777-4777-8777-777777777797',
    });
    let durableResponse: AgentResponse | undefined;
    let durableDeliveryRecorded = false;
    let externalDeliveries = 0;
    const finalizeDelivery = vi.fn(async (response: AgentResponse) => {
      durableResponse = structuredClone(response);
      if (!durableDeliveryRecorded) {
        durableDeliveryRecorded = true;
        if (response.content.trim()) externalDeliveries += 1;
      }
    });

    const first = await handleMessageForTurn(runtime, message, { finalizeDelivery });
    expect(reservationOutcome).toBe(terminalOutcome);
    expect(first.metadata.noReply !== undefined).toBe(noReply);
    expect(durableResponse).toBeDefined();
    const modelCallsBeforeRecovery = runtime.agent.prompt.mock.calls.length;
    if (!durableResponse) throw new Error('test expected a durable terminal response');

    const recovered = await handleMessageForTurn(runtime, message, {
      recoveredResponse: durableResponse,
      sourceAlreadyPersisted: true,
      finalizeDelivery,
    });

    expect(recovered.content).toBe(first.content);
    expect(runtime.agent.prompt).toHaveBeenCalledTimes(modelCallsBeforeRecovery);
    expect(externalDeliveries).toBe(noReply ? 0 : 1);
    expect(history.events).toHaveLength(1);
    expect(recordTurn).toHaveBeenCalledOnce();
    expect(prepareDelivery).toHaveBeenLastCalledWith(expect.objectContaining({
      recoveredOutcome: terminalOutcome,
    }));
    expect(finalize).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: terminalOutcome,
    }));
  });

  it('recovers the pending fatigue spend after the assistant row survives a crash', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const originalRecord = fatigueBudget.recordFinalDecision.bind(fatigueBudget);
    vi.spyOn(fatigueBudget, 'recordFinalDecision')
      .mockImplementationOnce(() => {
        throw new Error('simulated crash before fatigue ledger append');
      })
      .mockImplementation((evaluation, input) => originalRecord(evaluation, input));
    let durableResponse: AgentResponse | undefined;
    const recordAssistantMessage = vi.fn((...args: unknown[]) => {
      durableResponse = args[8] as AgentResponse;
      return 2;
    });
    const reserve = vi.fn(async () => ({
      outcome: 'reserved' as const,
      reservationOutcome: 'pending' as const,
      normalSpentBefore: 0,
      overchargeSpentBefore: 0,
      relationshipPressure: 0,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingReservationCount: 0,
    }));
    const finalize = vi.fn(async () => undefined);
    const prepareDelivery = vi.fn(async () => undefined);
    const handoff = vi.fn(async () => undefined);
    const fatigueRegulationReservations: IcpFatigueRegulationReservationPort = {
      reserve,
      readInitiationPressure: vi.fn(),
      prepareDelivery,
      handoff,
      finalize,
      close: vi.fn(),
    };
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const correlation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: localCompanionId,
      localCompanionId,
      peerCompanionId,
      peerContactId: 'contact-mi',
      channelId,
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
      messageId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
      requestId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'allow' as const,
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      fatigueRegulationReservations,
      recordAssistantMessage,
      configOverrides: { companionId: localCompanionId },
      resolveAuthorContext: vi.fn(() => machineIntelligenceAuthorContext({
        canonicalContactKey: 'contact-mi',
      })),
    });
    const message = createMessage(correlation.requestId, {
      channelId,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      isDirectMessage: true,
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        privateTurnTrigger: true,
        broadcast: {
          approvalToken: 'ephemeral-broadcast-secret',
          visibilityScope: 'approved_private_context',
        },
        icpCorrelation: correlation,
      },
    });

    runtime.buildPromptTemplateVariables = vi.fn(() => ({
      personality: 'private free-form personality prose',
    }));
    runtime.sessionManager.captureTurnSessionContext = vi.fn(async () => ({
      channelId: correlation.channelId,
      recentEntries: [],
      sourceEntryCount: 0,
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [],
      compactionPromptText: 'private pinned compaction prompt',
      versionPointer: 'mock-session-context',
    }));

    await expect(handleMessageForTurn(runtime, message, {
      finalizeDelivery: async () => undefined,
    })).rejects.toThrow('simulated crash');
    expect(reserve).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledOnce();
    expect(history.events).toHaveLength(0);
    expect(durableResponse?.metadata.fatiguePendingSpend).toMatchObject({
      amount: 1,
      correlation: { turnId: correlation.turnId },
    });
    if (!durableResponse) throw new Error('test expected durable recovery response');
    const parsedDurableResponse = parseIcpRecoveryResponse(durableResponse, {
      label: 'runtime durable recovery response',
      expectedChannelId: channelId,
      expectedSourceMessageId: correlation.messageId,
    });
    expect(parsedDurableResponse).toMatchObject({
      content: durableResponse.content,
      channelId,
      metadata: {
        internalStateSnapshotRef: durableResponse.metadata.internalStateSnapshotRef,
        fatigue: durableResponse.metadata.fatigue,
        fatiguePendingSpend: durableResponse.metadata.fatiguePendingSpend,
      },
    });
    const forgedContactRecovery = structuredClone(durableResponse);
    const forgedCorrelation = {
      ...correlation,
      peerContactId: 'forged-contact',
    };
    forgedContactRecovery.metadata.icpCorrelation = forgedCorrelation;
    if (!forgedContactRecovery.metadata.fatigue
      || !forgedContactRecovery.metadata.fatiguePendingSpend) {
      throw new Error('test expected fatigue metadata for forged contact recovery');
    }
    forgedContactRecovery.metadata.fatigue = {
      ...forgedContactRecovery.metadata.fatigue,
      scope: {
        ...forgedContactRecovery.metadata.fatigue.scope,
        peerContactId: 'forged-contact',
      },
      peer: {
        ...forgedContactRecovery.metadata.fatigue.peer,
        contactId: 'forged-contact',
      },
      triggeringAuthor: {
        ...forgedContactRecovery.metadata.fatigue.triggeringAuthor,
        contactId: 'forged-contact',
      },
    };
    forgedContactRecovery.metadata.fatiguePendingSpend = {
      ...forgedContactRecovery.metadata.fatiguePendingSpend,
      scope: {
        ...forgedContactRecovery.metadata.fatiguePendingSpend.scope,
        peerContactId: 'forged-contact',
      },
      peer: {
        ...forgedContactRecovery.metadata.fatiguePendingSpend.peer,
        contactId: 'forged-contact',
      },
      triggeringAuthor: {
        ...forgedContactRecovery.metadata.fatiguePendingSpend.triggeringAuthor,
        contactId: 'forged-contact',
      },
      correlation: {
        ...forgedContactRecovery.metadata.fatiguePendingSpend.correlation,
        icpCorrelation: forgedCorrelation,
      },
    };
    const promptCallsBeforeForgedRecovery = runtime.agent.prompt.mock.calls.length;
    await expect(handleMessageForTurn(runtime, message, {
      recoveredResponse: forgedContactRecovery,
      finalizeDelivery: async () => undefined,
    })).rejects.toThrow(/canonical contact/i);
    expect(runtime.agent.prompt).toHaveBeenCalledTimes(promptCallsBeforeForgedRecovery);
    expect(history.events).toHaveLength(0);

    const pendingSpend = durableResponse.metadata.fatiguePendingSpend;
    const fatigue = durableResponse.metadata.fatigue;
    if (!pendingSpend || !fatigue) {
      throw new Error('test expected durable fatigue recovery metadata');
    }
    const suppliedRecordedEvent = {
      timestampMs: pendingSpend.timestampMs,
      amount: pendingSpend.amount,
      decision: pendingSpend.decision,
      reason: pendingSpend.reason,
      spentAfter: 99,
      remainingAllowance: 0,
      normalSpentAfter: 99,
      overchargeSpentAfter: 0,
      overchargeAllowance: pendingSpend.limits.overchargeLimit,
      remainingOvercharge: pendingSpend.limits.overchargeLimit,
      softState: 'soft_limit_reached' as const,
      hardState: 'exhausted' as const,
    };
    const markedRecovery = structuredClone(durableResponse);
    markedRecovery.metadata.fatigue = {
      ...fatigue,
      recordedEvent: suppliedRecordedEvent,
    };
    const recordPendingSpend = vi.spyOn(fatigueBudget, 'recordPendingSpend');
    const recovered = await handleMessageForTurn(runtime, message, {
      recoveredResponse: markedRecovery,
      finalizeDelivery: async () => undefined,
    });
    const replayedRecovery = await handleMessageForTurn(runtime, message, {
      recoveredResponse: markedRecovery,
      finalizeDelivery: async () => undefined,
    });
    const parsedRecovered = parseIcpRecoveryResponse(recovered, {
      label: 'runtime completed recovery response',
      expectedChannelId: channelId,
      expectedSourceMessageId: correlation.messageId,
    });

    expect(recordPendingSpend).toHaveBeenCalledTimes(2);
    expect(history.events).toHaveLength(1);
    const ledgerEvent = history.events[0];
    expect(ledgerEvent).toBeDefined();
    const authoritativeRecordedEvent = {
      timestampMs: ledgerEvent.timestampMs,
      amount: ledgerEvent.amount,
      decision: ledgerEvent.decision,
      reason: ledgerEvent.reason,
      spentAfter: ledgerEvent.spentAfter,
      remainingAllowance: ledgerEvent.remainingAllowance,
      normalSpentAfter: ledgerEvent.normalSpentAfter,
      overchargeSpentAfter: ledgerEvent.overchargeSpentAfter,
      overchargeAllowance: ledgerEvent.overchargeAllowance,
      remainingOvercharge: ledgerEvent.remainingOvercharge,
      softState: ledgerEvent.softState,
      hardState: ledgerEvent.hardState,
    };
    expect(parsedRecovered.metadata.fatigue?.recordedEvent)
      .toEqual(authoritativeRecordedEvent);
    expect(parsedRecovered.metadata.fatigue?.recordedEvent)
      .not.toEqual(suppliedRecordedEvent);
    expect(replayedRecovery.metadata.fatigue?.recordedEvent)
      .toEqual(parsedRecovered.metadata.fatigue?.recordedEvent);
    expect(history.events[0]).toMatchObject({
      timestampMs: pendingSpend.timestampMs,
      amount: pendingSpend.amount,
      decision: pendingSpend.decision,
      reason: pendingSpend.reason,
    });
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(prepareDelivery).toHaveBeenCalledTimes(2);
    expect(finalize).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'delivered' }),
    );
  });

  it('uses the durable completed-turn marker to avoid scheduling post-turn work twice', async () => {
    const { fatigueBudget } = createFatigueBudgetHarness();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const sourceMessageId = 'companion-initiation:33333333-3333-4333-8333-333333333333';
    const correlation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: localCompanionId,
      localCompanionId,
      peerCompanionId,
      peerContactId: 'contact-mi',
      channelId,
      turnId: deriveDeterministicTurnId('post-turn-completion-marker-test'),
      messageId: sourceMessageId,
      requestId: sourceMessageId,
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'not_evaluated' as const,
    };
    const recoveredResponse: AgentResponse = {
      content: '',
      channelId,
      metadata: {
        model: 'durable-suppression',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
        turnId: correlation.turnId,
        requestId: correlation.requestId,
        icpCorrelation: correlation,
      },
    };
    const enqueuePostTurnBackgroundWork = vi.fn(async () => undefined);
    const recordTurn = vi.fn();
    const completedTurnRecord: TurnRecord = {
      schemaVersion: 1,
      turnId: correlation.turnId,
      requestId: correlation.requestId,
      sessionId: channelId,
      channelId,
      channelType: 'companion',
      startedAt: 1,
      completedAt: 2,
      status: 'completed',
      userMessage: { role: 'user', content: 'source', timestamp: 1 },
      assistantMessage: { role: 'assistant', content: '', timestamp: 2 },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: { model: 'durable-suppression' },
      provenanceRefs: [],
    };
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      configOverrides: { companionId: localCompanionId },
      sessionManager: {
        findRecordedTurn: vi.fn(() => completedTurnRecord),
        findSourceRecordedTurn: vi.fn(() => completedTurnRecord),
        findUniqueSourceRecordedTurn: vi.fn(async () => completedTurnRecord),
        recordTurn,
      },
    });
    runtime.enqueuePostTurnBackgroundWork = enqueuePostTurnBackgroundWork;
    const message = createMessage(sourceMessageId, {
      channelId,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      isDirectMessage: true,
      routing: {
        source: 'companion',
        canonicalContactId: 'contact-mi',
        authorIsMachineIntelligence: true,
        privateTurnTrigger: true,
        icpCorrelation: correlation,
      },
    });
    const finalizeDelivery = vi.fn(async () => undefined);

    const response = await handleMessageForTurn(runtime, message, {
      recoveredResponse,
      finalizeDelivery,
    });

    expect(response).toEqual(recoveredResponse);
    expect(finalizeDelivery).toHaveBeenCalledOnce();
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(enqueuePostTurnBackgroundWork).not.toHaveBeenCalled();
    expect(recordTurn).not.toHaveBeenCalled();
  });

  it('injects an internal fatigue alert for soft exhaustion and returns model-authored text', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 2 });
    const buildContext = vi.fn(async (_channelId: string, fullPrompt: string) => ({
      systemPrompt: fullPrompt,
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const { runtime } = createFatigueRuntime({ fatigueBudget, buildContext });
    const modelAuthoredText = 'I can wrap this thought up from here.';
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Callback API intentionally preserves its Promise-returning lifecycle contract.
    (runtime.agent.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({ role: 'assistant', content: modelAuthoredText });
    });
    runtime.extractResponseText = vi.fn(() => modelAuthoredText);

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-soft', {
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }));

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(response.content).toBe(modelAuthoredText);
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'wrap_up_charged',
      alertInjected: true,
      recordedEvent: {
        amount: 1,
        spentAfter: 3,
      },
    });
    expect(buildContext.mock.calls[0]?.[1]).toContain('<runtime_fatigue_alert');
    expect(buildContext.mock.calls[0]?.[1]).toContain('author the outward response yourself');
    expect(history.events).toHaveLength(3);
  });

  it('suppresses hard-exhausted MI turns before model invocation', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 5 });
    const eventBus = new EventBus();
    const recordTurn = vi.fn();
    const turnEnd = vi.fn(() => {
      expect(recordTurn).not.toHaveBeenCalled();
    });
    eventBus.on('agent.turn.end', turnEnd);
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      buildContext,
      eventBus,
      sessionManager: { recordTurn },
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-hard', {
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }));

    expect(response.content).toBe('');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'suppressed_hard_exhausted',
      modelDisposition: 'suppressed',
      shouldRecordSpend: false,
    });
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();
    expect(history.events).toHaveLength(5);
    expect(runtime.recordAssistantMessage).not.toHaveBeenCalled();
    expect(turnEnd).toHaveBeenCalledOnce();
    expect(recordTurn).toHaveBeenCalledOnce();
  });

  it('allows a human-active hard-cap MI turn through bounded overcharge reserve', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 5 });
    const buildContext = vi.fn(async (_channelId: string, fullPrompt: string) => ({
      systemPrompt: fullPrompt,
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      buildContext,
      sessionManager: {
        getRecentMessages: vi.fn(() => [
          {
            id: 99,
            channelId: 'ch1',
            role: 'user',
            content: 'Can both of you keep going on this?',
            authorId: 'human-user',
            authorName: 'Human',
            timestamp: Date.now() - 60_000,
            metadata: buildSessionMetadataWithTurn(undefined, {
              turnId: deriveDeterministicTurnId('human-fatigue-history'),
              requestId: 'human-fatigue-history',
              role: 'user',
              actorKind: 'human',
            }),
          },
        ]),
      },
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-overcharge-human', {
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }));

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(response.content).toBe('assistant reply');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'overcharge_charged',
      overchargeEligible: true,
      overchargePermitted: true,
      alertInjected: true,
      spendDecision: 'overcharge',
      spendReason: 'overcharge_recent_human_participation',
      recordedEvent: {
        amount: 1,
        decision: 'overcharge',
        overchargeSpentAfter: 1,
        remainingOvercharge: 1,
      },
    });
    expect(buildContext.mock.calls[0]?.[1]).toContain('bounded overcharge reserve');
    expect(history.events).toHaveLength(6);
    expect(history.events.at(-1)).toMatchObject({
      decision: 'overcharge',
      reason: 'overcharge_recent_human_participation',
      details: expect.objectContaining({
        overchargePermitted: true,
      }),
    });
  });

  it('does not treat a third companion room message as recent human participation', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 5 });
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      sessionManager: {
        getRecentMessages: vi.fn(() => [
          {
            id: 100,
            channelId: 'ch1',
            role: 'user',
            content: 'I can continue the companion discussion.',
            authorId: 'third-companion',
            authorName: 'Third companion',
            timestamp: Date.now() - 60_000,
            metadata: buildSessionMetadataWithTurn(undefined, {
              turnId: deriveDeterministicTurnId('third-companion-fatigue-history'),
              requestId: 'third-companion-fatigue-history',
              role: 'user',
              actorKind: 'machine_intelligence',
            }),
          },
        ]),
      },
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-third-companion', {
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }));

    expect(response.content).toBe('');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'suppressed_hard_exhausted',
      overchargeEligible: false,
    });
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(history.events).toHaveLength(5);
  });

  it('hard-stops MI continuation after overcharge reserve is depleted', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 5 });
    seedMachineIntelligenceOverchargeSpend({ fatigueBudget, count: 2 });
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      sessionManager: {
        getRecentMessages: vi.fn(() => [
          {
            id: 101,
            channelId: 'ch1',
            role: 'user',
            content: 'I am still here.',
            authorId: 'human-user',
            authorName: 'Human',
            timestamp: Date.now() - 60_000,
            metadata: buildSessionMetadataWithTurn(undefined, {
              turnId: deriveDeterministicTurnId('depleted-human-fatigue-history'),
              requestId: 'depleted-human-fatigue-history',
              role: 'user',
              actorKind: 'human',
            }),
          },
        ]),
      },
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-overcharge-depleted', {
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }));

    expect(response.content).toBe('');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'suppressed_hard_exhausted',
      overchargeEligible: true,
      overchargePermitted: false,
      overchargeBlockedReasons: expect.arrayContaining(['overcharge_reserve_exhausted']),
      budget: expect.objectContaining({
        overchargeSpentBefore: 2,
        overchargeRemainingBefore: 0,
      }),
    });
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(history.events).toHaveLength(7);
  });

  it('allows human-authored turns without spending even when an MI budget is exhausted in the same channel', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 5 });
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      resolveAuthorContext: vi.fn(() => humanAuthorContext()),
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-human', {
      authorId: 'human-user',
      authorName: 'Human',
    }));

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(response.content).toBe('assistant reply');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'allowed_free',
      shouldRecordSpend: false,
    });
    expect(history.events).toHaveLength(5);
    expect(history.events.every(event => event.peerContactId === 'contact-mi')).toBe(true);
  });

  it('allows human-authored turns without spending even when overcharge reserve is exhausted', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 5 });
    seedMachineIntelligenceOverchargeSpend({ fatigueBudget, count: 2 });
    const { runtime } = createFatigueRuntime({
      fatigueBudget,
      resolveAuthorContext: vi.fn(() => humanAuthorContext()),
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-human-reserve-exhausted', {
      authorId: 'human-user',
      authorName: 'Human',
    }));

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(response.content).toBe('assistant reply');
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'allowed_free',
      shouldRecordSpend: false,
      overchargePermitted: false,
    });
    expect(history.events).toHaveLength(7);
  });

  it('keeps MI budgets isolated by channel', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    seedMachineIntelligenceFatigueSpend({ fatigueBudget, count: 5, channelId: 'ch1' });
    const { runtime } = createFatigueRuntime({ fatigueBudget });

    const response = await handleMessageForTurn(runtime, createMessage('msg-fatigue-channel-isolation', {
      channelId: 'ch2',
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }));

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(response.metadata.fatigue).toMatchObject({
      decision: 'allowed_charged',
      scope: {
        channelId: 'ch2',
      },
      recordedEvent: {
        amount: 1,
        spentAfter: 1,
      },
    });
    expect(history.events.filter(event => event.channelId === 'ch1')).toHaveLength(5);
    expect(history.events.filter(event => event.channelId === 'ch2')).toHaveLength(1);
  });

  it('does not record fatigue spend when model generation fails', async () => {
    const { fatigueBudget, history } = createFatigueBudgetHarness();
    const { runtime } = createFatigueRuntime({ fatigueBudget });
    (runtime.agent.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('generation failed'));

    await expect(handleMessageForTurn(runtime, createMessage('msg-fatigue-failure', {
      authorId: 'mi-user',
      authorName: 'Peer MI',
    }))).rejects.toThrow('generation failed');

    expect(history.events).toHaveLength(0);
    expect(runtime.recordAssistantMessage).not.toHaveBeenCalled();
  });
});

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

async function runObserverSidecarTurn(
  observerEvalSidecar?: ObserverEvalSidecarRuntime | null,
  messageOverrides: Partial<SubstrateMessage> = {},
) {
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
    manifest: makeContextManifestFixture(),
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
    ...messageOverrides,
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
  expect(result.recordAssistantMessage.mock.calls[0]?.[7]).toEqual(TEST_EMOTION_SNAPSHOT);
}

async function captureObserverSidecarInput(
  messageOverrides: Partial<SubstrateMessage>,
): Promise<ObserverEvalInput> {
  const receivedInputs: ObserverEvalInput[] = [];
  const sidecarRuntime: ObserverEvalSidecarRuntime = {
    config: { enabled: true, sidecarId: 'observer-source-metadata-test' },
    observer: {
      observeTurn: vi.fn((input: ObserverEvalInput) => {
        receivedInputs.push(input);
      }),
    },
  };

  await runObserverSidecarTurn(sidecarRuntime, messageOverrides);
  await drainObserverEvalSidecarQueue(sidecarRuntime);

  expect(receivedInputs).toHaveLength(1);
  return receivedInputs[0]!;
}

describe('handleMessageForTurn observer eval sidecar seam', () => {
  it('uses the admitted private scope for internal scheduler observations', async () => {
    const receivedInput = await captureObserverSidecarInput({
      channelId: 'internal:reflection:temporal-wakeup',
      channelType: 'terminal',
      authorId: 'scheduler',
      authorName: 'Temporal Wakeup',
      isDirectMessage: false,
      routing: undefined,
    });

    expect(receivedInput.source).toEqual({
      routingSource: 'terminal',
      isDirectMessage: false,
      channelPrivacy: 'private',
    });
    expect(sanitizeObserverEvalInput(receivedInput)).toMatchObject({
      privacy: {
        channelVisibility: 'private',
        derivedTelemetryPermitted: true,
      },
      emotion: {
        snapshot: TEST_EMOTION_SNAPSHOT,
        snapshotRedacted: false,
      },
    });
  });

  it('classifies genuine interactive console turns as private observations', async () => {
    const consoleMessage = createInteractiveTerminalMessage({
      id: 'cli-observer-test',
      content: OBSERVER_TEST_MESSAGE_CONTENT,
      timestamp: new Date('2026-03-08T12:00:00Z'),
    });
    const receivedInput = await captureObserverSidecarInput(consoleMessage);

    expect(receivedInput.source).toEqual({
      routingSource: 'terminal',
      isDirectMessage: false,
      channelPrivacy: 'private',
    });
    expect(sanitizeObserverEvalInput(receivedInput)).toMatchObject({
      privacy: {
        privacyClass: 'closed',
        channelVisibility: 'private',
        derivedTelemetryPermitted: true,
      },
      emotion: {
        snapshot: TEST_EMOTION_SNAPSHOT,
        snapshotRedacted: false,
      },
    });
  });

  it('preserves a classified API session privacy level without defaulting it to private', async () => {
    const receivedInput = await captureObserverSidecarInput({
      channelId: 'api:shared-session',
      channelType: 'api',
      isDirectMessage: false,
      routing: {
        source: 'api',
        channelPrivacy: 'invite_only',
      },
    });

    expect(receivedInput.source).toEqual({
      routingSource: 'api',
      isDirectMessage: false,
      channelPrivacy: 'invite_only',
    });
  });

  it('leaves Discord observer source metadata unchanged', async () => {
    const receivedInput = await captureObserverSidecarInput({
      channelId: 'discord:guild-room',
      channelType: 'discord',
      isDirectMessage: false,
      routing: {
        source: 'discord',
        channelPrivacy: 'public',
      },
    });

    expect(receivedInput.source).toEqual({
      routingSource: 'discord',
      isDirectMessage: false,
      channelPrivacy: 'public',
    });
  });

  it('uses the admitted private scope when API routing omits optional privacy metadata', async () => {
    const receivedInput = await captureObserverSidecarInput({
      channelId: 'api:unclassified-session',
      channelType: 'api',
      isDirectMessage: false,
      routing: undefined,
    });

    expect(receivedInput.source).toEqual({
      routingSource: 'api',
      isDirectMessage: false,
      channelPrivacy: 'private',
    });
    expect(sanitizeObserverEvalInput(receivedInput).privacy).toMatchObject({
      channelVisibility: 'private',
      derivedTelemetryPermitted: true,
    });
  });

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
      coherenceContext: {
        recentMirrorNoteCount: 0,
        timeGapMs: null,
        activeConcernCount: 0,
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
  it('does not enqueue narrative appraisal work for a stable turn', async () => {
    const reserveNarrativeEmotionAppraisal = vi.fn(() => null);
    const runtime = createRuntime({
      eventBus: new EventBus(),
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      emotionSelfModelRuntimeOverrides: { reserveNarrativeEmotionAppraisal } as never,
    });

    await handleMessageForTurn(runtime, createMessage('stable-emotion-turn'));

    const jobs = (runtime.enqueuePostTurnBackgroundWork as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as Array<{ kind: string }>;
    expect(reserveNarrativeEmotionAppraisal).toHaveBeenCalledTimes(1);
    expect(jobs.map(job => job.kind)).not.toContain('emotion_appraisal');
  });

  it('threads ICP lineage into extraction, intention, emotion, and compaction side work', async () => {
    const eventBus = new EventBus();
    const scheduleAutoCompactionBetweenTurns = vi.fn(async () => undefined);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => null),
      recordAssistantMessage: vi.fn(() => 2),
      configOverrides: { companionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    const maybeExtract = vi.fn(async () => undefined);
    runtime.memoryExtractor = { maybeExtract };
    runtime.buildTurnRecord = vi.fn((input) => {
      const { turnSessionIdentity, ...turnRecordInput } = input;
      return buildTurnRecord({
        ...turnRecordInput,
        sessionId: turnSessionIdentity.logicalSessionId,
        hashPromptText: runtime.hashPromptText,
        // This harness stubs provider messages with string content; the producer
        // contract under test does not depend on tool-call reconstruction.
        turnMessages: [],
      });
    });
    const correlation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerContactId: 'contact-nova',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
      messageId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
      requestId: 'icp-initiation:33333333-3333-4333-8333-333333333333',
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'not_evaluated' as const,
    };
    const message = createMessage(correlation.requestId, {
      channelId: correlation.channelId,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      isDirectMessage: true,
      routing: {
        source: 'companion',
        canonicalContactId: correlation.peerContactId,
        authorIsMachineIntelligence: true,
        privateTurnTrigger: true,
        icpCorrelation: correlation,
      },
    });

    await handleMessageForTurn(runtime, message, { finalizeDelivery: async () => undefined });

    expect(maybeExtract).not.toHaveBeenCalled();
    expect(runtime.runIntentionPostTurnHooks).not.toHaveBeenCalled();
    expect(runtime.emotionSelfModelRuntime.triggerEmotionAppraisal).not.toHaveBeenCalled();
    expect(scheduleAutoCompactionBetweenTurns).not.toHaveBeenCalled();
    expect(runtime.enqueuePostTurnBackgroundWork).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        kind: 'memory_extraction',
        maxAttempts: 5,
        payload: expect.objectContaining({ kind: 'memory_extraction', icpCorrelation: correlation }),
      }),
      expect.objectContaining({
        kind: 'intention_post_turn_hooks',
        payload: expect.objectContaining({ kind: 'intention_post_turn_hooks' }),
      }),
      expect.objectContaining({
        kind: 'emotion_appraisal',
        payload: expect.objectContaining({ kind: 'emotion_appraisal', icpCorrelation: correlation }),
      }),
      expect.objectContaining({
        kind: 'auto_compaction',
        payload: expect.objectContaining({ kind: 'auto_compaction', icpCorrelation: correlation }),
      }),
    ]));
    const enqueued = (runtime.enqueuePostTurnBackgroundWork as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as Array<{ kind: string; payload: Record<string, unknown> }>;
    expect(enqueued).toHaveLength(4);
    expect(JSON.stringify(enqueued)).not.toContain(message.content);
    expect(JSON.stringify(enqueued)).not.toContain('assistant reply');
    expect(JSON.stringify(enqueued)).not.toContain('ephemeral-broadcast-secret');
    expect(JSON.stringify(enqueued)).not.toContain('private free-form personality prose');
    expect(JSON.stringify(enqueued)).not.toContain('private pinned compaction prompt');
    expect(JSON.stringify(enqueued)).not.toContain('broadcastApprovalToken');
    expect(JSON.stringify(enqueued)).not.toContain('compactionPromptText');
    expect(JSON.stringify(enqueued)).not.toContain('templateVariables');
    expect(runtime.sessionManager.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      extractedMemoryIds: [expect.stringMatching(/^loom-projection:v1:memory:[a-f0-9]{64}$/u)],
      concernDeltaRefs: [expect.stringMatching(/^loom-projection:v1:concern:[a-f0-9]{64}$/u)],
      contactDeltaRefs: [expect.stringMatching(/^loom-projection:v1:contact:[a-f0-9]{64}$/u)],
    }));
    const emotionPayload = enqueued.find(job => job.kind === 'emotion_appraisal')?.payload;
    expect(emotionPayload).toMatchObject({
      internalStateSnapshotRef: expect.stringMatching(/^internal-state-v1:/),
      personalityOwnerRef: 'character-card',
      personalityProjectionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      appraisalState: {
        schemaVersion: 1,
        attention: {
          activeConcernCount: 0,
          salientEntityCount: 0,
          conversationTrajectory: 'casual',
        },
      },
    });
    const recordedTurn = (runtime.sessionManager.recordTurn as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as TurnRecord;
    expect(extractTurnRecordSelfSnapshotRef(recordedTurn.internalStateSnapshotRef))
      .toBe(emotionPayload?.internalStateSnapshotRef);
    expect(emotionPayload).not.toHaveProperty('internalState');
    expect(emotionPayload?.appraisalState).not.toHaveProperty('attention.activeConcerns');
    expect(emotionPayload?.appraisalState).not.toHaveProperty('attention.salientEntities');
  });

  it('records authenticated testing-harness evidence without scheduling companion side effects', async () => {
    const eventBus = new EventBus();
    const reserveNarrativeEmotionAppraisal = vi.fn();
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      emotionSelfModelRuntimeOverrides: { reserveNarrativeEmotionAppraisal } as never,
    });
    runtime.memoryExtractor = { maybeExtract: vi.fn() };
    const message = createMessage('testing-harness-message', {
      channelId: 'api:testing-harness',
      channelType: 'api',
      routing: {
        source: 'api',
        testingHarness: {
          schemaVersion: 1,
          kind: 'testing_harness',
          runId: 'run-tool-call-matrix',
          manifestId: 'manifest-tool-call-matrix',
        },
      },
    });

    await handleMessageForTurn(runtime, message);

    expect(runtime.inferPostTurnActions).not.toHaveBeenCalled();
    expect(reserveNarrativeEmotionAppraisal).not.toHaveBeenCalled();
    expect(runtime.enqueuePostTurnBackgroundWork).not.toHaveBeenCalled();
    expect(runtime.sessionManager.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
    }));
    expect(runtime.sessionManager.recordTurn.mock.calls[0]?.[0])
      .not.toHaveProperty('backgroundWorkHandoff');
  });

  it('starts foreground identity work without a process-global post-turn drain', async () => {
    const eventBus = new EventBus();
    const performanceEvents: Array<EventMap['agent.turn.performance']> = [];
    eventBus.on('agent.turn.performance', event => performanceEvents.push(event));
    const controller = new AbortController();
    const beginForegroundBackgroundWork = vi.fn((logicalSessionId: string) => ({
      id: 'foreground-b',
      logicalSessionId,
      ready: Promise.resolve(),
      signal: controller.signal,
    }));
    const endForegroundBackgroundWork = vi.fn();
    const resolveAuthorContext = vi.fn(async () => ({
      trustLevel: 'regular',
      speakerRole: 'user',
      resolvedUserName: 'User',
      canonicalContactKey: 'contact-1',
      continuityFallbackKeys: [],
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      beginForegroundBackgroundWork,
      endForegroundBackgroundWork,
      resolveAuthorContext,
    });
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      runtime.agent.state.messages.push({ role: 'user', content: promptMessage.content });
      const timestampMs = Date.now();
      await eventBus.emit('agent.provider.first_output', {
        requestId: 'msg-post-turn-drain-wait',
        channelId: 'ch1',
        kind: 'text',
        monotonicAtMs: timestampMs,
        timestampMs,
        provider: 'test',
        model: 'test-model',
      });
      runtime.agent.state.messages.push({ role: 'assistant', content: 'assistant reply' });
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-post-turn-drain-wait'))).resolves.toMatchObject({
      content: 'assistant reply',
      channelId: 'ch1',
    });
    expect(beginForegroundBackgroundWork).toHaveBeenCalledWith('ch1');
    expect(resolveAuthorContext).toHaveBeenCalledTimes(1);
    expect(endForegroundBackgroundWork).toHaveBeenCalledWith({
      id: 'foreground-b',
      logicalSessionId: 'ch1',
      ready: expect.any(Promise),
      signal: controller.signal,
    });
    expect(performanceEvents.some(event => event.stage === 'post_turn_drain_wait')).toBe(false);
    expect(performanceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        traceId: 'msg-post-turn-drain-wait',
        requestId: 'msg-post-turn-drain-wait',
        stage: 'transport_received',
      }),
      expect.objectContaining({ stage: 'compaction_wait', durationMs: expect.any(Number) }),
      expect.objectContaining({ stage: 'context_assembly', durationMs: expect.any(Number) }),
      expect.objectContaining({ stage: 'session_context_assembly', durationMs: expect.any(Number) }),
      expect.objectContaining({ stage: 'emotion_observation', durationMs: expect.any(Number) }),
      expect.objectContaining({ stage: 'prompt_assembly', durationMs: expect.any(Number) }),
      expect.objectContaining({ stage: 'provider_request', model: 'test-model', provider: 'test' }),
      expect.objectContaining({
        stage: 'provider_first_token',
        providerOutputKind: 'text',
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        stage: 'provider_complete',
        model: 'test-model',
        provider: 'test',
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({ stage: 'turn_complete', toolUse: false, cacheState: 'miss' }),
    ]));
  });

  it('consumes foreground ownership loss before starting a provider effect', async () => {
    const eventBus = new EventBus();
    const controller = new AbortController();
    const identityStarted = createDeferred<void>();
    const continueIdentity = createDeferred<void>();
    const lease = {
      id: 'foreground-loss',
      logicalSessionId: 'ch1',
      ready: Promise.resolve(),
      signal: controller.signal,
    };
    const endForegroundBackgroundWork = vi.fn(async () => undefined);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      beginForegroundBackgroundWork: vi.fn(() => lease),
      endForegroundBackgroundWork,
      resolveAuthorContext: vi.fn(async () => {
        identityStarted.resolve();
        await continueIdentity.promise;
        return {
          trustLevel: 'regular',
          speakerRole: 'user',
          resolvedUserName: 'User',
          canonicalContactKey: 'contact-1',
          continuityFallbackKeys: [],
        };
      }),
    });
    const run = handleMessageForTurn(runtime, createMessage('msg-foreground-loss'));
    await identityStarted.promise;
    controller.abort(new Error('foreground ownership lost'));
    continueIdentity.resolve();

    await expect(run).rejects.toThrow('foreground ownership lost');
    expect(runtime.agent.prompt).not.toHaveBeenCalled();
    expect(endForegroundBackgroundWork).toHaveBeenCalledWith(lease);
  });

  it('aborts the request-owned provider run when foreground ownership is lost mid-turn', async () => {
    const eventBus = new EventBus();
    const foregroundController = new AbortController();
    const providerController = new AbortController();
    const providerStarted = createDeferred<void>();
    const lease = {
      id: 'foreground-provider-loss',
      logicalSessionId: 'ch1',
      ready: Promise.resolve(),
      signal: foregroundController.signal,
    };
    const endForegroundBackgroundWork = vi.fn(async () => undefined);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      beginForegroundBackgroundWork: vi.fn(() => lease),
      endForegroundBackgroundWork,
    });
    const requestId = 'msg-foreground-provider-loss';
    (runtime.agent as unknown as { activeRun: unknown }).activeRun = {
      requestId,
      abortController: providerController,
    };
    runtime.agent.abort = vi.fn(() => {
      providerController.abort(new Error('provider aborted after foreground ownership loss'));
    });
    runtime.agent.prompt = vi.fn(async () => {
      providerStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        if (providerController.signal.aborted) {
          reject(providerController.signal.reason);
          return;
        }
        providerController.signal.addEventListener('abort', () => {
          reject(providerController.signal.reason);
        }, { once: true });
      });
    });

    const run = handleMessageForTurn(runtime, createMessage(requestId));
    await providerStarted.promise;
    foregroundController.abort(new Error('foreground ownership lost'));

    await expect(run).rejects.toThrow('provider aborted after foreground ownership loss');
    expect(runtime.agent.abort).toHaveBeenCalledTimes(1);
    expect(providerController.signal.aborted).toBe(true);
    expect(endForegroundBackgroundWork).toHaveBeenCalledWith(lease);
  });

  it('records a replayable TurnRecord before atomically enqueueing post-turn work', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const scheduleAutoCompactionBetweenTurns = vi.fn(async () => undefined);
    const awaitPendingAutoCompaction = vi.fn(async () => undefined);
    const recordUserMessage = vi.fn(() => 1);
    const recordAssistantMessage = vi.fn(() => 2);
    const recordTurn = vi.fn();
    const enqueueHandoff = createDeferred<void>();
    const enqueuePostTurnBackgroundWork = vi.fn(() => enqueueHandoff.promise);
    const runtime = createRuntime({
      eventBus,
      sessionManager: { recordTurn } as unknown as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns,
      awaitPendingAutoCompaction,
      recordUserMessage,
      recordAssistantMessage,
      enqueuePostTurnBackgroundWork,
    });

    const responsePromise = handleMessageForTurn(runtime, createMessage('msg-1'));
    let responseSettled = false;
    void responsePromise.finally(() => { responseSettled = true; });
    await vi.waitFor(() => {
      expect(enqueuePostTurnBackgroundWork).toHaveBeenCalledTimes(1);
    });

    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      backgroundWorkHandoff: {
        schemaVersion: 1,
        jobs: expect.arrayContaining([
          expect.objectContaining({ kind: 'intention_post_turn_hooks' }),
          expect.objectContaining({ kind: 'emotion_appraisal' }),
          expect.objectContaining({ kind: 'auto_compaction' }),
        ]),
      },
    }));
    expect(responseSettled).toBe(false);

    enqueueHandoff.resolve();
    const response = await responsePromise;

    expect(response).toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
    expect(buildContext).toHaveBeenCalledTimes(1);
    expect(buildContext.mock.calls[0][3]).toBeUndefined();
    expect(scheduleAutoCompactionBetweenTurns).not.toHaveBeenCalled();
    expect(enqueuePostTurnBackgroundWork).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ kind: 'intention_post_turn_hooks' }),
      expect.objectContaining({ kind: 'emotion_appraisal' }),
      expect.objectContaining({ kind: 'auto_compaction' }),
    ]));
    expect(recordTurn.mock.invocationCallOrder[0]).toBeLessThan(
      enqueuePostTurnBackgroundWork.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps an in-flight routed handoff on its turn-start owner across a route reset', async () => {
    const dataDir = makeTempDir();
    const eventBus = new EventBus();
    const { runtime, store, sessionManager } = createPersistenceBackedRuntime(dataDir, eventBus, {
      turnRecordEligibilityFence: {
        withTurnRecordEligibilityFence: async (_key, operation) => operation(),
        withTurnRecordEligibilityFences: async (_keys, operation) => operation(),
      },
    });
    const sourceChannelId = 'discord:guild:routed-handoff';
    const reset = sessionManager.resetSourceChannelSession({
      sourceChannelId,
      actor: 'test',
      reason: 'exercise physical-source handoff recovery',
      mode: 'fresh_split',
    });
    const turnStartLogicalSessionId = reset.newLogicalSessionId;
    runtime.sessionManager = sessionManager;
    const synchronousSourceLookup = vi.spyOn(sessionManager, 'findSourceRecordedTurn');
    runtime.buildTurnCorrelation = (
      message,
      callType,
      turnId,
      requestId,
      logicalSessionId,
    ) => ({
      callType,
      purpose: 'agent.turn',
      turnId,
      requestId,
      channelId: message.channelId,
      sessionId: logicalSessionId,
    });
    runtime.memoryExtractor = {
      maybeExtract: vi.fn(async () => undefined),
      getBoundedExtractionSnapshotLimit: () => 10,
    };
    runtime.skillsRuntime = {} as TurnExecutionRuntime['skillsRuntime'];
    runtime.evaluateReflectionNudge = vi.fn(() => 'Old-turn reflection nudge.');
    const promptStarted = createDeferred<void>();
    const releasePrompt = createDeferred<void>();
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      promptStarted.resolve();
      await releasePrompt.promise;
      (fromAny(runtime.agent.state.messages)).push({
        role: 'toolResult',
        toolCallId: 'call-turn-start-owner',
        toolName: 'contact',
        content: [{ type: 'text', text: 'Old-turn tool observation.' }],
        isError: false,
      });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{ type: 'text', text: 'assistant reply' }],
      });
    });
    const liveEnqueue = vi.fn()
      .mockRejectedValueOnce(new Error('injected routed enqueue failure'))
      .mockResolvedValue(undefined);
    runtime.enqueuePostTurnBackgroundWork = liveEnqueue;

    const inFlight = handleMessageForTurn(runtime, createMessage('msg-routed-handoff', {
      channelId: sourceChannelId,
      channelType: 'discord',
      isDirectMessage: false,
    }));
    await promptStarted.promise;
    const futureRoute = sessionManager.resetSourceChannelSession({
      sourceChannelId,
      actor: 'test',
      reason: 'move only future turns to a new logical session',
      mode: 'fresh_split',
    });
    const {
      runtime: futureRuntime,
      sessionManager: futureSessionManager,
    } = createPersistenceBackedRuntime(dataDir, eventBus);
    futureRuntime.sessionManager = futureSessionManager;
    futureRuntime.buildTurnCorrelation = (
      turnMessage,
      callType,
      turnId,
      requestId,
      logicalSessionId,
    ) => ({
      callType,
      purpose: 'agent.turn',
      turnId,
      requestId,
      channelId: turnMessage.channelId,
      sessionId: logicalSessionId,
    });
    futureRuntime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (fromAny(futureRuntime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(futureRuntime.agent.state.messages)).push({
        role: 'assistant',
        content: [{ type: 'text', text: 'future reply' }],
      });
    });
    await expect(handleMessageForTurn(futureRuntime, createMessage('msg-future-route', {
      channelId: sourceChannelId,
      channelType: 'discord',
      isDirectMessage: false,
      content: 'Future routed turn.',
    }))).resolves.toMatchObject({ content: 'future reply' });
    releasePrompt.resolve();
    await expect(inFlight).rejects.toThrow('injected routed enqueue failure');
    expect(synchronousSourceLookup).not.toHaveBeenCalled();

    const physicalRecords = store.getRecentSourceTurnRecords(sourceChannelId, 10);
    const oldTurnRecords = physicalRecords.filter(record => record.requestId === 'msg-routed-handoff');
    expect(oldTurnRecords).toHaveLength(1);
    expect(oldTurnRecords[0]).toMatchObject({
      channelId: sourceChannelId,
      sessionId: turnStartLogicalSessionId,
      status: 'completed',
    });
    const exactManifest = parseTurnRecordBackgroundWorkHandoff(oldTurnRecords[0]!);
    expect(exactManifest).toHaveLength(4);
    expect(new Set(exactManifest.map(job => job.logicalSessionId))).toEqual(
      new Set([turnStartLogicalSessionId]),
    );
    const executedRecoveryJobs: string[] = [];
    expect(await sessionManager.recoverPendingBackgroundWorkHandoffs(
      1,
      async (record) => {
        const jobs = parseTurnRecordBackgroundWorkHandoff(record);
        executedRecoveryJobs.push(...jobs.map(job => job.kind));
        await liveEnqueue(jobs);
      },
    )).toBe(1);
    expect(executedRecoveryJobs).toEqual(exactManifest.map(job => job.kind));
    expect(liveEnqueue).toHaveBeenNthCalledWith(2, exactManifest);
    expect(await sessionManager.recoverPendingBackgroundWorkHandoffs(
      1,
      async record => liveEnqueue(parseTurnRecordBackgroundWorkHandoff(record)),
    )).toBe(0);

    const oldTurnEntries = sessionManager.getRecentSessionEntries(turnStartLogicalSessionId, 20)
      .filter(entry => resolveSessionEntryTurnContext(entry).requestId === 'msg-routed-handoff');
    expect(oldTurnEntries.map(entry => entry.role)).toEqual(['user', 'tool', 'assistant']);
    expect(oldTurnEntries.every(entry => entry.originChannelId === sourceChannelId)).toBe(true);
    expect(sessionManager.getRecentSessionEntries(turnStartLogicalSessionId, 20)).toContainEqual(
      expect.objectContaining({
        role: 'system',
        content: 'Old-turn reflection nudge.',
        originChannelId: sourceChannelId,
      }),
    );
    const futureOwnerEntries = futureSessionManager.getRecentSessionEntries(
      futureRoute.newLogicalSessionId,
      20,
    );
    expect(futureOwnerEntries.filter(entry => (
      resolveSessionEntryTurnContext(entry).requestId === 'msg-routed-handoff'
    ))).toEqual([]);
    expect(futureOwnerEntries.some(entry => entry.content === 'Old-turn reflection nudge.')).toBe(false);
    expect(futureOwnerEntries.filter(entry => (
      resolveSessionEntryTurnContext(entry).requestId === 'msg-future-route'
    )).map(entry => entry.role)).toEqual(['user', 'assistant']);
    expect(new Set(store.getRecentSourceTurnRecords(sourceChannelId, 10).map(record => record.sessionId)))
      .toEqual(new Set([turnStartLogicalSessionId, futureRoute.newLogicalSessionId]));
  });

  it.each(['api', 'terminal'] as const)(
    'keeps prompt history and background handoffs on the admitted %s owner across an active-context switch',
    async (channelKind) => {
    const dataDir = makeTempDir();
    const eventBus = new EventBus();
    const { runtime, sessionManager } = createPersistenceBackedRuntime(dataDir, eventBus);
    const sourceChannelId = `${channelKind}:physical-source`;
    const admittedOwner = `${channelKind}:admitted-owner`;
    const futureOwner = `${channelKind}:future-owner`;
    sessionManager.recordUserMessage(admittedOwner, 'admitted prompt history', 'user-a', 'User');
    sessionManager.recordUserMessage(futureOwner, 'future prompt history', 'user-b', 'User');
    sessionManager.setActiveContextSession(admittedOwner);
    const ingressResolution = vi.spyOn(sessionManager, 'resolveSessionForIngress');
    runtime.sessionManager = sessionManager;
    runtime.buildTurnCorrelation = (
      message,
      callType,
      turnId,
      requestId,
      logicalSessionId,
    ) => ({
      callType,
      purpose: 'agent.turn',
      turnId,
      requestId,
      channelId: message.channelId,
      sessionId: logicalSessionId,
    });
    const authorResolutionStarted = createDeferred<void>();
    const releaseAuthorResolution = createDeferred<void>();
    runtime.resolveAuthorContext = vi.fn(async () => {
      authorResolutionStarted.resolve();
      await releaseAuthorResolution.promise;
      return humanAuthorContext();
    });
    let observedPromptHistory = '';
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      observedPromptHistory = (runtime.agent.state.messages as Array<{ content?: unknown }>)
        .map(entry => typeof entry.content === 'string' ? entry.content : '')
        .join('\n');
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{ type: 'text', text: 'assistant reply' }],
      });
    });

    const inFlight = handleMessageForTurn(runtime, createMessage(`msg-owner-switch-${channelKind}`, {
      channelId: sourceChannelId,
      channelType: channelKind,
    }));
    await authorResolutionStarted.promise;
    sessionManager.setActiveContextSession(futureOwner);
    releaseAuthorResolution.resolve();
    await expect(inFlight).resolves.toMatchObject({ content: 'assistant reply' });

    expect(observedPromptHistory).toContain('admitted prompt history');
    expect(observedPromptHistory).not.toContain('future prompt history');
    expect(ingressResolution).toHaveBeenCalledTimes(1);
    expect(ingressResolution).toHaveBeenCalledWith(sourceChannelId);
    expect(runtime.enqueuePostTurnBackgroundWork).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            source: expect.objectContaining({ logicalSessionId: admittedOwner }),
          }),
        }),
      ]),
    );
    },
  );

  it('keeps a distinct Wyoming observability session out of durable turn ownership', async () => {
    const dataDir = makeTempDir();
    const eventBus = new EventBus();
    const {
      runtime,
      store,
      sessionManager,
      turnSupportRuntime,
    } = createPersistenceBackedRuntime(dataDir, eventBus);
    const emitSpy = vi.spyOn(eventBus, 'emit');
    const sourceChannelId = 'api:wyoming:office';
    const observabilitySessionId = 'wyoming-observability:office';
    runtime.sessionManager = sessionManager;
    runtime.buildTurnCorrelation = turnSupportRuntime.buildTurnCorrelation.bind(turnSupportRuntime);
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{ type: 'text', text: 'assistant reply' }],
      });
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-wyoming-owner', {
      channelId: sourceChannelId,
      channelType: 'api',
      routing: {
        source: 'wyoming',
        wyoming: { sessionId: observabilitySessionId },
      },
    }))).resolves.toMatchObject({ content: 'assistant reply' });

    expect(emitSpy).toHaveBeenCalledWith('agent.turn.end', expect.objectContaining({
      sessionId: observabilitySessionId,
    }));
    const records = store.getRecentSourceTurnRecords(sourceChannelId, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      channelId: sourceChannelId,
      sessionId: sourceChannelId,
      status: 'completed',
    });
    expect(parseTurnRecordBackgroundWorkHandoff(records[0]!).every(job => (
      job.logicalSessionId === sourceChannelId
      && job.sourceChannelId === sourceChannelId
    ))).toBe(true);
    expect(sessionManager.getRecentSessionEntries(sourceChannelId, 10)
      .filter(entry => resolveSessionEntryTurnContext(entry).requestId === 'msg-wyoming-owner')
      .map(entry => entry.role)).toEqual(['user', 'assistant']);
    expect(sessionManager.getRecentSessionEntries(observabilitySessionId, 10)).toEqual([]);
  });

  it('replays the exact TurnRecord handoff after a record-to-queue crash gap', async () => {
    const dataDir = makeTempDir();
    const eventBus = new EventBus();
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const { runtime, store, sessionManager } = createPersistenceBackedRuntime(dataDir, eventBus);
    const reset = sessionManager.resetSourceChannelSession({
      sourceChannelId: channelId,
      actor: 'test',
      reason: 'exercise routed delivery recovery',
      mode: 'fresh_split',
    });
    const logicalSessionId = reset.newLogicalSessionId;
    const sourceMessageId = 'icp-initiation:33333333-3333-4333-8333-333333333333';
    const correlation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: localCompanionId,
      localCompanionId,
      peerCompanionId,
      peerContactId: 'contact-mi',
      channelId,
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
      messageId: sourceMessageId,
      requestId: sourceMessageId,
      chargeLane: 'companion_social' as const,
      surface: 'companion_dm' as const,
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'initiation' as const,
      fatigueDecision: 'not_evaluated' as const,
    };
    const enqueuePostTurnBackgroundWork = vi.fn()
      .mockRejectedValueOnce(new Error('injected queue crash gap'))
      .mockResolvedValue(undefined);
    runtime.sessionManager = sessionManager;
    runtime.config.companionId = localCompanionId;
    runtime.enqueuePostTurnBackgroundWork = enqueuePostTurnBackgroundWork;
    runtime.buildTurnCorrelation = (
      message,
      callType,
      turnId,
      requestId,
      capturedLogicalSessionId,
    ) => ({
      callType,
      purpose: 'agent.turn',
      turnId,
      requestId,
      channelId: message.channelId,
      sessionId: capturedLogicalSessionId,
    });
    runtime.resolveAuthorContext = vi.fn(() => machineIntelligenceAuthorContext({
      canonicalContactKey: correlation.peerContactId,
    }));
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{ type: 'text', text: 'assistant reply' }],
      });
    });
    const message = createMessage(sourceMessageId, {
      channelId,
      channelType: 'companion',
      authorId: 'system:icp-initiation',
      authorName: 'ICP Initiation',
      isDirectMessage: true,
      routing: {
        source: 'companion',
        canonicalContactId: correlation.peerContactId,
        authorIsMachineIntelligence: true,
        privateTurnTrigger: true,
        icpCorrelation: correlation,
      },
    });

    await expect(handleMessageForTurn(runtime, message, {
      finalizeDelivery: vi.fn(async () => undefined),
    })).rejects.toThrow('injected queue crash gap');
    const physicalRecords = store.getRecentSourceTurnRecords(channelId, 10);
    expect(physicalRecords).toHaveLength(1);
    const recordedTurn = physicalRecords[0]!;
    expect(recordedTurn).toMatchObject({
      channelId,
      sessionId: logicalSessionId,
      status: 'completed',
    });
    const recordedJobs = recordedTurn.backgroundWorkHandoff?.jobs;
    expect(recordedJobs).toHaveLength(3);
    const futureRoute = sessionManager.resetSourceChannelSession({
      sourceChannelId: channelId,
      actor: 'test',
      reason: 'route only future deliveries to a fresh logical session',
      mode: 'fresh_split',
    });
    expect(futureRoute.newLogicalSessionId).not.toBe(logicalSessionId);

    const recoveredResponse: AgentResponse = {
      content: 'assistant reply',
      channelId: message.channelId,
      metadata: {
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
        turnId: recordedTurn.turnId,
        requestId: recordedTurn.requestId,
        icpCorrelation: correlation,
      },
    };
    await expect(handleMessageForTurn(runtime, message, {
      recoveredResponse,
      finalizeDelivery: vi.fn(async () => undefined),
    })).resolves.toEqual(recoveredResponse);

    expect(enqueuePostTurnBackgroundWork).toHaveBeenCalledTimes(2);
    expect(enqueuePostTurnBackgroundWork.mock.calls[1]?.[0]).toEqual(recordedJobs);
    expect(store.getRecentSourceTurnRecords(channelId, 10)).toHaveLength(1);
  });

  it('resolves the active route after a deferred recovered-record miss', async () => {
    const eventBus = new EventBus();
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => null),
      recordAssistantMessage: vi.fn(() => null),
    });
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    runtime.sessionManager.findUniqueSourceRecordedTurn = vi.fn(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return null;
    });
    let activeOwner = 'logical-owner-before-reset';
    runtime.sessionManager.resolveSessionForIngress = vi.fn(() => activeOwner);
    const localCompanionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const peerCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const channelId = `companion-dm:${localCompanionId}:${peerCompanionId}`;
    const turnId = createTurnId();
    const correlation: IcpConversationCorrelation = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      rootInitiationId: '99999999-9999-4999-8999-999999999999',
      initiatedByCompanionId: localCompanionId,
      localCompanionId,
      peerCompanionId,
      peerContactId: 'contact-deferred-route',
      channelId,
      turnId,
      messageId: 'msg-deferred-recovery-route',
      requestId: 'msg-deferred-recovery-route',
      chargeLane: 'companion_social',
      surface: 'companion_dm',
      costPurpose: 'conversation_turn',
      costOriginStage: 'reply',
      fatigueDecision: 'not_evaluated',
    };
    runtime.config.companionId = localCompanionId;
    runtime.resolveAuthorContext = vi.fn(() => machineIntelligenceAuthorContext({
      canonicalContactKey: correlation.peerContactId,
    }));
    const message = createMessage('msg-deferred-recovery-route', {
      channelId,
      channelType: 'companion',
      authorId: peerCompanionId,
      authorName: 'Peer companion',
      isDirectMessage: true,
      routing: {
        source: 'companion',
        icpCorrelation: correlation,
      },
    });
    const recoveredResponse: AgentResponse = {
      content: 'already delivered',
      channelId,
      metadata: {
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
        turnId,
        requestId: message.id,
        icpCorrelation: correlation,
      },
    };

    const recovery = handleMessageForTurn(runtime, message, {
      recoveredResponse,
      finalizeDelivery: vi.fn(async () => undefined),
    });
    await lookupStarted.promise;
    expect(runtime.sessionManager.resolveSessionForIngress).not.toHaveBeenCalled();
    activeOwner = 'logical-owner-after-reset';
    releaseLookup.resolve();

    await expect(recovery).resolves.toEqual(recoveredResponse);
    expect(runtime.sessionManager.resolveSessionForIngress).toHaveBeenCalledTimes(1);
    expect(runtime.sessionManager.findSourceRecordedTurn).not.toHaveBeenCalled();
    expect(runtime.sessionManager.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelId,
      sessionId: activeOwner,
      turnId,
    }));
  });

  it.each([
    { channelId: 'internal:heartbeat', taskKind: 'heartbeat' as const },
    { channelId: 'internal:reflection:whisper', taskKind: 'reflection' as const },
  ])('routes %s turns through the companion subject identity', async ({ channelId, taskKind }) => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const scheduleAutoCompactionBetweenTurns = vi.fn(async () => undefined);
    const awaitPendingAutoCompaction = vi.fn(async () => undefined);
    const recordUserMessage = vi.fn(() => null);
    const recordSystemMessage = vi.fn(() => taskKind === 'reflection' ? null : 1);
    const recordAssistantMessage = vi.fn(() => taskKind === 'reflection' ? null : 2);
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
      expect.objectContaining({ sourceChannelId: channelId, logicalSessionId: channelId }),
      expect.any(String),
      expect.any(String),
      `[SYSTEM: ${taskKind === 'heartbeat' ? 'Scheduler' : 'Whisper'}] ${taskKind} run`,
      DEFAULT_COMPANION_ID,
    );
    expect(recordUserMessage).not.toHaveBeenCalled();
    expect(buildPromptTemplateVariablesMock.mock.calls[0]?.[5]).toBe(DEFAULT_COMPANION_ID);
    expect(buildDynamicPromptTemplateVariablesMock.mock.calls[0]?.[6]).toBe(DEFAULT_COMPANION_ID);
    expect(buildRuntimeContextMock.mock.calls[0]?.[6]).toBe(DEFAULT_COMPANION_ID);
    expect(buildPromptPrefixCacheKeyMock.mock.calls[0]?.[3]).toBe(DEFAULT_COMPANION_ID);
    expect(buildContext.mock.calls[0]?.[4]).toBe(DEFAULT_COMPANION_ID);
    expect(scheduleAutoCompactionBetweenTurns).not.toHaveBeenCalled();
    const jobs = (runtime.enqueuePostTurnBackgroundWork as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as Array<{ kind: string; payload: Record<string, unknown> }>;
    if (taskKind === 'reflection') {
      expect(jobs.map(job => job.kind)).toEqual(['intention_post_turn_hooks']);
    } else {
      expect(jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'auto_compaction',
          payload: expect.objectContaining({
            kind: 'auto_compaction',
            userId: DEFAULT_COMPANION_ID,
          }),
        }),
      ]));
    }
    expect((runtime.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      role: 'custom',
      type: 'systemNote',
      content: `[SYSTEM: ${taskKind === 'heartbeat' ? 'Scheduler' : 'Whisper'}] ${taskKind} run`,
    });
    expect(runtime.inferPostTurnActions).toHaveBeenCalledWith(expect.objectContaining({
      taskKind,
    }));
  });

  it('routes runtime-authored repair guidance through system session + prompt lanes', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      expect.objectContaining({ sourceChannelId: 'ch1', logicalSessionId: 'ch1' }),
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
    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    const providerWireMessages = (promptContext?.providerObservability as {
      providerWireMessages?: Array<{ role: string; source: string; content: string }>;
    } | undefined)?.providerWireMessages;
    expect(providerWireMessages?.filter(providerMessage => providerMessage.source === 'message')).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining(
          '[System note] [SYSTEM: Runtime] tool notify is unavailable; choose another route',
        ),
      }),
    ]);
  });

  it('routes external turns through the canonical continuity subject instead of the session-local author id', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      actorKind: 'human',
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
      expect.objectContaining({
        sourceChannelId: 'discord:dm:alex',
        logicalSessionId: 'discord:dm:alex',
      }),
      expect.any(String),
      expect.any(String),
      'trusted',
      'contact-123',
      undefined,
      'human',
    );
    expect(recordAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'discord:dm:alex',
        authorId: 'discord-user-1',
      }),
      expect.objectContaining({
        sourceChannelId: 'discord:dm:alex',
        logicalSessionId: 'discord:dm:alex',
      }),
      expect.any(String),
      expect.any(String),
      'assistant reply',
      'trusted',
      'contact-123',
      null,
      undefined,
      undefined,
    );
    expect(buildContext.mock.calls[0]?.[4]).toBe('contact-123');
    expect(scheduleAutoCompactionBetweenTurns).not.toHaveBeenCalled();
    expect(runtime.enqueuePostTurnBackgroundWork).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        kind: 'auto_compaction',
        payload: expect.objectContaining({
          kind: 'auto_compaction',
          userId: 'contact-123',
        }),
      }),
    ]));
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
      manifest: makeContextManifestFixture(),
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
    const temporalRulesBlock = [
      '<temporal_rules>',
      '<rule>Treat runtime.current_datetime as the canonical source for the current date and time.</rule>',
      '</temporal_rules>',
    ].join('\n');
    runtime.resolveStaticPromptPrefix = vi.fn(async () => [
      'Rendered static prefix',
      temporalRulesBlock,
    ].join('\n\n'));
    runtime.getPersonaAdaptation = vi.fn(() => 'Persona hint');
    runtime.buildRuntimeContext = vi.fn(() => 'Runtime context block');
    runtime.buildScratchpadContextBlock = vi.fn(() => 'Scratchpad block');
    const historyAtPrompt: unknown[][] = [];
    runtime.agent.prompt = vi.fn(async (promptMessage: { role: string; content: string }) => {
      historyAtPrompt.push(runtime.agent.state.messages.map(historyMessage => ({ ...historyMessage })));
      runtime.agent.state.messages.push(
        promptMessage,
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'contact', arguments: { action: 'list' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'contact',
          content: [{ type: 'text', text: 'No contacts changed.' }],
          isError: false,
        },
        { role: 'assistant', content: 'assistant reply' },
      );
    });
    (runtime.applyActiveToolsToAgentForTurn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      runtime.agent.setTools([
        {
          name: 'contact',
          description: 'Manage contacts.',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              contactId: { type: 'string' },
            },
            required: ['action'],
          },
        },
      ]);
    });
    (runtime.getAdaptiveToolRuntimeState as ReturnType<typeof vi.fn>).mockReturnValue({
      generatedAt: 1_700_000_000_000,
      coreTools: ['contact'],
      extendedTools: [],
      promotedToolsConfigured: [],
      promotedToolsActive: [],
      promotedToolsSkipped: [],
      activeTools: [{ toolName: 'contact', source: 'core' }],
      lastSnapshot: {
        timestamp: 1_700_000_000_001,
        turnId: 'turn-1',
        requestId: 'msg-full-context',
        channelId: 'ch1',
        callType: 'chat',
        purpose: 'agent.tools.adaptive.snapshot',
        tools: [{ toolName: 'contact', source: 'core' }],
        skipped: [],
        counts: {
          core: 1,
          extended: 0,
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
    const plan = recordedInput.turnSnapshot?.plan as PromptPlan;
    const toolContext = recordedInput.turnSnapshot?.toolContext as Record<string, unknown> | undefined;
    expect(plan.schemaVersion).toBe(1);
    expect(getPromptPlanBlockText(plan, 'static_prefix')).toBe([
      'Rendered static prefix',
      temporalRulesBlock,
    ].join('\n\n'));
    expect(getPromptPlanBlockText(plan, 'dynamic_suffix')).toBe('Dynamic suffix template');
    expect(getPromptPlanBlockText(plan, 'runtime.context')).toBe('Runtime context block');
    expect(getPromptPlanBlockText(plan, 'runtime.scratchpad')).toBe('Scratchpad block');
    const assembledPrompt = renderPromptPlanAssembledPrompt(plan);
    expect(assembledPrompt).toContain('Rendered static prefix');
    expect(assembledPrompt).toContain('Persona hint');
    expect(assembledPrompt).toContain('Runtime context block');
    const finalSystemPrompt = serializePromptPlanSystemPrompt(plan);
    expect(plan.messages).toEqual([
      { role: 'user', content: 'Earlier user message' },
      { role: 'assistant', content: 'Earlier assistant reply' },
    ]);
    expect(plan.toolDefinitions).toMatchObject([{ name: 'contact' }]);
    const inputSections = promptContext?.inputSections as Array<{ id: string; content: string }> | undefined;
    expect(inputSections?.find(section => section.id === 'memory_context')?.content).toContain('Retrieved memory block');
    const finalSystemSections = promptContext?.finalSystemSections as Array<{
      id: string;
      tokenCount: number;
    }> | undefined;
    expect(finalSystemSections?.find(section => section.id === 'session_context')?.tokenCount).toBe(
      plan.blocks.find(block => block.id === 'session_context')?.tokensEst,
    );
    expect(finalSystemSections?.find(section => section.id === 'runtime.current_datetime')?.tokenCount).toBe(
      plan.blocks.find(block => block.id === 'runtime.current_datetime')?.tokensEst,
    );
    expect(promptContext?.currentTurnInput).toBe('Hello there');
    expect(promptContext?.response).toMatchObject({
      content: 'assistant reply',
      model: 'test-model',
    });
    expect(historyAtPrompt).toEqual([[
      expect.objectContaining({
        role: 'user',
        content: 'Earlier user message',
        timestamp: expect.any(Number),
      }),
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier assistant reply' }],
      }),
    ]]);
    expect(promptContext?.providerObservability).toMatchObject({
      backendApi: 'openai-completions',
      routeKind: 'registered_model',
      systemRole: {
        transport: 'openai_system',
      },
      providerWireMessages: [
        { role: 'system', source: 'system_prompt', content: finalSystemPrompt },
        { role: 'user', source: 'message', content: 'Earlier user message' },
        { role: 'assistant', source: 'message', content: expect.stringContaining('Earlier assistant reply') },
        { role: 'user', source: 'message', content: 'Hello there' },
      ],
    });
    expect(toolContext).toMatchObject({
      activeTools: [
        {
          name: 'contact',
          description: 'Manage contacts.',
        },
      ],
      adaptiveSnapshot: {
        tools: [{ toolName: 'contact', source: 'core' }],
        skipped: [],
      },
    });

    expect(emittedSnapshots).toHaveLength(5);
    expect(emittedSnapshots.at(-1)?.promptContext).toMatchObject({
      currentTurnInput: 'Hello there',
      response: {
        content: 'assistant reply',
        model: 'test-model',
      },
      providerObservability: {
        backendApi: 'openai-completions',
      },
    });
    expect(getPromptPlanBlockText(
      emittedSnapshots.at(-1)?.plan as PromptPlan,
      'runtime.context',
    )).toBe('Runtime context block');
    expect(emittedSnapshots.at(-1)?.toolContext).toMatchObject({
      activeTools: [{ name: 'contact' }],
    });
  });

  it('passes the just-recorded entry id to context assembly and prompts current input once', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [
        { role: 'user', content: 'Earlier user message' },
        { role: 'assistant', content: 'Earlier assistant reply' },
      ],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 77),
      recordAssistantMessage: vi.fn(() => 2),
    });
    const historyAtPrompt: unknown[][] = [];
    runtime.agent.prompt = vi.fn(async (promptMessage: { role: string; content: string }) => {
      historyAtPrompt.push(runtime.agent.state.messages.map(historyMessage => ({ ...historyMessage })));
      runtime.agent.state.messages.push(
        promptMessage,
        { role: 'assistant', content: 'assistant reply' },
      );
    });

    await handleMessageForTurn(runtime, createMessage('msg-current-input-in-history'));

    expect(buildContext.mock.calls[0]?.[11]).toBe(77);
    expect(historyAtPrompt).toEqual([[
      expect.objectContaining({
        role: 'user',
        content: 'Earlier user message',
        timestamp: expect.any(Number),
      }),
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier assistant reply' }],
      }),
    ]]);
    expect(runtime.agent.state.messages.filter(message => (
      message.role === 'user' && message.content === 'Hello there'
    ))).toHaveLength(1);
  });

  it('renders current group user attribution before the provider prompt without changing stored user content', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const recordUserMessage = vi.fn(() => 1);
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage,
      recordAssistantMessage: vi.fn(() => 2),
      resolveAuthorContext: vi.fn(() => ({
        trustLevel: 'regular',
        speakerRole: 'user',
        actorKind: 'human',
        resolvedUserName: 'Morgan',
        canonicalContactKey: 'contact-morgan',
        continuityFallbackKeys: [],
      })),
    });
    const historyAtPrompt: unknown[][] = [];
    runtime.agent.prompt = vi.fn(async (promptMessage: { role: string; content: string }) => {
      historyAtPrompt.push(runtime.agent.state.messages.map(historyMessage => ({ ...historyMessage })));
      runtime.agent.state.messages.push(
        promptMessage,
        { role: 'assistant', content: 'assistant reply' },
      );
    });

    await handleMessageForTurn(runtime, createMessage('msg-group-current', {
      channelId: '123456789012345678',
      channelType: 'discord',
      authorId: '388908766306893854',
      authorName: 'Morgan',
      content: 'can you hear us?',
      isDirectMessage: false,
    }));

    expect(historyAtPrompt).toEqual([[]]);
    expect(runtime.agent.prompt).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: 'Morgan (discord:388908766306893854): can you hear us?',
    }));
    expect(recordUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: '123456789012345678',
        authorId: '388908766306893854',
        authorName: 'Morgan',
        content: 'can you hear us?',
      }),
      expect.objectContaining({
        sourceChannelId: '123456789012345678',
        logicalSessionId: '123456789012345678',
      }),
      expect.any(String),
      'msg-group-current',
      'regular',
      'contact-morgan',
      undefined,
      'human',
    );
    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    const providerWireMessages = (promptContext?.providerObservability as {
      providerWireMessages?: Array<{ role: string; source: string; content: string }>;
    } | undefined)?.providerWireMessages;
    expect(providerWireMessages?.filter(providerMessage => providerMessage.source === 'message')).toEqual([
      {
        role: 'user',
        source: 'message',
        content: 'Morgan (discord:388908766306893854): can you hear us?',
      },
    ]);
  });

  it('keeps shadow-mode observability active by retaining the canary marker', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      cogSecMode: 'shadow',
    });

    await handleMessageForTurn(runtime, createMessage('msg-cogsec-shadow'));

    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const plan = recordedInput.turnSnapshot?.plan as PromptPlan;
    expect(getPromptPlanBlockText(plan, 'cogsec.canary')).toMatch(/^\[session-integrity cnry_/u);
    expect(serializePromptPlanSystemPrompt(plan)).toContain('session-integrity');
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
      manifest: makeContextManifestFixture(),
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
    runtime.resolveStaticPromptPrefix = vi.fn(async () => 'Rendered static prefix');
    runtime.buildRuntimeContext = vi.fn(() => 'Runtime context block');
    runtime.buildScratchpadContextBlock = vi.fn(() => '');
    runtime.getPersonaAdaptation = vi.fn(() => null);

    await handleMessageForTurn(runtime, createMessage('msg-system-context'));

    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    const plan = recordedInput.turnSnapshot?.plan as PromptPlan;
    const mergedSystemPrompt = [
      'Rendered static prefix',
      // htm9.18: the per-session canary marker is planted right after the static
      // prefix (session-stable, so it never churns the static cache region).
      getPromptPlanBlockText(plan, 'cogsec.canary'),
      'Dynamic suffix template',
      'Runtime context block',
      '<session_context>',
      '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.',
      '</session_context>',
    ].join('\n\n');
    expect(getPromptPlanBlockText(plan, 'cogsec.canary')).toMatch(/^\[session-integrity cnry_/u);
    const providerWireMessages = (promptContext?.providerObservability as {
      providerWireMessages?: Array<{ role: string; source: string; content: string }>;
    } | undefined)?.providerWireMessages;

    expect(plan.messages).toEqual([
      { role: 'user', content: 'Earlier user message' },
      { role: 'system', content: '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.' },
      { role: 'assistant', content: 'Earlier assistant reply' },
    ]);
    expect(getPromptPlanBlockText(plan, 'session_context')).toContain(
      '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.',
    );
    expect(serializePromptPlanSystemPrompt(plan)).toBe(mergedSystemPrompt);
    expect(providerWireMessages).toEqual([
      { role: 'system', source: 'system_prompt', content: mergedSystemPrompt },
      { role: 'user', source: 'message', content: 'Earlier user message' },
      { role: 'assistant', source: 'message', content: expect.stringContaining('Earlier assistant reply') },
      { role: 'user', source: 'message', content: 'Hello there' },
    ]);
    expect(providerWireMessages?.some(message => message.role === 'assistant'
      && message.content.includes('Queue a private follow-up reminder.'))).toBe(false);
  });

  it('promotes a just-delivered capability change out of history with the live turn tier', async () => {
    const eventBus = new EventBus();
    const noticeContent = '[SYSTEM: Capability policy] [System notice: capability access changed] '
      + 'The Operator changed your capability tier from "autonomous" to "nursery".';
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [
        { role: 'user' as const, content: 'Did anything change?' },
        { role: 'assistant' as const, content: 'Nothing I noticed yet.' },
        {
          role: 'system' as const,
          content: noticeContent,
          provenance: buildAuthenticityProvenance({
            kind: 'system_note',
            sourceAuthor: 'system',
            transformedBy: 'system',
            wording: 'direct',
            directSpeech: false,
            detailLoss: 'none',
            emotionalTexture: 'unknown',
            safeAsPartnerSpeech: false,
            sourceSpanCount: 1,
            sourceEntryIds: [41],
            notes: [CAPABILITY_TIER_CHANGE_NOTICE_PROVENANCE_NOTE],
          }),
        },
      ],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 42),
      recordAssistantMessage: vi.fn(() => 43),
    });
    runtime.captureTurnPromptSnapshot = vi.fn(() => ({
      staticPrefixTemplate: 'Static prefix template',
      dynamicSuffixTemplate: 'Dynamic suffix template',
      staticHash: 'static-hash',
      versionPointer: 'prompt-v1',
    }));
    runtime.resolveStaticPromptPrefix = vi.fn(async () => 'Rendered static prefix');
    runtime.buildRuntimeContext = vi.fn(() => 'Runtime context block');
    runtime.buildScratchpadContextBlock = vi.fn(() => '');
    runtime.getPersonaAdaptation = vi.fn(() => null);
    runtime.buildDynamicPromptTemplateVariables = vi.fn(async () => ({
      ...BASE_TURN_PROMPT_VARIABLES,
      runtime_capability_tier: 'nursery',
    }));

    await handleMessageForTurn(runtime, createMessage('msg-fresh-capability-change', {
      content: 'Did anything change?',
    }));

    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const plan = recordedInput.turnSnapshot?.plan as PromptPlan;
    const freshBlock = getPromptPlanBlockText(plan, 'recent_capability_change');
    const finalSystemPrompt = serializePromptPlanSystemPrompt(plan);

    expect(freshBlock).toContain('<status>fresh_runtime_event</status>');
    expect(freshBlock).toContain('<current_live_tier>nursery</current_live_tier>');
    expect(freshBlock).toContain('mention the capability change directly');
    expect(freshBlock).toContain(noticeContent);
    expect(getPromptPlanBlockText(plan, 'session_context')).not.toContain(noticeContent);
    expect(finalSystemPrompt.match(/\[System notice: capability access changed\]/gu)).toHaveLength(1);
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
      manifest: makeContextManifestFixture(),
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
    const temporalRulesBlock = [
      '<temporal_rules>',
      '<rule>Treat runtime.current_datetime as the canonical source for the current date and time.</rule>',
      '</temporal_rules>',
    ].join('\n');
    runtime.resolveStaticPromptPrefix = vi.fn(async () => [
      'Rendered static prefix',
      temporalRulesBlock,
    ].join('\n\n'));
    runtime.buildRuntimeContext = vi.fn(() => 'Runtime context block');
    runtime.buildScratchpadContextBlock = vi.fn(() => '');
    runtime.getPersonaAdaptation = vi.fn(() => null);
    runtime.buildDynamicPromptTemplateVariables = vi.fn(() => ({
      ...BASE_TURN_PROMPT_VARIABLES,
      active_timezone: 'America/New_York',
      runtime_current_weekday: 'Wednesday',
      runtime_current_date_human: 'March 18, 2026',
      runtime_current_time_human: '9:30 AM',
      runtime_current_datetime_iso: '2026-03-18T09:30:00.000-04:00',
      runtime_current_today: '2026-03-18',
      runtime_current_yesterday: '2026-03-17',
      runtime_current_tomorrow: '2026-03-19',
      runtime_current_part_of_day: 'late morning',
    }));

    await handleMessageForTurn(runtime, createMessage('msg-current-datetime-anchor'));

    const fullPrompt = buildContext.mock.calls[0]?.[1] as string;
    const buildTurnRecordMock = runtime.buildTurnRecord as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    // 6ahp: the anchor renders the instant once in human-readable form; the
    // redundant <iso> and <today> restatements were dropped (the underlying
    // macros remain available for authors who need a machine form).
    const currentDatetimeAnchor = [
      '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,cross_channel_continuity">',
      '<timezone>America/New_York</timezone>',
      '<weekday>Wednesday</weekday>',
      '<date>March 18, 2026</date>',
      '<time>9:30 AM</time>',
      '<yesterday>2026-03-17</yesterday>',
      '<tomorrow>2026-03-19</tomorrow>',
      '<part_of_day>late morning</part_of_day>',
      '</runtime.current_datetime>',
    ].join('\n');
    const plan = recordedInput.turnSnapshot?.plan as PromptPlan;
    // htm9.18: the per-session canary marker ships right after the static prefix
    // block (which here carries the temporal rules) and before the dynamic
    // suffix. Splice it into the expected merge at that position.
    const mergedSystemPrompt = [
      'Rendered static prefix',
      temporalRulesBlock,
      getPromptPlanBlockText(plan, 'cogsec.canary'),
      'Dynamic suffix template',
      'Runtime context block',
      '<session_context>',
      '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.',
      '</session_context>',
      currentDatetimeAnchor,
    ].join('\n\n');
    const finalSystemPrompt = serializePromptPlanSystemPrompt(plan);
    const providerWireMessages = (promptContext?.providerObservability as {
      providerWireMessages?: Array<{ role: string; source: string; content: string }>;
    } | undefined)?.providerWireMessages;
    const inputSections = promptContext?.inputSections as Array<{ id: string; content: string }> | undefined;
    const finalSystemSections = promptContext?.finalSystemSections as Array<{ id: string; content: string }> | undefined;

    expect(fullPrompt).toContain('Dynamic suffix template');
    expect(fullPrompt).toContain(temporalRulesBlock);
    expect(fullPrompt).not.toContain('Stale legacy date');
    expect(finalSystemPrompt).toBe(mergedSystemPrompt);
    expect(finalSystemPrompt.endsWith(currentDatetimeAnchor)).toBe(true);
    expect(finalSystemPrompt.indexOf('</session_context>')).toBeLessThan(
      finalSystemPrompt.lastIndexOf('<runtime.current_datetime'),
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
        id: 'temporal_rules',
        content: temporalRulesBlock,
      }),
      expect.objectContaining({
        id: 'runtime.current_datetime',
        content: currentDatetimeAnchor,
      }),
    ]));
    expect(inputSections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'temporal_rules',
        content: temporalRulesBlock,
      }),
    ]));
  });

  it('keeps runtime-layer suffixes active when a custom system prompt override is used', async () => {
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      'session.cogsec_notices',
    ], 'admin');

    const buildContext = vi.fn(async () => ({
      systemPrompt: 'Final system prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
    runtime.resolveStaticPromptPrefix = vi.fn(async () => 'Rendered static prefix');
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
      manifest: makeContextManifestFixture(),
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
      manifest: makeContextManifestFixture(),
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
      ...(input.continuationStop ? { continuationStop: input.continuationStop } : {}),
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
    const failedAssistant = {
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
        { type: 'text', text: 'Partial response before tool failure.' },
        { type: 'thinking', thinking: 'Need the memory tool first.' },
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'memory_write',
          arguments: { text: 'secret value' },
          thoughtSignature: 'sig-2',
        },
      ],
    };
    runtime.getLatestAssistantMessage = vi.fn(() => failedAssistant as never);
    runtime.extractResponseText = vi.fn(() => 'Partial response before tool failure.');
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push(failedAssistant);
      (fromAny(runtime.agent.state.messages)).push({
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
      assistantMessageContent: 'Partial response before tool failure.',
      turnMessages: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({ role: 'toolResult', toolName: 'memory_write' }),
      ]),
    }), expect.anything());
    expect(runtime.sessionManager.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
    }));
  });

  it('records and emits a content-free typed stop when the parent continuation fuse opens', async () => {
    const eventBus = new EventBus();
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
    });
    runtime.getLatestAssistantMessage = vi.fn(() => ({
      role: 'assistant',
      content: [{ type: 'text', text: 'stale assistant text from the prior turn' }],
    }) as never);
    runtime.extractResponseText = vi.fn(() => 'stale assistant text from the prior turn');
    const buildTurnRecord = vi.fn((input: Parameters<TurnExecutionRuntime['buildTurnRecord']>[0]) => ({
      schemaVersion: 1 as const,
      turnId: input.turnId,
      requestId: input.requestId,
      channelId: input.message.channelId,
      channelType: input.message.channelType,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: input.status ?? 'completed',
      ...(input.continuationStop ? { continuationStop: input.continuationStop } : {}),
      userMessage: {
        role: input.speakerRole,
        content: input.message.content,
        timestamp: input.message.timestamp.getTime(),
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: { model: input.model ?? 'test-model' },
      provenanceRefs: [],
    }));
    runtime.buildTurnRecord = buildTurnRecord as unknown as TurnExecutionRuntime['buildTurnRecord'];
    runtime.agent.prompt = vi.fn(async () => {
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'search-3',
          name: 'session_search_summary',
          arguments: { query: 'private partner content must not enter telemetry' },
        }],
        stopReason: 'toolUse',
      });
      throw new ParentTurnContinuationBudgetExceededError({
        schemaVersion: 1,
        reason: 'wall_clock_limit',
        promptEntries: 3,
        maxPromptEntries: 36,
        elapsedMs: 300_000,
        maxWallTimeMs: 300_000,
      });
    });

    await expect(handleMessageForTurn(
      runtime,
      createMessage('msg-continuation-budget'),
    )).rejects.toMatchObject({
      code: 'parent_turn_continuation_budget_exceeded',
    });

    const expectedStop = {
      schemaVersion: 1,
      reason: 'wall_clock_limit',
      outcome: 'failed',
      promptEntries: 3,
      maxPromptEntries: 36,
      elapsedMs: 300_000,
      maxWallTimeMs: 300_000,
    };
    expect(buildTurnRecord).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      continuationStop: expectedStop,
    }), expect.anything());
    expect(runtime.sessionManager.recordTurn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      continuationStop: expectedStop,
    }));
    expect(runtime.extractResponseText).not.toHaveBeenCalled();
    expect(runtime.emitTelemetry).toHaveBeenCalledWith(
      'agent.turn.continuation_stopped',
      expect.objectContaining({
        requestId: 'msg-continuation-budget',
        channelId: 'ch1',
        stop: expectedStop,
      }),
    );
    const telemetryPayload = (runtime.emitTelemetry as ReturnType<typeof vi.fn>).mock.calls
      .find(([eventName]) => eventName === 'agent.turn.continuation_stopped')?.[1];
    expect(JSON.stringify(telemetryPayload)).not.toContain('private partner content');
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
      manifest: makeContextManifestFixture(),
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
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-parallel-memory')))
      .resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });

    expect(captureTurnMemorySnapshot).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
    expect(buildContext).toHaveBeenCalledTimes(1);
  });

  it('threads temporal retrieval mode through active memory refresh scheduling', async () => {
    const eventBus = new EventBus();
    let refreshRequestContext: ReturnType<typeof getRequestContext>;
    const refreshActiveMemoryContext = vi.fn(async () => {
      refreshRequestContext = getRequestContext();
      return null;
    });
    const rolledOutSessionBoundary = {
      sessionId: 'ch1',
      beforeMs: Date.parse('2026-07-17T12:00:00.000Z'),
    };
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {
        captureTurnSessionContext: vi.fn(async (input: { channelId: string }) => ({
          channelId: input.channelId,
          recentEntries: [],
          sourceEntryCount: 12,
          rolledOutSessionBoundary,
          compactionSummaryTexts: [],
          focusKnowledgeTexts: [],
          continuityEntries: [],
          versionPointer: 'rolled-out-session-context',
        })),
      } as unknown as SessionManager,
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
      sessionChannelId: 'ch1',
      rolledOutSessionBoundary,
      trustLevel: 'regular',
      channelMeta: {},
      canonicalContactId: 'contact-1',
      turnBudgetCharacteristics: expect.objectContaining({ messageText: 'what time is it?' }),
      callerContext: { retrievalMode: 'temporal' },
      retrievalMode: 'temporal',
    }));
    expect(refreshRequestContext).toMatchObject({
      sessionId: 'ch1',
      channelId: 'ch1',
      callType: 'memory',
      originType: 'memory',
      originStage: 'memory.active_context.refresh',
      runtimeLaneClass: 'maintenance_reflection',
    });
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
      // E5.5: retrieval events now surface from the background active-context
      // refresh; the turn hot path never blocks on retrieve().
      const refreshActiveMemoryContext = vi.fn(async () => {
        await eventBus.emit('memory.retrieval', {
          turnId: activeTurnId,
          channelId: 'ch1',
          requestId: 'msg-warning-stage',
          count: 2,
          selectedTypes: { reflection: 2 },
        });
        return null;
      });
      const buildContext = vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      }));
      const runtime = createRuntime({
        eventBus,
        sessionManager: {
          captureTurnSessionContext: vi.fn(async () => ({
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
          getActiveMemoryContext: vi.fn(() => null),
          refreshActiveMemoryContext,
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
        'temporal_reflection_only_retrieval',
        'values_activity_contradiction',
      ]);
      expect(contextStage?.data.observabilityCounters).toEqual({
        warningCount: 4,
        historySpanExceededCount: 1,
        staleToolObservationVerbatimCount: 1,
        temporalReflectionOnlyRetrievalCount: 2,
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
      manifest: makeContextManifestFixture(),
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

  it('threads typed audience=self access into free-time active-memory refreshes', async () => {
    const eventBus = new EventBus();
    const observedRequestContexts: Array<ReturnType<typeof getRequestContext>> = [];
    const refreshActiveMemoryContext = vi.fn(async () => {
      observedRequestContexts.push(getRequestContext());
      return null;
    });
    const getActiveMemoryContext = vi.fn(() => null);
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: createRuntimeSessionManager(),
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      resolveAuthorContext: vi.fn(() => ({
        trustLevel: 'primary',
        speakerRole: 'system',
        actorKind: 'unknown',
        resolvedUserName: 'Free Time',
        continuityFallbackKeys: [],
      })),
      memoryProvider: {
        getActiveMemoryContext,
        refreshActiveMemoryContext,
        retrieve: vi.fn(async () => ''),
      },
    });

    await handleMessageForTurn(runtime, createMessage('msg-free-time-self', {
      channelId: 'internal:free-time:idle',
      authorId: 'scheduler',
      authorName: 'Free Time',
    }));
    await vi.waitFor(() => expect(refreshActiveMemoryContext).toHaveBeenCalledTimes(1));

    expect(getActiveMemoryContext).toHaveBeenCalledWith(expect.objectContaining({
      callerContext: { accessScope: 'companion_self_creation' },
    }));
    expect(refreshActiveMemoryContext).toHaveBeenCalledWith(expect.objectContaining({
      callerContext: { accessScope: 'companion_self_creation' },
    }));
    expect(observedRequestContexts[0]).toMatchObject({
      channelId: 'internal:free-time:idle',
      requesterProvenance: 'self_directed',
      requestAudience: 'self',
      purpose: 'free_time.creation.memory_retrieval',
      runtimeLaneClass: 'background_continuation',
    });
  });

  it('does not grant self access to an ambiguous internal audience', async () => {
    const eventBus = new EventBus();
    const refreshActiveMemoryContext = vi.fn(async () => null);
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
    }));
    const runtime = createRuntime({
      eventBus,
      sessionManager: createRuntimeSessionManager(),
      buildContext,
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      resolveAuthorContext: vi.fn(() => ({
        trustLevel: 'primary',
        speakerRole: 'system',
        actorKind: 'unknown',
        resolvedUserName: 'System',
        continuityFallbackKeys: [],
      })),
      memoryProvider: {
        getActiveMemoryContext: vi.fn(() => null),
        refreshActiveMemoryContext,
        retrieve: vi.fn(async () => ''),
      },
    });

    await handleMessageForTurn(runtime, createMessage('msg-internal-ambiguous', {
      channelId: 'internal:unclassified-work',
      authorId: 'scheduler',
    }));
    await vi.waitFor(() => expect(refreshActiveMemoryContext).toHaveBeenCalledTimes(1));

    expect(refreshActiveMemoryContext).toHaveBeenCalledWith(expect.not.objectContaining({
      callerContext: expect.objectContaining({ accessScope: 'companion_self_creation' }),
    }));
  });

  it('classifies a primary private human DM as the ungated primary-contact audience', async () => {
    const observedAudiences: unknown[] = [];
    const runtime = createRuntime({
      eventBus: new EventBus(),
      sessionManager: createRuntimeSessionManager(),
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      resolveAuthorContext: vi.fn(() => ({
        trustLevel: 'primary',
        speakerRole: 'user',
        actorKind: 'human',
        resolvedUserName: 'Morgan',
        canonicalContactKey: 'contact-v',
        continuityFallbackKeys: [],
      })),
    });
    vi.mocked(runtime.agent.prompt).mockImplementationOnce(async () => {
      observedAudiences.push(getRequestContext()?.requestAudience);
      runtime.agent.state.messages.push({ role: 'assistant', content: 'hello Morgan' });
    });

    await handleMessageForTurn(runtime, createMessage('msg-primary-contact', {
      channelId: 'api:primary-contact',
      isDirectMessage: true,
      routing: { channelPrivacy: 'private' },
    }));

    expect(observedAudiences).toEqual(['primary_contact']);
  });

  it('keeps the foreground response path open when active memory refresh rejects', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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

  it('fails closed when the memory provider lacks the active-context surface instead of blocking on legacy retrieve', async () => {
    const eventBus = new EventBus();
    const retrieve = vi.fn(async () => 'legacy blocking memories');
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
        retrieve,
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-legacy-only-provider')))
      .rejects.toThrow(/blocking legacy retrieval fallback is retired/);
    expect(retrieve).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();
  });

  it('emits a typed not_ready degradation event when the turn proceeds without an active memory context', async () => {
    const eventBus = new EventBus();
    const degradedEvents: Array<EventMap['memory.active_context.turn_degraded']> = [];
    eventBus.on('memory.active_context.turn_degraded', event => {
      degradedEvents.push(event);
    });
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-degraded-not-ready')))
      .resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
    await flushAsyncWork();

    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]).toMatchObject({
      channelId: 'ch1',
      key: 'unresolved',
      reason: 'not_ready',
      refreshStatus: null,
    });
    // The turn proceeds on the last-good (here: empty) context.
    expect(buildContext.mock.calls[0]?.[2]).toBe('');
  });

  it('emits refresh_failed and serves the last-good context when the active memory snapshot is degraded', async () => {
    const eventBus = new EventBus();
    const degradedEvents: Array<EventMap['memory.active_context.turn_degraded']> = [];
    eventBus.on('memory.active_context.turn_degraded', event => {
      degradedEvents.push(event);
    });
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
          key: 'active-memory:degraded-key',
          subjectKey: 'contact:contact-1',
          channelId: 'ch1',
          trustLevel: 'regular',
          channelVisibility: 'private',
          visibilityScope: 'non_broadcast',
          contextBlock: 'last-good memory block',
          contextChars: 'last-good memory block'.length,
          selectedMemoryIds: ['mem-1'],
          generatedAt: Date.now(),
          lastRefreshStartedAt: Date.now(),
          refreshStatus: 'degraded',
          versionPointer: 'active-memory-v1',
          lastRefreshError: 'embedding backend unavailable',
        })),
        refreshActiveMemoryContext: vi.fn(async () => null),
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await expect(handleMessageForTurn(runtime, createMessage('msg-degraded-refresh-failed')))
      .resolves.toMatchObject({ content: 'assistant reply', channelId: 'ch1' });
    await flushAsyncWork();

    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]).toMatchObject({
      channelId: 'ch1',
      key: 'active-memory:degraded-key',
      reason: 'refresh_failed',
      refreshStatus: 'degraded',
      lastRefreshError: 'embedding backend unavailable',
    });
    expect(buildContext.mock.calls[0]?.[2]).toBe('last-good memory block');
  });

  it('emits stale when the served snapshot is still refreshing from an earlier pass and stays silent when ready', async () => {
    const eventBus = new EventBus();
    const degradedEvents: Array<EventMap['memory.active_context.turn_degraded']> = [];
    eventBus.on('memory.active_context.turn_degraded', event => {
      degradedEvents.push(event);
    });
    const makeSnapshot = (refreshStatus: 'refreshing' | 'ready') => ({
      key: 'active-memory:refresh-lag-key',
      subjectKey: 'contact:contact-1',
      channelId: 'ch1',
      trustLevel: 'regular',
      channelVisibility: 'private',
      visibilityScope: 'non_broadcast',
      contextBlock: 'still useful memory block',
      contextChars: 'still useful memory block'.length,
      selectedMemoryIds: ['mem-1'],
      generatedAt: Date.now(),
      lastRefreshStartedAt: Date.now(),
      refreshStatus,
      versionPointer: 'active-memory-v1',
    });
    const getActiveMemoryContext = vi.fn(() => makeSnapshot('refreshing'));
    const runtime = createRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
      memoryProvider: {
        getActiveMemoryContext,
        refreshActiveMemoryContext: vi.fn(async () => null),
      } as unknown as TurnExecutionRuntime['memoryProvider'],
    });

    await handleMessageForTurn(runtime, createMessage('msg-degraded-stale'));
    await flushAsyncWork();

    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]).toMatchObject({
      key: 'active-memory:refresh-lag-key',
      reason: 'stale',
      refreshStatus: 'refreshing',
    });

    getActiveMemoryContext.mockImplementation(() => makeSnapshot('ready'));
    await handleMessageForTurn(runtime, createMessage('msg-degraded-ready'));
    await flushAsyncWork();

    // A ready snapshot is the healthy steady state: no degradation event.
    expect(degradedEvents).toHaveLength(1);
  });

  it('bypasses generic memory retrieval for live image turns', async () => {
    const eventBus = new EventBus();
    const getActiveMemoryContext = vi.fn(() => null);
    const refreshActiveMemoryContext = vi.fn(async () => null);
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      manifest: makeContextManifestFixture(),
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
      'Current image review (untrusted image-derived data):',
    );
    expect((runtime.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.content).toContain(
      'A catgirl sits on a server rack holding a pink rifle.',
    );
    expect(recordUserMessage).toHaveBeenCalledTimes(1);
    const persistedUserContent = recordUserMessage.mock.calls[0]?.[6] as string;
    expect(persistedUserContent).toContain('do you see it?');
    expect(persistedUserContent).toContain('---\nImage attachment:');
    expect(persistedUserContent).toContain('Description (untrusted image-derived data): A catgirl sits on a server rack holding a pink rifle.');
    expect(persistedUserContent).toContain('Model: vision-model');
    expect(persistedUserContent).toContain('Image count: 1');
    const buildTurnRecordMock = runtime.buildTurnRecord as unknown as ReturnType<typeof vi.fn>;
    expect(buildTurnRecordMock.mock.calls[0]?.[0]?.persistedUserMessageContent).toBe(persistedUserContent);
  });

  it('redacts inline image bytes from the persisted provider transcript', async () => {
    const rawImageBytes = 'c2Vuc2l0aXZlLWltYWdlLWJ5dGVz';
    const runtime = createRuntime({
      eventBus: new EventBus(),
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
    });

    await handleMessageForTurn(runtime, createMessage('msg-inline-image-observability', {
      channelType: 'api',
      content: 'look at this',
      attachments: [{
        url: 'https://example.test/current-image.png',
        contentType: 'image/png',
        name: 'current-image.png',
        dataBase64: rawImageBytes,
      }],
    }));

    const buildTurnRecordMock = runtime.buildTurnRecord as unknown as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    const providerWireMessages = (promptContext?.providerObservability as {
      providerWireMessages?: Array<{ content: string }>;
    } | undefined)?.providerWireMessages;
    expect(JSON.stringify(providerWireMessages)).not.toContain(rawImageBytes);
    expect(JSON.stringify(providerWireMessages)).toContain('[omitted]');
  });

  it('persists an unavailable image-description block when dedicated image review fails', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
    const persistedUserContent = recordUserMessage.mock.calls[0]?.[6] as string;
    expect(persistedUserContent).toContain('what did i send?');
    expect(persistedUserContent).toContain('---\nImage attachment:');
    expect(persistedUserContent).toContain(
      'Description unavailable: vision pipeline failed before image contents could be inspected.',
    );
    expect(persistedUserContent).toContain('Image count: 1');
    expect(persistedUserContent).not.toContain('signed_url_secret');
    const buildTurnRecordMock = runtime.buildTurnRecord as unknown as ReturnType<typeof vi.fn>;
    expect(buildTurnRecordMock.mock.calls[0]?.[0]?.persistedUserMessageContent).toBe(persistedUserContent);
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    const promptContext = recordedInput.turnSnapshot?.promptContext as Record<string, unknown> | undefined;
    expect(JSON.stringify(promptContext)).not.toContain('signed_url_secret');
  });

  it('keeps outer vision content-build errors out of prompts and durable diagnostics', async () => {
    mockedBuildTurnUserContent.mockRejectedValueOnce(
      new Error('outer vision failure signed_url_secret=abc123'),
    );
    const runtime = createRuntime({
      eventBus: new EventBus(),
      sessionManager: {} as SessionManager,
      buildContext: vi.fn(async () => ({
        systemPrompt: 'System prompt',
        messages: [],
        manifest: makeContextManifestFixture(),
      })),
      scheduleAutoCompactionBetweenTurns: vi.fn(async () => undefined),
      awaitPendingAutoCompaction: vi.fn(async () => undefined),
      recordUserMessage: vi.fn(() => 1),
      recordAssistantMessage: vi.fn(() => 2),
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-vision-outer-failure', {
      channelType: 'discord',
      content: 'what is in this image?',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    const promptContent = (runtime.agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.content;
    expect(promptContent).toContain('Vision pipeline status: unavailable after runtime inspection attempts.');
    expect(promptContent).not.toContain('signed_url_secret');
    expect(JSON.stringify(response.metadata.diagnostics)).not.toContain('signed_url_secret');
    expect(response.metadata.diagnostics).toMatchObject({
      fallback: {
        code: 'vision_content_unavailable',
        previousErrorMessage: 'Vision content build failed.',
      },
    });
    const buildTurnRecordMock = runtime.buildTurnRecord as unknown as ReturnType<typeof vi.fn>;
    const recordedInput = buildTurnRecordMock.mock.calls[0]?.[0] as { turnSnapshot?: Record<string, unknown> };
    expect(JSON.stringify(recordedInput.turnSnapshot?.promptContext)).not.toContain('signed_url_secret');
  });

  it('exposes current-turn image attachment context to tools during prompt execution', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({ role: 'assistant', content: 'assistant reply' });
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

  it('resolves the complete tool catalog before rendering dynamic prompt variables', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
    runtime.resolveToolTurnOutcome = vi.fn(() => ({
      intent: 'social',
    }));
    runtime.applyActiveToolsToAgentForTurn = vi.fn(() => {
      callOrder.push('apply-tools');
      runtime.agent.state.tools = fromAny([{
        name: 'selfie_create',
        description: 'Generate a dedicated selfie or self-portrait of the companion.',
        inputSchema: { type: 'object' },
      }]);
    });
    runtime.buildDynamicPromptTemplateVariables = vi.fn(() => {
      callOrder.push('dynamic-prompt');
      expect((runtime.agent.state.tools as Array<{ name?: string }>).some(tool => tool.name === 'selfie_create'))
        .toBe(true);
      return {
        ...BASE_TURN_PROMPT_VARIABLES,
        runtime_self_image_tool_active: 'true',
      };
    });

    await handleMessageForTurn(runtime, createMessage('msg-selfie-catalog-prompt', {
      channelType: 'discord',
      content: 'take a selfie',
    }));

    expect(runtime.resolveToolTurnOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'take a selfie',
      }),
      undefined,
    );
    expect(callOrder).toEqual(['apply-tools', 'dynamic-prompt']);
  });

  it('exposes appearance context to tools when selfie_create is active for the turn', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      runtime.agent.state.tools = fromAny([{
        name: 'selfie_create',
        description: 'Generate a dedicated selfie or self-portrait of the companion.',
        inputSchema: { type: 'object' },
      }]);
    });
    let observedContext: ReturnType<typeof getVisionToolRequestContext> | undefined;
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      observedContext = getVisionToolRequestContext();
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({ role: 'assistant', content: 'assistant reply' });
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
      manifest: makeContextManifestFixture(),
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
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({ role: 'assistant', content: 'assistant reply' });
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

  it('persists forced vision-failure provenance at the session and turn record boundary', async () => {
    const dataDir = makeTempDir();
    const eventBus = new EventBus();
    const { runtime, store } = createPersistenceBackedRuntime(dataDir, eventBus);
    runtime.agent.prompt = vi.fn(async () => {
      throw new Error('vision provider unavailable');
    });

    await handleMessageForTurn(runtime, createMessage('msg-vision-persisted-fallback', {
      channelType: 'discord',
      content: 'what is in the image?',
      attachments: [{
        url: 'https://cdn.discordapp.com/attachments/1/2/current-image.png?ex=fresh',
        contentType: 'image/png',
        name: 'current-image.png',
      }],
    }));

    const assistantEntry = store.getRecent('ch1', 10).find(entry => entry.role === 'assistant');
    expect(JSON.parse(assistantEntry?.metadata ?? '{}')).toMatchObject({
      runtimeFallbackProvenance: {
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'runtime_nonfabricating_notice',
      },
    });
    const turnRecord = store.getRecentTurnRecords('ch1', 1)[0];
    expect(turnRecord.assistantMessage).toMatchObject({
      runtimeFallbackProvenance: {
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'runtime_nonfabricating_notice',
      },
    });

    // psfn-framework-zagpk acceptance: the persisted runtime-authored fallback
    // entry must not be eligible for companion self-report extraction, and its
    // text must be rejected by the CogSec memory-candidacy backstop. Drive the
    // REAL downstream checks against the exact persisted entry shape.
    expect(assistantEntry).toBeDefined();
    expect(isExtractionTranscriptEntry(assistantEntry!)).toBe(false);
    expect(evaluateCogSecMemoryCandidacy({
      text: assistantEntry!.content,
      type: 'episodic',
      tags: [],
    })).toMatchObject({
      disposition: 'reject',
      reasonCodes: ['runtime_fallback_notice'],
    });
  });

  it('preserves a contradictory retry verbatim and surfaces the concern as a system note', async () => {
    const dataDir = makeTempDir();
    const eventBus = new EventBus();
    const guardActivations: EventMap['agent.datetime_guard.activation'][] = [];
    eventBus.on('agent.datetime_guard.activation', (event) => {
      guardActivations.push(event);
    });
    const { runtime, store, sessionManager } = createPersistenceBackedRuntime(dataDir, eventBus);
    runtime.buildDynamicPromptTemplateVariables = vi.fn(() => ({
      ...BASE_TURN_PROMPT_VARIABLES,
      active_timezone: 'America/New_York',
      runtime_current_weekday: 'Wednesday',
      runtime_current_date_human: 'March 18, 2026',
      runtime_current_time_human: '9:30 AM',
      runtime_current_datetime_iso: '2026-03-18T09:30:00.000-04:00',
      runtime_current_today: '2026-03-18',
      runtime_current_yesterday: '2026-03-17',
      runtime_current_tomorrow: '2026-03-19',
      runtime_current_part_of_day: 'late morning',
    }));
    const initialContradictoryResponse = 'The clock is off. That cannot be right.';
    const retriedContradictoryResponse = 'The time is wrong. Are you sure this is right?';
    let promptAttempt = 0;
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{
          type: 'text',
          text: promptAttempt++ === 0
            ? initialContradictoryResponse
            : retriedContradictoryResponse,
        }],
        api: 'openai-completions',
        provider: 'test',
        model: 'test-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-datetime-persisted-fallback', {
      content: 'What time is it?',
    }));

    expect(response.metadata.diagnostics?.runtimeContradiction).toMatchObject({
      retryAttempted: true,
      retrySucceeded: false,
      refusalApplied: false,
    });
    expect(runtime.agent.prompt).toHaveBeenCalledTimes(2);
    expect(response.content).toBe(retriedContradictoryResponse);
    expect(response.metadata.runtimeFallbackProvenance).toBeUndefined();

    const persistedEntries = store.getRecent('ch1', 10);
    const assistantEntries = persistedEntries.filter(entry => entry.role === 'assistant');
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]).toMatchObject({
      role: 'assistant',
      content: retriedContradictoryResponse,
    });
    expect(JSON.parse(assistantEntries[0]?.metadata ?? '{}'))
      .not.toHaveProperty('runtimeFallbackProvenance');

    const systemNoteEntry = persistedEntries.find(entry => entry.role === 'system');
    expect(systemNoteEntry).toMatchObject({
      role: 'system',
      content: expect.stringContaining('authoritative runtime current_datetime anchor'),
    });
    expect(JSON.parse(systemNoteEntry?.metadata ?? '{}')).toMatchObject({
      sessionLane: {
        schemaVersion: 1,
        kind: 'system_note',
        source: 'runtime_datetime_contradiction_guard',
      },
    });
    expect(sessionEntryToMessage(systemNoteEntry!)).toMatchObject({
      role: 'custom',
      type: 'systemNote',
      messageClass: 'systemNote',
    });

    const turnRecord = store.getRecentTurnRecords('ch1', 1)[0];
    expect(turnRecord.assistantMessage).toMatchObject({ content: retriedContradictoryResponse });
    expect(turnRecord.assistantMessage?.runtimeFallbackProvenance).toBeUndefined();

    const nextTurnContext = await sessionManager.buildContext('ch1', 'System prompt', '');
    expect(nextTurnContext.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('authoritative runtime current_datetime anchor'),
      provenance: expect.objectContaining({ kind: 'system_note' }),
    }));

    // psfn-framework-upx0.13: guard activations surface as typed, content-free
    // bus events for Garden visibility — signal ids and outcomes, not her text.
    expect(guardActivations).toHaveLength(2);
    expect(guardActivations[0]).toMatchObject({
      channelId: 'ch1',
      stage: 'initial',
      outcome: 'retry_scheduled',
      matchedSignals: ['clock_is_off', 'cannot_be_right'],
      attempts: 1,
    });
    expect(guardActivations[1]).toMatchObject({
      channelId: 'ch1',
      stage: 'retry',
      outcome: 'system_note_appended',
      matchedSignals: ['time_is_wrong', 'are_you_sure'],
      attempts: 2,
    });
    for (const activation of guardActivations) {
      expect(typeof activation.turnId).toBe('string');
      expect(activation.turnId.length).toBeGreaterThan(0);
      expect(JSON.stringify(activation)).not.toContain('The clock is off');
    }
  });

  it('does not treat a non-datetime "are you sure?" reply as a datetime contradiction (psfn-framework-upx0.13)', async () => {
    const dataDir = makeTempDir();
    const eventBus = new EventBus();
    const guardActivations: EventMap['agent.datetime_guard.activation'][] = [];
    eventBus.on('agent.datetime_guard.activation', (event) => {
      guardActivations.push(event);
    });
    const { runtime, store } = createPersistenceBackedRuntime(dataDir, eventBus);
    runtime.buildDynamicPromptTemplateVariables = vi.fn(() => ({
      ...BASE_TURN_PROMPT_VARIABLES,
      active_timezone: 'America/New_York',
      runtime_current_weekday: 'Wednesday',
      runtime_current_date_human: 'March 18, 2026',
      runtime_current_time_human: '9:30 AM',
      runtime_current_datetime_iso: '2026-03-18T09:30:00.000-04:00',
      runtime_current_today: '2026-03-18',
      runtime_current_yesterday: '2026-03-17',
      runtime_current_tomorrow: '2026-03-19',
      runtime_current_part_of_day: 'late morning',
    }));
    const validNonDatetimeReply = 'Are you sure you want me to delete all three branches? That seems drastic, but it must be a bug report waiting to happen if we keep them.';
    runtime.agent.prompt = vi.fn(async (promptMessage: { content: string }) => {
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({
        role: 'assistant',
        content: [{ type: 'text', text: validNonDatetimeReply }],
        api: 'openai-completions',
        provider: 'test',
        model: 'test-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
    });

    const response = await handleMessageForTurn(runtime, createMessage('msg-datetime-false-positive', {
      content: 'Clean up the old branches?',
    }));

    // The reply passes through untouched: no retry, no diagnostics, no events.
    expect(runtime.agent.prompt).toHaveBeenCalledTimes(1);
    expect(response.content).toBe(validNonDatetimeReply);
    expect(response.metadata.diagnostics?.runtimeContradiction).toBeUndefined();
    expect(guardActivations).toEqual([]);

    const assistantEntries = store.getRecent('ch1', 10).filter(entry => entry.role === 'assistant');
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]).toMatchObject({ content: validNonDatetimeReply });
  });

  it('retries empty vision prompt recovery three times before returning a visible fallback reply', async () => {
    const eventBus = new EventBus();
    const buildContext = vi.fn(async () => ({
      systemPrompt: 'System prompt',
      messages: [],
      manifest: makeContextManifestFixture(),
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
      const latestAssistant = [...(fromAny(runtime.agent.state.messages))]
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
      (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
      (fromAny(runtime.agent.state.messages)).push({ role: 'assistant', content: '' });
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
        manifest: makeContextManifestFixture(),
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
        const latestAssistant = [...(fromAny(runtime.agent.state.messages))]
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
        (fromAny(runtime.agent.state.messages)).push({ role: 'user', content: promptMessage.content });
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
