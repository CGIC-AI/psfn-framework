import { createHash } from 'node:crypto';

import { hasExactKeys, isCanonicalIsoTimestamp, isRecord } from '../../../shared/utils/types.js';

import type {
  BiographicalClaim,
  BiographicalClaimKind,
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';
import { assertKnownClaimKind } from './claim-kinds.js';
import { assertSubjectRef, computeSourceSetDigest } from './kernel.js';
import {
  BIOGRAPHICAL_REBUILD_REASONS,
  type BiographicalRebuildReason,
  type BiographicalRebuildRequest,
  type BiographicalSourceLifecycleReason,
} from './rebuild-contracts.js';
import type { BiographicalProfileStorePort } from './store-port.js';

export type SourceRevalidationOutcome =
  | {
      readonly status: 'valid';
      readonly currentSources: readonly BiographicalClaimSource[];
    }
  | {
      readonly status: 'invalid';
      readonly reason: BiographicalSourceLifecycleReason;
      readonly sourceRef: string;
    };

export function computeBiographicalRebuildId(input: {
  readonly claimId: string;
  readonly reason: BiographicalRebuildReason;
  readonly sourceRef?: string;
  readonly priorSourceSetDigest: string;
  readonly currentSourceSetDigest?: string;
  readonly targetSubject?: BiographicalSubjectRef;
}): string {
  const target = input.targetSubject === undefined
    ? ''
    : input.targetSubject.kind === 'contact'
      ? `contact:${input.targetSubject.contactId}:${input.targetSubject.subjectVersion}`
      : `companion:${input.targetSubject.companionId}:${input.targetSubject.subjectVersion}`;
  return createHash('sha256').update([
    input.claimId,
    input.reason,
    input.sourceRef ?? '',
    input.priorSourceSetDigest,
    input.currentSourceSetDigest ?? '',
    target,
  ].join('\u0000'), 'utf8').digest('hex');
}

function assertDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`stored biographical rebuild ${field} must be a SHA-256 digest`);
  }
  return value;
}

