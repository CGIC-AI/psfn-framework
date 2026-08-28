import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import { abortActiveAgentRun } from '../../../boundary/pi-agent/agent-loop-patch.js';
import { classifyBroadcastDraft } from '../../../system/trust/broadcast-safety.js';
import {
  emitTurnPerformance,
  monotonicEpochNowMs,
} from '../../../shared/telemetry/turn-performance.js';
import { resolveCompanionIdFromConfig } from '../../identity/companion-runtime.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { CapturedSessionReads } from '../../session/manager/captured-session-owner.js';
import { cloneMetacognitiveFlags } from '../../self-model/metacognition.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
  type InternalState,
} from '../../self-model/state.js';
import { extractRelayAcacAxisScores } from '../../emotion/relay-emotion-snapshot.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import { currentChannelClassificationEpoch } from '../../../system/trust/runtime-classification-epochs.js';
import type {
  AgentResponse,
  CorrelationMetadata,
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
  MessagePromptOverrideMode,
  ParentTurnContinuationStop,
  SubstrateMessage,
  TurnID,
} from '../../../shared/contracts/runtime.js';
import { isTemporalContextBudgetTurn } from '../../../shared/context-budget.js';
import { createTurnId, deriveDeterministicTurnId, parseTurnId } from '../../turns/id.js';
import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../../shared/contracts/icp-autonomy.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import type { IcpFatigueReservationOutcome } from '../fatigue/regulation-reservation.js';
import type { HumanAttentionPressureEvent } from '../fatigue/human-attention-pressure.js';
import {
  attachRecordedFatigueEvent,
  evaluateFatigueForTurn,
  type FatigueRecentHumanParticipation,
  type FatigueTurnDecision,
} from '../fatigue/runtime-enforcement.js';
import type { ResolvedAuthorContext } from './runtime-context.js';
import {
  listPendingPaidDeliverables,
  runWithPaidDeliverableTracking,
  type PendingPaidDeliverable,
} from '../../../shared/paid-deliverable-tracking.js';
import {
  SessionCanaryRegistry,
  runWithCanaryContext,
} from '../../cogsec/canary/canary-token.js';
import { recordReplyCanaryToken } from '../../cogsec/canary/reply-canary.js';
import {
  DISCLOSURE_CLASSIFIER_VERSION,
  buildGenerationDisclosureLineage,
} from '../../cogsec/disclosure/index.js';
import { runWithMcpTurnDisclosureContext } from '../../cogsec/disclosure/mcp-turn-context.js';
import {
  mergeChargedImageDeliverableSummaries,
  readGeneratedImageSensitivityClassifications,
  summarizeChargedImageDeliverables,
  summarizePendingPaidImageDeliverables,
} from '../../../primitives/images/generated-media.js';
import {
  classifyArtifactSensitivity,
  type ArtifactSensitivitySource,
} from '../../../shared/contracts/artifact-sensitivity.js';
import {
  authorizeArtifactEgress,
  authorizeRecoveredArtifactEgress,
  type ArtifactEgressDestination,
} from '../../artifacts/sensitivity-egress.js';
import type { Attachment } from '../../../shared/contracts/runtime.js';
import {
  healMissingImageAttachmentClaim,
  MISSING_IMAGE_ATTACHMENT_CORRECTION,
  rejectsMissingImageAttachmentClaim,
  rejectsUnfulfilledImageEditRequest,
  UNFULFILLED_IMAGE_EDIT_REQUEST_CORRECTION,
} from '../../../primitives/images/attachment-claim-guard.js';
import { stripLeadingHistoryStamps } from '../../../shared/utils/history-stamp-hygiene.js';
import {
  detectsUnfinishedToolExecutionNarration,
  rejectsUnconfirmedToolExecutionClaim,
  UNAVAILABLE_REQUESTED_TOOL_CORRECTION,
  UNCONFIRMED_TOOL_EXECUTION_CORRECTION,
} from '../tool-outcome-claim-guard.js';
import { CANONICAL_FIRST_PARTY_TOOL_SURFACES } from '../tool-surface/registry.js';
import { resolveExplicitlyRequestedToolNames } from '../../../shared/tools/explicit-tool-request.js';
import {
  invokeAgentForTurn,
  type AgentInvocationMutableState,
  type AgentInvocationResult,
} from './turn-execution/agent-invocation.js';
import { createTurnExecutionObservability } from './turn-execution/observability.js';
import { assembleTurnPrompt } from './turn-execution/prompt-assembly.js';
import { computePreTurnState, prepareTurnIdentityState } from './turn-execution/pre-turn-state.js';
import {
  collectTurnResponseAttachments,
  schedulePostTurnWork,
} from './turn-execution/post-turn-scheduling.js';
import {
  invokeWithCompanionSocialCharge,
  projectFatiguePendingSpendCorrelation,
  reserveIcpFatigueRegulation,
  resumeIcpFatigueRegulation,
} from './turn-execution/icp-fatigue-regulation.js';
import { hasVisionTurnInputs } from './vision-attachments.js';
import type { SessionEntry } from '../../session/types.js';
import {
  resolveSessionEntryActorKind,
  type SessionActorKind,
} from '../../session/turn-provenance.js';
import { parseIcpRecoveryResponse } from '../../session/icp-delivery-recovery.js';
import { ParentTurnContinuationBudgetExceededError } from '../turn-limits.js';
import { parseTurnRecordBackgroundWorkHandoff } from '../background-work/types.js';
import type { ForegroundWorkLease } from '../background-work/supervisor.js';
import type {
  TurnAdmissionRuntime,
  TurnExecutionRuntime,
  TurnSessionIdentity,
} from './turn-execution/contracts.js';

export type {
  TurnAdmissionRuntime,
  TurnExecutionRuntime,
} from './turn-execution/contracts.js';

const log = createComponentLogger('SubstrateAgent');

// htm9.18: process-scoped per-session canary registry. Keyed by the session
// channel id so the same token is planted on every turn of a session and
// rotates when a new session begins.
const sessionCanaryRegistry = new SessionCanaryRegistry();

function assertForegroundWorkOwned(lease: ForegroundWorkLease | null): void {
  if (!lease?.signal.aborted) return;
  const reason = lease.signal.reason;
  throw reason instanceof Error ? reason : new Error('Foreground work lease ownership was lost');
}

function cloneComputedInternalStateForResponse(internalState: InternalState): InternalState {
  return structuredClone(internalState);
}

/**
 * Delivery barrier for a private ICP target turn. The finalizer owns transport
 * and durable delivery-state recording. Post-turn work cannot begin until it
 * resolves successfully.
 */
export interface TurnDeliveryLifecycle {
  /** Durable response from an earlier attempt whose transport failed after generation. */
  recoveredResponse?: AgentResponse;
  /** The deterministic inbound envelope was already durably written before a process crash. */
  sourceAlreadyPersisted?: true;
  finalizeDelivery(response: AgentResponse): Promise<void>;
}

function summarizeFatigue(metadata: FatigueEnforcementMetadata): Record<string, unknown> {
  return {
    decision: metadata.decision,
    modelDisposition: metadata.modelDisposition,
    alertInjected: metadata.alertInjected,
    shouldRecordSpend: metadata.shouldRecordSpend,
    policyState: metadata.policyState,
    policyBaseState: metadata.policyBaseState,
    spendDecision: metadata.spendDecision,
    spendReason: metadata.spendReason,
    overchargeEligible: metadata.overchargeEligible,
    overchargePermitted: metadata.overchargePermitted,
    overchargeReasons: metadata.overchargeReasons,
    overchargeBlockedReasons: metadata.overchargeBlockedReasons,
    scope: metadata.scope,
    budget: metadata.budget,
    socialRegulation: metadata.socialRegulation,
  };
}

function evaluateRuntimeFatigue(input: {
  runtime: TurnExecutionRuntime;
  sessionReads: CapturedSessionReads;
  message: SubstrateMessage;
  turnSessionIdentity: TurnSessionIdentity;
  authorContext: ResolvedAuthorContext;
  channelType: string | undefined;
  channelMeta: ChannelMeta;
  taskKind: string | undefined;
  explicitPeerInvitation: boolean;
  turnCorrelationBase: CorrelationMetadata;
  timestampMs: number;
}): FatigueTurnDecision | null {
  if (!input.runtime.fatigueBudget) {
    return null;
  }
  const fatiguePolicy = input.runtime.config.chargePolicy?.fatigue;
  if (!fatiguePolicy) {
    throw new Error('Fatigue enforcement requires chargePolicy.fatigue when fatigueBudget is wired');
  }
  return evaluateFatigueForTurn({
    fatigueBudget: input.runtime.fatigueBudget,
    fatiguePolicy,
    localCompanionId: resolveCompanionIdFromConfig(input.runtime.config),
    message: input.message,
    authorContext: input.authorContext,
    channelId: input.turnSessionIdentity.logicalSessionId,
    channelType: input.channelType,
    channelMeta: input.channelMeta,
    taskKind: input.taskKind,
    explicitPeerInvitation: input.explicitPeerInvitation,
    recentHumanParticipation: resolveRecentHumanParticipationForFatigue({
      sessionReads: input.sessionReads,
      message: input.message,
      authorContext: input.authorContext,
      nowMs: input.timestampMs,
      windowMs: fatiguePolicy.overcharge.recentHumanParticipationWindowMs,
    }),
    timestampMs: input.timestampMs,
    correlation: input.runtime.withCorrelationPurpose(input.turnCorrelationBase, 'agent.fatigue.evaluate'),
  });
}

