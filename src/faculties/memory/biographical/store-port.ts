import { randomUUID } from 'node:crypto';

import type { SensitivityLevel } from '../../../system/trust/types.js';
import { hasExactKeys, isCanonicalIsoTimestamp } from '../../../shared/utils/types.js';
import type {
  BiographicalClaim,
  BiographicalClaimBasis,
  BiographicalClaimKind,
  BiographicalClaimSource,
  BiographicalClaimStatus,
  BiographicalClaimValue,
  BiographicalCollectionDepth,
  BiographicalSensitivityGrant,
  BiographicalSubjectRef,
} from './types.js';
import {
  BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
  BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
  BIOGRAPHICAL_GRANT_DECISION_REVISION,
  BIOGRAPHICAL_GRANT_SCHEMA_VERSION,
} from './types.js';
import {
  BiographicalClaimValidationError,
  assertClaimValidityRule,
  assertKnownClaimKind,
  assertRelatedSubjectShape,
  canonicalizeClaimValue,
  isValidSensitivityLevel,
} from './claim-kinds.js';
import {
  applyLoweringGrant,
  assembleCanonicalClaim,
  assertClaimBasis,
  assertClaimStatus,
  assertCollectionDepth,
  assertConfidence,
  assertGrantInput,
  assertLifecycleTransition,
  assertSources,
  assertSubjectRef,
  assertValidInterval,
  computeAutomaticSensitivity,
  computeClaimDigest,
  computeSourceSetDigest,
} from './kernel.js';

/**
 * Deep persistence module for the biographical profile projection. Both the
 * in-memory and Postgres adapters implement this port and share the
 * deterministic candidate/grant preparation helpers below, so persistence
 * parity is structural rather than per-adapter.
 *
 * The kernel ticket stores claims, sources, grants, lifecycle, temporal
 * validity, depth decisions, and append-only supersession. It does not render,
 * extract, or reach prompts.
 */

export interface BiographicalClaimWriteInput {
  readonly id?: string;
  readonly subject: BiographicalSubjectRef;
  readonly relatedSubject?: BiographicalSubjectRef;
  readonly kind: BiographicalClaimKind;
  readonly value: BiographicalClaimValue;
  readonly basis: BiographicalClaimBasis;
  readonly proposedSensitivity?: SensitivityLevel;
  readonly confidence: number;
  readonly sources: readonly BiographicalClaimSource[];
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly depthDecision?: BiographicalCollectionDepth;
  /** Defaults to `candidate`. */
  readonly status?: BiographicalClaimStatus;
  /** Set by {@link BiographicalProfileStorePort.supersedeClaim}. */
  readonly supersedesClaimId?: string;
  readonly now?: Date;
}

export interface BiographicalClaimListOptions {
  readonly subject?: BiographicalSubjectRef;
  readonly kind?: BiographicalClaimKind;
  readonly status?: BiographicalClaimStatus;
  /** Include terminal (superseded/revoked) history rows. Defaults to false. */
  readonly includeTerminal?: boolean;
  readonly limit?: number;
}

export interface BiographicalSupersessionInput {
  /** Existing claim to supersede. Must not already be terminal. */
  readonly supersededClaimId: string;
  readonly subject: BiographicalSubjectRef;
  readonly relatedSubject?: BiographicalSubjectRef;
  readonly kind: BiographicalClaimKind;
  readonly value: BiographicalClaimValue;
  readonly basis: BiographicalClaimBasis;
  readonly proposedSensitivity?: SensitivityLevel;
  readonly confidence: number;
  readonly sources: readonly BiographicalClaimSource[];
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly depthDecision?: BiographicalCollectionDepth;
  readonly now?: Date;
}

export interface BiographicalSupersessionResult {
  readonly superseded: BiographicalClaim;
  readonly superseding: BiographicalClaim;
}

export interface BiographicalTransitionInput {
  readonly claimId: string;
  readonly to: BiographicalClaimStatus;
  readonly now?: Date;
}

export interface BiographicalGrantWriteInput {
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly grantedSensitivity: SensitivityLevel;
  readonly authorizingActor: BiographicalSensitivityGrant['authorizingActor'];
  readonly authorityBasis: string;
  readonly reason: string;
  readonly expiresAt?: string;
  readonly now?: Date;
}

