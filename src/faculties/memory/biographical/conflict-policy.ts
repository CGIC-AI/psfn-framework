import { claimConflictKey, claimValuesCanCoexist } from './claim-kinds.js';
import { prepareBiographicalClaim } from './store-port.js';
import type {
  BiographicalClaimWriteInput,
  BiographicalProfileStorePort,
} from './store-port.js';
import type { BiographicalClaim, BiographicalSubjectRef } from './types.js';

export interface SubjectCorrectionAuthority {
  readonly actor: 'subject';
  readonly subject: BiographicalSubjectRef;
  readonly authorizationRef: string;
}

type BiographicalAdmissionDisposition =
  | 'coexisting'
  | 'deduplicated'
  | 'contested'
  | 'corrected'
  | 'quarantined';

export interface BiographicalAdmissionResult {
  readonly claim: BiographicalClaim;
  readonly disposition: BiographicalAdmissionDisposition;
  readonly affectedClaims: readonly BiographicalClaim[];
}

function sameSubject(
  left: BiographicalSubjectRef,
  right: BiographicalSubjectRef,
): boolean {
  if (left.kind !== right.kind || left.subjectVersion !== right.subjectVersion) return false;
  return left.kind === 'companion'
    ? right.kind === 'companion' && left.companionId === right.companionId
    : right.kind === 'contact' && left.contactId === right.contactId;
}

function assertCorrectionAuthority(
  candidate: BiographicalClaimWriteInput,
  authority: SubjectCorrectionAuthority | undefined,
): boolean {
  if (authority === undefined) return false;
  if (candidate.basis !== 'explicit') {
    throw new Error('subject correction authority requires an explicit candidate');
  }
  if (!sameSubject(candidate.subject, authority.subject)) {
    throw new Error('subject correction authority must match the corrected subject');
  }
  if (!/^[a-z][a-z0-9_-]*:[^\s]+$/u.test(authority.authorizationRef)) {
    throw new Error('subject correction authorizationRef must be a content-free provenance reference');
  }
  return true;
}

function conflictKeyForClaim(claim: BiographicalClaim): string {
  return claimConflictKey(
    claim.kind,
    claim.subject,
    claim.value,
    claim.relatedSubject,
  );
}

function stableClaimOrder(left: BiographicalClaim, right: BiographicalClaim): number {
  const timestampOrder = left.synthesizedAt.localeCompare(right.synthesizedAt);
  return timestampOrder !== 0 ? timestampOrder : left.id.localeCompare(right.id);
}

/**
 * Admit one already-structured candidate under the deterministic conflict
 * policy. Set-valued keys coexist. Opposing values on the same normalized key
 * contest both sides. Only an authorized, explicit correction from the exact
 * subject may supersede non-explicit evidence; all history remains append-only.
 * A semantic-conflict signal quarantines only the candidate and never mutates
 * an active claim.
 */
interface BiographicalAdmissionInput {
  readonly store: BiographicalProfileStorePort;
  readonly candidate: BiographicalClaimWriteInput;
  readonly semanticConflict?: boolean;
  readonly correctionAuthority?: SubjectCorrectionAuthority;
}

