import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { MemoryPolicyType } from '../../../system/config/memory-retrieval-policy.js';

/**
 * Biographical Profile projection (psfn-framework-o61vb).
 *
 * A rebuildable, typed-claim projection of who the companion is and who each
 * canonical contact is. Raw memories stay room-scoped; only independently
 * validated, sensitivity-gated, source-snapshot-bound claims live here. This
 * module owns the kernel + persistence only: it does not extract, render, or
 * reach prompts (those are later tracers).
 *
 * Everything fails closed: unknown kinds, schema/normalizer versions, subject
 * shapes, malformed sources, invalid temporal intervals, invalid lifecycle
 * transitions, and invalid grants reject rather than degrade.
 */

// ── Schema versions ──

/** Claim envelope shape version. Bumping invalidates stored claim digests. */
export const BIOGRAPHICAL_CLAIM_SCHEMA_VERSION = 1 as const;
/** Structured-value canonicalization version. Bumping invalidates claim digests. */
export const BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION = 1 as const;
/** Authorization-grant envelope version. */
export const BIOGRAPHICAL_GRANT_SCHEMA_VERSION = 1 as const;
/** Decision-contract revision an exact lowering grant was decided under. */
export const BIOGRAPHICAL_GRANT_DECISION_REVISION = 1 as const;

// ── Subjects ──

/**
 * A subject bound to the canonical subject version observed at write time. The
 * stored version lets read-time revalidation detect a contact merge/archive
 * that changed the canonical subject identity (lifecycle hardening ticket).
 */
export type BiographicalSubjectRef =
  | { readonly kind: 'companion'; readonly companionId: string; readonly subjectVersion: number }
  | { readonly kind: 'contact'; readonly contactId: string; readonly subjectVersion: number };

// ── Claim kinds (closed registry) ──

export type BiographicalClaimKind =
  | 'name'
  | 'nickname'
  | 'relationship'
  | 'role'
  | 'stable-preference'
  | 'shared-language';

export type BiographicalClaimBasis = 'explicit' | 'observed' | 'inferred' | 'imported';
export const BIOGRAPHICAL_CLAIM_BASES: readonly BiographicalClaimBasis[] = [
  'explicit',
  'observed',
  'inferred',
  'imported',
];

export const BIOGRAPHICAL_SOURCE_LIFECYCLE_STATES = [
  'active',
  'quarantined',
  'tombstoned',
  'cogsec_blocked',
  'revoked',
  'superseded',
] as const;
type BiographicalSourceLifecycleState =
  (typeof BIOGRAPHICAL_SOURCE_LIFECYCLE_STATES)[number];

export type BiographicalClaimStatus =
  | 'candidate'
  | 'active'
  | 'quarantined'
  | 'contested'
  | 'superseded'
  | 'revoked';

export const BIOGRAPHICAL_CLAIM_STATUSES: readonly BiographicalClaimStatus[] = [
  'candidate',
  'active',
  'quarantined',
  'contested',
  'superseded',
  'revoked',
];

/** Terminal lifecycle states; append-only history is preserved beyond these. */
export const BIOGRAPHICAL_TERMINAL_STATUSES: readonly BiographicalClaimStatus[] = [
  'superseded',
  'revoked',
];

// ── Portability scope (o61vb.15) ──

/**
 * How far a reviewed active claim may travel beyond the room its sources came
 * from.
 *
 * - `origin_only`  — never enters portable projection. The default for every
 *                    claim, including stored rows written before this scope
 *                    existed: portability is something a reviewer grants, never
 *                    something a claim acquires by existing.
 * - `universal`    — reviewed baseline-safe companion identity. Renders in any
 *                    destination its sensitivity and CogSec lineage already
 *                    admit; scope widens *where* a claim may go, never *whether*
 *                    it clears the destination gate.
 * - `subject_present` — renders only while the bound person is actually part of
 *                    the turn: the current author, an explicitly addressed
 *                    verified contact, or a proven current participant.
 */
