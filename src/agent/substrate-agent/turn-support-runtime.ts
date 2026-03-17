import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { createComponentLogger } from '../../logger.js';
import type { EventBus } from '../../event-bus.js';
import type { SessionManager } from '../../session/manager.js';
import { normalizeChannelVisibility, type TrustLevel } from '../../trust/types.js';
import type {
  AgentResponse,
  CorrelationMetadata,
  InferredPostTurnAction,
  MessagePromptOverrideMode,
  ObservabilityCallType,
  SubstrateMessage,
  TurnID,
  TurnRecord,
  TurnUsage,
} from '../../types.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  AdaptiveToolDecisionTelemetry,
} from '../adaptive-tools-telemetry.js';
import { toErrorMessage } from '../../utils/errors.js';
import {
  pinDeferredContinuationSessionContext as pinDeferredContinuationSessionContextForTurn,
  resolveSessionChannelId as resolveSessionChannelIdForTurn,
  queueBackgroundContinuationCompletion as queueBackgroundContinuationCompletionForTurn,
  dequeueBackgroundContinuationDeliveries as dequeueBackgroundContinuationDeliveriesForTurn,
  emitBackgroundContinuationEvent as emitBackgroundContinuationEventForTurn,
  type BackgroundContinuationTaskRecord,
  type BackgroundContinuationCompletionSignal,
  type PendingBackgroundContinuationDelivery,
} from './background-continuation-runtime.js';
import {
  buildTurnCorrelation as buildTurnCorrelationForTurn,
  buildTurnStageTelemetry as buildTurnStageTelemetryForTurn,
  resolveTurnCallType as resolveTurnCallTypeForTurn,
  withAdaptiveCorrelation as withAdaptiveCorrelationForTurn,
  withCorrelationPurpose as withCorrelationPurposeForTurn,
  type TurnStageName,
} from './turn-observability.js';
import {
  accumulateTurnUsage as accumulateTurnUsageForTurn,
  buildTurnRecord as buildTurnRecordForTurn,
  buildTurnToolSummary as buildTurnToolSummaryForTurn,
  recordAssistantMessage as recordAssistantMessageForTurn,
  recordToolObservations as recordToolObservationsForTurn,
  recordUserMessage as recordUserMessageForTurn,
} from './turn-records.js';
import { BackgroundCompletionDeliveryQueue } from '../background-completion-delivery-queue.js';
import {
  inferPostTurnActions as inferPostTurnActionsForTurn,
  runIntentionPostTurnHooks as runIntentionPostTurnHooksForTurn,
  type IntentionPostTurnHook,
  type IntentionPostTurnHookContext,
  type PostTurnActionInferer,
  type PostTurnInferenceContext,
} from './post-turn-actions.js';
import type { TurnToolSummary } from '../../skills/reflection-nudge.js';
import type { ChannelMeta } from '../../trust/policy.js';

const log = createComponentLogger('SubstrateAgent');

function resolveSessionChannelMeta(message: SubstrateMessage): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelVisibility(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
  };
}

export interface TurnSupportRuntimeOptions {
  eventBus: EventBus;
  sessionManager: SessionManager;
  hashPromptText: (text: string) => string;
  resolveContextWindow: () => number;
}

export class TurnSupportRuntime {
  private readonly eventBus: EventBus;
  private readonly sessionManager: SessionManager;
  private readonly hashPromptText: (text: string) => string;
  private readonly resolveContextWindow: () => number;

  private activeTurnCorrelation: CorrelationMetadata | null = null;
  private activeTurnTaskKind: string | null = null;
  private activeTurnIntent: string | null = null;

  private readonly pendingBackgroundContinuationDeliveries = new BackgroundCompletionDeliveryQueue<
    PendingBackgroundContinuationDelivery
  >();

  private readonly backgroundContinuationTasks = new Map<string, BackgroundContinuationTaskRecord>();
  private readonly postTurnActionInferers: PostTurnActionInferer[] = [];
  private readonly intentionPostTurnHooks: IntentionPostTurnHook[] = [];

  constructor(options: TurnSupportRuntimeOptions) {
    this.eventBus = options.eventBus;
    this.sessionManager = options.sessionManager;
    this.hashPromptText = options.hashPromptText;
    this.resolveContextWindow = options.resolveContextWindow;
  }

