import { hasExactKeys, isRecord } from '../../../shared/utils/types.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import {
  applyLoweringGrant,
  computeAutomaticSensitivity,
} from '../../../faculties/memory/biographical/kernel.js';
import { renderBiographicalClaimForReview } from '../../../faculties/memory/biographical/projection-rendering.js';
import { biographicalCandidateDerivation } from '../../../faculties/memory/biographical/candidate-state.js';
import type {
  BiographicalCandidateDerivation,
  BiographicalCandidateReceiptReason,
  BiographicalCandidateRecord,
  BiographicalClaim,
  BiographicalClaimSource,
  BiographicalSensitivityGrant,
} from '../../../faculties/memory/biographical/types.js';
import type { BiographicalRebuildRequest } from '../../../faculties/memory/biographical/rebuild-contracts.js';
import type {
  BiographicalReviewAction,
  BiographicalReviewAuditInput,
  BiographicalReviewAuditRecord,
  BiographicalReviewReason,
} from '../../../faculties/memory/biographical/review-audit.js';
import type {
  BiographicalClaimListOptions,
  BiographicalProfileStorePort,
} from '../../../faculties/memory/biographical/store-port.js';
import {
  soleAdminFleetActor,
  type GardenRequestContext,
} from '../garden-request-context.js';

interface AdminBiographicalSourceView {
  readonly ref: string;
  readonly revision: string;
  readonly evidenceDigest: string;
  readonly subjectEvidenceDigest?: string;
  readonly consentFingerprint?: string;
  readonly sourceChannelId?: string;
  readonly sensitivityContribution: SensitivityLevel;
}

export interface AdminBiographicalClaimView {
  readonly id: string;
  readonly kind: BiographicalClaim['kind'];
  readonly status: BiographicalClaim['status'];
  /** Staged review stage, present only while this claim still has a candidate row. */
  readonly candidateStage?: BiographicalCandidateRecord['stage'];
  /** Exact staged revision a human stage action must cite. */
  readonly candidateRevision?: number;
  /**
   * Whether the asserted facts were derived from a human subject. Review policy
   * never autoactivates human-derived facts, so the queue states it plainly.
   */
  readonly derivation: BiographicalCandidateDerivation;
  readonly subject: BiographicalClaim['subject'];
  readonly relatedSubject?: BiographicalClaim['relatedSubject'];
  readonly structuredValue: BiographicalClaim['value'];
  readonly renderedValue: string;
  readonly claimDigest: string;
  /** Latest observed source-set digest; may differ from the persisted claim snapshot. */
  readonly sourceSetDigest: string;
  readonly storedSourceSetDigest: string;
  readonly proposedSensitivity: SensitivityLevel;
  readonly automaticSensitivity: SensitivityLevel | null;
  readonly effectiveSensitivity: SensitivityLevel | null;
  readonly storedAutomaticSensitivity: SensitivityLevel;
  readonly storedEffectiveSensitivity: SensitivityLevel;
  readonly sensitivitySnapshotCurrent: boolean;
  readonly sources: readonly AdminBiographicalSourceView[];
  readonly synthesizedAt: string;
  readonly lastSourceValidatedAt: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersedesClaimId?: string;
  readonly appliedGrantId?: string;
  readonly withheldReasons: readonly string[];
  readonly pendingRebuildReasons: readonly string[];
}

/**
 * Read-only staging view of a claim's review candidate (o61vb.13), so an
 * operator can see where a proposal stands and what the companion decided
 * before it reaches human review. Receipts are authority/decision/reason codes
 * and digests only: no review reasoning and no source body is ever republished
 * here, and nothing on this surface can change a candidate's stage.
 */
