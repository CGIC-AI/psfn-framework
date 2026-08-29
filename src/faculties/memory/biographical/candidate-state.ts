import { createHash, randomUUID } from 'node:crypto';

import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import {
  BIOGRAPHICAL_SOURCE_LIFECYCLE_STATES,
  normalizeBiographicalCandidatePolicy,
} from '../../../system/config/biographical-candidate-policy.js';
import { MEMORY_POLICY_TYPES } from '../../../system/config/memory-retrieval-policy.js';
import { sensitivityAtMost } from '../../../system/trust/types.js';
import { hasExactKeys, isCanonicalIsoTimestamp, isRecord } from '../../../shared/utils/types.js';
import type {
  BiographicalCandidateReceipt,
  BiographicalCandidateReceiptAuthority,
  BiographicalCandidateReceiptDecision,
  BiographicalCandidateRecord,
  BiographicalCandidateStage,
  BiographicalClaim,
  BiographicalClaimSource,
} from './types.js';
import {
  BIOGRAPHICAL_CANDIDATE_RECEIPT_AUTHORITIES,
  BIOGRAPHICAL_CANDIDATE_STAGES,
} from './types.js';

export interface CandidateReceiptInput {
  readonly authority: BiographicalCandidateReceiptAuthority;
  readonly decision: BiographicalCandidateReceiptDecision;
  readonly actorAuthorityRef: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}

