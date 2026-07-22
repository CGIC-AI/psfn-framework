import { createHash } from 'node:crypto';
import { createComponentLogger } from '../../shared/logger.js';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import {
  inferComposedDeferredPostTurnActions,
  inferDeferredPostTurnActions as inferDeferredPostTurnActionsFromMessages,
} from '../agent/deferred-post-turn-inference.js';
import { evaluateCompositionalPolicyForChannelId } from '../../system/capabilities/compositional-policy.js';
import {
  IntentionAppraisal,
  INTENTION_FOLLOW_UP_ACTION_KIND,
  INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  INTENTION_REMINDER_ACTION_KIND,
  type IntentionOutboundMessageActionPayload,
  decisionsToPostTurnActionCandidates,
  isBackgroundAppraisalChannel,
  normalizeIntentionFollowUpActionPayload,
  normalizeIntentionOutboundMessageActionPayload,
  normalizeIntentionReminderActionPayload,
  pendingFollowUpsToPostTurnActionCandidates,
  buildPostTurnAppraisalTranscript,
  toInferredPostTurnActions,
} from '../intention/appraisal.js';
import { MotivationBridge } from '../intention/motivation.js';
import { hashString } from '../intention/appraisal/shared.js';
import { fingerprintSocialDesireOutboundAction } from '../intention/social-desire-outreach.js';
import {
  evaluatePendingFollowUpActivationState,
  isPendingFollowUpExpired,
} from '../intention/pending-follow-ups.js';
import { evaluateProactiveOutboundTimeGate } from '../intention/proactive-time-gate.js';
import type { OutreachOutboxAppendInput } from '../intention/outreach-outbox.js';
import { cloneInternalState } from '../self-model/state.js';
import {
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
  POST_TURN_APPRAISAL_RUNTIME_CLASS,
} from '../agent/worker-lanes.js';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import type {
  ReflectionAgent,
  ReflectionRuntimeOptions,
} from './reflection-runtime-contracts.js';
import { resolveIcpOriginRootInitiationId } from '../icp/initiation-lineage.js';
import { DEFERRED_REFLECTION_ACTION_KIND } from './reflection-runtime-contracts.js';
import type { ReflectionTemplateRuntime } from './reflection-template-runtime.js';
import type { Scheduler } from './scheduler.js';
import {
  createSchedulerOwnedPostTurnLanes,
  registerSchedulerOwnedPostTurnLanes,
} from './post-turn-runtime/scheduler-lanes.js';

export {
  CONTACT_TRUST_DRIFT_REVIEW_OPERATION_ID,
  DRIFT_VELOCITY_REVIEW_OPERATION_ID,
  SLEEPTIME_REST_WINDOW_OPERATION_ID,
} from './post-turn-runtime/scheduler-lanes.js';

const log = createComponentLogger('PostTurnRuntime');
export const INTENTION_FOLLOW_UP_ACTIVATION_MIN_INTERVAL_MS = 5 * 60_000;

interface WirePostTurnRuntimeOptions {
  scheduler: Scheduler;
  agentLoop: ReflectionAgent;
  sender: MessageSender;
  templateRuntime: Pick<ReflectionTemplateRuntime, 'runDeferredTemplate'>;
  runtimeOptions?: ReflectionRuntimeOptions;
}