interface AdminBiographicalCandidateView {
  readonly id: string;
  readonly stage: BiographicalCandidateRecord['stage'];
  readonly revision: number;
  readonly rationale?: BiographicalCandidateRecord['rationale'];
  readonly socialContext?: BiographicalCandidateRecord['socialContext'];
  readonly supersedesCandidateId?: string;
  readonly receipts: readonly {
    readonly authority: string;
    readonly decision: string;
    readonly reason?: string;
    readonly candidateRevision: number;
    readonly actorAuthorityRef: string;
    readonly recordedAt: string;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminBiographicalClaimDetail {
  readonly claim: AdminBiographicalClaimView;
  readonly grants: readonly BiographicalSensitivityGrant[];
  readonly rebuilds: readonly BiographicalRebuildRequest[];
  readonly audits: readonly BiographicalReviewAuditRecord[];
  /** Absent when the claim has no staged candidate (legacy or direct writes). */
  readonly candidate?: AdminBiographicalCandidateView;
}

export interface AdminBiographicalClaimList {
  readonly claims: readonly AdminBiographicalClaimView[];
}

/**
 * Subject-centered listing filter (o61vb.14). A Contact Biography tab and the
 * companion self view are the same bounded queue narrowed to one canonical
 * identity; the filter never widens what a caller may see, because the fleet
 * subject-relation gate still runs on every returned row.
 */
export interface AdminBiographicalClaimFilter {
  readonly subjectContactId?: string;
  readonly subjectCompanionId?: string;
}

function parseClaimFilter(
  filter: AdminBiographicalClaimFilter | undefined,
): Pick<BiographicalClaimListOptions, 'anySubjectIdentity'> {
  if (filter === undefined) return {};
  const contactId = filter.subjectContactId;
  const companionId = filter.subjectCompanionId;
  if (contactId !== undefined && companionId !== undefined) {
    throw new BiographicalReviewError(
      'malformed',
      'a biography listing filters on one canonical subject, not both',
    );
  }
  if (contactId !== undefined) {
    return {
      anySubjectIdentity: { kind: 'contact', contactId: nonEmpty(contactId, 'subjectContactId') },
    };
  }
  if (companionId !== undefined) {
    return {
      anySubjectIdentity: {
        kind: 'companion',
        companionId: nonEmpty(companionId, 'subjectCompanionId'),
      },
    };
  }
  return {};
}

function candidateView(candidate: BiographicalCandidateRecord): AdminBiographicalCandidateView {
  return {
    id: candidate.id,
    stage: candidate.stage,
    revision: candidate.revision,
    ...(candidate.rationale !== undefined ? { rationale: candidate.rationale } : {}),
    ...(candidate.socialContext !== undefined
      ? { socialContext: candidate.socialContext }
      : {}),
    ...(candidate.supersedesCandidateId !== undefined
      ? { supersedesCandidateId: candidate.supersedesCandidateId }
      : {}),
    receipts: candidate.receipts.map(receipt => ({
      authority: receipt.authority,
      decision: receipt.decision,
      ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
      candidateRevision: receipt.candidateRevision,
      actorAuthorityRef: receipt.actorAuthorityRef,
      recordedAt: receipt.recordedAt,
    })),
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

export interface AdminBiographicalReviewActor {
  readonly kind: 'operator';
  readonly authorityRef: string;
}

interface ParsedReviewInput {
  readonly action: BiographicalReviewAction;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly actor: AdminBiographicalReviewActor;
  readonly grantId?: string;
  readonly grantedSensitivity?: SensitivityLevel;
  /** Exact staged revision a stage action consumes. */
  readonly candidateRevision?: number;
  /** Closed human reviewer reason code stamped on the candidate receipt. */
  readonly receiptReason?: BiographicalCandidateReceiptReason;
}

/**
 * Reason codes a human reviewer may stamp on a stage decision. Closed on
 * purpose: a human review reason is an auditable code, never review prose that
 * would republish what the sources said.
 */
const HUMAN_STAGE_APPROVE_REASONS: readonly BiographicalCandidateReceiptReason[] = [
  'reviewer_approved',
];
const HUMAN_STAGE_REJECT_REASONS: readonly BiographicalCandidateReceiptReason[] = [
  'reviewer_rejected',
  'reviewer_flagged_sensitive',
  'reviewer_flagged_ambiguous',
];

export class BiographicalReviewError extends Error {
  constructor(
    readonly reason: BiographicalReviewReason,
    message: string,
  ) {
    super(message);
    this.name = 'BiographicalReviewError';
  }
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new BiographicalReviewError('malformed', `${field} must be a SHA-256 digest`);
  }
  return value;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BiographicalReviewError('malformed', `${field} must be non-empty`);
  }
  return value.trim();
}

function parseActor(value: unknown): AdminBiographicalReviewActor {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'authorityRef'])) {
    throw new BiographicalReviewError('unauthorized', 'verified operator authority is required');
  }
  if (value.kind !== 'operator') {
    throw new BiographicalReviewError('unauthorized', 'verified operator authority is required');
  }
  const authorityRef = nonEmpty(value.authorityRef, 'actor.authorityRef');
  if (!/^[a-z][a-z0-9_-]*:[^\s]+$/u.test(authorityRef)) {
    throw new BiographicalReviewError('unauthorized', 'operator authority reference is malformed');
  }
  return { kind: 'operator', authorityRef };
}