export const BIOGRAPHICAL_PORTABILITY_SCOPES = [
  'origin_only',
  'universal',
  'subject_present',
] as const;
export type BiographicalPortabilityScope = (typeof BIOGRAPHICAL_PORTABILITY_SCOPES)[number];

// ── Collection depth (audit only) ──
//
// Stored for audit. A claim may record the canonical depth decision under
// which it was admitted; the kernel never lets depth widen sensitivity or
// disclosure.

export type BiographicalCollectionDepth = 'recognition' | 'developing' | 'full';
export const BIOGRAPHICAL_COLLECTION_DEPTHS: readonly BiographicalCollectionDepth[] = [
  'recognition',
  'developing',
  'full',
];

// ── Structured values ──

export interface NameClaimValue {
  readonly kind: 'name';
  /** Display name. Stored verbatim after trim/length validation. */
  readonly name: string;
  /** Primary names are singleton per subject; aliases are set-valued. */
  readonly role: 'primary' | 'alias';
}

export interface NicknameClaimValue {
  readonly kind: 'nickname';
  readonly nickname: string;
  /** `self` describes the subject; `relational` attributes the related subject. */
  readonly scope: 'self' | 'relational';
}

export interface RelationshipClaimValue {
  readonly kind: 'relationship';
  /** Normalized relationship type (no inferred exclusivity between types). */
  readonly relationshipType: string;
}

/** Schema version shared by the closed stable-biography value family. */
export const BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION = 1 as const;

export const BIOGRAPHICAL_ROLE_TYPES = [
  'employment',
  'education',
  'family',
  'community',
  'creative',
] as const;
type BiographicalRoleType = (typeof BIOGRAPHICAL_ROLE_TYPES)[number];

export interface RoleClaimValue {
  readonly kind: 'role';
  readonly schemaVersion: typeof BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION;
  readonly roleType: BiographicalRoleType;
  readonly title: string;
  readonly organization?: string;
}

export const BIOGRAPHICAL_PREFERENCE_DOMAINS = [
  'food',
  'media',
  'activity',
  'environment',
  'communication',
] as const;
type BiographicalPreferenceDomain = (typeof BIOGRAPHICAL_PREFERENCE_DOMAINS)[number];

export const BIOGRAPHICAL_PREFERENCE_POLARITIES = [
  'likes',
  'dislikes',
  'prefers',
  'avoids',
] as const;
type BiographicalPreferencePolarity =
  (typeof BIOGRAPHICAL_PREFERENCE_POLARITIES)[number];

export interface StablePreferenceClaimValue {
  readonly kind: 'stable-preference';
  readonly schemaVersion: typeof BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION;
  readonly domain: BiographicalPreferenceDomain;
  readonly target: string;
  readonly polarity: BiographicalPreferencePolarity;
}

export const BIOGRAPHICAL_SHARED_LANGUAGE_TYPES = [
  'phrase',
  'ritual',
  'reference',
  'signal',
] as const;
type BiographicalSharedLanguageType =
  (typeof BIOGRAPHICAL_SHARED_LANGUAGE_TYPES)[number];

export interface SharedLanguageClaimValue {
  readonly kind: 'shared-language';
  readonly schemaVersion: typeof BIOGRAPHICAL_STABLE_VALUE_SCHEMA_VERSION;
  readonly languageType: BiographicalSharedLanguageType;
  readonly phrase: string;
  readonly meaning: string;
}

export type BiographicalClaimValue =
  | NameClaimValue
  | NicknameClaimValue
  | RelationshipClaimValue
  | RoleClaimValue
  | StablePreferenceClaimValue
  | SharedLanguageClaimValue;

// ── Source snapshots ──

