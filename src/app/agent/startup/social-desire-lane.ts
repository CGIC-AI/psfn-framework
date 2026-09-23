// ── Social-desire consent-moment lane (epic oth4, bead oth4.2) ──
// Extracted from agent/main.ts (charter 12.1 god-file split, emh3p.1).
// Per-contact durable desire crossing threshold -> the companion's own fresh
// outreach turn in that contact's dedicated channel (vcq8v.4): she writes the
// message, says later, or says nothing. Accepted consents carry
// social-desire provenance through the EXISTING outbound provenance gate,
// durable outbox, ICP candidate broker, and ProactiveOutboundDispatcher —
// under a tight desire-outbound rate budget. Fail closed: with
// socialDesire.enabled false disables that producer and its consent runtime.
// The shared human delivery policy also serves independently enabled EmoSim
// outreach and remains available when an approved heartbeat channel exists.

import type { Logger } from 'winston';
import { CanonicalCompanionPeerValidationError, type AgentFacingIcpAutonomyRuntime } from '../../../core/icp/agent-facing-autonomy.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { SocialImpulseDesireTarget } from '../../../core/emotion/social-impulse-outreach.js';
import { createSocialOutreachTurnEvaluator } from '../../../core/intention/social-outreach-turn/evaluator.js';
import type { SocialOutreachContextPorts } from '../../../core/intention/social-outreach-turn/context.js';
import type { SocialOutreachDraftRegistry } from '../../../core/intention/social-outreach-turn/drafts.js';
import type { ConcernFollowUpOutreachDeps } from '../../../core/intention/concern-follow-up-outreach.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime-base.js';
import {
  createSocialDesireFeltSignalWriter,
  type SocialDesireFeltSignalWriter,
} from '../../../core/intention/social-desire-felt-signal.js';
import { createContactSocialDesireTierSource } from '../../../core/intention/social-desire-store-port.js';
import {
  createSocialDesireConsentLedger,
  createSocialDesireOutboundRuntime,
  isSocialDesireContactPaced,
  type SocialDesireDeliveryChannel,
  type SocialDesireOutboundRuntime,
} from '../../../core/intention/social-desire-outreach.js';
import {
  createSocialDesireHumanDeliveryPolicy,
  type SocialDesireHumanDeliveryPolicy,
} from '../../../core/intention/social-desire-human-policy.js';
import type { OutreachOutboxStore } from '../../../core/intention/outreach-outbox.js';
import { registerSocialDesireOutreachTask } from '../../../core/scheduler/social-desire-outreach-lane.js';
import { createSocialDesireEvaluationQueue } from '../social-impulse-outreach-queue.js';
import { resolvePrimaryContactOutreachIdentity } from '../social-outreach-context.js';
import { composeCompanionDmChannelId } from '../../../shared/contracts/companion-channels.js';
import type { ChannelType } from '../../../shared/contracts/runtime.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import type { SchedulerRuntimeConfig as SchedulerConfig } from '../../../system/config/scheduler-config.js';
import type { AgentSchedulerRuntime } from '../scheduler-runtime.js';
import type { createAgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';

export interface SocialDesireLaneDeps {
  /** Narrowed to the fields the lane consumes (testable without a full config). */
  schedulerConfig: Pick<SchedulerConfig, 'socialDesire' | 'episodicProcessing'>;
  scheduler: AgentSchedulerRuntime['scheduler'];
  postTurnActions: Pick<AgentSchedulerRuntime['postTurnActions'], 'enqueue' | 'registerHandler'>;
  eventBus: EventBus;
  log: Logger;
  socialDesireStore: Awaited<ReturnType<typeof createAgentPersistenceRuntime>>['socialDesireStore'];
  /** Narrowed to the desire-budget read the lane performs. */
  outreachOutbox: Pick<OutreachOutboxStore, 'countSentSince'>;
  heartbeatChannel: { channelId: string; channelType: ChannelType } | undefined;
  /** Narrowed to the single read the lane performs (testable without a full port). */
  contactStore: Pick<ContactStorePort, 'getById'>;
  icpPeers: AgentFacingIcpAutonomyRuntime | undefined;
  localCompanionId: string | undefined;
  /** Runs the companion's persona-loaded outreach turn (the agent loop). */
  turns: { handleMessage(message: SubstrateMessage): Promise<unknown> };
  sessions: SocialOutreachContextPorts['sessions'];
  readEmotion: SocialOutreachContextPorts['readEmotion'];
  /** Live answer slots shared with the notify tool (outreach_send / outreach_later). */
  drafts: SocialOutreachDraftRegistry;
  /** Due concerns about a contact follow up through the same per-contact turn (vcq8v.5). */
  concernStore: ConcernFollowUpOutreachDeps['concerns'];
  companionName: string;
  /**
   * Composes the accumulation writer into the emotion/appraisal felt-signal
   * path (psfn-framework-hrmrq.85). REQUIRED: an enabled social-desire lane
   * without a felt-signal producer is a consent-moment scheduler over a store
   * nothing can write — registration throws rather than boot that lie.
   */
  attachFeltSignalWriter: (writer: SocialDesireFeltSignalWriter) => void;
}

export interface SocialDesireLaneResult {
  socialDesireOutbound: SocialDesireOutboundRuntime | undefined;
  socialDesireHumanDeliveryPolicy: SocialDesireHumanDeliveryPolicy | undefined;
  /** The composed accumulation writer; undefined only when the lane is disabled. */
  socialDesireFeltSignals: SocialDesireFeltSignalWriter | undefined;
  /** Where a felt EmoSim impulse adds per-contact pressure; undefined when disabled. */
  impulseTarget: SocialImpulseDesireTarget | undefined;
}

export function registerSocialDesireLane(deps: SocialDesireLaneDeps): SocialDesireLaneResult {
  const {
    schedulerConfig,
    scheduler,
    postTurnActions,
    eventBus,
    log,
    socialDesireStore,
    outreachOutbox,
    heartbeatChannel,
    contactStore,
    icpPeers,
    localCompanionId,
    companionName,
  } = deps;

  let socialDesireOutbound: SocialDesireOutboundRuntime | undefined;
  const socialDesireHumanDeliveryPolicy = heartbeatChannel
    ? createSocialDesireHumanDeliveryPolicy({
        contacts: contactStore,
        approvedHeartbeatChannel: heartbeatChannel,
        quietHours: schedulerConfig.episodicProcessing,
      })
    : undefined;
  let socialDesireFeltSignals: SocialDesireFeltSignalWriter | undefined;
  let impulseTarget: SocialImpulseDesireTarget | undefined;
  if (schedulerConfig.socialDesire.enabled) {
    if (!socialDesireStore) {
      // Fail closed (psfn-framework-hrmrq.85): an enabled lane without its
      // durable store would silently register nothing and report itself
      // healthy. Boot must refuse the contradiction instead.
      throw new Error(
        'scheduler.json socialDesire.enabled is true but no social-desire store is composed; '
        + 'refusing to boot a consent-moment lane whose pressure can never accumulate',
      );
    } else {
      // Accumulation writer (hrmrq.85): the ONLY production producer for the
      // social-desire store, threaded into the post-turn emotion-appraisal
      // path by the composition callback. The required callback makes
      // "enabled lane with no writer composed" unrepresentable at boot.
      socialDesireFeltSignals = createSocialDesireFeltSignalWriter({
        store: socialDesireStore,
        tierSource: createContactSocialDesireTierSource(contactStore),
        lifecycle: schedulerConfig.socialDesire.lifecycle,
      });
      deps.attachFeltSignalWriter(socialDesireFeltSignals);
      log.info('Social-desire felt-signal writer composed into the emotion/appraisal path');
      const socialDesireConsents = createSocialDesireConsentLedger({
        ttlMs: schedulerConfig.socialDesire.outreach.consentTtlMs,
      });
      socialDesireOutbound = createSocialDesireOutboundRuntime({
        store: socialDesireStore,
        lifecycle: schedulerConfig.socialDesire.lifecycle,
        consents: socialDesireConsents,
        budget: schedulerConfig.socialDesire.outreach.budget,
        // Budget counts durable desire-tagged sends from the outreach outbox —
        // enforcement lives at the dispatch layer and survives restart.
        countRecentSends: sinceMs => outreachOutbox.countSentSince({
          sinceMs,
          reasonPrefix: 'social_desire',
        }),
      });
      const budgetGuard = socialDesireOutbound;
      const consentEvaluator = createSocialOutreachTurnEvaluator({
        turns: deps.turns,
        drafts: deps.drafts,
        companionName,
        context: {
          contacts: contactStore,
          sessions: deps.sessions,
          readEmotion: deps.readEmotion,
          limits: schedulerConfig.socialDesire.outreach.turnContext,
        },
      });
      // Fail-closed delivery-channel policy: companion peers route to
      // their canonical companion DM (ICP candidate path); humans deliver
      // only to the primary contact's approved heartbeat DM. Anything
      // else has no channel — no consent moment, desire keeps pressure.
      const resolveDeliveryChannel = async (contactId: string): Promise<SocialDesireDeliveryChannel | null> => {
        const contact = await contactStore.getById(contactId);
        if (!contact) return null;
        if (contact.isMachineIntelligence) {
          if (!icpPeers || !localCompanionId) return null;
          try {
            const peer = await icpPeers.resolveKnownPeer(contactId);
            return {
              channelId: composeCompanionDmChannelId(
                createCompanionId(localCompanionId, 'social-desire local companion'),
                createCompanionId(peer.peerCompanionId, 'social-desire peer companion'),
              ),
              channelType: 'companion',
              contactName: contact.displayName,
              companionTarget: true,
            };
          } catch (error) {
            if (error instanceof CanonicalCompanionPeerValidationError) return null;
            throw error;
          }
        }
        if (contact.trustLevel !== 'primary' || !heartbeatChannel) return null;
        // The heartbeat channel must be this person's own direct messages (PR #609).
        if (!resolvePrimaryContactOutreachIdentity(deps.sessions, contact, heartbeatChannel.channelId)) return null;
        return {
          channelId: heartbeatChannel.channelId,
          channelType: heartbeatChannel.channelType,
          contactName: contact.displayName,
          companionTarget: false,
        };
      };
      const resolveContactTimeZone = async (contactId: string): Promise<string | null> => (
        (await contactStore.getById(contactId))?.timezone ?? null
      );
      const outreachTask = registerSocialDesireOutreachTask({
        scheduler,
        eventBus,
        postTurnActions,
        config: schedulerConfig.socialDesire,
        concernFollowUps: {
          concerns: deps.concernStore,
          consentEvaluator,
          resolveDeliveryChannel,
          quietHours: schedulerConfig.episodicProcessing,
          resolveContactTimeZone,
          deferDelayMs: schedulerConfig.socialDesire.outreach.contactPacing.deferDelayMs,
          maxPerRun: schedulerConfig.socialDesire.outreach.maxConsentMomentsPerRun,
          // Shares the desire row's cooldown anchor when one exists; a concern
          // never creates a desire (carved invariant), so no row = no anchor.
          pacing: {
            isPaced: async (contactId, nowMs) => {
              const desire = await socialDesireStore.getByContactId(contactId);
              return desire !== null && isSocialDesireContactPaced(
                desire,
                schedulerConfig.socialDesire.outreach.contactPacing,
                nowMs,
              );
            },
            markAsked: async (contactId, nowMs) => {
              const desire = await socialDesireStore.getByContactId(contactId);
              if (desire) await socialDesireStore.save({ ...desire, lastConsentMomentAt: new Date(nowMs).toISOString() });
            },
          },
        },
        deps: {
          store: socialDesireStore,
          lifecycle: schedulerConfig.socialDesire.lifecycle,
          tierSource: createContactSocialDesireTierSource(contactStore),
          consentEvaluator,
          consents: socialDesireConsents,
          maxConsentMomentsPerRun: schedulerConfig.socialDesire.outreach.maxConsentMomentsPerRun,
          contactPacing: schedulerConfig.socialDesire.outreach.contactPacing,
          quietHours: schedulerConfig.episodicProcessing,
          resolveContactTimeZone,
          resolveDeliveryChannel,
          isBudgetExhausted: (nowMs, reservedConsentCount) => (
            budgetGuard.isBudgetExhausted(nowMs, reservedConsentCount)
          ),
        },
      });
      if (!outreachTask) {
        throw new Error('scheduler.json socialDesire.enabled is true but the outreach task did not register');
      }
      const evaluationQueue = createSocialDesireEvaluationQueue({
        actions: postTurnActions,
        evaluate: () => outreachTask.runNow(),
      });
      impulseTarget = {
        store: socialDesireStore,
        lifecycle: schedulerConfig.socialDesire.lifecycle,
        gain: schedulerConfig.socialDesire.impulse.gain,
        requestEvaluation: evaluationQueue.request,
      };
    }
  }
  return { socialDesireOutbound, socialDesireHumanDeliveryPolicy, socialDesireFeltSignals, impulseTarget };
}
