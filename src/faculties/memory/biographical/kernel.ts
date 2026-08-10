import { createHash } from 'node:crypto';

import {
  classifyArtifactSensitivity,
  type ArtifactSensitivitySource,
} from '../../../shared/contracts/artifact-sensitivity.js';
import { hasExactKeys, isCanonicalIsoTimestamp, isRecord } from '../../../shared/utils/types.js';
import {
  sensitivityOrd,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  BIOGRAPHICAL_CLAIM_BASES,
  BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
  BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
  BIOGRAPHICAL_CLAIM_STATUSES,
  BIOGRAPHICAL_CLAIM_STATUSES as CLAIM_STATUSES,
  BIOGRAPHICAL_COLLECTION_DEPTHS,
  BIOGRAPHICAL_GRANT_DECISION_REVISION,
  BIOGRAPHICAL_GRANT_SCHEMA_VERSION,
  BIOGRAPHICAL_TERMINAL_STATUSES,
} from './types.js';
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
  BiographicalClaimValidationError,
  claimKindFloor,
  isValidSensitivityLevel,
} from './claim-kinds.js';

const BIOGRAPHICAL_SOURCE_REF_PATTERN = /^[a-z][a-z0-9_-]*:[^\s]+$/u;
const BIOGRAPHICAL_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Fixed source slots in the v1 claim envelope; not a mutable extraction budget. */
export const BIOGRAPHICAL_SOURCE_SLOTS = 16;

// ── Canonical hashing ──

/**
 * Deterministic JSON serialization: object keys sorted ascending, arrays in
 * given order, primitives verbatim. Used for every digest so re-running the
 * same structured inputs under the same versions always produces the same
 * digest, independent of field declaration order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Canonical subject identity included in the claim digest. Versions are part of
 * the identity so a contact merge (new version) intentionally produces a new
 * claim digest, invalidating any grant bound to the prior digest.
 */
function subjectDigestIdentity(subject: BiographicalSubjectRef): unknown {
  return subject.kind === 'companion'
    ? { kind: 'companion', companionId: subject.companionId, subjectVersion: subject.subjectVersion }
    : { kind: 'contact', contactId: subject.contactId, subjectVersion: subject.subjectVersion };
}

/**
 * Claim content digest: SHA-256 over canonical structured content covering
 * schema/normalizer versions, exact subject + related-subject identity, kind,
 * and the canonicalized structured value. Excludes ids, timestamps, extraction
 * run ids, sensitivity, confidence, sources, and audit notes. Semantically
 * identical structured re-extraction under the same versions is digest-stable.
 */
export function computeClaimDigest(input: {
  schemaVersion: number;
  normalizerVersion: number;
  subject: BiographicalSubjectRef;
  relatedSubject?: BiographicalSubjectRef;
  kind: BiographicalClaimKind;
  value: BiographicalClaimValue;
}): string {
  const base = {
    schemaVersion: input.schemaVersion,
    normalizerVersion: input.normalizerVersion,
    subject: subjectDigestIdentity(input.subject),
    ...(input.relatedSubject ? { relatedSubject: subjectDigestIdentity(input.relatedSubject) } : {}),
    kind: input.kind,
    value: input.value,
  };
  return sha256(canonicalJson(base));
}

/**
 * Source-set digest: SHA-256 over the canonically ordered source snapshots,
 * including revision, evidence digest, sensitivity, subject-evidence digest,
 * consent fingerprint, and channel epoch. Any source drift changes this digest,
 * which invalidates any grant bound to the prior source-set digest.
 */
export function computeSourceSetDigest(sources: readonly BiographicalClaimSource[]): string {
  const normalized = sources.map(canonicalSourceRecord);
  normalized.sort((left, right) => {
    if (left.ref !== right.ref) return left.ref < right.ref ? -1 : 1;
    if (left.revision !== right.revision) return left.revision < right.revision ? -1 : 1;
    return 0;
  });
  return sha256(canonicalJson(normalized));
}

