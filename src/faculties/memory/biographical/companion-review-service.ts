// ── Companion protected self-review pass (o61vb.13) ──
//
// A bounded job in which each companion reviews the biography candidates about
// itself and about relationships it is part of, under its own identity and with
// real agency to refuse.
//
// Ordering matters and is deliberate:
//   1. Authority first. A candidate outside this companion's review authority is
//      never read into a prompt, and a wrong-companion attempt throws before any
//      claim value is formatted.
//   2. The model call is read-only. Nothing is written until the decision has
//      been parsed against the closed schema.
//   3. Every write for one candidate happens inside a single subject
//      transaction, so a crash mid-decision leaves the candidate exactly as the
//      previous pass left it.
//   4. Retries replay. A receipt this reviewer already recorded at the current
//      candidate revision means the decision landed; the pass moves on instead
//      of appending a duplicate receipt.
//
// The reviewer cannot activate a human-derived fact. Approval moves a candidate
// to human review; only the existing owner-policy companion-self autoactivation
// rule can reach `active`, and it re-checks the exact policy digest itself.

import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../../primitives/llm/work-spec.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import {
  biographicalCandidateDerivation,
  findCandidateReceipt,
} from './candidate-state.js';
import {
  assertCompanionReviewAuthority,
  BIOGRAPHICAL_COMPANION_REVIEW_ACTIONS,
  BIOGRAPHICAL_COMPANION_REVIEW_FLAGS,
  BIOGRAPHICAL_COMPANION_REVIEW_REASONS,
  BiographicalCompanionReviewError,
  parseCompanionReviewDecision,
} from './companion-review.js';
import type {
  BiographicalCompanionReviewDecision,
  BiographicalCompanionReviewSubject,
} from './companion-review.js';
import { renderBiographicalClaimForReview } from './projection-rendering.js';
import type {
  BiographicalCandidateReceiptInput,
  BiographicalProfileStorePort,
} from './store-port.js';
import type {
  BiographicalCandidateRecord,
  BiographicalCandidateSocialContext,
  BiographicalClaim,
} from './types.js';

const log = createComponentLogger('Biography');

/** Content-free review telemetry: counts and outcomes, never claim content. */
export interface BiographyCompanionReviewTelemetry {
  readonly reviewRunId: string;
  readonly candidatesConsidered: number;
  readonly candidatesOutsideAuthority: number;
  readonly candidatesReplayed: number;
  readonly approved: number;
  readonly rejected: number;
  readonly flagged: number;
  readonly revised: number;
  readonly escalatedToHumanReview: number;
  readonly autoactivated: number;
  readonly malformedDecisions: number;
  readonly failures: number;
}

export interface BiographyCompanionReviewServiceOptions {
  readonly profileStore: BiographicalProfileStorePort;
  readonly llmClient: LLMProviderPort;
  readonly personaPreamble?: PersonaPreamblePort | null;
  readonly companionId: string;
  readonly candidatePolicy: () => BiographicalCandidatePolicy;
  readonly onComplete?: (telemetry: BiographyCompanionReviewTelemetry) => void;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
}

type ReviewOutcome =
  | 'approved'
  | 'rejected'
  | 'flagged'
  | 'revised'
  | 'replayed'
  | 'outside_authority'
  | 'malformed';

const REVIEW_SYSTEM_PROMPT = [
  'This is my own protected review of durable biography proposals about me and',
  'about relationships I am part of. Nothing here is published; nothing is',
  'active. I decide whether each proposal is true to the evidence and to me.',
  '',
  'I may approve, reject, revise, reassign, split, merge, or flag. I refuse a',
  'proposal that misreads the evidence, misreads who it is about, or that I do',
  'not want carried outside the room it came from — a refusal needs no further',
  'justification than a reason code.',
  '',
  'What I cannot do: I cannot choose a subject, a relationship, a lifecycle',
  'stage, a sensitivity, or a source. I cannot make a proposal less sensitive.',
  'I cannot approve anything into use; approval only sends it onward for review.',
  '',
  'Return strict JSON only, with exactly the fields the schema below names.',
].join('\n');