  getActiveTurnCorrelation(): CorrelationMetadata | null {
    return this.activeTurnCorrelation;
  }

  getActiveTurnTaskKind(): string | null {
    return this.activeTurnTaskKind;
  }

  getActiveTurnIntent(): string | null {
    return this.activeTurnIntent;
  }

  setActiveTurnContext(
    correlation: CorrelationMetadata,
    taskKind: string | null,
    intent: string | null,
  ): void {
    this.activeTurnCorrelation = correlation;
    this.activeTurnTaskKind = taskKind;
    this.activeTurnIntent = intent;
  }

  clearActiveTurnContext(): void {
    this.activeTurnCorrelation = null;
    this.activeTurnTaskKind = null;
    this.activeTurnIntent = null;
  }

  setActiveTurnCorrelation(correlation: CorrelationMetadata | null): void {
    this.activeTurnCorrelation = correlation;
  }

  setActiveTurnTaskKind(taskKind: string | null): void {
    this.activeTurnTaskKind = taskKind;
  }

  setActiveTurnIntent(intent: string | null): void {
    this.activeTurnIntent = intent;
  }

  getBackgroundContinuationTasks(): readonly BackgroundContinuationTaskRecord[] {
    return [...this.backgroundContinuationTasks.values()]
      .sort((left, right) => left.completedAt - right.completedAt)
      .map(entry => ({ ...entry }));
  }

  registerPostTurnActionInferer(inferer: PostTurnActionInferer): () => void {
    this.postTurnActionInferers.push(inferer);
    return () => {
      const index = this.postTurnActionInferers.indexOf(inferer);
      if (index !== -1) {
        this.postTurnActionInferers.splice(index, 1);
      }
    };
  }

  registerIntentionPostTurnHook(hook: IntentionPostTurnHook): () => void {
    this.intentionPostTurnHooks.push(hook);
    return () => {
      const index = this.intentionPostTurnHooks.indexOf(hook);
      if (index !== -1) {
        this.intentionPostTurnHooks.splice(index, 1);
      }
    };
  }

  async inferPostTurnActions(
    context: PostTurnInferenceContext,
  ): Promise<InferredPostTurnAction[]> {
    return inferPostTurnActionsForTurn({
      inferers: this.postTurnActionInferers,
      context,
      logger: log,
    });
  }

  async runIntentionPostTurnHooks(
    context: IntentionPostTurnHookContext,
  ): Promise<void> {
    await runIntentionPostTurnHooksForTurn({
      hooks: this.intentionPostTurnHooks,
      context,
      logger: log,
    });
  }

  pinDeferredContinuationSessionContext(
    deferredContinuationId: string | null,
    channelId: string,
  ): () => void {
    return pinDeferredContinuationSessionContextForTurn(
      deferredContinuationId,
      channelId,
      this.sessionManager,
    );
  }

  resolveSessionChannelId(channelId: string): string {
    return resolveSessionChannelIdForTurn(this.sessionManager, channelId);
  }

  queueBackgroundContinuationCompletion(
    deferredContinuationId: string,
    message: SubstrateMessage,
    response: AgentResponse,
    taskKind: string | null,
    intent: string | null,
  ): BackgroundContinuationCompletionSignal {
    return queueBackgroundContinuationCompletionForTurn({
      deferredContinuationId,
      message,
      response,
      taskKind,
      intent,
      resolveSessionChannelId: (channelId) => this.resolveSessionChannelId(channelId),
      backgroundContinuationTasks: this.backgroundContinuationTasks,
      pendingBackgroundContinuationDeliveries: this.pendingBackgroundContinuationDeliveries,
    });
  }

  dequeueBackgroundContinuationDeliveries(
    deliverySessionId: string,
  ): PendingBackgroundContinuationDelivery[] {
    return dequeueBackgroundContinuationDeliveriesForTurn(
      this.pendingBackgroundContinuationDeliveries,
      deliverySessionId,
    );
  }

  async emitBackgroundContinuationEvent(
    eventName: 'agent.background.continuation.completed' | 'agent.background.continuation.post_turn_delivery',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await emitBackgroundContinuationEventForTurn(this.eventBus, eventName, payload);
  }

