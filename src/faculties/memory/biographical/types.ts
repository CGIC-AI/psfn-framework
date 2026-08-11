import type { SensitivityLevel } from '../../../system/trust/types.js';

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
}

// ── Claim envelope ──

export interface BiographicalClaim {
  readonly id: string;
  readonly subject: BiographicalSubjectRef;
  /** Required for relationship/shared-language and relational nickname dyads. */
  readonly relatedSubject?: BiographicalSubjectRef;
  readonly kind: BiographicalClaimKind;
  readonly value: BiographicalClaimValue;
  readonly basis: BiographicalClaimBasis;
  readonly status: BiographicalClaimStatus;
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