export interface BiographicalClaimSource {
  /** Content-free durable provenance reference, such as `memory:<id>`. */
  readonly ref: string;
  /** Revision of the source observed at projection time. */
  readonly revision: string;
  /** Digest of the source evidence the claim was reduced from. */
  readonly evidenceDigest: string;
  readonly sensitivityAtProjection: SensitivityLevel;
  /** Digest of the subject evidence binding the source to this subject. */
  readonly subjectEvidenceDigest: string;
  /** Fingerprint of the consent state observed at projection time. */
  readonly consentFingerprint: string;
  readonly sourceChannelId?: string;
  readonly sourceChannelEpoch?: number;
  /** Required at the candidate admission boundary; legacy active claims may omit it. */
  readonly sourceType?: MemoryPolicyType;
  /** Required at candidate admission; only an exact owner-policy value is accepted. */
  readonly lifecycleStateAtProjection?: BiographicalSourceLifecycleState;
}

// ── Revisioned candidate review authority ──

export const BIOGRAPHICAL_CANDIDATE_STAGES = [
  'automata_synthesis',
  'companion_review',
  'human_review',
  'active',
  'rejected',
  'superseded',
] as const;
export type BiographicalCandidateStage = (typeof BIOGRAPHICAL_CANDIDATE_STAGES)[number];

export const BIOGRAPHICAL_CANDIDATE_RECEIPT_AUTHORITIES = [
  'automata',
  'companion',
  'human',
  'owner_policy',
] as const;
export type BiographicalCandidateReceiptAuthority =
  (typeof BIOGRAPHICAL_CANDIDATE_RECEIPT_AUTHORITIES)[number];

export type BiographicalCandidateReceiptDecision = 'approved' | 'rejected' | 'superseded';

/**
 * Closed reviewer reason codes. A reviewer states why it decided with a code so
 * a receipt can be audited without republishing review reasoning as prose.
 */
export const BIOGRAPHICAL_CANDIDATE_RECEIPT_REASONS = [
  'synthesized',
  'reviewer_approved',
  'reviewer_rejected',
  'reviewer_revised',
  'reviewer_reassigned',
  'reviewer_split',
  'reviewer_merged',
  'reviewer_flagged_sensitive',
  'reviewer_flagged_ambiguous',
  'owner_policy_supersession',
  'owner_policy_autoactivation',
] as const;
export type BiographicalCandidateReceiptReason =
  (typeof BIOGRAPHICAL_CANDIDATE_RECEIPT_REASONS)[number];

export interface BiographicalCandidateReceipt {
  readonly id: string;
  readonly authority: BiographicalCandidateReceiptAuthority;
  readonly decision: BiographicalCandidateReceiptDecision;
  readonly actorAuthorityRef: string;
  readonly candidateRevision: number;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly recordedAt: string;
  /** Closed reason code; absent on receipts written before o61vb.13. */
  readonly reason?: BiographicalCandidateReceiptReason;
}

/**
 * Canonical social context a candidate was grouped under. Grouping is by
 * canonical subject identity and explicit dyad, never by channel or room: the
 * same dyad observed in two rooms produces one context, and two dyads sharing a
 * room stay separate.
 */
export type BiographicalCandidateSocialContext =
  | { readonly kind: 'companion_self'; readonly companionId: string }
  | {
      readonly kind: 'companion_contact_dyad';
      readonly companionId: string;
      readonly contactId: string;
    }
  /**
   * A true group fact (o61vb.15). The contact set is the exact canonical
   * participant set the claim binds, in canonical order, so an n-ary fact can
   * never collapse into a misleading singular relationship.
   */
  | {
      readonly kind: 'companion_group';
      readonly companionId: string;
      readonly contactIds: readonly string[];
    };

/**
 * Closed synthesis rationale codes. The synthesizer explains why a candidate
 * exists with a code, never with prose: free-form profile narrative is a
 * non-goal of the biography epic and would leak source content into review.
 */
