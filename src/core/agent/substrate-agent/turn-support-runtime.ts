import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { EventBus, EventMap } from '../../../shared/event-bus.js';
import type { SessionManager } from '../../session/manager.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import { normalizeChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { AgentResponse, CorrelationMetadata, InferredPostTurnAction, IntentionalNoReplyMetadata, MessagePromptOverrideMode, ObservabilityCallType, ParentTurnContinuationStop, RuntimeFallbackProvenance, SubstrateMessage, TurnID, TurnRecord, TurnUsage } from '../../../shared/contracts/runtime.js';
import type { TurnObservabilityRecord } from '../../turns/observability.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type {
  AdaptiveToolDecisionTelemetry,
} from '../adaptive-tools-telemetry.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
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
import {
  inferPostTurnActions as inferPostTurnActionsForTurn,
  runIntentionPostTurnHooks as runIntentionPostTurnHooksForTurn,
  type IntentionPostTurnHook,
  type IntentionPostTurnHookContext,
  type IntentionPostTurnHookRunOptions,
  type PostTurnActionInferer,
  type PostTurnInferenceContext,
} from './post-turn-actions.js';
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { SessionActorKind } from '../../session/turn-provenance.js';
import type { IntrospectionTurnSensitivityDecisions } from '../../../faculties/introspection/turn-sensitivity.js';
import { getRunChargeSnapshot } from '../../../shared/telemetry/run-charge.js';
import type {
  BackgroundWorkSupervisor,
  ForegroundWorkLease,
} from '../background-work/supervisor.js';
import type { EnqueueBackgroundWorkInput } from '../background-work/types.js';
import type { TurnSessionIdentity } from './turn-execution/contracts.js';

const log = createComponentLogger('SubstrateAgent');

function resolveSessionChannelMeta(message: SubstrateMessage): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelPrivacy(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
  };
}

export interface TurnSupportRuntimeOptions {
  eventBus: EventBus;
  sessionManager: SessionManager;
  backgroundWorkSupervisor: BackgroundWorkSupervisor | null;
  backgroundWorkDisabled?: boolean;
  hashPromptText: (text: string) => string;
  resolveContextWindow: () => number;
  /** Configured companion identity, used as the fallback companion scope on
   *  ordinary human-ingress turn correlations (icpCorrelation still wins). */
  companionId?: string;
}

export class TurnSupportRuntime {
  private readonly eventBus: EventBus;
  private readonly sessionManager: SessionManager;
  private readonly backgroundWorkSupervisor: BackgroundWorkSupervisor | null;
  private readonly backgroundWorkDisabled: boolean;
  private readonly hashPromptText: (text: string) => string;
  private readonly resolveContextWindow: () => number;
  private readonly companionId?: string;
  private introspectionTurnSensitivityDecisions: IntrospectionTurnSensitivityDecisions | null = null;

  private activeTurnCorrelation: CorrelationMetadata | null = null;
  private activeTurnTaskKind: string | null = null;
  private activeTurnIntent: string | null = null;
  private activeTurnSessionIdentity: TurnSessionIdentity | null = null;

  private readonly postTurnActionInferers: PostTurnActionInferer[] = [];
  private readonly intentionPostTurnHooks: IntentionPostTurnHook[] = [];
  private readonly intentionalNoReplyDecisions = new Map<TurnID, IntentionalNoReplyMetadata>();
  constructor(options: TurnSupportRuntimeOptions) {
    this.eventBus = options.eventBus;
    this.sessionManager = options.sessionManager;
    this.backgroundWorkSupervisor = options.backgroundWorkSupervisor;
    this.backgroundWorkDisabled = options.backgroundWorkDisabled === true;
    if (this.backgroundWorkDisabled && this.backgroundWorkSupervisor) {
      throw new Error('Background work cannot be both durable and disabled');
    }
    this.hashPromptText = options.hashPromptText;
    this.resolveContextWindow = options.resolveContextWindow;
    this.companionId = typeof options.companionId === 'string' && options.companionId.trim().length > 0
      ? options.companionId.trim()
      : undefined;
  }

