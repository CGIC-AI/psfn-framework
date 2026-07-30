// ── Post-turn outbound provenance + activation gates (charter 12.1 split, emh3p.4) ──
// Extracted from post-turn-runtime.ts's wirePostTurnRuntime closure block.
// The gates below decide whether an inferred outbound action has live
// provenance (consent / pending row / concern), settle social-desire
// provenance terminally, and record the outreach audit + companion session
// writes. All fail closed; nothing here creates conversational speech.

import { createHash } from 'node:crypto';
import { createComponentLogger } from '../../shared/logger.js';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import {
  isBackgroundAppraisalChannel,
  type IntentionOutboundMessageActionPayload,
} from '../intention/appraisal.js';
import { resolveAppraisalOutboundProvenance } from '../intention/appraisal/outbound-provenance.js';
import { fingerprintSocialDesireOutboundAction } from '../intention/social-desire-outreach.js';
import {
  evaluatePendingFollowUpActivationState,
  isPendingFollowUpExpired,
} from '../intention/pending-follow-ups.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { ReflectionRuntimeOptions } from './reflection-runtime-contracts.js';

export const INTENTION_FOLLOW_UP_ACTIVATION_MIN_INTERVAL_MS = 5 * 60_000;

const log = createComponentLogger('PostTurnOutboundGates');

export interface PostTurnOutboundGatesDeps {
  runtimeOptions: ReflectionRuntimeOptions;
  telemetryEventBus: EventBus | undefined;
  lastIntentionFollowUpActivationByChannel: Map<string, number>;
}

export function createPostTurnOutboundGates(deps: PostTurnOutboundGatesDeps) {
  const { runtimeOptions, telemetryEventBus, lastIntentionFollowUpActivationByChannel } = deps;

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

  const resolveOutboundProvenanceBlockReason = async (
    action: InferredPostTurnAction,
    payload: IntentionOutboundMessageActionPayload,
    options: { durableSocialConsentReplay?: boolean } = {},
  ): Promise<string | undefined> => {
    const hasPendingFollowUpLink = Boolean(payload.pendingFollowUpId);
    const linkedConcernIds = payload.concernIds ?? [];
    const requiresActiveConcern = payload.requiresActiveConcern === true;
    const socialDesire = payload.socialDesire;
    const appraisalProvenance = resolveAppraisalOutboundProvenance(action, payload);
    if (appraisalProvenance.blockReason) {
      return appraisalProvenance.blockReason;
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
      const activeConcerns = await Promise.resolve(
        runtimeOptions.getActiveConcerns(appraisalProvenance.concernScope),
      );
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

  return {
    resolveOutboundProvenanceBlockReason,
    settleSocialDesireProvenance,
    hashOutreachContent,
    emitIntentionFollowUpGateTelemetry,
    isIntentionFollowUpActivationBudgetOpen,
    resolvePendingFollowUpActivationGate,
    recordOutreachSessionAudit,
    recordOutreachCompanionMessage,
  };
}