  emitTurnStage(
    message: SubstrateMessage,
    turnStartMs: number,
    turnId: TurnID,
    requestId: string,
    stage: TurnStageName,
    callType: ObservabilityCallType,
    payload: Record<string, unknown>,
  ): void {
    const telemetry = buildTurnStageTelemetryForTurn({
      message,
      turnStartMs,
      turnId,
      requestId,
      stage,
      callType,
      payload,
    });
    log.debug('Turn stage telemetry', telemetry);
    this.emitTelemetry('agent.turn.stage', telemetry);
  }

  resolveTurnCallType(
    message: SubstrateMessage,
    taskKind: string | undefined,
  ): ObservabilityCallType {
    return resolveTurnCallTypeForTurn(message, taskKind);
  }

  buildTurnCorrelation(
    message: SubstrateMessage,
    callType: ObservabilityCallType,
    turnId: TurnID,
    requestId: string,
  ): CorrelationMetadata {
    return buildTurnCorrelationForTurn(message, callType, turnId, requestId);
  }

  withCorrelationPurpose(
    correlation: CorrelationMetadata,
    purpose: string,
  ): CorrelationMetadata {
    return withCorrelationPurposeForTurn(correlation, purpose);
  }

  withAdaptiveCorrelation(
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ): Partial<CorrelationMetadata> {
    return withAdaptiveCorrelationForTurn(correlation, this.activeTurnCorrelation, purpose);
  }

  emitAdaptiveToolDecision(
    payload: Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>,
  ): void {
    this.emitTelemetry('agent.tools.adaptive.decision', {
      ...payload,
      timestamp: Date.now(),
    });
  }

  emitTelemetry(event: string, payload: Record<string, unknown>): void {
    const telemetryBus = this.eventBus as unknown as {
      emit: (event: string, eventPayload: Record<string, unknown>) => Promise<void>;
    };
    telemetryBus.emit(event, payload).catch(error => {
      log.debug('Telemetry emit failed', {
        event,
        error: toErrorMessage(error),
      });
    });
  }

  recordUserMessage(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
  ): number | null {
    return recordUserMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnId,
      requestId,
      trustLevel,
      continuityUserId,
    });
  }

  recordAssistantMessage(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    responseText: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    emotionSnapshot?: EmotionStateSnapshot | null,
  ): number | null {
    return recordAssistantMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnId,
      requestId,
      responseText,
      trustLevel,
      continuityUserId,
      emotionSnapshot,
    });
  }

  recordSystemMessage(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    content: string,
  ): number | null {
    return this.sessionManager.recordSystemMessage(
      message.channelId,
      content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
      undefined,
      {
        turnId,
        requestId,
        sourceMessageId: message.id,
        channelMeta: resolveSessionChannelMeta(message),
      },
    );
  }

  recordToolObservations(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    turnMessages: AgentMessage[],
    trustLevel: TrustLevel,
  ): void {
    recordToolObservationsForTurn({
      sessionManager: this.sessionManager,
      message,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    });
  }

  buildTurnRecord(input: {
    message: SubstrateMessage;
    turnId: TurnID;
    requestId: string;
    startedAt: number;
    completedAt: number;
    userSessionEntryId: number | null;
    assistantSessionEntryId: number | null;
    response: AgentResponse;
    turnMessages: AgentMessage[];
    promptMode: MessagePromptOverrideMode;
    promptText: string;
    contextMessageCount: number;
    memoryContextChars: number;
    trustLevel: TrustLevel;
    canonicalContactKey?: string;
    retrievalProvenanceRefs: string[];
    turnSnapshot?: TurnSnapshot;
    internalStateSnapshotRef?: string;
  }): TurnRecord {
    return buildTurnRecordForTurn({
      ...input,
      hashPromptText: this.hashPromptText,
    });
  }

  accumulateTurnUsage(messages: AgentMessage[]): TurnUsage {
    return accumulateTurnUsageForTurn(messages, this.resolveContextWindow());
  }

  buildTurnToolSummary(turnMessages: AgentMessage[]): TurnToolSummary {
    return buildTurnToolSummaryForTurn(turnMessages);
  }
}