function computeBiographicalCandidatePolicyDigest(
  policy: BiographicalCandidatePolicy,
): string {
  const normalized = normalizeBiographicalCandidatePolicy(policy);
  return createHash('sha256').update(stableStringify(normalized), 'utf8').digest('hex');
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertCandidateSource(
  source: BiographicalClaimSource,
  policy: BiographicalCandidatePolicy,
): void {
  if (
    typeof source.sourceType !== 'string'
    || !(MEMORY_POLICY_TYPES as readonly string[]).includes(source.sourceType)
    || !policy.admittedSourceTypes.includes(source.sourceType)
  ) {
    throw new Error('biography candidate source type is unknown or excluded by owner policy');
  }
  if (
    typeof source.lifecycleStateAtProjection !== 'string'
    || !(BIOGRAPHICAL_SOURCE_LIFECYCLE_STATES as readonly string[])
      .includes(source.lifecycleStateAtProjection)
    || policy.excludedLifecycleStates.includes(source.lifecycleStateAtProjection)
  ) {
    throw new Error('biography candidate source lifecycle is unknown or excluded by owner policy');
  }
  if (!sensitivityAtMost(source.sensitivityAtProjection, policy.maximumSourceSensitivity)) {
    throw new Error('biography candidate source sensitivity exceeds owner policy');
  }
}

function assertBiographicalCandidateAdmission(
  claim: BiographicalClaim,
  policyInput: BiographicalCandidatePolicy,
): BiographicalCandidatePolicy {
  const policy = normalizeBiographicalCandidatePolicy(policyInput);
  if (claim.sources.length > policy.budgets.maxSourcesPerCandidate) {
    throw new Error('biography candidate source budget exceeded');
  }
  for (const source of claim.sources) assertCandidateSource(source, policy);
  return policy;
}

function prepareCandidateReceipt(input: {
  readonly receipt: CandidateReceiptInput;
  readonly candidateRevision: number;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly now: Date;
}): BiographicalCandidateReceipt {
  if (!BIOGRAPHICAL_CANDIDATE_RECEIPT_AUTHORITIES.includes(input.receipt.authority)) {
    throw new Error('unknown biography candidate receipt authority');
  }
  if (!['approved', 'rejected', 'superseded'].includes(input.receipt.decision)) {
    throw new Error('unknown biography candidate receipt decision');
  }
  return {
    id: randomUUID(),
    authority: input.receipt.authority,
    decision: input.receipt.decision,
    actorAuthorityRef: nonEmpty(input.receipt.actorAuthorityRef, 'candidate receipt actorAuthorityRef'),
    candidateRevision: input.candidateRevision,
    claimDigest: input.claimDigest,
    sourceSetDigest: input.sourceSetDigest,
    recordedAt: input.now.toISOString(),
  };
}

export function prepareBiographicalCandidate(input: {
  readonly claim: BiographicalClaim;
  readonly automataRunId: string;
  readonly automataAuthorityRef: string;
  readonly policy: BiographicalCandidatePolicy;
  readonly now: Date;
  readonly supersedesCandidateId?: string;
}): BiographicalCandidateRecord {
  const policy = assertBiographicalCandidateAdmission(input.claim, input.policy);
  if (input.claim.status !== 'candidate') {
    throw new Error('biography candidate claim must begin in candidate status');
  }
  const revision = 1;
  const now = input.now.toISOString();
  return {
    id: randomUUID(),
    claimId: input.claim.id,
    claimDigest: input.claim.claimDigest,
    sourceSetDigest: input.claim.sourceSetDigest,
    automataRunId: nonEmpty(input.automataRunId, 'candidate automataRunId'),
    policyDigest: computeBiographicalCandidatePolicyDigest(policy),
    reviewReceiptLimit: policy.budgets.maxReviewReceiptsPerCandidate,
    revision,
    stage: 'automata_synthesis',
    receipts: [prepareCandidateReceipt({
      receipt: {
        authority: 'automata',
        decision: 'approved',
        actorAuthorityRef: input.automataAuthorityRef,
      },
      candidateRevision: revision,
      claimDigest: input.claim.claimDigest,
      sourceSetDigest: input.claim.sourceSetDigest,
      now: input.now,
    })],
    createdAt: now,
    updatedAt: now,
    ...(input.supersedesCandidateId !== undefined
      ? { supersedesCandidateId: nonEmpty(input.supersedesCandidateId, 'supersedesCandidateId') }
      : {}),
  };
}

function hasReceipt(
  receipts: readonly BiographicalCandidateReceipt[],
  authority: BiographicalCandidateReceiptAuthority,
  decision: BiographicalCandidateReceiptDecision,
): boolean {
  return receipts.some(receipt => receipt.authority === authority && receipt.decision === decision);
}

function assertAutoactivation(
  candidate: BiographicalCandidateRecord,
  claim: BiographicalClaim,
  policyInput: BiographicalCandidatePolicy | undefined,
  receipts: readonly BiographicalCandidateReceipt[],
): void {
  if (policyInput === undefined) {
    throw new Error('companion-only activation requires an exact owner policy receipt');
  }
  const policy = normalizeBiographicalCandidatePolicy(policyInput);
  if (computeBiographicalCandidatePolicyDigest(policy) !== candidate.policyDigest) {
    throw new Error('companion-only activation owner policy revision is stale');
  }
  const auto = policy.companionOnlyAutoactivation;
  if (
    !auto.enabled
    || claim.subject.kind !== 'companion'
    || !auto.scopes.includes('companion_self')
    || !auto.admittedClaimKinds.includes(claim.kind)
    || !auto.admittedBases.includes(claim.basis)
    || !sensitivityAtMost(claim.effectiveSensitivity, auto.maximumSensitivity)
    || !hasReceipt(receipts, 'companion', 'approved')
    || !hasReceipt(receipts, 'owner_policy', 'approved')
  ) {
    throw new Error('candidate is not eligible for companion-only autoactivation');
  }
}

export function assertCandidateClaimBinding(
  candidate: BiographicalCandidateRecord,
  claim: BiographicalClaim,
): void {
  if (
    claim.id !== candidate.claimId
    || claim.claimDigest !== candidate.claimDigest
    || claim.sourceSetDigest !== candidate.sourceSetDigest
  ) {
    throw new Error('biography candidate is not bound to the exact stored claim revision');
  }
}

export function transitionBiographicalCandidate(input: {
  readonly candidate: BiographicalCandidateRecord;
  readonly claim: BiographicalClaim;
  readonly expectedRevision: number;
  readonly to: BiographicalCandidateStage;
  readonly receipts: readonly CandidateReceiptInput[];
  readonly policy?: BiographicalCandidatePolicy;
  readonly now: Date;
}): BiographicalCandidateRecord {
  assertCandidateClaimBinding(input.candidate, input.claim);
  if (!(BIOGRAPHICAL_CANDIDATE_STAGES as readonly unknown[]).includes(input.to)) {
    throw new Error('unknown biography candidate stage');
  }
  if (input.candidate.revision !== input.expectedRevision) {
    throw new Error(
      `stale candidate revision: expected ${input.candidate.revision}, received ${input.expectedRevision}`,
    );
  }
  if (['active', 'rejected', 'superseded'].includes(input.candidate.stage)) {
    throw new Error(`illegal biography candidate transition from terminal ${input.candidate.stage}`);
  }
  const allowed = (
    input.candidate.stage === 'automata_synthesis' && input.to === 'companion_review'
  ) || (
    input.candidate.stage === 'companion_review'
    && ['human_review', 'active', 'rejected', 'superseded'].includes(input.to)
  ) || (
    input.candidate.stage === 'human_review'
    && ['active', 'rejected', 'superseded'].includes(input.to)
  );
  if (!allowed) {
    throw new Error(
      `illegal biography candidate transition ${input.candidate.stage} -> ${input.to}`,
    );
  }
  const newReceipts = input.receipts.map(receipt => prepareCandidateReceipt({
    receipt,
    candidateRevision: input.expectedRevision,
    claimDigest: input.candidate.claimDigest,
    sourceSetDigest: input.candidate.sourceSetDigest,
    now: input.now,
  }));
  const receipts = [...input.candidate.receipts, ...newReceipts];
  if (receipts.length > input.candidate.reviewReceiptLimit) {
    throw new Error('biography candidate review receipt budget exceeded');
  }
  if (input.to === 'human_review' && !hasReceipt(newReceipts, 'companion', 'approved')) {
    throw new Error('human review requires a companion approval receipt');
  }
  if (input.to === 'active') {
    if (input.candidate.stage === 'human_review') {
      if (!hasReceipt(newReceipts, 'human', 'approved')) {
        throw new Error('activation requires a human-reviewer approval receipt');
      }
    } else {
      assertAutoactivation(input.candidate, input.claim, input.policy, newReceipts);
    }
  }
  if (input.to === 'rejected') {
    const expectedAuthority = input.candidate.stage === 'human_review' ? 'human' : 'companion';
    if (!hasReceipt(newReceipts, expectedAuthority, 'rejected')) {
      throw new Error(`candidate rejection requires a ${expectedAuthority} rejection receipt`);
    }
  }
  if (input.to === 'superseded' && !hasReceipt(newReceipts, 'owner_policy', 'superseded')) {
    throw new Error('candidate supersession requires an owner policy receipt');
  }
  return {
    ...input.candidate,
    revision: input.candidate.revision + 1,
    stage: input.to,
    receipts,
    updatedAt: input.now.toISOString(),
  };
}

export function serializeCandidate(candidate: BiographicalCandidateRecord): string {
  return JSON.stringify(candidate);
}

function assertDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`stored biography candidate ${field} must be a SHA-256 digest`);
  }
  return value;
}

