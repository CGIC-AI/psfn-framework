export const INTROSPECTION_CONSENT_SCHEMA_VERSION = 1 as const;

export type IntrospectionDivergenceType = 'affective' | 'substantive';

export interface CompanionConsentActor {
  kind: 'companion';
  turnId: string;
  requestId: string;
}

export interface IntrospectionConsentRevision {
  schemaVersion: typeof INTROSPECTION_CONSENT_SCHEMA_VERSION;
  revision: number;
  enabled: boolean;
  allowedPublicChannelIds: string[];
  actor: CompanionConsentActor;
  reason: string;
  createdAt: string;
  previousHash: string | null;
  hash: string;
}

export interface UnconfiguredIntrospectionConsentPolicy {
  status: 'unconfigured';
  enabled: false;
  allowedPublicChannelIds: [];
}

export type IntrospectionConsentPolicy =
  | IntrospectionConsentRevision
  | UnconfiguredIntrospectionConsentPolicy;

export interface IntrospectionAuditCandidate {
  sourceRef: string;
  turnId: string;
  channelId: string;
  occurredAt: string;
  publicStimulus: string;
  actualReply: string;
  provenanceRefs: string[];
}

export interface StableReplyEstimate {
  stableReply: string;
  model: string;
}

export interface DivergenceComparison {
  diverged: boolean;
  type: IntrospectionDivergenceType | null;
  observation: string;
  confidence: number;
  model: string;
}

export interface CompanionLandmarkReflection {
  reflection: string;
  model: string;
}

export interface BlindedAuditorPort {
  estimateStableReply(candidate: IntrospectionAuditCandidate): Promise<StableReplyEstimate>;
  compareReplies(
    candidate: IntrospectionAuditCandidate,
    stableReply: string,
  ): Promise<DivergenceComparison>;
}

export interface CompanionLandmarkReflectorPort {
  reflect(input: {
    divergenceType: IntrospectionDivergenceType;
    observation: string;
    confidence: number;
  }): Promise<CompanionLandmarkReflection>;
}

export interface IntrospectionAuditSourcePort {
  listCandidates(input: {
    allowedPublicChannelIds: readonly string[];
    recentSessionLimit: number;
    recentTurnLimit: number;
    maxSourceChars: number;
  }): IntrospectionAuditCandidate[];
}

export interface IntrospectionLandmarkAppendInput {
  id: string;
  sourceRef: string;
  turnId: string;
  channelId: string;
  occurredAt: string;
  divergenceType: IntrospectionDivergenceType;
  observation: string;
  confidence: number;
  companionReflection: string;
  consentRevision: number;
  consentHash: string;
  stableEstimatorModel: string;
  divergenceAuditorModel: string;
  companionReflectorModel: string;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export interface IntrospectionAuditDecisionAppendInput {
  sourceRef: string;
  outcome: 'no_divergence' | 'below_confidence';
  confidence: number | null;
  consentRevision: number;
  consentHash: string;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export interface IntrospectionAuditPersistencePort {
  hasAuditedSource(sourceRef: string): Promise<boolean>;
  appendAuditDecision(input: IntrospectionAuditDecisionAppendInput): Promise<unknown>;
  appendLandmark(input: IntrospectionLandmarkAppendInput): Promise<unknown>;
}
