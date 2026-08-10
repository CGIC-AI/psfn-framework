import {
  HUMAN_RELATIONSHIP_TYPES,
  type HumanRelationshipType,
} from '../../../core/contacts/relationship-progression.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import { hasExactKeys, isRecord } from '../../../shared/utils/types.js';
import {
  BiographicalClaimValidationError,
  canonicalizeClaimValue,
  isValidSensitivityLevel,
} from './claim-kinds.js';
import {
  assertClaimBasis,
  assertConfidence,
  assertSources,
  assertSubjectRef,
  computeClaimDigest,
  computeSourceSetDigest,
} from './kernel.js';
import type { BiographicalProfileStorePort } from './store-port.js';
import {
  BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
  BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
  type BiographicalClaim,
  type BiographicalClaimBasis,
  type BiographicalClaimKind,
  type BiographicalClaimSource,
  type BiographicalClaimValue,
  type BiographicalSubjectRef,
} from './types.js';

export type CurrentAuthorIdentityCandidate =
  | { readonly kind: 'name'; readonly name: string; readonly role: 'primary' | 'alias' }
  | { readonly kind: 'relationship'; readonly relationshipType: HumanRelationshipType }
  | { readonly kind: 'relational_nickname'; readonly nickname: string };

export interface CurrentAuthorIdentityEvidence {
  readonly currentAuthorSubject: BiographicalSubjectRef;
  readonly companionSubject: BiographicalSubjectRef;
  readonly value: CurrentAuthorIdentityCandidate;
  readonly sources: readonly BiographicalClaimSource[];
  readonly confidence: number;
  readonly basis: BiographicalClaimBasis;
  readonly proposedSensitivity?: SensitivityLevel;
  readonly attribution: {
    readonly status: 'complete' | 'incomplete';
    readonly participantSubjects: readonly BiographicalSubjectRef[];
  };
  readonly now?: Date;
}

interface MappedCurrentAuthorClaim {
  readonly subject: BiographicalSubjectRef;
  readonly relatedSubject?: BiographicalSubjectRef;
  readonly kind: BiographicalClaimKind;
  readonly value: BiographicalClaimValue;
}

export interface CurrentAuthorIdentityCandidateFingerprint {
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
}

export type CurrentAuthorIdentitySynthesizer = (
  evidence: CurrentAuthorIdentityEvidence,
) => Promise<CurrentAuthorIdentityCandidate>;

export interface CurrentAuthorIdentityIngestResult {
  readonly claim: BiographicalClaim;
  readonly status: 'created' | 'unchanged' | 'superseded';
  readonly superseded?: BiographicalClaim;
}

function sameSubject(left: BiographicalSubjectRef, right: BiographicalSubjectRef): boolean {
  if (left.kind !== right.kind || left.subjectVersion !== right.subjectVersion) return false;
  return left.kind === 'companion'
    ? right.kind === 'companion' && left.companionId === right.companionId
    : right.kind === 'contact' && left.contactId === right.contactId;
}

function assertExactAttribution(
  evidence: CurrentAuthorIdentityEvidence,
  expected: readonly BiographicalSubjectRef[],
): void {
  if (evidence.attribution.status !== 'complete') {
    throw new BiographicalClaimValidationError(
      'current-author identity evidence requires complete canonical attribution',
    );
  }
  const participants = evidence.attribution.participantSubjects.map((subject, index) =>
    assertSubjectRef(subject, `attribution.participantSubjects[${index}]`));
  if (participants.length !== expected.length) {
    throw new BiographicalClaimValidationError(
      'current-author identity evidence contains an unsupported third-party subject',
    );
  }
  const unmatched = [...participants];
  for (const subject of expected) {
    const index = unmatched.findIndex(candidate => sameSubject(candidate, subject));
    if (index < 0) {
      throw new BiographicalClaimValidationError(
        'current-author identity evidence contains an unsupported third-party subject',
      );
    }
    unmatched.splice(index, 1);
  }
}

function mapCurrentAuthorEvidence(
  evidence: CurrentAuthorIdentityEvidence,
): MappedCurrentAuthorClaim {
  const currentAuthor = assertSubjectRef(evidence.currentAuthorSubject, 'currentAuthorSubject');
  const companion = assertSubjectRef(evidence.companionSubject, 'companionSubject');
  if (currentAuthor.kind !== 'contact') {
    throw new BiographicalClaimValidationError('currentAuthorSubject must be a canonical contact');
  }
  if (companion.kind !== 'companion') {
    throw new BiographicalClaimValidationError('companionSubject must be the canonical companion');
  }
  const value: unknown = evidence.value;
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new BiographicalClaimValidationError('current-author identity candidate must be structured');
  }

  if (value.kind === 'name') {
    assertExactAttribution(evidence, [currentAuthor]);
    return {
      subject: currentAuthor,
      kind: 'name',
      value: canonicalizeClaimValue('name', value),
    };
  }
  if (value.kind === 'relationship') {
    if (!hasExactKeys(value, ['kind', 'relationshipType'])) {
      throw new BiographicalClaimValidationError(
        'relationship candidate must contain only kind and relationshipType',
      );
    }
    const relationshipType = typeof value.relationshipType === 'string'
      ? value.relationshipType.trim()
      : '';
    if (!(HUMAN_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType)) {
      throw new BiographicalClaimValidationError(
        'relationshipType must be a registered contact relationship',
      );
    }
    assertExactAttribution(evidence, [currentAuthor, companion]);
    return {
      subject: currentAuthor,
      relatedSubject: companion,
      kind: 'relationship',
      value: canonicalizeClaimValue('relationship', {
        kind: 'relationship',
        relationshipType,
      }),
    };
  }
  if (value.kind === 'relational_nickname') {
    if (!hasExactKeys(value, ['kind', 'nickname'])) {
      throw new BiographicalClaimValidationError(
        'relational nickname candidate must contain only kind and nickname',
      );
    }
    assertExactAttribution(evidence, [currentAuthor, companion]);
    return {
      subject: companion,
      relatedSubject: currentAuthor,
      kind: 'nickname',
      value: canonicalizeClaimValue('nickname', {
        kind: 'nickname',
        nickname: value.nickname,
        scope: 'relational',
      }),
    };
  }
  throw new BiographicalClaimValidationError(
    `Unknown current-author identity candidate kind: ${String(value.kind)}`,
  );
}

