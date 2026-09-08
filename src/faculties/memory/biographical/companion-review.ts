// ── Companion protected self-review contract (o61vb.13) ──
//
// Companion review is its own authority stage between synthesis and human
// review. The companion may accept, refuse, correct, re-aim, split or merge a
// proposal about itself or about a relationship it is part of — and it may
// refuse for reasons no automaton can see, which is the point of the stage.
//
// What the reviewer may NOT do is encoded here rather than in a prompt:
//
//   * It cannot review a candidate outside its own review authority. Authority
//     is derived from the canonical claim subject and dyad, never from the
//     model's own assertion about who it is.
//   * It cannot choose a subject, a dyad, a lifecycle stage, a sensitivity, or
//     a source. Reassignment picks a target from an explicitly authorized set;
//     every revision reuses the exact source snapshots already bound.
//   * It cannot lower sensitivity. A `flag` raises the review bar; there is no
//     decision that lowers it.
//   * It cannot approve itself into the profile. Activation stays with the
//     existing owner-policy autoactivation rule and with human review.
//
// Decisions are schema-bound and reason-coded; no free-form review prose is
// persisted or republished.

import { hasExactKeys, isRecord } from '../../../shared/utils/types.js';
import { BiographicalClaimValidationError } from './claim-kinds.js';
import { parsePortableStableCandidate, PORTABLE_BIOGRAPHY_CANDIDATE_KINDS } from './stable-candidate.js';
import type { BiographicalClaimWriteInput } from './store-port.js';
import type {
  BiographicalCandidateRecord,
  BiographicalCandidateSocialContext,
  BiographicalClaim,
  BiographicalSubjectRef,
} from './types.js';

export const BIOGRAPHICAL_COMPANION_REVIEW_ACTIONS = [
  'approve',
  'reject',
  'revise',
  'reassign',
  'split',
  'merge',
  'flag',
] as const;
type BiographicalCompanionReviewAction =
  (typeof BIOGRAPHICAL_COMPANION_REVIEW_ACTIONS)[number];

export const BIOGRAPHICAL_COMPANION_REVIEW_FLAGS = ['sensitive', 'ambiguous'] as const;
type BiographicalCompanionReviewFlag =
  (typeof BIOGRAPHICAL_COMPANION_REVIEW_FLAGS)[number];

/**
 * Closed refusal/correction reason codes. A reviewer explains itself with a
 * code; the review transcript is never persisted or republished.
 */
export const BIOGRAPHICAL_COMPANION_REVIEW_REASONS = [
  'evidence_supports_claim',
  'evidence_does_not_support_claim',
  'wrong_subject',
  'wrong_social_context',
  'wrong_temporality',
  'value_misread',
  'evidence_belongs_to_separate_claims',
  'evidence_describes_one_claim',
  'material_is_sensitive',
  'material_is_ambiguous',
] as const;
type BiographicalCompanionReviewReason =
  (typeof BIOGRAPHICAL_COMPANION_REVIEW_REASONS)[number];

/** One structured replacement proposal from the reviewer. */
interface BiographicalCompanionReviewProposal {
  readonly write: BiographicalClaimWriteInput;
  readonly socialContext: BiographicalCandidateSocialContext;
}

export type BiographicalCompanionReviewDecision =
  | { readonly action: 'approve'; readonly reason: BiographicalCompanionReviewReason }
  | { readonly action: 'reject'; readonly reason: BiographicalCompanionReviewReason }
  | {
      readonly action: 'flag';
      readonly flag: BiographicalCompanionReviewFlag;
      readonly reason: BiographicalCompanionReviewReason;
      /** True when the flag is fatal rather than an escalation to a human. */
      readonly forceRejection: boolean;
    }
  | {
      readonly action: 'revise' | 'reassign' | 'split' | 'merge';
      readonly reason: BiographicalCompanionReviewReason;
      readonly proposals: readonly BiographicalCompanionReviewProposal[];
    };

export class BiographicalCompanionReviewError extends Error {}

/**
 * A candidate the reviewer is authorized to decide, with the exact claim and
 * social context it may re-aim within.
 */
export interface BiographicalCompanionReviewSubject {
  readonly candidate: BiographicalCandidateRecord;
  readonly claim: BiographicalClaim;
  /** Contexts the reviewer may reassign into, including the current one. */
  readonly authorizedContexts: readonly BiographicalCandidateSocialContext[];
}

function reviewFailure(message: string): never {
  throw new BiographicalCompanionReviewError(message);
}

