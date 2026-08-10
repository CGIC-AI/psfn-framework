import type { BiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import { trustAtLeast, type TrustLevel } from '../../../system/trust/types.js';
import type { BiographicalCollectionDepth, BiographicalSubjectRef } from './types.js';

interface VerifiedGovernedContextEvidence {
  readonly verified: boolean;
  readonly contextId: string;
  readonly governanceAuthorityRef: string;
  readonly kind: 'dm' | 'group';
  readonly primaryContact: boolean;
}

export interface VerifiedContactDepthEvidence {
  readonly subject: Extract<BiographicalSubjectRef, { kind: 'contact' }>;
  readonly canonicalContactVerified: boolean;
  readonly trust?: {
    readonly verified: boolean;
    readonly level: TrustLevel;
    readonly authorityRef: string;
  };
  readonly relationship?: {
    readonly verified: boolean;
    readonly type: 'partner' | 'friend' | 'family' | 'other';
    readonly authorityRef: string;
  };
  readonly governedContexts: readonly VerifiedGovernedContextEvidence[];
}

function hasAuthorityRef(value: string): boolean {
  return /^[a-z][a-z0-9_-]*:[^\s]+$/u.test(value);
}

function verifiedContextKeys(evidence: VerifiedContactDepthEvidence): Set<string> {
  const keys = new Set<string>();
  for (const context of evidence.governedContexts) {
    if (!context.verified || !hasAuthorityRef(context.governanceAuthorityRef)) continue;
    if (context.contextId.trim().length === 0) continue;
    keys.add(`${context.governanceAuthorityRef}:${context.contextId}`);
  }
  return keys;
}

/**
 * Compute canonical collection depth only from verified canonical-contact,
 * relationship, trust and governed-context evidence. Labels, room rosters,
 * inferred familiarity and model output are intentionally absent inputs.
 */
export function deriveBiographicalCollectionDepth(input: {
  readonly subject: BiographicalSubjectRef;
  readonly contactEvidence?: VerifiedContactDepthEvidence;
  readonly policy: BiographicalDepthPolicy;
}): BiographicalCollectionDepth {
  if (input.subject.kind === 'companion') return 'full';
  const evidence = input.contactEvidence;
  if (
    evidence === undefined
    || evidence.subject.contactId !== input.subject.contactId
    || evidence.subject.subjectVersion !== input.subject.subjectVersion
    || !evidence.canonicalContactVerified
  ) {
    return 'recognition';
  }
  const trust = evidence.trust;
  if (
    trust === undefined
    || !trust.verified
    || !hasAuthorityRef(trust.authorityRef)
  ) return 'recognition';
  const relationship = evidence.relationship;
  if (
    relationship !== undefined
    && relationship.verified
    && hasAuthorityRef(relationship.authorityRef)
    && relationship.type !== 'other'
    && trustAtLeast(trust.level, 'trusted')
  ) {
    return 'full';
  }

  const contextKeys = verifiedContextKeys(evidence);
  const primaryVerifiedDm = evidence.governedContexts.some(context =>
    context.verified
    && context.kind === 'dm'
    && context.primaryContact
    && hasAuthorityRef(context.governanceAuthorityRef));
  if (
    trustAtLeast(trust.level, 'regular')
    && (
      contextKeys.size >= input.policy.developingIndependentContextMinimum
      || (trust.level === 'primary' && primaryVerifiedDm)
    )
  ) {
    return 'developing';
  }
  return 'recognition';
}

const DEPTH_ORDER: Readonly<Record<BiographicalCollectionDepth, number>> = {
  recognition: 0,
  developing: 1,
  full: 2,
};

export interface BiographicalDepthTransitionPlan {
  readonly previousDepth: BiographicalCollectionDepth;
  readonly depth: BiographicalCollectionDepth;
  readonly promoted: boolean;
  readonly demoted: boolean;
  readonly enrichmentAllowed: boolean;
  readonly backfillClaimLimit: number;
  readonly ordinaryTrustCeiling: TrustLevel;
  readonly sensitivityEffect: 'unchanged';
  readonly disclosureEffect: 'unchanged';
  readonly deleteHistory: false;
}

export function planBiographicalDepthTransition(input: {
  readonly previousDepth: BiographicalCollectionDepth;
  readonly depth: BiographicalCollectionDepth;
  readonly verifiedTrustLevel: TrustLevel;
  readonly policy: BiographicalDepthPolicy;
}): BiographicalDepthTransitionPlan {
  const promoted = DEPTH_ORDER[input.depth] > DEPTH_ORDER[input.previousDepth];
  const demoted = DEPTH_ORDER[input.depth] < DEPTH_ORDER[input.previousDepth];
  const mode = input.policy[input.depth];
  return {
    previousDepth: input.previousDepth,
    depth: input.depth,
    promoted,
    demoted,
    enrichmentAllowed: !demoted && input.depth !== 'recognition',
    backfillClaimLimit: promoted ? mode.backfillBatchLimit : 0,
    ordinaryTrustCeiling: demoted && trustAtLeast(input.verifiedTrustLevel, 'trusted')
      ? 'regular'
      : input.verifiedTrustLevel,
    sensitivityEffect: 'unchanged',
    disclosureEffect: 'unchanged',
    deleteHistory: false,
  };
}

export type BiographicalDepthBoundedPhase =
  | 'refresh'
  | 'operation'
  | 'turn'
  | 'backfill'
  | 'compaction';

export function boundBiographicalDepthWork<T>(input: {
  readonly values: readonly T[];
  readonly depth: BiographicalCollectionDepth;
  readonly phase: BiographicalDepthBoundedPhase;
  readonly policy: BiographicalDepthPolicy;
}): readonly T[] {
  const mode = input.policy[input.depth];
  const limit = input.phase === 'refresh'
    ? mode.candidateLimitPerRefresh
    : input.phase === 'operation'
      ? mode.operationClaimLimit
      : input.phase === 'turn'
        ? mode.turnClaimLimit
        : input.phase === 'backfill'
          ? mode.backfillBatchLimit
          : mode.compactionBatchLimit;
  return input.values.slice(0, limit);
}

export function biographicalRetentionLimit(
  depth: BiographicalCollectionDepth,
  policy: BiographicalDepthPolicy,
): number | undefined {
  return policy[depth].retentionClaimLimit ?? undefined;
}