/** Fail-closed decoder for durable queue rows and restored backup data. */
export function deserializeBiographicalRebuildRequest(
  value: unknown,
): BiographicalRebuildRequest {
  if (!isRecord(value) || !hasExactKeys(
    value,
    [
      'id',
      'claimId',
      'subject',
      'kind',
      'reason',
      'priorSourceSetDigest',
      'status',
      'queuedAt',
    ],
    [
      'sourceRef',
      'currentSourceSetDigest',
      'targetSubject',
      'completedAt',
      'completion',
    ],
  )) {
    throw new Error('stored biographical rebuild has unknown or missing fields');
  }
  if (typeof value.id !== 'string' || !/^[0-9a-f]{64}$/u.test(value.id)) {
    throw new Error('stored biographical rebuild id must be a SHA-256 digest');
  }
  if (typeof value.claimId !== 'string' || value.claimId.trim().length === 0) {
    throw new Error('stored biographical rebuild claimId must be non-empty');
  }
  const subject = assertSubjectRef(value.subject, 'rebuild subject');
  assertKnownClaimKind(value.kind);
  const kind = value.kind as BiographicalClaimKind;
  if (!(BIOGRAPHICAL_REBUILD_REASONS as readonly unknown[]).includes(value.reason)) {
    throw new Error('stored biographical rebuild reason is not supported');
  }
  const reason = value.reason as BiographicalRebuildReason;
  if (value.status !== 'pending' && value.status !== 'completed') {
    throw new Error('stored biographical rebuild status is not supported');
  }
  if (!isCanonicalIsoTimestamp(value.queuedAt)) {
    throw new Error('stored biographical rebuild queuedAt must be a canonical ISO instant');
  }
  if (value.sourceRef !== undefined && (
    typeof value.sourceRef !== 'string' || value.sourceRef.trim().length === 0
  )) {
    throw new Error('stored biographical rebuild sourceRef must be non-empty');
  }
  const priorSourceSetDigest = assertDigest(value.priorSourceSetDigest, 'priorSourceSetDigest');
  const currentSourceSetDigest = value.currentSourceSetDigest === undefined
    ? undefined
    : assertDigest(value.currentSourceSetDigest, 'currentSourceSetDigest');
  const targetSubject = value.targetSubject === undefined
    ? undefined
    : assertSubjectRef(value.targetSubject, 'rebuild targetSubject');
  const completion = value.completion;
  if (
    completion !== undefined
    && completion !== 'no-change'
    && completion !== 'synthesized'
    && completion !== 'invalidated'
  ) {
    throw new Error('stored biographical rebuild completion is not supported');
  }
  if (value.status === 'pending' && (value.completedAt !== undefined || completion !== undefined)) {
    throw new Error('pending biographical rebuild cannot have completion fields');
  }
  if (
    value.status === 'completed'
    && (!isCanonicalIsoTimestamp(value.completedAt) || completion === undefined)
  ) {
    throw new Error('completed biographical rebuild requires canonical completion fields');
  }
  if (
    typeof value.completedAt === 'string'
    && Date.parse(value.completedAt) < Date.parse(value.queuedAt)
  ) {
    throw new Error('stored biographical rebuild completedAt precedes queuedAt');
  }
  const request: BiographicalRebuildRequest = {
    id: value.id,
    claimId: value.claimId,
    subject,
    kind,
    reason,
    ...(value.sourceRef !== undefined ? { sourceRef: value.sourceRef } : {}),
    priorSourceSetDigest,
    ...(currentSourceSetDigest !== undefined ? { currentSourceSetDigest } : {}),
    ...(targetSubject !== undefined ? { targetSubject } : {}),
    status: value.status,
    queuedAt: value.queuedAt,
    ...(typeof value.completedAt === 'string' ? { completedAt: value.completedAt } : {}),
    ...(completion !== undefined ? { completion } : {}),
  };
  const expectedId = computeBiographicalRebuildId({
    claimId: request.claimId,
    reason: request.reason,
    ...(request.sourceRef !== undefined ? { sourceRef: request.sourceRef } : {}),
    priorSourceSetDigest: request.priorSourceSetDigest,
    ...(request.currentSourceSetDigest !== undefined
      ? { currentSourceSetDigest: request.currentSourceSetDigest }
      : {}),
    ...(request.targetSubject !== undefined ? { targetSubject: request.targetSubject } : {}),
  });
  if (request.id !== expectedId) {
    throw new Error('stored biographical rebuild id does not match its deterministic payload');
  }
  return request;
}

export type BiographicalRebuildSynthesis = (input: {
  readonly request: BiographicalRebuildRequest;
  readonly claim: BiographicalClaim;
  readonly currentSources: readonly BiographicalClaimSource[];
}) => Promise<void>;

export interface BiographicalLifecycleSourceRevalidator {
  revalidate(
    sources: readonly BiographicalClaimSource[],
    now: Date,
  ): Promise<SourceRevalidationOutcome>;
}

/**
 * Process one durable rebuild request. Deterministic validation happens before
 * synthesis: an unchanged source set completes without an LLM call, and a
 * still-invalid source remains pending. Contact re-key work always synthesizes
 * against the explicit canonical target rather than copying an old claim.
 */
export async function executeBiographicalRebuild(input: {
  readonly store: BiographicalProfileStorePort;
  readonly request: BiographicalRebuildRequest;
  readonly revalidator: BiographicalLifecycleSourceRevalidator;
  readonly synthesize: BiographicalRebuildSynthesis;
  readonly now: Date;
}): Promise<'no-change' | 'synthesized' | 'invalidated' | 'deferred'> {
  const claim = await input.store.getClaim(input.request.claimId);
  if (claim === undefined) return 'deferred';
  if (input.request.reason === 'contact-archived') {
    await input.store.completeRebuild(input.request.id, 'invalidated', input.now);
    return 'invalidated';
  }
  const revalidation = await input.revalidator.revalidate(claim.sources, input.now);
  if (revalidation.status === 'invalid') return 'deferred';
  const currentSourceSetDigest = computeSourceSetDigest(revalidation.currentSources);
  if (
    input.request.targetSubject === undefined
    && currentSourceSetDigest === claim.sourceSetDigest
  ) {
    await input.store.completeRebuild(input.request.id, 'no-change', input.now);
    return 'no-change';
  }
  await input.synthesize({
    request: input.request,
    claim,
    currentSources: revalidation.currentSources,
  });
  await input.store.completeRebuild(input.request.id, 'synthesized', input.now);
  return 'synthesized';
}