function companionIdsIn(claim: BiographicalClaim): string[] {
  return [claim.subject, ...(claim.relatedSubject ? [claim.relatedSubject] : [])]
    .flatMap(subject => (subject.kind === 'companion' ? [subject.companionId] : []));
}

/**
 * Fail closed unless this companion owns the candidate's review authority.
 *
 * Authority comes from two canonical bindings, never from the model's own
 * assertion about who it is: the candidate's social context (which names the
 * companion whose self or dyad the proposal belongs to) and the companion
 * subjects of the claim itself. A candidate carrying neither binding is
 * unreviewable rather than open to anyone, and a context naming a different
 * companion is refused even when the claim mentions this one.
 */
export function assertCompanionReviewAuthority(input: {
  readonly claim: BiographicalClaim;
  readonly candidate: BiographicalCandidateRecord;
  readonly companionId: string;
}): void {
  const context = input.candidate.socialContext;
  if (context !== undefined && context.companionId !== input.companionId) {
    reviewFailure('companion review authority does not cover this candidate social context');
  }
  const claimNamesReviewer = companionIdsIn(input.claim).includes(input.companionId);
  if (context === undefined && !claimNamesReviewer) {
    reviewFailure('companion review authority does not cover this biography candidate');
  }
  if (input.candidate.stage !== 'automata_synthesis' && input.candidate.stage !== 'companion_review') {
    reviewFailure(`biography candidate is not open for companion review: ${input.candidate.stage}`);
  }
}

function sameContext(
  left: BiographicalCandidateSocialContext,
  right: BiographicalCandidateSocialContext,
): boolean {
  if (left.kind !== right.kind || left.companionId !== right.companionId) return false;
  return left.kind === 'companion_self'
    || (right.kind === 'companion_contact_dyad' && left.contactId === right.contactId);
}

function subjectForContext(
  context: BiographicalCandidateSocialContext,
  subjectVersion: number,
): BiographicalSubjectRef {
  return context.kind === 'companion_self'
    ? { kind: 'companion', companionId: context.companionId, subjectVersion }
    : { kind: 'contact', contactId: context.contactId, subjectVersion };
}

function relatedSubjectForContext(
  context: BiographicalCandidateSocialContext,
  kind: string,
  value: unknown,
  subjectVersion: number,
): BiographicalSubjectRef | undefined {
  if (context.kind !== 'companion_contact_dyad') return undefined;
  if (kind === 'relationship' || kind === 'shared-language') {
    return { kind: 'companion', companionId: context.companionId, subjectVersion };
  }
  if (kind === 'nickname' && isRecord(value) && value.scope === 'relational') {
    return { kind: 'companion', companionId: context.companionId, subjectVersion };
  }
  return undefined;
}

function parseProposal(
  raw: unknown,
  subject: BiographicalCompanionReviewSubject,
  now: Date,
): BiographicalCompanionReviewProposal {
  if (
    !isRecord(raw)
    || !hasExactKeys(
      raw,
      ['kind', 'value', 'basis', 'confidence', 'sourceRefs'],
      ['socialContext', 'validFrom', 'validTo'],
    )
  ) {
    reviewFailure('companion review proposal has unknown or missing fields');
  }
  // Reassignment picks from the explicitly authorized set. There is no way to
  // name a subject the reviewer was not already authorized for.
  const requested = raw.socialContext;
  const context = requested === undefined
    ? subject.candidate.socialContext
    : subject.authorizedContexts.find(candidateContext => (
      isRecord(requested)
      && candidateContext.kind === requested.kind
      && candidateContext.companionId === requested.companionId
      && (candidateContext.kind === 'companion_self'
        || candidateContext.contactId === requested.contactId)
    ));
  if (context === undefined) {
    reviewFailure('companion review proposal names an unauthorized social context');
  }
  if (
    !subject.authorizedContexts.some(authorized => sameContext(authorized, context))
  ) {
    reviewFailure('companion review proposal names an unauthorized social context');
  }
  // Sources are never model-chosen: a proposal may only narrow the exact
  // snapshots already bound to the candidate it supersedes.
  if (!Array.isArray(raw.sourceRefs) || raw.sourceRefs.length === 0) {
    reviewFailure('companion review proposal must cite at least one bound source');
  }
  const refs = new Set<string>();
  for (const ref of raw.sourceRefs) {
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      reviewFailure('companion review proposal source refs must be non-empty strings');
    }
    refs.add(ref.trim());
  }
  const sources = subject.claim.sources.filter(source => refs.has(source.ref));
  if (sources.length !== refs.size) {
    reviewFailure('companion review proposal cites a source not bound to the reviewed candidate');
  }
  const subjectVersion = subject.claim.subject.subjectVersion;
  const claimSubject = subjectForContext(context, subjectVersion);
  const relatedSubject = relatedSubjectForContext(
    context,
    String(raw.kind),
    raw.value,
    subjectVersion,
  );
  let write: BiographicalClaimWriteInput;
  try {
    write = parsePortableStableCandidate({
      subject: claimSubject,
      ...(relatedSubject !== undefined ? { relatedSubject } : {}),
      kind: raw.kind,
      value: raw.value,
      basis: raw.basis,
      confidence: raw.confidence,
      sources,
      ...(raw.validFrom !== undefined ? { validFrom: raw.validFrom } : {}),
      ...(raw.validTo !== undefined ? { validTo: raw.validTo } : {}),
      ...(subject.claim.depthDecision !== undefined
        ? { depthDecision: subject.claim.depthDecision }
        : {}),
    }, { now, admittedKinds: PORTABLE_BIOGRAPHY_CANDIDATE_KINDS });
  } catch (error) {
    if (!(error instanceof BiographicalClaimValidationError)) throw error;
    reviewFailure(`companion review proposal is malformed: ${error.message}`);
  }
  return { write, socialContext: context };
}

