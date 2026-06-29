import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { createComponentLogger } from '../../../shared/logger.js';
import type { EventBus, EventMap } from '../../../shared/event-bus.js';
import type { SessionManager } from '../../session/manager.js';
import { normalizeChannelVisibility, type TrustLevel } from '../../../system/trust/types.js';
import type { AgentResponse, CorrelationMetadata, InferredPostTurnAction, MessagePromptOverrideMode, ObservabilityCallType, SubstrateMessage, TurnID, TurnRecord, TurnUsage } from '../../../shared/contracts/runtime.js';
import type { TurnObservabilityRecord } from '../../turns/observability.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  AdaptiveToolDecisionTelemetry,
} from '../adaptive-tools-telemetry.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
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
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';

const log = createComponentLogger('SubstrateAgent');
export const DEFAULT_POST_TURN_DRAIN_TIMEOUT_MS = 5_000;

export interface PostTurnBackgroundWork {
  name: string;
  promise: Promise<unknown>;
}

export interface RegisterPostTurnBackgroundWorkInput {
  channelId: string;
  turnId: TurnID;
  requestId: string;
  work: readonly PostTurnBackgroundWork[];
  correlation?: CorrelationMetadata;
}

export interface AwaitPostTurnDrainInput {
  channelId: string;
  turnId: TurnID;
  requestId: string;
  timeoutMs?: number;
  correlation?: CorrelationMetadata;
}

export interface AwaitPostTurnDrainResult {
  status: 'idle' | 'drained' | 'timeout';
  waitMs: number;
  workCount: number;
  previousChannelId?: string;
  previousTurnId?: TurnID;
  previousRequestId?: string;
}

interface ActivePostTurnDrain {
  sequence: number;
  channelId: string;
  turnId: TurnID;
  requestId: string;
  taskNames: string[];
  promise: Promise<void>;
  timedOut: boolean;
}

function normalizePostTurnDrainTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_POST_TURN_DRAIN_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_POST_TURN_DRAIN_TIMEOUT_MS;
  }
  return Math.floor(value);
}

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
  private postTurnDrainSequence = 0;
  private activePostTurnDrain: ActivePostTurnDrain | null = null;

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

  registerPostTurnBackgroundWork(input: RegisterPostTurnBackgroundWorkInput): void {
    const work = input.work.filter(task => task.name.trim().length > 0);
    if (work.length === 0) {
      return;
    }

    const sequence = this.postTurnDrainSequence + 1;
    this.postTurnDrainSequence = sequence;
    const taskNames = work.map(task => task.name);
    const drain: ActivePostTurnDrain = {
      sequence,
      channelId: input.channelId,
      turnId: input.turnId,
      requestId: input.requestId,
      taskNames,
      promise: Promise.resolve(),
      timedOut: false,
    };

    drain.promise = Promise.all(
      work.map(async (task) => {
        try {
          await task.promise;
          return null;
        } catch (error) {
          return {
            name: task.name,
            error: toErrorMessage(error),
          };
        }
      }),
    ).then((failures) => {
      const failedTasks = failures.filter((failure): failure is { name: string; error: string } => failure !== null);
      if (failedTasks.length > 0) {
        log.warn('Post-turn background work completed with failures', {
          channelId: input.channelId,
          turnId: input.turnId,
          requestId: input.requestId,
          failureCount: failedTasks.length,
          failedTasks,
        });
      }
      this.emitPostTurnDrainTelemetry('drained', {
        channelId: input.channelId,
        previousTurnId: input.turnId,
        previousRequestId: input.requestId,
        workCount: work.length,
        taskNames,
        failureCount: failedTasks.length,
        correlation: input.correlation,
      });
    }).finally(() => {
      if (this.activePostTurnDrain?.sequence === sequence) {
        this.activePostTurnDrain = null;
      }
    });

    this.activePostTurnDrain = drain;
    this.emitPostTurnDrainTelemetry('registered', {
      channelId: input.channelId,
      previousTurnId: input.turnId,
      previousRequestId: input.requestId,
      workCount: work.length,
      taskNames,
      correlation: input.correlation,
    });
  }

  async awaitPostTurnDrain(input: AwaitPostTurnDrainInput): Promise<AwaitPostTurnDrainResult> {
    const drain = this.activePostTurnDrain;
    if (!drain || drain.timedOut) {
      return {
        status: 'idle',
        waitMs: 0,
        workCount: 0,
      };
    }

    const timeoutMs = normalizePostTurnDrainTimeoutMs(input.timeoutMs);
    const waitStartedAt = Date.now();
    this.emitPostTurnDrainTelemetry('wait_started', {
      channelId: input.channelId,
      turnId: input.turnId,
      requestId: input.requestId,
      previousChannelId: drain.channelId,
      previousTurnId: drain.turnId,
      previousRequestId: drain.requestId,
      workCount: drain.taskNames.length,
      taskNames: drain.taskNames,
      timeoutMs,
      correlation: input.correlation,
    });

    let resolveTimeout!: (value: 'timeout') => void;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      resolveTimeout = resolve;
    });
    const timeoutHandle = setTimeout(() => resolveTimeout('timeout'), timeoutMs);
    const outcome = await Promise.race([
      drain.promise.then(() => 'drained' as const),
      timeoutPromise,
    ]);
    clearTimeout(timeoutHandle);

    const waitMs = Math.max(0, Date.now() - waitStartedAt);
    if (outcome === 'timeout') {
      drain.timedOut = true;
      if (this.activePostTurnDrain?.sequence === drain.sequence) {
        this.activePostTurnDrain = null;
      }
      log.warn('Post-turn drain timed out before starting new turn', {
        channelId: input.channelId,
        turnId: input.turnId,
        requestId: input.requestId,
        previousChannelId: drain.channelId,
        previousTurnId: drain.turnId,
        previousRequestId: drain.requestId,
        timeoutMs,
        waitMs,
        taskNames: drain.taskNames,
      });
      this.emitPostTurnDrainTelemetry('timeout', {
        channelId: input.channelId,
        turnId: input.turnId,
        requestId: input.requestId,
        previousTurnId: drain.turnId,
        previousRequestId: drain.requestId,
        workCount: drain.taskNames.length,
        taskNames: drain.taskNames,
        waitMs,
        timeoutMs,
        correlation: input.correlation,
      });
      return {
        status: 'timeout',
        waitMs,
        workCount: drain.taskNames.length,
        previousChannelId: drain.channelId,
        previousTurnId: drain.turnId,
        previousRequestId: drain.requestId,
      };
    }

    return {
      status: 'drained',
      waitMs,
      workCount: drain.taskNames.length,
      previousChannelId: drain.channelId,
      previousTurnId: drain.turnId,
      previousRequestId: drain.requestId,
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
    limit?: number,
  ): PendingBackgroundContinuationDelivery[] {
    return dequeueBackgroundContinuationDeliveriesForTurn(
      this.pendingBackgroundContinuationDeliveries,
      deliverySessionId,
      limit,
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
  ): EventMap['agent.turn.stage'] {
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
    return telemetry as EventMap['agent.turn.stage'];
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

  private emitPostTurnDrainTelemetry(
    phase: EventMap['agent.post_turn.drain']['phase'],
    payload: {
      channelId: string;
      turnId?: TurnID;
      requestId?: string;
      previousChannelId?: string;
      previousTurnId?: TurnID;
      previousRequestId?: string;
      workCount: number;
      taskNames: string[];
      waitMs?: number;
      timeoutMs?: number;
      failureCount?: number;
      correlation?: CorrelationMetadata;
    },
  ): void {
    const { correlation, ...rest } = payload;
    const purpose = `agent.post_turn.drain.${phase}`;
    this.emitTelemetry('agent.post_turn.drain', {
      ...rest,
      phase,
      timestamp: Date.now(),
      ...(correlation ? this.withCorrelationPurpose(correlation, purpose) : { purpose }),
    });
  }

  recordUserMessage(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    contentOverride?: string,
  ): number | null {
    return recordUserMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnId,
      requestId,
      trustLevel,
      continuityUserId,
      contentOverride,
    });
  }

  recordSystemMessage(
    message: SubstrateMessage,
    turnId: TurnID,
    requestId: string,
    content: string,
    continuityUserId?: string,
  ): number | null {
    return this.sessionManager.recordSystemMessage(
      message.channelId,
      content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
      continuityUserId,
      {
        turnId,
        requestId,
        sourceMessageId: message.id,
        channelMeta: resolveSessionChannelMeta(message),
      },
    );
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
    speakerRole: 'user' | 'system';
    canonicalContactKey?: string;
    retrievalProvenanceRefs: string[];
    turnSnapshot?: TurnSnapshot;
    turnObservability?: TurnObservabilityRecord;
    internalStateSnapshotRef?: string;
    persistedUserMessageContent?: string;
  }): TurnRecord {
    const roleEnvelopeRefs = this.sessionManager.getRoleEnvelopeRefsForEntries(
      input.message.channelId,
      [
        ...(input.userSessionEntryId != null ? [input.userSessionEntryId] : []),
        ...(input.assistantSessionEntryId != null ? [input.assistantSessionEntryId] : []),
      ],
    );
    return buildTurnRecordForTurn({
      ...input,
      roleEnvelopeRefs,
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
