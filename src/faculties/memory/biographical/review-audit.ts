import { randomUUID } from 'node:crypto';

import { hasExactKeys, isCanonicalIsoTimestamp, isRecord } from '../../../shared/utils/types.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';

export const BIOGRAPHICAL_REVIEW_ACTIONS = ['approve', 'deny', 'revoke', 'regrant'] as const;
export type BiographicalReviewAction = (typeof BIOGRAPHICAL_REVIEW_ACTIONS)[number];

export const BIOGRAPHICAL_REVIEW_REASONS = [
  'approved',
  'denied',
  'grant-revoked',
  'grant-recorded',
  'malformed',
  'unauthorized',
  'claim-not-found',
  'stale-claim-digest',
  'stale-source-set-digest',
  'grant-not-found',
  'grant-digest-mismatch',
  'invalid-state',
] as const;
export type BiographicalReviewReason = (typeof BIOGRAPHICAL_REVIEW_REASONS)[number];

export interface BiographicalReviewAuditRecord {
  readonly id: string;
  readonly claimId: string;
  readonly claimDigest: string;
  readonly sourceSetDigest: string;
  readonly action: BiographicalReviewAction;
  readonly decision: 'allowed' | 'denied';
  readonly reason: BiographicalReviewReason;
  readonly actorAuthorityRef: string;
  readonly grantId?: string;
  readonly grantedSensitivity?: SensitivityLevel;
  readonly recordedAt: string;
}

export type BiographicalReviewAuditInput = Omit<BiographicalReviewAuditRecord, 'id' | 'recordedAt'> & {
  readonly now: Date;
};

export function prepareBiographicalReviewAudit(
  input: BiographicalReviewAuditInput,
): BiographicalReviewAuditRecord {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error('biographical review audit now must be a valid Date');
  }
  return deserializeBiographicalReviewAudit({
    id: randomUUID(),
    claimId: input.claimId,
    claimDigest: input.claimDigest,
    sourceSetDigest: input.sourceSetDigest,
    action: input.action,
    decision: input.decision,
    reason: input.reason,
    actorAuthorityRef: input.actorAuthorityRef,
    ...(input.grantId !== undefined ? { grantId: input.grantId } : {}),
    ...(input.grantedSensitivity !== undefined
      ? { grantedSensitivity: input.grantedSensitivity }
      : {}),
    recordedAt: input.now.toISOString(),
  });
}

export function deserializeBiographicalReviewAudit(value: unknown): BiographicalReviewAuditRecord {
  if (!isRecord(value) || !hasExactKeys(
    value,
    [
      'id', 'claimId', 'claimDigest', 'sourceSetDigest', 'action', 'decision',
      'reason', 'actorAuthorityRef', 'recordedAt',
    ],
    ['grantId', 'grantedSensitivity'],
  )) {
    throw new Error('stored biographical review audit has unknown or missing fields');
  }
  for (const field of ['id', 'claimId', 'actorAuthorityRef'] as const) {
    if (
      typeof value[field] !== 'string'
      || value[field].trim().length === 0
      || value[field] !== value[field].trim()
    ) {
      throw new Error(`stored biographical review audit ${field} must be non-empty`);
    }
  }
  if (!/^[a-z][a-z0-9_-]*:[^\s]+$/u.test(value.actorAuthorityRef as string)) {
    throw new Error('stored biographical review audit actorAuthorityRef is malformed');
  }
  for (const field of ['claimDigest', 'sourceSetDigest'] as const) {
    if (typeof value[field] !== 'string' || !/^[0-9a-f]{64}$/u.test(value[field])) {
      throw new Error(`stored biographical review audit ${field} must be a SHA-256 digest`);
    }
  }
  if (!(BIOGRAPHICAL_REVIEW_ACTIONS as readonly unknown[]).includes(value.action)) {
    throw new Error('stored biographical review audit action is not supported');
  }
  if (value.decision !== 'allowed' && value.decision !== 'denied') {
    throw new Error('stored biographical review audit decision is not supported');
  }
  if (!(BIOGRAPHICAL_REVIEW_REASONS as readonly unknown[]).includes(value.reason)) {
    throw new Error('stored biographical review audit reason is not supported');
  }
  if (!isCanonicalIsoTimestamp(value.recordedAt)) {
    throw new Error('stored biographical review audit recordedAt must be canonical');
  }
  if (value.grantId !== undefined && (
    typeof value.grantId !== 'string'
    || value.grantId.trim().length === 0
    || value.grantId !== value.grantId.trim()
  )) {
    throw new Error('stored biographical review audit grantId must be non-empty');
  }
  if (
    value.grantedSensitivity !== undefined
    && value.grantedSensitivity !== 'public'
    && value.grantedSensitivity !== 'personal'
    && value.grantedSensitivity !== 'intimate'
    && value.grantedSensitivity !== 'confidential'
  ) {
    throw new Error('stored biographical review audit sensitivity is not supported');
  }
  return value as unknown as BiographicalReviewAuditRecord;
}