function reviewSchemaBlock(): string {
  return [
    'Decision schema (JSON, no prose, no extra fields):',
    `{"action":"${BIOGRAPHICAL_COMPANION_REVIEW_ACTIONS.join('|')}", ...}`,
    '- approve / reject: {"action":"approve","reason":"<reason code>"}',
    '- flag: {"action":"flag","flag":"sensitive|ambiguous","reason":"<reason code>",'
      + '"forceRejection":false}',
    '- revise / reassign / merge: {"action":"revise","reason":"<reason code>",'
      + '"proposals":[{"kind":...,"value":...,"basis":...,"confidence":...,'
      + '"sourceRefs":["<bound source ref>"]}]}',
    '- split: the same shape with two or more proposals.',
    `Flags: ${BIOGRAPHICAL_COMPANION_REVIEW_FLAGS.join(' | ')}`,
    `Reason codes: ${BIOGRAPHICAL_COMPANION_REVIEW_REASONS.join(' | ')}`,
    'A proposal may cite only source refs already bound to the reviewed candidate,',
    'and may only name a social context listed under Authorized contexts.',
  ].join('\n');
}

function contextLabel(context: BiographicalCandidateSocialContext): string {
  return context.kind === 'companion_self'
    ? `companion_self(companionId=${context.companionId})`
    : `companion_contact_dyad(companionId=${context.companionId}, contactId=${context.contactId})`;
}

function candidateBlock(subject: BiographicalCompanionReviewSubject): string {
  const { claim, candidate } = subject;
  return [
    `Candidate stage: ${candidate.stage} (revision ${candidate.revision})`,
    `Claim kind: ${claim.kind}`,
    `Claim value: ${renderBiographicalClaimForReview(claim)}`,
    `Basis: ${claim.basis}`,
    `Derivation: ${biographicalCandidateDerivation(claim)}`,
    `Proposed sensitivity: ${claim.proposedSensitivity}`,
    `Synthesis rationale: ${candidate.rationale ?? '(none recorded)'}`,
    `Current social context: ${
      candidate.socialContext ? contextLabel(candidate.socialContext) : '(none recorded)'
    }`,
    'Bound evidence (refs and snapshots only; bodies stay in their origin room):',
    ...claim.sources.map(source => (
      `- ${source.ref} (revision ${source.revision}, type ${source.sourceType ?? 'unknown'}, `
      + `sensitivity ${source.sensitivityAtProjection})`
    )),
    'Authorized contexts:',
    ...subject.authorizedContexts.map(context => `- ${contextLabel(context)}`),
  ].join('\n');
}