function canonicalSourceRecord(source: BiographicalClaimSource): CanonicalSourceDigestRecord {
  return {
    ref: source.ref,
    revision: source.revision,
    evidenceDigest: source.evidenceDigest,
    sensitivityAtProjection: source.sensitivityAtProjection,
    subjectEvidenceDigest: source.subjectEvidenceDigest,
    consentFingerprint: source.consentFingerprint,
    ...(source.sourceChannelId !== undefined ? { sourceChannelId: source.sourceChannelId } : {}),
    ...(source.sourceChannelEpoch !== undefined
      ? { sourceChannelEpoch: source.sourceChannelEpoch }
      : {}),
  };
}

interface CanonicalSourceDigestRecord {
  readonly ref: string;
  readonly revision: string;
  readonly evidenceDigest: string;
  readonly sensitivityAtProjection: SensitivityLevel;
  readonly subjectEvidenceDigest: string;
  readonly consentFingerprint: string;
  readonly sourceChannelId?: string;
  readonly sourceChannelEpoch?: number;
}

// ── Validation (fail closed) ──

export { BiographicalClaimValidationError } from './claim-kinds.js';

function fail(message: string): never {
  throw new BiographicalClaimValidationError(message);
}

export function assertSubjectRef(value: unknown, field: string): BiographicalSubjectRef {
  if (!isRecord(value)) fail(`${field} must be an object`);
  if (value.kind === 'companion') {
    if (!hasExactKeys(value, ['kind', 'companionId', 'subjectVersion'])) {
      fail(`${field} has an invalid companion subject shape`);
    }
    if (typeof value.companionId !== 'string' || value.companionId.trim().length === 0) {
      fail(`${field}.companionId must be a non-empty string`);
    }
    const companionId = value.companionId.trim();
    const subjectVersion = assertPositiveInteger(value.subjectVersion, `${field}.subjectVersion`);
    return {
      kind: 'companion',
      companionId,
      subjectVersion,
    };
  }
  if (value.kind === 'contact') {
    if (!hasExactKeys(value, ['kind', 'contactId', 'subjectVersion'])) {
      fail(`${field} has an invalid contact subject shape`);
    }
    if (typeof value.contactId !== 'string' || value.contactId.trim().length === 0) {
      fail(`${field}.contactId must be a non-empty string`);
    }
    const contactId = value.contactId.trim();
    const subjectVersion = assertPositiveInteger(value.subjectVersion, `${field}.subjectVersion`);
    return { kind: 'contact', contactId, subjectVersion };
  }
  fail(`${field}.kind must be one of: companion, contact`);
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    fail(`${field} must be a positive integer`);
  }
  return value;
}

export function assertClaimBasis(value: unknown): BiographicalClaimBasis {
  if (typeof value !== 'string' || !(BIOGRAPHICAL_CLAIM_BASES as readonly string[]).includes(value)) {
    fail(`basis must be one of: ${BIOGRAPHICAL_CLAIM_BASES.join(', ')}`);
  }
  return value as BiographicalClaimBasis;
}

export function assertClaimStatus(value: unknown): BiographicalClaimStatus {
  if (typeof value !== 'string' || !(CLAIM_STATUSES as readonly string[]).includes(value)) {
    fail(`status must be one of: ${BIOGRAPHICAL_CLAIM_STATUSES.join(', ')}`);
  }
  return value as BiographicalClaimStatus;
}

export function assertCollectionDepth(value: unknown): BiographicalCollectionDepth {
  if (
    value === undefined
    || value === null
  ) {
    return 'recognition';
  }
  if (
    typeof value !== 'string'
    || !(BIOGRAPHICAL_COLLECTION_DEPTHS as readonly string[]).includes(value)
  ) {
    fail(`depthDecision must be one of: ${BIOGRAPHICAL_COLLECTION_DEPTHS.join(', ')}`);
  }
  return value as BiographicalCollectionDepth;
}

export function assertConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail('confidence must be a finite number between 0 and 1');
  }
  return value;
}