function parseReason(value: unknown): BiographicalCompanionReviewReason {
  if (
    typeof value !== 'string'
    || !(BIOGRAPHICAL_COMPANION_REVIEW_REASONS as readonly string[]).includes(value)
  ) {
    reviewFailure('companion review reason is not a supported reason code');
  }
  return value as BiographicalCompanionReviewReason;
}

/**
 * Strict decision boundary for companion review output. Every field is closed;
 * unknown actions, unknown reasons, free-form notes, stage/sensitivity choices
 * and unbound sources all reject rather than degrade.
 */
export function parseCompanionReviewDecision(
  value: unknown,
  subject: BiographicalCompanionReviewSubject,
  options: { readonly now: Date },
): BiographicalCompanionReviewDecision {
  if (!isRecord(value) || typeof value.action !== 'string') {
    reviewFailure('companion review decision must name an action');
  }
  if (!(BIOGRAPHICAL_COMPANION_REVIEW_ACTIONS as readonly string[]).includes(value.action)) {
    reviewFailure(`companion review action is not supported: ${value.action}`);
  }
  const action = value.action as BiographicalCompanionReviewAction;
  if (action === 'approve' || action === 'reject') {
    if (!hasExactKeys(value, ['action', 'reason'])) {
      reviewFailure('companion review decision has unknown or missing fields');
    }
    return { action, reason: parseReason(value.reason) };
  }
  if (action === 'flag') {
    if (!hasExactKeys(value, ['action', 'flag', 'reason', 'forceRejection'])) {
      reviewFailure('companion review decision has unknown or missing fields');
    }
    if (
      typeof value.flag !== 'string'
      || !(BIOGRAPHICAL_COMPANION_REVIEW_FLAGS as readonly string[]).includes(value.flag)
    ) {
      reviewFailure('companion review flag is not supported');
    }
    if (typeof value.forceRejection !== 'boolean') {
      reviewFailure('companion review forceRejection must be a boolean');
    }
    return {
      action: 'flag',
      flag: value.flag as BiographicalCompanionReviewFlag,
      reason: parseReason(value.reason),
      forceRejection: value.forceRejection,
    };
  }
  if (!hasExactKeys(value, ['action', 'reason', 'proposals'])) {
    reviewFailure('companion review decision has unknown or missing fields');
  }
  if (!Array.isArray(value.proposals) || value.proposals.length === 0) {
    reviewFailure('a revising companion review decision must carry proposals');
  }
  // Cardinality is part of the verb: splitting produces more than one claim,
  // revising and re-aiming produce exactly one, and merging folds evidence into
  // one. A decision whose shape contradicts its verb rejects.
  if (action === 'split' && value.proposals.length < 2) {
    reviewFailure('a split companion review decision must produce more than one claim');
  }
  if (action !== 'split' && value.proposals.length !== 1) {
    reviewFailure(`a ${action} companion review decision must produce exactly one claim`);
  }
  const proposals = value.proposals.map(
    proposal => parseProposal(proposal, subject, options.now),
  );
  if (action === 'reassign') {
    const current = subject.candidate.socialContext;
    if (
      current !== undefined
      && proposals.every(proposal => sameContext(proposal.socialContext, current))
    ) {
      reviewFailure('a reassign companion review decision must change the social context');
    }
  }
  return { action, reason: parseReason(value.reason), proposals };
}