export interface BiographicalGrantRevokeInput {
  readonly reason: string;
  readonly now?: Date;
}

/**
 * Prepared claim: validated, canonicalized, digested, with automatic
 * sensitivity. Effective sensitivity is finalized once applicable grants are
 * known. Carries everything needed to persist except the id (assigned by the
 * adapter when omitted).
 */
export interface PreparedBiographicalClaim {
  readonly id: string;
  readonly subject: BiographicalSubjectRef;
  readonly relatedSubject?: BiographicalSubjectRef;
  readonly kind: BiographicalClaimKind;
  readonly value: BiographicalClaimValue;
  readonly basis: BiographicalClaimBasis;
  readonly status: BiographicalClaimStatus;
  readonly sources: readonly BiographicalClaimSource[];
  readonly proposedSensitivity: SensitivityLevel;
  readonly confidence: number;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly automaticSensitivity: SensitivityLevel;
  readonly synthesizedAt: string;
  readonly lastSourceValidatedAt: string;
  readonly lastEvidenceAt: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesClaimId?: string;
  readonly depthDecision?: BiographicalCollectionDepth;
}

function canonicalNow(now: Date): string {
  return now.toISOString();
}

/**
 * Validate and canonicalize a write input into a prepared claim with computed
 * digests and automatic sensitivity. Throws {@link BiographicalClaimValidationError}
 * (or grant/lifecycle errors) on any malformed input. Both adapters call this
 * so the stored shape is identical.
 */
export function prepareBiographicalClaim(
  input: BiographicalClaimWriteInput,
  options: { defaultStatus?: BiographicalClaimStatus } = {},
): PreparedBiographicalClaim {
  const now = input.now ?? new Date();
  const nowIso = canonicalNow(now);
  assertKnownClaimKind(input.kind);
  const subject = assertSubjectRef(input.subject, 'subject');
  const relatedSubject =
    input.relatedSubject !== undefined
      ? assertSubjectRef(input.relatedSubject, 'relatedSubject')
      : undefined;
  const value = canonicalizeClaimValue(input.kind, input.value);
  assertRelatedSubjectShape(input.kind, value, relatedSubject, subject);
  const basis = assertClaimBasis(input.basis);
  const status = assertClaimStatus(input.status ?? options.defaultStatus ?? 'candidate');
  const sources = assertSources(input.sources);
  const confidence = assertConfidence(input.confidence);
  const interval = assertValidInterval({ validFrom: input.validFrom, validTo: input.validTo });
  assertClaimValidityRule(input.kind, interval);
  const depthDecision = assertCollectionDepth(input.depthDecision);
  if (
    input.proposedSensitivity !== undefined
    && !isValidSensitivityLevel(input.proposedSensitivity)
  ) {
    throw new BiographicalClaimValidationError(
      'proposedSensitivity must be a supported sensitivity level',
    );
  }
  const proposedSensitivity = input.proposedSensitivity ?? 'personal';
  const { sensitivity: automaticSensitivity } = computeAutomaticSensitivity({
    kind: input.kind,
    proposedSensitivity,
    sources,
    now,
  });
  const claimDigest = computeClaimDigest({
    schemaVersion: BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
    normalizerVersion: BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
    subject,
    ...(relatedSubject !== undefined ? { relatedSubject } : {}),
    kind: input.kind,
    value,
  });
  const sourceSetDigest = computeSourceSetDigest(sources);
  return {
    id: input.id ?? randomUUID(),
    subject,
    ...(relatedSubject !== undefined ? { relatedSubject } : {}),
    kind: input.kind,
    value,
    basis,
    status,
    sources,
    confidence,
    proposedSensitivity,
    claimDigest,
    sourceSetDigest,
    automaticSensitivity,
    synthesizedAt: nowIso,
    lastSourceValidatedAt: nowIso,
    // Source revisions are opaque identifiers, not evidence timestamps. Until
    // the source contract carries an explicit observed-at field, admission time
    // is the only truthful recency statement the kernel can make.
    lastEvidenceAt: nowIso,
    ...(interval.validFrom !== undefined ? { validFrom: interval.validFrom } : {}),
    ...(interval.validTo !== undefined ? { validTo: interval.validTo } : {}),
    ...(input.supersedesClaimId !== undefined
      ? { supersedesClaimId: input.supersedesClaimId }
      : {}),
    ...(depthDecision !== 'recognition' ? { depthDecision } : {}),
  };
}