  setIntrospectionTurnSensitivityDecisions(
    decisions: IntrospectionTurnSensitivityDecisions | null,
  ): void {
    this.introspectionTurnSensitivityDecisions = decisions;
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

  getActiveTurnSessionIdentity(): TurnSessionIdentity | null {
    return this.activeTurnSessionIdentity;
  }

  setActiveTurnContext(
    correlation: CorrelationMetadata,
    taskKind: string | null,
    intent: string | null,
    turnSessionIdentity: TurnSessionIdentity,
  ): void {
    this.activeTurnCorrelation = correlation;
    this.activeTurnTaskKind = taskKind;
    this.activeTurnIntent = intent;
    this.activeTurnSessionIdentity = turnSessionIdentity;
  }

  clearActiveTurnContext(): void {
    this.activeTurnCorrelation = null;
    this.activeTurnTaskKind = null;
    this.activeTurnIntent = null;
    this.activeTurnSessionIdentity = null;
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

  recordIntentionalNoReplyDecision(input: {
    source: IntentionalNoReplyMetadata['source'];
    toolCallId?: string;
    reason?: string;
  }): IntentionalNoReplyMetadata | null {
    const correlation = this.activeTurnCorrelation;
    const turnId = correlation?.turnId as TurnID | undefined;
    if (!correlation || !turnId) {
      log.warn('Intentional no-reply requested without active turn correlation');
      return null;
    }
    const activeCorrelation = correlation;

    const decision: IntentionalNoReplyMetadata = {
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: input.source,
      auditId: `no-reply:${turnId}:${input.toolCallId ?? 'unknown-tool-call'}`,
      decidedAt: Date.now(),
      turnId,
      ...(activeCorrelation.requestId ? { requestId: activeCorrelation.requestId } : {}),
      ...(activeCorrelation.channelId ? { channelId: activeCorrelation.channelId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.intentionalNoReplyDecisions.set(turnId, decision);
    this.emitTelemetry('agent.no_reply.intentional', {
      ...decision,
      ...this.withCorrelationPurpose(activeCorrelation, 'agent.no_reply.intentional'),
    });
    return decision;
  }

  consumeIntentionalNoReplyDecision(turnId: TurnID): IntentionalNoReplyMetadata | null {
    const decision = this.intentionalNoReplyDecisions.get(turnId) ?? null;
    if (decision) {
      this.intentionalNoReplyDecisions.delete(turnId);
    }
    return decision;
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

  enqueuePostTurnBackgroundWork(inputs: readonly EnqueueBackgroundWorkInput[]): Promise<void> {
    if (!this.backgroundWorkSupervisor) {
      if (this.backgroundWorkDisabled) return Promise.resolve();
      return Promise.reject(new Error('Durable background work supervisor is not configured'));
    }
    return this.backgroundWorkSupervisor.enqueue(inputs);
  }

  beginForegroundBackgroundWork(logicalSessionId: string): ForegroundWorkLease | null {
    return this.backgroundWorkSupervisor?.beginForeground(logicalSessionId) ?? null;
  }

  async endForegroundBackgroundWork(lease: ForegroundWorkLease | null): Promise<void> {
    if (lease) await this.backgroundWorkSupervisor?.endForeground(lease);
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
    options?: IntentionPostTurnHookRunOptions,
  ): Promise<void> {
    await runIntentionPostTurnHooksForTurn({
      hooks: this.intentionPostTurnHooks,
      context,
      logger: log,
      ...(options ? { options } : {}),
    });
  }

  resolveSessionChannelId(channelId: string): string {
    const resolver = this.sessionManager.resolveSessionChannelId;
    if (typeof resolver !== 'function') {
      return channelId;
    }
    const resolved = resolver.call(this.sessionManager, channelId);
    const trimmed = resolved.trim();
    return trimmed.length > 0 ? trimmed : channelId;
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
    const resolvedSessionId = this.resolveSessionChannelId(message.channelId);
    const wyomingSessionId = message.routing?.wyoming?.sessionId?.trim();
    const sessionId = resolvedSessionId !== message.channelId
      ? resolvedSessionId
      : (wyomingSessionId || resolvedSessionId);
    const rootInitiationId = getRunChargeSnapshot()?.lineage.rootRunId.trim() || requestId;
    return buildTurnCorrelationForTurn(message, callType, turnId, requestId, {
      sessionId,
      rootInitiationId,
    }, this.companionId);
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
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    contentOverride?: string,
    actorKind: SessionActorKind = 'unknown',
  ): number | null {
    return recordUserMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      trustLevel,
      continuityUserId,
      contentOverride,
      actorKind,
    });
  }

  recordSystemMessage(
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    content: string,
    continuityUserId?: string,
  ): number | null {
    return this.sessionManager.recordSystemMessage(
      turnSessionIdentity.logicalSessionId,
      content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
      continuityUserId,
      {
        turnId,
        requestId,
        sourceMessageId: message.id,
        sourceChannelId: turnSessionIdentity.sourceChannelId,
        channelMeta: resolveSessionChannelMeta(message),
      },
    );
  }

  recordAssistantMessage(
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    responseText: string,
    trustLevel: TrustLevel,
    continuityUserId?: string,
    emotionSnapshot?: EmotionStateSnapshot | null,
    recoveryResponse?: AgentResponse,
    runtimeFallbackProvenance?: RuntimeFallbackProvenance,
  ): number | null {
    return recordAssistantMessageForTurn({
      sessionManager: this.sessionManager,
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      responseText,
      trustLevel,
      continuityUserId,
      emotionSnapshot,
      recoveryResponse,
      runtimeFallbackProvenance,
    });
  }

  recordToolObservations(
    message: SubstrateMessage,
    turnSessionIdentity: TurnSessionIdentity,
    turnId: TurnID,
    requestId: string,
    turnMessages: AgentMessage[],
    trustLevel: TrustLevel,
  ): void {
    recordToolObservationsForTurn({
      sessionManager: this.sessionManager,
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    });
  }

  buildTurnRecord(input: {
    message: SubstrateMessage;
    turnSessionIdentity: TurnSessionIdentity;
    turnId: TurnID;
    requestId: string;
    startedAt: number;
    completedAt: number;
    userSessionEntryId: number | null;
    assistantSessionEntryId: number | null;
    response?: AgentResponse;
    model?: string;
    assistantMessageContent?: string;
    turnMessages: AgentMessage[];
    status?: TurnRecord['status'];
    continuationStop?: ParentTurnContinuationStop;
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
    if (input.message.channelId !== input.turnSessionIdentity.sourceChannelId) {
      throw new Error('TurnRecord physical source does not match the captured turn identity');
    }
    const roleEnvelopeRefs = this.sessionManager.getRoleEnvelopeRefsForEntries(
      input.turnSessionIdentity.logicalSessionId,
      [
        ...(input.userSessionEntryId != null ? [input.userSessionEntryId] : []),
        ...(input.assistantSessionEntryId != null ? [input.assistantSessionEntryId] : []),
      ],
    );
    const introspectionSensitivityDecision = this.introspectionTurnSensitivityDecisions?.consume({
      turnId: input.turnId,
      requestId: input.requestId,
    });
    const { turnSessionIdentity, ...turnRecordInput } = input;
    return buildTurnRecordForTurn({
      ...turnRecordInput,
      sessionId: turnSessionIdentity.logicalSessionId,
      roleEnvelopeRefs,
      hashPromptText: this.hashPromptText,
      ...(introspectionSensitivityDecision ? { introspectionSensitivityDecision } : {}),
    });
  }

  accumulateTurnUsage(messages: AgentMessage[]): TurnUsage {
    return accumulateTurnUsageForTurn(messages, this.resolveContextWindow());
  }

  buildTurnToolSummary(turnMessages: AgentMessage[]): TurnToolSummary {
    return buildTurnToolSummaryForTurn(turnMessages);
  }
}