export const BIOGRAPHICAL_CANDIDATE_RATIONALES = [
  'new_subject_claim',
  'recurring_evidence',
  'coalesced_duplicate_evidence',
  'contradicts_active_claim',
  'companion_revision',
] as const;
export type BiographicalCandidateRationale =
  (typeof BIOGRAPHICAL_CANDIDATE_RATIONALES)[number];

/**
 * Whether the facts a candidate asserts were derived from a human subject's
 * sources or from the companion's own. Review policy never autoactivates
 * human-derived facts.
 */
export type BiographicalCandidateDerivation = 'human_derived' | 'companion_derived';

export interface BiographicalCandidateRecord {
  readonly id: string;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly automataRunId: string;
  readonly policyDigest: string;
  /** Snapshotted owner-policy bound so later transitions remain budgeted. */
  readonly reviewReceiptLimit: number;
  readonly revision: number;
  readonly stage: BiographicalCandidateStage;
  readonly receipts: readonly BiographicalCandidateReceipt[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supersedesCandidateId?: string;
  /** Canonical grouping context; absent on rows written before o61vb.12. */
  readonly socialContext?: BiographicalCandidateSocialContext;
  /** Closed synthesis reason code; absent on rows written before o61vb.12. */
  readonly rationale?: BiographicalCandidateRationale;
}

// ── Claim envelope ──

export interface BiographicalClaim {
  readonly id: string;
  readonly subject: BiographicalSubjectRef;
  /** Required for relationship/shared-language and relational nickname dyads. */
  readonly relatedSubject?: BiographicalSubjectRef;
  /**
   * Exact canonical participant set for an n-ary group claim (o61vb.15). At
   * least two contacts, unique and canonically ordered, and mutually exclusive
   * with `relatedSubject`: a group fact never degrades into a dyad.
   */
  readonly participants?: readonly BiographicalSubjectRef[];
  readonly kind: BiographicalClaimKind;
  readonly value: BiographicalClaimValue;
  readonly basis: BiographicalClaimBasis;
  readonly status: BiographicalClaimStatus;
  /**
   * Review-assigned portability. Deliberately outside `claimDigest`, exactly
   * like status and sensitivity: it is a lifecycle decision about one claim,
   * not part of what the claim asserts, so granting portability never
   * invalidates a digest-bound grant or a staged candidate.
   */
  readonly portabilityScope: BiographicalPortabilityScope;
  readonly schemaVersion: typeof BIOGRAPHICAL_CLAIM_SCHEMA_VERSION;
  readonly normalizerVersion: typeof BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly sources: readonly BiographicalClaimSource[];
  readonly proposedSensitivity: SensitivityLevel;
  /** Cache and audit statement; read-time authority recomputes from live sources + grants. */
  readonly effectiveSensitivity: SensitivityLevel;
  readonly confidence: number;
  readonly synthesizedAt: string;
  readonly lastSourceValidatedAt: string;
  readonly lastEvidenceAt: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesClaimId?: string;
  /** Audit-only depth decision under which the claim was admitted. */
  readonly depthDecision?: BiographicalCollectionDepth;
  /** Id of an exact lowering grant currently reflected in effectiveSensitivity. */
  readonly appliedGrantId?: string;
}

// ── Exact digest-bound lowering grants ──

type BiographicalGrantActor = 'companion' | 'operator' | 'subject';

export interface BiographicalSensitivityGrant {
  readonly id: string;
  readonly schemaVersion: typeof BIOGRAPHICAL_GRANT_SCHEMA_VERSION;
  readonly policyVersion: typeof BIOGRAPHICAL_GRANT_DECISION_REVISION;
  /** Exact claim content digest the grant is bound to. */
  readonly claimDigest: string;
  /** Exact source-set digest the grant is bound to. */
  readonly sourceSetDigest: string;
  /** Sensitivity the claim is lowered to while the grant is valid. */
  readonly grantedSensitivity: SensitivityLevel;
  readonly authorizingActor: BiographicalGrantActor;
  readonly authorityBasis: string;
  readonly reason: string;
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}