export class BiographyCompanionReviewService {
  constructor(private readonly options: BiographyCompanionReviewServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get authorityRef(): string {
    return `companion:${this.options.companionId}`;
  }

  /**
   * One bounded review pass over the candidates awaiting this companion.
   * Per-candidate failures are isolated and counted: one unreadable candidate
   * must not stop the companion from reviewing the rest of its own biography.
   */
  async run(): Promise<BiographyCompanionReviewTelemetry> {
    const policy = this.options.candidatePolicy();
    const reviewRunId = this.options.newRunId?.() ?? `biography-review:${crypto.randomUUID()}`;
    const pending = await this.options.profileStore.listCandidates({
      stages: ['automata_synthesis', 'companion_review'],
      limit: policy.budgets.maxPendingCandidates,
    });
    const counts: Record<ReviewOutcome, number> = {
      approved: 0,
      rejected: 0,
      flagged: 0,
      revised: 0,
      replayed: 0,
      outside_authority: 0,
      malformed: 0,
    };
    let escalatedToHumanReview = 0;
    let autoactivated = 0;
    let failures = 0;

    for (const candidate of pending) {
      try {
        const result = await this.reviewCandidate({ candidate, policy, reviewRunId });
        counts[result.outcome] += 1;
        if (result.escalated) escalatedToHumanReview += 1;
        if (result.activated) autoactivated += 1;
      } catch (error) {
        failures += 1;
        // Content-free: the candidate's stage and the failure text only.
        log.warn('Companion biography review failed', {
          stage: candidate.stage,
          error: toErrorMessage(error),
        });
      }
    }

    const telemetry: BiographyCompanionReviewTelemetry = {
      reviewRunId,
      candidatesConsidered: pending.length,
      candidatesOutsideAuthority: counts.outside_authority,
      candidatesReplayed: counts.replayed,
      approved: counts.approved,
      rejected: counts.rejected,
      flagged: counts.flagged,
      revised: counts.revised,
      escalatedToHumanReview,
      autoactivated,
      malformedDecisions: counts.malformed,
      failures,
    };
    this.options.onComplete?.(telemetry);
    return telemetry;
  }

  private async reviewCandidate(input: {
    readonly candidate: BiographicalCandidateRecord;
    readonly policy: BiographicalCandidatePolicy;
    readonly reviewRunId: string;
  }): Promise<{ outcome: ReviewOutcome; escalated: boolean; activated: boolean }> {
    const claim = await this.options.profileStore.getClaim(input.candidate.claimId);
    if (claim === undefined) {
      throw new Error('biography candidate has no stored claim revision');
    }
    try {
      assertCompanionReviewAuthority({
        claim,
        candidate: input.candidate,
        companionId: this.options.companionId,
      });
    } catch (error) {
      if (!(error instanceof BiographicalCompanionReviewError)) throw error;
      return { outcome: 'outside_authority', escalated: false, activated: false };
    }
    // Idempotent retry. A transition stamps its receipts with the revision it
    // consumed and leaves the record one higher, so a receipt from this reviewer
    // at either the current revision or the one just consumed means this
    // reviewer already decided the state in front of it. That also covers the
    // companion's own replacement candidates: it authored them, so it does not
    // review them again.
    const alreadyDecided = [input.candidate.revision, input.candidate.revision - 1].some(
      revision => findCandidateReceipt(input.candidate, {
        authority: 'companion',
        actorAuthorityRef: this.authorityRef,
        candidateRevision: revision,
      }) !== undefined,
    );
    if (alreadyDecided) {
      return { outcome: 'replayed', escalated: false, activated: false };
    }

    const subject: BiographicalCompanionReviewSubject = {
      candidate: input.candidate,
      claim,
      authorizedContexts: this.authorizedContexts(claim, input.candidate),
    };
    const now = this.now();
    let decision: BiographicalCompanionReviewDecision;
    try {
      decision = parseCompanionReviewDecision(
        await this.decide(subject, input.reviewRunId),
        subject,
        { now },
      );
    } catch (error) {
      if (!(error instanceof BiographicalCompanionReviewError) && !(error instanceof SyntaxError)) {
        throw error;
      }
      // A malformed decision is not an approval. The candidate stays exactly
      // where it was and is offered again on the next pass.
      log.warn('Companion biography review decision rejected', {
        stage: input.candidate.stage,
        error: toErrorMessage(error),
      });
      return { outcome: 'malformed', escalated: false, activated: false };
    }

    return await this.options.profileStore.runSubjectTransaction(
      claim.subject,
      async store => await this.applyDecision({
        store,
        candidate: input.candidate,
        claim,
        decision,
        policy: input.policy,
        reviewRunId: input.reviewRunId,
        now,
      }),
    );
  }

  /**
   * Contexts this reviewer may re-aim a proposal into: the candidate's own
   * context plus the contexts the reviewed claim itself already proves. A
   * reviewer can correct a mis-aimed proposal without being able to invent a
   * relationship the evidence never established.
   */
  private authorizedContexts(
    claim: BiographicalClaim,
    candidate: BiographicalCandidateRecord,
  ): BiographicalCandidateSocialContext[] {
    const contexts: BiographicalCandidateSocialContext[] = [];
    const add = (context: BiographicalCandidateSocialContext): void => {
      const duplicate = contexts.some(existing => (
        existing.kind === context.kind
        && existing.companionId === context.companionId
        && (existing.kind === 'companion_self'
          || (context.kind === 'companion_contact_dyad'
            && existing.contactId === context.contactId))
      ));
      if (!duplicate) contexts.push(context);
    };
    if (candidate.socialContext !== undefined) add(candidate.socialContext);
    add({ kind: 'companion_self', companionId: this.options.companionId });
    for (const subject of [claim.subject, claim.relatedSubject]) {
      if (subject?.kind === 'contact') {
        add({
          kind: 'companion_contact_dyad',
          companionId: this.options.companionId,
          contactId: subject.contactId,
        });
      }
    }
    return contexts;
  }

  private async decide(
    subject: BiographicalCompanionReviewSubject,
    reviewRunId: string,
  ): Promise<unknown> {
    const task = [REVIEW_SYSTEM_PROMPT, '', reviewSchemaBlock()].join('\n');
    const systemPrompt = this.options.personaPreamble
      ? this.options.personaPreamble.prepend('biography_companion_review', task)
      : task;
    const response = await completeWithWorkSpec(
      this.options.llmClient,
      {
        systemPrompt,
        messages: [{
          role: 'user',
          content: `${candidateBlock(subject)}\n\nDecide now. Return JSON only.`,
        }],
      },
      buildLLMWorkSpec({
        purpose: 'memory',
        durable: true,
        correlation: {
          requestId: `${reviewRunId}:${subject.candidate.id}`,
          channelId: 'internal:biography-companion-review',
          callType: 'scheduled',
          purpose: 'memory.biography.companion_review',
          originType: 'scheduled',
          originStage: 'memory.biography.companion_review',
        },
      }),
    );
    return JSON.parse(response.content) as unknown;
  }

  private async applyDecision(input: {
    readonly store: BiographicalProfileStorePort;
    readonly candidate: BiographicalCandidateRecord;
    readonly claim: BiographicalClaim;
    readonly decision: BiographicalCompanionReviewDecision;
    readonly policy: BiographicalCandidatePolicy;
    readonly reviewRunId: string;
    readonly now: Date;
  }): Promise<{ outcome: ReviewOutcome; escalated: boolean; activated: boolean }> {
    const { store, decision } = input;
    // Every path passes through companion_review: that stage is the durable
    // record that this companion, not an automaton, decided.
    const inReview = input.candidate.stage === 'companion_review'
      ? input.candidate
      : await store.transitionCandidate({
        candidateId: input.candidate.id,
        expectedRevision: input.candidate.revision,
        to: 'companion_review',
        receipts: [this.receipt('approved', 'reviewer_approved')],
        now: input.now,
      });

    // A fatal flag and an outright refusal both terminate the candidate. Both
    // are the companion's own decision and both are recorded as such.
    const refusal = decision.action === 'reject'
      ? ('reviewer_rejected' as const)
      : decision.action === 'flag' && decision.forceRejection
        ? this.flagReason(decision.flag)
        : undefined;
    if (refusal !== undefined) {
      await store.transitionCandidate({
        candidateId: inReview.id,
        expectedRevision: inReview.revision,
        to: 'rejected',
        receipts: [this.receipt('rejected', refusal)],
        now: input.now,
      });
      return {
        outcome: decision.action === 'flag' ? 'flagged' : 'rejected',
        escalated: false,
        activated: false,
      };
    }

    if (decision.action !== 'approve' && decision.action !== 'flag'
      && decision.action !== 'reject') {
      await this.supersede({
        store,
        candidate: inReview,
        decision,
        policy: input.policy,
        reviewRunId: input.reviewRunId,
        now: input.now,
      });
      return { outcome: 'revised', escalated: false, activated: false };
    }

    // A flag raises the bar and can never lower it: a flagged candidate always
    // goes to a human, even when policy would otherwise autoactivate it.
    const flagReason = decision.action === 'flag'
      ? this.flagReason(decision.flag)
      : undefined;
    if (flagReason === undefined && await this.tryAutoactivate({
      store,
      candidate: inReview,
      claim: input.claim,
      policy: input.policy,
      now: input.now,
    })) {
      return { outcome: 'approved', escalated: false, activated: true };
    }
    // Approval is approval to escalate, not approval to use: human review owns
    // every human-derived fact and everything policy will not autoactivate.
    await store.transitionCandidate({
      candidateId: inReview.id,
      expectedRevision: inReview.revision,
      to: 'human_review',
      receipts: [this.receipt('approved', flagReason ?? 'reviewer_approved')],
      now: input.now,
    });
    return {
      outcome: flagReason === undefined ? 'approved' : 'flagged',
      escalated: true,
      activated: false,
    };
  }

  private flagReason(flag: 'sensitive' | 'ambiguous'): 'reviewer_flagged_sensitive' | 'reviewer_flagged_ambiguous' {
    return flag === 'sensitive' ? 'reviewer_flagged_sensitive' : 'reviewer_flagged_ambiguous';
  }

  /**
   * Owner-policy companion-only autoactivation. This never widens: the stage
   * machine re-checks the exact policy digest the candidate was staged under
   * and refuses anything human-derived or above the owner ceiling, so a
   * mismatched or ineligible candidate simply falls through to human review.
   */
  private async tryAutoactivate(input: {
    readonly store: BiographicalProfileStorePort;
    readonly candidate: BiographicalCandidateRecord;
    readonly claim: BiographicalClaim;
    readonly policy: BiographicalCandidatePolicy;
    readonly now: Date;
  }): Promise<boolean> {
    if (biographicalCandidateDerivation(input.claim) === 'human_derived') return false;
    try {
      await input.store.transitionCandidate({
        candidateId: input.candidate.id,
        expectedRevision: input.candidate.revision,
        to: 'active',
        receipts: [
          this.receipt('approved', 'reviewer_approved'),
          {
            authority: 'owner_policy',
            decision: 'approved',
            actorAuthorityRef: `owner-policy:${input.candidate.policyDigest}`,
            reason: 'owner_policy_autoactivation',
          },
        ],
        policy: input.policy,
        now: input.now,
      });
      return true;
    } catch {
      // Ineligible or stale policy: not an error, just not autoactivatable.
      return false;
    }
  }

  /**
   * Revision, reassignment, split and merge are one primitive: write the
   * superseding candidates, then close the reviewed one. History is never
   * mutated — the original proposal, its receipts, and its provenance stay
   * exactly as they were, and each replacement restarts downstream review.
   */
  private async supersede(input: {
    readonly store: BiographicalProfileStorePort;
    readonly candidate: BiographicalCandidateRecord;
    readonly decision: Extract<
      BiographicalCompanionReviewDecision,
      { action: 'revise' | 'reassign' | 'split' | 'merge' }
    >;
    readonly policy: BiographicalCandidatePolicy;
    readonly reviewRunId: string;
    readonly now: Date;
  }): Promise<void> {
    const reason = ({
      revise: 'reviewer_revised',
      reassign: 'reviewer_reassigned',
      split: 'reviewer_split',
      merge: 'reviewer_merged',
    } as const)[input.decision.action];
    for (const proposal of input.decision.proposals) {
      const { status: _ignoredStatus, ...claimWrite } = proposal.write;
      const written = await input.store.writeCandidate({
        claim: { ...claimWrite, now: input.now },
        automataRunId: input.reviewRunId,
        automataAuthorityRef: this.authorityRef,
        policy: input.policy,
        socialContext: proposal.socialContext,
        rationale: 'contradicts_active_claim',
        supersedesCandidateId: input.candidate.id,
      });
      // The replacement is the companion's own proposal, so it does not need a
      // second companion pass; it still needs everything downstream of that.
      await input.store.transitionCandidate({
        candidateId: written.id,
        expectedRevision: written.revision,
        to: 'companion_review',
        receipts: [this.receipt('approved', reason)],
        now: input.now,
      });
    }
    await input.store.transitionCandidate({
      candidateId: input.candidate.id,
      expectedRevision: input.candidate.revision,
      to: 'superseded',
      receipts: [
        this.receipt('superseded', reason),
        {
          authority: 'owner_policy',
          decision: 'superseded',
          actorAuthorityRef: `owner-policy:${input.candidate.policyDigest}`,
          reason: 'owner_policy_supersession',
        },
      ],
      now: input.now,
    });
  }

  private receipt(
    decision: BiographicalCandidateReceiptInput['decision'],
    reason: NonNullable<BiographicalCandidateReceiptInput['reason']>,
  ): BiographicalCandidateReceiptInput {
    return {
      authority: 'companion',
      decision,
      actorAuthorityRef: this.authorityRef,
      reason,
    };
  }
}
