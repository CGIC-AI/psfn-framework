import { hasExactKeys, isRecord } from '../../../shared/utils/types.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import {
  applyLoweringGrant,
  computeAutomaticSensitivity,
} from '../../../faculties/memory/biographical/kernel.js';
import { renderBiographicalClaimForReview } from '../../../faculties/memory/biographical/projection-rendering.js';
import type {
  BiographicalClaim,
  BiographicalClaimSource,
  BiographicalSensitivityGrant,
} from '../../../faculties/memory/biographical/types.js';
import type { BiographicalRebuildRequest } from '../../../faculties/memory/biographical/lifecycle.js';
import type {
  BiographicalReviewAction,
  BiographicalReviewAuditInput,
  BiographicalReviewAuditRecord,
  BiographicalReviewReason,
} from '../../../faculties/memory/biographical/review-audit.js';
import type { BiographicalProfileStorePort } from '../../../faculties/memory/biographical/store-port.js';

export interface AdminBiographicalSourceView {
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

export interface AdminBiographicalClaimDetail {
  readonly claim: AdminBiographicalClaimView;
  readonly grants: readonly BiographicalSensitivityGrant[];
  readonly rebuilds: readonly BiographicalRebuildRequest[];
  readonly audits: readonly BiographicalReviewAuditRecord[];
}

export interface AdminBiographicalClaimList {
  readonly claims: readonly AdminBiographicalClaimView[];
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
}

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
  if (action !== 'approve' && action !== 'deny' && action !== 'revoke' && action !== 'regrant') {
    throw new BiographicalReviewError('malformed', 'review action is not supported');
  }
  const optional = action === 'revoke'
    ? ['grantId'] as const
    : action === 'regrant'
      ? ['grantedSensitivity'] as const
      : [] as const;
  if (!hasExactKeys(
    value,
    ['action', 'claimDigest', 'sourceSetDigest'],
    optional,
  )) {
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

function claimView(
  claim: BiographicalClaim,
  rebuilds: readonly BiographicalRebuildRequest[],
  grants: readonly BiographicalSensitivityGrant[],
  now: Date,
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
    ...(currentDigestGrant === undefined
      ? pendingRebuildReasons.map(reason => `rebuild:${reason}`)
      : []),
  ];
  return {
    id: claim.id,
    kind: claim.kind,
    status: claim.status,
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

  async close(): Promise<void> {
    await this.deps.close?.();
  }

  async listClaims(): Promise<AdminBiographicalClaimList> {
    const claims = await this.deps.store.listClaims({
      includeTerminal: true,
      limit: this.deps.queryLimit,
    });
    const views = await Promise.all(claims.map(async claim => {
      const [rebuilds, grants] = await Promise.all([
        this.deps.store.listRebuilds({ claimId: claim.id, limit: this.deps.queryLimit }),
        this.deps.store.listGrantsForClaim(claim.id),
      ]);
      return claimView(claim, rebuilds, grants, this.now());
    }));
    return { claims: views };
  }

  async getClaim(claimId: string): Promise<AdminBiographicalClaimDetail> {
    const claim = await this.deps.store.getClaim(claimId);
    if (claim === undefined) {
      throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
    }
    const [grants, rebuilds, audits] = await Promise.all([
      this.deps.store.listGrantsForClaim(claim.id),
      this.deps.store.listRebuilds({ claimId: claim.id, limit: this.deps.queryLimit }),
      this.deps.store.listReviewAudits(claim.id, this.deps.queryLimit),
    ]);
    return { claim: claimView(claim, rebuilds, grants, this.now()), grants, rebuilds, audits };
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
  ): Promise<AdminBiographicalClaimDetail> {
    const input = parseReviewInput(claimId, value, actor);
    const initial = await this.deps.store.getClaim(input.claimId);
    if (initial === undefined) {
      await this.recordDenied(input, 'claim-not-found');
      throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
    }
    try {
      await this.deps.store.runClaimTransaction(initial.subject, initial.kind, async store => {
        const claim = await store.getClaim(input.claimId);
        if (claim === undefined) {
          throw new BiographicalReviewError('claim-not-found', 'biographical claim not found');
        }
        if (claim.claimDigest !== input.claimDigest) {
          throw new BiographicalReviewError('stale-claim-digest', 'stale claim digest');
        }
        const rebuilds = await store.listRebuilds({ claimId: claim.id, limit: this.deps.queryLimit });
        const pendingDigestDrift = rebuilds.find(rebuild =>
          rebuild.status === 'pending'
          && rebuild.currentSourceSetDigest !== undefined
          && rebuild.currentSourceSetDigest !== claim.sourceSetDigest
        );
        const expectedSourceSetDigest = input.action === 'regrant'
          ? pendingDigestDrift?.currentSourceSetDigest ?? claim.sourceSetDigest
          : claim.sourceSetDigest;
        if (input.action !== 'revoke' && input.sourceSetDigest !== expectedSourceSetDigest) {
          throw new BiographicalReviewError('stale-source-set-digest', 'stale source-set digest');
        }
        let reason: BiographicalReviewReason;
        let grantId: string | undefined;
        if (input.action === 'approve') {
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
      if (error instanceof BiographicalReviewError) {
        await this.recordDenied(input, error.reason);
      }
      throw error;
    }
    return await this.getClaim(input.claimId);
  }
}