export type BiographicalContactLifecycleInput =
  | {
      readonly action: 'archive';
      readonly sourceSubject: Extract<BiographicalSubjectRef, { kind: 'contact' }>;
      readonly maxPending: number;
      readonly now: Date;
    }
  | {
      readonly action: 'merge';
      readonly sourceSubject: Extract<BiographicalSubjectRef, { kind: 'contact' }>;
      readonly targetSubject: Extract<BiographicalSubjectRef, { kind: 'contact' }>;
      readonly maxPending: number;
      readonly now: Date;
    };

export interface BiographicalContactLifecycleResult {
  readonly retiredClaimIds: readonly string[];
  readonly rebuildRequestIds: readonly string[];
}

/**
 * Retire every current claim owned by or relationally tied to an archived or
 * merged contact. History is preserved in place; merge never copies an old
 * claim into the canonical target profile. Instead, bounded rebuild work is
 * queued against the explicit target so fresh governed evidence must produce
 * any target claim.
 */
export async function applyBiographicalContactLifecycle(input: {
  readonly store: BiographicalProfileStorePort;
  readonly lifecycle: BiographicalContactLifecycleInput;
}): Promise<BiographicalContactLifecycleResult> {
  const { lifecycle } = input;
  if (!Number.isSafeInteger(lifecycle.maxPending) || lifecycle.maxPending < 1) {
    throw new Error('biographical contact lifecycle maxPending must be a positive integer');
  }
  if (
    lifecycle.action === 'merge'
    && lifecycle.sourceSubject.contactId === lifecycle.targetSubject.contactId
    && lifecycle.sourceSubject.subjectVersion === lifecycle.targetSubject.subjectVersion
  ) {
    throw new Error('biographical contact merge requires distinct source and target subjects');
  }
  return await input.store.runSubjectTransaction(
    lifecycle.sourceSubject,
    async store => {
      const [owned, related] = await Promise.all([
        store.listClaims({
          subject: lifecycle.sourceSubject,
          includeTerminal: true,
          limit: lifecycle.maxPending + 1,
        }),
        store.listClaims({
          relatedSubject: lifecycle.sourceSubject,
          includeTerminal: true,
          limit: lifecycle.maxPending + 1,
        }),
      ]);
      const current = [...new Map(
        [...owned, ...related]
          .filter(claim => claim.status !== 'superseded' && claim.status !== 'revoked')
          .map(claim => [claim.id, claim] as const),
      ).values()].sort((left, right) => {
        const timeOrder = left.synthesizedAt.localeCompare(right.synthesizedAt);
        return timeOrder !== 0 ? timeOrder : left.id.localeCompare(right.id);
      });
      if (current.length > lifecycle.maxPending) {
        throw new Error('biographical contact lifecycle operation bound exceeded');
      }
      const reason: BiographicalSourceLifecycleReason = lifecycle.action === 'merge'
        ? 'contact-merged'
        : 'contact-archived';
      const rebuildRequestIds: string[] = [];
      for (const claim of current) {
        const queued = await store.enqueueRebuild({
          claim,
          reason,
          ...(lifecycle.action === 'merge'
            ? { targetSubject: lifecycle.targetSubject }
            : {}),
          maxPending: lifecycle.maxPending,
          now: lifecycle.now,
        });
        if (queued.status === 'capacity-exhausted' || queued.request === undefined) {
          throw new Error('biographical lifecycle rebuild queue capacity exhausted');
        }
        rebuildRequestIds.push(queued.request.id);
      }
      const retiredClaimIds: string[] = [];
      for (const claim of current) {
        await store.transitionClaim({
          claimId: claim.id,
          to: lifecycle.action === 'merge' ? 'superseded' : 'revoked',
          now: lifecycle.now,
        });
        retiredClaimIds.push(claim.id);
      }
      return { retiredClaimIds, rebuildRequestIds };
    },
  );
}