export function wirePostTurnRuntime(
  options: WirePostTurnRuntimeOptions,
): void {
  const {
    scheduler,
    agentLoop,
    templateRuntime,
    runtimeOptions = {},
  } = options;

  if (!runtimeOptions.postTurnActions) {
    return;
  }

  const telemetryEventBus = runtimeOptions.eventBus;
  const lastIntentionFollowUpActivationByChannel = new Map<string, number>();
  // Covers the narrow in-process gap after an external/ICP terminal outcome
  // but before its durable outbox append. Retries finish persistence and
  // settlement without repeating the external side effect.
  const pendingSocialDesireTerminals = new Map<string, {
    record: OutreachOutboxAppendInput;
    disposition: 'sent' | 'terminal_block';
    detail: string;
  }>();
  const shouldUseCompositionalAppraisal = (channelId: string): boolean => (
    evaluateCompositionalPolicyForChannelId({
      policy: runtimeOptions.compositionalPolicy,
      capabilityTier: runtimeOptions.capabilityTier,
      channelId,
      purpose: 'appraisal',
    }).allowed
  );
  const schedulerOwnedLanes = createSchedulerOwnedPostTurnLanes({
    agentLoop,
    runtimeOptions,
  });
  const { nearTurnLane, episodeSynthesisLane } = schedulerOwnedLanes;
  const intentionAppraisalEnabled = runtimeOptions.intentionAppraisalEnabled !== false;
  const intentionAppraisal = (
    intentionAppraisalEnabled
    && runtimeOptions.llmProvider
    && telemetryEventBus
  )
    ? new IntentionAppraisal({
      llmProvider: runtimeOptions.llmProvider,
      ...(runtimeOptions.characterPromptVariablesProvider
        ? { characterPromptVariablesProvider: runtimeOptions.characterPromptVariablesProvider }
        : {}),
      onEvaluationError: (error, context) => {
        log.warn('Intention appraisal failed closed', {
          sessionId: context.sessionId,
          trigger: context.trigger,
          error: String(error),
        });
      },
    })
    : null;
  const intentionSessionsInFlight = new Set<string>();
  const motivationBridge = intentionAppraisal ? new MotivationBridge() : null;

  const resolveMinimumOutboundRunAt = (
    concerns: readonly { dueAt?: number }[] | undefined,
    now: number,
  ): number | undefined => {
    const futureConcernDueTimes = (concerns ?? [])
      .map(concern => concern.dueAt)
      .filter((dueAt): dueAt is number => (
        typeof dueAt === 'number'
        && Number.isFinite(dueAt)
        && dueAt > now
      ));
    return futureConcernDueTimes.length > 0 ? Math.min(...futureConcernDueTimes) : undefined;
  };

  const normalizeConcernIds = (
    concerns: readonly { id?: string }[] | undefined,
  ): string[] => {
    const ids: string[] = [];
    for (const concern of concerns ?? []) {
      const id = concern.id?.trim();
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    }
    return ids;
  };

  const decisionReferencesConcernPressure = (decision: { reason?: string; followUp?: { content?: string } }): boolean => {
    const text = `${decision.reason ?? ''} ${decision.followUp?.content ?? ''}`.toLowerCase();
    return /\bconcerns?\b/.test(text) || /\bopen threads?\b/.test(text) || /\bactive high-priority\b/.test(text);
  };

  const resolveOutboundProvenanceBlockReason = async (
    action: InferredPostTurnAction,
    payload: IntentionOutboundMessageActionPayload,
    options: { durableSocialConsentReplay?: boolean } = {},
  ): Promise<string | undefined> => {
    const hasPendingFollowUpLink = Boolean(payload.pendingFollowUpId);
    const linkedConcernIds = payload.concernIds ?? [];
    const requiresActiveConcern = payload.requiresActiveConcern === true;
    const socialDesire = payload.socialDesire;
    const appraisalFollowUp = payload.appraisalFollowUp;
    const legacyAppraisalDedupe = [
      INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
      action.sourceMessageId,
      hashString(payload.content),
    ].join(':');
    const isAppraisalFollowUp = Boolean(appraisalFollowUp)
      || action.dedupeKey === legacyAppraisalDedupe;

    // The appraisal model may propose external text, but it is not the
    // companion's consent moment. Only the existing exact-action, single-use
    // social-desire consent can ratify that draft for delivery. The dedupe
    // fallback also fail-closes already-queued pre-marker appraisal actions.
    if (isAppraisalFollowUp && !socialDesire) {
      return 'appraisal_consent_required';
    }
    if (
      appraisalFollowUp?.canonicalContactKey
      && socialDesire
      && appraisalFollowUp.canonicalContactKey !== socialDesire.contactId
    ) {
      return 'appraisal_consent_scope_mismatch';
    }

    if (
      !hasPendingFollowUpLink
      && linkedConcernIds.length === 0
      && !requiresActiveConcern
      && !socialDesire
    ) {
      return 'missing_live_provenance';
    }

    if (socialDesire) {
      // Consented social-desire provenance (bead oth4.2). Acceptance requires
      // the desire outbound runtime (wired only when socialDesire.enabled), a
      // LIVE single-use consent from the companion's consent moment, a real
      // durable desire record behind it, and headroom in the tight rate
      // budget. A payload merely claiming this provenance can never pass:
      // consents exist only in the runtime's own ledger.
      const socialDesireRuntime = runtimeOptions.socialDesireOutbound;
      if (!socialDesireRuntime) {
        return 'social_desire_runtime_unavailable';
      }
      if (!runtimeOptions.outreachOutbox) {
        return 'social_desire_outbox_unavailable';
      }
      const nowMs = Date.now();
      if (!options.durableSocialConsentReplay && !socialDesireRuntime.verifyConsent({
        consentId: socialDesire.consentId,
        contactId: socialDesire.contactId,
        nowMs,
        actionId: action.id,
        dedupeKey: action.dedupeKey,
        channelId: payload.channelId,
        channelType: payload.channelType,
        content: payload.content,
        orientation: socialDesire.orientation,
        reason: payload.reason ?? '',
        actionFingerprint: fingerprintSocialDesireOutboundAction(action),
      })) {
        return 'social_desire_consent_invalid';
      }
      if (!(await socialDesireRuntime.hasDesire(socialDesire.contactId))) {
        return 'social_desire_record_missing';
      }
      if (socialDesireRuntime.isBudgetExhausted(nowMs)) {
        return 'social_desire_budget_exhausted';
      }
    }

    if (payload.pendingFollowUpId) {
      if (!runtimeOptions.pendingFollowUpStore) {
        return 'pending_follow_up_unavailable';
      }
      const followUp = await runtimeOptions.pendingFollowUpStore.peek(payload.pendingFollowUpId);
      if (
        !followUp
        || followUp.activatedAt
        || followUp.dampenedAt
        || isPendingFollowUpExpired(followUp, Date.now())
      ) {
        return 'stale_pending_follow_up';
      }
    }

    if (linkedConcernIds.length > 0 || requiresActiveConcern) {
      if (!runtimeOptions.getActiveConcerns) {
        return 'active_concern_unavailable';
      }
      const activeConcerns = await Promise.resolve(runtimeOptions.getActiveConcerns({
        channelId: appraisalFollowUp?.channelId ?? action.channelId,
        ...(appraisalFollowUp?.canonicalContactKey
          ? { canonicalContactKey: appraisalFollowUp.canonicalContactKey }
          : {}),
      }));
      const activeConcernIds = new Set(normalizeConcernIds(activeConcerns));
      if (linkedConcernIds.length > 0) {
        const hasLiveLinkedConcern = linkedConcernIds.some(id => activeConcernIds.has(id));
        if (!hasLiveLinkedConcern) {
          return 'stale_concern';
        }
      } else if (activeConcernIds.size === 0) {
        return 'active_concern_missing';
      }
    }

    return undefined;
  };

  /**
   * Terminal settlement of consented social-desire provenance (bead oth4.2).
   * The single-use consent is spent, and the desire's pressure is released on
   * a successful send or dampened (kept, never released) on a terminal block —
   * so a budget- or policy-blocked desire retries from a fresh consent moment
   * later. Non-terminal outcomes (reschedules, deferred ICP candidates) never
   * settle: the consent stays live for the retry until it expires.
   */
  const settleSocialDesireProvenance = async (
    action: { dedupeKey: string },
    payload: IntentionOutboundMessageActionPayload,
    disposition: 'sent' | 'terminal_block',
    detail: string,
  ): Promise<void> => {
    const socialDesire = payload.socialDesire;
    if (!socialDesire) {
      return;
    }
    const socialDesireRuntime = runtimeOptions.socialDesireOutbound;
    if (!socialDesireRuntime) {
      // The gate already fails closed without the runtime; reaching settlement
      // without it means the gate was bypassed — refuse to continue silently.
      throw new Error('Social desire settlement requires the social desire outbound runtime');
    }
    const nowMs = Date.now();
    const outcome = await socialDesireRuntime.settle({
      settlementId: action.dedupeKey,
      contactId: socialDesire.contactId,
      disposition,
      nowMs,
    });
    if (outcome === 'missing') {
      throw new Error(`Social desire record "${socialDesire.contactId}" was missing at outbound settlement`);
    }
    // Durable settlement is committed before the ephemeral consent is spent.
    // A retry can therefore reconcile an already-settled action safely.
    socialDesireRuntime.consumeConsent(socialDesire.consentId);
    log.info('Social desire outbound settled', {
      contactId: socialDesire.contactId,
      orientation: socialDesire.orientation,
      disposition,
      outcome,
      detail,
    });
  };

  const hashOutreachContent = (content: string): string => (
    createHash('sha256').update(content).digest('hex')
  );

  const emitIntentionFollowUpGateTelemetry = (
    phase: 'blocked' | 'activated',
    detail: Record<string, unknown>,
  ): void => {
    if (!telemetryEventBus) {
      return;
    }
    telemetryEventBus.emit('intention.follow_up.activation_gate', {
      phase,
      ...detail,
      timestamp: Date.now(),
    }).catch((error) => {
      log.warn('Intention follow-up gate telemetry emit failed', {
        error: String(error),
      });
    });
  };

  const isIntentionFollowUpActivationBudgetOpen = (
    channelId: string,
    nowMs: number,
  ): boolean => {
    const lastActivatedAt = lastIntentionFollowUpActivationByChannel.get(channelId);
    if (
      lastActivatedAt !== undefined
      && nowMs - lastActivatedAt < INTENTION_FOLLOW_UP_ACTIVATION_MIN_INTERVAL_MS
    ) {
      log.info('Intention follow-up activation blocked by channel budget', {
        channelId,
        lastActivatedAt,
        nowMs,
        minIntervalMs: INTENTION_FOLLOW_UP_ACTIVATION_MIN_INTERVAL_MS,
      });
      emitIntentionFollowUpGateTelemetry('blocked', {
        reason: 'channel_budget',
        channelId,
        lastActivatedAt,
        nowMs,
        minIntervalMs: INTENTION_FOLLOW_UP_ACTIVATION_MIN_INTERVAL_MS,
      });
      return false;
    }
    return true;
  };

  const resolvePendingFollowUpActivationGate = async (payload: {
    channelId: string;
    pendingFollowUpId?: string;
  }): Promise<boolean> => {
    if (!payload.pendingFollowUpId) {
      return true;
    }
    const nowMs = Date.now();
    if (!runtimeOptions.pendingFollowUpStore) {
      log.warn('Intention follow-up activation blocked because pending store is unavailable', {
        pendingFollowUpId: payload.pendingFollowUpId,
        channelId: payload.channelId,
      });
      emitIntentionFollowUpGateTelemetry('blocked', {
        reason: 'pending_store_unavailable',
        pendingFollowUpId: payload.pendingFollowUpId,
        channelId: payload.channelId,
      });
      return false;
    }
    const followUp = await runtimeOptions.pendingFollowUpStore.peek(payload.pendingFollowUpId);
    if (
      !followUp
      || followUp.activatedAt
      || followUp.dampenedAt
      || isPendingFollowUpExpired(followUp, nowMs)
    ) {
      log.info('Intention follow-up activation blocked by stale pending row', {
        pendingFollowUpId: payload.pendingFollowUpId,
        channelId: payload.channelId,
        missing: !followUp,
        activatedAt: followUp?.activatedAt ?? null,
        dampenedAt: followUp?.dampenedAt ?? null,
      });
      emitIntentionFollowUpGateTelemetry('blocked', {
        reason: 'stale_pending_follow_up',
        pendingFollowUpId: payload.pendingFollowUpId,
        channelId: payload.channelId,
        missing: !followUp,
        activatedAt: followUp?.activatedAt ?? null,
        dampenedAt: followUp?.dampenedAt ?? null,
      });
      return false;
    }
    const linkedCandidateStatus = await runtimeOptions.icpIntentionCandidateAdapter
      ?.getLinkedCandidateStatus(payload.pendingFollowUpId);
    if (linkedCandidateStatus) {
      log.info('Intention follow-up activation blocked by linked ICP candidate', {
        pendingFollowUpId: payload.pendingFollowUpId,
        channelId: payload.channelId,
        candidateStatus: linkedCandidateStatus,
      });
      emitIntentionFollowUpGateTelemetry('blocked', {
        reason: 'linked_icp_candidate',
        pendingFollowUpId: payload.pendingFollowUpId,
        channelId: payload.channelId,
        candidateStatus: linkedCandidateStatus,
      });
      return false;
    }
    const activationState = evaluatePendingFollowUpActivationState(followUp, {
      now: nowMs,
      isBackgroundTurn: isBackgroundAppraisalChannel(payload.channelId),
    });
    if (!activationState.eligibleNow) {
      log.info('Intention follow-up activation blocked because timing/wake is not due', {
        pendingFollowUpId: followUp.id,
        channelId: payload.channelId,
        dueAt: followUp.dueAt ?? null,
        timing: followUp.timing,
        wakeConditions: followUp.wakeConditions ?? [],
      });
      emitIntentionFollowUpGateTelemetry('blocked', {
        reason: 'not_due',
        pendingFollowUpId: followUp.id,
        channelId: payload.channelId,
        dueAt: followUp.dueAt ?? null,
        timing: followUp.timing,
        wakeConditions: followUp.wakeConditions ?? [],
      });
      return false;
    }
    return true;
  };

  const recordOutreachSessionAudit = (
    action: { id: string; dedupeKey: string; sourceMessageId: string },
    payload: IntentionOutboundMessageActionPayload,
    status: 'sent' | 'blocked' | 'failed' | 'skipped',
    detail: string,
  ): void => {
    if (!runtimeOptions.sessionManager?.recordSystemMessage) {
      return;
    }
    try {
      runtimeOptions.sessionManager.recordSystemMessage(
        payload.channelId,
        `[SYSTEM: Outreach Outbox] ${status}: ${detail}`,
        'system:outreach-outbox',
        'Outreach Outbox',
        payload.channelType === 'discord',
        undefined,
        {
          requestId: action.id,
          sourceMessageId: action.sourceMessageId,
          metadata: JSON.stringify({
            type: 'outreach_outbox',
            status,
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            channelId: payload.channelId,
            channelType: payload.channelType,
            detail,
          }),
        },
      );
    } catch (error) {
      log.warn('Outreach session audit write failed', {
        actionId: action.id,
        dedupeKey: action.dedupeKey,
        error: String(error),
      });
    }
  };

  const recordOutreachCompanionMessage = (
    action: { id: string; dedupeKey: string; sourceMessageId: string },
    payload: IntentionOutboundMessageActionPayload,
  ): void => {
    if (!runtimeOptions.sessionManager?.recordAssistantMessage) {
      return;
    }
    try {
      runtimeOptions.sessionManager.recordAssistantMessage(
        payload.channelId,
        payload.content,
        undefined,
        payload.channelType === 'discord',
        undefined,
        {
          sourceMessageId: action.sourceMessageId,
          metadata: JSON.stringify({
            type: 'proactive_outbound_message',
            status: 'sent',
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            channelId: payload.channelId,
            channelType: payload.channelType,
            ...(payload.reason ? { reason: payload.reason } : {}),
          }),
          roleEnvelopePreview: {
            schemaVersion: 1,
            envelopeId: `proactive_outbound:${action.id}`,
            internalRole: 'outreach_candidate',
            summary: payload.reason ?? 'Companion-authored proactive outbound message.',
            sourceStage: 'post_turn_appraisal',
            promotionTarget: 'turn_record_summary',
            promotedRef: `turn_record_summary:${action.id}`,
          },
        },
      );
    } catch (error) {
      log.warn('Outreach companion session write failed', {
        actionId: action.id,
        error: String(error),
      });
    }
  };

  type PostTurnInfererContext = Parameters<PostTurnActionInferer>[0];

  const buildConversationTrajectory = (context: Pick<PostTurnInfererContext, 'message' | 'response'>) => {
    const unresolvedTopics: string[] = [];
    const userText = context.message.content.trim();
    const responseText = context.response.content.trim();
    if (userText.includes('?') && !responseText.endsWith('?')) {
      unresolvedTopics.push(userText.slice(0, 180));
    }

    const summary = `User: ${userText.slice(0, 180)} | Assistant: ${responseText.slice(0, 180)}`;
    return {
      ...(unresolvedTopics.length > 0 ? { unresolvedTopics } : {}),
      summary,
      turnsSinceUserReply: 0,
    };
  };

  const triggerIntentionPostTurnAppraisal = (
    context: Pick<PostTurnInfererContext, 'message' | 'response' | 'canonicalContactKey' | 'completedAt'>,
  ): void => {
    if (!intentionAppraisal || !telemetryEventBus) {
      return;
    }

    const resolvedSessionId = (
      runtimeOptions.sessionManager?.resolveSessionChannelId(context.message.channelId)
      ?? context.message.channelId
    ).trim() || context.message.channelId;

    if (intentionSessionsInFlight.has(resolvedSessionId)) {
      return;
    }
    intentionSessionsInFlight.add(resolvedSessionId);

    void (async () => {
      try {
        const recentSessionEntries = runtimeOptions.sessionManager?.getRecentMessages(resolvedSessionId, 12) ?? [];
        const recentMessages = buildPostTurnAppraisalTranscript({
          recentSessionEntries,
          currentUserMessage: {
            content: context.message.content,
            timestampMs: context.message.timestamp.getTime(),
          },
          currentAssistantReply: context.response.content.trim(),
          nowMs: Date.now(),
        });

        if (context.response.metadata.internalState === undefined) {
          throw new Error('Intention post-turn appraisal requires response.metadata.internalState');
        }
        const internalState = cloneInternalState(context.response.metadata.internalState);
        const currentEmotion = {
          vad: { ...internalState.emotional.vad },
          mood: { ...internalState.emotional.mood },
          discrete: { ...internalState.emotional.discreteEmotions },
          confidence: internalState.emotional.confidence,
        };
        if (runtimeOptions.onBehavioralPatternOutcome) {
          try {
            await runtimeOptions.onBehavioralPatternOutcome({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
              emotionSnapshot: currentEmotion,
              observedAtMs: context.completedAt,
            });
          } catch (error) {
            log.warn('Behavioral pattern outcome hook failed', {
              channelId: context.message.channelId,
              messageId: context.message.id,
              error: String(error),
            });
          }
        }
        const contactEmotionalSnapshot = (
          context.canonicalContactKey
          && runtimeOptions.contactStore?.getEmotionalSnapshot
        )
          ? (await runtimeOptions.contactStore.getEmotionalSnapshot(context.canonicalContactKey)) ?? null
          : null;
        const contactForMotivation = (
          context.canonicalContactKey
          && runtimeOptions.contactStore?.getById
        )
          ? await runtimeOptions.contactStore.getById(context.canonicalContactKey)
          : undefined;
        const isPrimaryContact = contactForMotivation?.trustLevel === 'primary';
        const motivationAssessment = motivationBridge?.assess({
          sessionId: resolvedSessionId,
          currentEmotion,
          emotionTelemetry: internalState.emotional.telemetry,
          contactEmotionalSnapshot,
          isPrimaryContact,
        });
        if (motivationAssessment?.shouldTriggerAppraisal) {
          log.debug('Motivation bridge trigger matched', {
            sessionId: resolvedSessionId,
            profile: motivationAssessment.profile,
            signals: motivationAssessment.signals.map(signal => signal.kind),
            metrics: motivationAssessment.metrics,
          });
        }
        const activeConcerns = runtimeOptions.getActiveConcerns
          ? await Promise.resolve(
            runtimeOptions.getActiveConcerns({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
            }),
          )
          : undefined;
        const recentlyResolvedConcerns = runtimeOptions.getRecentResolvedConcerns
          ? await Promise.resolve(
            runtimeOptions.getRecentResolvedConcerns({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
            }),
          )
          : undefined;
        const originIcpRootInitiationId = resolveIcpOriginRootInitiationId(
          context.message.routing,
        );
        const decisions = await intentionAppraisal.evaluate({
          sessionId: resolvedSessionId,
          ...(context.message.routing?.icpCorrelation
            ? { icpCorrelation: context.message.routing.icpCorrelation }
            : {}),
          internalState,
          currentEmotion,
          recentMessages,
          ...(activeConcerns ? { activeConcerns } : {}),
          ...(recentlyResolvedConcerns ? { recentlyResolvedConcerns } : {}),
          contactEmotionalSnapshot,
          conversationTrajectory: buildConversationTrajectory(context),
          ...(motivationAssessment?.shouldTriggerAppraisal
            ? {
              triggerOverride: 'motivation' as const,
              motivationSignals: motivationAssessment.signals.map(signal => signal.kind),
            }
            : {}),
        });

        if (runtimeOptions.onIntentionConcernDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'concern') continue;
            await runtimeOptions.onIntentionConcernDecision({
              decision,
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
              formationVAD: { ...internalState.emotional.vad },
              ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
            });
          }
        }
        if (runtimeOptions.onIntentionFollowUpDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'followUp') continue;
            const pendingFollowUpId = await runtimeOptions.onIntentionFollowUpDecision({
              decision,
              channelId: resolvedSessionId,
              channelType: context.message.channelType,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
              formationVAD: { ...internalState.emotional.vad },
              ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
            });
            if (pendingFollowUpId) {
              if (!decision.followUp) {
                continue;
              }
              decision.followUp = {
                ...decision.followUp,
                pendingFollowUpId,
              };
            }
          }
        }
        if (runtimeOptions.onIntentionReminderDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'reminder') continue;
            const reminderId = await runtimeOptions.onIntentionReminderDecision({
              decision,
              channelId: resolvedSessionId,
              channelType: context.message.channelType,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
            });
            if (reminderId) {
              if (!decision.reminder) {
                continue;
              }
              decision.reminder = {
                ...decision.reminder,
                reminderId,
              };
            }
          }
        }

        for (const decision of decisions) {
          if (decision.type !== 'followUp' || decision.followUp?.delivery !== 'external') {
            continue;
          }
          const suppliedConcernIds = decision.followUp.concernIds ?? [];
          if (suppliedConcernIds.length === 0 && decisionReferencesConcernPressure(decision)) {
            decision.followUp = {
              ...decision.followUp,
              requiresActiveConcern: true,
            };
          }
        }

        const candidateNow = Date.now();
        const decisionCandidates = decisionsToPostTurnActionCandidates(
          decisions,
          {
            message: context.message,
          },
          {
            now: candidateNow,
            minimumOutboundRunAt: resolveMinimumOutboundRunAt(activeConcerns, candidateNow),
            proactiveOutboundQuietHours: runtimeOptions.episodicProcessingRestWindow,
            appraisalConcernScope: {
              channelId: resolvedSessionId,
              ...(context.canonicalContactKey
                ? { canonicalContactKey: context.canonicalContactKey }
                : {}),
            },
            ...(isBackgroundAppraisalChannel(context.message.channelId)
              ? { surfacePendingFollowUpsImmediately: true }
              : {}),
          },
        );
        const resurfacedPendingFollowUps = runtimeOptions.getPendingFollowUpsForResurfacing
          ? await runtimeOptions.getPendingFollowUpsForResurfacing({
            channelId: resolvedSessionId,
            canonicalContactKey: context.canonicalContactKey,
            sourceMessageId: context.message.id,
            isBackgroundTurn: isBackgroundAppraisalChannel(context.message.channelId),
            now: Date.now(),
            ...(motivationAssessment?.signals.length
              ? {
                motivationSignals: motivationAssessment.signals.map(signal => signal.kind),
              }
              : {}),
            currentMoodValence: currentEmotion.mood.valence,
          })
          : [];
        const candidates = [
          ...decisionCandidates,
          ...pendingFollowUpsToPostTurnActionCandidates(resurfacedPendingFollowUps),
        ];
        if (candidates.length === 0) {
          return;
        }

        const inferredActions = toInferredPostTurnActions(candidates, context.message);
        if (inferredActions.length === 0) {
          return;
        }

        await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
          message: context.message,
          response: context.response,
          actions: inferredActions,
        });
      } catch (error) {
        log.warn('Intention post-turn appraisal dispatch failed', {
          channelId: context.message.channelId,
          messageId: context.message.id,
          error: String(error),
        });
      } finally {
        intentionSessionsInFlight.delete(resolvedSessionId);
      }
    })();
  };

  runtimeOptions.postTurnActions.registerHandler(
    DEFERRED_REFLECTION_ACTION_KIND,
    async (action) => {
      const templateIdRaw = action.payload.templateId;
      if (typeof templateIdRaw !== 'string' || !templateIdRaw.trim()) {
        throw new Error(`Deferred reflection action "${action.id}" is missing payload.templateId`);
      }
      const sendToDiscordOverride = typeof action.payload.sendToDiscordOverride === 'boolean'
        ? action.payload.sendToDiscordOverride
        : undefined;
      await templateRuntime.runDeferredTemplate(templateIdRaw.trim(), {
        ...(sendToDiscordOverride !== undefined ? { sendToDiscordOverride } : {}),
        actionId: action.id,
      });
    },
    {
      runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
    },
  );

  if (intentionAppraisal && agentLoop.followUp) {
      runtimeOptions.postTurnActions.registerHandler(
        INTENTION_FOLLOW_UP_ACTION_KIND,
        async (action) => {
          const payload = normalizeIntentionFollowUpActionPayload(action.payload);
          if (!payload) {
            throw new Error(`Intention follow-up action "${action.id}" payload is missing required fields`);
          }
          const nowMs = Date.now();
          if (!await resolvePendingFollowUpActivationGate(payload)) {
            return;
          }
          if (payload.pendingFollowUpId && !runtimeOptions.onIntentionFollowUpActivated) {
            log.warn('Intention follow-up activation blocked because activation callback is unavailable', {
              pendingFollowUpId: payload.pendingFollowUpId,
              channelId: payload.channelId,
            });
            emitIntentionFollowUpGateTelemetry('blocked', {
              reason: 'activation_callback_unavailable',
              pendingFollowUpId: payload.pendingFollowUpId,
              channelId: payload.channelId,
            });
            return;
          }
          if (!isIntentionFollowUpActivationBudgetOpen(payload.channelId, nowMs)) {
            return;
          }
          if (payload.pendingFollowUpId && runtimeOptions.onIntentionFollowUpActivated) {
            const activated = await runtimeOptions.onIntentionFollowUpActivated({
              pendingFollowUpId: payload.pendingFollowUpId,
              activationReason: 'post_turn_action',
            });
            if (activated === false) {
              log.info('Intention follow-up activation skipped because store activation returned false', {
                pendingFollowUpId: payload.pendingFollowUpId,
                channelId: payload.channelId,
              });
              emitIntentionFollowUpGateTelemetry('blocked', {
                reason: 'activation_store_rejected',
                pendingFollowUpId: payload.pendingFollowUpId,
                channelId: payload.channelId,
              });
              return;
            }
          }
          lastIntentionFollowUpActivationByChannel.set(payload.channelId, nowMs);
          emitIntentionFollowUpGateTelemetry('activated', {
            pendingFollowUpId: payload.pendingFollowUpId ?? null,
            channelId: payload.channelId,
          });
          agentLoop.followUp?.({
            id: `intention-follow-up:${action.id}`,
            channelId: payload.channelId,
            channelType: payload.channelType,
            authorId: payload.authorId,
            authorName: payload.authorName,
            content: payload.content,
            timestamp: new Date(),
            ...(payload.originIcpRootInitiationId
              ? { routing: { originIcpRootInitiationId: payload.originIcpRootInitiationId } }
              : {}),
          });
        },
        {
          executionMode: 'background',
          runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
        },
      );
  }

  if (runtimeOptions.proactiveOutbound || runtimeOptions.icpIntentionCandidateAdapter) {
        const proactiveOutbound = runtimeOptions.proactiveOutbound;
        runtimeOptions.postTurnActions.registerHandler(
          INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
          async (action) => {
            const payload = normalizeIntentionOutboundMessageActionPayload(action.payload);
            if (!payload) {
              throw new Error(`Intention outbound action "${action.id}" payload is missing required fields`);
            }
            const contentHash = hashOutreachContent(payload.content);
            const baseOutboxRecord = {
              actionId: action.id,
              dedupeKey: action.dedupeKey,
              channelId: payload.channelId,
              channelType: payload.channelType,
              sourceMessageId: action.sourceMessageId,
              contentHash,
              contentLength: payload.content.length,
              ...(payload.reason ? { reason: payload.reason } : {}),
              ...(typeof action.runAt === 'number' ? { runAt: action.runAt } : {}),
            };
            const socialDesireBindingHash = payload.socialDesire
              ? fingerprintSocialDesireOutboundAction(action)
              : undefined;
            const persistAndSettleSocialDesireTerminal = async (input: {
              phase: 'sent' | 'blocked' | 'failed';
              disposition: 'sent' | 'terminal_block';
              detail: string;
              reason?: string;
              error?: string;
              metadata?: Record<string, unknown>;
            }): Promise<void> => {
              if (!payload.socialDesire) {
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: input.phase,
                  ...(input.reason ? { reason: input.reason } : {}),
                  ...(input.error ? { error: input.error } : {}),
                  ...(input.metadata ? { metadata: input.metadata } : {}),
                });
                return;
              }
              if (!runtimeOptions.outreachOutbox) {
                throw new Error('Social desire terminal persistence requires a durable outreach outbox');
              }
              const record: OutreachOutboxAppendInput = {
                ...baseOutboxRecord,
                phase: input.phase,
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.error ? { error: input.error } : {}),
                metadata: {
                  ...(input.metadata ?? {}),
                  socialDesireDisposition: input.disposition,
                  socialDesireBindingHash,
                },
              };
              pendingSocialDesireTerminals.set(action.dedupeKey, {
                record,
                disposition: input.disposition,
                detail: input.detail,
              });
              runtimeOptions.outreachOutbox.append(record);
              await settleSocialDesireProvenance(action, payload, input.disposition, input.detail);
              pendingSocialDesireTerminals.delete(action.dedupeKey);
            };
            const reconcileDeliveredIcpPendingFollowUp = async (
              pendingFollowUpId: string,
            ): Promise<void> => {
              if (!runtimeOptions.onIntentionFollowUpActivated) {
                throw new Error('Linked ICP intention requires a follow-up activation callback');
              }
              if (!runtimeOptions.pendingFollowUpStore) {
                throw new Error('Linked ICP intention requires a pending follow-up store');
              }
              const activated = await runtimeOptions.onIntentionFollowUpActivated({
                pendingFollowUpId,
                activationReason: 'icp_candidate_sent',
              });
              if (activated === true) return;
              const followUp = await runtimeOptions.pendingFollowUpStore.peek(pendingFollowUpId);
              if (!followUp?.activatedAt) {
                throw new Error(`Delivered ICP pending follow-up "${pendingFollowUpId}" remained live`);
              }
            };
            const reconcileDampenedIcpPendingFollowUp = async (
              pendingFollowUpId: string,
              dampeningReason: string,
            ): Promise<void> => {
              if (!runtimeOptions.onIntentionFollowUpDampened) {
                throw new Error('Terminal ICP intention requires a follow-up dampening callback');
              }
              if (!runtimeOptions.pendingFollowUpStore) {
                throw new Error('Terminal ICP intention requires a pending follow-up store');
              }
              const dampened = await runtimeOptions.onIntentionFollowUpDampened({
                pendingFollowUpId,
                dampeningReason,
              });
              if (dampened === true) return;
              const followUp = await runtimeOptions.pendingFollowUpStore.peek(pendingFollowUpId);
              if (!followUp?.dampenedAt) {
                throw new Error(`Terminal ICP pending follow-up "${pendingFollowUpId}" remained live`);
              }
            };
            const deliveredIcpCompletion = payload.pendingFollowUpId
              ? runtimeOptions.outreachOutbox?.getIcpDeliveredCompletion(payload.pendingFollowUpId)
              : undefined;
            if (payload.pendingFollowUpId && deliveredIcpCompletion) {
              await reconcileDeliveredIcpPendingFollowUp(payload.pendingFollowUpId);
              runtimeOptions.outreachOutbox?.append({
                ...baseOutboxRecord,
                phase: 'skipped',
                metadata: {
                  skippedReason: 'icp_delivery_reconciled',
                  deliveredActionId: deliveredIcpCompletion.actionId,
                  deliveredRecordedAt: deliveredIcpCompletion.recordedAt,
                },
              });
              return { detail: 'icp_candidate:delivery_reconciled' };
            }
            if (payload.pendingFollowUpId && runtimeOptions.icpIntentionCandidateAdapter) {
              if (!runtimeOptions.onIntentionFollowUpActivated) {
                throw new Error('Linked ICP intention requires a follow-up activation callback');
              }
              if (!runtimeOptions.outreachOutbox) {
                throw new Error('Linked ICP intention requires a durable outreach outbox');
              }
            }
            const pendingSocialTerminal = payload.socialDesire
              ? pendingSocialDesireTerminals.get(action.dedupeKey)
              : undefined;
            if (pendingSocialTerminal) {
              if (!runtimeOptions.outreachOutbox) {
                throw new Error('Social desire terminal reconciliation requires a durable outreach outbox');
              }
              if (pendingSocialTerminal.record.metadata?.socialDesireBindingHash !== socialDesireBindingHash) {
                return { detail: 'blocked:social_desire_consent_invalid' };
              }
              const persistedTerminal = runtimeOptions.outreachOutbox.getTerminal(action.dedupeKey);
              if (persistedTerminal) {
                if (persistedTerminal.actionId !== pendingSocialTerminal.record.actionId
                  || persistedTerminal.phase !== pendingSocialTerminal.record.phase
                  || persistedTerminal.metadata?.socialDesireBindingHash !== socialDesireBindingHash) {
                  return { detail: 'blocked:social_desire_consent_invalid' };
                }
              } else {
                runtimeOptions.outreachOutbox.append(pendingSocialTerminal.record);
              }
              await settleSocialDesireProvenance(
                action,
                payload,
                pendingSocialTerminal.disposition,
                pendingSocialTerminal.detail,
              );
              pendingSocialDesireTerminals.delete(action.dedupeKey);
              const reconciledPhase = pendingSocialTerminal.record.phase;
              return reconciledPhase === 'sent'
                ? { detail: 'sent' }
                : { detail: `blocked:${pendingSocialTerminal.record.reason ?? 'delivery_outcome_ambiguous'}` };
            }
            const terminalRecord = runtimeOptions.outreachOutbox?.getTerminal(action.dedupeKey);
            if (terminalRecord) {
              const disposition = terminalRecord.metadata?.socialDesireDisposition;
              if (payload.socialDesire && (disposition === 'sent' || disposition === 'terminal_block')) {
                if (terminalRecord.metadata?.socialDesireBindingHash !== socialDesireBindingHash) {
                  return { detail: 'blocked:social_desire_consent_invalid' };
                }
                await settleSocialDesireProvenance(
                  action,
                  payload,
                  disposition,
                  `terminal_replay:${terminalRecord.phase}`,
                );
              }
              runtimeOptions.outreachOutbox?.append({
                ...baseOutboxRecord,
                phase: 'skipped',
                metadata: {
                  skippedReason: 'terminal_dedupe_replay',
                  terminalPhase: terminalRecord.phase,
                  terminalRecordedAt: terminalRecord.recordedAt,
                },
              });
              recordOutreachSessionAudit(action, payload, 'skipped', `terminal history already recorded as ${terminalRecord.phase}`);
              return { detail: `skipped:terminal_dedupe:${terminalRecord.phase}` };
            }
            const latestRecord = payload.socialDesire
              ? runtimeOptions.outreachOutbox?.getLatest(action.dedupeKey)
              : undefined;
            const resumingDurableIcpSubmission = latestRecord?.phase === 'dispatching'
              && latestRecord.metadata?.kind === 'social_desire_icp_submission';
            if (latestRecord?.phase === 'dispatching') {
              if (latestRecord.metadata?.socialDesireBindingHash !== socialDesireBindingHash) {
                return { detail: 'blocked:social_desire_consent_invalid' };
              }
              if (!resumingDurableIcpSubmission) {
                await persistAndSettleSocialDesireTerminal({
                  phase: 'blocked',
                  disposition: 'terminal_block',
                  detail: 'delivery_outcome_ambiguous',
                  reason: 'delivery_outcome_ambiguous',
                });
                return { detail: 'blocked:delivery_outcome_ambiguous' };
              }
            }
            runtimeOptions.outreachOutbox?.append({
              ...baseOutboxRecord,
              phase: typeof action.runAt === 'number' && action.runAt > Date.now() ? 'scheduled' : 'queued',
            });
            const provenanceBlockReason = await resolveOutboundProvenanceBlockReason(action, payload, {
              durableSocialConsentReplay: resumingDurableIcpSubmission,
            });
            if (provenanceBlockReason) {
              log.info('Intention outbound action blocked by stale or missing provenance', {
                actionId: action.id,
                channelId: action.channelId,
                reason: provenanceBlockReason,
                pendingFollowUpId: payload.pendingFollowUpId,
                concernIds: payload.concernIds,
                ...(payload.socialDesire
                  ? { socialDesireContactId: payload.socialDesire.contactId }
                  : {}),
              });
              if (provenanceBlockReason === 'social_desire_budget_exhausted') {
                // Rate-budget exhaustion is a terminal block for THIS consent:
                // spend it and dampen (never release) so the desire keeps its
                // pressure and can retry via a later consent moment.
                await persistAndSettleSocialDesireTerminal({
                  phase: 'blocked',
                  disposition: 'terminal_block',
                  detail: provenanceBlockReason,
                  reason: provenanceBlockReason,
                });
              } else {
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: 'blocked',
                  reason: provenanceBlockReason,
                });
              }
              recordOutreachSessionAudit(action, payload, 'blocked', provenanceBlockReason);
              return { detail: `blocked:${provenanceBlockReason}` };
            }
            if (payload.socialDesire && runtimeOptions.icpIntentionCandidateAdapter) {
              runtimeOptions.outreachOutbox?.append({
                ...baseOutboxRecord,
                phase: 'dispatching',
                metadata: { kind: 'social_desire_icp_submission', socialDesireBindingHash },
              });
            }
            const icpCandidate = runtimeOptions.icpIntentionCandidateAdapter
              ? await runtimeOptions.icpIntentionCandidateAdapter.submit({ action, payload })
              : { kind: 'not_companion' as const };
            if (icpCandidate.kind === 'blocked') {
              await persistAndSettleSocialDesireTerminal({
                phase: 'blocked',
                disposition: 'terminal_block',
                detail: icpCandidate.reason,
                reason: icpCandidate.reason,
              });
              recordOutreachSessionAudit(action, payload, 'blocked', icpCandidate.reason);
              return { detail: `blocked:${icpCandidate.reason}` };
            }
            if (icpCandidate.kind === 'submitted') {
              const pendingFollowUpId = payload.pendingFollowUpId;
              const isLinkedPendingFollowUp = pendingFollowUpId !== undefined
                && icpCandidate.result.pendingFollowUpId === pendingFollowUpId;
              if (isLinkedPendingFollowUp
                && icpCandidate.result.status === 'consumed'
                && icpCandidate.result.deliveryDisposition === 'delivered') {
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: 'sent',
                  metadata: {
                    kind: 'icp_candidate_delivery',
                    disposition: 'delivered',
                    pendingFollowUpId,
                    candidateId: icpCandidate.result.candidateId,
                    candidateStatus: icpCandidate.result.status,
                  },
                });
                await reconcileDeliveredIcpPendingFollowUp(pendingFollowUpId);
              } else if (isLinkedPendingFollowUp
                && icpCandidate.result.status === 'consumed'
                && icpCandidate.result.deliveryDisposition === 'suppressed') {
                await reconcileDampenedIcpPendingFollowUp(
                  pendingFollowUpId,
                  'icp_candidate_suppressed',
                );
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: 'blocked',
                  reason: 'icp_candidate_suppressed',
                  metadata: {
                    kind: 'icp_candidate_delivery',
                    disposition: 'suppressed',
                    pendingFollowUpId,
                    candidateId: icpCandidate.result.candidateId,
                    candidateStatus: icpCandidate.result.status,
                  },
                });
                recordOutreachSessionAudit(action, payload, 'blocked', 'icp_candidate_suppressed');
              } else if (isLinkedPendingFollowUp
                && (icpCandidate.result.status === 'declined'
                  || icpCandidate.result.status === 'cancelled'
                  || icpCandidate.result.status === 'expired'
                  || icpCandidate.result.status === 'rejected')) {
                const dampeningReason = icpCandidate.result.status === 'declined'
                  ? 'icp_candidate_declined'
                  : icpCandidate.result.status === 'cancelled'
                    ? 'icp_candidate_retry_exhausted'
                    : `icp_candidate_${icpCandidate.result.status}`;
                await reconcileDampenedIcpPendingFollowUp(pendingFollowUpId, dampeningReason);
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: 'blocked',
                  reason: dampeningReason,
                  metadata: {
                    kind: 'icp_candidate_terminal_disposition',
                    pendingFollowUpId,
                    candidateId: icpCandidate.result.candidateId,
                    candidateStatus: icpCandidate.result.status,
                  },
                });
                recordOutreachSessionAudit(action, payload, 'blocked', dampeningReason);
              }
              if (payload.socialDesire) {
                // Companion-target social desire (bead oth4.2): the consent
                // moment already happened; the candidate rides the existing
                // ICP defer/retry semantics. Terminal candidate dispositions
                // settle the consent here; deferred keeps it live for the
                // durable retry below.
                const candidateStatus = icpCandidate.result.status;
                if (candidateStatus === 'consumed' || candidateStatus === 'permitted') {
                  if (icpCandidate.result.deliveryDisposition === 'suppressed') {
                    await persistAndSettleSocialDesireTerminal({
                      phase: 'blocked',
                      disposition: 'terminal_block',
                      detail: 'icp_candidate_suppressed',
                      reason: 'icp_candidate_suppressed',
                      metadata: {
                        kind: 'social_desire_icp_disposition',
                        candidateId: icpCandidate.result.candidateId,
                        candidateStatus,
                      },
                    });
                    recordOutreachSessionAudit(action, payload, 'blocked', 'icp_candidate_suppressed');
                  } else {
                    // Durable 'sent' record: the desire-outreach rate budget
                    // counts ICP-path sends exactly like human-path sends.
                    await persistAndSettleSocialDesireTerminal({
                      phase: 'sent',
                      disposition: 'sent',
                      detail: `icp_candidate_${candidateStatus}`,
                      metadata: {
                        kind: 'social_desire_icp_delivery',
                        candidateId: icpCandidate.result.candidateId,
                        candidateStatus,
                      },
                    });
                    recordOutreachSessionAudit(action, payload, 'sent', `icp_candidate_${candidateStatus}`);
                  }
                } else if (
                  candidateStatus === 'declined'
                  || candidateStatus === 'rejected'
                  || candidateStatus === 'expired'
                  || candidateStatus === 'cancelled'
                ) {
                  const socialDesireBlockReason = `icp_candidate_${candidateStatus}`;
                  await persistAndSettleSocialDesireTerminal({
                    phase: 'blocked',
                    disposition: 'terminal_block',
                    detail: socialDesireBlockReason,
                    reason: socialDesireBlockReason,
                    metadata: {
                      kind: 'social_desire_icp_disposition',
                      candidateId: icpCandidate.result.candidateId,
                      candidateStatus,
                    },
                  });
                  recordOutreachSessionAudit(action, payload, 'blocked', socialDesireBlockReason);
                }
              }
              const handlerResult = {
                detail: `icp_candidate:${icpCandidate.result.outcome}:${icpCandidate.result.status}`,
              };
              if (icpCandidate.result.status !== 'deferred') {
                return handlerResult;
              }
              if (icpCandidate.result.retryEligibleAtMs === undefined) {
                throw new Error('Deferred ICP intention candidate has no durable retry eligibility');
              }
              if (payload.socialDesire) {
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: 'scheduled',
                  reason: 'icp_candidate_deferred',
                  runAt: icpCandidate.result.retryEligibleAtMs,
                });
              }
              return {
                ...handlerResult,
                rescheduleAt: icpCandidate.result.retryEligibleAtMs,
              };
            }
            if (!proactiveOutbound) {
              throw new Error('Intention outbound action has no applicable delivery runtime');
            }
            if (payload.socialDesire) {
              const policyDecision = runtimeOptions.socialDesireHumanDeliveryPolicy
                ? await runtimeOptions.socialDesireHumanDeliveryPolicy.evaluate({
                    contactId: payload.socialDesire.contactId,
                    channelId: payload.channelId,
                    channelType: payload.channelType,
                    nowMs: Date.now(),
                    ...(typeof action.runAt === 'number' ? { earliestSendAtMs: action.runAt } : {}),
                  })
                : { allowed: false as const, reason: 'social_desire_human_policy_unavailable' };
              if (!policyDecision.allowed) {
                if (policyDecision.rescheduleAt !== undefined) {
                  runtimeOptions.outreachOutbox?.append({
                    ...baseOutboxRecord,
                    phase: 'scheduled',
                    reason: policyDecision.reason,
                    runAt: policyDecision.rescheduleAt,
                  });
                  return {
                    detail: policyDecision.reason,
                    rescheduleAt: policyDecision.rescheduleAt,
                  };
                }
                await persistAndSettleSocialDesireTerminal({
                  phase: 'blocked',
                  disposition: 'terminal_block',
                  detail: policyDecision.reason,
                  reason: policyDecision.reason,
                });
                return { detail: `blocked:${policyDecision.reason}` };
              }
            } else {
              // Evaluate quiet hours in the recipient's timezone when resolvable
              // (2tli); fall back to the global window otherwise.
              const contactTimeZone = runtimeOptions.resolveContactTimeZone
                ? await runtimeOptions.resolveContactTimeZone(payload.channelId)
                : null;
              const timeGate = evaluateProactiveOutboundTimeGate({
                nowMs: Date.now(),
                earliestSendAtMs: action.runAt,
                quietHours: runtimeOptions.episodicProcessingRestWindow,
                contactTimeZone,
              });
              if (!timeGate.allowed) {
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: 'scheduled',
                  reason: timeGate.reason,
                  runAt: timeGate.nextEligibleAtMs,
                });
                return {
                  detail: timeGate.reason,
                  rescheduleAt: timeGate.nextEligibleAtMs,
                };
              }
            }
            if (payload.socialDesire) {
              runtimeOptions.outreachOutbox?.append({
                ...baseOutboxRecord,
                phase: 'dispatching',
                metadata: { kind: 'social_desire_human_dispatch', socialDesireBindingHash },
              });
            }
            let dispatchResult: Awaited<ReturnType<typeof proactiveOutbound.dispatch>>;
            try {
              dispatchResult = await proactiveOutbound.dispatch({
                actionId: action.id,
                channelId: payload.channelId,
                channelType: payload.channelType,
                content: payload.content,
                ...(payload.reason ? { reason: payload.reason } : {}),
              });
            } catch (error) {
              if (payload.socialDesire) {
                await persistAndSettleSocialDesireTerminal({
                  phase: 'failed',
                  disposition: 'terminal_block',
                  detail: 'delivery_outcome_ambiguous',
                  error: String(error),
                  metadata: { failureReason: 'delivery_outcome_ambiguous' },
                });
              } else {
                runtimeOptions.outreachOutbox?.append({
                  ...baseOutboxRecord,
                  phase: 'failed',
                  error: String(error),
                });
              }
              recordOutreachSessionAudit(action, payload, 'failed', String(error));
              throw error;
            }
            if (
              dispatchResult.outcome === 'blocked'
              && dispatchResult.reason === 'rate_limited'
              && typeof dispatchResult.retryAfterMs === 'number'
              && Number.isFinite(dispatchResult.retryAfterMs)
              && dispatchResult.retryAfterMs > 0
            ) {
              runtimeOptions.outreachOutbox?.append({
                ...baseOutboxRecord,
                phase: 'scheduled',
                reason: 'rate_limited',
                runAt: Date.now() + dispatchResult.retryAfterMs,
              });
              return {
                detail: 'rate_limited',
                rescheduleAt: Date.now() + dispatchResult.retryAfterMs,
              };
            }
            await persistAndSettleSocialDesireTerminal({
              phase: dispatchResult.outcome === 'sent' ? 'sent' : 'blocked',
              disposition: dispatchResult.outcome === 'sent' ? 'sent' : 'terminal_block',
              detail: dispatchResult.outcome === 'sent' ? 'dispatched' : dispatchResult.reason,
              ...(dispatchResult.outcome === 'blocked' ? { reason: dispatchResult.reason } : {}),
            });
            if (dispatchResult.outcome === 'sent') {
              recordOutreachCompanionMessage(action, payload);
            }
            recordOutreachSessionAudit(
              action,
              payload,
              dispatchResult.outcome === 'sent' ? 'sent' : 'blocked',
              dispatchResult.outcome === 'sent' ? 'sent' : dispatchResult.reason,
            );
            return dispatchResult.outcome === 'sent'
              ? { detail: 'sent' }
              : { detail: `blocked:${dispatchResult.reason}` };
          },
          {
            executionMode: 'background',
            runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
          },
        );
  }

  if (intentionAppraisal && agentLoop.followUp) {
      runtimeOptions.postTurnActions.registerHandler(
        INTENTION_REMINDER_ACTION_KIND,
        async (action) => {
          const payload = normalizeIntentionReminderActionPayload(action.payload);
          if (!payload) {
            throw new Error(`Intention reminder action "${action.id}" payload is missing required fields`);
          }
          if (!runtimeOptions.onIntentionReminderTriggered) {
            throw new Error('Intention reminder action triggered without reminder substrate wiring');
          }
          const triggered = await runtimeOptions.onIntentionReminderTriggered({
            reminderId: payload.reminderId,
          });
          if (!triggered) {
            return;
          }
          if (triggered.nextDueAt && telemetryEventBus) {
            const nextRunAt = Date.parse(triggered.nextDueAt);
            if (Number.isFinite(nextRunAt) && nextRunAt > 0) {
              const nextActions = toInferredPostTurnActions([{
                kind: INTENTION_REMINDER_ACTION_KIND,
                dedupeKey: `${INTENTION_REMINDER_ACTION_KIND}:${triggered.reminderId}:${nextRunAt}`,
                payload: {
                  reminderId: triggered.reminderId,
                },
                maxRetries: 1,
                runAt: nextRunAt,
              }], {
                id: action.id,
                channelId: action.channelId,
              });
              if (nextActions.length > 0) {
                await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
                  message: {
                    id: action.id,
                    channelId: action.channelId,
                    channelType: triggered.channelType,
                    authorId: triggered.authorId,
                    authorName: triggered.authorName,
                    content: triggered.content,
                    timestamp: new Date(),
                  },
                  response: {
                    content: triggered.content,
                    channelId: action.channelId,
                    metadata: {
                      model: 'scheduler:reminder-reschedule',
                      inputTokens: 0,
                      outputTokens: 0,
                      durationMs: 0,
                    },
                  },
                  actions: nextActions,
                });
              }
            }
          }
          agentLoop.followUp?.({
            id: `intention-reminder:${action.id}`,
            channelId: triggered.channelId,
            channelType: triggered.channelType,
            authorId: triggered.authorId,
            authorName: triggered.authorName,
            content: triggered.content,
            timestamp: new Date(),
          });
        },
        {
          executionMode: 'background',
          runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
        },
      );
  }
  if (intentionAppraisal && !agentLoop.followUp) {
    log.warn('Intention appraisal enabled but followUp hook is unavailable on agent loop');
  }

  registerSchedulerOwnedPostTurnLanes({
    agentLoop,
    scheduler,
    runtimeOptions,
    lanes: schedulerOwnedLanes,
    postTurnActions: runtimeOptions.postTurnActions,
  });

  if (agentLoop.registerPostTurnActionInferer) {
    const inferDeferredPostTurnActions: PostTurnActionInferer = async ({
      message,
      response,
      turnMessages,
      canonicalContactKey,
    }) => {
      const inferred = shouldUseCompositionalAppraisal(message.channelId)
        ? await inferComposedDeferredPostTurnActions({
          message,
          turnMessages,
          deferredReflectionActionKind: DEFERRED_REFLECTION_ACTION_KIND,
        })
        : inferDeferredPostTurnActionsFromMessages({
          message,
          turnMessages,
          deferredReflectionActionKind: DEFERRED_REFLECTION_ACTION_KIND,
        });
      // Heavy sleeptime work is intentionally absent here: no code path from
      // turn cadence may reach consolidation, arc weaving, or the dream pass.
      if (nearTurnLane) {
        inferred.push(...await nearTurnLane.inferPostTurnActions({ message }));
      }
      if (episodeSynthesisLane) {
        const thresholdAction = episodeSynthesisLane.noteTurn(message);
        if (thresholdAction) {
          inferred.push(thresholdAction);
        }
      }
      triggerIntentionPostTurnAppraisal({
        message,
        response,
        canonicalContactKey,
        completedAt: Date.now(),
      });
      return inferred;
    };
    agentLoop.registerPostTurnActionInferer(inferDeferredPostTurnActions);
  } else {
    log.warn('Post-turn action runtime enabled but inferer registration is unavailable');
  }
}