/**
 * Apply known grants to a prepared claim, producing the final stored claim with
 * the effective-sensitivity cache and applied-grant id. Both adapters call this.
 */
export function finalizeBiographicalClaim(
  prepared: PreparedBiographicalClaim,
  grants: readonly BiographicalSensitivityGrant[],
  now: Date,
): BiographicalClaim {
  const result = applyLoweringGrant({
    claimDigest: prepared.claimDigest,
    sourceSetDigest: prepared.sourceSetDigest,
    automaticSensitivity: prepared.automaticSensitivity,
    grants,
    now,
  });
  return assembleCanonicalClaim({
    id: prepared.id,
    subject: prepared.subject,
    ...(prepared.relatedSubject !== undefined ? { relatedSubject: prepared.relatedSubject } : {}),
    kind: prepared.kind,
    value: prepared.value,
    basis: prepared.basis,
    status: prepared.status,
    sources: prepared.sources,
    proposedSensitivity: prepared.proposedSensitivity,
    effectiveSensitivity: result.effectiveSensitivity,
    ...(result.appliedGrant !== undefined ? { appliedGrantId: result.appliedGrant.id } : {}),
    confidence: prepared.confidence,
    synthesizedAt: prepared.synthesizedAt,
    lastSourceValidatedAt: prepared.lastSourceValidatedAt,
    lastEvidenceAt: prepared.lastEvidenceAt,
    ...(prepared.validFrom !== undefined ? { validFrom: prepared.validFrom } : {}),
    ...(prepared.validTo !== undefined ? { validTo: prepared.validTo } : {}),
    ...(prepared.supersedesClaimId !== undefined
      ? { supersedesClaimId: prepared.supersedesClaimId }
      : {}),
    ...(prepared.depthDecision !== undefined ? { depthDecision: prepared.depthDecision } : {}),
  });
}

/**
 * Re-evaluate the effective-sensitivity cache of a stored claim against the
 * current grant set. Returns the claim unchanged (new reference) when no grant
 * applies, or a claim with the cache updated. Used after grant record/revoke.
 */
export function reevaluateClaimEffective(
  claim: BiographicalClaim,
  grants: readonly BiographicalSensitivityGrant[],
  now: Date,
): BiographicalClaim {
  // Recompute the automatic floor from live sources + kind floor + proposal
  // exactly as write time did, then apply exact digest-bound lowering grants.
  const { sensitivity: automatic } = computeAutomaticSensitivity({
    kind: claim.kind,
    proposedSensitivity: claim.proposedSensitivity,
    sources: claim.sources,
    now,
  });
  const result = applyLoweringGrant({
    claimDigest: claim.claimDigest,
    sourceSetDigest: claim.sourceSetDigest,
    automaticSensitivity: automatic,
    grants,
    now,
  });
  const effective = result.effectiveSensitivity;
  const appliedGrantId = result.appliedGrant !== undefined ? result.appliedGrant.id : undefined;
  if (
    effective === claim.effectiveSensitivity
    && appliedGrantId === claim.appliedGrantId
  ) {
    return claim;
  }
  const { appliedGrantId: _dropped, ...rest } = claim;
  void _dropped;
  return { ...rest, effectiveSensitivity: effective, ...(appliedGrantId !== undefined ? { appliedGrantId } : {}) };
}

/** Validate and normalize a grant write input, assigning an id and timestamps. */
export function prepareBiographicalGrant(
  input: BiographicalGrantWriteInput,
): { grant: Omit<BiographicalSensitivityGrant, 'id'>; id: string } {
  const validated = assertGrantInput(input);
  const now = input.now ?? new Date();
  const grantedAt = canonicalNow(now);
  if (validated.expiresAt !== undefined && Date.parse(validated.expiresAt) <= Date.parse(grantedAt)) {
    throw new Error('grant expiresAt must be strictly after grantedAt');
  }
  return {
    id: randomUUID(),
    grant: {
      schemaVersion: BIOGRAPHICAL_GRANT_SCHEMA_VERSION,
      policyVersion: BIOGRAPHICAL_GRANT_DECISION_REVISION,
      claimDigest: validated.claimDigest,
      sourceSetDigest: validated.sourceSetDigest,
      grantedSensitivity: validated.grantedSensitivity,
      authorizingActor: validated.authorizingActor,
      authorityBasis: validated.authorityBasis,
      reason: validated.reason,
      grantedAt,
      ...(validated.expiresAt !== undefined ? { expiresAt: validated.expiresAt } : {}),
    },
  };
}