function parseReviewInput(
  claimIdValue: string,
  value: unknown,
  actorValue: AdminBiographicalReviewActor,
): ParsedReviewInput {
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw new BiographicalReviewError('malformed', 'review input must be an exact object');
  }
  const action = value.action;
  if (
    action !== 'approve' && action !== 'deny' && action !== 'revoke' && action !== 'regrant'
    && action !== 'stage-approve' && action !== 'stage-reject'
  ) {
    throw new BiographicalReviewError('malformed', 'review action is not supported');
  }
  const isStageAction = action === 'stage-approve' || action === 'stage-reject';
  const required = isStageAction
    ? ['action', 'claimDigest', 'sourceSetDigest', 'candidateRevision'] as const
    : ['action', 'claimDigest', 'sourceSetDigest'] as const;
  const optional = action === 'revoke'
    ? ['grantId'] as const
    : action === 'regrant'
      ? ['grantedSensitivity'] as const
      : isStageAction
        ? ['reason'] as const
        : [] as const;
  if (!hasExactKeys(value, required, optional)) {
    throw new BiographicalReviewError('malformed', 'review input has unknown or missing fields');
  }
  const actor = parseActor(actorValue);
  const base = {
    action,
    claimId: nonEmpty(claimIdValue, 'claimId'),
    claimDigest: digest(value.claimDigest, 'claimDigest'),
    sourceSetDigest: digest(value.sourceSetDigest, 'sourceSetDigest'),
    actor,
  };
  if (isStageAction) {
    const revision = value.candidateRevision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      throw new BiographicalReviewError(
        'malformed',
        'candidateRevision must be a positive safe integer',
      );
    }
    const allowed = action === 'stage-approve'
      ? HUMAN_STAGE_APPROVE_REASONS
      : HUMAN_STAGE_REJECT_REASONS;
    if (
      value.reason !== undefined
      && !(allowed as readonly string[]).includes(String(value.reason))
    ) {
      throw new BiographicalReviewError('malformed', 'stage reason code is not supported');
    }
    return {
      ...base,
      action,
      candidateRevision: revision,
      receiptReason: (value.reason as BiographicalCandidateReceiptReason | undefined) ?? allowed[0]!,
    };
  }
  if (action === 'revoke') {
    return { ...base, action, grantId: nonEmpty(value.grantId, 'grantId') };
  }
  if (action === 'regrant') {
    const sensitivity = value.grantedSensitivity;
    if (
      sensitivity !== 'public'
      && sensitivity !== 'personal'
      && sensitivity !== 'intimate'
      && sensitivity !== 'confidential'
    ) {
      throw new BiographicalReviewError('malformed', 'grantedSensitivity is not supported');
    }
    return { ...base, action, grantedSensitivity: sensitivity };
  }
  return { ...base, action };
}

