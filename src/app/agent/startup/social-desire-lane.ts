// ── Social-desire consent-moment lane (epic oth4, bead oth4.2) ──
// Extracted from agent/main.ts (charter 12.1 god-file split, emh3p.1).
// Per-contact durable desire crossing threshold -> companion consent moment
// (message / defer / decline — never auto-send). Accepted consents carry
// social-desire provenance through the EXISTING outbound provenance gate,
// durable outbox, ICP candidate broker, and ProactiveOutboundDispatcher —
// under a tight desire-outbound rate budget. Fail closed: with
// socialDesire.enabled false (or a missing store) nothing is wired, so the
// gate rejects any social-desire provenance outright.

import type { Logger } from 'winston';
import { CanonicalCompanionPeerValidationError, type AgentFacingIcpAutonomyRuntime } from '../../../core/icp/agent-facing-autonomy.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { createLlmSocialDesireConsentEvaluator } from '../../../core/intention/social-desire-consent-evaluator.js';
import { createContactSocialDesireTierSource } from '../../../core/intention/social-desire-store-port.js';
import {
  createSocialDesireConsentLedger,
  createSocialDesireOutboundRuntime,
  type SocialDesireDeliveryChannel,
  type SocialDesireOutboundRuntime,
} from '../../../core/intention/social-desire-outreach.js';
import {
  createSocialDesireHumanDeliveryPolicy,
  type SocialDesireHumanDeliveryPolicy,
} from '../../../core/intention/social-desire-human-policy.js';
import type { OutreachOutboxStore } from '../../../core/intention/outreach-outbox.js';
import { registerSocialDesireOutreachTask } from '../../../core/scheduler/social-desire-outreach-lane.js';
import { composeCompanionDmChannelId } from '../../../shared/contracts/companion-channels.js';
import type { ChannelType } from '../../../shared/contracts/runtime.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import type { SchedulerRuntimeConfig as SchedulerConfig } from '../../../system/config/scheduler-config.js';
import type { AgentSchedulerRuntime } from '../scheduler-runtime.js';
import type { createAgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';

export interface SocialDesireLaneDeps {
  schedulerConfig: SchedulerConfig;
  scheduler: AgentSchedulerRuntime['scheduler'];
  postTurnActions: AgentSchedulerRuntime['postTurnActions'];
  eventBus: EventBus;
  log: Logger;
  socialDesireStore: Awaited<ReturnType<typeof createAgentPersistenceRuntime>>['socialDesireStore'];
  outreachOutbox: OutreachOutboxStore;
  heartbeatChannel: { channelId: string; channelType: ChannelType } | undefined;
  contactStore: ContactStorePort;
  icpPeers: AgentFacingIcpAutonomyRuntime | undefined;
  localCompanionId: string | undefined;
  llmProvider: LLMProviderPort;
  companionName: string;
}

export interface SocialDesireLaneResult {
  socialDesireOutbound: SocialDesireOutboundRuntime | undefined;
  socialDesireHumanDeliveryPolicy: SocialDesireHumanDeliveryPolicy | undefined;
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
    llmProvider,
    companionName,
  } = deps;

  let socialDesireOutbound: SocialDesireOutboundRuntime | undefined;
  let socialDesireHumanDeliveryPolicy: SocialDesireHumanDeliveryPolicy | undefined;
  if (schedulerConfig.socialDesire.enabled) {
    if (!socialDesireStore) {
      log.warn('socialDesire enabled but no social-desire store is available; lane not registered');
    } else {
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
      if (heartbeatChannel) {
        socialDesireHumanDeliveryPolicy = createSocialDesireHumanDeliveryPolicy({
          contacts: contactStore,
          approvedHeartbeatChannel: heartbeatChannel,
          quietHours: schedulerConfig.episodicProcessing,
        });
      }
      registerSocialDesireOutreachTask({
        scheduler,
        eventBus,
        postTurnActions,
        config: schedulerConfig.socialDesire,
        deps: {
          store: socialDesireStore,
          lifecycle: schedulerConfig.socialDesire.lifecycle,
          tierSource: createContactSocialDesireTierSource(contactStore),
          consentEvaluator: createLlmSocialDesireConsentEvaluator({
            llmProvider,
            characterName: companionName,
          }),
          consents: socialDesireConsents,
          maxConsentMomentsPerRun: schedulerConfig.socialDesire.outreach.maxConsentMomentsPerRun,
          quietHours: schedulerConfig.episodicProcessing,
          resolveContactTimeZone: async contactId => (
            (await contactStore.getById(contactId))?.timezone ?? null
          ),
          // Fail-closed delivery-channel policy: companion peers route to
          // their canonical companion DM (ICP candidate path); humans deliver
          // only to the primary contact's approved heartbeat DM. Anything
          // else has no channel — no consent moment, desire keeps pressure.
          resolveDeliveryChannel: async (contactId): Promise<SocialDesireDeliveryChannel | null> => {
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
            return {
              channelId: heartbeatChannel.channelId,
              channelType: heartbeatChannel.channelType,
              contactName: contact.displayName,
              companionTarget: false,
            };
          },
          isBudgetExhausted: (nowMs, reservedConsentCount) => (
            budgetGuard.isBudgetExhausted(nowMs, reservedConsentCount)
          ),
        },
      });
    }
  }
  return { socialDesireOutbound, socialDesireHumanDeliveryPolicy };
}
