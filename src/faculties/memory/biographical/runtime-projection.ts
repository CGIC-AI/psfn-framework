import type { MemoryProvider } from '../../../core/agent/contracts.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { BiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import type { BiographicalSubjectRef } from './types.js';
import type { BiographicalSourceRevalidator } from './projection.js';
import { projectBiographicalContext } from './projection.js';
import type { CanonicalAddressedContactResolver } from './explicit-subject-selection.js';

function canonicalAddressedContactResolver(
  contactStore: ContactStorePort,
): CanonicalAddressedContactResolver {
  return {
    resolve: async input => {
      const contact = await contactStore.getByChannelIdentity(
        input.source,
        input.transportParticipantId,
      );
      if (!contact || contact.archivedAt) return { status: 'missing' };
      return {
        status: 'verified',
        subject: { kind: 'contact', contactId: contact.id, subjectVersion: 1 },
        trustLevel: contact.trustLevel,
        // Addressing proves who was addressed, not current room membership.
        currentParticipation: { status: 'unproven' },
      };
    },
  };
}

export function createRuntimeBiographicalProjection(input: {
  store: BiographicalProfileStorePort;
  revalidator: BiographicalSourceRevalidator;
  contactStore: ContactStorePort;
  companionId: string;
  policy: BiographicalDepthPolicy;
}): Pick<MemoryProvider, 'projectBiographicalContext'> {
  const companionSubject: BiographicalSubjectRef = {
    kind: 'companion',
    companionId: input.companionId,
    subjectVersion: 1,
  };
  const resolver = canonicalAddressedContactResolver(input.contactStore);
  return {
    projectBiographicalContext: async request => {
      const projected = await projectBiographicalContext({
        store: input.store,
        revalidator: input.revalidator,
        rebuildQueueMaxPending: input.policy.full.operationClaimLimit,
        explicitAddressing: {
          resolver,
          maxSubjects: input.policy.full.turnClaimLimit,
        },
      }, {
        companionSubject,
        conversationScope: request.conversationScope,
        ...(request.currentAuthor ? { currentAuthor: request.currentAuthor } : {}),
        ...(request.messageAddressing
          ? { messageAddressing: request.messageAddressing }
          : {}),
      });
      return {
        promptSection: projected.promptSection,
        disclosureSources: projected.disclosureSources,
        admittedClaimIds: projected.admittedClaimIds,
        withheldCount: projected.withheld.length,
      };
    },
  };
}
