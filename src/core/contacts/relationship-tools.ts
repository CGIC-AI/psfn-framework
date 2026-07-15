import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type {
  ApprovalQueuePort,
  ConfirmationQueueEntry,
} from '../../system/capabilities/approval-queue-port.js';
import type { TrustDriftBehaviorSignals } from '../../system/trust/policy.js';
import { textResult, textResultWithError } from '../tools/results.js';
import type { ContactStorePort } from './contact-store-port.js';
import { resolvePreferredContactName } from './preferred-name.js';
import {
  evaluateRelationshipProgressionSuggestion,
  HUMAN_RELATIONSHIP_TYPES,
  isApprovalGatedRelationshipType,
  isHumanRelationshipType,
  relationshipTypeRank,
  requiresManualRelationshipMutation,
} from './relationship-progression.js';
import { deriveTrustDriftBehaviorSignals } from './trust-drift-signals.js';
import type { RelationshipType } from './types.js';

const RELATIONSHIP_PROMOTION_METHOD = 'contact.relationship.promote';
const RELATIONSHIP_PROMOTION_ACTION = 'promote_relationship';
const RELATIONSHIP_PROMOTION_APPROVAL_ACTOR = 'operator:confirmation-queue';
const RELATIONSHIP_SIGNAL_TIME_SERIES_LIMIT = 64;

export interface ContactRelationshipToolParams {
  contactId?: string;
  relationshipType?: RelationshipType;
  rationale?: string;
  behaviorSignals?: TrustDriftBehaviorSignals;
}

function boundedBehaviorSignals(signals: TrustDriftBehaviorSignals): TrustDriftBehaviorSignals {
  const boundedCount = (value: number | undefined): number => (
    Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0
  );
  return {
    positiveInteractionCount: boundedCount(signals.positiveInteractionCount),
    negativeInteractionCount: boundedCount(signals.negativeInteractionCount),
    verifiedIdentityLinks: boundedCount(signals.verifiedIdentityLinks),
    consistentBoundaryRespect: signals.consistentBoundaryRespect === true,
  };
}

async function loadRecordedBehaviorSignals(
  contactStore: ContactStorePort,
  contactId: string,
): Promise<TrustDriftBehaviorSignals> {
  const [timeSeries, verifiedIdentityLinkCount] = await Promise.all([
    contactStore.getEmotionalTimeSeries(contactId, RELATIONSHIP_SIGNAL_TIME_SERIES_LIMIT),
    contactStore.countVerifiedIdentityLinks(contactId),
  ]);
  return deriveTrustDriftBehaviorSignals({ timeSeries, verifiedIdentityLinkCount });
}

function approvedEvidenceMatches(
  approved: unknown,
  recorded: TrustDriftBehaviorSignals,
): boolean {
  if (!approved || typeof approved !== 'object' || Array.isArray(approved)) return false;
  const candidate = approved as Record<string, unknown>;
  return candidate.positiveInteractionCount === recorded.positiveInteractionCount
    && candidate.negativeInteractionCount === recorded.negativeInteractionCount
    && candidate.verifiedIdentityLinks === recorded.verifiedIdentityLinks
    && candidate.consistentBoundaryRespect === recorded.consistentBoundaryRespect;
}

export async function executeContactSetRelationship(
  contactStore: ContactStorePort,
  params: ContactRelationshipToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const contactId = params.contactId?.trim() ?? '';
  if (!contactId) return textResultWithError('Missing contactId', true);

  const requestedRelationshipType = params.relationshipType;
  if (!requestedRelationshipType || !isHumanRelationshipType(requestedRelationshipType)) {
    return textResultWithError(
      `set_relationship requires relationshipType to be one of: ${HUMAN_RELATIONSHIP_TYPES.join(', ')}`,
      true,
    );
  }

  const contact = await contactStore.getById(contactId);
  if (!contact) return textResultWithError(`Contact ${contactId} not found`, true);
  if (!isHumanRelationshipType(contact.relationshipType)) {
    return textResultWithError(
      `Contact ${contactId} is classified as '${contact.relationshipType}'; use set_machine_intelligence instead of the human relationship ladder.`,
      true,
    );
  }
  if (contact.relationshipType === requestedRelationshipType) {
    return textResult(`Relationship for ${contactId} is already ${requestedRelationshipType}`);
  }

  if (requiresManualRelationshipMutation(contact.relationshipType, requestedRelationshipType)) {
    return textResultWithError(
      `Changing relationship '${contact.relationshipType}' to '${requestedRelationshipType}' for ${contactId} requires operator approval. `
      + (isApprovalGatedRelationshipType(requestedRelationshipType)
        ? 'Use action=propose_relationship with a rationale.'
        : 'Ask the operator to make the gated relationship change in Garden.'),
      true,
    );
  }

  const currentRank = relationshipTypeRank(contact.relationshipType);
  const requestedRank = relationshipTypeRank(requestedRelationshipType);
  if (requestedRank < currentRank) {
    return textResultWithError(
      'Autonomous relationship changes only progress one classification at a time; downgrades require operator review.',
      true,
    );
  }
  if (requestedRank > currentRank) {
    const recordedSignals = await loadRecordedBehaviorSignals(contactStore, contactId);
    const suggestion = evaluateRelationshipProgressionSuggestion(
      contact.relationshipType,
      recordedSignals,
    );
    if (!suggestion || suggestion.suggestedRelationshipType !== requestedRelationshipType) {
      return textResultWithError(
        `Recorded behavior does not support ${contact.relationshipType} -> ${requestedRelationshipType}. `
        + 'Relationship promotions proceed one classification at a time.',
        true,
      );
    }
  }

  const updated = await contactStore.compareAndSetRelationshipType(
    contactId,
    contact.relationshipType,
    requestedRelationshipType,
    'agent:tool:contact_set_relationship',
  );
  if (!updated) {
    return textResultWithError(
      `Relationship update for ${contactId} was denied by contact policy or the relationship changed concurrently`,
      true,
    );
  }
  return textResult(
    `Relationship for ${contactId} updated: ${contact.relationshipType} -> ${requestedRelationshipType}. `
    + `Trust remains ${contact.trustLevel}.`,
  );
}

