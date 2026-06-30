import type { BroadcastVisibilityScope } from '../../../system/trust/broadcast-safety.js';
import type {
  SensitivityLevel,
  TrustLevel,
} from '../../../system/trust/types.js';
import type { MemoryEvolutionRelation } from '../memory-store-port.js';
import type {
  MemoryPrivacyRiskBreakdown,
  PurrMemory,
} from '../types.js';
import type {
  MemoryWithheldRelevanceBandCounts,
  MemoryWithheldReasonCounts,
  MemoryWithheldReasonTag,
} from '../withheld-summary.js';

export interface ScoredMemory {
  memory: PurrMemory & { similarity: number };
  baseScore: number;
  evidenceSupport: number;
  contradictionPenaltyMultiplier: number;
  explicitlyQueried: boolean;
  lowConfidenceSingleSourceSuppressed: boolean;
  quietPreferenceSuppressed: boolean;
  preferenceContextBoost: number;
  evidenceSourceCount: number;
  privacyRisk: number;
  privacyPenalty: number;
  privacyBreakdown: MemoryPrivacyRiskBreakdown;
  retrievalModeExcluded: boolean;
  score: number;
  evolutionChain?: MemoryEvolutionPromptLink[];
}

export interface MemoryEvolutionPromptLink {
  relation: MemoryEvolutionRelation;
  confidence: number;
  reason?: string;
  memory: PurrMemory;
}

export interface RetrievalDecisionDiagnostics {
  candidateCount: number;
	  policyAllowedCount: number;
	  rejectedBySessionQuarantine: number;
	  rejectedByRoomVisibility: number;
  rejectedByContactScope: number;
  rejectedBySensitivity: number;
  rejectedByPolicy: number;
  rejectedByPolicyReasonTag: Record<string, number>;
  rejectedByScore: number;
  selectedCount: number;
  topSelected: Array<{
    id: string;
    score: number;
    baseScore: number;
    evidenceSupport: number;
    contradictionPenaltyMultiplier: number;
    lowConfidenceSingleSourceSuppressed: boolean;
    explicitlyQueried: boolean;
    privacyRisk: number;
    privacyPenalty: number;
    sensitivity: SensitivityLevel;
  }>;
  contradictionAdjustedCount: number;
  lowConfidenceSuppressedCount: number;
  explicitQueryOverrideCount: number;
}

export interface RetrievalTelemetry {
  channelId: string;
  count: number;
  reason: 'ok' | 'empty_input' | 'no_candidates' | 'score_filtered' | 'trust_filtered' | 'error';
  retrievalSource: 'embedding' | 'lexical_fallback';
  trustLevel: TrustLevel;
  channelVisibility: string;
  candidateCount: number;
  semanticCandidateCount: number;
  lexicalCandidateCount: number;
  episodicChainCount?: number;
  episodicEpisodeCount?: number;
  rankedCount: number;
  returnedCount: number;
  retrievalLimit: number;
  retrievalThreshold: number;
  retrievalBudgetPct: number;
  retrievalTokenBudget: number;
  retrievalLimitMode: 'budget' | 'hard_limit';
	  policyAllowedCount?: number;
	  sessionQuarantineRejectedCount?: number;
	  roomVisibilityRejectedCount?: number;
  contactScopeRejectedCount?: number;
  sensitivityRejectedCount?: number;
  policyRejectedCount?: number;
  policyRejectedReasonTags?: Record<string, number>;
  withheldCount?: number;
  withheldReasonCounts?: MemoryWithheldReasonCounts;
  withheldRelevanceBands?: MemoryWithheldRelevanceBandCounts;
  scoreRejectedCount?: number;
  scoreGuaranteedCount?: number;
  evidenceSupportAverage?: number;
  contradictionAdjustedCount?: number;
  lowConfidenceSuppressedCount?: number;
  explicitQueryOverrideCount?: number;
  visibilityScope: BroadcastVisibilityScope | 'non_broadcast';
  operatorApproval: boolean;
  provenanceRefs: string[];
  profileIncluded?: boolean;
  emotionalSnapshotIncluded?: boolean;
  emotionalContinuityCount?: number;
  topSimilarity?: number;
  bottomSimilarity?: number;
  topScore?: number;
  bottomScore?: number;
  budgetCappedCount?: number;
  relevanceStoppedCount?: number;
  selectionStopReason?: 'budget' | 'relevance' | 'exhausted';
  selectionScoreFloor?: number;
  selectedTypes?: Record<string, number>;
  compositionalMode?: 'disabled_policy' | 'llm_unavailable' | 'insufficient_candidates' | 'malformed_or_failed' | 'applied';
  compositionalCandidateCount?: number;
  compositionalEvaluationBatchCount?: number;
  compositionalFinalistCount?: number;
}

export interface CompositionalRetrievalDecision {
  ranked: ScoredMemory[] | null;
  mode: NonNullable<RetrievalTelemetry['compositionalMode']>;
  candidateCount: number;
  evaluationBatchCount: number;
  finalistCount: number;
}

export interface ProactiveWeightedMemory {
  memory: PurrMemory;
  weight: number;
}

export interface RetrievalContactContext {
  contactId: string;
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: string;
  relationshipLabels: string[];
  relatedToCanonical: boolean;
}

export interface RetrievalSocialContext {
  canonicalContactId: string;
  canonicalDisplayName: string;
  relatedContactsById: ReadonlyMap<string, RetrievalContactContext>;
}

export type RetrievalAccessRejectionKind =
  | 'session_quarantine'
  | 'room_visibility'
  | 'contact_scope'
  | 'sensitivity'
  | 'policy';

export interface RetrievalAccessDecision {
  allowed: boolean;
  rejectionKind?: RetrievalAccessRejectionKind;
  withheldReason?: MemoryWithheldReasonTag;
}

export interface RetrievalSelectionDecision {
  selected: ScoredMemory[];
  stopReason: 'budget' | 'relevance' | 'exhausted';
  relevanceStoppedCount: number;
  budgetCappedCount: number;
  relevanceScoreFloor: number;
}