async function admitBiographicalCandidateInTransaction(
  input: BiographicalAdmissionInput,
): Promise<BiographicalAdmissionResult> {
  if (input.candidate.status !== undefined) {
    throw new Error('candidate lifecycle status is decided by the admission policy');
  }
  const prepared = prepareBiographicalClaim({
    ...input.candidate,
    status: 'candidate',
  });
  const [active, unresolvedClaims] = await Promise.all([
    input.store.listClaims({
      subject: prepared.subject,
      kind: prepared.kind,
      status: 'active',
    }),
    input.store.listClaims({
      subject: prepared.subject,
      kind: prepared.kind,
      status: 'contested',
    }),
  ]);
  active.sort(stableClaimOrder);
  unresolvedClaims.sort(stableClaimOrder);

  if (input.semanticConflict === true) {
    const claim = await input.store.writeClaim({
      ...input.candidate,
      status: 'quarantined',
    });
    return { claim, disposition: 'quarantined', affectedClaims: [] };
  }

  const candidateKey = claimConflictKey(
    prepared.kind,
    prepared.subject,
    prepared.value,
    prepared.relatedSubject,
  );
  const activeAtKey = active.filter(claim => conflictKeyForClaim(claim) === candidateKey);
  const unresolvedAtKey = unresolvedClaims.filter(
    claim => conflictKeyForClaim(claim) === candidateKey,
  );
  if (unresolvedAtKey.length > 0) {
    const candidate = await input.store.writeClaim({
      ...input.candidate,
      status: 'contested',
    });
    const newlyContested: BiographicalClaim[] = [];
    for (const claim of activeAtKey) {
      newlyContested.push(await input.store.transitionClaim({
        claimId: claim.id,
        to: 'contested',
        ...(input.candidate.now !== undefined ? { now: input.candidate.now } : {}),
      }));
    }
    return {
      claim: candidate,
      disposition: 'contested',
      affectedClaims: newlyContested,
    };
  }

  const identical = active.find(claim => claim.claimDigest === prepared.claimDigest);
  if (identical !== undefined) {
    return { claim: identical, disposition: 'deduplicated', affectedClaims: [] };
  }

  const conflicts = activeAtKey.filter(claim =>
    !claimValuesCanCoexist(prepared.kind, prepared.value, claim.value)
  );
  if (conflicts.length === 0) {
    const claim = await input.store.writeClaim({ ...input.candidate, status: 'active' });
    return { claim, disposition: 'coexisting', affectedClaims: [] };
  }

  const authorizedCorrection = assertCorrectionAuthority(
    input.candidate,
    input.correctionAuthority,
  );
  if (authorizedCorrection && conflicts.every(claim => claim.basis !== 'explicit')) {
    const [prior, ...additional] = conflicts;
    if (prior === undefined) throw new Error('conflict policy invariant violated');
    const result = await input.store.supersedeClaim({
      supersededClaimId: prior.id,
      subject: input.candidate.subject,
      ...(input.candidate.relatedSubject !== undefined
        ? { relatedSubject: input.candidate.relatedSubject }
        : {}),
      kind: input.candidate.kind,
      value: input.candidate.value,
      basis: input.candidate.basis,
      ...(input.candidate.proposedSensitivity !== undefined
        ? { proposedSensitivity: input.candidate.proposedSensitivity }
        : {}),
      confidence: input.candidate.confidence,
      sources: input.candidate.sources,
      ...(input.candidate.validFrom !== undefined
        ? { validFrom: input.candidate.validFrom }
        : {}),
      ...(input.candidate.validTo !== undefined ? { validTo: input.candidate.validTo } : {}),
      ...(input.candidate.depthDecision !== undefined
        ? { depthDecision: input.candidate.depthDecision }
        : {}),
      ...(input.candidate.now !== undefined ? { now: input.candidate.now } : {}),
    });
    const supersededAdditional: BiographicalClaim[] = [];
    for (const claim of additional) {
      supersededAdditional.push(await input.store.transitionClaim({
        claimId: claim.id,
        to: 'superseded',
        ...(input.candidate.now !== undefined ? { now: input.candidate.now } : {}),
      }));
    }
    const activated = await input.store.transitionClaim({
      claimId: result.superseding.id,
      to: 'active',
      ...(input.candidate.now !== undefined ? { now: input.candidate.now } : {}),
    });
    return {
      claim: activated,
      disposition: 'corrected',
      affectedClaims: [result.superseded, ...supersededAdditional],
    };
  }

  const candidate = await input.store.writeClaim({
    ...input.candidate,
    status: 'contested',
  });
  const contested: BiographicalClaim[] = [];
  for (const claim of conflicts) {
    contested.push(await input.store.transitionClaim({
      claimId: claim.id,
      to: 'contested',
      ...(input.candidate.now !== undefined ? { now: input.candidate.now } : {}),
    }));
  }
  return {
    claim: candidate,
    disposition: 'contested',
    affectedClaims: contested,
  };
}

export async function admitBiographicalCandidate(
  input: BiographicalAdmissionInput,
): Promise<BiographicalAdmissionResult> {
  return await input.store.runClaimTransaction(
    input.candidate.subject,
    input.candidate.kind,
    async transactionStore => await admitBiographicalCandidateInTransaction({
      ...input,
      store: transactionStore,
    }),
  );
}