export function deserializeCandidate(stored: unknown): BiographicalCandidateRecord {
  const value: unknown = typeof stored === 'string' ? JSON.parse(stored) : stored;
  if (!isRecord(value) || !hasExactKeys(value, [
    'id',
    'claimId',
    'claimDigest',
    'sourceSetDigest',
    'automataRunId',
    'policyDigest',
    'reviewReceiptLimit',
    'revision',
    'stage',
    'receipts',
    'createdAt',
    'updatedAt',
  ], ['supersedesCandidateId'])) {
    throw new Error('stored biography candidate has unknown or missing fields');
  }
  if (!(BIOGRAPHICAL_CANDIDATE_STAGES as readonly unknown[]).includes(value.stage)) {
    throw new Error('stored biography candidate has unknown stage');
  }
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('stored biography candidate revision is invalid');
  }
  const revision = value.revision;
  if (
    typeof value.reviewReceiptLimit !== 'number'
    || !Number.isSafeInteger(value.reviewReceiptLimit)
    || value.reviewReceiptLimit < 1
  ) {
    throw new Error('stored biography candidate review receipt limit is invalid');
  }
  if (!Array.isArray(value.receipts)) {
    throw new Error('stored biography candidate receipts must be an array');
  }
  const receipts = value.receipts.map(receipt => {
    if (!isRecord(receipt) || !hasExactKeys(receipt, [
      'id',
      'authority',
      'decision',
      'actorAuthorityRef',
      'candidateRevision',
      'claimDigest',
      'sourceSetDigest',
      'recordedAt',
    ])) {
      throw new Error('stored biography candidate receipt has unknown or missing fields');
    }
    if (!(BIOGRAPHICAL_CANDIDATE_RECEIPT_AUTHORITIES as readonly unknown[]).includes(receipt.authority)) {
      throw new Error('stored biography candidate receipt has unknown authority');
    }
    if (!['approved', 'rejected', 'superseded'].includes(String(receipt.decision))) {
      throw new Error('stored biography candidate receipt has unknown decision');
    }
    if (
      typeof receipt.candidateRevision !== 'number'
      || !Number.isSafeInteger(receipt.candidateRevision)
      || receipt.candidateRevision < 1
      || receipt.candidateRevision > revision
    ) {
      throw new Error('stored biography candidate receipt revision is invalid');
    }
    if (typeof receipt.recordedAt !== 'string' || !isCanonicalIsoTimestamp(receipt.recordedAt)) {
      throw new Error('stored biography candidate receipt time is invalid');
    }
    return {
      id: nonEmpty(receipt.id, 'stored candidate receipt id'),
      authority: receipt.authority as BiographicalCandidateReceiptAuthority,
      decision: receipt.decision as BiographicalCandidateReceiptDecision,
      actorAuthorityRef: nonEmpty(receipt.actorAuthorityRef, 'stored candidate receipt actorAuthorityRef'),
      candidateRevision: receipt.candidateRevision,
      claimDigest: assertDigest(receipt.claimDigest, 'receipt claimDigest'),
      sourceSetDigest: assertDigest(receipt.sourceSetDigest, 'receipt sourceSetDigest'),
      recordedAt: receipt.recordedAt,
    };
  });
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (typeof value[field] !== 'string' || !isCanonicalIsoTimestamp(value[field])) {
      throw new Error(`stored biography candidate ${field} is invalid`);
    }
  }
  const createdAt = value.createdAt as string;
  const updatedAt = value.updatedAt as string;
  const claimDigest = assertDigest(value.claimDigest, 'claimDigest');
  const sourceSetDigest = assertDigest(value.sourceSetDigest, 'sourceSetDigest');
  if (
    !receipts.some(receipt => receipt.authority === 'automata' && receipt.decision === 'approved')
    || receipts.some(receipt => (
      receipt.claimDigest !== claimDigest || receipt.sourceSetDigest !== sourceSetDigest
    ))
  ) {
    throw new Error('stored biography candidate receipts are not bound to the candidate digests');
  }
  return {
    id: nonEmpty(value.id, 'stored candidate id'),
    claimId: nonEmpty(value.claimId, 'stored candidate claimId'),
    claimDigest,
    sourceSetDigest,
    automataRunId: nonEmpty(value.automataRunId, 'stored candidate automataRunId'),
    policyDigest: assertDigest(value.policyDigest, 'policyDigest'),
    reviewReceiptLimit: value.reviewReceiptLimit,
    revision,
    stage: value.stage as BiographicalCandidateStage,
    receipts,
    createdAt,
    updatedAt,
    ...(value.supersedesCandidateId !== undefined
      ? { supersedesCandidateId: nonEmpty(value.supersedesCandidateId, 'stored supersedesCandidateId') }
      : {}),
  };
}