function evaluateHumanAttentionPressure(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnSessionIdentity: TurnSessionIdentity;
  authorContext: ResolvedAuthorContext;
  timestampMs: number;
  turnId: string;
}): HumanAttentionPressureEvent | null {
  if (!input.runtime.humanAttentionPressure || input.authorContext.actorKind !== 'human') {
    return null;
  }
  const contactId = input.authorContext.canonicalContactKey
    ?? input.authorContext.subjectIdentityKey
    ?? input.message.authorId.trim();
  if (!contactId) {
    return null;
  }
  const channelContext = input.message.isDirectMessage === true
    ? 'direct_message'
    : input.message.routing?.responseMode === 'respond'
      ? 'direct_mention'
      : 'ambient_group_message';
  return input.runtime.humanAttentionPressure.evaluate({
    localCompanionId: resolveCompanionIdFromConfig(input.runtime.config),
    contactId,
    channelId: input.turnSessionIdentity.sourceChannelId,
    trustLevel: input.authorContext.trustLevel,
    relationshipType: input.authorContext.relationshipType ?? 'stranger',
    channelContext,
    timestampMs: input.timestampMs,
    sourceMessageId: input.message.id,
    turnId: input.turnId,
  });
}

function resolveRecentHumanParticipationForFatigue(input: {
  sessionReads: CapturedSessionReads;
  message: SubstrateMessage;
  authorContext: ResolvedAuthorContext;
  nowMs: number;
  windowMs: number;
}): FatigueRecentHumanParticipation {
  const participants = new Set<string>();
  let messageCount = 0;
  let latestHumanTimestampMs: number | undefined;
  const addHumanMessage = (entry: Pick<SessionEntry, 'authorId' | 'authorName' | 'timestamp'>): void => {
    if (!Number.isFinite(entry.timestamp) || entry.timestamp > input.nowMs) {
      return;
    }
    const ageMs = input.nowMs - entry.timestamp;
    if (ageMs < 0 || ageMs > input.windowMs) {
      return;
    }
    messageCount += 1;
    participants.add(entry.authorId?.trim() || entry.authorName?.trim() || 'unknown-human');
    latestHumanTimestampMs = latestHumanTimestampMs === undefined
      ? entry.timestamp
      : Math.max(latestHumanTimestampMs, entry.timestamp);
  };

  if (
    input.authorContext.speakingWithIsMachineIntelligence !== true
    && input.authorContext.speakerRole !== 'system'
  ) {
    addHumanMessage({
      authorId: input.message.authorId,
      authorName: input.message.authorName,
      timestamp: input.nowMs,
    });
  }

  for (const entry of input.sessionReads.getRecentMessages(32)) {
    if (entry.role !== 'user' || resolveSessionEntryActorKind(entry) !== 'human') {
      continue;
    }
    if (entry.authorId && entry.authorId === input.message.authorId) {
      continue;
    }
    addHumanMessage(entry);
  }

  return {
    messageCount,
    participantCount: participants.size,
    ...(latestHumanTimestampMs !== undefined
      ? { latestMessageAgeMs: input.nowMs - latestHumanTimestampMs }
      : {}),
  };
}

function resolveSessionActorKind(authorContext: ResolvedAuthorContext): SessionActorKind {
  return authorContext.actorKind;
}

function emitFatigueDecision(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnCorrelationBase: CorrelationMetadata;
  fatigueDecision: FatigueTurnDecision;
  observability: Pick<ReturnType<typeof createTurnExecutionObservability>, 'emitObservedTurnStage'>;
}): void {
  const telemetry = summarizeFatigue(input.fatigueDecision.metadata);
  input.observability.emitObservedTurnStage('fatigue', telemetry);
  input.runtime.emitTelemetry('agent.fatigue.decision', {
    channelId: input.message.channelId,
    ...telemetry,
    ...input.runtime.withCorrelationPurpose(input.turnCorrelationBase, 'agent.fatigue.decision'),
  });
  if (input.fatigueDecision.suppressModel) {
    log.info('Suppressed machine-intelligence turn at fatigue hard cap', {
      channelId: input.message.channelId,
      ...telemetry,
    });
  }
}

function buildSuppressedFatigueResponse(input: {
  message: SubstrateMessage;
  startTime: number;
  completedAt: number;
  model: string;
  fatigue: FatigueEnforcementMetadata;
}): AgentResponse {
  return {
    content: '',
    channelId: input.message.channelId,
    metadata: {
      model: input.model,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: input.completedAt - input.startTime,
      fatigue: input.fatigue,
      ...(input.message.routing?.icpCorrelation
        ? {
            turnId: input.message.routing.icpCorrelation.turnId as TurnID,
            requestId: input.message.routing.icpCorrelation.requestId,
            icpCorrelation: input.message.routing.icpCorrelation,
          }
        : {}),
    },
  };
}

