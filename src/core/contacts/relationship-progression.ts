import type { TrustDriftBehaviorSignals } from '../../system/trust/policy.js';
import type { RelationshipType } from './types.js';

export const HUMAN_RELATIONSHIP_TYPES = [
  'stranger',
  'acquaintance',
  'friend',
  'family',
  'partner',
] as const satisfies readonly RelationshipType[];

export type HumanRelationshipType = (typeof HUMAN_RELATIONSHIP_TYPES)[number];

export interface RelationshipProgressionSuggestion {
  fromRelationshipType: HumanRelationshipType;
  suggestedRelationshipType: HumanRelationshipType;
  rationale: string;
  requiresApproval: boolean;
}

const MANUAL_RELATIONSHIP_ACTOR_PREFIXES = ['admin:', 'human:', 'operator:'] as const;

function normalizeCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

export function isHumanRelationshipType(value: RelationshipType): value is HumanRelationshipType {
  return (HUMAN_RELATIONSHIP_TYPES as readonly RelationshipType[]).includes(value);
}

export function isApprovalGatedRelationshipType(value: RelationshipType): boolean {
  return value === 'family' || value === 'partner';
}

export function isManualRelationshipMutationAuthorized(actor?: string): boolean {
  const normalizedActor = actor?.trim().toLowerCase() ?? '';
  return MANUAL_RELATIONSHIP_ACTOR_PREFIXES.some(prefix => normalizedActor.startsWith(prefix));
}

export function requiresManualRelationshipMutation(
  currentRelationshipType: RelationshipType | undefined,
  requestedRelationshipType: RelationshipType,
): boolean {
  return isApprovalGatedRelationshipType(requestedRelationshipType)
    || (currentRelationshipType !== undefined
      && isApprovalGatedRelationshipType(currentRelationshipType));
}

export function relationshipTypeRank(value: HumanRelationshipType): number {
  return HUMAN_RELATIONSHIP_TYPES.indexOf(value);
}

export function evaluateRelationshipProgressionSuggestion(
  currentRelationshipType: RelationshipType,
  signals: TrustDriftBehaviorSignals,
): RelationshipProgressionSuggestion | null {
  if (!isHumanRelationshipType(currentRelationshipType) || currentRelationshipType === 'partner') {
    return null;
  }

  const positives = normalizeCount(signals.positiveInteractionCount);
  const negatives = normalizeCount(signals.negativeInteractionCount);
  const respectsBoundaries = signals.consistentBoundaryRespect === true;
  if (!respectsBoundaries) return null;

  if (currentRelationshipType === 'stranger' && positives >= 3 && negatives <= 1) {
    return {
      fromRelationshipType: 'stranger',
      suggestedRelationshipType: 'acquaintance',
      rationale: 'Repeated positive interactions support recognizing this contact as an acquaintance.',
      requiresApproval: false,
    };
  }

  if (currentRelationshipType === 'acquaintance' && positives >= 12 && negatives <= 1) {
    return {
      fromRelationshipType: 'acquaintance',
      suggestedRelationshipType: 'friend',
      rationale: 'Sustained positive interactions and boundary respect support recognizing this contact as a friend.',
      requiresApproval: false,
    };
  }

  if (currentRelationshipType === 'friend' && positives >= 24 && negatives === 0) {
    return {
      fromRelationshipType: 'friend',
      suggestedRelationshipType: 'family',
      rationale: 'Long-running positive interactions support proposing a family relationship for human review.',
      requiresApproval: true,
    };
  }

  if (currentRelationshipType === 'family' && positives >= 48 && negatives === 0) {
    return {
      fromRelationshipType: 'family',
      suggestedRelationshipType: 'partner',
      rationale: 'Exceptional sustained closeness supports proposing a partner relationship for human review.',
      requiresApproval: true,
    };
  }

  return null;
}