/**
 * Assert a claim may transition to `to`, returning the timestamp of the
 * transition for audit. Throws {@link BiographicalLifecycleError} on invalid
 * transitions or terminal claims.
 */
export function assertClaimTransition(
  claim: BiographicalClaim,
  to: BiographicalClaimStatus,
  now: Date,
): string {
  assertLifecycleTransition(claim.status, to);
  void now;
  return canonicalNow(now);
}

/** Serialize/deserialize the full claim envelope to/from persisted JSONB. */
export function serializeClaim(claim: BiographicalClaim): string {
  return JSON.stringify(claim);
}

export function deserializeClaim(stored: unknown): BiographicalClaim {
  let parsed: unknown;
  if (typeof stored === 'string') {
    try {
      parsed = JSON.parse(stored);
    } catch {
      throw new Error('stored claim is not valid JSON');
    }
  } else {
    // JSONB columns come back from pg as already-parsed objects.
    parsed = stored;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('stored claim must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (!hasExactKeys(
    record,
    [
      'id',
      'subject',
      'kind',
      'value',
      'basis',
      'status',
      'schemaVersion',
      'normalizerVersion',
      'claimDigest',
      'sourceSetDigest',
      'sources',
      'proposedSensitivity',
      'effectiveSensitivity',
      'confidence',
      'synthesizedAt',
      'lastSourceValidatedAt',
      'lastEvidenceAt',
    ],
    [
      'relatedSubject',
      'validFrom',
      'validTo',
      'supersedesClaimId',
      'depthDecision',
      'appliedGrantId',
    ],
  )) {
    throw new Error('stored claim has unknown or missing fields');
  }
  if (record.schemaVersion !== BIOGRAPHICAL_CLAIM_SCHEMA_VERSION) {
    throw new Error('stored claim schemaVersion is not supported');
  }
  if (record.normalizerVersion !== BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION) {
    throw new Error('stored claim normalizerVersion is not supported');
  }
  // Re-validate the canonical fields so a corrupted row fails closed on read.
  const subject = assertSubjectRef(record.subject, 'subject');
  const relatedSubject =
    record.relatedSubject !== undefined
      ? assertSubjectRef(record.relatedSubject, 'relatedSubject')
      : undefined;
  const kind = record.kind;
  assertKnownClaimKind(kind);
  const claimValue = canonicalizeClaimValue(kind, record.value);
  assertRelatedSubjectShape(kind, claimValue, relatedSubject, subject);
  const basis = assertClaimBasis(record.basis);
  const status = assertClaimStatus(record.status);
  const sources = assertSources(record.sources);
  const confidence = assertConfidence(record.confidence);
  const interval = assertValidInterval({ validFrom: record.validFrom, validTo: record.validTo });
  assertClaimValidityRule(kind, interval);
  for (const field of ['synthesizedAt', 'lastSourceValidatedAt', 'lastEvidenceAt'] as const) {
    const instant = record[field];
    if (typeof instant !== 'string' || !isCanonicalIsoTimestamp(instant)) {
      throw new Error(`stored claim ${field} must be a canonical ISO instant`);
    }
  }
  if (typeof record.id !== 'string' || record.id.trim().length === 0) {
    throw new Error('stored claim id must be a non-empty string');
  }
  if (typeof record.claimDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(record.claimDigest)) {
    throw new Error('stored claim claimDigest must be a 64-hex digest');
  }
  if (typeof record.sourceSetDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(record.sourceSetDigest)) {
    throw new Error('stored claim sourceSetDigest must be a 64-hex digest');
  }
  const recomputedClaimDigest = computeClaimDigest({
    schemaVersion: BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
    normalizerVersion: BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
    subject,
    ...(relatedSubject !== undefined ? { relatedSubject } : {}),
    kind,
    value: claimValue,
  });
  if (record.claimDigest !== recomputedClaimDigest) {
    throw new Error('stored claim claimDigest does not match canonical content');
  }
  const recomputedSourceSetDigest = computeSourceSetDigest(sources);
  if (record.sourceSetDigest !== recomputedSourceSetDigest) {
    throw new Error('stored claim sourceSetDigest does not match source snapshots');
  }
  for (const field of ['appliedGrantId', 'supersedesClaimId'] as const) {
    if (
      record[field] !== undefined
      && (typeof record[field] !== 'string' || record[field].trim().length === 0)
    ) {
      throw new Error(`stored claim ${field} must be a non-empty string when present`);
    }
  }
  const proposed = record.proposedSensitivity;
  const effective = record.effectiveSensitivity;
  if (typeof proposed !== 'string' || !['public', 'personal', 'intimate', 'confidential'].includes(proposed)) {
    throw new Error('stored claim proposedSensitivity must be a sensitivity level');
  }
  if (typeof effective !== 'string' || !['public', 'personal', 'intimate', 'confidential'].includes(effective)) {
    throw new Error('stored claim effectiveSensitivity must be a sensitivity level');
  }
  return {
    id: record.id,
    subject,
    ...(relatedSubject !== undefined ? { relatedSubject } : {}),
    kind,
    value: claimValue,
    basis,
    status,
    schemaVersion: BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
    normalizerVersion: BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
    claimDigest: record.claimDigest,
    sourceSetDigest: record.sourceSetDigest,
    sources,
    proposedSensitivity: proposed as SensitivityLevel,
    effectiveSensitivity: effective as SensitivityLevel,
    ...(typeof record.appliedGrantId === 'string' && record.appliedGrantId.length > 0
      ? { appliedGrantId: record.appliedGrantId }
      : {}),
    confidence,
    synthesizedAt: record.synthesizedAt as string,
    lastSourceValidatedAt: record.lastSourceValidatedAt as string,
    lastEvidenceAt: record.lastEvidenceAt as string,
    ...(interval.validFrom !== undefined ? { validFrom: interval.validFrom } : {}),
    ...(interval.validTo !== undefined ? { validTo: interval.validTo } : {}),
    ...(typeof record.supersedesClaimId === 'string' && record.supersedesClaimId.length > 0
      ? { supersedesClaimId: record.supersedesClaimId }
      : {}),
    ...(record.depthDecision !== undefined && record.depthDecision !== null
      ? { depthDecision: assertCollectionDepth(record.depthDecision) }
      : {}),
  };
}

