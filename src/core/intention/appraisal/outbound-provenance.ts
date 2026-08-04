import type { InferredPostTurnAction } from '../../../shared/contracts/runtime.js';
import {
  type IntentionActionDecision,
  type IntentionOutboundAppraisalFollowUpProvenance,
  type IntentionOutboundMessageActionPayload,
} from './types.js';

export interface AppraisalOutboundProvenanceResolution {
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
 * Resolve the appraisal-owned concern scope before the generic scheduler gate
 * checks concern liveness and common delivery policy. An explicit external
 * appraisal decision is its own exact-action companion authorship moment; it
 * does not borrow authorization from an unrelated proactive initiator.
 */
export function resolveAppraisalOutboundProvenance(
  action: InferredPostTurnAction,
  payload: IntentionOutboundMessageActionPayload,
): AppraisalOutboundProvenanceResolution {
  const appraisalFollowUp = payload.appraisalFollowUp;
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