function assertSource(value: unknown, index: number): BiographicalClaimSource {
  if (!isRecord(value)) fail(`sources[${index}] must be an object`);
  if (!hasExactKeys(
    value,
    [
      'ref',
      'revision',
      'evidenceDigest',
      'sensitivityAtProjection',
      'subjectEvidenceDigest',
      'consentFingerprint',
    ],
    ['sourceChannelId', 'sourceChannelEpoch'],
  )) {
    fail(`sources[${index}] has unknown or missing fields`);
  }
  if (typeof value.ref !== 'string' || !BIOGRAPHICAL_SOURCE_REF_PATTERN.test(value.ref)) {
    fail(`sources[${index}].ref must be a content-free provenance reference like "memory:<id>"`);
  }
  if (typeof value.revision !== 'string' || value.revision.trim().length === 0) {
    fail(`sources[${index}].revision must be a non-empty string`);
  }
  if (
    typeof value.evidenceDigest !== 'string'
    || !BIOGRAPHICAL_SHA256_PATTERN.test(value.evidenceDigest)
  ) {
    fail(`sources[${index}].evidenceDigest must be a 64-hex SHA-256 digest`);
  }
  if (!isValidSensitivityLevel(value.sensitivityAtProjection)) {
    fail(`sources[${index}].sensitivityAtProjection must be a sensitivity level`);
  }
  if (
    typeof value.subjectEvidenceDigest !== 'string'
    || !BIOGRAPHICAL_SHA256_PATTERN.test(value.subjectEvidenceDigest)
  ) {
    fail(`sources[${index}].subjectEvidenceDigest must be a 64-hex SHA-256 digest`);
  }
  if (
    typeof value.consentFingerprint !== 'string'
    || !BIOGRAPHICAL_SHA256_PATTERN.test(value.consentFingerprint)
  ) {
    fail(`sources[${index}].consentFingerprint must be a 64-hex SHA-256 digest`);
  }
  let sourceChannelId: string | undefined;
  if (value.sourceChannelId !== undefined) {
    if (typeof value.sourceChannelId !== 'string' || value.sourceChannelId.trim().length === 0) {
      fail(`sources[${index}].sourceChannelId must be a non-empty string`);
    }
    sourceChannelId = value.sourceChannelId.trim();
  }
  let sourceChannelEpoch: number | undefined;
  if (value.sourceChannelEpoch !== undefined) {
    sourceChannelEpoch = assertNonNegativeInteger(
      value.sourceChannelEpoch,
      `sources[${index}].sourceChannelEpoch`,
    );
  }
  return {
    ref: value.ref.trim(),
    revision: value.revision.trim(),
    evidenceDigest: value.evidenceDigest,
    sensitivityAtProjection: value.sensitivityAtProjection,
    subjectEvidenceDigest: value.subjectEvidenceDigest,
    consentFingerprint: value.consentFingerprint,
    ...(sourceChannelId !== undefined ? { sourceChannelId } : {}),
    ...(sourceChannelEpoch !== undefined ? { sourceChannelEpoch } : {}),
  };
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer`);
  }
  return value;
}

export function assertSources(
  value: unknown,
): BiographicalClaimSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('sources must be a non-empty array');
  }
  if (value.length > BIOGRAPHICAL_SOURCE_SLOTS) {
    fail(`sources must contain at most ${BIOGRAPHICAL_SOURCE_SLOTS} entries`);
  }
  const parsed = value.map((entry, index) => assertSource(entry, index));
  const seen = new Set<string>();
  for (const source of parsed) {
    const key = `${source.ref}@${source.revision}`;
    if (seen.has(key)) {
      fail(`duplicate source ref+revision: ${key}`);
    }
    seen.add(key);
  }
  return parsed;
}

/** validFrom, if present, must be a canonical ISO instant. */
function assertOptionalInstant(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isCanonicalIsoTimestamp(value)) {
    fail(`${field} must be a canonical UTC ISO-8601 timestamp with millisecond precision`);
  }
  return value;
}

/**
 * Assert valid temporal interval. `validFrom`/`validTo` are both optional, but
 * when both are present `validTo` must not precede `validFrom`. An absent
 * `validFrom` is treated as unbounded-past for ordering checks.
 */
export function assertValidInterval(options: {
  validFrom?: unknown;
  validTo?: unknown;
}): { validFrom?: string; validTo?: string } {
  const validFrom = assertOptionalInstant(options.validFrom, 'validFrom');
  const validTo = assertOptionalInstant(options.validTo, 'validTo');
  if (validFrom && validTo && Date.parse(validTo) < Date.parse(validFrom)) {
    fail('validTo must not precede validFrom');
  }
  return {
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validTo !== undefined ? { validTo } : {}),
  };
}

// ── Sensitivity computation ──

/**
 * Maximum of the kind floor, the proposed sensitivity (defaulting to
 * `personal` when uncertain/missing), and every live source sensitivity. Reuses
 * the shared artifact-sensitivity classifier for the source maximum so there is
 * one max-sensitivity primitive, not two.
 */
export function computeAutomaticSensitivity(input: {
  kind: BiographicalClaimKind;
  proposedSensitivity?: SensitivityLevel;
  sources: readonly BiographicalClaimSource[];
  now?: Date;
}): { sensitivity: SensitivityLevel; sourceClassification: ReturnType<typeof classifyArtifactSensitivity> } {
  const sourceInputs: ArtifactSensitivitySource[] = input.sources.map(source => ({
    ref: source.ref,
    sensitivity: source.sensitivityAtProjection,
  }));
  const sourceClassification = classifyArtifactSensitivity(sourceInputs, input.now);
  const proposed: SensitivityLevel = isValidSensitivityLevel(input.proposedSensitivity)
    ? input.proposedSensitivity
    : 'personal';
  const floor = claimKindFloor(input.kind);
  const sensitivity = maxOf(floor, proposed, sourceClassification.sensitivity);
  return { sensitivity, sourceClassification };
}

function maxOf(...levels: readonly SensitivityLevel[]): SensitivityLevel {
  return levels.reduce(
    (highest, level) => (sensitivityOrd(level) > sensitivityOrd(highest) ? level : highest),
    'public',
  );
}

export interface EffectiveSensitivityResult {
  readonly effectiveSensitivity: SensitivityLevel;
  readonly automaticSensitivity: SensitivityLevel;
  readonly appliedGrant: BiographicalSensitivityGrant | undefined;
}

/**
 * Apply an exact digest-bound lowering grant to the automatic sensitivity.
 *
 * A grant lowers the claim below its automatic floor only when it is bound to
 * the claim's exact `claimDigest` AND `sourceSetDigest`, is not revoked, has
 * not expired (at `now`), and grants a sensitivity strictly below the
 * automatic floor. A grant can never raise sensitivity. Collection depth is
 * deliberately ignored: depth controls compute, never disclosure.
 */
export function applyLoweringGrant(
  input: {
    claimDigest: string;
    sourceSetDigest: string;
    automaticSensitivity: SensitivityLevel;
    grants: readonly BiographicalSensitivityGrant[];
    now: Date;
  },
): EffectiveSensitivityResult {
  let effective = input.automaticSensitivity;
  let applied: BiographicalSensitivityGrant | undefined;
  const nowMs = input.now.getTime();
  for (const grant of input.grants) {
    if (grant.revokedAt !== undefined) continue;
    if (Date.parse(grant.grantedAt) > nowMs) continue;
    if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= nowMs) continue;
    if (grant.claimDigest !== input.claimDigest) continue;
    if (grant.sourceSetDigest !== input.sourceSetDigest) continue;
    if (sensitivityOrd(grant.grantedSensitivity) >= sensitivityOrd(input.automaticSensitivity)) {
      continue;
    }
    // A valid lowering grant: take the lowest applicable grant (most permissive
    // authorized lowering). Multiple valid grants cannot lower below the most
    // permissive one an operator signed.
    if (sensitivityOrd(grant.grantedSensitivity) < sensitivityOrd(effective)) {
      effective = grant.grantedSensitivity;
      applied = grant;
    }
  }
  return {
    effectiveSensitivity: effective,
    automaticSensitivity: input.automaticSensitivity,
    appliedGrant: applied,
  };
}

// ── Lifecycle transitions ──

export class BiographicalLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiographicalLifecycleError';
  }
}

const TRANSITIONS: Readonly<Record<BiographicalClaimStatus, readonly BiographicalClaimStatus[]>> = {
  candidate: ['active', 'quarantined', 'contested', 'superseded', 'revoked'],
  active: ['contested', 'superseded', 'revoked'],
  quarantined: ['active', 'contested', 'superseded', 'revoked'],
  contested: ['active', 'superseded', 'revoked'],
  superseded: [],
  revoked: [],
};

export function assertLifecycleTransition(
  from: BiographicalClaimStatus,
  to: BiographicalClaimStatus,
): void {
  if (from === to) return;
  if ((BIOGRAPHICAL_TERMINAL_STATUSES as readonly string[]).includes(from)) {
    throw new BiographicalLifecycleError(
      `claim is terminal (${from}); lifecycle is append-only`,
    );
  }
  const allowed = TRANSITIONS[from] as readonly BiographicalClaimStatus[];
  if (!allowed.includes(to)) {
    throw new BiographicalLifecycleError(`invalid lifecycle transition: ${from} -> ${to}`);
  }
}

// ── Grant validation ──

export class BiographicalGrantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiographicalGrantValidationError';
  }
}

function grantFail(message: string): never {
  throw new BiographicalGrantValidationError(message);
}

export function assertGrantInput(value: unknown): {
  claimDigest: string;
  sourceSetDigest: string;
  grantedSensitivity: SensitivityLevel;
  authorizingActor: BiographicalSensitivityGrant['authorizingActor'];
  authorityBasis: string;
  reason: string;
  expiresAt?: string;
} {
  if (!isRecord(value)) grantFail('grant input must be an object');
  if (!hasExactKeys(
    value,
    [
      'claimDigest',
      'sourceSetDigest',
      'grantedSensitivity',
      'authorizingActor',
      'authorityBasis',
      'reason',
    ],
    ['expiresAt', 'now'],
  )) {
    grantFail('grant input has unknown or missing fields');
  }
  if (
    typeof value.claimDigest !== 'string'
    || !BIOGRAPHICAL_SHA256_PATTERN.test(value.claimDigest)
  ) {
    grantFail('claimDigest must be a 64-hex SHA-256 digest');
  }
  if (
    typeof value.sourceSetDigest !== 'string'
    || !BIOGRAPHICAL_SHA256_PATTERN.test(value.sourceSetDigest)
  ) {
    grantFail('sourceSetDigest must be a 64-hex SHA-256 digest');
  }
  if (!isValidSensitivityLevel(value.grantedSensitivity)) {
    grantFail('grantedSensitivity must be a sensitivity level');
  }
  if (
    value.authorizingActor !== 'companion'
    && value.authorizingActor !== 'operator'
    && value.authorizingActor !== 'subject'
  ) {
    grantFail('authorizingActor must be one of: companion, operator, subject');
  }
  if (typeof value.authorityBasis !== 'string' || value.authorityBasis.trim().length === 0) {
    grantFail('authorityBasis must be a non-empty string');
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    grantFail('reason must be a non-empty string');
  }
  const expiresAt = assertOptionalInstant(value.expiresAt, 'expiresAt');
  return {
    claimDigest: value.claimDigest,
    sourceSetDigest: value.sourceSetDigest,
    grantedSensitivity: value.grantedSensitivity,
    authorizingActor: value.authorizingActor,
    authorityBasis: value.authorityBasis.trim(),
    reason: value.reason.trim(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export function assertGrantRecord(value: unknown): BiographicalSensitivityGrant {
  if (!isRecord(value)) throw new BiographicalGrantValidationError('stored grant must be an object');
  if (!hasExactKeys(
    value,
    [
      'id',
      'schemaVersion',
      'policyVersion',
      'claimDigest',
      'sourceSetDigest',
      'grantedSensitivity',
      'authorizingActor',
      'authorityBasis',
      'reason',
      'grantedAt',
    ],
    ['expiresAt', 'revokedAt', 'revokedReason'],
  )) {
    throw new BiographicalGrantValidationError('stored grant has unknown or missing fields');
  }
  if (value.schemaVersion !== BIOGRAPHICAL_GRANT_SCHEMA_VERSION) {
    throw new BiographicalGrantValidationError('grant schemaVersion is not supported');
  }
  if (value.policyVersion !== BIOGRAPHICAL_GRANT_DECISION_REVISION) {
    throw new BiographicalGrantValidationError('grant policyVersion is not supported');
  }
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw new BiographicalGrantValidationError('grant id must be a non-empty string');
  }
  const input = assertGrantInput({
    claimDigest: value.claimDigest,
    sourceSetDigest: value.sourceSetDigest,
    grantedSensitivity: value.grantedSensitivity,
    authorizingActor: value.authorizingActor,
    authorityBasis: value.authorityBasis,
    reason: value.reason,
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
  });
  if (typeof value.grantedAt !== 'string' || !isCanonicalIsoTimestamp(value.grantedAt)) {
    throw new BiographicalGrantValidationError('grantedAt must be a canonical ISO instant');
  }
  if (
    input.expiresAt !== undefined
    && Date.parse(input.expiresAt) <= Date.parse(value.grantedAt)
  ) {
    throw new BiographicalGrantValidationError('expiresAt must be strictly after grantedAt');
  }
  if (value.revokedReason !== undefined && value.revokedAt === undefined) {
    throw new BiographicalGrantValidationError('revokedReason requires revokedAt');
  }
  if (value.revokedAt !== undefined) {
    if (typeof value.revokedAt !== 'string' || !isCanonicalIsoTimestamp(value.revokedAt)) {
      throw new BiographicalGrantValidationError('revokedAt must be a canonical ISO instant');
    }
    if (typeof value.revokedReason !== 'string' || value.revokedReason.trim().length === 0) {
      throw new BiographicalGrantValidationError('revokedReason must be a non-empty string');
    }
    if (Date.parse(value.revokedAt) < Date.parse(value.grantedAt)) {
      throw new BiographicalGrantValidationError('revokedAt must not precede grantedAt');
    }
  }
  const grantedAt = value.grantedAt;
  const revokedAt = typeof value.revokedAt === 'string' ? value.revokedAt : undefined;
  const revokedReason = typeof value.revokedReason === 'string' ? value.revokedReason : undefined;
  return {
    id: value.id,
    schemaVersion: BIOGRAPHICAL_GRANT_SCHEMA_VERSION,
    policyVersion: BIOGRAPHICAL_GRANT_DECISION_REVISION,
    ...input,
    grantedAt,
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    ...(revokedReason !== undefined ? { revokedReason } : {}),
  };
}

// ── Canonical claim assembly ──

export interface CanonicalClaimInput {
  readonly id: string;
  readonly subject: BiographicalSubjectRef;
  readonly relatedSubject?: BiographicalSubjectRef;
  readonly kind: BiographicalClaimKind;
  readonly value: BiographicalClaimValue;
  readonly basis: BiographicalClaimBasis;
  readonly status: BiographicalClaimStatus;
  readonly sources: readonly BiographicalClaimSource[];
  readonly proposedSensitivity: SensitivityLevel;
  readonly effectiveSensitivity: SensitivityLevel;
  readonly appliedGrantId?: string;
  readonly confidence: number;
  readonly synthesizedAt: string;
  readonly lastSourceValidatedAt: string;
  readonly lastEvidenceAt: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesClaimId?: string;
  readonly depthDecision?: BiographicalCollectionDepth;
}

/** Build a {@link BiographicalClaim} with computed digests from canonical inputs. */
export function assembleCanonicalClaim(input: CanonicalClaimInput): BiographicalClaim {
  const claimDigest = computeClaimDigest({
    schemaVersion: BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
    normalizerVersion: BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
    subject: input.subject,
    ...(input.relatedSubject !== undefined ? { relatedSubject: input.relatedSubject } : {}),
    kind: input.kind,
    value: input.value,
  });
  const sourceSetDigest = computeSourceSetDigest(input.sources);
  return {
    id: input.id,
    subject: input.subject,
    ...(input.relatedSubject !== undefined ? { relatedSubject: input.relatedSubject } : {}),
    kind: input.kind,
    value: input.value,
    basis: input.basis,
    status: input.status,
    schemaVersion: BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
    normalizerVersion: BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
    claimDigest,
    sourceSetDigest,
    sources: input.sources,
    proposedSensitivity: input.proposedSensitivity,
    effectiveSensitivity: input.effectiveSensitivity,
    ...(input.appliedGrantId !== undefined ? { appliedGrantId: input.appliedGrantId } : {}),
    confidence: input.confidence,
    synthesizedAt: input.synthesizedAt,
    lastSourceValidatedAt: input.lastSourceValidatedAt,
    lastEvidenceAt: input.lastEvidenceAt,
    ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
    ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
    ...(input.supersedesClaimId !== undefined ? { supersedesClaimId: input.supersedesClaimId } : {}),
    ...(input.depthDecision !== undefined && input.depthDecision !== 'recognition'
      ? { depthDecision: input.depthDecision }
      : {}),
  };
}
