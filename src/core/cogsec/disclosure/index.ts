// ── CogSec outbound disclosure: public surface ──
//
// Contract types for the destination-eligibility axis (bible §9) and the pure,
// fail-closed decision functions over them. Runtime accumulation/egress wiring
// lives in later beads; this module is contract + pure logic only.

export * from './contracts.js';
export {
  accumulateDisclosureSource,
  assessDisclosure,
  beginDisclosureAccumulation,
  destinationEpochEligible,
  destinationPermitted,
  intersectDestinationConstraints,
  maxSensitivity,
} from './decision.js';
export {
  DISCLOSURE_CLASSIFIER_VERSION,
  assertScopedDisclosureConstraints,
  buildGenerationDisclosureLineage,
  memoryDisclosureContribution,
  sessionHistoryDisclosureContribution,
  toolResultDisclosureContribution,
  wikiDisclosureContribution,
  type CompanionOwnedDisclosureAudience,
  type DisclosureMemorySource,
  type DisclosureToolResultSource,
  type DisclosureWikiSource,
} from './generation-lineage.js';
export {
  DISCLOSURE_SOCIAL_EGRESS_METHODS,
  composeEgressDisclosureDecision,
  deriveDisclosureDestination,
  isDisclosureSocialEgressMethod,
  type ChannelDisclosureResolver,
  type ComposedEgressDisclosureDecision,
} from './egress-composition.js';
export {
  CAPSULE_AUTHORITY,
  CAPSULE_DENY_CODES,
  CAPSULE_USE_INTENTS,
  SHARE_CAPSULE_SCHEMA_VERSION,
  SHARE_CONTENT_HASH_VERSION,
  approveShareCandidate,
  authorizeCapsuleUse,
  buildShareCandidate,
  evaluateCapsuleUse,
  hashShareContent,
  parseApprovedShareCapsule,
  parseCapsuleExpiry,
  parseCapsuleRevocation,
  parseShareCandidate,
  parseShareContent,
  revokeShareCapsule,
  type ApprovedShareCapsule,
  type CapsuleAuthority,
  type CapsuleDenyCode,
  type CapsuleExpiry,
  type CapsuleRevocation,
  type CapsuleUseDecision,
  type CapsuleUseIntent,
  type CapsuleUseRequest,
  type ShareApproval,
  type ShareApprovalGrant,
  type ShareCandidate,
  type ShareCandidateDraft,
  type ShareContent,
} from './capsule.js';
export {
  classifyProvenanceSourceRef,
  projectPublicationProvenance,
  type ProvenanceDestinationView,
  type ProvenanceFieldStatus,
  type ProvenanceSourceKind,
  type ProvenanceSourceKindCount,
  type ProvenanceSourceView,
  type PublicationProvenanceView,
} from './publication-provenance.js';