export async function executeContactProposeRelationship(
  contactStore: ContactStorePort,
  proposalQueue: ApprovalQueuePort | undefined,
  params: ContactRelationshipToolParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const contactId = params.contactId?.trim() ?? '';
  if (!contactId) return textResultWithError('Missing contactId', true);

  const requestedRelationshipType = params.relationshipType;
  if (!requestedRelationshipType || !isApprovalGatedRelationshipType(requestedRelationshipType)) {
    return textResultWithError(
      "propose_relationship can only propose 'family' or 'partner' classifications",
      true,
    );
  }
  const rationale = params.rationale?.trim() ?? '';
  if (!rationale) {
    return textResultWithError('Missing rationale. propose_relationship requires a short rationale.', true);
  }
  if (!proposalQueue) {
    return textResultWithError(
      'Family and partner relationship proposals require a confirmation queue, but none is wired into the contact tool.',
      true,
    );
  }

  const contact = await contactStore.getById(contactId);
  if (!contact) return textResultWithError(`Contact ${contactId} not found`, true);
  const recordedSignals = await loadRecordedBehaviorSignals(contactStore, contactId);
  const suggestion = evaluateRelationshipProgressionSuggestion(
    contact.relationshipType,
    recordedSignals,
  );
  if (
    !suggestion
    || suggestion.suggestedRelationshipType !== requestedRelationshipType
    || !suggestion.requiresApproval
  ) {
    return textResultWithError(
      `Recorded behavior does not support proposing ${contact.relationshipType} -> ${requestedRelationshipType}. `
      + 'Gated relationship promotions proceed one classification at a time.',
      true,
    );
  }

  const contactName = resolvePreferredContactName(contact) ?? contact.displayName;
  const currentRelationshipType = suggestion.fromRelationshipType;
  const proposalEvidence = boundedBehaviorSignals(recordedSignals);
  const entry = proposalQueue.enqueue(
    {
      method: RELATIONSHIP_PROMOTION_METHOD,
      action: RELATIONSHIP_PROMOTION_ACTION,
      scope: `${contactName} (${contactId}): ${currentRelationshipType} -> ${requestedRelationshipType}`,
      params: {
        contactId,
        currentRelationshipType,
        requestedRelationshipType,
        rationale,
        behaviorSignals: proposalEvidence,
      },
      companionReason: rationale,
    },
    async (approvedParams: Record<string, unknown>, queueEntry: ConfirmationQueueEntry) => {
      const approvedContactId = typeof approvedParams.contactId === 'string' ? approvedParams.contactId.trim() : '';
      const approvedCurrent = approvedParams.currentRelationshipType;
      const approvedTarget = approvedParams.requestedRelationshipType;
      if (
        approvedContactId !== contactId
        || approvedCurrent !== currentRelationshipType
        || approvedTarget !== requestedRelationshipType
        || !approvedEvidenceMatches(approvedParams.behaviorSignals, proposalEvidence)
      ) {
        throw new Error(`Proposal ${queueEntry.id} changed immutable relationship scope or evidence; refusing approval.`);
      }

      const applied = await contactStore.compareAndSetRelationshipType(
        contactId,
        currentRelationshipType,
        requestedRelationshipType,
        RELATIONSHIP_PROMOTION_APPROVAL_ACTOR,
      );
      if (!applied) {
        throw new Error(`Failed to apply stale relationship proposal ${queueEntry.id}; relationship unchanged.`);
      }
    },
  );

  return textResult(
    `Relationship proposal queued for ${contactName} (${contactId}): ${currentRelationshipType} -> `
    + `${requestedRelationshipType} (proposal id: ${entry.id}). Relationship and trust are unchanged until `
    + 'the operator approves in the Garden Confirmations page.',
  );
}
