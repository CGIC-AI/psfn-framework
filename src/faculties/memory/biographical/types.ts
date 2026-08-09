import type { SensitivityLevel } from '../../../system/trust/types.js';

/**
 * Biographical Profile projection (psfn-framework-o61vb).
 *
 * A rebuildable, typed-claim projection of who the companion is and who each
 * canonical contact is. Raw memories stay room-scoped; only independently
 * validated, sensitivity-gated, source-snapshot-bound claims live here. This
 * module owns the kernel + persistence only: it does not extract, render, or
 * reach prompts (those are later tracers). See
 * `working_docs/cross-channel-biographical-continuity-design.md`.
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
/** Policy version an exact lowering grant was decided under (audit only). */
export const BIOGRAPHICAL_GRANT_POLICY_VERSION = 1 as const;

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

export type BiographicalClaimKind = 'name' | 'nickname' | 'relationship';

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
  | 'contested'
  | 'superseded'
  | 'revoked';

export const BIOGRAPHICAL_CLAIM_STATUSES: readonly BiographicalClaimStatus[] = [
  'candidate',
  'active',
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
// Stored for audit. This ticket does NOT implement adaptive extraction policy
// or owner-file depth settings (those land with o61vb.6). A claim may record
// the depth decision under which it was admitted; the kernel never lets depth
// widen sensitivity or disclosure.

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

export type BiographicalClaimValue = NameClaimValue | NicknameClaimValue | RelationshipClaimValue;

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
  /** Required for `relationship`; required for `nickname` with `relational` scope. */
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
  readonly policyVersion: typeof BIOGRAPHICAL_GRANT_POLICY_VERSION;
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