export async function handleMessageForTurn(
  runtime: TurnAdmissionRuntime,
  message: SubstrateMessage,
  deliveryLifecycle?: TurnDeliveryLifecycle,
  authenticatedConversationScope?: import('../../session/conversation-scope.js').ConversationScope,
): Promise<AgentResponse> {
  const transportReceivedAt = monotonicEpochNowMs();
  const transportReceivedTimestamp = Date.now();
  const requestId = message.id;
  const recoveredResponse = deliveryLifecycle?.recoveredResponse
    ? parseIcpRecoveryResponse(deliveryLifecycle.recoveredResponse, {
        label: 'Recovered turn response',
        expectedChannelId: message.channelId,
        expectedSourceMessageId: message.id,
      })
    : undefined;
  const privateIcpCorrelation = message.routing?.privateTurnTrigger === true
    && message.channelType === 'companion'
    ? parseIcpConversationCorrelation(message.routing.icpCorrelation)
    : null;
  if (privateIcpCorrelation && !deliveryLifecycle) {
    throw new Error('Private ICP target turn requires a delivery finalizer');
  }
  if (!privateIcpCorrelation && deliveryLifecycle && !message.routing?.icpCorrelation) {
    throw new Error('Delivery finalization is restricted to ICP channel turns');
  }
  if (recoveredResponse && !message.routing?.icpCorrelation) {
    throw new Error('Recovered delivery requires durable ICP correlation');
  }
  if (privateIcpCorrelation) {
    const expectedPrivateAuthorId = privateIcpCorrelation.dyadId
      ? 'system:icp-continuation'
      : 'system:icp-initiation';
    if (message.channelType !== 'companion'
      || message.authorId !== expectedPrivateAuthorId
      || privateIcpCorrelation.localCompanionId !== resolveCompanionIdFromConfig(runtime.config)
      || privateIcpCorrelation.channelId !== message.channelId
      || privateIcpCorrelation.requestId !== requestId
      || privateIcpCorrelation.messageId !== requestId) {
      throw new Error('Private ICP target turn is not bound to this runtime message');
    }
  }
  const recoveredCorrelation = recoveredResponse
    ? parseIcpConversationCorrelation(recoveredResponse.metadata.icpCorrelation)
    : null;
  if (recoveredCorrelation) {
    const localCompanionId = resolveCompanionIdFromConfig(runtime.config);
    if (recoveredCorrelation.localCompanionId !== localCompanionId
      || (!privateIcpCorrelation && recoveredCorrelation.peerCompanionId !== message.authorId)
      || recoveredCorrelation.channelId !== message.channelId
      || recoveredCorrelation.messageId !== message.id
      || recoveredResponse?.channelId !== message.channelId) {
      throw new Error('Recovered ICP delivery is not bound to the recorded local turn');
    }
  }
  const inboundIcpCorrelation = !privateIcpCorrelation && !recoveredCorrelation
    && message.routing?.icpCorrelation
    ? parseIcpConversationCorrelation(message.routing.icpCorrelation)
    : null;
  const deterministicReplyTurnId = inboundIcpCorrelation
    ? deriveDeterministicTurnId([
        'icp-reply',
        resolveCompanionIdFromConfig(runtime.config),
        message.channelId,
        message.id,
      ].join(':'))
    : null;
  // mmo9.8.3: a transport that must correlate the agent's stamped delta turnId
  // ahead of turn execution (the live voice reply-stream bridge) may supply a
  // real UUIDv7 on routing. It is honored ONLY when no authoritative ICP
  // correlation binds the turn; parseTurnId fails closed on a malformed value.
  const suppliedTurnId = message.routing?.turnId
    ? parseTurnId(message.routing.turnId, 'routing.turnId')
    : null;
  const turnId = privateIcpCorrelation || recoveredCorrelation
    ? parseTurnId(
        (privateIcpCorrelation ?? recoveredCorrelation)!.turnId,
        'ICP delivery turn correlation.turnId',
      )
    : deterministicReplyTurnId ?? suppliedTurnId ?? createTurnId();
  if (!turnId) throw new Error('Private ICP target turn requires a UUIDv7 turnId');
  const taskKind = runtime.resolveTaskKind(message);
  const turnBudgetCharacteristics = runtime.buildTurnBudgetCharacteristics(message, taskKind);
  const temporalRetrievalMode: 'temporal' | undefined = isTemporalContextBudgetTurn(turnBudgetCharacteristics)
    ? 'temporal'
    : undefined;
  const temporalRetrievalCallerContext = temporalRetrievalMode
    ? { retrievalMode: temporalRetrievalMode }
    : undefined;
  const turnCallType = runtime.resolveTurnCallType(message, taskKind);
  const recoveredSourceRecord = recoveredResponse
    ? await runtime.sessionManager.findUniqueSourceRecordedTurn(message.channelId, turnId)
    : null;
  if (recoveredSourceRecord && recoveredSourceRecord.status !== 'completed') {
    throw new Error('Recovered delivery source TurnRecord is not completed');
  }
  const recoveredLogicalSessionId = recoveredSourceRecord
    ? (recoveredSourceRecord.sessionId ?? recoveredSourceRecord.channelId).trim()
    : '';
  // A recovered exact-record miss must resolve the live route after the async
  // archive lookup. A reset during that lookup owns future work; capturing the
  // route before awaiting would admit this turn into the retired session.
  const activeLogicalSessionId = recoveredLogicalSessionId
    ? ''
    : runtime.sessionManager.resolveSessionForIngress(message.channelId).trim();
  const logicalSessionId = recoveredLogicalSessionId || activeLogicalSessionId;
  if (!logicalSessionId) {
    throw new Error('Turn execution requires a logical session id');
  }
  let turnCorrelationBase = runtime.buildTurnCorrelation(
    message,
    turnCallType,
    turnId,
    requestId,
    logicalSessionId,
  );
  const turnSessionIdentity: TurnSessionIdentity = Object.freeze({
    sourceChannelId: message.channelId,
    logicalSessionId,
  });
  const sessionReads = runtime.sessionManager.createCapturedSessionReads(turnSessionIdentity);
  const admittedRuntime: TurnExecutionRuntime = runtime;
  return await sessionReads.run(async () => {
  const runtime = admittedRuntime;
  const initialCorrelationSessionId = turnCorrelationBase.sessionId?.trim();
  const wyomingObservabilitySessionId = message.routing?.wyoming?.sessionId?.trim();
  const correlationUsesWyomingSession = Boolean(
    wyomingObservabilitySessionId
    && initialCorrelationSessionId === wyomingObservabilitySessionId,
  );
  const turnCorrelationSessionId = recoveredResponse && !correlationUsesWyomingSession
    ? logicalSessionId
    : initialCorrelationSessionId || logicalSessionId;
  turnCorrelationBase = {
    ...turnCorrelationBase,
    sessionId: turnCorrelationSessionId,
    conversationId: turnCorrelationBase.icpCorrelation?.conversationId ?? turnCorrelationSessionId,
  };
  const rebuildTurnCorrelation = (): CorrelationMetadata => {
    const rebuilt = runtime.buildTurnCorrelation(
      message,
      turnCallType,
      turnId,
      requestId,
      turnCorrelationSessionId,
    );
    return {
      ...rebuilt,
      sessionId: turnCorrelationSessionId,
      conversationId: rebuilt.icpCorrelation?.conversationId ?? turnCorrelationSessionId,
    };
  };
  const performanceCompanionId = turnCorrelationBase.companionId
    ?? runtime.config.companionId?.trim();
  void emitTurnPerformance(runtime.eventBus, {
    traceId: requestId,
    turnId,
    requestId,
    channelId: message.channelId,
    channelType: message.channelType,
    ...(performanceCompanionId ? { companionId: performanceCompanionId } : {}),
    stage: 'transport_received',
    monotonicAtMs: transportReceivedAt,
    timestampMs: transportReceivedTimestamp,
  }).catch(error => {
    log.debug('Turn transport performance telemetry emit failed', {
      channelId: message.channelId,
      turnId,
      requestId,
      error: toErrorMessage(error),
    });
  });
  const foregroundLease = runtime.beginForegroundBackgroundWork(logicalSessionId);
  if (foregroundLease) await foregroundLease.ready;
  const abortRunAfterForegroundLoss = foregroundLease
    ? () => { abortActiveAgentRun(runtime.agent, requestId); }
    : null;
  if (foregroundLease && abortRunAfterForegroundLoss) {
    foregroundLease.signal.addEventListener('abort', abortRunAfterForegroundLoss, { once: true });
  }
  assertForegroundWorkOwned(foregroundLease);
  try {
  const startTime = Date.now();
  const focusMemoryScopeQuery = sessionReads.getActiveFocusMemoryScopeQuery();
  const hasDeferredVisionPersistence = hasVisionTurnInputs(message);
  // A fresh inbound companion correlation is not trusted until it has been
  // bound to the resolved canonical peer below. Keep it out of L0 until that
  // validation succeeds so a rejected envelope cannot poison actor history.
  const deferSessionEntryPersistence = hasDeferredVisionPersistence
    || inboundIcpCorrelation !== null;
  const skipSessionEntryPersistence = recoveredResponse !== undefined
    || deliveryLifecycle?.sourceAlreadyPersisted === true;
  const observability = createTurnExecutionObservability({
    runtime,
    message,
    startTime,
    turnId,
    requestId,
    turnCallType,
    turnCorrelationBase,
  });
  const identityState = await prepareTurnIdentityState({
    runtime,
    sessionReads,
    message,
    turnSessionIdentity,
    turnId,
    requestId,
    turnCorrelationBase,
    observability,
    ...(authenticatedConversationScope
      ? { conversationScope: authenticatedConversationScope }
      : {}),
    deferSessionEntryPersistence,
    skipSessionEntryPersistence,
  });
  const {
    authorContext,
    channelMeta,
    contextEnvelope,
    broadcastVisibilityScope,
    viewerRequestContext,
    baseVisionToolRequestContext,
    continuitySubjectKey,
    attributedSystemContent,
    userSessionEntryId: preparedUserSessionEntryId,
    emotionSessionId,
    trustLevel,
    speakerRole,
    canonicalContactKey,
    conversationScope,
  } = identityState;
  const inboundIcpOrigin = message.routing?.icpCorrelation;
  const explicitPeerInvitation = privateIcpCorrelation === null
    && inboundIcpOrigin?.costOriginStage === 'initiation';
  if (recoveredCorrelation) {
    if (!canonicalContactKey || recoveredCorrelation.peerContactId !== canonicalContactKey) {
      throw new Error('Recovered ICP delivery peer does not match the resolved canonical contact');
    }
    message.routing = {
      ...message.routing,
      icpCorrelation: recoveredCorrelation,
    };
    turnCorrelationBase = rebuildTurnCorrelation();
  } else if (inboundIcpOrigin && !privateIcpCorrelation) {
    const localCompanionId = resolveCompanionIdFromConfig(runtime.config);
    if (inboundIcpOrigin.localCompanionId !== message.authorId
      || inboundIcpOrigin.peerCompanionId !== localCompanionId
      || inboundIcpOrigin.channelId !== message.channelId
      || !canonicalContactKey
      || authorContext.actorKind !== 'machine_intelligence'
      || !authorContext.speakingWithIsMachineIntelligence) {
      throw new Error('Inbound ICP initiation correlation does not match recipient identity/contact routing');
    }
    const recipientCorrelation = parseIcpConversationCorrelation({
      ...inboundIcpOrigin,
      localCompanionId,
      peerCompanionId: message.authorId,
      peerContactId: canonicalContactKey,
      turnId,
      messageId: message.id,
      requestId,
      costOriginStage: 'reply',
      fatigueDecision: 'not_evaluated',
    });
    message.routing = {
      ...message.routing,
      icpCorrelation: recipientCorrelation,
    };
    turnCorrelationBase = rebuildTurnCorrelation();
  }
  let promptMode: MessagePromptOverrideMode = 'default';
  let fullPrompt = '';
  let contextMessageCount = 0;
  let memoryContextChars = 0;
  let memoryContextBlock = '';
  let wikiContextBlock = '';
  let turnSnapshot: TurnSnapshot | undefined;
  let turnMessages: AgentMessage[] = [];
  let pendingPaidDeliverables: readonly PendingPaidDeliverable[] = [];
  let responseModel = runtime.agent.state.model.id;
  let userSessionEntryId = preparedUserSessionEntryId;
  let assistantSessionEntryId: number | null = null;
  let internalStateSnapshotRef: string | undefined;
  let persistedUserMessageContent: string | undefined;
  let fatigueDecision: FatigueTurnDecision | null = null;
  let humanAttentionPressure: HumanAttentionPressureEvent | null = null;
  let durableFatigueReservation: NonNullable<SubstrateMessage['routing']>['icpCorrelation'] | null = null;
  let recoveredFatigueReservationOutcome: IcpFatigueReservationOutcome | null = null;
  let durableDeliveryFinalized = false;
  let durableRecoveryResponsePersisted = recoveredResponse !== undefined;
  const completedTurnRecordState = { persisted: false };
  const invocationState: AgentInvocationMutableState = {
    turnMessages,
    turnStartMessageIndex: null,
  };
  const recordDeferredSessionEntry = (contentOverride?: string): number | null => {
    if (speakerRole === 'system') {
      return runtime.recordSystemMessage(
        message,
        turnSessionIdentity,
        turnId,
        requestId,
        contentOverride ?? attributedSystemContent,
        continuitySubjectKey,
      );
    }
    return runtime.recordUserMessage(
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      trustLevel,
      continuitySubjectKey,
      contentOverride,
      resolveSessionActorKind(authorContext),
    );
  };
  if (inboundIcpCorrelation
    && !hasDeferredVisionPersistence
    && !skipSessionEntryPersistence
    && userSessionEntryId == null) {
    userSessionEntryId = recordDeferredSessionEntry();
  }

  try {
    const channelType = runtime.resolveChannelType(message);
    if (recoveredResponse?.metadata.fatiguePendingSpend) {
      if (!message.routing?.icpCorrelation
        || !runtime.fatigueRegulationReservations
        || !runtime.config.chargePolicy) {
        throw new Error('Recovered ICP fatigue spend requires its durable reservation runtime');
      }
      recoveredFatigueReservationOutcome = await resumeIcpFatigueRegulation({
        correlation: message.routing.icpCorrelation,
        pendingSpend: recoveredResponse.metadata.fatiguePendingSpend,
        reservationPort: runtime.fatigueRegulationReservations,
        fatiguePolicy: runtime.config.chargePolicy.fatigue,
      });
      durableFatigueReservation = message.routing.icpCorrelation;
    }
    fatigueDecision = recoveredResponse
      ? null
      : evaluateRuntimeFatigue({
          runtime,
          sessionReads,
          message,
          turnSessionIdentity,
          authorContext,
          channelType,
          channelMeta,
          taskKind,
          explicitPeerInvitation,
          turnCorrelationBase,
          timestampMs: startTime,
        });
    humanAttentionPressure = recoveredResponse
      ? null
      : evaluateHumanAttentionPressure({
          runtime,
          message,
          turnSessionIdentity,
          authorContext,
          timestampMs: startTime,
          turnId,
        });
    if (fatigueDecision) {
      const icpCorrelation = message.routing?.icpCorrelation;
      if (icpCorrelation) {
        const finalFatigueDecision = fatigueDecision.metadata.decision === 'suppressed_hard_exhausted'
          ? 'suppress'
          : fatigueDecision.metadata.decision === 'overcharge_charged'
            ? 'allow_overcharge'
            : 'allow';
        const evaluatedCorrelation: IcpConversationCorrelation = {
          ...icpCorrelation,
          fatigueDecision: finalFatigueDecision,
          chargeLane: fatigueDecision.metadata.socialRegulation.chargeLane,
          ...(finalFatigueDecision === 'suppress'
            ? { fatigueReasonCode: 'fatigue_exhausted' }
            : {}),
        };
        message.routing = {
          ...message.routing,
          icpCorrelation: evaluatedCorrelation,
        };
        turnCorrelationBase = {
          ...turnCorrelationBase,
          icpCorrelation: evaluatedCorrelation,
          chargeLane: evaluatedCorrelation.chargeLane,
        };
      }
      if (fatigueDecision.shouldRecordSpend && message.routing?.icpCorrelation) {
        const reconciliation = await reserveIcpFatigueRegulation({
          correlation: message.routing.icpCorrelation,
          fatigueDecision,
          multiCompanion: runtime.config.multiCompanion === true,
          reservationPort: runtime.fatigueRegulationReservations,
          fatiguePolicy: runtime.config.chargePolicy!.fatigue,
        });
        fatigueDecision = reconciliation.fatigueDecision;
        durableFatigueReservation = reconciliation.durableReservation;
        message.routing = {
          ...message.routing,
          icpCorrelation: reconciliation.correlation,
        };
        turnCorrelationBase = {
          ...turnCorrelationBase,
          icpCorrelation: reconciliation.correlation,
          chargeLane: reconciliation.correlation.chargeLane,
        };
      }
      emitFatigueDecision({
        runtime,
        message,
        turnCorrelationBase,
        fatigueDecision,
        observability,
      });
    }
    if (fatigueDecision?.suppressModel) {
      const completedAt = Date.now();
      const suppressedResponse = buildSuppressedFatigueResponse({
        message,
        startTime,
        completedAt,
        model: responseModel,
        fatigue: fatigueDecision.metadata,
      });
      await deliveryLifecycle?.finalizeDelivery(suppressedResponse);
      observability.emitObservedTurnStage('end', {
        durationMs: completedAt - startTime,
        ttftMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        fatigue: summarizeFatigue(fatigueDecision.metadata),
      });
      const suppressedTurnRecord = runtime.buildTurnRecord({
        message,
        turnSessionIdentity,
        turnId,
        requestId,
        startedAt: startTime,
        completedAt,
        userSessionEntryId,
        assistantSessionEntryId,
        response: suppressedResponse,
        turnMessages: [],
        promptMode,
        promptText: fullPrompt,
        contextMessageCount,
        memoryContextChars,
        trustLevel,
        speakerRole,
        canonicalContactKey,
        retrievalProvenanceRefs: [],
        turnObservability: {
          stages: observability.getObservedTurnStages(),
          retrievals: observability.getObservedTurnRetrievals(),
          ...(observability.getObservedTurnSnapshot() ? { snapshot: observability.getObservedTurnSnapshot() } : {}),
        },
      }, sessionReads);
      await runtime.eventBus.emit('agent.turn.end', {
        message,
        response: suppressedResponse,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.end'),
      });
      // Suppression still follows the ordinary completion contract: only
      // publish the durable completed-turn marker after its awaited end event.
      await runtime.sessionManager.recordTurn(suppressedTurnRecord);
      return suppressedResponse;
    }
    runtime.ensureModel(message);
    responseModel = runtime.agent.state.model.id;
    const contextAssemblyStartedAt = performance.now();
    const preTurnState = await computePreTurnState({
      runtime,
      sessionReads,
      message,
      turnSessionIdentity,
      channelType,
      taskKind,
      turnId,
      requestId,
      channelMeta,
      authorContext,
      conversationScope,
      continuitySubjectKey,
      trustLevel,
      emotionSessionId,
      turnBudgetCharacteristics,
      currentSessionEntryId: userSessionEntryId,
      focusMemoryScopeQuery,
      temporalRetrievalCallerContext,
      temporalRetrievalMode,
      viewerRequestContext,
      turnCorrelationBase,
      observability,
    });
    observability.emitPerformanceStage('context_assembly', {
      durationMs: Math.max(0, performance.now() - contextAssemblyStartedAt),
    });
    turnSnapshot = preTurnState.turnSnapshot;
    if (fatigueDecision) {
      turnSnapshot.fatigue = fatigueDecision.metadata;
    }
    memoryContextBlock = preTurnState.memoryContextBlock;
    wikiContextBlock = preTurnState.wikiContextBlock;
    memoryContextChars = preTurnState.memoryContextChars;
    const toolTurnOutcome = runtime.resolveToolTurnOutcome(message, taskKind);
    runtime.applyActiveToolsToAgentForTurn(
      message,
      taskKind,
      turnCallType,
      turnCorrelationBase,
      toolTurnOutcome,
    );
    const responseStyle = runtime.resolveResponseStyle(message, channelType, channelMeta);
    // htm9.18: the canonical CogSec mode is always armed (shadow/boundary/
    // strict), so a turn-scoped canary carrier is always registered; shadow
    // observes, boundary/strict may hold at the egress sink.
    const canaryToken = sessionCanaryRegistry.ensure(emotionSessionId);
    // d269: when this turn was initiated by a reply-bearing reverse-RPC call
    // (voice.handleMessage / voice.transcript.end / api.chat.completion), record
    // the token into the ambient reply capture so the reply result carries the
    // carrier back to the gateway reply guard. No-op outside such a capture.
    if (canaryToken) {
      recordReplyCanaryToken(canaryToken);
    }
    const promptAssemblyStartedAt = performance.now();
    const promptAssembly = await assembleTurnPrompt({
      runtime,
      sessionReads,
      message,
      turnSessionIdentity,
      channelType,
      taskKind,
      channelMeta,
      authorContext,
      conversationScope,
      trustLevel,
      responseStyle,
      emotionSessionId,
      preTurnInternalState: preTurnState.preTurnInternalState,
      emotionAppraisalChain: preTurnState.emotionAppraisalChain,
      memoryContextBlock,
      wikiContextBlock,
      scratchpadBlock: preTurnState.scratchpadBlock,
      turnBudgetCharacteristics,
      continuitySubjectKey,
      temporalRetrievalMode,
      viewerRequestContext,
      turnCorrelationBase,
      turnCallType,
      turnSnapshot,
      currentSessionEntryId: userSessionEntryId,
      memoryManifestSeed: preTurnState.memoryManifestSeed ?? observability.getMemoryManifestSeed(),
      ...(fatigueDecision ? { fatigue: fatigueDecision.metadata } : {}),
      ...(humanAttentionPressure ? { humanAttentionPressure } : {}),
      ...(canaryToken ? { canaryToken } : {}),
      getRetrievalProvenanceRefs: observability.getRetrievalProvenanceRefs,
      getObservedTurnRetrievals: observability.getObservedTurnRetrievals,
      observability,
    });
    observability.emitPerformanceStage('prompt_assembly', {
      durationMs: Math.max(0, performance.now() - promptAssemblyStartedAt),
    });
    promptMode = promptAssembly.promptMode;
    fullPrompt = promptAssembly.fullPrompt;
    contextMessageCount = promptAssembly.contextMessageCount;

    if (!recoveredResponse) {
      // Publish the context already admitted before the first model step. MCP
      // authorization reads this lineage lazily; the scheduler tightens it to
      // confidential as soon as any screened tool result enters the loop.
      runtime.setCurrentTurnDisclosureLineage(buildGenerationDisclosureLineage({
        context: {
          generationContextRef: `turn:${turnId}`,
          classifierVersion: DISCLOSURE_CLASSIFIER_VERSION,
          classifiedAt: new Date().toISOString(),
        },
        conversationScope,
        conversationChannelEpoch: currentChannelClassificationEpoch(conversationScope.channelId),
        memorySources: preTurnState.disclosureMemorySources,
        biographicalSources: preTurnState.disclosureBiographicalSources,
        wikiSources: preTurnState.disclosureWikiSources,
        toolResultSources: [],
      }));
    }

    const promptStageStart = Date.now();
    // Establish the turn-scoped paid-deliverable registry around the agent
    // invocation so charged tools (e.g. paid image generation) can record an
    // undelivered artifact and the in-turn response_control tool can refuse a
    // no-reply that would silently drop it.
    let scopedPendingPaidDeliverables: readonly PendingPaidDeliverable[] = [];
    const invokeWithPaidDeliverableTracking = () => runWithPaidDeliverableTracking(async () => {
      try {
        return await invokeAgentForTurn({
          runtime,
          message,
          turnSessionIdentity,
          context: promptAssembly.context,
          authoritativeSystemPrompt: promptAssembly.fullPrompt,
          providerSystemPrompt: promptAssembly.providerSystemPrompt,
          piMessages: promptAssembly.piMessages,
          startTime,
          promptStageStart,
          turnId,
          requestId,
          taskKind,
          turnCallType,
          turnCorrelationBase,
          viewerRequestContext,
          baseVisionToolRequestContext,
          toolTurnOutcome,
          turnSnapshot: turnSnapshot!,
          templateVariables: promptAssembly.templateVariables,
          speakerRole,
          mutableState: invocationState,
          observability,
        });
      } finally {
        scopedPendingPaidDeliverables = listPendingPaidDeliverables();
        pendingPaidDeliverables = scopedPendingPaidDeliverables;
      }
    });
    // Shadow/enforce carry the marker for observation. Off bypasses the async
    // canary context entirely so gateway client calls remain byte-identical.
    const recoveredInvocationResult: AgentInvocationResult | null = recoveredResponse
      ? {
          firstTokenAt: null,
          turnMessages: [],
          turnUsage: {
            inputTokens: recoveredResponse.metadata.inputTokens,
            outputTokens: recoveredResponse.metadata.outputTokens,
            cacheReadTokens: 0,
            llmCalls: 1,
            toolCalls: 0,
            contextUtilization: 0,
          },
          responseModel: recoveredResponse.metadata.model,
          responseText: recoveredResponse.content,
          fallbackDiagnostics: recoveredResponse.metadata.diagnostics,
          runtimeContradictionDiagnostics: recoveredResponse.metadata.diagnostics?.runtimeContradiction
            ? { runtimeContradiction: recoveredResponse.metadata.diagnostics.runtimeContradiction }
            : undefined,
          turnIntent: null,
        }
      : null;
    const invokeWithCanary = () => canaryToken
      ? runWithCanaryContext(canaryToken, invokeWithPaidDeliverableTracking)
      : invokeWithPaidDeliverableTracking();
    const invokeWithMcpDisclosure = () => runWithMcpTurnDisclosureContext({
      getLineage: runtime.getCurrentTurnDisclosureLineage,
    }, invokeWithCanary);
    assertForegroundWorkOwned(foregroundLease);
    const invocationResult = recoveredInvocationResult ?? await invokeWithCompanionSocialCharge({
      chargePolicy: runtime.config.chargePolicy,
      correlation: turnCorrelationBase,
      fatigue: fatigueDecision?.metadata,
      invoke: invokeWithMcpDisclosure,
      recordChargeEvent: runtime.durableChargeRecorder,
      probeChargeEvent: runtime.durableChargeProbe,
      turnId,
      withCorrelationPurpose: runtime.withCorrelationPurpose,
    });
    assertForegroundWorkOwned(foregroundLease);
    pendingPaidDeliverables = scopedPendingPaidDeliverables;
    turnMessages = invocationResult.turnMessages;
    responseModel = invocationResult.responseModel;
    persistedUserMessageContent = invocationResult.persistedUserMessageContent;
    if (deferSessionEntryPersistence && userSessionEntryId == null) {
      userSessionEntryId = recordDeferredSessionEntry(persistedUserMessageContent);
    }
    const {
      firstTokenAt,
      turnUsage,
      fallbackDiagnostics,
      runtimeContradictionDiagnostics,
      runtimeFallbackProvenance,
    } = invocationResult;
    // Fail-safe strip of mimicked history stamps (psfn-framework-2x37.10),
    // applied where the model's turn text is accepted so persistence,
    // channel dispatch, and TTS all see clean output.
    const responseText = stripLeadingHistoryStamps(invocationResult.responseText);
    const noReplyDecision = recoveredResponse?.metadata.noReply
      ?? runtime.consumeIntentionalNoReplyDecision(turnId);
    // Intentional silence is only honored when no user-facing reply was
    // authored. A no_reply issued during internal follow-up continuation
    // (whisper/system-note steps drained into this run) must not suppress the
    // reply already written for the user — that silently drops an authored
    // reply (psfn-framework-ay73). responseText is already bounded to the
    // user-facing portion of the run via the user-facing boundary index.
    const honorNoReply = noReplyDecision != null && responseText.trim().length === 0;
    if (noReplyDecision && !honorNoReply) {
      log.warn('Intentional no-reply demoted: user-facing reply already authored this turn; delivering the reply', {
        channelId: message.channelId,
        turnId,
        requestId,
        noReplyAuditId: noReplyDecision.auditId,
        noReplySource: noReplyDecision.source,
      });
      runtime.emitTelemetry('agent.no_reply.demoted', {
        channelId: message.channelId,
        turnId,
        auditId: noReplyDecision.auditId,
        source: noReplyDecision.source,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.no_reply.demoted'),
      });
    }
    let safeResponseText = honorNoReply ? '' : responseText;
    let broadcastSafetyMeta: AgentResponse['metadata']['broadcastSafety'] | undefined =
      recoveredResponse?.metadata.broadcastSafety;

    if (contextEnvelope.broadcast) {
      const visibilityScope = broadcastVisibilityScope ?? 'public_only';
      const classification = classifyBroadcastDraft(responseText);
      const operatorApproval = visibilityScope === 'approved_private_context';
      const approvalRequired = classification.risky && !operatorApproval;
      const provenanceRefs = [...new Set(observability.getRetrievalProvenanceRefs())];

      broadcastSafetyMeta = {
        visibilityScope,
        operatorApproval,
        risky: classification.risky,
        signals: classification.signals,
        approvalRequired,
        provenanceRefs,
      };

      runtime.emitTelemetry('broadcast.pre_send.classified', {
        channelId: message.channelId,
        risky: classification.risky,
        signals: classification.signals,
        visibilityScope,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.pre_send.classified'),
      });

      if (approvalRequired) {
        runtime.emitTelemetry('broadcast.approval.required', {
          channelId: message.channelId,
          signals: classification.signals,
          visibilityScope,
          draftLength: responseText.length,
          ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.approval.required'),
        });
        runtime.sessionManager.appendSystemNote(
          turnSessionIdentity.logicalSessionId,
          `Broadcast draft held for approval (${classification.signals.join(', ') || 'risk'} risk).`,
          'appendSystemNote',
          turnSessionIdentity.sourceChannelId,
        );
        safeResponseText = '';
      }

      const provenancePayload = {
        channelId: message.channelId,
        visibilityScope,
        operatorApproval,
        risky: classification.risky,
        signals: classification.signals,
        provenanceRefs,
        contextMessageCount,
        memoryContextChars,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'broadcast.provenance'),
      };
      runtime.emitTelemetry('broadcast.provenance', provenancePayload);
      log.info('Broadcast provenance', provenancePayload);
    }

    const retrievalProvenanceRefs = observability.getRetrievalProvenanceRefs();
    const internalState = recoveredResponse?.metadata.internalState
      ? cloneInternalState(recoveredResponse.metadata.internalState)
      : await runtime.emotionSelfModelRuntime.computeInternalStateForTurn({
          message,
          responseText,
          trustLevel,
          canonicalContactKey,
          emotionSnapshot: preTurnState.emotionSnapshot,
          toolCallCount: turnUsage.toolCalls,
          sessionChannelId: emotionSessionId,
          conversationScope,
          capturedSessionReads: sessionReads,
        });
    internalStateSnapshotRef = recoveredResponse?.metadata.internalStateSnapshotRef
      ?? buildInternalStateSnapshotRef(internalState);
    const metacognitiveFlags = recoveredResponse?.metadata.metacognitiveFlags
      ? cloneMetacognitiveFlags(recoveredResponse.metadata.metacognitiveFlags)
      : runtime.emotionSelfModelRuntime.computeMetacognitiveFlagsForTurn({
          internalState,
          responseText,
          toolCallCount: turnUsage.toolCalls,
          sessionChannelId: emotionSessionId,
          retrievalProvenanceRefs,
          capturedSessionReads: sessionReads,
        });
    await runtime.setCurrentSelfModelState(
      internalState,
      internalStateSnapshotRef,
      metacognitiveFlags,
    );

    // Companion emotion relay (bead psfn-framework-7ang.1): publish a redacted
    // per-turn emotion snapshot sourced from the post-turn InternalState. The
    // forwarder redacts before anything crosses the relay; emission is strictly
    // fire-and-forget so a relay failure can never break the turn.
    const emotionAcacAxisScores = extractRelayAcacAxisScores(internalState.emotional.acac);
    void runtime.eventBus.emit('agent.emotion.snapshot', {
      trigger: 'post_turn',
      vad: { ...internalState.emotional.vad },
      mood: { ...internalState.emotional.mood },
      discrete: { ...internalState.emotional.discreteEmotions },
      confidence: internalState.emotional.confidence,
      ...(emotionAcacAxisScores ? { acacAxisScores: emotionAcacAxisScores } : {}),
      channelId: emotionSessionId,
      timestamp: Date.now(),
    }).catch((error) => {
      log.warn('Failed to emit companion emotion snapshot', {
        error: toErrorMessage(error),
      });
    });

    const toolResultDisclosureSources = runtime.recordToolObservations(
      message,
      turnSessionIdentity,
      turnId,
      requestId,
      turnMessages,
      trustLevel,
    );
    const artifactSensitivitySources: ArtifactSensitivitySource[] = [
      ...preTurnState.artifactSensitivitySources,
      {
        ref: `turn:${turnId}`,
        sensitivity: contextEnvelope.channelPrivacy === 'public' ? 'public' : 'personal',
      },
    ];
    const artifactSensitivityClassification = classifyArtifactSensitivity(
      artifactSensitivitySources,
    );

    // jp36.1.1.2/jp36.1.1.3: fold every admitted source (session history, memory
    // retrieval, wiki/project/journal reads, tool results) into the outbound
    // disclosure lineage for this generation context (bible §9.2). The
    // destination-eligibility gate that consumes it at egress is jp36.1.3; here
    // the lineage is accumulated from the real admitted sources and surfaced for
    // audit, never used to alter this turn's behavior. Tool-result taint rides
    // the intake-firewall verdict recordToolObservations just computed, so a
    // tainted/unscreened tool result fails the whole context closed (§9.0/§9.5).
    const generationDisclosureLineage = buildGenerationDisclosureLineage({
      context: {
        generationContextRef: `turn:${turnId}`,
        classifierVersion: DISCLOSURE_CLASSIFIER_VERSION,
        classifiedAt: new Date().toISOString(),
      },
      conversationScope,
      // jp36.6.4: this turn's own session content is admitted under the
      // conversation channel's CURRENT epoch, so it stays auto-eligible to the
      // room only while the room remains at that epoch. Untracked channels resolve
      // to undefined and the epoch gate stays inert (byte-identical).
      conversationChannelEpoch: currentChannelClassificationEpoch(conversationScope.channelId),
      memorySources: preTurnState.disclosureMemorySources,
      biographicalSources: preTurnState.disclosureBiographicalSources,
      wikiSources: preTurnState.disclosureWikiSources,
      toolResultSources: toolResultDisclosureSources,
    });
    log.debug('Disclosure lineage accumulated', {
      turnId,
      requestId,
      generationContextRef: generationDisclosureLineage.generationContextRef,
      classification: generationDisclosureLineage.classification,
      effectiveSensitivity: generationDisclosureLineage.effectiveSensitivity,
      sourceCount: generationDisclosureLineage.sourceCount,
      wikiSourceCount: preTurnState.disclosureWikiSources.length,
      toolResultSourceCount: toolResultDisclosureSources.length,
      hasUnclassifiedSource: generationDisclosureLineage.hasUnclassifiedSource,
      permittedDestinationKinds: generationDisclosureLineage.permittedDestinations.map(constraint => constraint.kind),
      subjectContactCount: generationDisclosureLineage.subjectContactIds.length,
    });
    // jp36.1.3: publish the folded lineage so the egress tool guard composes the
    // destination check over it for outbound social sends this turn. Until this
    // point the guard sees no lineage and fails closed for outward destinations.
    runtime.setCurrentTurnDisclosureLineage(generationDisclosureLineage);
    let responseAttachments = honorNoReply
      ? []
      : recoveredResponse?.attachments
        ? [...recoveredResponse.attachments]
        : await collectTurnResponseAttachments({
          runtime,
          turnMessages,
          paidDeliverables: pendingPaidDeliverables,
          galleryContext: {
            channelId: message.channelId,
            channelType: message.channelType,
            turnId,
            requestId,
            sourceMessageId: message.id,
            ...(userSessionEntryId !== null ? { userSessionEntryId } : {}),
            sensitivitySources: artifactSensitivitySources,
            sensitivityClassification: artifactSensitivityClassification,
          },
        });

    if (responseAttachments.length > 0) {
      const requestAudience = viewerRequestContext.requestAudience;
      const destination: ArtifactEgressDestination = {
        audience: requestAudience ?? 'ambiguous',
        channelId: message.channelId,
        channelType: message.channelType,
        surface: message.channelType === 'psfn-amica'
          ? 'satellite'
          : message.channelType === 'api'
            ? 'pwa'
            : contextEnvelope.broadcast || contextEnvelope.channelPrivacy === 'public'
              ? 'public_channel'
              : requestAudience === 'self' || requestAudience === 'primary_contact'
                ? 'conversation'
                : 'external',
      };
      const egressDeps = {
        approvalQueue: runtime.artifactApprovalQueue,
        notifier: runtime.artifactApprovalNotifier,
        readCurrentClassifications: readGeneratedImageSensitivityClassifications,
        executeApprovedShare: async (
          approvedAttachments: readonly Attachment[],
          approvedDestination: ArtifactEgressDestination,
        ) => {
          if (!runtime.shareApprovedArtifacts) {
            throw new Error('Approved artifact egress is not wired for this runtime');
          }
          await runtime.shareApprovedArtifacts(approvedAttachments, approvedDestination);
        },
      };
      const egress = recoveredResponse
        ? await authorizeRecoveredArtifactEgress({
            attachments: responseAttachments,
            destination,
            deps: egressDeps,
          })
        : await authorizeArtifactEgress({
            attachments: responseAttachments,
            classification: artifactSensitivityClassification,
            destination,
            deps: egressDeps,
          });
      responseAttachments = egress.attachments;
      if (egress.disposition !== 'proceed') {
        safeResponseText = '';
      }
      if (egress.disposition === 'queued') {
        runtime.sessionManager.appendSystemNote(
          turnSessionIdentity.logicalSessionId,
          `Artifact share held for operator review because it inherited ${egress.sensitivity} context. `
            + `Confirmation ${egress.queueEntry.id} is pending; the artifact remains in the personal gallery.`,
          'artifact_egress_approval',
          turnSessionIdentity.sourceChannelId,
        );
      }
    }

    if (rejectsMissingImageAttachmentClaim({
      responseText: safeResponseText,
      attachmentCount: responseAttachments.length,
    })) {
      const healedResponseText = healMissingImageAttachmentClaim(safeResponseText);
      safeResponseText = healedResponseText.length > 0
        ? healedResponseText
        : MISSING_IMAGE_ATTACHMENT_CORRECTION;
      log.warn('Rejected assistant image-attachment claim without a current-turn attachment', {
        channelId: message.channelId,
        turnId,
        requestId,
      });
      runtime.emitTelemetry('agent.image_attachment_claim.rejected', {
        channelId: message.channelId,
        turnId,
        requestId,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.image_attachment_claim.rejected'),
      });
    }

    const activeToolNames = (
      turnSnapshot.plan?.toolDefinitions
      ?? turnSnapshot.toolContext?.activeTools
      ?? []
    ).map(tool => tool.name);
    const knownToolNames = [
      ...new Set([
        ...activeToolNames,
        ...CANONICAL_FIRST_PARTY_TOOL_SURFACES.map(tool => tool.name),
      ]),
    ];
    const unavailableRequestedToolNames = resolveExplicitlyRequestedToolNames(
      message.content,
      knownToolNames,
    ).filter(name => !activeToolNames.includes(name));
    if (rejectsUnconfirmedToolExecutionClaim({
      requestText: message.content,
      activeToolNames,
      responseText: safeResponseText,
      turnMessages,
    })) {
      safeResponseText = unavailableRequestedToolNames.length > 0
        ? UNAVAILABLE_REQUESTED_TOOL_CORRECTION
        : UNCONFIRMED_TOOL_EXECUTION_CORRECTION;
      log.warn('Rejected assistant execution-success claim without a successful tool outcome', {
        channelId: message.channelId,
        turnId,
        requestId,
      });
      runtime.emitTelemetry('agent.tool_execution_claim.rejected', {
        channelId: message.channelId,
        turnId,
        requestId,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.tool_execution_claim.rejected'),
      });
    }

    if (detectsUnfinishedToolExecutionNarration(safeResponseText)) {
      log.warn('Assistant final response narrates a tool action that did not finish in the turn', {
        channelId: message.channelId,
        turnId,
        requestId,
      });
      runtime.emitTelemetry('agent.tool_execution_narration.unfinished', {
        channelId: message.channelId,
        turnId,
        requestId,
        ...runtime.withCorrelationPurpose(
          turnCorrelationBase,
          'agent.tool_execution_narration.unfinished',
        ),
      });
    }

    if (rejectsUnfulfilledImageEditRequest({
      requestText: message.content,
      requestHasImageInput: message.attachments?.some(
        attachment => attachment.contentType.trim().toLowerCase().startsWith('image/'),
      ) ?? false,
      turnMessages,
    })) {
      safeResponseText = UNFULFILLED_IMAGE_EDIT_REQUEST_CORRECTION;
      log.warn('Rejected unfulfilled image-edit request without a successful edit tool outcome', {
        channelId: message.channelId,
        turnId,
        requestId,
      });
      runtime.emitTelemetry('agent.image_edit_request.unfulfilled', {
        channelId: message.channelId,
        turnId,
        requestId,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.image_edit_request.unfulfilled'),
      });
    }

    // Fail loud, never silently: if a charged image deliverable was produced this
    // turn but is not riding out on the reply, surface it. The response_control
    // guard should prevent the no-reply case; this is the last-resort audit trail.
    const chargedImageDeliverables = mergeChargedImageDeliverableSummaries(
      summarizeChargedImageDeliverables(turnMessages),
      summarizePendingPaidImageDeliverables(pendingPaidDeliverables),
    );
    if (chargedImageDeliverables.length > 0) {
      if (honorNoReply) {
        log.warn('Paid image deliverable dropped by intentional no-reply', {
          channelId: message.channelId,
          turnId,
          requestId,
          noReplyAuditId: noReplyDecision.auditId,
          noReplySource: noReplyDecision.source,
          deliverables: chargedImageDeliverables,
        });
      } else if (responseAttachments.length === 0) {
        log.warn('Paid image deliverable was not attached to the outbound reply', {
          channelId: message.channelId,
          turnId,
          requestId,
          deliverables: chargedImageDeliverables,
        });
      }
    }

    const completedAt = Date.now();
    const responseDiagnostics: NonNullable<AgentResponse['metadata']['diagnostics']> = {};
    if (fallbackDiagnostics?.fallback) {
      responseDiagnostics.fallback = fallbackDiagnostics.fallback;
    }
    if (runtimeContradictionDiagnostics?.runtimeContradiction) {
      responseDiagnostics.runtimeContradiction = runtimeContradictionDiagnostics.runtimeContradiction;
    }
    let responseFatigueMetadata = recoveredResponse?.metadata.fatigue ?? fatigueDecision?.metadata;
    const fatiguePendingSpend: FatiguePendingSpendMetadata | undefined = fatigueDecision?.shouldRecordSpend
      ? {
          schemaVersion: 1,
          timestampMs: fatigueDecision.evaluation.timestampMs,
          decision: fatigueDecision.evaluation.decision,
          reason: fatigueDecision.evaluation.reason,
          amount: fatigueDecision.evaluation.amount,
          scope: { ...fatigueDecision.evaluation.scope },
          peer: { ...fatigueDecision.evaluation.peer },
          triggeringAuthor: { ...fatigueDecision.evaluation.triggeringAuthor },
          limits: {
            softLimit: fatigueDecision.evaluation.stateAfter.softLimit,
            hardLimit: fatigueDecision.evaluation.stateAfter.allowance,
            overchargeLimit: fatigueDecision.evaluation.stateAfter.overchargeAllowance,
          },
          correlation: projectFatiguePendingSpendCorrelation(
            runtime.withCorrelationPurpose(
              turnCorrelationBase,
              'agent.fatigue.record',
            ),
          ),
        }
      : recoveredResponse?.metadata.fatiguePendingSpend;
    const buildGeneratedResponse = (): AgentResponse => ({
      content: safeResponseText,
      channelId: message.channelId,
      ...(responseAttachments.length > 0 ? { attachments: responseAttachments } : {}),
      metadata: {
        model: responseModel,
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
        durationMs: completedAt - startTime,
        turnId,
        requestId,
        ...(runtimeFallbackProvenance ? { runtimeFallbackProvenance } : {}),
        ...(message.routing?.icpCorrelation
          ? { icpCorrelation: message.routing.icpCorrelation }
          : {}),
        internalState: cloneComputedInternalStateForResponse(internalState),
        internalStateSnapshotRef,
        metacognitiveFlags: cloneMetacognitiveFlags(metacognitiveFlags),
        ...(retrievalProvenanceRefs.length > 0 ? { retrievalProvenanceRefs } : {}),
        ...(Object.keys(responseDiagnostics).length > 0 ? { diagnostics: responseDiagnostics } : {}),
        ...(broadcastSafetyMeta ? { broadcastSafety: broadcastSafetyMeta } : {}),
        ...(responseFatigueMetadata ? { fatigue: responseFatigueMetadata } : {}),
        ...(fatiguePendingSpend ? { fatiguePendingSpend } : {}),
        ...(honorNoReply ? { noReply: noReplyDecision } : {}),
      },
    });

    if (!recoveredResponse
      && !broadcastSafetyMeta?.approvalRequired
      && honorNoReply
      && message.routing?.icpCorrelation) {
      if (!deliveryLifecycle) {
        throw new Error('Intentional ICP no-reply requires durable delivery recovery');
      }
      await deliveryLifecycle.finalizeDelivery(buildGeneratedResponse());
      durableRecoveryResponsePersisted = true;
    }

    if (!recoveredResponse && !broadcastSafetyMeta?.approvalRequired && !honorNoReply) {
      const durableRecoveryResponse = message.routing?.icpCorrelation
        ? buildGeneratedResponse()
        : undefined;
      assistantSessionEntryId = runtime.recordAssistantMessage(
        message,
        turnSessionIdentity,
        turnId,
        requestId,
        safeResponseText,
        trustLevel,
        continuitySubjectKey,
        preTurnState.emotionSnapshot,
        durableRecoveryResponse,
        runtimeFallbackProvenance,
      );
      durableRecoveryResponsePersisted = durableRecoveryResponse !== undefined;
    }

    if (fatigueDecision?.shouldRecordSpend) {
      if (!runtime.fatigueBudget) {
        throw new Error('Fatigue spend recording requires fatigueBudget');
      }
      const fatigueEvent = runtime.fatigueBudget.recordFinalDecision(
        fatigueDecision.evaluation,
        {
          correlation: runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.fatigue.record'),
          details: {
            enforcementDecision: fatigueDecision.metadata.decision,
            policyState: fatigueDecision.metadata.policyState,
            policyBaseState: fatigueDecision.metadata.policyBaseState,
            overchargePermitted: fatigueDecision.metadata.overchargePermitted,
            overchargeReasons: fatigueDecision.metadata.overchargeReasons,
            socialRegulation: fatigueDecision.metadata.socialRegulation,
            responseChars: responseText.length,
            model: responseModel,
          },
        },
      );
      responseFatigueMetadata = attachRecordedFatigueEvent(fatigueDecision.metadata, fatigueEvent);
      fatigueDecision = {
        ...fatigueDecision,
        metadata: responseFatigueMetadata,
      };
      turnSnapshot.fatigue = responseFatigueMetadata;
      runtime.emitTelemetry('agent.fatigue.recorded', {
        channelId: message.channelId,
        amount: fatigueEvent.amount,
        spentAfter: fatigueEvent.spentAfter,
        remainingAllowance: fatigueEvent.remainingAllowance,
        decision: responseFatigueMetadata.decision,
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.fatigue.recorded'),
      });
    } else if (recoveredResponse?.metadata.fatiguePendingSpend) {
      if (!runtime.fatigueBudget || !responseFatigueMetadata) {
        throw new Error('Recovered fatigue spend requires budget runtime and enforcement metadata');
      }
      const fatigueEvent = runtime.fatigueBudget.recordPendingSpend(
        recoveredResponse.metadata.fatiguePendingSpend,
        {
          correlation: runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.fatigue.record'),
          details: {
            recovery: true,
            responseChars: responseText.length,
            model: responseModel,
          },
        },
      );
      responseFatigueMetadata = attachRecordedFatigueEvent(responseFatigueMetadata, fatigueEvent);
    }
    const agentResponse: AgentResponse = recoveredResponse
      ? {
          content: safeResponseText,
          channelId: recoveredResponse.channelId,
          ...(responseAttachments.length > 0 ? { attachments: responseAttachments } : {}),
          metadata: {
            ...recoveredResponse.metadata,
            ...(responseFatigueMetadata ? { fatigue: responseFatigueMetadata } : {}),
          },
        }
      : buildGeneratedResponse();
    if (runtime.fatigueRegulationReservations
      && message.routing?.icpCorrelation
      && durableFatigueReservation
      && responseFatigueMetadata) {
      await runtime.fatigueRegulationReservations.prepareDelivery({
        correlation: message.routing.icpCorrelation,
        fatigue: responseFatigueMetadata,
        ...(recoveredFatigueReservationOutcome === 'delivered'
          || recoveredFatigueReservationOutcome === 'no_reply'
          ? { recoveredOutcome: recoveredFatigueReservationOutcome }
          : {}),
      });
    }
    assertForegroundWorkOwned(foregroundLease);
    await deliveryLifecycle?.finalizeDelivery(agentResponse);
    durableDeliveryFinalized = true;
    if (runtime.fatigueRegulationReservations
      && message.routing?.icpCorrelation
      && (durableFatigueReservation || recoveredResponse?.metadata.fatiguePendingSpend)
      && responseFatigueMetadata) {
      await runtime.fatigueRegulationReservations.finalize({
        correlation: message.routing.icpCorrelation,
        outcome: honorNoReply ? 'no_reply' : 'delivered',
        finalizedAtMs: Date.now(),
        fatigue: responseFatigueMetadata,
      });
      durableFatigueReservation = null;
    }

    const recoveredTurnRecord = recoveredResponse === undefined
      ? null
      : recoveredSourceRecord;
    if (recoveredTurnRecord?.status === 'completed') {
      const replayJobs = parseTurnRecordBackgroundWorkHandoff(recoveredTurnRecord);
      if (replayJobs.length > 0) {
        try {
          await runtime.enqueuePostTurnBackgroundWork(replayJobs);
        } catch (error) {
          runtime.sessionManager.deferBackgroundWorkHandoffRecovery(recoveredTurnRecord);
          throw error;
        }
      }
      return agentResponse;
    }

    if (runtime.skillsRuntime) {
      const toolSummary = runtime.buildTurnToolSummary(turnMessages);
      const nudge = runtime.evaluateReflectionNudge(toolSummary);
      if (nudge) {
        runtime.sessionManager.appendSystemNote(
          turnSessionIdentity.logicalSessionId,
          nudge,
          'appendSystemNote',
          turnSessionIdentity.sourceChannelId,
        );
      }
    }
    assertForegroundWorkOwned(foregroundLease);
    await schedulePostTurnWork({
      runtime,
      sessionReads,
      message,
      turnSessionIdentity,
      response: agentResponse,
      turnMessages,
      turnId,
      requestId,
      startTime,
      completedAt,
      firstTokenAt,
      turnUsage,
      context: promptAssembly.context,
      taskKind,
      turnCorrelationBase,
      userSessionEntryId,
      assistantSessionEntryId,
      promptMode,
      fullPrompt,
      contextMessageCount,
      memoryContextChars,
      memoryContextBlock,
      trustLevel,
      speakerRole,
      canonicalContactKey,
      continuitySubjectKey,
      turnSnapshot: turnSnapshot!,
      internalStateSnapshotRef,
      internalState,
      templateVariables: promptAssembly.templateVariables,
      emotionSessionId,
      channelMeta,
      conversationScope,
      turnBudgetCharacteristics,
      observability,
      persistedUserMessageContent,
      onTurnRecordPersisted: () => {
        completedTurnRecordState.persisted = true;
      },
    });

    observability.emitPerformanceStage('turn_complete', {
      durationMs: Math.max(0, monotonicEpochNowMs() - transportReceivedAt),
      model: responseModel,
      provider: runtime.agent.state.model.provider,
      toolUse: turnUsage.toolCalls > 0,
      cacheState: turnUsage.cacheReadTokens > 0 ? 'hit' : 'miss',
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      cacheReadTokens: turnUsage.cacheReadTokens,
      ...(turnUsage.estimatedCostUsd !== undefined ? { costUsd: turnUsage.estimatedCostUsd } : {}),
    });

    return agentResponse;
  } catch (error) {
    if (!durableDeliveryFinalized
      && !durableRecoveryResponsePersisted
      && durableFatigueReservation
      && runtime.fatigueRegulationReservations
      && fatigueDecision) {
      try {
        await runtime.fatigueRegulationReservations.finalize({
          correlation: durableFatigueReservation,
          outcome: 'failed',
          finalizedAtMs: Date.now(),
          fatigue: fatigueDecision.metadata,
        });
      } catch (finalizeError) {
        log.error('Failed to release durable ICP fatigue reservation after turn failure', {
          turnId,
          error: toErrorMessage(finalizeError),
        });
      }
    }
    if (durableFatigueReservation && runtime.fatigueRegulationReservations) {
      try {
        await runtime.fatigueRegulationReservations.handoff(durableFatigueReservation);
      } catch (handoffError) {
        log.error('Failed to hand off durable ICP fatigue reservation after turn failure', {
          turnId,
          error: toErrorMessage(handoffError),
        });
      }
      durableFatigueReservation = null;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    const continuationStopSnapshot = error instanceof ParentTurnContinuationBudgetExceededError
      ? error.stop
      : null;
    const observedFailureTurnMessages = invocationState.turnMessages.length > 0
      ? invocationState.turnMessages
      : invocationState.turnStartMessageIndex == null
        ? []
        : runtime.agent.state.messages.slice(invocationState.turnStartMessageIndex);
    let assistantMessageContent: string | undefined;
    const latestUserFacingAssistant = runtime.getLatestAssistantMessage();
    const assistantBelongsToFailedTurn = latestUserFacingAssistant !== null
      && observedFailureTurnMessages.includes(latestUserFacingAssistant);
    if (assistantBelongsToFailedTurn) {
      try {
        const extracted = runtime.extractResponseText().trim();
        if (extracted.length > 0) {
          assistantMessageContent = extracted;
        }
      } catch (extractionError) {
        log.debug('No outward assistant text available while recording failed turn', {
          turnId,
          requestId,
          error: toErrorMessage(extractionError),
        });
        assistantMessageContent = undefined;
      }
    }
    const failedCompletedAt = Date.now();
    const continuationStop: ParentTurnContinuationStop | null = continuationStopSnapshot
      ? {
          ...continuationStopSnapshot,
          outcome: assistantMessageContent ? 'partial' : 'failed',
        }
      : null;
    if (deferSessionEntryPersistence && userSessionEntryId == null) {
      try {
        userSessionEntryId = recordDeferredSessionEntry(persistedUserMessageContent);
      } catch (recordError) {
        log.warn('Deferred user session entry persistence failed during turn error handling', {
          channelId: message.channelId,
          turnId,
          requestId,
          error: toErrorMessage(recordError),
        });
      }
    }
    // A completed TurnRecord with a background handoff is deliberately written
    // before the Postgres batch. If that batch fails, delivery recovery must
    // replay the manifest; appending a second failed record for the same turn
    // would destroy the source uniqueness gate and make recovery impossible.
    const completedSourceRecordExists = completedTurnRecordState.persisted
      || recoveredSourceRecord !== null;
    if (!completedSourceRecordExists) {
      await runtime.sessionManager.recordTurn(runtime.buildTurnRecord({
        message,
        turnSessionIdentity,
        turnId,
        requestId,
        startedAt: startTime,
        completedAt: failedCompletedAt,
        userSessionEntryId,
        assistantSessionEntryId,
        ...(assistantMessageContent ? { assistantMessageContent } : {}),
        turnMessages: observedFailureTurnMessages,
        status: 'failed',
        ...(continuationStop ? { continuationStop } : {}),
        model: runtime.agent.state.model.id,
        promptMode,
        promptText: fullPrompt,
        contextMessageCount,
        memoryContextChars,
        trustLevel,
        speakerRole,
        canonicalContactKey,
        retrievalProvenanceRefs: observability.getRetrievalProvenanceRefs(),
        ...(persistedUserMessageContent ? { persistedUserMessageContent } : {}),
        ...(turnSnapshot ? { turnSnapshot } : {}),
        turnObservability: {
          stages: observability.getObservedTurnStages(),
          retrievals: observability.getObservedTurnRetrievals(),
          ...(observability.getObservedTurnSnapshot() ? { snapshot: observability.getObservedTurnSnapshot() } : {}),
        },
        ...(internalStateSnapshotRef ? { internalStateSnapshotRef } : {}),
      }, sessionReads));
    }
    if (continuationStop) {
      runtime.emitTelemetry('agent.turn.continuation_stopped', {
        ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.continuation_stopped'),
        turnId,
        requestId,
        channelId: message.channelId,
        stop: continuationStop,
        timestamp: failedCompletedAt,
      });
    }
    await runtime.eventBus.emit('agent.error', {
      message,
      error: err,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.error'),
    });
    throw err;
  } finally {
    observability.unsubscribe();
  }
  } finally {
    if (foregroundLease && abortRunAfterForegroundLoss) {
      foregroundLease.signal.removeEventListener('abort', abortRunAfterForegroundLoss);
    }
    await runtime.endForegroundBackgroundWork(foregroundLease);
  }
  });
}