function sameSubject(left: BiographicalSubjectRef, right: BiographicalSubjectRef): boolean {
  if (left.kind !== right.kind || left.subjectVersion !== right.subjectVersion) return false;
  return left.kind === 'companion'
    ? right.kind === 'companion' && left.companionId === right.companionId
    : right.kind === 'contact' && left.contactId === right.contactId;
}

/** Supersession may revise only the same canonical subject/kind relationship. */
export function assertCompatibleSupersession(
  prior: BiographicalClaim,
  next: PreparedBiographicalClaim,
): void {
  const relatedMatches = prior.relatedSubject === undefined
    ? next.relatedSubject === undefined
    : next.relatedSubject !== undefined && sameSubject(prior.relatedSubject, next.relatedSubject);
  if (
    prior.kind !== next.kind
    || !sameSubject(prior.subject, next.subject)
    || !relatedMatches
  ) {
    throw new Error('superseding claim must target the same canonical subject and claim kind');
  }
}

export interface BiographicalProfileStorePort {
  writeClaim(input: BiographicalClaimWriteInput): Promise<BiographicalClaim>;
  getClaim(id: string): Promise<BiographicalClaim | undefined>;
  listClaims(options?: BiographicalClaimListOptions): Promise<BiographicalClaim[]>;
  /** Append-only supersession: creates a new claim and marks the prior terminal. */
  supersedeClaim(input: BiographicalSupersessionInput): Promise<BiographicalSupersessionResult>;
  /** Lifecycle transition (candidate→active, active→contested, …). */
  transitionClaim(input: BiographicalTransitionInput): Promise<BiographicalClaim>;
  recordGrant(input: BiographicalGrantWriteInput): Promise<BiographicalSensitivityGrant>;
  /** Grants whose digests match the claim's current digests. */
  listGrantsForClaim(claimId: string): Promise<BiographicalSensitivityGrant[]>;
  revokeGrant(grantId: string, input: BiographicalGrantRevokeInput): Promise<BiographicalSensitivityGrant>;
  getGrant(grantId: string): Promise<BiographicalSensitivityGrant | undefined>;
}