function fingerprintMappedClaim(
  claim: MappedCurrentAuthorClaim,
  sources: readonly BiographicalClaimSource[],
): CurrentAuthorIdentityCandidateFingerprint {
  return {
    claimDigest: computeClaimDigest({
      schemaVersion: BIOGRAPHICAL_CLAIM_SCHEMA_VERSION,
      normalizerVersion: BIOGRAPHICAL_CLAIM_NORMALIZER_VERSION,
      subject: claim.subject,
      ...(claim.relatedSubject !== undefined ? { relatedSubject: claim.relatedSubject } : {}),
      kind: claim.kind,
      value: claim.value,
    }),
    sourceSetDigest: computeSourceSetDigest(sources),
  };
}

export function currentAuthorIdentityCandidateFingerprint(
  evidence: CurrentAuthorIdentityEvidence,
): CurrentAuthorIdentityCandidateFingerprint {
  return fingerprintMappedClaim(mapCurrentAuthorEvidence(evidence), assertSources(evidence.sources));
}

/**
 * Ingest one already-attributed current-author identity fact. Candidate kind
 * and subject cardinality are checked before the store or optional synthesizer
 * is reached, preventing gossip-shaped or ambiguous evidence from becoming a
 * portable claim.
 */
export async function ingestCurrentAuthorIdentityEvidence(input: {
  readonly store: BiographicalProfileStorePort;
  readonly evidence: CurrentAuthorIdentityEvidence;
  readonly synthesize?: CurrentAuthorIdentitySynthesizer;
}): Promise<CurrentAuthorIdentityIngestResult> {
  const mapped = mapCurrentAuthorEvidence(input.evidence);
  const sources = assertSources(input.evidence.sources);
  const basis = assertClaimBasis(input.evidence.basis);
  const confidence = assertConfidence(input.evidence.confidence);
  if (
    input.evidence.proposedSensitivity !== undefined
    && !isValidSensitivityLevel(input.evidence.proposedSensitivity)
  ) {
    throw new BiographicalClaimValidationError(
      'proposedSensitivity must be a supported sensitivity level',
    );
  }
  const fingerprint = fingerprintMappedClaim(mapped, sources);
  const active = await input.store.listClaims({
    subject: mapped.subject,
    kind: mapped.kind,
    status: 'active',
  });
  const identical = active.find(claim =>
    claim.claimDigest === fingerprint.claimDigest
    && claim.sourceSetDigest === fingerprint.sourceSetDigest);
  if (identical !== undefined) {
    return { claim: identical, status: 'unchanged' };
  }

  const synthesized = input.synthesize === undefined
    ? input.evidence.value
    : await input.synthesize(input.evidence);
  const synthesizedMapping = mapCurrentAuthorEvidence({
    ...input.evidence,
    value: synthesized,
  });
  const synthesizedFingerprint = fingerprintMappedClaim(
    synthesizedMapping,
    sources,
  );
  if (synthesizedFingerprint.claimDigest !== fingerprint.claimDigest) {
    throw new BiographicalClaimValidationError(
      'current-author synthesis must preserve the validated structured candidate',
    );
  }

  const sharedWrite = {
    subject: synthesizedMapping.subject,
    ...(synthesizedMapping.relatedSubject !== undefined
      ? { relatedSubject: synthesizedMapping.relatedSubject }
      : {}),
    kind: synthesizedMapping.kind,
    value: synthesizedMapping.value,
    basis,
    ...(input.evidence.proposedSensitivity !== undefined
      ? { proposedSensitivity: input.evidence.proposedSensitivity }
      : {}),
    confidence,
    sources,
    ...(input.evidence.now !== undefined ? { now: input.evidence.now } : {}),
  };
  const priorSameClaim = active.find(claim => claim.claimDigest === fingerprint.claimDigest);
  if (priorSameClaim !== undefined) {
    const { superseding, superseded } = await input.store.supersedeClaim({
      supersededClaimId: priorSameClaim.id,
      ...sharedWrite,
    });
    const claim = await input.store.transitionClaim({
      claimId: superseding.id,
      to: 'active',
      ...(input.evidence.now !== undefined ? { now: input.evidence.now } : {}),
    });
    return { claim, superseded, status: 'superseded' };
  }

  const claim = await input.store.writeClaim({ ...sharedWrite, status: 'active' });
  return { claim, status: 'created' };
}