function sourceView(source: BiographicalClaimSource): AdminBiographicalSourceView {
  return {
    ref: source.ref,
    revision: source.revision,
    evidenceDigest: source.evidenceDigest,
    subjectEvidenceDigest: source.subjectEvidenceDigest,
    consentFingerprint: source.consentFingerprint,
    ...(source.sourceChannelId !== undefined ? { sourceChannelId: source.sourceChannelId } : {}),
    sensitivityContribution: source.sensitivityAtProjection,
  };
}

interface BiographicalSubjectAccess {
  readonly viewerContactId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'guest';
  readonly accessMode: 'sole_admin' | 'multi_admin';
  readonly escalated: boolean;
}

function claimContactIds(claim: BiographicalClaim): string[] {
  return [claim.subject, claim.relatedSubject]
    .filter((subject): subject is Extract<NonNullable<typeof subject>, { kind: 'contact' }> => (
      subject?.kind === 'contact'
    ))
    .map(subject => subject.contactId);
}

function claimVisibleToSubject(
  claim: BiographicalClaim,
  pendingRebuilds: readonly BiographicalRebuildRequest[],
  access: BiographicalSubjectAccess,
): boolean {
  const contactIds = claimContactIds(claim);
  const viewerIsSubject = contactIds.includes(access.viewerContactId);
  const adminClass = access.role === 'owner' || access.role === 'admin';
  if (!adminClass) return viewerIsSubject;
  if (access.accessMode === 'sole_admin' || viewerIsSubject || contactIds.length === 0) return true;
  if (access.escalated) return true;
  const sourceSetDrifted = pendingRebuilds.some(rebuild =>
    rebuild.currentSourceSetDigest !== undefined
    && rebuild.currentSourceSetDigest !== claim.sourceSetDigest
  );
  if (sourceSetDrifted) return false;
  return claim.effectiveSensitivity !== 'intimate'
    && claim.effectiveSensitivity !== 'confidential';
}

function claimView(
  claim: BiographicalClaim,
  rebuilds: readonly BiographicalRebuildRequest[],
  grants: readonly BiographicalSensitivityGrant[],
  now: Date,
  candidate?: BiographicalCandidateRecord,
): AdminBiographicalClaimView {
  const automaticSensitivity = computeAutomaticSensitivity({
    kind: claim.kind,
    proposedSensitivity: claim.proposedSensitivity,
    sources: claim.sources,
    now,
  }).sensitivity;
  const latestObservedDigest = [...rebuilds]
    .reverse()
    .find(rebuild => rebuild.currentSourceSetDigest !== undefined)
    ?.currentSourceSetDigest ?? claim.sourceSetDigest;
  const sensitivitySnapshotCurrent = latestObservedDigest === claim.sourceSetDigest;
  const currentDigestGrant = applyLoweringGrant({
    claimDigest: claim.claimDigest,
    sourceSetDigest: latestObservedDigest,
    automaticSensitivity,
    grants,
    now,
  }).appliedGrant;
  const pendingRebuildReasons = rebuilds
    .filter(rebuild => rebuild.status === 'pending')
    .map(rebuild => rebuild.reason);
  const withheldReasons = [
    ...(claim.status === 'active' ? [] : [`claim-status:${claim.status}`]),
    // A staged candidate that has not reached `active` is the reason a claim is
    // nonprojectable, and naming it is what tells a reviewer whether the ball is
    // with the companion, with a human, or with nobody.
    ...(candidate !== undefined && candidate.stage !== 'active'
      ? [`candidate-stage:${candidate.stage}`]
      : []),
    ...(currentDigestGrant === undefined
      ? pendingRebuildReasons.map(reason => `rebuild:${reason}`)
      : []),
  ];
  return {
    id: claim.id,
    kind: claim.kind,
    status: claim.status,
    ...(candidate !== undefined
      ? { candidateStage: candidate.stage, candidateRevision: candidate.revision }
      : {}),
    derivation: biographicalCandidateDerivation(claim),
    subject: claim.subject,
    ...(claim.relatedSubject !== undefined ? { relatedSubject: claim.relatedSubject } : {}),
    structuredValue: claim.value,
    renderedValue: renderBiographicalClaimForReview(claim),
    claimDigest: claim.claimDigest,
    sourceSetDigest: latestObservedDigest,
    storedSourceSetDigest: claim.sourceSetDigest,
    proposedSensitivity: claim.proposedSensitivity,
    automaticSensitivity: sensitivitySnapshotCurrent ? automaticSensitivity : null,
    effectiveSensitivity: sensitivitySnapshotCurrent ? claim.effectiveSensitivity : null,
    storedAutomaticSensitivity: automaticSensitivity,
    storedEffectiveSensitivity: claim.effectiveSensitivity,
    sensitivitySnapshotCurrent,
    sources: claim.sources.map(sourceView),
    synthesizedAt: claim.synthesizedAt,
    lastSourceValidatedAt: claim.lastSourceValidatedAt,
    ...(claim.validFrom !== undefined ? { validFrom: claim.validFrom } : {}),
    ...(claim.validTo !== undefined ? { validTo: claim.validTo } : {}),
    ...(claim.supersedesClaimId !== undefined ? { supersedesClaimId: claim.supersedesClaimId } : {}),
    ...(claim.appliedGrantId !== undefined ? { appliedGrantId: claim.appliedGrantId } : {}),
    withheldReasons,
    pendingRebuildReasons,
  };
}

