import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import {
  type IntentionActionDecision,
  type IntentionOutboundAppraisalFollowUpProvenance,
  type IntentionOutboundMessageActionPayload,
} from './types.js';

export type AppraisalOutboundProvenanceBlockReason =
  | 'appraisal_consent_required'
  | 'appraisal_consent_scope_mismatch';

export interface AppraisalOutboundProvenanceResolution {
  blockReason?: AppraisalOutboundProvenanceBlockReason;
  concernScope: IntentionOutboundAppraisalFollowUpProvenance;
}

export function createAppraisalConcernScope(
  channelId: string,
  canonicalContactKey?: string,
): IntentionOutboundAppraisalFollowUpProvenance {
  return {
    channelId,
    ...(canonicalContactKey ? { canonicalContactKey } : {}),
  };
}

/**
 * Resolve the appraisal-owned part of outbound provenance before the generic
 * scheduler gate checks durable consent, concern liveness, and delivery policy.
 */
export function resolveAppraisalOutboundProvenance(
  action: InferredPostTurnAction,
  payload: IntentionOutboundMessageActionPayload,
): AppraisalOutboundProvenanceResolution {
  const appraisalFollowUp = payload.appraisalFollowUp;

  // The appraisal model may propose external text, but it is not the
  // companion's consent moment. Only the existing exact-action, single-use
  // social-desire consent can ratify that draft for delivery.
  if (appraisalFollowUp && !payload.socialDesire) {
    return {
      blockReason: 'appraisal_consent_required',
      concernScope: createAppraisalConcernScope(action.channelId),
    };
  }
  if (
    appraisalFollowUp?.canonicalContactKey
    && payload.socialDesire
    && appraisalFollowUp.canonicalContactKey !== payload.socialDesire.contactId
  ) {
    return {
      blockReason: 'appraisal_consent_scope_mismatch',
      concernScope: appraisalFollowUp,
    };
  }
  return {
    concernScope: appraisalFollowUp ?? createAppraisalConcernScope(action.channelId),
  };
}

function decisionReferencesConcernPressure(
  decision: Pick<IntentionActionDecision, 'reason' | 'followUp'>,
): boolean {
  const text = `${decision.reason} ${decision.followUp?.content ?? ''}`.toLowerCase();
  return /\bconcerns?\b/.test(text)
    || /\bopen threads?\b/.test(text)
    || /\bactive high-priority\b/.test(text);
}

/** Preserve the explicit concern-pressure fallback without stapling unrelated ids. */
export function applyExternalAppraisalConcernRequirement(
  decisions: IntentionActionDecision[],
): void {
  for (const decision of decisions) {
    if (decision.type !== 'followUp' || decision.followUp?.delivery !== 'external') {
      continue;
    }
    if (
      (decision.followUp.concernIds ?? []).length === 0
      && decisionReferencesConcernPressure(decision)
    ) {
      decision.followUp = {
        ...decision.followUp,
        requiresActiveConcern: true,
      };
    }
  }
}