export class AdminBiographicalReviewService {
  constructor(private readonly deps: {
    readonly store: BiographicalProfileStorePort;
    readonly queryLimit: number;
    readonly now?: () => Date;
    readonly close?: () => Promise<void>;
  }) {
    if (!Number.isSafeInteger(deps.queryLimit) || deps.queryLimit < 1) {
      throw new Error('biographical Garden queryLimit must be a positive integer');
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Fleet requests carry the authenticated contact into the D1 projection.
   * Sole-admin operators see the complete companion view; multi-admin
   * operators see companion-only, self/co-subject, and non-intimate foreign
   * claims, while intimate/confidential foreign-human claims require audited
   * escalation. Any fleet call lacking the route's signed subject relation
   * fails closed even if a caller bypasses the HTTP service boundary.
   */
  private subjectAccessForRequest(
    context: GardenRequestContext | undefined,
  ): BiographicalSubjectAccess | null {
    if (context === undefined || context.kind !== 'fleet_principal') return null;
    if (context.resource.area !== 'memory'
      || (context.subjectRelation !== 'self'
        && context.subjectRelation !== 'self_or_co_subject')) {
      throw new BiographicalReviewError(
        'unauthorized',
        'biographical review requires an exact request-local subject relation',
      );
    }
    return {
      viewerContactId: context.actor.contactId,
      role: context.actor.role,
      accessMode: soleAdminFleetActor(context) ? 'sole_admin' : context.actor.accessMode,
      escalated: context.actor.sessionAssurance === 'escalated',
    };
  }

  async close(): Promise<void> {
    await this.deps.close?.();
  }

  /**
   * The exact staging record for one claim. A claim id is unique to one
   * candidate row, so this is the claim's own review state; other rows share
   * only the content digest.
   */
  private async candidateFor(
    store: BiographicalProfileStorePort,
    claimId: string,
  ): Promise<BiographicalCandidateRecord | undefined> {
    const rows = await store.listCandidates({ claimId, limit: this.deps.queryLimit });
    return rows.at(-1);
  }

  async listClaims(
    context?: GardenRequestContext,
    filter?: AdminBiographicalClaimFilter,
  ): Promise<AdminBiographicalClaimList> {
    const access = this.subjectAccessForRequest(context);
    const subjectFilter = parseClaimFilter(filter);
    if (access === null) {
      const claims = await this.deps.store.listClaims({
        includeTerminal: true,
        limit: this.deps.queryLimit,
        ...subjectFilter,
      });
      const views = await Promise.all(claims.map(async claim => {
        const [rebuilds, grants, candidate] = await Promise.all([
          this.deps.store.listRebuilds({ claimId: claim.id, limit: this.deps.queryLimit }),
          this.deps.store.listGrantsForClaim(claim.id),
          this.candidateFor(this.deps.store, claim.id),
        ]);
        return claimView(claim, rebuilds, grants, this.now(), candidate);
      }));
      return { claims: views };
    }

    const authorized: Array<{
      readonly claim: BiographicalClaim;
      readonly rebuilds: readonly BiographicalRebuildRequest[];
    }> = [];
    let offset = 0;
    while (authorized.length < this.deps.queryLimit) {
      const candidates = await this.deps.store.listClaims({
        includeTerminal: true,
        offset,
        limit: this.deps.queryLimit,
        ...subjectFilter,
      });
      if (candidates.length === 0) break;
      const evaluated = await Promise.all(candidates.map(async claim => ({
        claim,
        rebuilds: await this.deps.store.listRebuilds({
          claimId: claim.id,
          status: 'pending',
          limit: this.deps.queryLimit,
        }),
      })));
      for (const candidate of evaluated) {
        if (claimVisibleToSubject(candidate.claim, candidate.rebuilds, access)) {
          authorized.push(candidate);
          if (authorized.length === this.deps.queryLimit) break;
        }
      }
      offset += candidates.length;
      if (candidates.length < this.deps.queryLimit) break;
    }
    const views = await Promise.all(authorized.map(async ({ claim, rebuilds }) => {
      const [grants, candidate] = await Promise.all([
        this.deps.store.listGrantsForClaim(claim.id),
        this.candidateFor(this.deps.store, claim.id),
      ]);
      return claimView(claim, rebuilds, grants, this.now(), candidate);
    }));
    return { claims: views };
  }

  async getClaim(
    claimId: string,
    context?: GardenRequestContext,
  ): Promise<AdminBiographicalClaimDetail> {
    const access = this.subjectAccessForRequest(context);
    const claim = await this.deps.store.getClaim(claimId);
    if (claim === undefined) {
      throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
    }
    const pendingRebuilds = access === null
      ? []
      : await this.deps.store.listRebuilds({
        claimId: claim.id,
        status: 'pending',
        limit: this.deps.queryLimit,
      });
    if (access !== null && !claimVisibleToSubject(claim, pendingRebuilds, access)) {
      throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
    }
    const [grants, rebuilds, audits, candidate] = await Promise.all([
      this.deps.store.listGrantsForClaim(claim.id),
      this.deps.store.listRebuilds({ claimId: claim.id, limit: this.deps.queryLimit }),
      this.deps.store.listReviewAudits(claim.id, this.deps.queryLimit),
      this.candidateFor(this.deps.store, claim.id),
    ]);
    return {
      claim: claimView(claim, rebuilds, grants, this.now(), candidate),
      grants,
      rebuilds,
      audits,
      ...(candidate !== undefined ? { candidate: candidateView(candidate) } : {}),
    };
  }

  private async recordDenied(
    input: ParsedReviewInput,
    reason: BiographicalReviewReason,
  ): Promise<void> {
    await this.deps.store.recordReviewAudit({
      claimId: input.claimId,
      claimDigest: input.claimDigest,
      sourceSetDigest: input.sourceSetDigest,
      action: input.action,
      decision: 'denied',
      reason,
      actorAuthorityRef: input.actor.authorityRef,
      ...(input.grantId !== undefined ? { grantId: input.grantId } : {}),
      ...(input.grantedSensitivity !== undefined
        ? { grantedSensitivity: input.grantedSensitivity }
        : {}),
      now: this.now(),
    });
  }

  async review(
    claimId: string,
    value: unknown,
    actor: AdminBiographicalReviewActor,
    context?: GardenRequestContext,
  ): Promise<AdminBiographicalClaimDetail> {
    const input = parseReviewInput(claimId, value, actor);
    const access = this.subjectAccessForRequest(context);
    const initial = await this.deps.store.getClaim(input.claimId);
    if (initial === undefined) {
      await this.recordDenied(input, 'claim-not-found');
      throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
    }
    const initialPendingRebuilds = access === null
      ? []
      : await this.deps.store.listRebuilds({
        claimId: initial.id,
        status: 'pending',
        limit: this.deps.queryLimit,
      });
    // Return the same not-found shape as an absent claim and do not append a
    // biography audit: otherwise an unrelated claim id becomes an existence
    // oracle across fleet principals.
    if (access !== null && !claimVisibleToSubject(initial, initialPendingRebuilds, access)) {
      throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
    }
    try {
      await this.deps.store.runClaimTransaction(initial.subject, initial.kind, async store => {
        const claim = await store.getClaim(input.claimId);
        if (claim === undefined) {
          throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
        }
        const pendingRebuilds = await store.listRebuilds({
          claimId: claim.id,
          status: 'pending',
          limit: this.deps.queryLimit,
        });
        if (access !== null && !claimVisibleToSubject(claim, pendingRebuilds, access)) {
          throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
        }
        if (claim.claimDigest !== input.claimDigest) {
          throw new BiographicalReviewError('stale-claim-digest', 'stale claim digest');
        }
        const pendingDigestDrift = pendingRebuilds.find(rebuild =>
          rebuild.currentSourceSetDigest !== undefined
          && rebuild.currentSourceSetDigest !== claim.sourceSetDigest
        );
        const expectedSourceSetDigest = input.action === 'regrant'
          ? pendingDigestDrift?.currentSourceSetDigest ?? claim.sourceSetDigest
          : claim.sourceSetDigest;
        if (input.action !== 'revoke' && input.sourceSetDigest !== expectedSourceSetDigest) {
          throw new BiographicalReviewError('stale-source-set-digest', 'stale source-set digest');
        }
        // Staged claims are governed by the receipt-gated candidate machine.
        // Reading it here is what stops the claim-only approve/deny path from
        // becoming an operator bypass around companion review.
        const staged = await this.candidateFor(store, claim.id);
        const stagingOpen = staged !== undefined && staged.stage !== 'active'
          && staged.stage !== 'rejected' && staged.stage !== 'superseded';

        let reason: BiographicalReviewReason;
        let grantId: string | undefined;
        if (input.action === 'stage-approve' || input.action === 'stage-reject') {
          if (staged === undefined) {
            throw new BiographicalReviewError(
              'candidate-not-found',
              'this claim has no staged review candidate',
            );
          }
          if (staged.revision !== input.candidateRevision) {
            throw new BiographicalReviewError(
              'stale-candidate-revision',
              'stale candidate revision',
            );
          }
          // Human review acts only on what companion review already handed
          // forward. Any other stage — including a candidate the companion has
          // not seen — fails closed rather than short-circuiting a stage.
          if (staged.stage !== 'human_review') {
            throw new BiographicalReviewError(
              'invalid-state',
              `candidate is in ${staged.stage}, not human review`,
            );
          }
          if (input.action === 'stage-approve' && pendingDigestDrift !== undefined) {
            throw new BiographicalReviewError(
              'invalid-state',
              'candidate cannot be activated while its sources have drifted',
            );
          }
          await store.transitionCandidate({
            candidateId: staged.id,
            expectedRevision: staged.revision,
            to: input.action === 'stage-approve' ? 'active' : 'rejected',
            receipts: [{
              authority: 'human',
              decision: input.action === 'stage-approve' ? 'approved' : 'rejected',
              actorAuthorityRef: input.actor.authorityRef,
              ...(input.receiptReason !== undefined ? { reason: input.receiptReason } : {}),
            }],
            now: this.now(),
          });
          if (input.action === 'stage-reject') {
            // Activation already flips the claim inside the candidate machine;
            // rejection does not, so the claim would otherwise linger in
            // `candidate` forever. Revoking it makes the refusal durable.
            await store.transitionClaim({ claimId: claim.id, to: 'revoked', now: this.now() });
          }
          reason = input.action === 'stage-approve' ? 'stage-approved' : 'stage-rejected';
        } else if (input.action === 'approve') {
          if (stagingOpen) {
            throw new BiographicalReviewError(
              'invalid-state',
              'this claim is under staged review; use the exact stage action',
            );
          }
          if (pendingDigestDrift !== undefined || (
            claim.status !== 'candidate'
            && claim.status !== 'quarantined'
            && claim.status !== 'contested'
          )) {
            throw new BiographicalReviewError('invalid-state', 'claim cannot be approved in its current state');
          }
          await store.transitionClaim({ claimId: claim.id, to: 'active', now: this.now() });
          reason = 'approved';
        } else if (input.action === 'deny') {
          if (stagingOpen) {
            throw new BiographicalReviewError(
              'invalid-state',
              'this claim is under staged review; use the exact stage action',
            );
          }
          if (
            claim.status !== 'candidate'
            && claim.status !== 'quarantined'
            && claim.status !== 'contested'
          ) {
            throw new BiographicalReviewError('invalid-state', 'claim cannot be denied in its current state');
          }
          await store.transitionClaim({ claimId: claim.id, to: 'revoked', now: this.now() });
          reason = 'denied';
        } else if (input.action === 'revoke') {
          const grant = input.grantId === undefined ? undefined : await store.getGrant(input.grantId);
          if (grant === undefined) {
            throw new BiographicalReviewError('grant-not-found', 'biographical grant not found');
          }
          if (
            grant.claimDigest !== input.claimDigest
            || grant.sourceSetDigest !== input.sourceSetDigest
          ) {
            throw new BiographicalReviewError('grant-digest-mismatch', 'grant does not match exact review digests');
          }
          await store.revokeGrant(grant.id, { reason: 'Garden exact grant revocation', now: this.now() });
          grantId = grant.id;
          reason = 'grant-revoked';
        } else {
          if (claim.status !== 'active' || input.grantedSensitivity === undefined) {
            throw new BiographicalReviewError('invalid-state', 'only an active claim can be re-granted');
          }
          const existingGrants = await store.listGrantsForClaim(claim.id);
          const nowMs = this.now().getTime();
          if (existingGrants.some(grant =>
            grant.sourceSetDigest === input.sourceSetDigest
            && grant.revokedAt === undefined
            && Date.parse(grant.grantedAt) <= nowMs
            && (grant.expiresAt === undefined || Date.parse(grant.expiresAt) > nowMs)
          )) {
            throw new BiographicalReviewError(
              'invalid-state',
              'an active exact-digest grant already exists; revoke it before re-granting',
            );
          }
          const grant = await store.recordGrant({
            claimDigest: input.claimDigest,
            sourceSetDigest: input.sourceSetDigest,
            grantedSensitivity: input.grantedSensitivity,
            authorizingActor: 'operator',
            authorityBasis: input.actor.authorityRef,
            reason: 'Garden exact biographical re-grant',
            now: this.now(),
          });
          grantId = grant.id;
          reason = 'grant-recorded';
        }

        const audit: BiographicalReviewAuditInput = {
          claimId: claim.id,
          claimDigest: input.claimDigest,
          sourceSetDigest: input.sourceSetDigest,
          action: input.action,
          decision: 'allowed',
          reason,
          actorAuthorityRef: input.actor.authorityRef,
          ...(grantId !== undefined ? { grantId } : {}),
          ...(input.grantedSensitivity !== undefined
            ? { grantedSensitivity: input.grantedSensitivity }
            : {}),
          now: this.now(),
        };
        await store.recordReviewAudit(audit);
      });
    } catch (error) {
      if (error instanceof BiographicalReviewError && error.reason !== 'claim-not-found') {
        await this.recordDenied(input, error.reason);
      }
      throw error;
    }
    return await this.getClaim(input.claimId, context);
  }
}
